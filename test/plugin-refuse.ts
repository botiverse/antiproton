/**
 * `Plugin.refuse` (botiverse/antiproton#1092): a call the plugin will never run is answered before the policy is
 * asked, so no approval card is made for it — a card a person approves only to see the call fail spends a human click
 * on nothing. Asserted on outcomes: the result, the operation row, the approval rows, and whether the plugin's
 * `invoke` was reached; over a default mount that holds every call, a mount that allows everything, `confirm`, an
 * approved replay of a card held before the hook refused it, a hook that throws, and a plugin without the hook.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { REFUSE_FAILED, REFUSE_REASON_BYTES, REFUSE_TOO_LONG, refusalOf } from "../src/plugins/types.ts";
import type { Plugin } from "../src/plugins/types.ts";
import type { MountPolicy } from "../src/core/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const caller = { tenantId: "t", agentId: "a", taskId: "k" };
const NO_MERGE = "api may not merge: call pr_merge";

/**
 * One generic `api` tool held for a person by default, whose calls to `merge` the plugin refuses, and a bridge whose
 * table refuses the same thing, so the two refusals can be laid side by side. `refuse` is swappable per fixture.
 */
function fixture(refuse: Plugin["refuse"] | null = (tool, args) =>
  tool === "api" && (args as { path?: string })?.path === "merge" ? NO_MERGE : undefined) {
  const ran: unknown[] = [];
  const asked: unknown[] = [];
  const plugin: Plugin = {
    id: "svc", version: "1.0.0",
    tools: [{ name: "api", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" }],
    defaultPolicy: { tools: { api: "approval" } },
    ...(refuse ? { refuse(tool: string, args: any) { asked.push(args); return refuse.call(this, tool, args); } } : {}),
    bridge: {
      box: { files: { "index.js": "export default (f) => ({ svc: f });" }, entry: "index.js", exports: ["svc"] },
      routes: [{ methods: ["POST"], path: /^\/v1\/merge$/, refuse: NO_MERGE }],
      unlistedWriteKey: "svc.write",
      async send() { ran.push("bridge"); return { status: 200, headers: {}, text: "{}" }; },
    },
    async invoke(_tool, args) { ran.push(args); return { ok: true }; },
  };
  return { plugin, ran, asked };
}

async function gatewayWith(policy: MountPolicy | null, plugin: Plugin) {
  const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), "plugin-refuse-")), "s.sqlite"));
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy,
  });
  return { gw: new ToolGateway(store, [plugin], new Set(["svc"]), { async resolve() { return null; } }), store };
}

const OPEN: MountPolicy = { read: "allow", write: "allow", tools: { api: "allow", "svc.write": "allow" } };
/** Every approval row in any state: a refused call must leave none, pending or decided. */
const allApprovals = (store: SqliteStore) => store.listApprovals("t");

await check("refusalOf: no hook and undefined let the call through; a reason is the reason; a throw or a non-reason refuses", async () => {
  must(refusalOf({}, "api", {}) === null, "no hook");
  must(refusalOf({ refuse: () => undefined }, "api", {}) === null, "undefined");
  must(refusalOf({ refuse: () => "no" }, "api", {}) === "no", "a reason");
  must(refusalOf({ refuse: () => { throw new Error("boom"); } }, "api", {}) === REFUSE_FAILED, "a throw");
  for (const odd of ["", null, 0, false, {}, ["x"]]) {
    must(refusalOf({ refuse: () => odd as any }, "api", {}) === REFUSE_FAILED, `answered ${JSON.stringify(odd)}`);
  }
});

