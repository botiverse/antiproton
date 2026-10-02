/**
 * Usage leaves an idle object (cf/src/index.ts `alarm`, `#usageWake`; cf/src/usage-flush.ts): a row
 * written outside an alarm pass arms a short alarm, the pass that stands down counts its own active time
 * and sends it, and a backlog the pass could not finish — more than one batch, or a lost cursor race —
 * brings the object back, a bounded number of times. The whole `AgentDO` under node, with its
 * `cloudflare:workers` stand-in as in test/pd-writes.ts, a virtual clock that jumps to the armed alarm,
 * and D1 as node:sqlite holding the two tables the flush writes.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { PiDurableSqlite } from "../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { appendUsage } from "../src/usage/outbox.ts";
import { appendTrace } from "../src/trace/outbox.ts";
import { busySpans, unionMs } from "../src/usage/active.ts";
import { USAGE_RETRY_LIMIT } from "../cf/src/usage-flush.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

// A clock the test moves: an alarm "fires" by jumping to the time it was armed for, and every reading
// moves it a millisecond, so a handler takes time and leaves a span worth counting.
let clock = Date.now();
Date.now = () => ++clock;

/**
 * D1 as node:sqlite, with the usage tables the flush writes. Anything else the object asks of D1 (the
 * model choice, the hook directory) reads as empty. `lose(n)` makes the next n usage batches lose the
 * cursor race: nothing is written and the cursor update changes no row, as when another send won.
 */
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE usage_cursor(tenant_id TEXT, agent_id TEXT, last_seq INTEGER, PRIMARY KEY(tenant_id, agent_id))");
  db.exec(`CREATE TABLE usage_hourly(tenant_id TEXT, hour INTEGER, agent_id TEXT, resource TEXT, key TEXT, unit TEXT, quantity REAL,
    PRIMARY KEY(tenant_id, hour, agent_id, resource, key, unit))`);
  let losing = 0;
  let batches = 0;
  const stmt = (q: string, b: unknown[] = []) => ({
    q, b,
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => { try { return (db.prepare(q).get(...(b as any[])) as any) ?? null; } catch { return null; } },
    all: async () => { try { return { results: db.prepare(q).all(...(b as any[])) }; } catch { return { results: [] }; } },
    run: async () => { try { return { meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }; } catch { return { meta: { changes: 0 } }; } },
  });
  return {
    prepare: (q: string) => stmt(q),
    batch: async (s: Array<ReturnType<typeof stmt>>) => {
      batches++;
      if (losing > 0) { losing--; return s.map(() => ({ results: [], meta: { changes: 0 } })); }
      return s.map((x) => { try { return { results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } }; } catch { return { results: [], meta: { changes: 0 } }; } });
    },
    lose(n: number) { losing = n; },
    get batches() { return batches; },
    ledger(resource?: string) {
      return db.prepare("SELECT resource, key, unit, SUM(quantity) AS q FROM usage_hourly GROUP BY resource, key, unit").all()
        .map((r: any) => ({ resource: String(r.resource), key: String(r.key), unit: String(r.unit), q: Number(r.q) }))
        .filter((r) => resource === undefined || r.resource === resource);
    },
  };
}

const T = "t", A = "a";

