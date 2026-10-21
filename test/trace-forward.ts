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
  ingestRequest, sendForward, stageForward, forwardSettingsOf, GITHUB_REFRESH_LANE, AGENT_TRACE_LANE, AGENT_TRACE_KINDS, AGENT_TRACE_FIELDS, FORWARD_BATCH_BYTES,
  type ForwardConfig, type ForwardRow,
} from "../cf/src/trace-forward.ts";
import { TRACE_KINDS, type TraceKind } from "../src/trace/outbox.ts";
import { modelAttemptRow, modelCallRow, toolCallRow, toolRefusedRow } from "../src/trace/seams.ts";
import { turnStopRow } from "../src/runtime/turn-stop.ts";
import { closeTurn, turnInbound, turnSaid, turnStepStart, turnToolRan } from "../src/runtime/turn-timing.ts";
import { ASSISTANT_STORE, OWNER_KEY, assistantWake, checkEnded, notifyAttrs, notifyOwner } from "../src/plugins/raft-assistant.ts";
import { checkTurnKey } from "../src/plugins/raft-assistant-check.ts";
import { PLUGIN_TRACE_KINDS } from "../src/trace/outbox.ts";
import { raftPlugin } from "../src/plugins/raft.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const OWNER = { tenantId: "raft_t1", agentId: "raft_a1" };
const BASE = "https://ingest.example/";
/** The agent's mounts, in the store's own `mounts` table (src/store/durable-object.ts): alias → plugin type. */
function withMounts(sql: any, mounts: Array<[string, string]>, owner = OWNER) {
  sql.exec("CREATE TABLE IF NOT EXISTS mounts (tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL, installation_id TEXT NOT NULL, " +
    "connection_id TEXT, plugin TEXT NOT NULL, tool_version TEXT NOT NULL, public_config TEXT NOT NULL, secret_ref TEXT, policy TEXT, tool_snapshot TEXT, " +
    "PRIMARY KEY (tenant_id, agent_id, alias))");
  for (const [alias, plugin] of mounts) {
    sql.exec("INSERT INTO mounts(tenant_id, agent_id, alias, installation_id, plugin, tool_version, public_config) VALUES (?, ?, ?, ?, ?, '1', '{}')",
      owner.tenantId, owner.agentId, alias, `inst_${alias}`, plugin);
  }
}
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
  withMounts(sql, [["gh", "github"]]);
  // Extra attrs a future writer might add, one of them token-shaped: none may ride along.
  appendTrace(sql, [refresh(1, "kept-unstored", { attempt: 3, stored: false, reasonCode: "d1-write-failed", token: "ghu_secret", reason: "GitHub said x" })]);
  await pass(sql, e, r2());
  const [row] = sent(e);
  must(row, "nothing was forwarded");
  must(JSON.stringify(Object.keys(row).sort()) === JSON.stringify([...FORWARD_COLUMNS].sort()), `fields: ${Object.keys(row).sort()}`);
  must(JSON.stringify([...FORWARD_COLUMNS].sort()) === JSON.stringify(["agent_id", "at", "attempt", "connector_id", "env", "mount", "outcome", "reason_code", "scope", "seq", "stored", "tenant_id", "why"]),
    `the column list moved: ${FORWARD_COLUMNS}`);
  const want: ForwardRow = { at: new Date(T0 + 1000).toISOString(), tenant_id: OWNER.tenantId, agent_id: OWNER.agentId, seq: 1, env: "preview",
    outcome: "kept-unstored", scope: "mount", connector_id: "conn_1", mount: "github", why: "expiring", attempt: 3, stored: false, reason_code: "d1-write-failed" };
  must(JSON.stringify(row) === JSON.stringify(want), `row: ${JSON.stringify(row)}`);
  const wire = JSON.stringify(e.requests[0]!.rows);
  must(!/ghu_|GitHub said|span|verdict|attrs|"gh"/.test(wire), `something beyond the columns was sent: ${wire}`);
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
 * The receiver's fields per kind and their types, as the trace-upload worker's `antiprotonTrace.ts`
 * (`ANTIPROTON_TRACE_KINDS`) has them at botiverse/slock 2d91205. Pinned here so a drift on either side shows.
 * `mount_index` is this side's envelope (any row about a mount), so it is checked apart from the kind's fields.
 */
const ENUM = (...v: string[]) => v.join("|");
const RULE_COUNT_FIELDS = Object.fromEntries(["mute", "always", "digest"].flatMap((effect) =>
  ["channel", "thread", "person", "kind", "dms", "legacy"].map((scope) => [`${effect}_${scope}`, "count"])));
const WORKER_FIELDS: Record<string, Record<string, string>> = {
  "model.call": { model: "id", stop_reason: "code", input: "count", output: "count", cache_read: "count", cache_write: "count", reasoning: "count",
    first_tool: "id", turn: "id", session: "id" },
  "model.attempt": { attempt: "count", phase: ENUM("take", "admit", "call", "deliver"), outcome: "code", http_status: "count", error_class: "id",
    total_ms: "count", provider_ms: "count", model: "id" },
  "tool.call": { mount_index: "count", tool: "id", mount: "id", task: "id", run_ms: "count", exit_code: "int", denied: "bool", error_code: "code", http_status: "count" },
  "tool.refused": { tool: "id", code: "code", by: "id", from: ENUM("model", "program") },
  "turn.timing": { inbound_to_start_ms: "count", start_to_first_job_ms: "count", model_ms: "count", between_jobs_ms: "count", tool_ms: "count",
    last_answer_to_reply_ms: "count", model_jobs: "count", tools: "count", messages: "count", first_call_prompt_tokens: "count",
    first_call_cached_tokens: "count", client_wait_ms: "count", client_pauses: "count", prep_ms: "count" },
  "turn.stop": { trigger: "code", turn: "id" },
  "raft.assistant_wake": { mount_index: "count",
    result: ENUM("skipped_empty", "skipped_filtered", "invoked", "unreadable", "paused", "night_deferred", "failed", "inbox_lagging"),
    trigger: "code", conversations: "count", candidates: "count", seen: "count", unreadable: "count", lag_retry: "count", caught_up: "bool",
    caught_up_via: ENUM("unread", "all", "mixed"), caught_up_rule: ENUM("seq", "time"), muted: "count", told: "count", held: "count", said: "count",
    inbox_lagging_gave_up: "count" },
  "raft.assistant_notify": { mount_index: "count", state: ENUM("sent", "nothing_to_send", "kept_for_brief", "not_sent"), items_in: "count", items_sent: "count", dropped: "count",
    dropped_already_told: "count", dropped_rule: "count", dropped_not_confirmed: "count", dropped_decisions_in_brief: "count", dropped_other: "count" },
  "raft.assistant_rules": { action: ENUM("add", "mute", "unmute", "remove", "list", "quiet", "timezone", ""), result: "code",
    effect: ENUM("mute", "always", "digest"), scope: ENUM("channel", "thread", "person", "kind", "dms"), removed: "count", rules_total: "count",
    ...RULE_COUNT_FIELDS },
  "raft.assistant_chat_told": { told: "count", reply_fallback: "count", failed_turn: "count", result: ENUM("sent", "held", "failed"), code: "code" },
  "raft.assistant_send_as_owner": { result: "code", target_kind: ENUM("message", "channel", "dm", "channel_id"), in_thread: "bool", chars: "count",
    http_status: "count" },
  "raft.turn_ended": { mount_index: "count", result: ENUM("settled", "skipped", "unreadable"), reason: "code", conversations: "count", outcome: ENUM("completed", "interrupted", "failed") },
};
/**
 * What this side sends that the receiver does not keep yet, by the receiver's types: new kinds, new fields, and enums
 * widened (a value outside the receiver's list is dropped by it, the row kept). The field table sent to the receiving
 * side is this; when the receiver takes an entry, it moves to WORKER_FIELDS.
 */
