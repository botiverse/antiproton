/**
 * Forwarding `github.refresh` trace rows to Raft's trace-upload worker (cf/src/github-refresh-forward.ts), on a real
 * SQLite outbox with a recording endpoint: only the allowlisted kind leaves, with exactly the receiver's columns; off
 * (and stateless) until configured; a 413 splits, another 4xx drops and counts, a 5xx keeps the rows and backs off;
 * a 400/422 drops and counts, a 401/403/404 pauses with the rows kept; a request with no answer in time is aborted and
 * treated as no answer, and stops the pass; the R2 export goes on whatever the forward does,
 * and never prunes a row the forward has not copied.
 */
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { appendTrace, pendingTrace, type TraceRow } from "../src/trace/outbox.ts";
import { flushActivityThenTrace } from "../cf/src/activity-raft.ts";
import {
  FORWARD_BACKOFF_BASE_MS, FORWARD_BATCH_MAX, FORWARD_TIMEOUT_MS, FORWARD_COLUMNS, FORWARD_KINDS, forwardConfigOf, forwardCursor, forwardPass, forwardRow,
  ingestRequest, sendForward, stageForward, type ForwardConfig, type ForwardRow,
} from "../cf/src/github-refresh-forward.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const OWNER = { tenantId: "raft_t1", agentId: "raft_a1" };
const BASE = "https://ingest.example/";
const TOKEN = "tok_fake_write_only";
const ENV = { GITHUB_REFRESH_INGEST_URL: BASE, GITHUB_REFRESH_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" };
const CFG = forwardConfigOf(ENV)!;
const OUTCOMES = ["rotated", "adopted", "broken", "unavailable", "store-failed", "kept-unstored", "interrupted-before", "propagate-failed"] as const;
const T0 = 1_790_000_000_000;

const refresh = (n: number, outcome: string = "rotated", attrs: Record<string, unknown> = {}): TraceRow => ({
  at: T0 + n * 1000, ...OWNER, kind: "github.refresh", spanId: `refresh_${n}`, status: outcome,
  verdict: outcome === "rotated" || outcome === "adopted" ? "ok" : "failed",
  attrs: { scope: "mount", connectorId: "conn_1", mount: "gh", why: "expiring", attempt: 1, stored: true, reasonCode: "no-answer", ...attrs },
});
const tool = (n: number): TraceRow => ({ at: T0 + n * 1000, ...OWNER, kind: "tool.call", spanId: `op_${n}`, status: "succeeded", verdict: "ok", ms: 5, attrs: { tool: "x", mount: "gh" } });
const model = (n: number): TraceRow => ({ at: T0 + n * 1000, ...OWNER, kind: "model.call", spanId: `mj_${n}`, status: "stop", verdict: "ok", attrs: { model: "m" } });

/** A recording endpoint. `answer` decides each request's status from the rows it carries; a thrown error is "no answer". */
function endpoint(answer: (rows: ForwardRow[]) => number | Error = () => 200) {
  const e = {
    requests: [] as Array<{ url: string; headers: Record<string, string>; rows: ForwardRow[]; status: number | "error"; bytes: number }>,
    answer,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      const body = init.body as Uint8Array;
      must(body instanceof Uint8Array, "the body is not fully buffered bytes");
      const rows = JSON.parse(new TextDecoder().decode(body)).rows as ForwardRow[];
      const a = e.answer(rows);
      e.requests.push({ url, headers: init.headers as Record<string, string>, rows, status: a instanceof Error ? "error" : a, bytes: body.byteLength });
      if (a instanceof Error) throw a;
      return new Response(null, { status: a });
    },
  };
  return e;
}
const queued = (sql: any): number[] => sql.exec("SELECT seq FROM ghr_forward_queue ORDER BY seq").toArray().map((r: any) => Number(r.seq));
const dropsOf = (sql: any) => sql.exec("SELECT reason, status, rows FROM ghr_forward_log ORDER BY at").toArray();
const left = (sql: any) => Number(sql.exec("SELECT COUNT(*) AS n FROM trace_outbox").toArray()[0].n);
const tables = (sql: any): string[] => sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ghr_%'").toArray().map((r: any) => String(r.name));
const sent = (e: ReturnType<typeof endpoint>) => e.requests.filter((r) => r.status === 200).flatMap((r) => r.rows);
const idOf = (r: ForwardRow) => `${r.tenant_id}/${r.agent_id}/${r.seq}`;
/** A pass as the alarm runs it: stage, export (with activity), send. */
async function pass(sql: any, e: ReturnType<typeof endpoint>, bucket: { put(k: string, b: Uint8Array): Promise<unknown> }, env: Record<string, unknown> = ENV) {
  const gateway = { async reportActivity() { return [{ alias: "raft", skipped: "push is disabled" }]; } };
  const f = forwardPass(env, sql, OWNER.tenantId, OWNER.agentId, e.fetch);
  const hold = f.before();
  const flushed = await flushActivityThenTrace(gateway, bucket, sql, OWNER.tenantId, OWNER.agentId, undefined, hold);
  return { hold, flushed, forwarded: await f.after() };
}
/** A bucket that keeps the trace batches it is given (the day index's empty markers are not batches). */
const r2 = () => { const puts: string[] = []; return { puts, async put(k: string, b: Uint8Array) { if (k.startsWith("trace/")) puts.push(new TextDecoder().decode(b)); } }; };

