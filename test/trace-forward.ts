/**
 * Forwarding trace rows to Raft's trace-upload worker (cf/src/trace-forward.ts). First the `github.refresh` lane, on a real
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
  ingestRequest, sendForward, stageForward, GITHUB_REFRESH_LANE, AGENT_TRACE_LANE, AGENT_TRACE_KINDS, AGENT_TRACE_FIELDS, FORWARD_BATCH_BYTES,
  type ForwardConfig, type ForwardRow,
} from "../cf/src/trace-forward.ts";
import { TRACE_KINDS, type TraceKind } from "../src/trace/outbox.ts";
import { modelAttemptRow, modelCallRow, toolCallRow, toolRefusedRow } from "../src/trace/seams.ts";
import { turnStopRow } from "../src/runtime/turn-stop.ts";
import { closeTurn, turnInbound, turnSaid, turnStepStart, turnToolRan } from "../src/runtime/turn-timing.ts";
import { notifyAttrs } from "../src/plugins/raft-assistant.ts";

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
  const f = forwardPass(env, sql, OWNER.tenantId, OWNER.agentId, e.fetch, [GITHUB_REFRESH_LANE]);
  const hold = f.before();
  const flushed = await flushActivityThenTrace(gateway, bucket, sql, OWNER.tenantId, OWNER.agentId, undefined, hold);
  const after = await f.after();
  return { hold, flushed, forwarded: after === null ? null : after["github.refresh"]! };
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
  const { FORWARD_QUEUE_MAX } = await import("../cf/src/trace-forward.ts");
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


// ---------------------------------------------------------------------------------------------------------------------
// The agent.trace lane: POST /api/external/antiproton-trace (botiverse/slock#10530).

console.log(`\n  agent.trace forward\n  ${"─".repeat(56)}`);

/**
 * The receiver's fields per kind, as botiverse/slock#10530 (9e555880) has them in
 * the trace-upload worker's `antiprotonTrace.ts`, `ANTIPROTON_TRACE_KINDS`. Pinned here so a drift on
 * either side shows; the two it has that nothing here fills are listed in WORKER_UNFILLED.
 */
const WORKER_FIELDS: Record<string, string[]> = {
  "model.call": ["model", "stop_reason", "input", "output", "cache_read", "cache_write", "reasoning", "first_tool", "turn", "session"],
  "model.attempt": ["attempt", "phase", "outcome", "total_ms", "provider_ms", "model"],
  "tool.call": ["tool", "mount", "task", "run_ms", "exit_code", "denied", "error_code"],
  "tool.refused": ["tool", "code", "by", "from"],
  "turn.timing": ["inbound_to_start_ms", "start_to_first_job_ms", "model_ms", "between_jobs_ms", "tool_ms", "last_answer_to_reply_ms",
    "model_jobs", "tools", "messages", "first_call_prompt_tokens", "first_call_cached_tokens"],
  "turn.stop": ["trigger", "error_class"],
  "raft.assistant_wake": ["result", "trigger", "conversations", "candidates", "seen", "unreadable", "lag_retry", "caught_up", "caught_up_via", "caught_up_rule"],
  "raft.assistant_notify": ["state", "items_in", "items_sent", "dropped", "dropped_already_told", "dropped_rule", "dropped_unresolved", "dropped_other"],
  "raft.turn_ended": ["result", "reason", "conversations"],
};
/** turn.stop's errorClass is a sentence ("stopped: by owner") the receiver's id shape refuses; dropped_unresolved has no source. */
const WORKER_UNFILLED = ["turn.stop.error_class", "raft.assistant_notify.dropped_unresolved"];
const ENVELOPE = ["seq", "at", "kind", "tenant_id", "agent_id", "span_id", "env", "status", "verdict", "ms"];

