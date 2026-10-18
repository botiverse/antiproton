/**
 * `attachments_upload` (src/plugins/raft.ts): a file in the agent's own object storage, uploaded to Raft as an
 * attachment through the SDK's typed `attachments.upload` with the mount's credential. Only the caller's own
 * `artifact://` references resolve; the size is capped before Raft is asked; the tool is offered only with storage and
 * to a credential holding `send`; it is a write, so a subagent never gets it. Raft is faked at the fetch boundary, so
 * what the SDK actually sends (the multipart body, the channel, the credential) is what is checked.
 */
import {
  raftPlugin as raftWithoutStorage, createRaftPlugin, uploadAttachment, UPLOAD_TOOL, UPLOAD_MAX_BYTES,
} from "../src/plugins/raft.ts";
import { admitTools } from "../src/runtime/mount-tools.ts";
import { toolsOf } from "../src/plugins/types.ts";
import { childMayCall, childWithheld } from "../src/runtime/subagents.ts";

const originalFetch = globalThis.fetch;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
async function failure(fn: () => Promise<unknown>): Promise<Error> {
  try { await fn(); } catch (e) { return e as Error; }
  throw new Error("expected failure");
}

const CREDENTIAL = "sk_agent_test_1234567890";
function ctx() {
  return {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "ctx_turn" },
    alias: "raft", credential: CREDENTIAL, publicConfig: { serverUrl: "https://raft.example" },
    sibling: async () => null, sandboxForms: async () => [],
    // A listing keeps the Server's flags in the mount's database; nothing here reads them back.
    db: { get: async () => null, put: async () => {}, delete: async () => {} },
  } as any;
}

/**
 * The agent's object storage: `objects` by key, and every key asked for, by a whole read (`gets`) and by a metadata
 * read (`heads`). `sizes` overrides what the metadata reports for a key, as a real object of that size would.
 */