console.log(`\n  github.refresh forward\n  ${"─".repeat(56)}`);

await check("the allowlist is one kind, github.refresh, and only its rows are forwarded", async () => {
  must(FORWARD_KINDS.length === 1 && FORWARD_KINDS[0] === "github.refresh", `allowlist: ${JSON.stringify(FORWARD_KINDS)}`);
  const { sql } = sqliteHost(); const e = endpoint();
  appendTrace(sql, [tool(1), refresh(2), model(3), { ...tool(4), kind: "raft.mcp_call" }, refresh(5, "broken")]);
  await pass(sql, e, r2());
  must(e.requests.length === 1, `requests: ${e.requests.length}`);
  must(sent(e).map((r) => r.seq).join(",") === "2,5", `forwarded seqs: ${sent(e).map((r) => r.seq)}`);
});

await check("a forwarded row is exactly the receiver's columns, built from the row, and carries nothing else it held", async () => {
  const { sql } = sqliteHost(); const e = endpoint();
  // Extra attrs a future writer might add, one of them token-shaped: none may ride along.
  appendTrace(sql, [refresh(1, "kept-unstored", { attempt: 3, stored: false, reasonCode: "d1-write-failed", token: "ghu_secret", reason: "GitHub said x" })]);
  await pass(sql, e, r2());
  const [row] = sent(e);
  must(row, "nothing was forwarded");
  must(JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...FORWARD_COLUMNS].sort()), `fields: ${Object.keys(row).sort()}`);
  must(JSON.stringify([...FORWARD_COLUMNS].sort()) === JSON.stringify(["agent_id", "at", "attempt", "connector_id", "env", "mount", "outcome", "reason_code", "scope", "seq", "stored", "tenant_id", "why"]),
    `the column list moved: ${FORWARD_COLUMNS}`);
  const want: ForwardRow = { at: new Date(T0 + 1000).toISOString(), tenant_id: OWNER.tenantId, agent_id: OWNER.agentId, seq: 1, env: "preview",
    outcome: "kept-unstored", scope: "mount", connector_id: "conn_1", mount: "gh", why: "expiring", attempt: 3, stored: false, reason_code: "d1-write-failed" };
  must(JSON.stringify(row) === JSON.stringify(want), `row: ${JSON.stringify(row)}`);
  const wire = JSON.stringify(e.requests[0]!.rows);
  must(!/ghu_|GitHub said|span|verdict|attrs/.test(wire), `something beyond the columns was sent: ${wire}`);
  // A missing attr is null, never a guess; a wrong-typed one is null too.
  const sparse = forwardRow({ ...pendingTrace(sql, 0).rows[0] ?? { seq: 9, at: T0, ...OWNER, kind: "github.refresh", spanId: "s", status: "broken", verdict: "failed" }, attrs: { scope: "connector", attempt: "2", stored: "yes" } } as any, "production");
  must(sparse.mount === null && sparse.attempt === null && sparse.stored === null && sparse.scope === "connector" && sparse.env === "production", JSON.stringify(sparse));
});