const ATR = (sql: any): number[] => sql.exec("SELECT seq FROM atr_forward_queue ORDER BY seq").toArray().map((r: any) => Number(r.seq));
const atrLog = (sql: any) => sql.exec("SELECT reason, status, rows FROM atr_forward_log ORDER BY at").toArray();
/** An endpoint that tells the routes apart: `answer(path, rows)`. Bodies are kept as text, to search for what must not be there. */
function routes(answer: (path: string, rows: any[]) => number = () => 200) {
  const e = {
    requests: [] as Array<{ path: string; headers: Record<string, string>; rows: any[]; text: string; bytes: number; status: number }>,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      const body = init.body as Uint8Array;
      const text = new TextDecoder().decode(body);
      const rows = JSON.parse(text).rows;
      const path = new URL(url).pathname;
      const status = answer(path, rows);
      e.requests.push({ path, headers: init.headers as Record<string, string>, rows, text, bytes: body.byteLength, status });
      return new Response(null, { status });
    },
  };
  return e;
}
const TRACE_PATH = "/api/external/antiproton-trace";
const GHR_PATH = "/api/external/github-refresh";
const traced = (e: ReturnType<typeof routes>) => e.requests.filter((r) => r.path === TRACE_PATH && r.status === 200).flatMap((r) => r.rows);
async function lanePass(sql: any, e: ReturnType<typeof routes>, env: Record<string, unknown> = ENV) {
  const gateway = { async reportActivity() { return [{ alias: "raft", skipped: "push is disabled" }]; } };
  const f = forwardPass(env, sql, OWNER.tenantId, OWNER.agentId, e.fetch);
  const hold = f.before();
  const flushed = await flushActivityThenTrace(gateway, r2(), sql, OWNER.tenantId, OWNER.agentId, undefined, hold);
  return { hold, flushed, forwarded: await f.after() };
}

/** One row of each kind, from the writers themselves where they can be called, else with the exact attrs their writer sets. */
function everyKind(sql: any): void {
  const t = { ...OWNER };
  appendTrace(sql, [modelCallRow({
    ...t, jobId: "mj_aaa", stopReason: "toolUse", model: "anthropic/claude-sonnet-4.5", at: T0, createdAt: T0 - 4_000, answeredAt: T0,
    usage: { input: 1200, output: 80, cacheRead: 1000, cacheWrite: 200, reasoning: 12 }, session: "main", firstTool: "raft__messages_send",
    turn: "tt_main@1789999990000", limit: "You have spent your daily limit of $5", prefix: { same: 3 },
  })]);
  appendTrace(sql, [modelAttemptRow({ ...t, jobId: "mj_aaa", at: T0 + 1 }, {
    attempt: 2, phase: "call", outcome: "http", httpStatus: 529, errorClass: "OverloadedError", ms: 36_100, providerMs: 35_900,
    model: "anthropic/claude-sonnet-4.5", message: "overloaded: body {\"error\":\"x\"}",
  })]);
  appendTrace(sql, [toolCallRow({
    ...t, taskId: "task_1", operationId: "op_1", mountAlias: "raft", tool: "messages.send", status: "failed", modelName: "raft__messages_send",
    createdAt: T0, endedAt: T0 + 900, callId: "call_x|fc_y", exitCode: -1, startedAt: T0 + 100, denied: false,
    failure: { code: "NOT_FOUND", httpStatus: 404, message: "channel #secret-plans not found for user alice@example.com" },
  })]);
  appendTrace(sql, [toolRefusedRow({ ...t, at: T0 + 3, tool: "gh.api_get", code: "unknown_tool", callId: "call_r|fc_r", by: "run_js", fromProgram: true, task: "task_1" })]);
  turnInbound(sql, "main", T0 - 10_000, { stale: false });
  turnSaid(sql, "main", T0 - 9_900);
  turnStepStart(sql, "main", T0 - 9_000);
  turnToolRan(sql, "main", 700);
  closeTurn(sql, { ...t, session: "main", replyAt: T0 + 4, status: "completed" });
  appendTrace(sql, [turnStopRow({ ...t, operationId: "op_stop", trigger: "provider_stop", at: T0 + 5, turn: "tt_main@1789999990000" })]);
  // raft-assistant.ts `record`: { trigger, ...counts } on the mount's span (a wake has no operation: gateway.ts `trace`).
  appendTrace(sql, [{ at: T0 + 6, ...t, kind: "raft.assistant_wake", spanId: "mount:assistant", status: "invoked", verdict: "ok",
    attrs: { mount: "assistant", trigger: "doorbell", conversations: 4, candidates: 2, muted: 1, told: 0, seen: 1, unreadable: 0,
      lagRetry: 1, caught_up: true, caught_up_rule: "seq", caught_up_via: "mixed" } }]);
  appendTrace(sql, [{ at: T0 + 7, ...t, kind: "raft.assistant_notify", spanId: "op_notify", status: "sent", verdict: "ok",
    attrs: { mount: "assistant", ...notifyAttrs({ items: [{}, {}, {}, {}] }, {
      state: "sent", items: 1, dropped: { "#a:1": "already told", "#b:2": "rule r_1", "#c:3": "not in a conversation this check was given" },
    }) } }]);
  // raft.ts `reportTurnEnd`.
  appendTrace(sql, [{ at: T0 + 8, ...t, kind: "raft.turn_ended", spanId: "mount:raft", status: "skipped", verdict: "ok",
    attrs: { mount: "raft", outcome: "completed", targets: 3, reason: "snapshot_stale", snapshotMismatches: 1 } }]);
}

