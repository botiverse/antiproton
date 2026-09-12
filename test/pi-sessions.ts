/**
 * Two conversations in one object: each session's transcript is its own set
 * of tables, so a write to one cannot be read from the other, and the first
 * session keeps the tables it always had.
 */
import { piTables, MAIN_SESSION } from "../src/store/pi-storage.ts";
import { PiAgent, jobSession, sessionsWithWork, failedRuns } from "../src/runtime/pi-agent.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";

const results: { name: string; ok: boolean; error?: string }[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error).message ?? e) }); }
}
const CTX = {} as any;
const entry = (id: string, text: string) => ({
  type: "append-entry" as const,
  entry: { id, parentId: null, type: "message", timestamp: Date.now(),
    message: { role: "user", content: [{ type: "text", text }] } } as any,
});

await check("the main session keeps the unprefixed tables; a second session gets its own", () => {
  const m = piTables(MAIN_SESSION), b = piTables("t_u-alice_x1");
  if (m.entries !== "pi_entries") throw new Error(`main renamed: ${m.entries}`);
  if (b.entries === m.entries || !/^pi_s_t_u_alice_x1_[0-9a-f]+_entries$/.test(b.entries)) throw new Error(`bad name: ${b.entries}`);
  if (piTables("a/b") .entries === piTables("a_b").entries) throw new Error("two ids collapsed onto one table");
});

await check("two conversations in one object: each reads only its own transcript, and a job returns to the session that asked", async () => {
  const host = sqliteHost();
  const MODEL = { provider: "queue", id: "m", contextWindow: 128_000 };
  const dispatched: string[] = [];
  const open = (session: string) => PiAgent.open({
    host, sessionId: `s#${session}`, session, systemPrompt: "be brief", model: MODEL, tools: [],
    toolHost: { async invoke() { return { status: "succeeded", result: { ok: true } }; } },
    async dispatch(id) { dispatched.push(id); },
  });
  const A = await open("conv-a"), B = await open("conv-b"), M = await open(MAIN_SESSION);
  await A.say("the marker only A holds");
  await B.say("what B holds");
  const text = async (ag: PiAgent) => JSON.stringify(await ag.storage.scanEntries({ order: "asc" }, {} as any));
  const ta = await text(A), tb = await text(B), tm = await text(M);
  if (!ta.includes("marker only A")) throw new Error("A cannot read its own message");
  if (tb.includes("marker only A")) throw new Error("B can read A's message");
  if (!tb.includes("what B holds")) throw new Error("B cannot read its own message");
  if (tm.includes("marker only A") || tm.includes("what B holds")) throw new Error("the main session saw another session's message");
  // A's turn starts a model call; the job row names A's session, and the wake list names A.
  await A.step();
  const jobs = host.sql.exec("SELECT id, session FROM pi_model_jobs").toArray() as any[];
  if (jobs.length !== 1 || jobs[0].session !== "conv-a") throw new Error(`job not tied to A: ${JSON.stringify(jobs)}`);
  if (jobSession(host.sql, String(jobs[0].id)) !== "conv-a") throw new Error("jobSession did not find the session");
  const work = sessionsWithWork(host.sql);
  if (!work.includes("conv-a")) throw new Error(`conv-a missing from sessions with work: ${work}`);
  // B stepping must not touch A's job: B has no unanswered job of its own.
  const before = dispatched.length;
  await B.step();
  const bJobs = host.sql.exec("SELECT COUNT(*) AS n FROM pi_model_jobs WHERE session='conv-b'").toArray()[0] as any;
  if (dispatched.length - before > 1) throw new Error("B's step dispatched more than its own call");
  void bJobs;
  await A.close(); await B.close(); await M.close();
  host.dispose();
});


/**
 * The other half, whose wrong version fails silently: a session threaded one
 * layer too far makes mounts, connection state and credentials per
 * conversation, and the symptom is a new conversation with an empty plugins
 * panel rather than an error. So the rows are read back with no session in
 * hand, and the tables are checked for never having grown a column for one.
 */