/** One agent's object, its storage, and the alarm it has armed. */
async function object(opts: { pd?: boolean } = {}) {
  const raw = sqliteHost();
  if (opts.pd) {
    const ap = new ApStore(raw.sql, new PiDurableSqlite(raw, prefixedNamespace("pd")), prefixedNamespace("ap"));
    await ap.ensure();
    await ap.setEngineOnce("pd");
  }
  const db = d1();
  const jobs: string[] = [];
  const puts: string[] = [];
  const state = { alarmAt: null as number | null, sets: 0 };
  const ctx = {
    storage: {
      sql: raw.sql, transaction: raw.transaction, transactionSync: raw.transactionSync,
      getAlarm: async () => state.alarmAt,
      setAlarm: async (at: number) => { state.alarmAt = at; state.sets++; },
      deleteAlarm: async () => { state.alarmAt = null; },
    },
    id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
  };
  const env = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: { put: async (key: string) => { puts.push(key); return {}; }, get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
    ARTIFACT_BUCKET: "b", CONTROL_DB: db, HARNESS_MODEL: "m1",
    DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k",
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
  };
  const D = new AgentDO(ctx as never, env as never);
  /** Fire the armed alarm, as the platform would, until none is armed; how many passes that took. */
  const settle = async (answer?: (jobId: string) => Promise<void>, max = 40) => {
    let passes = 0;
    for (;;) {
      if (answer && jobs.length) { await answer(jobs.shift()!); continue; }
      if (state.alarmAt === null) return passes;
      must(passes < max, `the object did not settle in ${max} passes (alarm at +${state.alarmAt - clock}ms)`);
      clock = Math.max(clock, state.alarmAt);
      passes++;
      await D.alarm();
      clock += 5;
    }
  };
  const outbox = () => {
    try { return Number((raw.sql.exec("SELECT COUNT(*) AS n FROM usage_outbox").toArray()[0] as any)?.n ?? 0); }
    catch (e) { if (/no such table/.test(String(e))) return 0; throw e; }
  };
  /** Active time the object has spent and not yet counted into the outbox, in ms. */
  const uncountedMs = () => {
    const spans = raw.sql.exec("SELECT at, ms, kind FROM do_activity").toArray()
      .map((r: any) => ({ at: Number(r.at), ms: Number(r.ms), kind: String(r.kind) }));
    let counted = 0;
    try { counted = Number((raw.sql.exec("SELECT SUM(ms) AS ms FROM usage_active").toArray()[0] as any)?.ms ?? 0); } catch { /* none yet */ }
    return unionMs(busySpans(spans)) - counted;
  };
  /** Trace rows the export has not taken. */
  const traceUnsent = () => {
    let sent = 0;
    try { sent = Number((raw.sql.exec("SELECT through_seq FROM trace_sent WHERE id = 1").toArray()[0] as any)?.through_seq ?? 0); } catch { /* none yet */ }
    try { return Number((raw.sql.exec("SELECT COUNT(*) AS n FROM trace_outbox WHERE seq > ?", sent).toArray()[0] as any).n); } catch { return 0; }
  };
  return { D, raw, db, jobs, puts, state, settle, outbox, uncountedMs, traceUnsent };
}

/** An agent as the console makes it, bound to the operator's model, left to settle. */
async function adopt(o: Awaited<ReturnType<typeof object>>) {
  await o.D.uiAdoptAgent(T, A, { name: "n", description: "d", avatar: "x" });
  const rt = o.D.runtime();
  await rt.ready();
  await rt.bindOperatorModel(T, A);
  await o.settle();
}

const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** One console message, answered once by the model, then left alone: how many alarm passes. */
async function turnPasses(pd: boolean) {
  const o = await object({ pd });
  await adopt(o);
  o.state.sets = 0;
  await o.D.uiSay(T, A, `t_${A}`, "hello", "steer");
  const passes = await o.settle(async (id) => {
    const job = await o.D.takeJob(T, A, id) as any;
    await o.D.deliverAnswer(T, A, id, { role: "assistant", content: [{ type: "text", text: "ok" }], api: job?.model?.api ?? "x", provider: job?.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0 }, 5);
  });
  const left = o.outbox();
  const uncounted = o.uncountedMs();
  const tokens = o.db.ledger("model.tokens").reduce((a, r) => a + r.q, 0);
  o.raw.dispose();
  return { passes, left, uncounted, tokens };
}

if (process.argv[2] === "--measure") {
  // Not a check: the numbers the change is measured by, printed for a person to compare across commits.
  for (const pd of [false, true]) console.log(`${pd ? "pd" : "default"} engine: ${show(await turnPasses(pd))}`);
  process.exit(0);
}