const GOLDEN: Record<string, Record<string, unknown>> = {
  "model.call": { seq: 1, at: new Date(T0).toISOString(), kind: "model.call", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "mj_aaa", env: "preview",
    status: "tool_use", verdict: "ok", ms: 4000, model: "anthropic/claude-sonnet-4.5", stop_reason: "tool_use", input: 1200, output: 80,
    cache_read: 1000, cache_write: 200, reasoning: 12, first_tool: "raft__messages_send", turn: "tt_main@1789999990000", session: "main" },
  "model.attempt": { seq: 2, at: new Date(T0 + 1).toISOString(), kind: "model.attempt", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "mj_aaa",
    env: "preview", status: "retried", verdict: "failed", ms: 36100, attempt: 2, phase: "call", outcome: "http", total_ms: 36100,
    provider_ms: 35900, model: "anthropic/claude-sonnet-4.5", http_status: 529, error_class: "OverloadedError" },
  "tool.call": { seq: 3, at: new Date(T0 + 900).toISOString(), kind: "tool.call", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "op_1",
    env: "preview", status: "failed", verdict: "failed", ms: 900, tool: "messages.send", mount: "raft", task: "task_1", run_ms: 800,
    exit_code: -1, error_code: "not_found", http_status: 404 },
  "tool.refused": { seq: 4, at: new Date(T0 + 3).toISOString(), kind: "tool.refused", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "call_r_fc_r",
    env: "preview", status: "unknown_tool", verdict: "blocked", tool: "gh.api_get", code: "unknown_tool", by: "run_js", from: "program", task: "task_1" },
  "turn.timing": { seq: 5, at: new Date(T0 + 4).toISOString(), kind: "turn.timing", tenant_id: "raft_t1", agent_id: "raft_a1",
    span_id: `tt_main@${T0 - 10_000}`, env: "preview", status: "completed", verdict: "ok", ms: 10004, inbound_to_start_ms: 1000, model_ms: 0,
    between_jobs_ms: 0, tool_ms: 700, model_jobs: 0, tools: 1, messages: 1, client_wait_ms: 0, client_pauses: 0, prep_ms: 100 },
  "turn.stop": { seq: 6, at: new Date(T0 + 5).toISOString(), kind: "turn.stop", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "op_stop",
    env: "preview", status: "stopped", verdict: "cancelled", trigger: "provider_stop", turn: "tt_main@1789999990000" },
  "raft.assistant_wake": { seq: 7, at: new Date(T0 + 6).toISOString(), kind: "raft.assistant_wake", tenant_id: "raft_t1", agent_id: "raft_a1",
    span_id: "mount:assistant", env: "preview", status: "invoked", verdict: "ok", result: "invoked", trigger: "doorbell", conversations: 4,
    candidates: 2, seen: 1, unreadable: 0, lag_retry: 1, caught_up: true, caught_up_via: "mixed", caught_up_rule: "seq", muted: 1, told: 0 },
  "raft.assistant_notify": { seq: 8, at: new Date(T0 + 7).toISOString(), kind: "raft.assistant_notify", tenant_id: "raft_t1", agent_id: "raft_a1",
    span_id: "op_notify", env: "preview", status: "sent", verdict: "ok", state: "sent", items_in: 4, items_sent: 1, dropped: 3,
    dropped_already_told: 1, dropped_rule: 1, dropped_not_confirmed: 1 },
  "raft.turn_ended": { seq: 9, at: new Date(T0 + 8).toISOString(), kind: "raft.turn_ended", tenant_id: "raft_t1", agent_id: "raft_a1",
    span_id: "mount:raft", env: "preview", status: "skipped", verdict: "ok", result: "skipped", reason: "snapshot_stale", conversations: 3,
    outcome: "completed", snapshot_mismatches: 1 },
};
/** Same keys, same values, any order. */
const sameRow = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.join(",") === kb.join(",") && ka.every((k) => a[k] === b[k]);
};

