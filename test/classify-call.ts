/**
 * A mount policy's read or write half, chosen per call (`Plugin.classify`).
 *
 * One tool that runs many commands is declared "write", and the plugin may
 * lower a call to "read" for the policy. Only exactly "read" lowers; nothing,
 * a throw, a wrong word or a throwing `classify` leaves it a write. A declared
 * read is the ceiling the other way: `classify` is not asked, since replay
 * reads the declaration and a raised read would be rerun after a crash.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { Json } from "../src/core/types.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (c: unknown, why: string) => { if (!c) throw new Error(why); };

/** One tool, `run`, declared `declared`, on a mount under `policy`; `classify` as given (absent when undefined). */
async function fixture(
  declared: "read" | "write",
  classify: Plugin["classify"] | undefined,
  policy: unknown = { write: "approval" },
) {
  const ran: Json[] = [];
  const plugin: Plugin = {
    // An id that is not the alias, so nothing here can be answered by a name.
    id: "multi", version: "1.0.0",
    tools: [{ name: "run", summary: "", parameters: { type: "object", properties: { cmd: { type: "string" } } }, sideEffects: declared, idempotency: "none" }],
    async invoke(_tool, args) { ran.push(args); return { ran: args }; },
    ...(classify ? { classify } : {}),
  };
  if (classify === THROWING_GETTER) {
    delete (plugin as any).classify;
    Object.defineProperty(plugin, "classify", { get() { throw new Error("classify getter broke"); } });
  }
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "box", plugin: "multi", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: policy as any,
  });
  const gw = new ToolGateway(store, [plugin], new Set([plugin.id]), { async resolve() { return null; } });
  const call = (cmd: string) => gw.invoke({ tenantId: "t", agentId: "a", taskId: "k" }, "box.run", { cmd });
  const cards = async () => (await store.listApprovals("t", "pending")).length;
  return { call, ran, cards };
}

/** A marker: install a `classify` whose very property read throws. */
const THROWING_GETTER: Plugin["classify"] = () => "read";

const byCommand: Plugin["classify"] = (_tool, args) => {
  const cmd = (args as { cmd?: string })?.cmd;
  return cmd === "look" ? "read" : cmd === "send" ? "write" : undefined;
};

await check("declared write, classified per call: under write-approval a look runs and a send is held", async () => {
  const f = await fixture("write", byCommand);
  const look: any = await f.call("look");
  must(look.status === "succeeded" && f.ran.length === 1, `look: ${JSON.stringify(look)}`);
  const send: any = await f.call("send");
  must(send.status === "pending" && send.error?.code === "awaiting_approval", `send: ${JSON.stringify(send)}`);
  must(f.ran.length === 1 && (await f.cards()) === 1, `the send ran or no card: ran=${f.ran.length}`);
});

await check("declared write, a classifier that cannot place the call leaves it a write: held, not run, and the call answers", async () => {
  const cases: Array<[string, Plugin["classify"]]> = [
    ["undefined", () => undefined],
    ["\"banana\"", () => "banana" as any],
    ["a throw", () => { throw new Error("classifier broke"); }],
    ["a throwing getter", THROWING_GETTER],
  ];
  for (const [what, classify] of cases) {
    const f = await fixture("write", classify);
    const r: any = await f.call("look");
    must(r.status === "pending" && r.error?.code === "awaiting_approval", `${what}: ${JSON.stringify(r)}`);
    must(f.ran.length === 0 && (await f.cards()) === 1, `${what}: ran=${f.ran.length}`);
  }
  const f = await fixture("write", byCommand);
  must(((await f.call("format-disk")) as any).status === "pending", "an unrecognised command was not held");
});

await check("declared read is the ceiling: classify is not asked, and the call runs as a read under write-approval", async () => {
  for (const [what, answer] of [["\"write\"", () => "write" as const], ["a throw", () => { throw new Error("must not be asked"); }]] as const) {
    let asked = 0;
    const f = await fixture("read", (...a) => { asked++; return (answer as any)(...a); });
    const r: any = await f.call("send");
    must(r.status === "succeeded" && f.ran.length === 1, `${what}: ${JSON.stringify(r)}`);
    must(asked === 0, `${what}: classify was asked ${asked} time(s) for a declared read`);
  }
});

await check("without classify the declared sideEffects decides, as before", async () => {
  const read = await fixture("read", undefined);
  must(((await read.call("send")) as any).status === "succeeded", "a declared read was held");
  const write = await fixture("write", undefined);
  must(((await write.call("look")) as any).status === "pending", "a declared write was not held");
});

await check("declared write, under read-approval: a call classified read is held and a write runs", async () => {
  const f = await fixture("write", byCommand, { read: "approval" });
  must(((await f.call("look")) as any).status === "pending", "a classified read was not held under read-approval");
  must(((await f.call("send")) as any).status === "succeeded", "a classified write was held under read-approval");
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
