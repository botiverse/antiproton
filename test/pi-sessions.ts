/**
 * Two conversations in one object: each session's transcript is its own set
 * of tables, so a write to one cannot be read from the other, and the first
 * session keeps the tables it always had.
 */
import { piTables, MAIN_SESSION } from "../src/store/pi-storage.ts";
import { PiAgent, jobSession, sessionsWithWork } from "../src/runtime/pi-agent.ts";
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

console.log(`\n  Sessions\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