const PROPOSED: Record<string, Record<string, string>> = {
  "turn.end_unrecorded": { stage: ENUM("read", "record"), error_class: "id" },
  "rebuild.outcome": { decision: "id", trigger: ENUM("window", "cold-wake", "operator"), strategy: ENUM("summary", "briefing"),
    agreement: ENUM("agree", "false-cold", "false-warm", "expected-cold", "unmeasured"), would_rebuild: "bool", predicted_cold: "bool",
    expected_cold: "bool", measured_cold: "bool", input: "count", cache_read: "count", since_decision_ms: "count" },
  "raft.assistant_wake": {
    result: ENUM("skipped_empty", "skipped_filtered", "invoked", "unreadable", "paused", "night_deferred", "failed", "inbox_lagging", "check_refused", "skipped_no_check"),
    error_code: ENUM("inbox_refused", "inbox_shape", "not_enabled", "unexpected"), http_status: "count",
    check_id: "id", raft_check: "bool",
    reason: ENUM("malformed", "version", "instruction_too_large", "no_notify", "raft_check_off", "engine_pd_unsupported"),
    instruction_bytes: "count", tools_offered: "count", tools_dropped: "count", placeholders_unknown: "count", placeholders_unoffered: "count",
    items: "count", truncated: "count", skipped: "count", digest: "count", always: "count", dm: "count", mention: "count", thread: "count",
    named: "count", default_out: "count", night_held: "count" },
  "raft.assistant_check": { mount_index: "count", check_id: "id", trigger: ENUM("doorbell", "brief"), outcome: ENUM("completed", "failed", "cancelled"),
    error_code: "code", attempts: "count", http_status: "count", code: "code" },
  "raft.assistant_notify": { state: ENUM("sent", "duplicate", "nothing_to_send", "kept_for_brief", "not_sent", "unknown"),
    held_back: "count", kept_for_brief: "count", dropped_not_in_check: "count", check_id: "id", trigger: ENUM("doorbell", "brief"),
    forwarded: "count", code: "code", http_status: "count" },
  "raft.assistant_chat_told": { mount_index: "count", refs: "count", skipped: "count", forwarded: "count", http_status: "count" },
  "raft.assistant_rules": { mount_index: "count", action: ENUM("add", "mute", "unmute", "remove", "list", "quiet", "timezone", "other"),
    via: ENUM("raft"), left: "count", code: "code" },
  "raft.assistant_send_as_owner": { mount_index: "count", target_kind: ENUM("message", "channel", "dm", "channel_id", "other") },
};
/** The receiver's fields once PROPOSED lands: what this side's fields are pinned to. */
const CONTRACT: Record<string, Record<string, string>> = Object.fromEntries([...new Set([...Object.keys(WORKER_FIELDS), ...Object.keys(PROPOSED)])]
  .map((k) => [k, { ...WORKER_FIELDS[k], ...PROPOSED[k] }]));
const ENVELOPE = ["seq", "at", "kind", "tenant_id", "agent_id", "span_id", "env", "status", "verdict", "ms", "mount_index"];

const ATR = (sql: any): number[] => sql.exec("SELECT seq FROM atr_forward_queue ORDER BY seq").toArray().map((r: any) => Number(r.seq));
const atrLog = (sql: any) => sql.exec("SELECT reason, status, rows FROM atr_forward_log ORDER BY at").toArray();
/** An endpoint that tells the routes apart: `answer(path, rows)`. Bodies are kept as text, to search for what must not be there. */
function routes(answer: (path: string, rows: any[]) => number | { status: number; body: string } = () => 200) {
  const e = {
    requests: [] as Array<{ path: string; headers: Record<string, string>; rows: any[]; text: string; bytes: number; status: number }>,
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      const body = init.body as Uint8Array;
      const text = new TextDecoder().decode(body);
      const rows = JSON.parse(text).rows;
      const path = new URL(url).pathname;
      const a = answer(path, rows);
      const status = typeof a === "number" ? a : a.status;
      e.requests.push({ path, headers: init.headers as Record<string, string>, rows, text, bytes: body.byteLength, status });
      return new Response(typeof a === "number" ? null : a.body, { status });
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
  withMounts(sql, [["assistant", "raft"], ["raft", "raft"]]);
  appendTrace(sql, [modelCallRow({
    ...t, jobId: "mj_0123456789abcdef01234567", stopReason: "toolUse", model: "anthropic/claude-sonnet-4.5", at: T0, createdAt: T0 - 4_000, answeredAt: T0,
    usage: { input: 1200, output: 80, cacheRead: 1000, cacheWrite: 200, reasoning: 12 }, session: "main", firstTool: "raft__messages_send",
    turn: "tt_main@1789999990000", limit: "You have spent your daily limit of $5", prefix: { same: 3 },
  })]);
  appendTrace(sql, [modelAttemptRow({ ...t, jobId: "mj_0123456789abcdef01234567", at: T0 + 1 }, {
    attempt: 2, phase: "call", outcome: "http", httpStatus: 529, errorClass: "OverloadedError", ms: 36_100, providerMs: 35_900,
    model: "anthropic/claude-sonnet-4.5", message: "overloaded: body {\"error\":\"x\"}",
  })]);
  appendTrace(sql, [toolCallRow({
    ...t, taskId: "main", operationId: "op_00000000000000000001", mountAlias: "raft", tool: "messages.send", status: "failed", modelName: "raft__messages_send",
    createdAt: T0, endedAt: T0 + 900, callId: "call_x|fc_y", exitCode: -1, startedAt: T0 + 100, denied: false,
    failure: { code: "NOT_FOUND", httpStatus: 404, message: "channel #secret-plans not found for user alice@example.com" },
  })]);
  appendTrace(sql, [toolRefusedRow({ ...t, at: T0 + 3, tool: "gh.api_get", code: "unknown_tool", callId: "call_Rf0r3fUs3d1|fc_0123456789abcdef0123", by: "run_js", fromProgram: true, task: "main" })]);
  turnInbound(sql, "main", T0 - 10_000, { stale: false });
  turnSaid(sql, "main", T0 - 9_900);
  turnStepStart(sql, "main", T0 - 9_000);
  turnToolRan(sql, "main", 700);
  closeTurn(sql, { ...t, session: "main", replyAt: T0 + 4, status: "completed" });
  appendTrace(sql, [turnStopRow({ ...t, operationId: "op_00000000000000000002", trigger: "provider_stop", at: T0 + 5, turn: "tt_main@1789999990000" })]);
  // raft-assistant.ts `record`: { trigger, ...counts } on the mount's span (a wake has no operation: gateway.ts `trace`).
  appendTrace(sql, [{ at: T0 + 6, ...t, kind: "raft.assistant_wake", spanId: "mount:assistant", status: "invoked", verdict: "ok",
    attrs: { mount: "assistant", trigger: "doorbell", conversations: 4, candidates: 2, muted: 1, told: 0, seen: 1, unreadable: 0,
      lagRetry: 1, caught_up: true, caught_up_rule: "seq", caught_up_via: "mixed" } }]);
  appendTrace(sql, [{ at: T0 + 7, ...t, kind: "raft.assistant_notify", spanId: "op_00000000000000000003", status: "sent", verdict: "ok",
    attrs: { mount: "assistant", ...notifyAttrs({ items: [{}, {}, {}, {}] }, {
      state: "sent", items: 1, dropped: { "#a:1": "already told", "#b:2": "rule r_1", "#c:3": "not in a conversation this check was given" },
    }) } }]);
  // raft.ts `reportTurnEnd`.
  appendTrace(sql, [{ at: T0 + 8, ...t, kind: "raft.turn_ended", spanId: "mount:raft", status: "skipped", verdict: "ok",
    attrs: { mount: "raft", outcome: "completed", targets: 3, reason: "snapshot_stale", snapshotMismatches: 1 } }]);
}

/**
 * A plugin context on the mount `assistant` whose trace rows are kept as the gateway writes them (src/runtime/gateway.ts
 * `trace`: the operation's span, else the mount's; the mount first in attrs), with an owner kept and the session's key.
 */
function assistantCtx(at: number, turnKey?: string, span: string | null = null) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const rows: TraceRow[] = [];
  const ctx = {
    caller: { tenantId: OWNER.tenantId, agentId: OWNER.agentId, taskId: "iso_0123456789abcdef", ...(turnKey ? { turnKey } : {}) }, alias: "assistant",
    db: openPluginDatabase(tables, { tenantId: OWNER.tenantId, agentId: OWNER.agentId, alias: "assistant", plugin: raftPlugin.id }, raftPlugin.database),
    trace: (row: any) => rows.push({ at, ...OWNER, kind: row.kind, spanId: span ?? "mount:assistant", status: row.status, verdict: row.verdict,
      attrs: { mount: "assistant", ...row.attrs } }),
  } as any;
  return { ctx, rows };
}
const CHECK = "0f1e2d3c-4b5a-4968-8776-655443322110";