function fakeArtifacts(objects: Record<string, Uint8Array> = {}, sizes: Record<string, number> = {}) {
  const gets: string[] = [];
  const heads: string[] = [];
  return {
    gets, heads, objects,
    async head(key: string): Promise<{ bytes: number } | null> {
      heads.push(key);
      if (key in sizes) return { bytes: sizes[key]! };
      return objects[key] ? { bytes: objects[key]!.byteLength } : null;
    },
    async put(key: string, body: Uint8Array) { objects[key] = body; return { ref: `r2://bucket/${key}`, bytes: body.byteLength }; },
    async get(key: string): Promise<Uint8Array> {
      gets.push(key);
      const o = objects[key];
      // As the runtime's store says it: no key in the message.
      if (!o) throw new Error("no such artifact");
      return o;
    },
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
const OWN_KEY = "t/tenant/agent/sandbox/box-1/work/out.png";
const OWN_REF = "artifact://sandbox/box-1/work/out.png";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** What reached the fake Raft: each request's path, and the upload's form as the SDK built it. */
interface Seen {
  paths: string[]; auth: string[];
  upload?: { channelId: string | null; filename: string; type: string; mimeType: string | null; bytes: Uint8Array };
  /** The upload session's create body, the presigned PUT as it was sent, and every request to anywhere but Raft. */
  created?: Record<string, unknown>; put?: { url: string; method: string; headers: Headers; bytes: Uint8Array }; elsewhere: string[];
}
const CHANNEL_UUID = "0b6c3a52-5f1e-4c8e-9a51-1f7d2c3b4a10";
const UPLOAD_UUID = "6a0f1e2d-3c4b-4a59-8e7d-6c5b4a392817";
const SESSION_ATTACHMENT_UUID = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
const PUT_URL = "https://objects.example/bucket/upload-1?X-Amz-Signature=SIG";
/**
 * Raft, faked: the upload limits (`maxBytes`, and `session` for a direct-upload threshold, at or above which the SDK
 * takes an upload session to `putUrl`), the channel a target resolves to, the upload itself (or `uploadFails`), and
 * the credential context a listing reads (`caps`).
 */
function raft(opts: { caps?: string[]; maxBytes?: number; uploadFails?: Response; resolveFails?: Response; session?: { threshold: number; putUrl?: string } } = {}): Seen {
  const seen: Seen = { paths: [], auth: [], elsewhere: [] };
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.origin !== "https://raft.example") {
      seen.elsewhere.push(`${init?.method ?? "GET"} ${u.href}`);
      if (u.href === (opts.session?.putUrl ?? PUT_URL)) {
        seen.put = { url: u.href, method: init?.method ?? "GET", headers: new Headers(init?.headers), bytes: new Uint8Array(init?.body as ArrayBuffer) };
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 404 });
    }
    seen.paths.push(`${init?.method ?? "GET"} ${u.pathname}`);
    seen.auth.push(new Headers(init?.headers).get("authorization") ?? "");
    if (u.pathname === "/internal/agent-api/attachment-upload-capabilities") {
      return json(opts.session
        ? { directUploadEnabled: true, directUploadThresholdBytes: opts.session.threshold, maxBytes: opts.maxBytes ?? 200 * 1024 * 1024, sessionExpiresInSeconds: 900 }
        : { directUploadEnabled: false, directUploadThresholdBytes: null, maxBytes: opts.maxBytes ?? 200 * 1024 * 1024, sessionExpiresInSeconds: null });
    }
    if (u.pathname === "/internal/agent-api/resolve-channel") {
      if (opts.resolveFails) return opts.resolveFails;
      const body = JSON.parse(String(init?.body ?? "{}"));
      // A session's create takes the channel as a UUID; the multipart form takes any id.
      return json({ channelId: opts.session ? CHANNEL_UUID : `ch-${String(body.target).replace(/\W/g, "")}` });
    }
    if (u.pathname === "/internal/agent-api/attachment-upload-sessions" && init?.method === "POST") {
      seen.created = JSON.parse(String(init.body));
      return json({ uploadId: UPLOAD_UUID, attachmentId: SESSION_ATTACHMENT_UUID, state: "pending", expiresAt: "2026-10-17T23:00:00.000Z",
        upload: { method: "PUT", url: opts.session?.putUrl ?? PUT_URL, headers: { "Content-Type": String(seen.created!.mimeType), "If-None-Match": "*" } } });
    }
    if (u.pathname === `/internal/agent-api/attachment-upload-sessions/${UPLOAD_UUID}/complete`) {
      const size = seen.put?.bytes.byteLength ?? 0;
      return json({ uploadId: UPLOAD_UUID, state: "completed",
        attachment: { id: SESSION_ATTACHMENT_UUID, filename: String(seen.created?.filename), mimeType: String(seen.created?.mimeType), sizeBytes: size, thumbnailUrl: null } });
    }
    if (u.pathname === `/internal/agent-api/attachment-upload-sessions/${UPLOAD_UUID}` && init?.method === "DELETE") {
      return json({ uploadId: UPLOAD_UUID, state: "canceled", expiresAt: "2026-10-17T23:00:00.000Z", attachment: null, terminalReason: null });
    }
    if (u.pathname === "/internal/agent-api/upload") {
      if (opts.uploadFails) return opts.uploadFails;
      const form = init?.body as FormData;
      const file = form.get("file") as File;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const mimeType = form.get("mimeType");
      seen.upload = { channelId: form.get("channelId") as string | null, filename: file.name, type: file.type, mimeType: typeof mimeType === "string" ? mimeType : null, bytes };
      return json({ id: "att-up-1", filename: file.name, mimeType: file.type, sizeBytes: bytes.byteLength, thumbnailUrl: null });
    }
    if (u.pathname === "/internal/agent-api/context") {
      return json({ agent: { id: "agent-1", name: "raft-bot", displayName: null, description: null, runtime: "external", external: true },
        server: { id: "server-1", slug: "s", name: "S" }, credential: { capabilities: opts.caps ?? ["read", "send"] }, prompt: null });
    }
    return json({ error: "not found" }, 404);
  }) as any;
  return seen;
}

// ---- the upload ---------------------------------------------------------------------------------------------------

