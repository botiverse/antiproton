/**
 * Image evidence of a model call (cf/src/image-evidence.ts): what the queue consumer did with each image reference of
 * a call, one record per delivery attempt, written back to the agent's object and read through the evaluation route's
 * `model-input` answer (`AgentRuntime.modelInput`, cf/src/fresh-context.ts `readModelInput`).
 *
 * The end-to-end rows drive the real `AgentRuntime` (cf/src/runtime.ts) over node:sqlite with model-input evidence on,
 * a plugin whose tool result carries an image, and an in-memory bucket; the call that sees the image is left pending
 * and run by the real consumer (`consumeModelCalls`, cf/src/model-queue.ts, with `queuedCall`'s evidence sink pointed
 * at the runtime, as cf/src/index.ts `modelQueueDeps` points it at the object). `fetch` is the provider.
 *
 * The window rows call `resolveImagesReported` (src/model/images.ts) directly, for the outcomes a conversation needs
 * many images to reach.
 */
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { callQueuedModel, operatorModelOf, queuedCall, type ModelEnv } from "../cf/src/model-request.ts";
import { consumeModelCalls, type ModelQueueDeps, type ModelQueueMessage, type QueuedModelCall } from "../cf/src/model-queue.ts";
import { EVIDENCE_WRITE_BOUND_MS, MAX_EVIDENCE_ITEMS, cleanAttempt, recordImageAttempt, type ImageAttempt, type ImageEvidenceSink } from "../cf/src/image-evidence.ts";
import { IMAGE_WINDOW_STEP, imageKey, imageRef, resolveImagesReported, sha256Hex, type ImageItem } from "../src/model/images.ts";
import type { ModelResponse } from "../src/model/types.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 4).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

/** A real PNG, `w` by `h`, of noise from `seed`. */
function png(w: number, h: number, seed = 1): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t: string, d: Buffer) => {
    const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  let s = seed;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let i = 0; i < raw.length; i++) { s = (s * 1103515245 + 12345) >>> 0; raw[i] = i % (w * 3 + 1) === 0 ? 0 : s >>> 24; }
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}

const OWNER = { tenantId: "t", agentId: "a" };
const IMG = png(32, 32, 7);
const IMG_SHA = sha256Hex(IMG);
const IMG_B64 = Buffer.from(IMG).toString("base64");
/** Pieces of the image's bytes in each form a leak could take. */
const IMG_PIECES = [IMG_B64.slice(40, 100), Buffer.from(IMG).subarray(40, 80).toString("hex")];
const VIEW = { ref: "artifact://uploads/chart.png", mimeType: "image/png", width: 32, height: 32, bytes: IMG.byteLength };

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async put(key: string, body: Uint8Array | string) { objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body)); return {}; },
    async get(key: string) { const b = objects.get(key); return b ? { arrayBuffer: async () => b.slice().buffer } : null; },
    async head(key: string) { const b = objects.get(key); return b ? { size: b.byteLength } : null; },
    async list() { return { objects: [], truncated: false }; },
    async delete(key: string) { objects.delete(key); },
  };
}

const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const call = (id: string, name: string, args: unknown): ModelResponse =>
  ({ text: "", finishReason: "tool_calls", truncated: false, usage, toolCalls: [{ id, name, arguments: args as never }] });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));
