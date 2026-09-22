/**
 * The idempotency guard asks whether an earlier attempt under the same key
 * ever BEGAN, not whether a row exists. A call the policy refused never ran,
 * so its key is free; a call that began — still in flight, or ended after
 * running — is refused, and the refusal says which of the two it knows.
 * Both backends, because the Durable Object is the one production runs on.
 */
import { createHash } from "node:crypto";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const caller = { tenantId: "t", agentId: "a", taskId: "k" };
const KEY = "k-1";
const opId = `op_${createHash("sha256").update(`${caller.tenantId}|${caller.taskId}|${KEY}`).digest("hex").slice(0, 20)}`;

const BACKENDS = {
  sqlite: async () => { const s = new SqliteStore(":memory:"); await s.init(); return s as any; },
  "durable-object": async () => {
    const host = sqliteHost();
    const s = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
    await s.init(); return s as any;
  },
} as const;

/** A write tool whose invoke can be held open by the test. */
function fixture(store: any) {
  const calls: number[] = [];
  let blocked: Promise<void> | null = null;
  const plugin: Plugin = {
    id: "svc", version: "1.0.0",
    tools: [{ name: "go", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" }],
    async invoke() {
      calls.push(Date.now());
      if (blocked) await blocked;
      return { ok: true };
    },
  };
  const gw = new ToolGateway(store, [plugin], new Set(["svc"]), { async resolve() { return null; } });
  /** Holds the next invoke open until the returned function is called. */
  const hold = () => {
    let release!: () => void;
    blocked = new Promise<void>((r) => { release = () => { blocked = null; r(); }; });
    return release;
  };
  return { gw, calls, hold };
}

async function mount(store: any, policy: unknown) {
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy,
  });
}