await check("a stored file is uploaded with its bytes and name to the target's channel, as the mount, and the id comes back with the next step", async () => {
  const store = fakeArtifacts({ [OWN_KEY]: PNG });
  const plugin = createRaftPlugin({ artifacts: store });
  const seen = raft();
  const out: any = await plugin.invoke(UPLOAD_TOOL, { ref: OWN_REF, target: "#general" }, ctx());
  must(store.gets.length === 1 && store.gets[0] === OWN_KEY, `read: ${JSON.stringify(store.gets)}`);
  must(seen.upload && Buffer.compare(Buffer.from(seen.upload.bytes), Buffer.from(PNG)) === 0, "the bytes Raft got are not the stored ones");
  // The name defaults to the reference's last segment; the type is read from the bytes (no mimeType given, none sent).
  must(seen.upload!.filename === "out.png" && seen.upload!.type === "image/png" && seen.upload!.mimeType === null, JSON.stringify({ ...seen.upload, bytes: undefined }));
  must(seen.upload!.channelId === "ch-general", `channel: ${seen.upload!.channelId}`);
  must(seen.auth.every((a) => a === `Bearer ${CREDENTIAL}`) && seen.paths.includes("POST /internal/agent-api/upload"), `${seen.paths} ${seen.auth}`);
  must(out.attachmentId === "att-up-1" && out.target === "#general" && out.filename === "out.png" && out.mimeType === "image/png" && out.bytes === PNG.byteLength, JSON.stringify(out));
  must(/not posted/.test(out.next) && out.next.includes("messages_send") && out.next.includes('attachmentIds ["att-up-1"]') && out.next.includes('"#general"'), out.next);
  // Nothing was posted: no message route was called.
  must(!seen.paths.some((p) => /messages/.test(p)), `posted: ${seen.paths}`);
});

await check("a filename and mimeType given are what Raft gets", async () => {
  const seen = raft();
  const out: any = await uploadAttachment({ ref: OWN_REF, target: "dm:@ana", filename: "chart.png", mimeType: "image/x-custom" },
    ctx(), fakeArtifacts({ [OWN_KEY]: PNG }));
  must(seen.upload!.filename === "chart.png" && seen.upload!.type === "image/x-custom" && seen.upload!.mimeType === "image/x-custom", JSON.stringify({ ...seen.upload, bytes: undefined }));
  must(out.filename === "chart.png" && out.mimeType === "image/x-custom", JSON.stringify(out));
});

// ---- the upload session ---------------------------------------------------------------------------------------------

const BIG_KEY = "t/tenant/agent/sandbox/box-1/work/report.bin";
const BIG_REF = "artifact://sandbox/box-1/work/report.bin";
/** About 4 KiB of bytes no two positions of which repeat in a short cycle, so a truncated or shifted body differs. */
const BIG = Uint8Array.from({ length: 4096 + 37 }, (_, i) => (i * 131 + (i >> 8)) & 255);

await check("at or above the Server's direct-upload threshold the SDK's session is taken: create, the presigned PUT of exactly the file, complete; the id is complete's", async () => {
  const seen = raft({ session: { threshold: 1024 } });
  const out: any = await uploadAttachment({ ref: BIG_REF, target: "#general" }, ctx(), fakeArtifacts({ [BIG_KEY]: BIG }));
  const order = seen.paths.filter((p) => p.includes("attachment-upload-sessions") || p.endsWith("/upload"));
  must(JSON.stringify(order) === JSON.stringify(["POST /internal/agent-api/attachment-upload-sessions", `POST /internal/agent-api/attachment-upload-sessions/${UPLOAD_UUID}/complete`]),
    `Raft saw: ${seen.paths}`);
  must(seen.created?.channelId === CHANNEL_UUID && seen.created?.filename === "report.bin" && seen.created?.sizeBytes === BIG.byteLength, JSON.stringify(seen.created));
  must(seen.put && seen.put.method === "PUT" && seen.put.url === PUT_URL, `PUT: ${JSON.stringify(seen.elsewhere)}`);
  must(seen.put!.bytes.byteLength === BIG.byteLength && Buffer.compare(Buffer.from(seen.put!.bytes), Buffer.from(BIG)) === 0, `PUT ${seen.put!.bytes.byteLength} bytes, not the file's ${BIG.byteLength}`);
  // The presigned URL carries its own grant: the mount's credential never goes with it.
  must(!seen.put!.headers.has("authorization") && seen.put!.headers.get("if-none-match") === "*", JSON.stringify([...seen.put!.headers]));
  must(out.attachmentId === SESSION_ATTACHMENT_UUID && out.bytes === BIG.byteLength && out.next.includes(SESSION_ATTACHMENT_UUID), JSON.stringify(out));
  // Control: below the threshold the same file goes as one multipart request, and no session is made.
  const below = raft({ session: { threshold: BIG.byteLength + 1 } });
  const small: any = await uploadAttachment({ ref: BIG_REF, target: "#general" }, ctx(), fakeArtifacts({ [BIG_KEY]: BIG }));
  must(small.attachmentId === "att-up-1" && !below.put && !below.paths.some((p) => p.includes("upload-sessions")), `below: ${below.paths}`);
});