await check("the agent.trace lane is the nine kinds the receiver takes, every one a trace kind, and none of github.refresh's", async () => {
  must(AGENT_TRACE_KINDS.slice().sort().join(",") === Object.keys(WORKER_FIELDS).sort().join(","), `kinds: ${AGENT_TRACE_KINDS}`);
  for (const k of AGENT_TRACE_KINDS) must((TRACE_KINDS as readonly string[]).includes(k), `${k} is not a trace kind`);
  must(!AGENT_TRACE_KINDS.includes("github.refresh") && GITHUB_REFRESH_LANE.kinds.join() === "github.refresh", "the lanes overlap");
  must(AGENT_TRACE_LANE.path === TRACE_PATH && GITHUB_REFRESH_LANE.path === GHR_PATH, "paths");
});

await check("every field the receiver takes is filled from an attr, but for the two that have no source here", async () => {
  const missing: string[] = [];
  for (const [kind, fields] of Object.entries(WORKER_FIELDS)) {
    for (const f of fields) if (!(f in AGENT_TRACE_FIELDS[kind as TraceKind]!)) missing.push(`${kind}.${f}`);
  }
  must(missing.sort().join(",") === WORKER_UNFILLED.slice().sort().join(","), `unfilled: ${missing}`);
});

for (const kind of Object.keys(GOLDEN)) {
  await check(`golden: a ${kind} row from its writer goes out as exactly these fields`, async () => {
    const { sql } = sqliteHost(); const e = routes();
    everyKind(sql);
    await lanePass(sql, e);
    const row = traced(e).find((r) => r.kind === kind);
    must(row, `no ${kind} row was sent: ${JSON.stringify(traced(e).map((r) => r.kind))}`);
    must(sameRow(row, GOLDEN[kind]!), `${kind}:\n      sent ${JSON.stringify(row)}\n      want ${JSON.stringify(GOLDEN[kind])}`);
  });
}

await check("an agent.trace row carries the envelope and its kind's fields, nothing else, and no free text", async () => {
  const { sql } = sqliteHost(); const e = routes();
  everyKind(sql);
  await lanePass(sql, e);
  const rows = traced(e);
  must(rows.length === 9, `rows: ${rows.length}`);
  for (const r of rows) {
    const allowed = new Set([...ENVELOPE, ...Object.keys(AGENT_TRACE_FIELDS[r.kind as TraceKind]!)]);
    const extra = Object.keys(r).filter((k) => !allowed.has(k));
    must(!extra.length, `${r.kind} carried ${extra}`);
    for (const [k, v] of Object.entries(r)) {
      if (k === "at") continue;
      must(typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && /^[A-Za-z0-9_.:@/-]{1,128}$/.test(v)), `${r.kind}.${k} = ${JSON.stringify(v)}`);
    }
  }
  const text = e.requests.map((r) => r.text).join("\n");
  for (const leak of ["secret-plans", "alice@example.com", "daily limit", "overloaded", '"error":', '"name":', '"callId":', '"limit":', '"prefix":', '"mount":"assistant"', '"engine":']) {
    must(!text.includes(leak), `the body has ${leak}`);
  }
});