/**
 * One row of each kind added since the first nine, and the new shapes of two of those (a wake and a notify while Raft
 * runs the check), seq 10 on, after `everyKind`'s: from the writers where they can be called here, else with the exact
 * attrs their writer sets (file and function named on each).
 */
async function newKinds(sql: any): Promise<void> {
  const t = { ...OWNER };
  // cf/src/runtime.ts `#turnEndsUnrecorded`.
  appendTrace(sql, [{ at: T0 + 10, ...t, kind: "turn.end_unrecorded", spanId: `turn_end:${T0 + 10}`, status: "failed", verdict: "failed",
    attrs: { stage: "record", error_class: "SqliteError" } }]);
  // src/runtime/rebuild.ts `settleRebuildOutcome`.
  appendTrace(sql, [{ at: T0 + 11, ...t, kind: "rebuild.outcome", spanId: "mj_00000000000000000000000b", parentId: "rb_0123456789abcdef0123", status: "agree", verdict: "ok",
    attrs: { decision: "rb_0123456789abcdef0123", trigger: "cold-wake", strategy: "briefing", wouldRebuild: true, predictedCold: true, expectedCold: false,
      rule: "alice-team-rule", input: 5000, cacheRead: 100, hitRate: 0.02, measuredCold: true, agreement: "agree", sinceDecisionMs: 1234 } }]);
  // src/plugins/raft-assistant.ts `raftCheckWake` (invoked), `refusedCheck` (check_refused), `raftIdleWake` (skipped_no_check), `record` of a failure.
  appendTrace(sql, [
    { at: T0 + 12, ...t, kind: "raft.assistant_wake", spanId: "mount:assistant", status: "invoked", verdict: "ok",
      attrs: { mount: "assistant", trigger: "brief", check_id: CHECK, raft_check: true, tools_offered: 1, tools_dropped: 2, placeholders_unknown: 1,
        placeholders_unoffered: 0, conversations: 5, items: 3, truncated: 0, told: 1, skipped: 1, muted: 2, digest: 1, always: 0, dm: 1, mention: 1,
        thread: 0, named: 0, default_out: 2, night_held: 0 } },
    { at: T0 + 13, ...t, kind: "raft.assistant_wake", spanId: "mount:assistant", status: "check_refused", verdict: "ok",
      attrs: { mount: "assistant", trigger: "doorbell", check_id: CHECK, raft_check: true, reason: "instruction_too_large", instruction_bytes: 20000 } },
    { at: T0 + 14, ...t, kind: "raft.assistant_wake", spanId: "mount:assistant", status: "skipped_no_check", verdict: "ok",
      attrs: { mount: "assistant", trigger: "doorbell", raft_check: true } },
    { at: T0 + 15, ...t, kind: "raft.assistant_wake", spanId: "mount:assistant", status: "failed", verdict: "failed",
      attrs: { mount: "assistant", trigger: "doorbell", error: "inbox_refused", status: 503 } },
  ]);
  // The real notify while Raft runs the check (`notifyRaft`), in the check's short session: Raft drops three, one for a
  // reason this side has no field for and one for a reason that is not a code.
  const key = checkTurnKey({ id: CHECK, trigger: "doorbell" });
  const n = assistantCtx(T0 + 16, key, "op_00000000000000000010");
  await n.ctx.db.put(ASSISTANT_STORE, { userId: "owner-1", timezone: "Europe/Berlin", dmTarget: "dm:@owner", raftCheck: true }, OWNER_KEY);
  const api = async () => ({ ok: true as const, data: { outcome: "sent", shown: 2, more: 1, dropped: [
    { channelId: "c-1", reason: "not_in_check" }, { channelId: "c-2", reason: "rule_mute" }, { channelId: "c-3", reason: "made_up_reason" },
    { channelId: "c-4", reason: "Not A Code!" }] } });
  await notifyOwner({ items: [1, 2, 3, 4, 5, 6].map((i) => ({ channelId: `c-${i}`, summary: `alice said ${i}` })) }, n.ctx,
    { api, send: async () => ({ sent: true as const }), recheck: async () => null });
  // The same, refused by Raft with a 5xx.
  const n2 = assistantCtx(T0 + 17, key, "op_00000000000000000011");
  await n2.ctx.db.put(ASSISTANT_STORE, { userId: "owner-1", timezone: "Europe/Berlin", dmTarget: "dm:@owner", raftCheck: true }, OWNER_KEY);
  await notifyOwner({ items: [{ channelId: "c-1", summary: "x" }] }, n2.ctx,
    { api: async () => ({ ok: false as const, status: 502, code: null }), send: async () => ({ sent: true as const }), recheck: async () => null });
  // The real check's end (`checkEnded`).
  const c = assistantCtx(T0 + 18);
  checkEnded(c.ctx, { turnKey: key, outcome: "failed", errorCode: "output_limit", isolated: true });
  appendTrace(sql, [...n.rows, ...n2.rows, ...c.rows]);
  appendTrace(sql, [
    // `pushBriefImport`'s failure.
    { at: T0 + 19, ...t, kind: "raft.assistant_check", spanId: "mount:assistant", status: "import_failed", verdict: "failed",
      attrs: { mount: "assistant", attempts: 3, http_status: 502, code: "http" } },
    // `toldToRaft`'s failure and `replyFallback`'s.
    { at: T0 + 20, ...t, kind: "raft.assistant_chat_told", spanId: "op_00000000000000000012", status: "told_failed", verdict: "failed",
      attrs: { mount: "assistant", told: 0, refs: 2, forwarded: 1, http_status: 503, code: "http" } },
    { at: T0 + 21, ...t, kind: "raft.assistant_chat_told", spanId: "mount:assistant", status: "reply_fallback", verdict: "failed",
      attrs: { mount: "assistant", reply_fallback: 0, result: "failed", code: "send_failed", failed_turn: 1 } },
    // `preferencesRaft`'s partial removal, and the legacy `traceRules` with `rulesAttrs`.
    { at: T0 + 22, ...t, kind: "raft.assistant_rules", spanId: "op_00000000000000000013", status: "removed_partial", verdict: "ok",
      attrs: { mount: "assistant", action: "remove", via: "raft", result: "removed_partial", removed: 2, left: 1, code: "http_502" } },
    { at: T0 + 23, ...t, kind: "raft.assistant_rules", spanId: "op_00000000000000000014", status: "added", verdict: "ok",
      attrs: { mount: "assistant", action: "add", effect: "mute", scope: "channel", result: "added", rules_total: 2, mute_channel: 1, always_person: 1 } },
    // `sendAsOwner`.
    { at: T0 + 24, ...t, kind: "raft.assistant_send_as_owner", spanId: "op_00000000000000000015", status: "refused:channel_not_found", verdict: "blocked",
      attrs: { mount: "assistant", result: "refused:channel_not_found", target_kind: "channel", in_thread: false, chars: 42, http_status: 404 } },
  ]);
}