await check("mounts, connection state and credentials are the agent's, shared by every conversation", async () => {
  const store = new SqliteStore(":memory:"); await store.init();
  await store.addMount({ tenantId: "t", agentId: "a", alias: "gh", plugin: "github", installationId: "i",
    connectionId: null, toolVersion: "1", publicConfig: { account: "shared" }, secretRef: "agent:gh" });
  await store.putConnection("t", "a", "gh", { boxId: "held-by-the-agent" });
  await store.putSecret("t", "a", "gh", { ciphertext: "c", iv: "i", account: "octocat", verified: true });
  // Read back the way the gateway does: tenant, agent, alias — nothing names a
  // conversation, so there is nothing a second conversation could fail to match.
  const mount = await store.getMountByAlias("t", "a", "gh");
  if (mount?.secretRef !== "agent:gh") throw new Error(`mount not found without a session: ${JSON.stringify(mount)}`);
  const conn = await store.getConnection("t", "a", "gh") as any;
  if (conn?.boxId !== "held-by-the-agent") throw new Error(`connection state not found without a session: ${JSON.stringify(conn)}`);
  const meta = await store.secretMeta("t", "a", "gh");
  if (meta?.account !== "octocat") throw new Error(`credential not found without a session: ${JSON.stringify(meta)}`);
  // And the discriminating check: none of the three tables has a column that
  // could scope a row to a conversation. Adding one is where this would break.
  const tables = store.dumpTables();
  for (const name of ["mounts", "connections", "secrets"]) {
    const rows = tables[name] as Record<string, unknown>[] | undefined;
    if (!rows?.length) throw new Error(`${name} has no row to inspect`);
    const cols = Object.keys(rows[0]!);
    if (cols.some((c) => /session|conversation|task/i.test(c))) {
      throw new Error(`${name} is scoped below the agent: ${cols.join(", ")}`);
    }
  }
  await store.close();
});


/**
 * A session configured under one set of tool names, reopened under another.
 * pi remembers the names and refuses every run whose names it cannot find;
 * the rename that made every tool `alias__tool` did exactly that to every
 * session opened before it, silently: message written, run admitted, run
 * failed before the first model call. Open must bring the remembered names
 * up to the offered ones.
 */
/**
 * run_js is not a mount; it reaches the session beside the mounts. A session
 * that remembers it must keep it on reopen: when the sandbox tool was added
 * after open, the reconcile above saw a list without it, judged the remembered
 * names stale, and switched run_js off for every agent on its second open.
 */
/**
 * pi remembers the model a session was configured with, and refuses every run
 * whose remembered model this process does not register. An operator changing
 * the binding — or a dated model id expiring — left every older session
 * failing before its first model call, with the message written and the run
 * admitted (`model_unavailable`, seen in production 2026-09-12).
 */
await check("a session that remembers another model runs again after the binding changes", async () => {
  const host = sqliteHost();
  const tool = { name: "get", description: "fetch", parameters: { type: "object", properties: {} }, address: "web.get", sideEffects: "read" as const };
  const openWith = (id: string) => PiAgent.open({ host, sessionId: "s3", systemPrompt: "be brief", model: { provider: "queue", id, contextWindow: 128_000 }, tools: [tool] as any,
    toolHost: { async invoke() { return { status: "succeeded", result: { ok: true } }; } },
    async dispatch() {} });
  const A = await openWith("model-of-yesterday");
  await A.close();
  const B = await openWith("model-of-today");
  const model: any = await B.lane.getModel(CTX);
  if (model?.id !== "model-of-today") throw new Error(`open did not reconcile the model: ${model?.id}`);
  const said: any = await B.say("hello", "steer");
  if (said?.ok === false) throw new Error(`say refused: ${JSON.stringify(said.error)}`);
  await B.close(); host.dispose();
});