await check("usage written by provisionTool on an idle object reaches the ledger with nothing else waking it", async () => {
  const o = await object();
  await o.D.provisionAdopt(T, A, JSON.stringify({ name: "Cody", instructions: "be brief", raftOrigin: "https://raft.example" }));
  await o.settle();
  must(o.state.alarmAt === null, "adopting left an alarm armed");
  const before = o.db.ledger("tool.call").length;
  const r = await o.D.provisionTool(T, A, "enable_push");
  must(!r.ok, `enable_push with no credential succeeded: ${show(r)}`);
  must(o.outbox() > 0, "the tool call wrote no usage row");
  must(o.state.alarmAt !== null && o.state.alarmAt - clock <= 10_000, `no short alarm was armed: ${o.state.alarmAt}`);
  const passes = await o.settle();
  must(passes === 1, `${passes} passes to send one row`);
  const calls = o.db.ledger("tool.call");
  must(calls.length > before && calls.some((c) => c.key.includes("enable_push")), `the call is not in the ledger: ${show(calls)}`);
  must(o.outbox() === 0, `${o.outbox()} rows left in the outbox`);
  o.raw.dispose();
});

await check("the trace row a provisionTool call writes reaches the export on the same short alarm", async () => {
  const o = await object();
  await o.D.provisionAdopt(T, A, JSON.stringify({ name: "Cody", instructions: "be brief", raftOrigin: "https://raft.example" }));
  await o.settle();
  o.puts.length = 0;
  await o.D.provisionTool(T, A, "disable_push");
  must(o.traceUnsent() > 0, "the tool call wrote no trace row");
  must(o.state.alarmAt !== null, "no alarm was armed");
  await o.settle();
  must(o.traceUnsent() === 0, `${o.traceUnsent()} trace rows not exported`);
  must(o.puts.some((k) => k.startsWith(`trace/${T}/${A}/`)), `nothing reached the trace sink: ${show(o.puts)}`);
  o.raw.dispose();
});

await check("a trace row alone, written outside a pass, arms the alarm and reaches the export", async () => {
  const o = await object();
  await adopt(o);
  o.puts.length = 0;
  appendTrace(o.raw.sql as any, [{ at: clock, tenantId: T, agentId: A, kind: "tool.call", spanId: "op_x", status: "succeeded", verdict: "ok", attrs: {} }]);
  must(o.outbox() === 0, "the setup wrote usage too");
  // Any handler that ends with it unsent; this one writes nothing of its own.
  await o.D.uiRenameMount(T, A, "web", "web2").catch(() => undefined);
  must(o.state.alarmAt !== null, "a trace row left unsent armed nothing");
  await o.settle();
  must(o.traceUnsent() === 0 && o.puts.some((k) => k.startsWith(`trace/${T}/${A}/`)), `not exported: ${show(o.puts)}`);
  o.raw.dispose();
});

await check("the pass that stands down counts its own active time and sends it", async () => {
  const o = await object();
  await adopt(o);
  o.state.alarmAt = clock;
  // A pass that is not instant: its own span is what the last pass used to leave behind.
  const slow = o.D as any;
  const owner = slow.owner.bind(slow);
  slow.owner = async () => { clock += 700; return owner(); };
  await o.settle();
  must(o.state.alarmAt === null, "the pass did not stand down");
  must(o.outbox() === 0, `${o.outbox()} rows left in the outbox`);
  const spans = o.raw.sql.exec("SELECT at, ms FROM do_activity WHERE kind = 'alarm' ORDER BY at DESC").toArray() as any[];
  const last = spans[0];
  must(last && Number(last.ms) >= 700, `the pass's span: ${show(spans)}`);
  const active = o.db.ledger("object.active").reduce((a, r) => a + r.q, 0);
  const counted = Number((o.raw.sql.exec("SELECT SUM(ms) AS ms FROM usage_active").toArray()[0] as any).ms);
  must(active >= 700 && active === counted, `active time in the ledger ${active}, counted ${counted}`);
  o.raw.dispose();
});

await check("a backlog of more than one batch drains across passes, each one sending a full batch", async () => {
  const o = await object();
  await adopt(o);
  appendUsage(o.raw.sql as any, Array.from({ length: 2_300 }, (_, i) => ({
    at: clock, tenantId: T, agentId: A, resource: "tool.call", key: `k${i}`, quantity: 1, unit: "calls",
  })));
  o.state.alarmAt = clock;
  const passes = await o.settle();
  must(o.outbox() === 0, `${o.outbox()} rows left after ${passes} passes`);
  const sent = o.db.ledger("tool.call").reduce((a, r) => a + r.q, 0);
  must(sent === 2_300, `${sent} calls in the ledger`);
  // Two batches of 500 a pass: 2,300 rows are three passes, not one, and not twenty.
  must(passes === 3, `${passes} passes`);
  o.raw.dispose();
});

