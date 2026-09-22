/**
 * The gateway's half of an inbound event, through the real gateway and store:
 * the plugin is asked only when the mount would take a call — present, able to
 * receive, switched on, and pinned to the version installed (Piper, #377 review).
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const asked: Array<{ alias: string; secret: string; credential: string | null; bytes: number }> = [];
const hook: Plugin = {
  id: "hook", version: "1.0.0", defaultForAllAgents: true, tools: [],
  async invoke() { return null; },
  async receive(event, secret, ctx) {
    asked.push({ alias: ctx.alias, secret, credential: ctx.credential, bytes: event.body.length });
    return { deliver: true, text: "something happened", dedupeKey: "d1" };
  },
};
const deaf: Plugin = { id: "deaf", version: "1.0.0", defaultForAllAgents: true, tools: [], async invoke() { return null; } };
const event = { headers: { "x-sig": "s" }, body: new Uint8Array([1, 2, 3]) };

async function fixture(pinned = "1.0.0") {
  asked.length = 0;
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  for (const [alias, plugin] of [["gh", "hook"], ["quiet", "deaf"]] as const) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, plugin, installationId: "i", connectionId: null,
      toolVersion: alias === "gh" ? pinned : "1.0.0", publicConfig: {}, secretRef: alias === "gh" ? "ref:gh" : null, policy: null,
    });
  }
  const gw = new ToolGateway(store, [hook, deaf], new Set(([hook, deaf]).map((p: any) => p.id)), { async resolve() { return "CRED"; } });
  return { store, gw };
}

await check("an event on a mount that can take it reaches the plugin with the hook secret and the mount's context", async () => {
  const { gw } = await fixture();
  const r: any = await gw.receive("t", "a", "gh", event, "HOOKSECRET");
  assert(r.result?.deliver === true && r.result.text === "something happened", JSON.stringify(r));
  assert(asked.length === 1 && asked[0].alias === "gh" && asked[0].secret === "HOOKSECRET" && asked[0].credential === "CRED" && asked[0].bytes === 3,
    JSON.stringify(asked));
  assert((await gw.receiveBlocked("t", "a", "gh")) === null, "a mount that can receive was reported blocked");
});

await check("a switched-off plugin is not asked, and says why", async () => {
  const { store, gw } = await fixture();
  await store.setPluginChoice("t", "a", "hook", "disable");
  const r: any = await gw.receive("t", "a", "gh", event, "HOOKSECRET");
  assert(asked.length === 0, "the plugin was asked while switched off");
  assert(/switched off/.test(r.skipped ?? ""), JSON.stringify(r));
  assert(/switched off/.test((await gw.receiveBlocked("t", "a", "gh")) ?? ""), "creating a hook on a switched-off plugin was allowed");
});

await check("a mount pinned to another version is not asked", async () => {
  const { gw } = await fixture("0.9.0");
  const r: any = await gw.receive("t", "a", "gh", event, "HOOKSECRET");
  assert(asked.length === 0 && /pins 0\.9\.0/.test(r.skipped ?? ""), JSON.stringify(r));
});

await check("a missing mount and a plugin without receive are skipped, not thrown", async () => {
  const { gw } = await fixture();
  const gone: any = await gw.receive("t", "a", "nope", event, "S");
  const deafR: any = await gw.receive("t", "a", "quiet", event, "S");
  assert(/no mount named nope/.test(gone.skipped ?? "") && /cannot receive/.test(deafR.skipped ?? ""), JSON.stringify([gone, deafR]));
  assert(asked.length === 0, "a plugin was asked");
});

await check("another agent's mount is never reached", async () => {
  const { gw } = await fixture();
  const r: any = await gw.receive("t", "someone-else", "gh", event, "S");
  assert(asked.length === 0 && /no mount named gh/.test(r.skipped ?? ""), JSON.stringify(r));
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