for (const backend of Object.keys(BACKENDS) as Array<keyof typeof BACKENDS>) {
  await check(`a write the policy refused does not hold its key: the retry runs (${backend})`, async () => {
    const store = await BACKENDS[backend]();
    await mount(store, { tools: { go: "deny" } });
    const { gw, calls } = fixture(store);
    const first: any = await gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    must(first.status === "rejected" && first.error?.code === "policy_denied", `first call: ${JSON.stringify(first)}`);
    await store.updateMountPolicy("t", "a", "svc", null);
    const retry: any = await gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    must(retry.status === "succeeded", `the retry was not run: ${JSON.stringify(retry)}`);
    must(calls.length === 1, `the plugin ran ${calls.length} times`);
    const row = await store.getOperation("t", opId);
    must(row?.status === "succeeded", `the record says ${row?.status}`);
  });

  await check(`a write that began is refused while in flight, and told it may have landed (${backend})`, async () => {
    const store = await BACKENDS[backend]();
    await mount(store, null);
    const { gw, calls, hold } = fixture(store);
    const release = hold();
    const inFlight = gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    await new Promise((r) => setTimeout(r, 5));
    must((await store.getOperation("t", opId))?.status === "running", "the start was not recorded before the plugin ran");
    const again: any = await gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    must(again.error?.code === "already_attempted", `a repeat of an in-flight write was allowed: ${JSON.stringify(again)}`);
    must(/it ran and may have landed/.test(again.error.message), `wrong sentence: ${again.error.message}`);
    release(); await inFlight;
    must(calls.length === 1, `the plugin ran ${calls.length} times`);
  });

  await check(`a refused key, then an allowed retry in flight, then a third call: the third is refused (${backend})`, async () => {
    const store = await BACKENDS[backend]();
    await mount(store, { tools: { go: "deny" } });
    const { gw, calls, hold } = fixture(store);
    const first: any = await gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    must(first.status === "rejected", "the first call was not refused");
    await store.updateMountPolicy("t", "a", "svc", null);
    const release = hold();
    const second = gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    await new Promise((r) => setTimeout(r, 5));
    // Asked before anything is released: a third call the guard lets through
    // reaches the plugin and waits on the same hold, so awaiting it first would
    // turn the defect into a hang instead of a red.
    const third = gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    await new Promise((r) => setTimeout(r, 5));
    must(calls.length === 1, `the key was free twice: the third call reached the plugin (${calls.length} runs)`);
    release(); await second;
    const r3: any = await third;
    must(r3.error?.code === "already_attempted", `the key was free twice: ${JSON.stringify(r3)}`);
    must(calls.length === 1, `the plugin ran ${calls.length} times`);
  });

  await check(`a row that never reached the start mark is refused, and not told it landed (${backend})`, async () => {
    const store = await BACKENDS[backend]();
    await mount(store, null);
    const { gw, calls } = fixture(store);
    // A row an older version wrote, or a crash between the record and the start.
    await store.recordOperation({ operationId: opId, tenantId: "t", agentId: "a", taskId: "k", mountAlias: "svc", tool: "svc.go", toolVersion: "1.0.0" });
    const r: any = await gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    must(r.error?.code === "already_attempted", `a pending row was treated as free: ${JSON.stringify(r)}`);
    must(/whether it began cannot be told/.test(r.error.message), `wrong sentence: ${r.error.message}`);
    must(!/may have landed/.test(r.error.message), "a row that cannot say it began was told it may have landed");
    must(calls.length === 0, "the plugin ran");
  });
  await check(`a cancelled row cannot be told to have begun; an unknown one began and is told so (${backend})`, async () => {
    // `cancelled` is what a human's denial of an approval writes (the plugin
    // was never called) and also what stopping a background job writes (it
    // ran); the sentence must not claim the first may have landed. `unknown`
    // is written only after the plugin threw, so it began.
    const store = await BACKENDS[backend]();
    await mount(store, null);
    const { gw, calls } = fixture(store);
    const op = { operationId: opId, tenantId: "t", agentId: "a", taskId: "k", mountAlias: "svc", tool: "svc.go", toolVersion: "1.0.0" };
    await store.recordOperation(op);
    await store.completeOperation("t", opId, "cancelled", null);
    const c: any = await gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    must(c.error?.code === "already_attempted" && /cannot be told/.test(c.error.message) && !/may have landed/.test(c.error.message),
      `a cancelled row: ${JSON.stringify(c.error)}`);
    await store.completeOperation("t", opId, "unknown", null);
    const u: any = await gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    must(u.error?.code === "already_attempted" && /it ran and may have landed/.test(u.error.message),
      `an unknown row: ${JSON.stringify(u.error)}`);
    must(calls.length === 0, "the plugin ran");
  });

  await check(`two calls racing for one key: one takes it, the other is refused (${backend})`, async () => {
    // The guard reads the row and the start mark writes it; between the two a
    // second caller under the same key reads what the first has not yet
    // written. What decides is the store's condition, and only because the
    // answer is read: a marker records that someone began, a claim decides who.
    const store = await BACKENDS[backend]();
    await mount(store, null);
    const { gw, calls } = fixture(store);
    const rs: any[] = await Promise.all([
      gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY }),
      gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY }),
    ]);
    must(calls.length === 1, `the key was taken twice: the plugin ran ${calls.length} times`);
    must(rs.filter((r) => r.status === "succeeded").length === 1, `expected one run: ${JSON.stringify(rs)}`);
    const refused = rs.filter((r) => r.error?.code === "already_attempted");
    must(refused.length === 1, `expected one refusal: ${JSON.stringify(rs)}`);
    // The loser is told by the row, which reads `running` or the end it reached:
    // either way that row began, so it is not told the attempt is undetermined.
    must(/it ran and may have landed/.test(refused[0].error.message), `wrong sentence: ${refused[0].error.message}`);
  });

  await check(`a refused key, then two retries racing: one takes it, the other is refused (${backend})`, async () => {
    // The same window, one row-value along: a refusal leaves `rejected`, which
    // the guard lets through, so both retries pass the guard and the claim is
    // what separates them.
    const store = await BACKENDS[backend]();
    await mount(store, { tools: { go: "deny" } });
    const { gw, calls } = fixture(store);
    const first: any = await gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY });
    must(first.status === "rejected", `the first call was not refused: ${JSON.stringify(first)}`);
    await store.updateMountPolicy("t", "a", "svc", null);
    const rs: any[] = await Promise.all([
      gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY }),
      gw.invoke(caller, "svc.go", {}, { idempotencyKey: KEY }),
    ]);
    must(calls.length === 1, `the key was taken twice: the plugin ran ${calls.length} times`);
    must(rs.filter((r) => r.status === "succeeded").length === 1, `expected one run: ${JSON.stringify(rs)}`);
    must(rs.filter((r) => r.error?.code === "already_attempted").length === 1, `expected one refusal: ${JSON.stringify(rs)}`);
  });
}

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
