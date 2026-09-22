/**
 * The container.lease seam (src/trace/seams.ts, src/runtime/gateway.ts): a
 * lease's end is a fact the plugin reports from its own read, and it reaches
 * the kernel by two shapes — the return of `holds.release`, and LEASE_KEY on
 * a tool result — plus a third for the failure that did not release. The
 * gateway records each and strips the key before the result reaches the
 * model.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { LEASE_KEY, markReleased, type Plugin, type Released } from "../src/plugins/types.ts";
import { pendingTrace } from "../src/trace/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const FACT: Released = { id: "box-7", startedAt: 1_700_000_000_000, endedAt: 1_700_000_090_000, status: "freed" };
const caller = { tenantId: "t", agentId: "a", taskId: "k" };

const plugin = (id: string, o: {
  release?: () => Promise<Released | boolean | void>;
  result?: unknown; throwOnInvoke?: Error;
}): Plugin => ({
  id, version: "1.0.0",
  tools: [{ name: "go", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" }],
  async invoke() { if (o.throwOnInvoke) throw o.throwOnInvoke; return o.result ?? { ok: true }; },
  ...(o.release ? { holds: { tools: { release: "go" }, release: o.release, async activity() { return { live: null }; } } } : {}),
});

async function fixture(plugins: Plugin[]) {
  const path = join(mkdtempSync(join(tmpdir(), "trace-lease-")), "store.sqlite");
  const store = new SqliteStore(path); await store.init();
  await store.createAgent("t", "a");
  for (const p of plugins) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias: p.id, plugin: p.id, installationId: `i-${p.id}`, connectionId: null,
      toolVersion: p.version, publicConfig: {}, secretRef: null, policy: null,
    });
  }
  const gw = new ToolGateway(store, plugins, new Set(plugins.map((p) => p.id)), { async resolve() { return null; } });
  const db = new DatabaseSync(path);
  const sql = { exec: (q: string, ...b: unknown[]) => {
    const st = db.prepare(q);
    const rows = st.columns().length ? st.all(...(b as any[])) : (st.run(...(b as any[])), []);
    return { toArray: () => rows };
  } } as any;
  const leases = () => pendingTrace(sql, 0).rows.filter((r) => r.kind === "container.lease");
  return { store, gw, leases };
}

function joins(row: any, fact: Released, alias: string) {
  must(row.spanId === fact.id, `span ${row.spanId} does not join box ${fact.id}`);
  must(row.at === fact.endedAt, `at ${row.at} is not the fact's endedAt`);
  must(row.ms === fact.endedAt - fact.startedAt, `ms ${row.ms} is not the fact's own ${fact.endedAt} - ${fact.startedAt}`);
  must(row.status === fact.status, `status ${row.status}`);
  must(row.attrs.mount === alias, `attrs ${JSON.stringify(row.attrs)}`);
  must(row.tenantId === "t" && row.agentId === "a", "the row lost its owner");
}

await check("the kernel's own release records the lease the plugin reported", async () => {
  const f = await fixture([plugin("held", { release: async () => FACT })]);
  const r = await f.gw.releaseTask(caller);
  must(r.released.includes("held"), "the release was not counted");
  const rows = f.leases();
  must(rows.length === 1, `one lease row, found ${rows.length}`);
  joins(rows[0], FACT, "held");
  must(rows[0]!.verdict === "ok", `verdict ${rows[0]!.verdict}`);
});

await check("a release that did not release is the most expensive lease, and is recorded as such", async () => {
  const bad: Released = { ...FACT, status: "error", error: "delete returned 500" };
  const f = await fixture([plugin("held", { release: async () => { throw markReleased(new Error("box-7 not released"), bad); } })]);
  const r = await f.gw.releaseTask(caller);
  must(r.failed.length === 1 && r.failed[0]!.alias === "held", "the failure was not reported");
  const rows = f.leases();
  must(rows.length === 1, `one lease row, found ${rows.length}`);
  joins(rows[0], bad, "held");
  must(rows[0]!.verdict === "failed" && rows[0]!.attrs.error === "delete returned 500", `verdict ${rows[0]!.verdict} attrs ${JSON.stringify(rows[0]!.attrs)}`);
});

await check("a tool that ended a lease says so under the key; the row is written and the key never reaches the model", async () => {
  const f = await fixture([plugin("svc", { result: { ok: true, note: "released", [LEASE_KEY]: FACT } })]);
  const r: any = await f.gw.invoke(caller, "svc.go", {});
  must(r.status === "succeeded", `status ${r.status}: ${JSON.stringify(r)}`);
  must(!(LEASE_KEY in r.result), `the key reached the result the model reads: ${JSON.stringify(r.result)}`);
  must(r.result.ok === true && r.result.note === "released", "stripping the key took other fields with it");
  const rows = f.leases();
  must(rows.length === 1, `one lease row, found ${rows.length}`);
  joins(rows[0], FACT, "svc");
});

await check("a result that merely has a field called lease is not a lease and is left whole", async () => {
  // The strip is by name, so the name is a sentinel; a plugin that wants the
  // model to see a field called `lease` must keep it.
  const f = await fixture([plugin("svc", { result: { ok: true, lease: { id: "mine", term: "30d" } } })]);
  const r: any = await f.gw.invoke(caller, "svc.go", {});
  must(r.result.lease?.term === "30d", `a plugin's own field was eaten: ${JSON.stringify(r.result)}`);
  must(f.leases().length === 0, "a row was written for something that is not a Released");
});

await check("something under the key that is not a Released is neither recorded nor stripped", async () => {
  const f = await fixture([plugin("svc", { result: { ok: true, [LEASE_KEY]: { id: "box-7" } } })]);
  const r: any = await f.gw.invoke(caller, "svc.go", {});
  must(LEASE_KEY in r.result, "a malformed fact was hidden instead of left visible");
  must(f.leases().length === 0, "a malformed fact was recorded");
});

await check("a tool that failed to release reports the lease on the error it throws", async () => {
  const bad: Released = { ...FACT, status: "error", error: "still running" };
  const f = await fixture([plugin("svc", { throwOnInvoke: markReleased(new Error("could not release"), bad) })]);
  const r: any = await f.gw.invoke(caller, "svc.go", {});
  must(r.status === "failed", `status ${r.status}`);
  const rows = f.leases();
  must(rows.length === 1, `one lease row, found ${rows.length}`);
  joins(rows[0], bad, "svc");
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
