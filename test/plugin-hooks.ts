/**
 * A plugin making its own mount's hooks (`PluginContext.inbound`), through the
 * real runtime, gateway and store: offered only to a plugin that can receive,
 * scoped to the mount being called, and the secret it returns is the one
 * events are checked against. The D1 index is a stand-in here; its queries
 * are covered in test/spec/control-plane-spec.ts.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { INBOUND_HOOKS_PER_MOUNT, type InboundHooks, type Plugin } from "../src/plugins/types.ts";
import type { HookRow } from "../cf/src/control-plane.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

// The plugin under test hands its `inbound` out through a tool, so the test can drive it.
const handed: Record<string, InboundHooks | undefined> = {};
/** The hook id each delivery said it arrived at, as the plugin saw it. */
const arrivedAt: string[] = [];
const pushy: Plugin = {
  id: "pushy", version: "1.0.0", 
  tools: [{ name: "grab", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke(_t, _a, ctx) { handed[ctx.alias] = ctx.inbound; return { has: !!ctx.inbound }; },
  async receive(event, secret) {
    arrivedAt.push(event.hookId);
    if (event.headers["x-signed-with"] !== secret) return { deliver: false, reason: "bad", rejected: true };
    if (event.headers["x-malformed"]) return { deliver: false, reason: "not my shape", malformed: true };
    return { deliver: true, text: "ok" };
  },
};
const quiet: Plugin = { ...pushy, id: "quiet", receive: undefined };
// Reports activity; records what it was handed and with which mount's credential state.
const told: Array<{ alias: string; n: number; credential: string | null }> = [];
pushy.reportActivity = async (events, ctx) => { told.push({ alias: ctx.alias, n: events.length, credential: ctx.credential }); return { sent: events.length }; };

async function runtime(opts: { hooks?: boolean } = {}) {
  const host = sqliteHost();
  const rows = new Map<string, HookRow>();
  const directory = {
    async create(r: { hookId: string; tenantId: string; agentId: string; alias: string }) { rows.set(r.hookId, { ...r, createdAt: 1, revokedAt: null }); },
    async lookup(id: string) { const r = rows.get(id); return r && r.revokedAt === null ? r : null; },
    async list(t: string, a: string) { return [...rows.values()].filter((r) => r.tenantId === t && r.agentId === a); },
    async revoke(id: string) { const r = rows.get(id); if (!r || r.revokedAt !== null) return null; r.revokedAt = 2; return r; },
  };
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    extraPlugins: [pushy, quiet], secretKek: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    ...(opts.hooks === false ? {} : { hooks: { origin: "https://hooks.test", directory } }),
  } as any);
  await rt.ready();
  for (const agentId of ["a", "b"]) {
    await rt.store.createAgent("t", agentId);
    // Installed here, absent from the deployment's catalogue: switched on per
    // agent, the same way a person would. These plugins used to enable
    // themselves with `defaultForAllAgents`.
    for (const id of ["pushy", "quiet"]) await rt.store.setPluginChoice("t", agentId, id, "enable");
    for (const [alias, plugin] of [["p", "pushy"], ["p2", "pushy"], ["q", "quiet"]]) {
      await rt.store.addMount({ tenantId: "t", agentId, alias, plugin, installationId: "i", connectionId: null,
        toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
    }
  }
  (rt as any).postMessage = async () => {};
  for (const k of Object.keys(handed)) delete handed[k];
  const grab = async (agentId: string, alias: string) => {
    const r: any = await rt.gateway().invoke({ tenantId: "t", agentId, taskId: "k" }, `${alias}.grab`, {});
    must(r.ok !== false, `grab ${alias}: ${JSON.stringify(r)}`);
    return handed[alias];
  };
  return { rt, host, rows, grab };
}
const ev = (secret: string, extra: Record<string, string> = {}) => ({ headers: { "x-signed-with": secret, ...extra }, body: new Uint8Array([1]) });

await check("activity reaches every mount whose plugin reports it, through the gateway's gate, and a switched-off plugin is skipped with the reason", async () => {
  const { rt, host } = await runtime();
  told.length = 0;
  const events = [{ eventId: "a:1", hookEventName: "Stop" as const, occurredAt: "2026-09-28T08:00:00.000Z" }];
  const out = await rt.gateway().reportActivity("t", "a", events);
  must(out.length === 2 && out.every((r) => "sent" in r && r.sent === 1) && told.map((t) => t.alias).sort().join(",") === "p,p2", JSON.stringify({ out, told }));
  must(told.every((t) => t.credential === null), "a mount with no account showed a credential");
  await rt.store.setPluginChoice("t", "a", "pushy", "disable");
  told.length = 0;
  const off = await rt.gateway().reportActivity("t", "a", events);
  must(off.length === 2 && off.every((r) => "skipped" in r && /switched off/.test(r.skipped)) && told.length === 0, JSON.stringify(off));
  must((await rt.gateway().reportActivity("t", "b", events)).every((r) => "sent" in r), "another agent's mounts were affected");
  host.dispose();
});

await check("a signed body the plugin cannot read is malformed, which is neither rejected nor ignored", async () => {
  const { rt, host, grab } = await runtime();
  const made = await (await grab("a", "p"))!.create();
  const r = await rt.receiveHook("t", "a", "p", made.hookId, ev(made.secret, { "x-malformed": "1" }));
  must(r.outcome === "malformed", `outcome ${r.outcome}`);
  const log = await rt.inboundLog(1);
  must(log[0]?.outcome === "malformed" && log[0]?.reason === "not my shape", `record ${JSON.stringify(log[0])}`);
  host.dispose();
});

await check("what a plugin delivers reaches the agent under the label that says it is not the user", async () => {
  const { rt, host, grab } = await runtime();
  const posted: string[] = [];
  (rt as any).postMessage = async (_t: string, _a: string, text: string) => { posted.push(text); };
  const made = await (await grab("a", "p"))!.create();
  must((await rt.receiveHook("t", "a", "p", made.hookId, ev(made.secret))).outcome === "delivered", "not delivered");
  must(posted.length === 0, `posted before the answer: ${posted.length}`);
  must((await rt.deliverPendingInbound("t", "a")).posted === 1, "the queued push was not posted");
  // The event names the hook it arrived at, which the runtime resolved before the plugin saw it.
  must(arrivedAt.at(-1) === made.hookId, `the plugin saw hookId ${arrivedAt.at(-1)}, not the hook the delivery came to`);
  must(posted.length === 1 && /not by the user/.test(posted[0]!) && posted[0]!.endsWith("\nok"), `posted ${JSON.stringify(posted)}`);
  host.dispose();
});
await check("an explicit seed list mounts a non-default plugin and its tools reach the catalogue; the default list still leaves it to the switch", async () => {
  // The bench arm's shape: rt.provision(tenant, agent, [seeds]) with a plugin that is not in DEFAULT_MOUNTS and
  // was never switched on. #491 made provision() skip it without a word; the production τ² round went 0/24.
  const { rt, host } = await runtime();
  await rt.store.createAgent("t", "bench-1");
  await rt.provision("t", "bench-1", [{ alias: "p", plugin: "pushy", config: {}, secretRef: null, policy: null } as any], { chosen: true });
  const mounts = (await rt.store.listMounts("t", "bench-1")).map((m) => m.alias);
  must(mounts.includes("p"), `explicit seed not mounted: ${mounts.join(",")}`);
  must((await rt.store.pluginChoices("t", "bench-1")).pushy === "enable", "the explicit seed was not recorded as a choice");
  const r: any = await rt.gateway().invoke({ tenantId: "t", agentId: "bench-1", taskId: "k" }, "p.grab", {});
  must(r.ok !== false && r.status !== "rejected", `the seeded plugin's tool did not run: ${JSON.stringify(r)}`);
  // An explicit "disable" still wins over an explicit seed.
  await rt.store.createAgent("t", "bench-2");
  await rt.store.setPluginChoice("t", "bench-2", "pushy", "disable");
  await rt.provision("t", "bench-2", [{ alias: "p", plugin: "pushy", config: {}, secretRef: null, policy: null } as any], { chosen: true });
  must(!(await rt.store.listMounts("t", "bench-2")).some((m) => m.alias === "p"), "a disabled plugin was mounted from an explicit seed");
  // The default list is not an explicit choice: a non-default plugin is not switched on by it.
  await rt.store.createAgent("t", "plain");
  await rt.provision("t", "plain");
  must((await rt.store.pluginChoices("t", "plain")).pushy === undefined, "the default seeds switched on a non-default plugin");
  // Nor is a fresh copy of a list: only saying so counts.
  await rt.store.createAgent("t", "copy");
  await rt.provision("t", "copy", [{ alias: "p", plugin: "pushy", config: {}, secretRef: null, policy: null } as any]);
  must((await rt.store.pluginChoices("t", "copy")).pushy === undefined && !(await rt.store.listMounts("t", "copy")).some((m) => m.alias === "p"), "an unsaid list switched a plugin on");
  host.dispose();
});

await check("a plugin that can receive makes a hook for its own mount, and the secret it gets is the one events are checked with", async () => {
  const { rt, host, rows, grab } = await runtime();
  const inbound = await grab("a", "p");
  must(inbound, "no inbound offered");
  const made = await inbound!.create();
  must(made.url === `https://hooks.test/hooks/${made.hookId}` && /^[A-Za-z0-9_-]{43}$/.test(made.hookId), JSON.stringify({ ...made, secret: "…" }));
  const row = rows.get(made.hookId);
  must(row?.tenantId === "t" && row.agentId === "a" && row.alias === "p", `index row ${JSON.stringify(row)}`);
  must((await rt.receiveHook("t", "a", "p", made.hookId, ev(made.secret))).outcome === "delivered", "the returned secret did not verify");
  must((await rt.receiveHook("t", "a", "p", made.hookId, ev("x"))).outcome === "rejected", "another secret verified");
  host.dispose();
});

await check("a plugin that cannot receive, or a deployment without a hook origin, is offered nothing", async () => {
  const one = await runtime();
  must((await one.grab("a", "q")) === undefined, "a plugin without receive was offered inbound");
  one.host.dispose();
  const two = await runtime({ hooks: false });
  must((await two.grab("a", "p")) === undefined, "offered without a hook origin");
  two.host.dispose();
});

await check("revoke reaches only this mount's hooks, and takes the secret with it", async () => {
  const { rt, host, rows, grab } = await runtime();
  const mine = await (await grab("a", "p"))!.create();
  const sibling = await (await grab("a", "p2"))!.create();
  const other = await (await grab("b", "p"))!.create();
  const inbound = await grab("a", "p");
  must((await inbound!.revoke(sibling.hookId)) === false && rows.get(sibling.hookId)?.revokedAt === null, "revoked another mount's hook");
  must((await inbound!.revoke(other.hookId)) === false && rows.get(other.hookId)?.revokedAt === null, "revoked another agent's hook");
  must((await inbound!.revoke("nope")) === false, "revoked a hook that does not exist");
  must((await inbound!.revoke(mine.hookId)) === true && rows.get(mine.hookId)?.revokedAt !== null, "own hook not revoked");
  must((await inbound!.revoke(mine.hookId)) === false, "a second revoke reported a change");
  must((await rt.receiveHook("t", "a", "p", mine.hookId, ev(mine.secret))).outcome === "failed", "the secret survived the revoke");
  must((await rt.receiveHook("t", "a", "p2", sibling.hookId, ev(sibling.secret))).outcome === "delivered", "the sibling's hook stopped working");
  host.dispose();
});

await check("no hook is made for a mount that is switched off, and nothing is indexed", async () => {
  const { rt, host, rows, grab } = await runtime();
  const inbound = await grab("a", "p");
  await rt.store.setPluginChoice("t", "a", "pushy", "disable");
  let err = "";
  try { await inbound!.create(); } catch (e) { err = String((e as Error).message); }
  must(/switched off/.test(err) && rows.size === 0, `created while off: ${err} ${rows.size}`);
  host.dispose();
});

await check("a mount holds a few live hooks at most; revoking one makes room", async () => {
  const { host, rows, grab } = await runtime();
  const inbound = await grab("a", "p");
  const made = [];
  for (let i = 0; i < INBOUND_HOOKS_PER_MOUNT; i++) made.push(await inbound!.create());
  let err = "";
  try { await inbound!.create(); } catch (e) { err = String((e as Error).message); }
  must(/already has 3 live hooks/.test(err) && rows.size === INBOUND_HOOKS_PER_MOUNT, `past the cap: ${err} ${rows.size}`);
  must(!!(await (await grab("a", "p2"))!.create()), "another mount was held to this mount's cap");
  await inbound!.revoke(made[0].hookId);
  must(!!(await inbound!.create()), "revoking did not make room");
  host.dispose();
});

console.log(`\n  A plugin's own hooks\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