await check("all eight outcomes pass through, rotated and adopted included", async () => {
  const { sql } = sqliteHost(); const e = endpoint();
  appendTrace(sql, OUTCOMES.map((o, i) => refresh(i + 1, o)));
  await pass(sql, e, r2());
  must(sent(e).map((r) => r.outcome).join(",") === OUTCOMES.join(","), `outcomes: ${sent(e).map((r) => r.outcome)}`);
});

await check("off unless the URL, the token and the deployment are all set: no request, no hold, no table", async () => {
  for (const missing of ["GITHUB_REFRESH_INGEST_URL", "GITHUB_REFRESH_INGEST_TOKEN", "DEPLOYMENT_ENV"] as const) {
    for (const value of [undefined, "", "  "]) {
      const env: Record<string, unknown> = { ...ENV, [missing]: value };
      must(forwardConfigOf(env) === null, `on with ${missing}=${JSON.stringify(value)}`);
      const { sql } = sqliteHost(); const e = endpoint(); const bucket = r2();
      appendTrace(sql, [refresh(1), tool(2)]);
      const p = await pass(sql, e, bucket, env);
      must(p.hold === null && p.forwarded === null && e.requests.length === 0, `forwarded with ${missing} unset: ${JSON.stringify(p)}`);
      must(tables(sql).length === 0, `state made while off: ${tables(sql)}`);
      must(bucket.puts.length === 1 && left(sql) === 0, "the export did not run as before");
    }
  }
  must(forwardConfigOf({ ...ENV, DEPLOYMENT_ENV: "staging" }) === null, "an unknown deployment name turned it on");
  must(forwardConfigOf({ ...ENV, DEPLOYMENT_ENV: "production" })?.env === "production", "production is not production");
});

await check("the request: POST <base>/api/external/github-refresh, bearer token, {rows}, buffered with its Content-Length", async () => {
  const rows = [forwardRow({ ...refresh(1), seq: 1 } as any, "preview")];
  const { url, init } = ingestRequest(CFG, rows);
  const h = init.headers as Record<string, string>;
  must(url === "https://ingest.example/api/external/github-refresh", `url: ${url}`);
  must(init.method === "POST" && h.authorization === `Bearer ${TOKEN}` && h["content-type"] === "application/json", JSON.stringify({ ...h, authorization: "-" }));
  must(init.body instanceof Uint8Array && h["content-length"] === String(init.body.byteLength), `content-length ${h["content-length"]} for ${init.body.byteLength} bytes`);
  const parsed = JSON.parse(new TextDecoder().decode(init.body));
  must(JSON.stringify(Object.keys(parsed)) === '["rows"]' && parsed.rows.length === 1 && parsed.rows[0].seq === 1, JSON.stringify(parsed));
});

await check("at most 500 rows a request, oldest first", async () => {
  const { sql } = sqliteHost(); const e = endpoint();
  appendTrace(sql, Array.from({ length: 1_200 }, (_, i) => refresh(i + 1)));
  await pass(sql, e, r2());
  must(e.requests.map((r) => r.rows.length).join(",") === `${FORWARD_BATCH_MAX},${FORWARD_BATCH_MAX},200`, `batches: ${e.requests.map((r) => r.rows.length)}`);
  must(sent(e).every((r, i) => r.seq === i + 1) && queued(sql).length === 0, "not sent oldest first, or something was kept");
});