await check("on a default mount a refused call is rejected as route_refused: no approval row, no card, nothing run", async () => {
  const f = fixture();
  const { gw, store } = await gatewayWith(null, f.plugin);
  const r: any = await gw.invoke(caller, "svc.api", { path: "merge" });
  must(r.status === "rejected" && r.error?.code === "route_refused" && r.error.message === NO_MERGE, `not refused: ${JSON.stringify(r)}`);
  must((await allApprovals(store)).length === 0, "an approval row was made for a refused call");
  must(f.ran.length === 0, "the plugin ran a refused call");
  // The call the hook does not refuse is held as before: the hook answers only what it refuses.
  const held: any = await gw.invoke(caller, "svc.api", { path: "comment" });
  must(held.status === "pending" && f.ran.length === 0 && (await store.listApprovals("t", "pending")).length === 1, `not held: ${JSON.stringify(held)}`);
});

await check("a reason of exactly 300 bytes (String.length) passes unchanged", async () => {
  must(REFUSE_REASON_BYTES === 300, `the bound is ${REFUSE_REASON_BYTES}`);
  const exact = "a".repeat(300);
  must(refusalOf({ refuse: () => exact }, "api", {}) === exact, "a reason of exactly 300 bytes was not passed unchanged");
});

await check("a reason of 301 bytes is replaced by the fixed message and still refused, through the gateway too", async () => {
  const over = "a".repeat(301);
  must(refusalOf({ refuse: () => over }, "api", {}) === REFUSE_TOO_LONG, "a reason of 301 bytes was not replaced");
  const f = fixture(() => over);
  const { gw, store } = await gatewayWith(null, f.plugin);
  const r: any = await gw.invoke(caller, "svc.api", { path: "comment" });
  must(r.status === "rejected" && r.error?.code === "route_refused" && r.error.message === REFUSE_TOO_LONG, `an over-long reason: ${JSON.stringify(r).slice(0, 200)}`);
  must(f.ran.length === 0 && (await allApprovals(store)).length === 0, "it ran, or a card was made");
});

await check("an over-long reason ending in a non-BMP character (301 bytes) gives the fixed message, with no lone surrogate", async () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const over = "a".repeat(299) + "\u{1F600}";
  must(over.length === 301, `the fixture is ${over.length} bytes, not 301`);
  const got = refusalOf({ refuse: () => over }, "api", {})!;
  must(got === REFUSE_TOO_LONG, `not the fixed message: ${JSON.stringify(got.slice(-4))}`);
  must(!lone.test(got), `a lone surrogate: ${JSON.stringify(got.slice(-4))}`);
});

await check("refusal comes before deny: a mount that denies the tool still hears route_refused, with the plugin's reason", async () => {
  const f = fixture();
  const { gw, store } = await gatewayWith({ tools: { api: "deny" } }, f.plugin);
  const r: any = await gw.invoke(caller, "svc.api", { path: "merge" });
  must(r.status === "rejected" && r.error?.code === "route_refused" && r.error.message === NO_MERGE, `deny answered first: ${JSON.stringify(r)}`);
  // The control: a call the hook does not refuse is denied as before.
  const d: any = await gw.invoke(caller, "svc.api", { path: "comment" });
  must(d.status === "rejected" && d.error?.code === "policy_denied", `not denied: ${JSON.stringify(d)}`);
  must(f.ran.length === 0 && (await allApprovals(store)).length === 0, "it ran, or a card was made");
});

await check("refused where the mount allows everything, and where the agent asks to confirm", async () => {
  const f = fixture();
  const { gw, store } = await gatewayWith(OPEN, f.plugin);
  const r: any = await gw.invoke(caller, "svc.api", { path: "merge" });
  must(r.status === "rejected" && r.error?.code === "route_refused", `allowed mount ran it: ${JSON.stringify(r)}`);
  const c: any = await gw.invoke(caller, "svc.api", { path: "merge" }, { confirm: true });
  must(c.status === "rejected" && c.error?.code === "route_refused", `confirm held it: ${JSON.stringify(c)}`);
  must(f.ran.length === 0 && (await allApprovals(store)).length === 0, "it ran, or a card was made");
});