await check("a planted secret in a tool's error, in an unknown attr and in a wake's error never reaches the request body", async () => {
  const { sql } = sqliteHost(); const e = routes();
  const SECRET = "ghp_PLANTEDsecret0123456789abcdefghijABCDEF";
  const PW = "hunter2-PLANTED-pw";
  // Through the writer (which redacts what it recognizes)...
  appendTrace(sql, [toolCallRow({ ...OWNER, taskId: "task_1", operationId: "op_s1", mountAlias: "gh", tool: "api_get", status: "failed",
    createdAt: T0, endedAt: T0 + 1, failure: { code: "BAD_CREDENTIALS", httpStatus: 401, message: `Bad credentials for token ${SECRET} pw=${PW}` } })]);
  // ...and straight into the outbox, as a writer that forgot to redact would.
  appendTrace(sql, [
    { at: T0 + 2, ...OWNER, kind: "tool.call", spanId: "op_s2", status: "failed", verdict: "failed",
      attrs: { tool: "api_get", mount: "gh", error: `Bad credentials ${SECRET}`, errorCode: "bad credentials " + PW, args: { token: SECRET }, password: PW } },
    { at: T0 + 3, ...OWNER, kind: "raft.assistant_wake", spanId: "mount:assistant", status: "failed", verdict: "failed",
      attrs: { trigger: "doorbell", error: `401 ${SECRET}`, reason: SECRET.slice(0, 20) + " " + PW } },
    { at: T0 + 4, ...OWNER, kind: "model.call", spanId: "mj_s", status: "stop", verdict: "ok",
      attrs: { model: "m", limit: `limit ${PW}`, turn: `${PW} ${SECRET}`, prefix: { key: SECRET } } },
  ]);
  await lanePass(sql, e);
  must(traced(e).length === 4, `sent: ${traced(e).length}`);
  const text = e.requests.map((r) => r.text).join("\n");
  must(!text.includes("PLANTED") && !text.includes("ghp_") && !text.includes("hunter2"), `leaked: ${text.slice(0, 600)}`);
  const s2 = traced(e).find((r) => r.span_id === "op_s2")!;
  must(s2.error_code === undefined && s2.tool === "api_get", JSON.stringify(s2));
});

await check("an id that is not one is left out of its field; a span the receiver would refuse is made one; an unsendable row is counted, not sent", async () => {
  const { sql } = sqliteHost(); const e = routes();
  appendTrace(sql, [
    { at: T0, ...OWNER, kind: "tool.call", spanId: "op_ok", status: "succeeded", verdict: "ok", attrs: { tool: "has spaces in it", mount: "gh", exitCode: 1.7, runMs: -5 } },
    { at: T0 + 1, ...OWNER, kind: "tool.refused", spanId: "call_a|fc_b", status: "no_tools", verdict: "blocked", attrs: { code: "no_tools", by: "gateway", from: "elsewhere" } },
    { at: T0 + 2, tenantId: "raft_t1", agentId: "agent with spaces", kind: "turn.stop", spanId: "op_x", status: "stopped", verdict: "cancelled", attrs: { trigger: "delete" } },
    { at: T0 + 3, ...OWNER, kind: "turn.stop", spanId: "x".repeat(150), status: "stopped", verdict: "cancelled", attrs: { trigger: "admin_cancel", errorClass: "stopped: by operator" } },
  ]);
  await lanePass(sql, e);
  const rows = traced(e);
  must(rows.map((r) => r.seq).join(",") === "1,2,4", `sent: ${rows.map((r) => r.seq)}`);
  const [a, b, d] = rows;
  must(a.tool === undefined && a.exit_code === 1 && a.run_ms === undefined && a.mount === "gh", JSON.stringify(a));
  must(b.span_id === "call_a_fc_b" && b.from === undefined && b.code === "no_tools", JSON.stringify(b));
  must(d.span_id === "x".repeat(128) && d.error_class === undefined && d.trigger === "admin_cancel", JSON.stringify(d));
  must(JSON.stringify(atrLog(sql)) === JSON.stringify([{ reason: "unsendable", status: null, rows: 1 }]), JSON.stringify(atrLog(sql)));
});