await check("a 413 splits the batch in half until it fits; a single row still too large is dropped, logged and counted", async () => {
  const { sql } = sqliteHost();
  // More than two rows is too large, and row 4 is too large on its own.
  const e = endpoint((rows) => rows.length > 2 || rows.some((r) => r.seq === 4) ? 413 : 200);
  appendTrace(sql, Array.from({ length: 7 }, (_, i) => refresh(i + 1)));
  const { forwarded } = await pass(sql, e, r2());
  must(sent(e).map((r) => r.seq).join(",") === "1,2,3,5,6,7", `accepted: ${sent(e).map((r) => r.seq)}`);
  must(forwarded!.sent === 6 && forwarded!.dropped === 1 && forwarded!.error === null && queued(sql).length === 0, JSON.stringify(forwarded));
  must(JSON.stringify(dropsOf(sql)) === JSON.stringify([{ reason: "too-large", status: 413, rows: 1 }]), JSON.stringify(dropsOf(sql)));
  must(e.requests.every((r) => r.headers["content-length"] === String(r.bytes)), "a split request lost its Content-Length");
});

await check("a 400 or 422 skips the batch, counted as schema with its status, and the queue moves on instead of wedging", async () => {
  for (const status of [400, 422]) {
    const { sql } = sqliteHost(); const e = endpoint(() => status);
    appendTrace(sql, [refresh(1), refresh(2)]);
    const first = (await pass(sql, e, r2())).forwarded!;
    must(first.dropped === 2 && first.error === null && queued(sql).length === 0, JSON.stringify(first));
    must(JSON.stringify(dropsOf(sql)) === JSON.stringify([{ reason: "schema", status, rows: 2 }]), JSON.stringify(dropsOf(sql)));
    e.answer = () => 200;
    appendTrace(sql, [refresh(3)]);
    await pass(sql, e, r2());
    must(sent(e).map((r) => r.seq).join(",") === "3", `after the skip: ${sent(e).map((r) => r.seq)}`);
  }
  // Another 4xx is dropped too, under its own reason.
  const { sql } = sqliteHost();
  appendTrace(sql, [refresh(1)]);
  await pass(sql, endpoint(() => 409), r2());
  must(JSON.stringify(dropsOf(sql)) === JSON.stringify([{ reason: "rejected", status: 409, rows: 1 }]) && queued(sql).length === 0, JSON.stringify(dropsOf(sql)));
});

await check("a 401, 403 or 404 pauses: nothing dropped, the rows kept, counted as auth_or_off; after a 2xx the backlog drains", async () => {
  for (const status of [401, 403, 404]) {
    const { sql } = sqliteHost(); let now = T0;
    const e = endpoint(() => status);
    appendTrace(sql, [refresh(1), tool(2), refresh(3)]);
    stageForward(sql, CFG, OWNER.tenantId, OWNER.agentId);
    const paused = await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, e.fetch, () => now);
    must(paused.dropped === 0 && paused.kept === 2 && paused.error === `auth_or_off: http-${status}` && queued(sql).join(",") === "1,3", JSON.stringify(paused));
    must(JSON.stringify(dropsOf(sql)) === JSON.stringify([{ reason: "auth_or_off", status, rows: 2 }]), JSON.stringify(dropsOf(sql)));
    // More rows arrive while paused; they wait with the rest.
    appendTrace(sql, [refresh(4)]);
    stageForward(sql, CFG, OWNER.tenantId, OWNER.agentId);
    now += FORWARD_BACKOFF_BASE_MS;
    e.answer = () => 200;
    const drained = await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, e.fetch, () => now);
    must(drained.sent === 3 && queued(sql).length === 0 && sent(e).map((r) => r.seq).join(",") === "1,3,4", JSON.stringify({ drained, s: sent(e).map((r) => r.seq) }));
  }
});