const env0 = (seq: number, kind: string, at: number, extra: Record<string, unknown>) =>
  ({ seq, at: new Date(at).toISOString(), kind, tenant_id: "raft_t1", agent_id: "raft_a1", env: "preview", ...extra });
/** The rows `newKinds` writes, by seq, as they must go out. */
const GOLDEN_NEW: Record<number, Record<string, unknown>> = {
  10: env0(10, "turn.end_unrecorded", T0 + 10, { span_id: `turn_end:${T0 + 10}`, status: "failed", verdict: "failed", stage: "record", error_class: "SqliteError" }),
  11: env0(11, "rebuild.outcome", T0 + 11, { span_id: "mj_00000000000000000000000b", status: "agree", verdict: "ok", decision: "rb_0123456789abcdef0123",
    trigger: "cold-wake", strategy: "briefing", agreement: "agree", would_rebuild: true, predicted_cold: true, expected_cold: false, measured_cold: true,
    input: 5000, cache_read: 100, since_decision_ms: 1234 }),
  12: env0(12, "raft.assistant_wake", T0 + 12, { span_id: "mount", mount_index: 0, status: "invoked", verdict: "ok", result: "invoked", trigger: "brief",
    check_id: CHECK, raft_check: true, tools_offered: 1, tools_dropped: 2, placeholders_unknown: 1, placeholders_unoffered: 0, conversations: 5, items: 3,
    truncated: 0, told: 1, skipped: 1, muted: 2, digest: 1, always: 0, dm: 1, mention: 1, thread: 0, named: 0, default_out: 2, night_held: 0 }),
  13: env0(13, "raft.assistant_wake", T0 + 13, { span_id: "mount", mount_index: 0, status: "check_refused", verdict: "ok", result: "check_refused",
    trigger: "doorbell", check_id: CHECK, raft_check: true, reason: "instruction_too_large", instruction_bytes: 20000 }),
  14: env0(14, "raft.assistant_wake", T0 + 14, { span_id: "mount", mount_index: 0, status: "skipped_no_check", verdict: "ok", result: "skipped_no_check",
    trigger: "doorbell", raft_check: true }),
  15: env0(15, "raft.assistant_wake", T0 + 15, { span_id: "mount", mount_index: 0, status: "failed", verdict: "failed", result: "failed", trigger: "doorbell",
    error_code: "inbox_refused", http_status: 503 }),
  // given 6, shown 2, one held back; dropped 4: not_in_check 1, rule_mute 1 (the receiver's `dropped_rule`), and two
  // summed into dropped_other (`made_up_reason`, and the one that is not a code, which the plugin counts as `other`).
  16: env0(16, "raft.assistant_notify", T0 + 16, { span_id: "op_00000000000000000010", mount_index: 0, status: "sent", verdict: "ok", state: "sent",
    items_in: 6, items_sent: 2, held_back: 1, dropped: 4, dropped_not_in_check: 1, dropped_rule: 1, dropped_other: 2, check_id: CHECK,
    trigger: "doorbell", forwarded: 1 }),
  17: env0(17, "raft.assistant_notify", T0 + 17, { span_id: "op_00000000000000000011", mount_index: 0, status: "not_sent", verdict: "failed", state: "not_sent",
    items_in: 1, items_sent: 0, check_id: CHECK, trigger: "doorbell", forwarded: 1, code: "failed", http_status: 502 }),
  18: env0(18, "raft.assistant_check", T0 + 18, { span_id: "mount", mount_index: 0, status: "turn_ended", verdict: "failed", check_id: CHECK,
    trigger: "doorbell", outcome: "failed", error_code: "output_limit" }),
  19: env0(19, "raft.assistant_check", T0 + 19, { span_id: "mount", mount_index: 0, status: "import_failed", verdict: "failed", attempts: 3,
    http_status: 502, code: "http" }),
  20: env0(20, "raft.assistant_chat_told", T0 + 20, { span_id: "op_00000000000000000012", mount_index: 0, status: "told_failed", verdict: "failed",
    told: 0, refs: 2, forwarded: 1, http_status: 503, code: "http" }),
  21: env0(21, "raft.assistant_chat_told", T0 + 21, { span_id: "mount", mount_index: 0, status: "reply_fallback", verdict: "failed",
    reply_fallback: 0, result: "failed", code: "send_failed", failed_turn: 1 }),
  22: env0(22, "raft.assistant_rules", T0 + 22, { span_id: "op_00000000000000000013", mount_index: 0, status: "removed_partial", verdict: "ok",
    action: "remove", via: "raft", result: "removed_partial", removed: 2, left: 1, code: "http_502" }),
  23: env0(23, "raft.assistant_rules", T0 + 23, { span_id: "op_00000000000000000014", mount_index: 0, status: "added", verdict: "ok",
    action: "add", effect: "mute", scope: "channel", result: "added", rules_total: 2, mute_channel: 1, always_person: 1 }),
  24: env0(24, "raft.assistant_send_as_owner", T0 + 24, { span_id: "op_00000000000000000015", mount_index: 0, status: "refused:channel_not_found",
    verdict: "blocked", result: "refused:channel_not_found", target_kind: "channel", in_thread: false, chars: 42, http_status: 404 }),
};

