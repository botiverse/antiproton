import { readFileSync } from "node:fs";
import { homedir } from "node:os";
for (const l of readFileSync(`${homedir()}/.secrets/agent-harness.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2];
}
const { PostgresStore } = await import("../src/store/postgres.ts");
const { Kernel } = await import("../src/runtime/kernel.ts");

const store = new PostgresStore({ connectionString: process.env.DB9_DSN, max: 6 });
await store.init();
const R = Math.random().toString(36).slice(2, 7);
const T = `rt-${R}`, A = `ag-${R}`, K = `tk-${R}`;
await store.createAgent(T, A);
await store.createTask(T, A, K, { log: [] });

const harness = {
  kind: "echo", stateVersion: 1,
  async initialize() { return { log: [] }; },
  async advance({ state, events }) {
    return {
      state: { log: [...state.log, ...events.map((e) => e.kind)] },
      status: "waiting",
      commands: events.filter((e) => e.kind === "message").map((e) => ({ kind: "tool.call", payload: { seq: e.sequence } })),
      waits: [],
    };
  },
};
await store.appendEvent({ tenantId: T, agentId: A, taskId: K, kind: "message", payload: { text: "go" } });

const seen = [];
store.onQuery = (sql, ms) => { const q = { sql: sql.replace(/\s+/g, " ").trim().slice(0, 62), ms }; seen.push(q); if (process.env.TRACE) console.log(`      · ${Math.round(ms)}ms ${q.sql}`); };
const kernel = new Kernel(store, harness, { holder: "w1", leaseTtlMs: 60_000 });
const t0 = performance.now();
await kernel.step(T, K, null, async () => {});
const total = performance.now() - t0;

const groups = new Map();
for (const q of seen) {
  const key = q.sql.split(" ").slice(0, 3).join(" ");
  const g = groups.get(key) ?? { n: 0, ms: 0, sample: q.sql };
  g.n++; g.ms += q.ms; groups.set(key, g);
}
console.log(`\n  one kernel.step against db9: ${seen.length} round trips, ${Math.round(total)} ms total\n`);
console.log("  n    ms     statement");
console.log("  " + "─".repeat(74));
for (const [, g] of [...groups.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
  console.log(`  ${String(g.n).padEnd(4)} ${String(Math.round(g.ms)).padStart(5)}  ${g.sample}`);
}
console.log("  " + "─".repeat(74));
console.log(`  BEGIN/COMMIT/ROLLBACK overhead: ${seen.filter(q => /^(BEGIN|COMMIT|ROLLBACK)/.test(q.sql)).length} of ${seen.length} round trips\n`);
await store.close();