await check("a presigned upload address that is not https, carries a user name, or is on a private network is never sent to; the session is cancelled and the model told why", async () => {
  for (const [putUrl, why] of [
    ["http://objects.example/bucket/upload-1?sig=1", "that is not https"],
    ["https://user:pass@objects.example/bucket/upload-1", "that carries a user name or password"],
    ["https://169.254.169.254/latest/meta-data", "on a private or local network"],
    ["https://localhost/upload", "on a private or local network"],
  ] as const) {
    const seen = raft({ session: { threshold: 1024, putUrl } });
    const e = await failure(() => uploadAttachment({ ref: BIG_REF, target: "#general" }, ctx(), fakeArtifacts({ [BIG_KEY]: BIG })));
    must(e.message === `Raft returned an upload address ${why}; nothing was sent there, and nothing was uploaded`, `${putUrl}: ${e.message}`);
    must(seen.elsewhere.length === 0 && !seen.put, `${putUrl} was fetched: ${seen.elsewhere}`);
    must(seen.paths.includes(`DELETE /internal/agent-api/attachment-upload-sessions/${UPLOAD_UUID}`) && !seen.paths.some((p) => p.endsWith("/complete")),
      `${putUrl}: ${seen.paths}`);
  }
});

// ---- whose file -----------------------------------------------------------------------------------------------------

await check("only the caller's own artifact:// files resolve: raw r2:// refs (another agent's or its own), moving paths and another agent's file are refused, and Raft is not asked", async () => {
  const store = fakeArtifacts({ [OWN_KEY]: PNG, "t/tenant/other/sandbox/box-1/work/out.png": PNG, "t/tenant2/agent/sandbox/box-1/work/out.png": PNG });
  const seen = raft();
  for (const ref of ["r2://bucket/t/tenant/other/sandbox/box-1/work/out.png", `r2://bucket/${OWN_KEY}`, "s3://bucket/x", "sandbox/box-1/work/out.png"]) {
    const e = await failure(() => uploadAttachment({ ref, target: "#general" }, ctx(), store));
    must(/must be an artifact:\/\/… reference/.test(e.message) && /nothing was uploaded/.test(e.message), `${ref}: ${e.message}`);
  }
  for (const ref of ["artifact://../other/sandbox/box-1/work/out.png", "artifact://sandbox/./x", "artifact://"]) {
    const e = await failure(() => uploadAttachment({ ref, target: "#general" }, ctx(), store));
    must(/does not name a file in this agent's storage/.test(e.message), `${ref}: ${e.message}`);
  }
  must(store.gets.length === 0, `read before refusing: ${JSON.stringify(store.gets)}`);
  // Another agent's file by its own path: the reference resolves under the caller's scope, where there is none.
  const other = fakeArtifacts({ "t/tenant/other/sandbox/box-1/work/report.pdf": PNG });
  const e = await failure(() => uploadAttachment({ ref: "artifact://sandbox/box-1/work/report.pdf", target: "#general" }, ctx(), other));
  must(/no file is stored at artifact:\/\/sandbox\/box-1\/work\/report.pdf/.test(e.message), e.message);
  must(other.heads.length === 1 && other.heads[0] === "t/tenant/agent/sandbox/box-1/work/report.pdf" && other.gets.length === 0, `asked for: ${JSON.stringify(other.heads)} ${JSON.stringify(other.gets)}`);
  // Storage failing is not the file being absent: said as a failure that may clear.
  for (const down of [
    { ...fakeArtifacts(), async head(): Promise<{ bytes: number } | null> { throw new Error("R2 timed out"); } },
    { ...fakeArtifacts({ [OWN_KEY]: PNG }), async get(): Promise<Uint8Array> { throw new Error("R2 timed out"); } },
  ]) {
    const d = await failure(() => uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), down));
    must(/storage did not answer/.test(d.message) && (d as any).transient === true && !/R2 timed out/.test(d.message), `${d.message} ${JSON.stringify(d)}`);
  }
  must(seen.paths.length === 0, `Raft was asked: ${seen.paths}`);
});