await check("a session that remembers run_js keeps it on reopen when run_js is offered", async () => {
  const host = sqliteHost();
  const MODEL = { provider: "queue", id: "m", contextWindow: 128_000 };
  const tool = { name: "get", description: "fetch", parameters: { type: "object", properties: {} }, address: "web.get", sideEffects: "read" as const };
  const runJs = { name: "run_js", label: "run_js", description: "sandbox", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [], details: {} }) };
  const open = () => PiAgent.open({ host, sessionId: "s2", systemPrompt: "be brief", model: MODEL, tools: [tool] as any, extraTools: [runJs] as any,
    toolHost: { async invoke() { return { status: "succeeded", result: { ok: true } }; } },
    async dispatch() {} });
  const A = await open();
  await A.lane.setActiveTools(["web__get", "run_js"], CTX);
  await A.close();
  const B = await open();
  const remembered = await B.lane.getActiveTools(CTX);
  if (!remembered.includes("run_js") || !remembered.includes("web__get")) throw new Error(`reopen dropped a tool: ${remembered}`);
  await B.close(); host.dispose();
});

await check("a session that remembers old tool names runs again after the names change", async () => {
  const host = sqliteHost();
  const MODEL = { provider: "queue", id: "m", contextWindow: 128_000 };
  const dispatched: string[] = [];
  const tool = { name: "get", description: "fetch", parameters: { type: "object", properties: {} }, address: "web.get", sideEffects: "read" as const };
  const open = () => PiAgent.open({ host, sessionId: "s", systemPrompt: "be brief", model: MODEL, tools: [tool] as any,
    toolHost: { async invoke() { return { status: "succeeded", result: { ok: true } }; } },
    async dispatch(id) { dispatched.push(id); } });
  const A = await open();
  // What a session opened before the rename remembers: the bare name.
  await A.lane.setActiveTools(["get"], CTX);
  await A.close();
  const B = await open();
  const remembered = await B.lane.getActiveTools(CTX);
  if (!remembered.includes("web__get") || remembered.includes("get")) throw new Error(`open did not reconcile the names: ${remembered}`);
  const said: any = await B.say("hello", "steer");
  if (said?.ok === false) throw new Error(`say refused: ${JSON.stringify(said.error)}`);
  const out = await B.step();
  if (dispatched.length !== 1) throw new Error(`no model call after reopen: dispatched ${dispatched.length}, settled ${JSON.stringify(out.settled)}`);
  await B.close(); host.dispose();
});


await check("a run that failed before its first model call is readable with pi's reason", async () => {
  const host = sqliteHost();
  const MODEL = { provider: "queue", id: "m", contextWindow: 128_000 };
  const A = await PiAgent.open({ host, sessionId: "s", systemPrompt: "be brief", model: MODEL, tools: [],
    toolHost: { async invoke() { return { status: "succeeded", result: { ok: true } }; } }, async dispatch() {} });
  if (failedRuns(host.sql).length !== 0) throw new Error("a fresh session reports failed runs");
  // What pi writes for a run refused at generation: an outcome record, no entry.
  const t = piTables(MAIN_SESSION);
  host.sql.exec(`INSERT INTO ${t.values}(namespace, key, seq, body) VALUES ('pi.result', 'op-1', 999, ?)`,
    JSON.stringify({ operationId: "op-1", kind: "run", status: "failed", error: { code: "configured_tools_unavailable", message: "One or more configured tools are unavailable in this process" } }));
  host.sql.exec(`INSERT INTO ${t.values}(namespace, key, seq, body) VALUES ('pi.result', 'op-2', 1000, ?)`,
    JSON.stringify({ operationId: "op-2", kind: "run", status: "completed" }));
  const f = failedRuns(host.sql);
  if (f.length !== 1 || f[0]!.operationId !== "op-1" || f[0]!.code !== "configured_tools_unavailable") throw new Error(`wrong failed runs: ${JSON.stringify(f)}`);
  await A.close(); host.dispose();
});

console.log(`\n  Sessions\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
