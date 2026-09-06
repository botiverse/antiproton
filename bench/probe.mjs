import { readFileSync } from "node:fs";
import { homedir } from "node:os";
for (const l of readFileSync(`${homedir()}/.secrets/agent-harness.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2];
}
const step = async (label, fn) => { const t = performance.now(); const r = await fn(); console.log(`  ${label}: ${Math.round(performance.now()-t)}ms`); return r; };
const { PostgresStore } = await import("../src/store/postgres.ts");
const store = new PostgresStore({ connectionString: process.env.DB9_DSN, max: 6 });
await step("init", () => store.init());
const R = Math.random().toString(36).slice(2, 7);
const T = `p-${R}`, A = `a-${R}`, K = `k-${R}`;
await step("createAgent", () => store.createAgent(T, A));
await step("createTask", () => store.createTask(T, A, K, {}));
await step("appendEvent", () => store.appendEvent({ tenantId: T, agentId: A, taskId: K, kind: "message", payload: {} }));
store.onQuery = (sql, ms) => console.log(`      · ${Math.round(ms)}ms ${sql.replace(/\s+/g," ").slice(0,60)}`);
await step("acquireLease (hooked)", () => store.acquireLease(T, K, "w1", 60000));
await store.close();
console.log("done");