const pictures: Plugin = {
  id: "pics", version: "1.0.0",
  tools: [{ name: "show", description: "Shows an image.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "native" }] as never,
  async invoke() { return { name: "chart.png", view: VIEW } as never; },
};

/** An agent on `model`, its tool's image stored, with model-input evidence on unless `evidence` is false. */
async function world(model: string, evidence = true, host = sqliteHost(), engine: "pi085" | "pd" = "pi085") {
  if (engine === "pd") {
    const ap = new ApStore(host, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const bucket = memoryBucket();
  bucket.objects.set("t/t/a/uploads/chart.png", IMG);
  const sent: string[] = [];
  const standIn = standInLoader();
  const env: ModelEnv = { DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: model };
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: bucket as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, extraPlugins: [pictures],
    loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf(env),
    offloadModel: async (j: { commandId: string }) => { sent.push(j.commandId); },
    modelInputEvidence: evidence,
  } as never);
  await rt.ready();
  return { host, bucket, rt, sent, env };
}
type World = Awaited<ReturnType<typeof world>>;

/** A turn whose first call asks for the image and whose second call, the one that carries it, is left pending. */
async function pendingImageCall(w: World): Promise<string> {
  await w.rt.store.createAgent("t", "a");
  await w.rt.store.setPluginChoice("t", "a", "pics", "enable");
  const added = await w.rt.addMount("t", "a", { alias: "pics", plugin: "pics", config: {} });
  must(added.ok, `the mount was refused: ${show(added)}`);
  await w.rt.bindOperatorModel("t", "a");
  await w.rt.postMessage("t", "a", "show me", "prompt", "main");
  let answered = false;
  for (let guard = 0; guard < 200; guard++) {
    await w.rt.step("t", "a");
    if (!answered && w.sent.length >= 1) {
      const job = await w.rt.takeJob("t", "a", w.sent[0]!) as any;
      await w.rt.deliverAnswer("t", "a", w.sent[0]!, fromResponse(call("c1", "pics__show", {}), { api: job.model.api, provider: job.model.provider, id: job.model.id }, w.sent[0]!), undefined);
      answered = true;
    }
    if (w.sent.length >= 2) return w.sent[1]!;
    await sleep(20);
  }
  throw new Error(`the image's call was never dispatched (${w.sent.length} sent)`);
}

/** The runtime as the consumer's stub sees the object (`AgentDO`'s RPC methods). */
function stubOf(w: World) {
  return {
    takeJob: (t: string, a: string, id: string, taker?: string) => w.rt.takeJob(t, a, id, taker),
    releaseJob: (t: string, a: string, id: string, taker: string) => w.rt.releaseJob(t, a, id, taker),
    deliverAnswer: (t: string, a: string, id: string, answer: unknown, _ms: number, taker?: string) => w.rt.deliverAnswer(t, a, id, answer, taker),
  };
}

/** The consumer's deps as cf/src/index.ts builds them, with the evidence sink pointed at the runtime. */
function consumerDeps(w: World, sink: (m: QueuedModelCall) => ImageEvidenceSink): ModelQueueDeps {
  return {
    stub: () => stubOf(w),
    call: queuedCall(w.env, w.bucket, sink),
    givenUp: () => ({ role: "assistant", content: [], stopReason: "error" }),
  };
}
/** The evidence sink cf/src/index.ts installs, against the runtime: the object's `recordImageAttempt` for the message's job. */
const toRuntime = (w: World) => (m: QueuedModelCall): ImageEvidenceSink => (report) => w.rt.recordImageAttempt(m.jobId, report);

/** Delivers one message to the consumer; true when it was acked, false when it asked to be retried. */
async function deliver(deps: ModelQueueDeps, jobId: string): Promise<boolean> {
  let acked: boolean | null = null;
  const message: ModelQueueMessage = { body: { doId: "do-1", ...OWNER, jobId }, ack: () => { acked = true; }, retry: () => { acked = false; } };
  await consumeModelCalls({ queue: "model-calls", messages: [message] }, deps);
  must(acked !== null, "the consumer neither acked nor retried");
  return acked!;
}

const CHAT_REPLY = JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "A chart." } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
/** Runs `fn` with `fetch` answering `reply` (or throwing it), and returns every request body. */
async function withProvider<T>(reply: (body: string) => Response | Error, fn: () => Promise<T>): Promise<{ value: T; bodies: string[] }> {
  const real = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    bodies.push(body);
    if (init?.signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
    const r = reply(body);
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  try { return { value: await fn(), bodies }; } finally { globalThis.fetch = real; }
}
const ok200 = () => new Response(CHAT_REPLY, { status: 200, headers: { "content-type": "application/json" } });
/** Runs `fn` with the call's deadline already passed, as a provider that never answered in time leaves it. */
async function pastDeadline<T>(fn: () => Promise<T>): Promise<T> {
  const real = AbortSignal.timeout;
  AbortSignal.timeout = () => AbortSignal.abort(new DOMException("The operation timed out", "TimeoutError"));
  try { return await fn(); } finally { AbortSignal.timeout = real; }
}

async function modelInputOf(w: World, jobId: string): Promise<any> {
  const digest = w.host.sql.exec("SELECT session_id, call FROM model_input_digests WHERE job_id = ?", jobId).toArray()[0] as any;
  must(digest, `no model input was recorded for ${jobId}`);
  return w.rt.modelInput("t", "a", String(digest.session_id), Number(digest.call));
}
const imageRows = (w: World) => {
  try { return w.host.sql.exec("SELECT * FROM model_input_images").toArray() as any[]; }
  catch (e) { if (/no such table/.test(String(e))) return []; throw e; }
};
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ---- end to end ---------------------------------------------------------------------------------------------

await check("included_in_request: a vision model's image is sent, and model-input names it with the attempt's terminal provider outcome", async () => {
  const w = await world("deepseek-flash");
  try {
    const jobId = await pendingImageCall(w);
    const { value: acked, bodies } = await withProvider(ok200, () => deliver(consumerDeps(w, toRuntime(w)), jobId));
    must(acked, "the call was not acked");
    must(bodies.length === 1 && bodies[0]!.includes(IMG_B64), "the image was not in the request");
    const mi = await modelInputOf(w, jobId);
    must(Array.isArray(mi.images) && mi.images.length === 1, `images: ${show(mi.images)}`);
    const a: ImageAttempt = mi.images[0];
    must(a.modelCallId === jobId && a.sessionId === mi.sessionId && a.call === mi.call && a.attempt === 1 && a.policy === "image-window/v1", show(a));
    must(show(a.budget) === show({ maxImages: 8, maxBytes: 12 * 1024 * 1024, step: IMAGE_WINDOW_STEP }), `budget ${show(a.budget)}`);
    must(a.windowStart === 0 && a.model === "deepseek-flash" && a.vision === true && ISO.test(a.preparedAt), show(a));
    must(show(a.items) === show([{ index: 0, sha256: IMG_SHA, declaredBytes: IMG.byteLength, readBytes: IMG.byteLength, result: "included_in_request" }]), `items ${show(a.items)}`);
    must(a.provider?.outcome === "http" && (a.provider as any).status === 200 && ISO.test(a.provider.at), `provider ${show(a.provider)}`);
    must(Date.parse(a.provider!.at) >= Date.parse(a.preparedAt), "the provider ended before the request was prepared");
    must(!("truncated" in a), "truncated is set with one item");
    // The keys, in the agreed order, and nothing else.
    must(show(Object.keys(a)) === show(["modelCallId", "sessionId", "call", "attempt", "policy", "budget", "windowStart", "model", "vision", "preparedAt", "items", "provider"]), show(Object.keys(a)));
  } finally { w.host.dispose(); }
});

await check("non_vision_model: a model that cannot see images reads nothing, and every reference is omitted with that reason", async () => {
  const w = await world("deepseek-v4-pro");
  try {
    // A model that cannot see images is told so in the tool result, with no reference; the reference this row needs
    // is put in the conversation the way a vision model's turn wrote it, before the switch to this model.
    const jobId = await pendingImageCall(w);
    const row = w.host.sql.exec("SELECT request FROM pi_model_jobs WHERE id = ?", jobId).toArray()[0] as any;
    const req = JSON.parse(String(row.request));
    req.context.messages.push({ role: "user", content: [{ type: "image", data: imageRef(IMG_SHA, IMG.byteLength), mimeType: "image/png" }], timestamp: 9 });
    w.host.sql.exec("UPDATE pi_model_jobs SET request = ? WHERE id = ?", JSON.stringify(req), jobId);
    const gets: string[] = [];
    const get = w.bucket.get.bind(w.bucket);
    w.bucket.get = async (k: string) => { gets.push(k); return get(k); };
    const { bodies } = await withProvider(ok200, () => deliver(consumerDeps(w, toRuntime(w)), jobId));
    must(!bodies[0]!.includes(IMG_B64), "the image was sent to a model that cannot see it");
    must(!gets.some((k) => k.includes("model-images")), `read for a model that cannot see: ${show(gets)}`);
    const a = (await modelInputOf(w, jobId)).images[0];
    must(a && a.vision === false && a.windowStart === 1, show(a));
    must(show(a.items) === show([{ index: 0, sha256: IMG_SHA, declaredBytes: IMG.byteLength, readBytes: null, result: "omitted", reason: "non_vision_model" }]), show(a.items));
    must(a.provider?.outcome === "http" && a.provider.status === 200, show(a.provider));
  } finally { w.host.dispose(); }
});

await check("load_failed/missing: an image no longer stored is not sent, the model is told it could not be loaded, and the item says missing", async () => {
  const w = await world("deepseek-flash");
  try {
    const jobId = await pendingImageCall(w);
    w.bucket.objects.delete(imageKey(OWNER, IMG_SHA));
    const { bodies } = await withProvider(ok200, () => deliver(consumerDeps(w, toRuntime(w)), jobId));
    must(!bodies[0]!.includes(IMG_B64) && bodies[0]!.includes("(an image could not be loaded: it is no longer stored)"), bodies[0]!.slice(-400));
    const a = (await modelInputOf(w, jobId)).images[0];
    must(show(a.items) === show([{ index: 0, sha256: IMG_SHA, declaredBytes: IMG.byteLength, readBytes: null, result: "load_failed", reason: "missing" }]), show(a.items));
  } finally { w.host.dispose(); }
});

await check("load_failed/size_mismatch: bytes whose size is not the one the reference declares are refused, not sent, even when their hash matches", async () => {
  const w = await world("deepseek-flash");
  try {
    const jobId = await pendingImageCall(w);
    // The reference declares one byte fewer than is stored under its hash.
    const row = w.host.sql.exec("SELECT request FROM pi_model_jobs WHERE id = ?", jobId).toArray()[0] as any;
    must(String(row.request).includes(imageRef(IMG_SHA, IMG.byteLength)), "control: the job does not hold the reference this row changes");
    w.host.sql.exec("UPDATE pi_model_jobs SET request = ? WHERE id = ?", String(row.request).split(imageRef(IMG_SHA, IMG.byteLength)).join(imageRef(IMG_SHA, IMG.byteLength - 1)), jobId);
    const { bodies } = await withProvider(ok200, () => deliver(consumerDeps(w, toRuntime(w)), jobId));
    must(!bodies[0]!.includes(IMG_B64), "the mismatched image was sent");
    must(bodies[0]!.includes(`(an image could not be loaded: it is ${IMG.byteLength} bytes, not the ${IMG.byteLength - 1} its reference declares)`), bodies[0]!.slice(-400));
    const a = (await modelInputOf(w, jobId)).images[0];
    must(show(a.items) === show([{ index: 0, sha256: IMG_SHA, declaredBytes: IMG.byteLength - 1, readBytes: IMG.byteLength, result: "load_failed", reason: "size_mismatch" }]), show(a.items));
  } finally { w.host.dispose(); }
});

await check("retry: a timed-out attempt and a retry that answers are two records, each with its own terminal provider outcome", async () => {
  const w = await world("deepseek-flash");
  try {
    const jobId = await pendingImageCall(w);
    const deps = consumerDeps(w, toRuntime(w));
    const first = await pastDeadline(() => withProvider(ok200, () => deliver(deps, jobId)));
    must(first.value === false, "a timed-out call was acked, not retried");
    const second = await withProvider(ok200, () => deliver(deps, jobId));
    must(second.value === true, "the retry was not acked");
    const images: ImageAttempt[] = (await modelInputOf(w, jobId)).images;
    must(images.length === 2, `attempts: ${show(images)}`);
    must(images[0]!.attempt === 1 && images[0]!.provider?.outcome === "timeout" && !("status" in images[0]!.provider!), show(images[0]!.provider));
    must(images[1]!.attempt === 2 && images[1]!.provider?.outcome === "http" && (images[1]!.provider as any).status === 200, show(images[1]!.provider));
    must(images.every((a) => a.modelCallId === jobId && a.items.length === 1 && a.items[0]!.result === "included_in_request"), show(images));
    // A third delivery of the answered job calls nothing and records nothing.
    const third = await withProvider(ok200, () => deliver(deps, jobId));
    must(third.value === true && third.bodies.length === 0 && (await modelInputOf(w, jobId)).images.length === 2, "a redelivery after the answer was recorded or called");
  } finally { w.host.dispose(); }
});

await check("transport_error and a 5xx past its retries are terminal outcomes too; a provider-less attempt has no provider key", async () => {
  const w = await world("deepseek-flash");
  try {
    const jobId = await pendingImageCall(w);
    const deps = consumerDeps(w, toRuntime(w));
    await withProvider(() => new TypeError("fetch failed"), () => deliver(deps, jobId));
    await withProvider(() => new Response("busy", { status: 503 }), () => deliver(deps, jobId));
    const images: ImageAttempt[] = (await modelInputOf(w, jobId)).images;
    must(show(images.map((a) => a.provider && { ...a.provider, at: "x" })) === show([
      { outcome: "transport_error", errorClass: "TypeError", at: "x" }, { outcome: "http", status: 503, at: "x" }]), show(images.map((a) => a.provider)));
    // Prepared only: what an attempt whose invocation died mid-call leaves.
    must(await w.rt.recordImageAttempt(jobId, { ...cleanAttempt({ ...images[0], attemptId: "dead-attempt" })!, provider: undefined }), "a prepared-only attempt was refused");
    const dead = (await modelInputOf(w, jobId)).images[2];
    must(dead.attempt === 3 && !("provider" in dead), `a prepared-only attempt: ${show(dead)}`);
  } finally { w.host.dispose(); }
});

await check("evidence disabled: the job is not marked, the consumer writes nothing, and the object records nothing", async () => {
  const w = await world("deepseek-flash", false);
  try {
    const jobId = await pendingImageCall(w);
    let writes = 0;
    const { value: acked, bodies } = await withProvider(ok200, () => deliver(consumerDeps(w, () => async () => { writes++; }), jobId));
    must(acked && bodies[0]!.includes(IMG_B64), "control: the call did not go out with its image");
    must(writes === 0, `the consumer wrote evidence ${writes} time(s) for an agent with evidence off`);
    const taken = await w.rt.takeJob("t", "a", jobId);
    must(taken === null, "control: the job is still open");
    must(imageRows(w).length === 0, "rows were recorded");
  } finally { w.host.dispose(); }
  // The object's own gate: a call whose input was recorded while evidence was on, and an object built with it off.
  const host = sqliteHost();
  const on = await world("deepseek-flash", true, host);
  try {
    const jobId = await pendingImageCall(on);
    const report = { attemptId: "a-1", budget: { maxImages: 8, maxBytes: 1, step: 4 }, windowStart: 0, model: "m", vision: true, preparedAt: new Date().toISOString(), items: [] };
    const off = await world("deepseek-flash", false, host);
    must(await off.rt.recordImageAttempt(jobId, report) === false, "an object with evidence off recorded an attempt");
    must(imageRows(on).length === 0, "rows were recorded with evidence off");
    must(await on.rt.recordImageAttempt(jobId, report) === true, "control: the same report is refused with evidence on");
  } finally { host.dispose(); }
});

await check("no base64, URL or storage key: the model-input answer and every evidence row hold names and sizes only", async () => {
  const w = await world("deepseek-flash");
  try {
    const jobId = await pendingImageCall(w);
    const deps = consumerDeps(w, toRuntime(w));
    await withProvider(ok200, () => deliver(deps, jobId));
    const text = show(await modelInputOf(w, jobId)) + show(imageRows(w));
    must(text.includes(IMG_SHA) && text.includes("included_in_request"), "control: the evidence names nothing, so the scan below proves nothing");
    for (const piece of IMG_PIECES) must(!text.includes(piece), `the evidence holds the image's bytes (${piece.slice(0, 12)}…)`);
    for (const bad of ["base64", "data:", "://", "https:", "http:", "model-images", imageKey(OWNER, IMG_SHA), "t/t/a/", "apimg:", "model.example"]) {
      must(!text.includes(bad), `the evidence holds "${bad}"`);
    }
    // A report carrying more than the fixed shape keeps only the shape.
    const smuggled = { attemptId: "s-1", budget: { maxImages: 8, maxBytes: 1, step: 4, url: "https://x" }, windowStart: 0, model: "m", vision: true,
      preparedAt: new Date().toISOString(), data: IMG_B64, key: imageKey(OWNER, IMG_SHA),
      items: [{ index: 0, sha256: IMG_SHA, declaredBytes: 1, readBytes: 1, result: "included_in_request", url: "https://x", data: IMG_B64 }] };
    must(await w.rt.recordImageAttempt(jobId, smuggled), "the report was refused");
    const all = show(imageRows(w));
    must(!all.includes("https://x") && !all.includes(IMG_PIECES[0]!) && !all.includes("model-images"), "a field outside the shape was kept");
  } finally { w.host.dispose(); }
});

await check("a failing evidence write does not fail the call: a sink that throws, rejects or never answers still gets the answer delivered", async () => {
  const sinks: Array<[string, ImageEvidenceSink]> = [
    ["throws", () => { throw new Error("object unreachable"); }],
    ["rejects", async () => { throw new Error("object unreachable"); }],
    ["hangs", () => new Promise(() => {})],
  ];
  for (const [how, sink] of sinks) {
    const w = await world("deepseek-flash");
    try {
      const jobId = await pendingImageCall(w);
      const t0 = Date.now();
      const { value: acked, bodies } = await withProvider(ok200, () => deliver(consumerDeps(w, () => sink), jobId));
      must(acked && bodies.length === 1 && bodies[0]!.includes(IMG_B64), `${how}: the call did not complete`);
      must(await w.rt.takeJob("t", "a", jobId) === null, `${how}: the answer was not delivered`);
      // Bounded: the ended write is waited on at most EVIDENCE_WRITE_BOUND_MS.
      must(Date.now() - t0 < EVIDENCE_WRITE_BOUND_MS + 1500, `${how}: the call was held ${Date.now() - t0} ms`);
    } finally { w.host.dispose(); }
  }
});

await check("an attempt is only ever added to: a prepared report arriving after its ended one changes nothing, and an ended one is final", async () => {
  const w = await world("deepseek-flash");
  try {
    const jobId = await pendingImageCall(w);
    const base = { attemptId: "x-1", budget: { maxImages: 8, maxBytes: 1, step: 4 }, windowStart: 0, model: "m", vision: true, preparedAt: new Date(0).toISOString(),
      items: [{ index: 0, sha256: IMG_SHA, declaredBytes: 1, readBytes: 1, result: "included_in_request" }] };
    const ended = { ...base, provider: { outcome: "timeout", at: new Date(1).toISOString() } };
    must(await w.rt.recordImageAttempt(jobId, ended), "the ended report was refused");
    must(await w.rt.recordImageAttempt(jobId, base) === false, "a late prepared report was taken");
    must(await w.rt.recordImageAttempt(jobId, { ...base, provider: { outcome: "http", status: 200, at: new Date(2).toISOString() } }) === false, "an ended attempt was changed");
    const images = (await modelInputOf(w, jobId)).images;
    must(images.length === 1 && images[0].provider.outcome === "timeout", show(images));
  } finally { w.host.dispose(); }
});

await check("pd: a job of the pd engine is not marked, since its calls have no input record to join", async () => {
  const w = await world("deepseek-flash", true, sqliteHost(), "pd");
  try {
    const jobId = await pendingImageCall(w);
    const taken = await w.rt.takeJob("t", "a", jobId) as any;
    must(taken && taken.context, "control: the job was not taken");
    must(!("imageEvidence" in taken), "a pd job was marked for image evidence");
  } finally { w.host.dispose(); }
});

// ---- the window ---------------------------------------------------------------------------------------------

/** `n` images of `size` bytes each, one per user message, and a loader for them. */
function manyImages(n: number, size: number) {
  const store = new Map<string, Uint8Array>();
  const messages = Array.from({ length: n }, (_, i) => {
    const b = new Uint8Array(size); b[0] = i; b[1] = i >> 8;
    const sha = sha256Hex(b); store.set(sha, b);
    return { role: "user", content: [{ type: "image", data: imageRef(sha, size), mimeType: "image/png" }] };
  });
  return { context: { messages }, load: async (sha: string) => store.get(sha) ?? null };
}
const kinds = (items: ImageItem[]) => items.map((i) => i.result === "omitted" ? `omitted:${i.reason}` : i.result);

await check("over_budget and before_window: images past the byte budget, and those the step passed over, are told apart and never read", async () => {
  // Ten 1 MiB images, a 3 MiB budget of at most 8: the newest three fit (fits = 7), the start snaps forward to 8.
  const MiB = 1024 * 1024;
  const m = manyImages(10, MiB);
  const reads: string[] = [];
  const r = await resolveImagesReported(m.context, async (sha) => { reads.push(sha); return m.load(sha); }, { maxImages: 8, maxBytes: 3 * MiB });
  must(r.windowStart === 8, `windowStart ${r.windowStart}`);
  must(show(kinds(r.items)) === show([...Array(7).fill("omitted:over_budget"), "omitted:before_window", "included_in_request", "included_in_request"]), show(kinds(r.items)));
  must(reads.length === 2, `read ${reads.length}, not just the window's two`);
  must(r.items.every((i, k) => i.index === k && i.declaredBytes === MiB && i.readBytes === (i.result === "included_in_request" ? MiB : null)), show(r.items.slice(6)));
});

await check(`truncated: a conversation of more than ${MAX_EVIDENCE_ITEMS} references keeps the newest ${MAX_EVIDENCE_ITEMS} items and counts the rest`, async () => {
  const m = manyImages(MAX_EVIDENCE_ITEMS + 25, 10);
  const r = await resolveImagesReported(m.context, m.load, { maxImages: 4, maxBytes: 1000 });
  const host = sqliteHost();
  try {
    host.sql.exec("CREATE TABLE model_input_digests (session_id TEXT NOT NULL, call INTEGER NOT NULL, job_id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (session_id, call))");
    host.sql.exec("INSERT INTO model_input_digests VALUES ('main', 1, 'mj_1', 0, '{}')");
    const wrote = recordImageAttempt(host.sql as never, "mj_1", { attemptId: "t-1", budget: { maxImages: 4, maxBytes: 1000, step: 4 }, windowStart: r.windowStart,
      model: "m", vision: true, preparedAt: new Date().toISOString(), items: r.items });
    must(wrote, "the attempt was refused");
    const a = JSON.parse(String((host.sql.exec("SELECT record FROM model_input_images").toArray()[0] as any).record));
    must(a.items.length === MAX_EVIDENCE_ITEMS && a.truncated === 25, `items ${a.items.length}, truncated ${a.truncated}`);
    must(a.items[0].index === 25 && a.items.at(-1).index === MAX_EVIDENCE_ITEMS + 24 && a.items.at(-1).result === "included_in_request", "the newest were not the ones kept");
  } finally { host.dispose(); }
});

await check("a call without evidence is the call it always was: no observer, no write, and the same request", async () => {
  const m = manyImages(1, 10);
  const job = { model: { api: "offloaded", provider: "openai-compatible", id: "deepseek-flash" }, context: m.context, options: {}, operatorModel: "deepseek-flash", operatorProvider: "deepseek" };
  const env: ModelEnv = { DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "deepseek-flash" };
  let writes = 0;
  const sink: ImageEvidenceSink = async () => { writes++; };
  const plain = await withProvider(ok200, () => callQueuedModel(env, job, "mj_1", m.load));
  const unmarked = await withProvider(ok200, () => callQueuedModel(env, job, "mj_1", m.load, sink));
  const marked = await withProvider(ok200, () => callQueuedModel(env, { ...job, imageEvidence: true }, "mj_1", m.load, sink));
  must(writes === 2, `writes: ${writes} (the unmarked job wrote, or the marked one did not write twice)`);
  must(plain.bodies[0] === unmarked.bodies[0] && plain.bodies[0] === marked.bodies[0], "evidence changed the request");
});

for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.error ? `\n      ${r.error}` : ""}`);
console.log(`  ${"─".repeat(56)}\n  ${results.filter((r) => r.ok).length} passed, ${results.filter((r) => !r.ok).length} failed`);
if (results.some((r) => !r.ok)) process.exit(1);