await check("a paused forward never holds the outbox: the export prunes every row, and only the queue waits, bounded", async () => {
  const { sql } = sqliteHost(); const bucket = r2();
  appendTrace(sql, [tool(1), refresh(2), model(3)]);
  const p = await pass(sql, endpoint(() => 401), bucket);
  must(p.flushed.traceError === null && left(sql) === 0 && queued(sql).join(",") === "2", JSON.stringify({ p, left: left(sql), q: queued(sql) }));
  // Past FORWARD_QUEUE_MAX, the oldest are dropped and counted as lost.
  const { FORWARD_QUEUE_MAX } = await import("../cf/src/github-refresh-forward.ts");
  const { sql: big } = sqliteHost();
  appendTrace(big, Array.from({ length: FORWARD_QUEUE_MAX + 3 }, (_, i) => refresh(i + 1)));
  stageForward(big, CFG, OWNER.tenantId, OWNER.agentId); stageForward(big, CFG, OWNER.tenantId, OWNER.agentId);
  stageForward(big, CFG, OWNER.tenantId, OWNER.agentId);
  const q = queued(big);
  must(q.length === FORWARD_QUEUE_MAX && q[0] === 4, `queue ${q.length} from ${q[0]}`);
  must(JSON.stringify(dropsOf(big).filter((d: any) => d.reason === "lost").map((d: any) => d.rows)) === "[3]", JSON.stringify(dropsOf(big)));
});

await check("a 5xx or no answer keeps the rows, backs off, and the retry sends the same (tenant, agent, seq)", async () => {
  const { sql } = sqliteHost(); let now = T0;
  const e = endpoint(() => 503);
  appendTrace(sql, [refresh(1, "rotated"), tool(2), refresh(3, "broken")]);
  stageForward(sql, CFG, OWNER.tenantId, OWNER.agentId);
  const first = await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, e.fetch, () => now);
  must(first.error === "unavailable: http-503" && first.kept === 2 && queued(sql).join(",") === "1,3", JSON.stringify(first));
  const tried = e.requests.at(-1)!.rows.map(idOf);
  // Within the backoff: nothing is sent.
  now += FORWARD_BACKOFF_BASE_MS - 1;
  const waiting = await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, e.fetch, () => now);
  must(waiting.skipped === "backoff" && e.requests.length === 1, JSON.stringify(waiting));
  // After it, no answer at all: still kept, and the next wait is longer.
  now += 1;
  e.answer = () => new TypeError(`fetch failed for ${BASE} with ${TOKEN}`);
  const lost = await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, e.fetch, () => now);
  must(lost.error?.startsWith("network:") && lost.kept === 2, JSON.stringify(lost));
  must(!lost.error!.includes(TOKEN) && !lost.error!.includes("ingest.example"), `the error carries the request: ${lost.error}`);
  now += FORWARD_BACKOFF_BASE_MS;
  must((await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, e.fetch, () => now)).skipped === "backoff", "the second backoff did not double");
  now += FORWARD_BACKOFF_BASE_MS;
  e.answer = () => 200;
  const ok = await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, e.fetch, () => now);
  must(ok.sent === 2 && ok.error === null && queued(sql).length === 0, JSON.stringify(ok));
  must(JSON.stringify(sent(e).map(idOf)) === JSON.stringify(tried) && tried.join(",") === "raft_t1/raft_a1/1,raft_t1/raft_a1/3", `retried ${sent(e).map(idOf)} after ${tried}`);
  // Success clears the backoff: the next row goes at once.
  appendTrace(sql, [refresh(4)]);
  stageForward(sql, CFG, OWNER.tenantId, OWNER.agentId);
  must((await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, e.fetch, () => now)).sent === 1, "the backoff outlived a success");
});

/**
 * An endpoint that never answers the requests `hangs` picks (they wait on their signal, as a real fetch does, and
 * would wait forever without one) and answers the rest with 200 or 413 as `answer` says. `ignoreSignal` makes a hung
 * request deaf to its signal too, as if the fetch implementation did not honour it.
 */
