/**
 * What the OpenAI-compatible agents API remembers (task #17) in objects: agents and sessions indexed in the owner's object that
 * disappear from the API when deleted, ids that are valid object names, and the
 * store's new way to update an agent's config.
 */
import {
  apiAgentIds, deleteApiAgent, deleteApiSession, getApiAgent, getApiSession, listApiAgents, listApiSessions,
  mintAgentId, mintSessionId, putApiAgent, putApiSession, touchApiSession,
} from "../cf/src/agents-api/store.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
const now = 1_800_000_000_000;
const agentCfg = (name: string) => ({ name, instructions: null, model: "m", metadata: {}, tools: [], createdAt: now, updatedAt: now });

await check("ids are valid object names, distinct, and refuse an owner too long to extend", async () => {
  const a = mintAgentId("u-automation_mu02ye2p", now); const b = mintAgentId("u-automation_mu02ye2p", now);
  assert(a !== b && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a), `agent ids: ${a} ${b}`);
  assert(/^sess_[0-9a-f]{24}$/.test(mintSessionId()) && mintSessionId() !== mintSessionId(), "session ids");
  let threw = false; try { mintAgentId("x".repeat(60), now); } catch { threw = true; }
  assert(threw, "an id longer than an object name allows was minted");
});

await check("agents: put, update in place, list oldest first, and a deleted agent is gone from the API", async () => {
  const host = sqliteHost(); const sql = host.sql as any;
  try {
    putApiAgent(sql, "a1", agentCfg("one"));
    putApiAgent(sql, "a2", { ...agentCfg("two"), createdAt: now + 1, updatedAt: now + 1 });
    putApiAgent(sql, "a1", { ...agentCfg("one-renamed"), updatedAt: now + 9 });
    assert(getApiAgent(sql, "a1")?.name === "one-renamed", "an update did not replace the config");
    assert(listApiAgents(sql).map((x) => x.id).join() === "a1,a2", `list: ${listApiAgents(sql).map((x) => x.id)}`);
    assert(deleteApiAgent(sql, "a1", now + 10) === true && deleteApiAgent(sql, "a1", now + 11) === false, "delete result");
    assert(getApiAgent(sql, "a1") === null, "a deleted agent is still retrievable");
    assert(listApiAgents(sql).map((x) => x.id).join() === "a2", "a deleted agent is still listed");
  } finally { host.dispose(); }
});

await check("the console hides the agents the API deleted and marks the ones it made, and nothing else", async () => {
  const host = sqliteHost(); const sql = host.sql as any;
  try {
    const empty = apiAgentIds(sql);
    assert(empty.live.size === 0 && empty.deleted.size === 0, "an empty index reported agents");
    putApiAgent(sql, "a1", agentCfg("one"));
    putApiAgent(sql, "a2", agentCfg("two"));
    deleteApiAgent(sql, "a1", now + 10);
    const ids = apiAgentIds(sql);
    assert([...ids.deleted].join() === "a1" && [...ids.live].join() === "a2", `live ${[...ids.live]}, deleted ${[...ids.deleted]}`);
  } finally { host.dispose(); }
});

await check("only the API's index route writes api_agents, so being in it means the API made the agent", async () => {
  // The console's "API" mark reads that table (apiAgentIds). A second writer, such as the console's own
  // create route, would mark agents the API never made; this fails first, and the mark then needs a field.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../cf/src/index.ts", import.meta.url), "utf8");
  const calls = [...src.matchAll(/putApiAgent\(/g)].length;
  const inRoute = /async apiPutAgent\([^)]*\)\s*\{[^\n]*putApiAgent\(/.test(src);
  assert(calls === 1 && inRoute, `putApiAgent is called ${calls} times in cf/src/index.ts; inside apiPutAgent: ${inRoute}`);
});

await check("sessions: filtered by agent, touched, and a deleted session is gone from the API", async () => {
  const host = sqliteHost(); const sql = host.sql as any;
  try {
    const s = (id: string, agentId: string, at: number) => ({ id, agentId, environment: "container" as const, metadata: { k: id }, createdAt: at, lastActiveAt: at });
    putApiSession(sql, s("s1", "a1", now)); putApiSession(sql, s("s2", "a2", now + 1)); putApiSession(sql, s("s3", "a1", now + 2));
    assert(listApiSessions(sql, "a1").map((x) => x.id).join() === "s1,s3", "filter by agent");
    assert(listApiSessions(sql).length === 3, "unfiltered list");
    touchApiSession(sql, "s1", now + 50);
    assert(getApiSession(sql, "s1")?.lastActiveAt === now + 50 && getApiSession(sql, "s1")?.metadata.k === "s1", "touch or metadata lost");
    assert(deleteApiSession(sql, "s1", now + 60) === true, "delete result");
    assert(getApiSession(sql, "s1") === null && listApiSessions(sql, "a1").map((x) => x.id).join() === "s3", "a deleted session is still visible");
  } finally { host.dispose(); }
});

await check("the store can replace an agent's config, and says so only when the agent exists", async () => {
  const store = new SqliteStore(":memory:"); await store.init();
  await store.createAgent("t", "a", { name: "old" });
  assert(await store.updateAgentConfig("t", "a", { name: "new", description: "Write clean code." }) === true, "update of an existing agent reported false");
  const back = await store.loadAgent("t", "a");
  assert((back?.config as any)?.name === "new" && (back?.config as any)?.description === "Write clean code.", `config after update: ${JSON.stringify(back)}`);
  assert(await store.updateAgentConfig("t", "missing", { name: "x" }) === false, "an update of a missing agent reported success");
  assert(await store.updateAgentConfig("other-tenant", "a", { name: "x" }) === false, "another tenant updated this agent");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