await check("batches: at most 500 rows and 256 KiB a request, oldest first, every row once", async () => {
  const { sql } = sqliteHost(); const e = routes();
  const long = (c: string) => `${c}`.repeat(128);
  const rows: TraceRow[] = [];
  for (let n = 1; n <= 1_400; n++) {
    rows.push({ at: T0 + n, ...OWNER, kind: "model.call", spanId: `mj_${n}`, status: "stop", verdict: "ok", ms: n,
      attrs: n <= 700
        ? { model: long("m"), session: long("s"), turn: long("t"), firstTool: long("f"), input: n, output: n, cacheRead: n, cacheWrite: n, reasoning: n }
        : { model: "m" } });
  }
  appendTrace(sql, rows);
  // Two passes: one stage reads at most 2,000 outbox rows, which is all of them here.
  await lanePass(sql, e);
  const reqs = e.requests.filter((r) => r.path === TRACE_PATH);
  must(reqs.every((r) => r.rows.length <= FORWARD_BATCH_MAX && r.bytes <= FORWARD_BATCH_BYTES), JSON.stringify(reqs.map((r) => [r.rows.length, r.bytes])));
  must(reqs.some((r) => r.rows.length < FORWARD_BATCH_MAX && r.bytes > FORWARD_BATCH_BYTES * 0.9), `the byte cap never bound: ${JSON.stringify(reqs.map((r) => [r.rows.length, r.bytes]))}`);
  const seqs = traced(e).map((r) => r.seq);
  must(seqs.length === 1_400 && seqs.every((s, i) => s === i + 1), `seqs: ${seqs.length}`);
  must(ATR(sql).length === 0, "queue left");
});