function hanging(hangs: (rows: ForwardRow[]) => boolean, answer: (rows: ForwardRow[]) => number = () => 200, ignoreSignal = false) {
  const h = {
    hangs, answer,
    requests: [] as Array<{ rows: ForwardRow[]; signal: AbortSignal | null; outcome: number | "aborted" | "hung" }>,
    fetch: async (_url: string, init: RequestInit): Promise<Response> => {
      const rows = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)).rows as ForwardRow[];
      const req = { rows, signal: init.signal ?? null, outcome: "hung" as number | "aborted" | "hung" };
      h.requests.push(req);
      if (!h.hangs(rows)) { req.outcome = h.answer(rows); return new Response(null, { status: req.outcome }); }
      return new Promise<Response>((_, reject) => {
        if (ignoreSignal || !init.signal) return;
        init.signal.addEventListener("abort", () => { req.outcome = "aborted"; reject(init.signal!.reason); });
      });
    },
  };
  return h;
}
/** Fails, rather than hangs, a send that is still waiting after `ms`: what the test reports when there is no timeout. */
async function within<T>(ms: number, p: Promise<T>): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`the send was still waiting after ${ms} ms: no timeout`)), ms); })]); }
  finally { clearTimeout(t); }
}
const SHORT = 30;

await check("a request with no answer in time is aborted: the rows kept, counted unavailable, backed off; the retry drains on 2xx", async () => {
  must(FORWARD_TIMEOUT_MS === 10_000, `the timeout is ${FORWARD_TIMEOUT_MS}`);
  const { sql } = sqliteHost(); let now = T0;
  const h = hanging(() => true);
  appendTrace(sql, [refresh(1), tool(2), refresh(3, "broken")]);
  stageForward(sql, CFG, OWNER.tenantId, OWNER.agentId);
  const started = Date.now();
  const first = await within(2_000, sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, h.fetch, () => now, SHORT));
  const took = Date.now() - started;
  must(h.requests.length === 1 && h.requests[0]!.outcome === "aborted" && h.requests[0]!.signal?.aborted, `not aborted: ${JSON.stringify(h.requests.map((r) => r.outcome))}`);
  must(took < 1_000, `the send took ${took} ms`);
  must(first.error === "network: TimeoutError" && first.kept === 2 && first.sent === 0 && first.dropped === 0, JSON.stringify(first));
  must(queued(sql).join(",") === "1,3", `rows not kept: ${queued(sql)}`);
  must(JSON.stringify(dropsOf(sql)) === JSON.stringify([{ reason: "unavailable", status: null, rows: 2 }]), JSON.stringify(dropsOf(sql)));
  // The backoff applies as for any other no answer.
  now += FORWARD_BACKOFF_BASE_MS - 1;
  must((await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, h.fetch, () => now, SHORT)).skipped === "backoff", "a timeout did not back off");
  // The next pass after it: the receiver answers, and the same rows drain.
  now += 1;
  h.hangs = () => false;
  const ok = await within(2_000, sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, h.fetch, () => now, SHORT));
  must(ok.sent === 2 && ok.error === null && queued(sql).length === 0, JSON.stringify(ok));
  must(h.requests.at(-1)!.rows.map(idOf).join(",") === h.requests[0]!.rows.map(idOf).join(","), "the retry did not send the same rows");
});

await check("a timeout stops the pass: no later batch is sent, and a fetch deaf to its signal still costs one timeout", async () => {
  const { sql } = sqliteHost();
  // Deaf: the request never settles, even when aborted; the pass must stop waiting for it all the same.
  const h = hanging((rows) => rows[0]!.seq === 1, () => 200, true);
  appendTrace(sql, Array.from({ length: FORWARD_BATCH_MAX * 2 + 10 }, (_, i) => refresh(i + 1)));
  stageForward(sql, CFG, OWNER.tenantId, OWNER.agentId);
  const started = Date.now();
  const r = await within(2_000, sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, h.fetch, () => T0, SHORT));
  must(Date.now() - started < 1_000, `the pass waited ${Date.now() - started} ms`);
  must(h.requests.length === 1 && h.requests[0]!.signal?.aborted, `requests after a timeout: ${h.requests.length}`);
  must(r.error === "network: TimeoutError" && r.kept === FORWARD_BATCH_MAX * 2 + 10 && r.sent === 0, JSON.stringify(r));
});