// ---- size -----------------------------------------------------------------------------------------------------------

await check(`a file over ${UPLOAD_MAX_BYTES / 1024 / 1024} MiB is refused before Raft is asked; one at exactly the limit goes; an empty one is refused`, async () => {
  must(UPLOAD_MAX_BYTES === 25 * 1024 * 1024, `the cap moved: ${UPLOAD_MAX_BYTES}`);
  const over = new Uint8Array(UPLOAD_MAX_BYTES + 1);
  over.set(PNG);
  let seen = raft();
  const e = await failure(() => uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), fakeArtifacts({ [OWN_KEY]: over })));
  must(/over the 25 MiB this mount uploads; nothing was uploaded/.test(e.message) && e.message.includes(String(UPLOAD_MAX_BYTES + 1)), e.message);
  must(seen.paths.length === 0, `Raft was asked: ${seen.paths}`);
  const empty = await failure(() => uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), fakeArtifacts({ [OWN_KEY]: new Uint8Array(0) })));
  must(/is empty/.test(empty.message) && seen.paths.length === 0, empty.message);
  // Control: the limit itself is not over it.
  seen = raft();
  const at: any = await uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), fakeArtifacts({ [OWN_KEY]: over.subarray(0, UPLOAD_MAX_BYTES) }));
  must(at.bytes === UPLOAD_MAX_BYTES && seen.upload?.bytes.byteLength === UPLOAD_MAX_BYTES, JSON.stringify(at));
});

await check("an artifact whose metadata reports 26 MiB is refused from the size alone: its bytes are never read", async () => {
  const seen = raft();
  const store = fakeArtifacts({ [OWN_KEY]: PNG }, { [OWN_KEY]: 26 * 1024 * 1024 });
  const e = await failure(() => uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), store));
  must(/is 26\.0 MiB \(27262976 bytes\), over the 25 MiB this mount uploads; nothing was uploaded/.test(e.message), e.message);
  must(store.heads.length === 1 && store.heads[0] === OWN_KEY, `heads: ${JSON.stringify(store.heads)}`);
  must(store.gets.length === 0, `the bytes were read: ${JSON.stringify(store.gets)}`);
  must(seen.paths.length === 0, `Raft was asked: ${seen.paths}`);
  // Control: the same store reporting the real size is read and uploaded, so it is the size that refused it.
  const small = fakeArtifacts({ [OWN_KEY]: PNG });
  await uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), small);
  must(small.heads.length === 1 && small.gets.length === 1, `${JSON.stringify(small.heads)} ${JSON.stringify(small.gets)}`);
  // And an object that grew past the cap between the size and the read is held to it on the bytes.
  const grew = new Uint8Array(UPLOAD_MAX_BYTES + 1);
  const raced = fakeArtifacts({ [OWN_KEY]: grew }, { [OWN_KEY]: PNG.byteLength });
  const r = await failure(() => uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), raced));
  must(/over the 25 MiB this mount uploads/.test(r.message) && raced.gets.length === 1, r.message);
});