await check("an approved replay is refused too: a card held before the hook refused the call does not run it", async () => {
  // Held while the plugin did not yet refuse it, as a card from an earlier version would have been.
  let refusing = false;
  const f = fixture((tool, args) => refusing && tool === "api" && (args as any)?.path === "merge" ? NO_MERGE : undefined);
  const { gw, store } = await gatewayWith(null, f.plugin);
  const r: any = await gw.invoke(caller, "svc.api", { path: "merge" });
  must(r.status === "pending", `not held: ${JSON.stringify(r)}`);
  refusing = true;
  const done: any = await gw.applyApproval("t", r.operationId, "approved", "owner");
  must(done.ok && done.result?.status === "rejected" && done.result.error?.code === "route_refused" && done.result.error.message === NO_MERGE,
    `the replay was not refused: ${JSON.stringify(done)}`);
  must(f.ran.length === 0, "the replay ran");
  must((await store.getOperation("t", r.operationId))?.status === "rejected", "the operation does not read rejected");
});

await check("a refuse that throws fails closed: refused with the fixed message, never run, no card, on any mount", async () => {
  for (const policy of [null, OPEN]) {
    const f = fixture(() => { throw new Error("the hook could not decide"); });
    const { gw, store } = await gatewayWith(policy, f.plugin);
    const r: any = await gw.invoke(caller, "svc.api", { path: "comment" });
    must(r.status === "rejected" && r.error?.code === "route_refused" && r.error.message === REFUSE_FAILED,
      `${JSON.stringify(policy)}: a throwing hook did not refuse: ${JSON.stringify(r)}`);
    must(f.ran.length === 0 && (await allApprovals(store)).length === 0, "it ran, or a card was made");
  }
});

await check("a plugin without refuse is unchanged: held on a default mount, run where allowed, replayed once approved", async () => {
  const f = fixture(null);
  must(!("refuse" in f.plugin), "the fixture has a refuse");
  const { gw, store } = await gatewayWith(null, f.plugin);
  const r: any = await gw.invoke(caller, "svc.api", { path: "merge" });
  const before = f.ran.length;
  must(r.status === "pending" && r.error?.code === "awaiting_approval" && before === 0, `not held: ${JSON.stringify(r)}`);
  const done: any = await gw.applyApproval("t", r.operationId, "approved", "owner");
  must(done.result?.status === "succeeded" && f.ran.length === 1, `the replay did not run once: ${JSON.stringify(done)}`);
  must((await store.listApprovals("t", "pending")).length === 0, "the approval is still pending");
  const g = fixture(null);
  const open = await gatewayWith(OPEN, g.plugin);
  const ok: any = await open.gw.invoke(caller, "svc.api", { path: "merge" });
  must(ok.status === "succeeded" && g.ran.length === 1, `an allowed call did not run: ${JSON.stringify(ok)}`);
});

await check("the hook is asked for the plugin's own tools only, not for its bridge's requests", async () => {
  const f = fixture();
  const { gw } = await gatewayWith(OPEN, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", { method: "POST", path: "/v1/other", body: "{}", headers: {} }, { fromProgram: true });
  must(r.status === "succeeded" && f.asked.length === 0, `asked for a bridged request: ${JSON.stringify(r)} ${JSON.stringify(f.asked)}`);
});

await check("a refused call is answered in the shape the bridge answers a refused route: same keys, status and code", async () => {
  const f = fixture();
  const { gw, store } = await gatewayWith(null, f.plugin);
  const viaHook: any = await gw.invoke(caller, "svc.api", { path: "merge" });
  const viaRoute: any = await gw.invoke(caller, "svc.request", { method: "POST", path: "/v1/merge", body: "{}", headers: {} }, { fromProgram: true });
  must(JSON.stringify(viaHook) === JSON.stringify(viaRoute), `shapes differ: hook ${JSON.stringify(viaHook)} route ${JSON.stringify(viaRoute)}`);
  must(Object.keys(viaHook).join() === "status,error" && Object.keys(viaHook.error).join() === "code,message" && typeof viaHook.error.message === "string",
    `not { status, error: { code, message } }: ${JSON.stringify(viaHook)}`);
  must((await allApprovals(store)).length === 0 && f.ran.length === 0, "a card was made, or something ran");
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