await check("each half of a 413 split has its own timeout, and a half that times out stops the rest", async () => {
  const { sql } = sqliteHost();
  // Four rows is too large; of the halves, the one starting at row 3 hangs.
  const h = hanging((rows) => rows.length <= 2 && rows[0]!.seq === 3, (rows) => rows.length > 2 ? 413 : 200);
  appendTrace(sql, Array.from({ length: 8 }, (_, i) => refresh(i + 1)));
  stageForward(sql, CFG, OWNER.tenantId, OWNER.agentId);
  const r = await within(2_000, sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, h.fetch, () => T0, SHORT));
  // 1-8 (413), 1-4 (413), 1-2 (200), 3-4 (hangs, aborted); 5-8 never tried in this pass.
  must(h.requests.map((q) => `${q.rows[0]!.seq}-${q.rows.at(-1)!.seq}:${q.outcome}`).join(" ") === "1-8:413 1-4:413 1-2:200 3-4:aborted",
    h.requests.map((q) => `${q.rows[0]!.seq}-${q.rows.at(-1)!.seq}:${q.outcome}`).join(" "));
  const signals = h.requests.map((q) => q.signal);
  must(signals.every(Boolean) && new Set(signals).size === signals.length, "the split's requests share a signal");
  must(!signals[2]!.aborted && signals[3]!.aborted, "the wrong request was aborted");
  must(r.sent === 2 && r.error === "network: TimeoutError" && queued(sql).join(",") === "3,4,5,6,7,8", JSON.stringify({ r, q: queued(sql) }));
});

await check("a failing forward leaves the R2 export whole: every row exported and pruned, the forward's rows kept in its own queue", async () => {
  const { sql } = sqliteHost(); const e = endpoint(() => 500); const bucket = r2();
  appendTrace(sql, [tool(1), refresh(2), model(3), refresh(4, "unavailable")]);
  const p = await pass(sql, e, bucket);
  must(p.flushed.traceError === null && p.flushed.activityError === null, JSON.stringify(p.flushed));
  must(bucket.puts.length === 1 && bucket.puts[0]!.trim().split("\n").length === 4, `export: ${bucket.puts}`);
  must(left(sql) === 0, `outbox rows left behind the export: ${left(sql)}`);
  must(p.forwarded!.error === "unavailable: http-500" && queued(sql).join(",") === "2,4", JSON.stringify({ f: p.forwarded, q: queued(sql) }));
  // The same with an endpoint that throws instead of answering.
  const { sql: sql2 } = sqliteHost(); const bucket2 = r2();
  appendTrace(sql2, [refresh(1)]);
  const p2 = await pass(sql2, endpoint(() => new Error("connection reset")), bucket2);
  must(p2.flushed.traceError === null && bucket2.puts.length === 1 && left(sql2) === 0 && queued(sql2).join(",") === "1", JSON.stringify(p2));
});

await check("the export never prunes a row the forward has not staged, and a failing export does not hold the forward", async () => {
  const { sql } = sqliteHost(); const bucket = r2();
  appendTrace(sql, [refresh(1), tool(2)]);
  // A forward behind (cursor 0, as when its stage failed): the export goes ahead but keeps the rows.
  const gateway = { async reportActivity() { return [{ alias: "raft", skipped: "off" }]; } };
  await flushActivityThenTrace(gateway, bucket, sql, OWNER.tenantId, OWNER.agentId, undefined, 0);
  must(bucket.puts.length === 1 && left(sql) === 2, `exported ${bucket.puts.length}, left ${left(sql)}`);
  // The export failing: the forward still stages and sends.
  const e = endpoint();
  const failing = { async put() { throw new Error("r2 unavailable"); } };
  appendTrace(sql, [refresh(3)]);
  const p = await pass(sql, e, failing);
  must(/r2 unavailable/.test(p.flushed.traceError ?? "") && sent(e).map((r) => r.seq).join(",") === "1,3" && forwardCursor(sql) === 3, JSON.stringify({ p, s: sent(e) }));
  must(left(sql) === 3, `a failed export pruned: ${left(sql)}`);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