await check("a lost cursor race leaves rows behind, and the object comes back for them", async () => {
  const o = await object();
  await adopt(o);
  appendUsage(o.raw.sql as any, [{ at: clock, tenantId: T, agentId: A, resource: "tool.call", key: "raced", quantity: 1, unit: "calls" }]);
  o.db.lose(2);
  o.state.alarmAt = clock;
  await o.D.alarm();
  must(o.outbox() > 0, "the rows went although every send lost");
  must(o.state.alarmAt !== null, "the object stood down with rows unsent");
  await o.settle();
  must(o.outbox() === 0 && o.db.ledger("tool.call").some((r) => r.key === "raced"), `not delivered: ${show(o.db.ledger())}`);
  o.raw.dispose();
});

await check("a send that keeps losing is retried a bounded number of times, with growing gaps, then left for the next wake", async () => {
  const o = await object();
  await adopt(o);
  appendUsage(o.raw.sql as any, [{ at: clock, tenantId: T, agentId: A, resource: "tool.call", key: "stuck", quantity: 1, unit: "calls" }]);
  o.db.lose(1_000);
  o.state.alarmAt = clock;
  const gaps: number[] = [];
  let passes = 0;
  while (o.state.alarmAt !== null && passes < 50) {
    clock = Math.max(clock, o.state.alarmAt);
    await o.D.alarm();
    passes++;
    if (o.state.alarmAt !== null) gaps.push(o.state.alarmAt - clock);
  }
  must(o.state.alarmAt === null, `still armed after ${passes} passes`);
  must(passes === USAGE_RETRY_LIMIT + 1, `${passes} passes for a limit of ${USAGE_RETRY_LIMIT}`);
  for (let i = 1; i < gaps.length; i++) must(gaps[i]! > gaps[i - 1]!, `the gaps do not grow: ${show(gaps)}`);
  must(o.outbox() > 0, "the rows were dropped");
  // The next wake tries again: the rows are kept, and so is the right to retry.
  o.db.lose(0);
  o.state.alarmAt = clock;
  await o.settle();
  must(o.outbox() === 0 && o.db.ledger("tool.call").some((r) => r.key === "stuck"), "the next wake did not send them");
  o.raw.dispose();
});

await check("an idle object with nothing to send arms nothing: not on a handler, not at the end of a pass", async () => {
  const o = await object();
  await adopt(o);
  o.state.sets = 0;
  // A handler that writes no usage.
  await o.D.uiRenameMount(T, A, "web", "web2").catch(() => undefined);
  must(o.state.alarmAt === null && o.state.sets === 0, `a handler with nothing to send armed an alarm (${o.state.sets} sets)`);
  // An alarm with nothing to do: one pass, its own time sent, and it stands down.
  o.state.alarmAt = clock;
  const passes = await o.settle();
  must(passes === 1 && o.state.alarmAt === null, `${passes} passes`);
  must(o.outbox() === 0, `${o.outbox()} rows left`);
  o.raw.dispose();
});

// One console message and one answer, counted by `--measure` on master d499204 (before this change): two
// passes on either engine, and the second, the one that stood down, left its own active time uncounted
// (18 ms on the default engine, 21 ms on pd, on this clock).
const TURN_PASSES = 2, PD_TURN_PASSES = 2;

for (const pd of [false, true]) {
  await check(`a model turn on the ${pd ? "pd" : "default"} engine leaves nothing in the outbox and takes no extra pass to do it`, async () => {
    const r = await turnPasses(pd);
    must(r.left === 0, `${r.left} rows left in the outbox after the turn: ${show(r)}`);
    must(r.tokens > 0, `no tokens in the ledger: ${show(r)}`);
    // What is left uncounted is only the tail after the final count: the final send and the alarm's own end.
    must(r.uncounted < 10, `${r.uncounted} ms of active time left uncounted`);
    must(r.passes === (pd ? PD_TURN_PASSES : TURN_PASSES), `${r.passes} passes for one turn`);
  });
}

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