await check("the Server's own, lower limit is the SDK's to apply, and its refusal reaches the model", async () => {
  const seen = raft({ maxBytes: 10 });
  const e = await failure(() => uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), fakeArtifacts({ [OWN_KEY]: PNG })));
  must(/the Server's maximum is 10/.test(e.message), e.message);
  must(!seen.paths.includes("POST /internal/agent-api/upload"), `uploaded anyway: ${seen.paths}`);
});

// ---- Raft's refusals ------------------------------------------------------------------------------------------------

await check("Raft refusing the upload, or the target, is said with its reason and code; not marked as a write that may have landed", async () => {
  raft({ uploadFails: json({ error: "This credential may not upload here", errorCode: "CAPABILITY_NOT_AUTHORIZED" }, 403) });
  const e = await failure(() => uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), fakeArtifacts({ [OWN_KEY]: PNG })));
  must(/does not carry the capability/.test(e.message) && e.message.includes("(HTTP 403, CAPABILITY_NOT_AUTHORIZED)"), e.message);
  must((e as any).mayHaveLanded !== true, `marked as may have landed: ${JSON.stringify(e)}`);
  raft({ resolveFails: json({ error: "No such channel: #nowhere", errorCode: "CHANNEL_NOT_FOUND" }, 404) });
  const r = await failure(() => uploadAttachment({ ref: OWN_REF, target: "#nowhere" }, ctx(), fakeArtifacts({ [OWN_KEY]: PNG })));
  must(/does not exist or is not visible/.test(r.message) && r.message.includes("(HTTP 404, CHANNEL_NOT_FOUND)"), r.message);
  // No answer at all: said in Raft's words and marked as one that may clear, not thrown raw.
  globalThis.fetch = (async () => { throw new TypeError("network down"); }) as any;
  const t = await failure(() => uploadAttachment({ ref: OWN_REF, target: "#general" }, ctx(), fakeArtifacts({ [OWN_KEY]: PNG })));
  must(/did not reach the Raft Server/.test(t.message) && !/network down/.test(t.message) && (t as any).transient === true && (t as any).mayHaveLanded !== true, `${t.message} ${JSON.stringify(t)}`);
});

await check("arguments are checked before anything is read or fetched", async () => {
  const store = fakeArtifacts({ [OWN_KEY]: PNG });
  const seen = raft();
  for (const [args, why] of [
    ["x", /takes an object of arguments/], [null, /takes an object of arguments/],
    [{ target: "#general" }, /ref is required/], [{ ref: OWN_REF }, /target is required/], [{ ref: OWN_REF, target: "  " }, /target is required/],
    [{ ref: OWN_REF, target: "#general", filename: "" }, /filename, when given/],
    [{ ref: OWN_REF, target: "#general", mimeType: "png" }, /mimeType, when given/],
  ] as const) {
    const e = await failure(() => uploadAttachment(args, ctx(), store));
    must(why.test(e.message), `${JSON.stringify(args)}: ${e.message}`);
  }
  must(store.gets.length === 0 && seen.paths.length === 0, `${store.gets} ${seen.paths}`);
});

// ---- where it is offered --------------------------------------------------------------------------------------------

const has = (tools: readonly { name: string }[], name: string) => tools.some((t) => t.name === name);

await check("offered only with storage; with no storage a direct call says why", async () => {
  const withStorage = createRaftPlugin({ artifacts: fakeArtifacts() });
  must(has(withStorage.tools, UPLOAD_TOOL) && has(withStorage.mountTools!({ toolSnapshot: null } as any), UPLOAD_TOOL), "control: not offered with storage");
  must(!has(raftWithoutStorage.tools, UPLOAD_TOOL) && !has(raftWithoutStorage.mountTools!({ toolSnapshot: null } as any), UPLOAD_TOOL), "offered with no storage");
  raft({ caps: ["read", "send"] });
  must(!has((await raftWithoutStorage.snapshotTools!(ctx())).tools, UPLOAD_TOOL), "listed with no storage");
  // Not even from a snapshot a build with storage took.
  const stored = await admitTools(await withStorage.snapshotTools!(ctx()), 0);
  must(has(stored.tools, UPLOAD_TOOL) && !has(raftWithoutStorage.mountTools!({ toolSnapshot: stored } as any), UPLOAD_TOOL), "offered from a snapshot with no storage");
  const why = await failure(() => raftWithoutStorage.invoke(UPLOAD_TOOL, { ref: OWN_REF, target: "#general" }, ctx()) as Promise<unknown>);
  must(/no object storage/.test(why.message), why.message);
});