const GOLDEN: Record<string, Record<string, unknown>> = {
  "model.call": { seq: 1, at: new Date(T0).toISOString(), kind: "model.call", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "mj_0123456789abcdef01234567", env: "preview",
    status: "toolUse", verdict: "ok", ms: 4000, model: "anthropic/claude-sonnet-4.5", stop_reason: "toolUse", input: 1200, output: 80,
    cache_read: 1000, cache_write: 200, reasoning: 12, turn: "tt_main@1789999990000", session: "main" },
  "model.attempt": { seq: 2, at: new Date(T0 + 1).toISOString(), kind: "model.attempt", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "mj_0123456789abcdef01234567",
    env: "preview", status: "retried", verdict: "failed", ms: 36100, attempt: 2, phase: "call", outcome: "http", total_ms: 36100,
    provider_ms: 35900, model: "anthropic/claude-sonnet-4.5", http_status: 529, error_class: "OverloadedError" },
  "tool.call": { seq: 3, at: new Date(T0 + 900).toISOString(), kind: "tool.call", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "op_00000000000000000001",
    env: "preview", status: "failed", verdict: "failed", ms: 900, tool: "messages.send", mount: "raft", mount_index: 1, task: "main", run_ms: 800,
    exit_code: -1, error_code: "NOT_FOUND", http_status: 404 },
  "tool.refused": { seq: 4, at: new Date(T0 + 3).toISOString(), kind: "tool.refused", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "call_Rf0r3fUs3d1|fc_0123456789abcdef0123",
    env: "preview", status: "unknown_tool", verdict: "blocked", code: "unknown_tool", by: "run_js", from: "program" },
  "turn.timing": { seq: 5, at: new Date(T0 + 4).toISOString(), kind: "turn.timing", tenant_id: "raft_t1", agent_id: "raft_a1",
    span_id: `tt_main@${T0 - 10_000}`, env: "preview", status: "completed", verdict: "ok", ms: 10004, inbound_to_start_ms: 1000, model_ms: 0,
    between_jobs_ms: 0, tool_ms: 700, model_jobs: 0, tools: 1, messages: 1, client_wait_ms: 0, client_pauses: 0, prep_ms: 100 },
  "turn.stop": { seq: 6, at: new Date(T0 + 5).toISOString(), kind: "turn.stop", tenant_id: "raft_t1", agent_id: "raft_a1", span_id: "op_00000000000000000002",
    env: "preview", status: "stopped", verdict: "cancelled", trigger: "provider_stop", turn: "tt_main@1789999990000" },
  "raft.assistant_wake": { seq: 7, at: new Date(T0 + 6).toISOString(), kind: "raft.assistant_wake", tenant_id: "raft_t1", agent_id: "raft_a1",
    span_id: "mount", mount_index: 0, env: "preview", status: "invoked", verdict: "ok", result: "invoked", trigger: "doorbell", conversations: 4,
    candidates: 2, seen: 1, unreadable: 0, lag_retry: 1, caught_up: true, caught_up_via: "mixed", caught_up_rule: "seq", muted: 1, told: 0 },
  "raft.assistant_notify": { seq: 8, at: new Date(T0 + 7).toISOString(), kind: "raft.assistant_notify", tenant_id: "raft_t1", agent_id: "raft_a1",
    span_id: "op_00000000000000000003", mount_index: 0, env: "preview", status: "sent", verdict: "ok", state: "sent", items_in: 4, items_sent: 1, dropped: 3,
    dropped_already_told: 1, dropped_rule: 1, dropped_not_confirmed: 1 },
  "raft.turn_ended": { seq: 9, at: new Date(T0 + 8).toISOString(), kind: "raft.turn_ended", tenant_id: "raft_t1", agent_id: "raft_a1",
    span_id: "mount", mount_index: 1, env: "preview", status: "skipped", verdict: "ok", result: "skipped", reason: "snapshot_stale", conversations: 3,
    outcome: "completed" },
};
/** Same keys, same values, any order. */
const sameRow = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.join(",") === kb.join(",") && ka.every((k) => a[k] === b[k]);
};

await check("the agent.trace lane is the receiver's kinds and the proposed ones, every one a trace kind, and none of github.refresh's", async () => {
  must(AGENT_TRACE_KINDS.slice().sort().join(",") === Object.keys(CONTRACT).sort().join(","), `kinds: ${AGENT_TRACE_KINDS}`);
  must(AGENT_TRACE_KINDS.length === 15, `kinds: ${AGENT_TRACE_KINDS.length}`);
  // Every proposal is new to the receiver: a field it already keeps as it is moves to WORKER_FIELDS, not here.
  for (const [kind, fields] of Object.entries(PROPOSED)) {
    for (const [f, type] of Object.entries(fields)) must(WORKER_FIELDS[kind]?.[f] !== type, `${kind}.${f} is proposed but the receiver has it`);
  }
  // A plugin's row is about its mount, so it carries `mount_index` (the envelope's), and the receiver is to keep it.
  for (const kind of AGENT_TRACE_KINDS) {
    if ((PLUGIN_TRACE_KINDS as readonly string[]).includes(kind)) must(CONTRACT[kind]!.mount_index === "count", `${kind} has no mount_index in the contract`);
  }
  for (const k of AGENT_TRACE_KINDS) must((TRACE_KINDS as readonly string[]).includes(k), `${k} is not a trace kind`);
  must(!AGENT_TRACE_KINDS.includes("github.refresh") && GITHUB_REFRESH_LANE.kinds.join() === "github.refresh", "the lanes overlap");
  must(AGENT_TRACE_LANE.path === TRACE_PATH && GITHUB_REFRESH_LANE.path === GHR_PATH, "paths");
});

/** The receiver's fields this side leaves unfilled: their value is whatever word the model wrote (cf/src/trace-forward.ts). */
const UNFILLED = ["model.call.first_tool", "tool.refused.tool"];
const RECEIVER_ID = /^[A-Za-z0-9_.:@/|-]{1,128}$/, RECEIVER_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