await check("off unless configured: no request, no hold, no agent.trace table", async () => {
  for (const env of [{}, { TRACE_INGEST_URL: BASE, DEPLOYMENT_ENV: "preview" }, { TRACE_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" },
    { TRACE_INGEST_URL: BASE, TRACE_INGEST_TOKEN: TOKEN }, { TRACE_INGEST_URL: " ", TRACE_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" }]) {
    const { sql } = sqliteHost(); const e = routes();
    everyKind(sql);
    const p = await lanePass(sql, e, env);
    must(p.hold === null && p.forwarded === null && e.requests.length === 0, `forwarded with ${JSON.stringify(env)}`);
    const t = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'atr_%' OR name LIKE 'ghr_%')").toArray();
    must(t.length === 0, `tables: ${JSON.stringify(t)}`);
  }
});

await check("the token: TRACE_INGEST_TOKEN, else GITHUB_REFRESH_INGEST_TOKEN; the URL the same; one token on both routes", async () => {
  const old = forwardConfigOf({ GITHUB_REFRESH_INGEST_URL: "https://old.example/", GITHUB_REFRESH_INGEST_TOKEN: "tok_old", DEPLOYMENT_ENV: "production" });
  must(old?.token === "tok_old" && old.url === "https://old.example" && old.env === "production", JSON.stringify(old));
  const both = forwardConfigOf({ TRACE_INGEST_URL: "https://new.example", TRACE_INGEST_TOKEN: "tok_new",
    GITHUB_REFRESH_INGEST_URL: "https://old.example", GITHUB_REFRESH_INGEST_TOKEN: "tok_old", DEPLOYMENT_ENV: "preview" });
  must(both?.token === "tok_new" && both.url === "https://new.example", JSON.stringify(both));
  const blank = forwardConfigOf({ TRACE_INGEST_URL: "https://new.example", TRACE_INGEST_TOKEN: "  ", GITHUB_REFRESH_INGEST_TOKEN: "tok_old", DEPLOYMENT_ENV: "preview" });
  must(blank?.token === "tok_old" && blank.url === "https://new.example", JSON.stringify(blank));
  const { sql } = sqliteHost(); const e = routes();
  everyKind(sql); appendTrace(sql, [refresh(20)]);
  await lanePass(sql, e, { GITHUB_REFRESH_INGEST_URL: BASE, GITHUB_REFRESH_INGEST_TOKEN: "tok_old", DEPLOYMENT_ENV: "preview" });
  must(e.requests.length === 2 && e.requests.every((r) => r.headers.authorization === "Bearer tok_old"), JSON.stringify(e.requests.map((r) => [r.path, r.headers.authorization])));
  must(e.requests.map((r) => r.path).join() === `${GHR_PATH},${TRACE_PATH}`, "paths");
  must(e.requests[0]!.rows.length === 1 && e.requests[0]!.rows[0].outcome === "rotated" && e.requests[1]!.rows.every((r) => r.kind !== "github.refresh"), "lanes mixed");
});

await check("the lanes are independent: a receiver without the new route pauses agent.trace alone, and the export is held by neither", async () => {
  const { sql } = sqliteHost();
  let deployed = false;
  const e = routes((path) => path === TRACE_PATH && !deployed ? 404 : 200);
  everyKind(sql); appendTrace(sql, [refresh(20)]);
  const first = await lanePass(sql, e);
  must(first.forwarded!["github.refresh"]!.sent === 1 && first.forwarded!["agent.trace"]!.error === "auth_or_off: http-404", JSON.stringify(first.forwarded));
  must(ATR(sql).length === 9 && queued(sql).length === 0, `queues: ${ATR(sql)} / ${queued(sql)}`);
  must(left(sql) === 0, `the export held ${left(sql)} rows`);
  must(JSON.stringify(atrLog(sql)) === JSON.stringify([{ reason: "auth_or_off", status: 404, rows: 9 }]), JSON.stringify(atrLog(sql)));
  deployed = true;
  const stillBackingOff = await lanePass(sql, e);
  must(stillBackingOff.forwarded!["agent.trace"]!.skipped === "backoff", JSON.stringify(stillBackingOff.forwarded));
  const later = await sendForward(sql, CFG, OWNER.tenantId, OWNER.agentId, e.fetch, () => Date.now() + FORWARD_BACKOFF_BASE_MS + 1, FORWARD_TIMEOUT_MS, AGENT_TRACE_LANE);
  must(later.sent === 9 && later.error === null && ATR(sql).length === 0, JSON.stringify(later));
  const ids = traced(e).map((r) => `${r.tenant_id}:${r.agent_id}:${r.span_id}:${r.kind}`);
  must(ids.length === 9, `sent: ${ids}`);
});

await check("agent.trace keeps the forward's answers: 413 splits, 400 drops as schema, 5xx keeps and backs off", async () => {
  const { sql } = sqliteHost();
  const e = routes((path, rows) => path !== TRACE_PATH ? 200 : rows.length > 2 ? 413 : rows.some((r) => r.kind === "tool.call") ? 400 : rows.some((r) => r.kind === "turn.stop") ? 503 : 200);
  everyKind(sql);
  const p = await lanePass(sql, e);
  const f = p.forwarded!["agent.trace"]!;
  // 9 → [1-5] + [6-9]; [1-5] → [1-3] + [4,5]; [1-3] → [1,2] sent + [3] (tool.call) dropped on 400; [4,5] sent;
  // [6-9] → [6,7] (turn.stop) answered 503: kept, and the pass stops before [8,9].
  must(f.error === "unavailable: http-503", JSON.stringify(f));
  const reasons = atrLog(sql).map((r: any) => `${r.reason}:${r.status}:${r.rows}`);
  must(reasons.join() === "schema:400:1,unavailable:503:2", JSON.stringify(reasons));
  must(traced(e).map((r) => r.seq).join(",") === "1,2,4,5" && ATR(sql).join(",") === "6,7,8,9", `sent ${traced(e).map((r) => r.seq)}, kept: ${ATR(sql)}`);
  must(f.sent === 4 && f.dropped === 1 && f.kept === 4, JSON.stringify(f));
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