await check("a credential without send is not listed it, and is told why; one with send is listed and offered it", async () => {
  const plugin = createRaftPlugin({ artifacts: fakeArtifacts() });
  const base: any = { tenantId: "t", agentId: "a", alias: "raft", plugin: "raft" };
  const offered = (snap: any) => toolsOf(plugin, { ...base, toolSnapshot: snap }).map((t) => t.name);
  raft({ caps: ["read"] });
  const listing = await plugin.snapshotTools!(ctx());
  const reading = await admitTools(listing, 0);
  must(!has(reading.tools, UPLOAD_TOOL) && !offered(reading).includes(UPLOAD_TOOL), `read only: ${reading.tools.map((t) => t.name)}`);
  // Read from the listing itself: the stored copy keeps only the first few reasons.
  must(/lacks the Raft capability send$/.test(listing.skipped?.find((s) => s.name === UPLOAD_TOOL)?.reason ?? ""), JSON.stringify(listing.skipped));
  // Control: the same build, a credential with send.
  raft({ caps: ["read", "send"] });
  const sending = await admitTools(await plugin.snapshotTools!(ctx()), 0);
  must(has(sending.tools, UPLOAD_TOOL) && offered(sending).includes(UPLOAD_TOOL), `send: ${sending.tools.map((t) => t.name)}`);
  must(!sending.skipped?.some((s) => s.name === UPLOAD_TOOL), JSON.stringify(sending.skipped));
  // Send alone is enough: the upload does not need the download's read.
  raft({ caps: ["send"] });
  const sendOnly = await admitTools(await plugin.snapshotTools!(ctx()), 0);
  must(offered(sendOnly).includes(UPLOAD_TOOL) && !offered(sendOnly).includes("attachments_download_url"), `send only: ${offered(sendOnly)}`);
});

await check("it is a write: a subagent is never handed it, and approval policy for writes applies", async () => {
  const plugin = createRaftPlugin({ artifacts: fakeArtifacts() });
  const tool = plugin.tools.find((t) => t.name === UPLOAD_TOOL)!;
  must(tool.sideEffects === "write" && tool.idempotency === "none", JSON.stringify(tool));
  must(!childMayCall(tool, plugin.actsAs), "a subagent may call it");
  const withheld = childWithheld(plugin.tools.map((t) => ({ address: `raft.${t.name}`, sideEffects: t.sideEffects })), () => plugin.actsAs);
  must(withheld.has(`raft.${UPLOAD_TOOL}`), `not withheld: ${[...withheld]}`);
  // Control: the read beside it is not withheld, so the set is the read-only rule and not everything.
  must(!withheld.has("raft.attachments_view"), "the view is withheld too");
});

await check("the description says what it takes, the limit, and that it posts nothing until messages_send", async () => {
  const tool = createRaftPlugin({ artifacts: fakeArtifacts() }).tools.find((t) => t.name === UPLOAD_TOOL)!;
  for (const term of ["artifact://", "25 MiB", "Posts nothing", "messages_send", "attachmentIds"]) must(tool.summary.includes(term), `missing ${term}: ${tool.summary}`);
  const p = tool.parameters as any;
  must(JSON.stringify(p.required) === JSON.stringify(["ref", "target"]) && Object.keys(p.properties).join() === "ref,target,filename,mimeType", JSON.stringify(p));
});

globalThis.fetch = originalFetch;
console.log(`\n  raft attachments_upload\n  ${"─".repeat(56)}`);
for (const result of results) {
  console.log(result.ok ? `  \x1b[32m✓\x1b[0m ${result.name}` : `  \x1b[31m✗\x1b[0m ${result.name}\n      \x1b[31m${result.error}\x1b[0m`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