await check("the fields per kind are the receiver's names and types, or narrower: a known list for an id or code, a minted shape for an id", async () => {
  const diff: string[] = [], unfilled: string[] = [];
  for (const [kind, all] of Object.entries(CONTRACT)) {
    const ours = AGENT_TRACE_FIELDS[kind as TraceKind]!;
    const fields = Object.fromEntries(Object.entries(all).filter(([f]) => f !== "mount_index"));
    for (const [f, type] of Object.entries(fields)) {
      const mine = ours[f]?.[1];
      if (mine === undefined) { unfilled.push(`${kind}.${f}`); continue; }
      // `flag`: a boolean attr sent as the 1 or 0 the receiver's count takes (a wake's inbox_lagging_gave_up).
      const ok = Array.isArray(mine)
        ? mine.join("|") === type || (type === "id" && mine.every((v) => RECEIVER_ID.test(v))) || (type === "code" && mine.every((v) => RECEIVER_CODE.test(v)))
        : mine === "flag" ? type === "count"
        : mine === "session" || mine === "turn" || mine === "task" || mine === "mount" || mine === "check" || mine === "minted" ? type === "id"
        : mine === type;
      if (!ok) diff.push(`${kind}.${f}: receiver ${type}, here ${Array.isArray(mine) ? mine.join("|") : mine}`);
    }
    for (const f of Object.keys(ours)) if (!(f in fields)) diff.push(`${kind}.${f}: not the receiver's`);
  }
  must(!diff.length, diff.join("; "));
  must(unfilled.sort().join() === UNFILLED.slice().sort().join(), `unfilled: ${unfilled}`);
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

for (const [seq, want] of Object.entries(GOLDEN_NEW)) {
  await check(`golden: ${want.kind} (${want.status}) goes out as exactly these fields`, async () => {
    const { sql } = sqliteHost(); const e = routes();
    everyKind(sql); await newKinds(sql);
    await lanePass(sql, e);
    const row = traced(e).find((r) => r.seq === Number(seq));
    must(row, `no row ${seq} was sent: ${JSON.stringify(traced(e).map((r) => `${r.seq}:${r.kind}`))}`);
    must(sameRow(row, want), `${seq}:\n      sent ${JSON.stringify(row)}\n      want ${JSON.stringify(want)}`);
  });
}

await check("every kind and every proposed field is exercised by a golden row", async () => {
  const sent = new Map<string, Set<string>>();
  for (const r of [...Object.values(GOLDEN), ...Object.values(GOLDEN_NEW)]) {
    const k = String(r.kind);
    if (!sent.has(k)) sent.set(k, new Set());
    for (const f of Object.keys(r)) sent.get(k)!.add(f);
  }
  const missing: string[] = [];
  for (const kind of AGENT_TRACE_KINDS) if (!sent.has(kind)) missing.push(kind);
  for (const [kind, fields] of Object.entries(PROPOSED)) for (const f of Object.keys(fields)) if (!sent.get(kind)?.has(f)) missing.push(`${kind}.${f}`);
  // Raft's own notify answers say `duplicate` or a state this build does not know; the night's `kept_for_brief` count is the legacy check's.
  const notShown = ["raft.assistant_notify.kept_for_brief", "raft.assistant_chat_told.skipped"];
  must(missing.filter((m) => !notShown.includes(m)).length === 0, `no golden row has: ${missing}`);
});

await check("the new kinds' fields hold their shapes: a check id, a decision id, a reason or an action outside its list is left out", async () => {
  const { sql } = sqliteHost(); const e = routes();
  withMounts(sql, [["assistant", "raft"]]);
  const row = (n: number, kind: TraceKind, status: string, attrs: Record<string, unknown>): TraceRow =>
    ({ at: T0 + n, ...OWNER, kind, spanId: "mount:assistant", status, verdict: "ok", attrs: { mount: "assistant", ...attrs } });
  appendTrace(sql, [
    row(1, "raft.assistant_wake", "check_refused", { check_id: "alice_peer", reason: "the instruction said alice", raft_check: "yes", tools_dropped: -1 }),
    row(2, "rebuild.outcome", "agree", { decision: "alice", trigger: "nightly", rule: "alice-rule", hitRate: 0.5 }),
    row(3, "raft.assistant_rules", "refused:effect", { action: "please mute alice", result: "refused:effect", scope: "alice", via: "elsewhere" }),
    // `dropped` is the total, not a reason; a non-count and a name-like key are not summed.
    row(4, "raft.assistant_notify", "sent", { notifyState: "sent", dropped: 5, dropped_other: 1, dropped_x: 2, dropped_y: "3", "dropped_Alice Smith": 4 }),
    row(5, "raft.assistant_send_as_owner", "sent", { result: "sent", target_kind: "#alice", chars: 3.6 }),
    row(6, "turn.end_unrecorded", "failed", { stage: "write", error_class: "has spaces in it" }),
  ]);
  await lanePass(sql, e);
  const [w, r, rules, n, so, te] = traced(e);
  must(w.check_id === undefined && w.reason === undefined && w.raft_check === undefined && w.tools_dropped === undefined && w.result === "check_refused", JSON.stringify(w));
  must(r.decision === undefined && r.trigger === undefined && !("rule" in r) && !("hit_rate" in r) && r.agreement === undefined && r.status === "agree", JSON.stringify(r));
  must(rules.action === undefined && rules.scope === undefined && rules.via === undefined && rules.result === "refused:effect", JSON.stringify(rules));
  must(n.dropped === 5 && n.dropped_other === 3 && n.state === "sent", JSON.stringify(n));
  must(so.target_kind === undefined && so.chars === 4 && so.result === "sent", JSON.stringify(so));
  must(te.stage === undefined && te.error_class === undefined, JSON.stringify(te));
  must(!e.requests.map((q) => q.text).join("").includes("alice") && !e.requests.map((q) => q.text).join("").includes("Alice"), "a name was sent");
});

await check("an agent.trace row carries the envelope and its kind's fields, nothing else, and no free text", async () => {
  const { sql } = sqliteHost(); const e = routes();
  everyKind(sql); await newKinds(sql);
  await lanePass(sql, e);
  const rows = traced(e);
  must(rows.length === 24, `rows: ${rows.length}`);
  for (const r of rows) {
    const allowed = new Set([...ENVELOPE, ...Object.keys(AGENT_TRACE_FIELDS[r.kind as TraceKind]!)]);
    const extra = Object.keys(r).filter((k) => !allowed.has(k));
    must(!extra.length, `${r.kind} carried ${extra}`);
    for (const [k, v] of Object.entries(r)) {
      if (k === "at") continue;
      must(typeof v === "number" || typeof v === "boolean" || (typeof v === "string" && /^[A-Za-z0-9_.:@/|-]{1,128}$/.test(v)), `${r.kind}.${k} = ${JSON.stringify(v)}`);
    }
  }
  const text = e.requests.map((r) => r.text).join("\n");
  for (const leak of ["secret-plans", "alice@example.com", "daily limit", "overloaded", '"error":', '"name":', '"callId":', '"limit":', '"prefix":', '"mount":"assistant"', '"engine":',
    "alice", "c-1", "c-3", "made_up_reason", "Not A Code", "owner-1", "dm:@owner", '"rule":', "hitRate", '"hit_rate"', "turnKey"]) {
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
  const s2 = traced(e).find((r) => r.seq === 2)!;
  must(s2.error_code === undefined && s2.tool === "api_get", JSON.stringify(s2));
});

await check("a value not in its field's shape is left out, never rewritten; a span that is not an id is left out; an unsendable row is counted, not sent", async () => {
  const { sql } = sqliteHost(); const e = routes();
  withMounts(sql, [["gh", "github"]]);
  appendTrace(sql, [
    { at: T0, ...OWNER, kind: "tool.call", spanId: "op_ok", status: "succeeded", verdict: "ok", attrs: { tool: "has spaces in it", mount: "gh", exitCode: 1.7, runMs: -5 } },
    { at: T0 + 1, ...OWNER, kind: "tool.refused", spanId: "call_a|fc_b", status: "no_tools", verdict: "blocked", attrs: { code: "No_Tools", by: "gateway", from: "elsewhere" } },
    { at: T0 + 2, tenantId: "raft_t1", agentId: "agent with spaces", kind: "turn.stop", spanId: "op_x", status: "stopped", verdict: "cancelled", attrs: { trigger: "delete" } },
    { at: T0 + 3, ...OWNER, kind: "turn.stop", spanId: "x".repeat(150), status: "stopped", verdict: "cancelled", attrs: { trigger: "admin_cancel", errorClass: "stopped: by operator" } },
  ]);
  await lanePass(sql, e);
  const rows = traced(e);
  must(rows.map((r) => r.seq).join(",") === "1,2,4", `sent: ${rows.map((r) => r.seq)}`);
  const [a, b, d] = rows;  // b's span is not a provider's call id shape (fc_ too short): left out
  must(a.tool === undefined && a.exit_code === 1 && a.run_ms === undefined && a.mount === "github" && a.mount_index === 0, JSON.stringify(a));
  must(!("span_id" in b) && b.from === undefined && b.code === "No_Tools", JSON.stringify(b));
  must(!("span_id" in d) && d.seq === 4 && d.error_class === undefined && d.trigger === "admin_cancel", JSON.stringify(d));
  must(JSON.stringify(atrLog(sql)) === JSON.stringify([{ reason: "unsendable", status: null, rows: 1 }]), JSON.stringify(atrLog(sql)));
});

await check("batches: at most 500 rows and 256 KiB a request, oldest first, every row once", async () => {
  const { sql } = sqliteHost(); const e = routes();
  const long = (c: string) => `${c}`.repeat(128);
  const rows: TraceRow[] = [];
  for (let n = 1; n <= 1_400; n++) {
    const hex = n.toString(16).padStart(40, "0");
    rows.push({ at: T0 + n, ...OWNER, kind: "model.call", spanId: `mj_${hex}${hex.slice(0, 24)}`, status: "stop", verdict: "ok", ms: n,
      attrs: n <= 700
        ? { model: long("m"), session: `sess_${hex}`, turn: `tt_sess_${hex}@${T0 + n}`, input: n, output: n, cacheRead: n, cacheWrite: n, reasoning: n }
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

await check("every agent.trace row carries its seq, the receiver's key; a wake still lagging says so in result and its give-up as 1", async () => {
  const { sql } = sqliteHost(); const e = routes();
  appendTrace(sql, [
    { at: T0, ...OWNER, kind: "raft.assistant_wake", spanId: "mount:assistant", status: "inbox_lagging", verdict: "ok",
      attrs: { trigger: "doorbell", conversations: 2, inbox_lagging: true, lagRetry: 0, caught_up: false, caught_up_rule: "time" } },
    { at: T0 + 1, ...OWNER, kind: "raft.assistant_wake", spanId: "mount:assistant", status: "skipped_filtered", verdict: "ok",
      attrs: { trigger: "doorbell", conversations: 2, lagRetry: 3, caught_up: false, caught_up_rule: "seq", inbox_lagging: true, inbox_lagging_gave_up: true } },
  ]);
  await lanePass(sql, e);
  const [a, b] = traced(e);
  must(a.seq === 1 && b.seq === 2 && a.span_id === b.span_id, "two wakes, one span, told apart by seq");
  must(a.result === "inbox_lagging" && a.inbox_lagging === undefined && a.inbox_lagging_gave_up === undefined, JSON.stringify(a));
  must(b.result === "skipped_filtered" && b.inbox_lagging_gave_up === 1 && b.lag_retry === 3, JSON.stringify(b));
});

await check("a 2xx with rejected rows: the batch leaves the queue, the rejected are counted by reason and not retried, and it is no failure", async () => {
  const { sql } = sqliteHost();
  const e = routes((path, rows) => path !== TRACE_PATH ? 200 : { status: 200, body: JSON.stringify({ ok: true, accepted: rows.length - 3,
    rejected: [{ index: 1, reason: "seq_invalid" }, { index: 3, reason: "kind_not_allowed" }, { index: 3, reason: "kind_not_allowed" },
      { index: 5, reason: "has spaces in it" }, { index: 99, reason: "seq_invalid" }, { index: -1 }, "junk"] }) });
  everyKind(sql);
  const p = await lanePass(sql, e);
  const f = p.forwarded!["agent.trace"]!;
  must(f.error === null && f.sent === 6 && f.dropped === 3 && f.kept === 0 && !f.skipped, JSON.stringify(f));
  must(ATR(sql).length === 0, `queued: ${ATR(sql)}`);
  const log = sql.exec("SELECT reason, status, rows, detail FROM atr_forward_log ORDER BY detail").toArray();
  must(JSON.stringify(log) === JSON.stringify([
    { reason: "rejected", status: 200, rows: 1, detail: "kind_not_allowed" }, { reason: "rejected", status: 200, rows: 1, detail: "other" },
    { reason: "rejected", status: 200, rows: 1, detail: "seq_invalid" },
  ]), JSON.stringify(log));
  must(sql.exec("SELECT 1 FROM atr_forward_state").toArray().length === 0, "a 2xx with rejections backed off");
  // Nothing is sent again: the next pass has nothing to send.
  const again = await lanePass(sql, e);
  must(again.forwarded!["agent.trace"]!.sent === 0 && e.requests.filter((r) => r.path === TRACE_PATH).length === 1, "resent");
});

await check("a 2xx whose body is not the answer's shape rejected nothing: every row counts as sent", async () => {
  for (const body of ["", "not json", JSON.stringify({ ok: true }), JSON.stringify({ rejected: "all" }), "x".repeat(70 * 1024)]) {
    const { sql } = sqliteHost();
    const e = routes((path) => path !== TRACE_PATH ? 200 : { status: 200, body });
    everyKind(sql);
    const f = (await lanePass(sql, e)).forwarded!["agent.trace"]!;
    must(f.sent === 9 && f.dropped === 0 && f.error === null && ATR(sql).length === 0, `${body.slice(0, 20)}: ${JSON.stringify(f)}`);
  }
});

await check("RFC 077: an owner's DM peer and a channel's name, read by the assistant's real wake and notify, never leave in a request", async () => {
  const PEER = "alice-peer-xyz", CHANNEL = "secret-channel-xyz";
  const NOW = Date.parse("2026-10-20T10:30:00Z"); // 12:30 in Berlin: a doorbell's check, not the brief, not the night
  const { sql } = sqliteHost();
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: OWNER.tenantId, agentId: OWNER.agentId, alias: "assistant", plugin: raftPlugin.id };
  const local: TraceRow[] = [];
  let op: string | null = null;
  // The gateway's `trace` (src/runtime/gateway.ts): the operation's span, else the mount's; the mount first in attrs.
  const ctx = {
    caller: { tenantId: OWNER.tenantId, agentId: OWNER.agentId, taskId: "main" }, alias: "assistant",
    db: openPluginDatabase(tables, scope, raftPlugin.database),
    trace: (row: any) => local.push({ at: NOW, ...OWNER, kind: row.kind, spanId: op ?? "mount:assistant", status: row.status, verdict: row.verdict,
      attrs: { mount: "assistant", ...row.attrs } }),
  } as any;
  await ctx.db.put(ASSISTANT_STORE, { userId: "owner-1", timezone: "Europe/Berlin", dmTarget: "dm:@owner", doorbellAt: NOW - 60_000,
    lastBrief: "2026-10-20", briefSent: "2026-10-20" }, OWNER_KEY);
  const items = [
    { channelId: "c-dm-1", channelName: PEER, channelType: "dm", kind: "dm", unread: 2, hasMention: false, latestAt: "2026-10-20T10:20:00.000Z",
      latestSenderName: PEER, latestPreview: `hi, ${PEER} here`, firstUnreadMessageId: "aaaaaaa1-1111-4222-8333-444455556666" },
    { channelId: "c-ch-1", channelName: CHANNEL, channelType: "channel", kind: "channel", unread: 1, hasMention: true, latestAt: "2026-10-20T10:25:00.000Z",
      latestSenderName: PEER, latestPreview: `plans for #${CHANNEL}`, firstUnreadMessageId: "bbbbbbb2-1111-4222-8333-444455556666" },
  ];
  const sends: string[] = [];
  let unreadableDm = false;
  const deps = {
    recheck: async () => null, now: () => NOW,
    inbox: async (_c: unknown, req: { filter: string }) => ({ ok: true as const, data: { owner: { userId: "owner-1" }, filter: req.filter, items } }),
    messages: async (_c: unknown, channelId: string) => unreadableDm && channelId === "c-dm-1"
      ? { ok: false as const, error: `could not read ${PEER}` } : { ok: true as const, ids: [channelId === "c-dm-1" ? "aaaaaaa1" : "bbbbbbb2"] },
    send: async (_c: unknown, target: string, content: string) => { sends.push(`${target}: ${content}`); return { sent: true as const }; },
  };
  const first = await assistantWake(ctx, deps);
  must(first && "turn" in first && String((first as any).turn).includes(CHANNEL), "control: the check's turn names the conversations it is to look at");
  // The model's notify, about both, in the DM's and the channel's own references.
  op = "op_0000000000000000000a";
  const out = await notifyOwner({ items: [
    { ref: `#${PEER}:aaaaaaa1`, summary: `${PEER} asks about Friday`, kind: "question", sender: `@${PEER}` },
    { ref: `#${CHANNEL}:bbbbbbb2`, summary: `plans in #${CHANNEL}`, kind: "mention", sender: `@${PEER}` },
  ] }, ctx, { send: deps.send, recheck: async () => null, now: () => NOW }) as any;
  must(out.state === "sent" && sends.some((x) => x.includes(PEER)), `control: notify sent about them: ${JSON.stringify(out)}`);
  // A second doorbell whose DM cannot be read: the unreadable outcome, which tells the owner by name.
  op = null; unreadableDm = true;
  await ctx.db.put(ASSISTANT_STORE, { ...(await ctx.db.get(ASSISTANT_STORE, OWNER_KEY)), doorbellAt: NOW - 1_000 }, OWNER_KEY);
  items[0]!.latestAt = "2026-10-20T10:29:00.000Z"; items[1]!.latestAt = "2026-10-20T10:29:30.000Z";
  await assistantWake(ctx, deps);
  // Raft's answer to the turn's end, with the attrs src/plugins/raft.ts `reportTurnEnd` writes: the conversations counted, never named.
  const shown = [PEER, CHANNEL];
  local.push({ at: NOW, ...OWNER, kind: "raft.turn_ended", spanId: "mount:raft", status: "settled", verdict: "ok",
    attrs: { mount: "raft", outcome: "completed", targets: shown.length } });
  const kinds = local.map((r) => `${r.kind}:${r.status}`);
  must(kinds.join() === "raft.assistant_wake:invoked,raft.assistant_notify:sent,raft.assistant_wake:unreadable,raft.turn_ended:settled", `rows: ${kinds}`);
  appendTrace(sql, local);
  const e = routes();
  await lanePass(sql, e);
  must(traced(e).length === 4, `sent ${traced(e).length}`);
  const body = e.requests.map((r) => r.text).join("\n");
  for (const name of [PEER, CHANNEL, "alice", "secret-channel", "c-dm-1", "c-ch-1", "aaaaaaa1", "bbbbbbb2", "owner-1", "dm:@owner"]) {
    must(!body.includes(name), `the request body has ${name}`);
  }
  // And the rows as kept here, before the forward: nothing of them either (the plugin writes counts only).
  const kept = JSON.stringify(local);
  must(kept.includes('"conversations":2') && kept.includes('"given":2'), `control: the local rows are the plugin's: ${kept}`);
  for (const name of [PEER, CHANNEL]) must(!kept.includes(name), `the local trace has ${name}: ${kept}`);
});

await check("a URL that is not https is refused: no fetch on either lane, nothing staged, the token never sent; the reason is named", async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ TRACE_INGEST_URL: "http://10.0.3.7", TRACE_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" }, "url_not_https"],
    [{ TRACE_INGEST_URL: "http://ingest-alb-123.elb.amazonaws.com/", TRACE_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" }, "url_not_https"],
    [{ GITHUB_REFRESH_INGEST_URL: "http://ingest.example", GITHUB_REFRESH_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "production" }, "url_not_https"],
    // The new name set wrong does not fall back to an old one set right: what someone wrote is what is reported.
    [{ TRACE_INGEST_URL: "http://ingest.example", GITHUB_REFRESH_INGEST_URL: "https://ingest.example", TRACE_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" }, "url_not_https"],
    [{ TRACE_INGEST_URL: "ingest.example", TRACE_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" }, "url_invalid"],
    [{ TRACE_INGEST_URL: "ftp://ingest.example", TRACE_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" }, "url_not_https"],
    [{ TRACE_INGEST_URL: "https://user:pw@ingest.example", TRACE_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" }, "url_has_credentials"],
    [{ TRACE_INGEST_URL: "https://ingest.example", DEPLOYMENT_ENV: "preview" }, "token_missing"],
    [{ TRACE_INGEST_TOKEN: TOKEN, DEPLOYMENT_ENV: "preview" }, "url_missing"],
    [{ TRACE_INGEST_URL: "https://ingest.example", TRACE_INGEST_TOKEN: TOKEN }, "deployment_env_invalid"],
  ];
  for (const [env, problem] of cases) {
    const s = forwardSettingsOf(env);
    must(s.state === "misconfigured" && s.problem === problem, `${JSON.stringify(env)}: ${JSON.stringify(s)}`);
    must(!JSON.stringify(s).includes(TOKEN) && !JSON.stringify(s).includes("ingest"), `the settings report carries a value: ${JSON.stringify(s)}`);
    const { sql } = sqliteHost();
    let fetched = 0;
    const e = routes(); const f0 = e.fetch; e.fetch = async (u: string, i: RequestInit) => { fetched++; return f0(u, i); };
    everyKind(sql); appendTrace(sql, [refresh(20)]);
    const p = await lanePass(sql, e, env);
    must(p.hold === null && p.forwarded === null && fetched === 0, `${problem}: ${JSON.stringify(p)} fetched ${fetched}`);
  }
  must(forwardSettingsOf({}).state === "off", "nothing set is off, not misconfigured");
  // And a config that reached the sender some other way is still refused there, before any fetch.
  const { sql } = sqliteHost(); everyKind(sql);
  const forged = { url: "http://ingest.example", token: TOKEN, env: "preview" as const };
  stageForward(sql, forged, OWNER.tenantId, OWNER.agentId, Date.now, AGENT_TRACE_LANE);
  let fetched = 0;
  const r = await sendForward(sql, forged, OWNER.tenantId, OWNER.agentId, async () => { fetched++; return new Response(null, { status: 200 }); },
    Date.now, FORWARD_TIMEOUT_MS, AGENT_TRACE_LANE);
  must(fetched === 0 && r.error === "config: url_not_https" && r.sent === 0 && ATR(sql).length === 9, JSON.stringify(r));
});

await check("a mount's alias never leaves, on either lane: its type is sent as `mount`, its ordinal as `mount_index`, its spans without it", async () => {
  const ALIAS = "alice-alias-xyz", GONE = "bob-alias-gone";
  const { sql } = sqliteHost();
  withMounts(sql, [[ALIAS, "raft"], ["gh", "github"], ["zz-files", "artifacts"]]);
  appendTrace(sql, [
    toolCallRow({ ...OWNER, taskId: "main", operationId: "op_000000000000000000a1", mountAlias: ALIAS, tool: "messages.send", status: "succeeded",
      createdAt: T0, endedAt: T0 + 5 }),
    { at: T0 + 1, ...OWNER, kind: "raft.assistant_wake", spanId: `mount:${ALIAS}`, status: "invoked", verdict: "ok", attrs: { mount: ALIAS, trigger: "doorbell", conversations: 1 } },
    { at: T0 + 2, ...OWNER, kind: "raft.assistant_wake", spanId: `wake:${ALIAS}:${T0 + 2}`, status: "failed", verdict: "failed", attrs: { reason: "engine_pd_unsupported", mount: ALIAS } },
    { at: T0 + 3, ...OWNER, kind: "raft.assistant_notify", spanId: "op_000000000000000000a2", status: "sent", verdict: "ok", attrs: { mount: ALIAS, given: 1, sent: 1 } },
    { at: T0 + 4, ...OWNER, kind: "raft.turn_ended", spanId: `mount:${ALIAS}`, status: "settled", verdict: "ok", attrs: { mount: ALIAS, targets: 1 } },
    // A mount removed since: its alias names nothing now, so no type and no ordinal, and still never the alias.
    toolCallRow({ ...OWNER, taskId: "main", operationId: "op_000000000000000000a3", mountAlias: GONE, tool: "x", status: "succeeded", createdAt: T0, endedAt: T0 + 6 }),
    refresh(7, "rotated", { mount: ALIAS }),
  ]);
  const e = routes();
  await lanePass(sql, e);
  const body = e.requests.map((r) => r.text).join("\n");
  for (const name of [ALIAS, "alice", GONE, "bob-alias"]) must(!body.includes(name), `the request body has ${name}: ${body.slice(0, 400)}`);
  const rows = traced(e);
  const bySeq = (n: number) => rows.find((r) => r.seq === n)!;
  must(bySeq(1).mount === "raft" && bySeq(1).mount_index === 0, `tool.call: ${JSON.stringify(bySeq(1))}`);
  must(bySeq(2).span_id === "mount" && bySeq(2).mount_index === 0, `wake: ${JSON.stringify(bySeq(2))}`);
  must(bySeq(3).span_id === `wake:${T0 + 2}` && bySeq(3).mount_index === 0, `pd wake: ${JSON.stringify(bySeq(3))}`);
  must(bySeq(4).mount_index === 0 && bySeq(5).span_id === "mount" && bySeq(5).mount_index === 0, `notify/turn_ended: ${JSON.stringify([bySeq(4), bySeq(5)])}`);
  must(!("mount" in bySeq(6)) && !("mount_index" in bySeq(6)), `removed mount: ${JSON.stringify(bySeq(6))}`);
  const ghr = e.requests.find((r) => r.path === GHR_PATH)!.rows[0];
  must(ghr.mount === "raft" && ghr.seq === 7, `github.refresh: ${JSON.stringify(ghr)}`);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
