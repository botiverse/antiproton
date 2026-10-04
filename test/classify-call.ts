/**
 * A mount policy's read or write half, chosen per call (`Plugin.classify`).
 *
 * One tool that runs many commands cannot be declared "read" or "write": half
 * its calls would be held when they should not be, or run when they should be
 * held. The plugin answers per call; anything but "read" or "write" — nothing,
 * a throw, a wrong word — is taken as "write", so a call the plugin cannot
 * place is held where writes are held.
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

await check("declared read, classified write: under write-approval the call is held", async () => {
  const f = await fixture("read", () => "write");
  const r: any = await f.call("look");
  must(r.status === "pending" && f.ran.length === 0, `not held: ${JSON.stringify(r)}`);
});

await check("a classifier that cannot place the call fails closed: undefined, a wrong word, or a throw is a write, and the call still answers", async () => {
  const cases: Array<[string, Plugin["classify"]]> = [
    ["undefined", () => undefined],
    ["\"banana\"", () => "banana" as any],
    ["a throw", () => { throw new Error("classifier broke"); }],
  ];
  for (const [what, classify] of cases) {
    // Declared read, so only the classifier's failure can make this a write.
    const f = await fixture("read", classify);
    const r: any = await f.call("look");
    must(r.status === "pending" && r.error?.code === "awaiting_approval", `${what}: ${JSON.stringify(r)}`);
    must(f.ran.length === 0 && (await f.cards()) === 1, `${what}: ran=${f.ran.length}`);
  }
  // The unknown command of the per-command classifier, too: declared read, held.
  const f = await fixture("read", byCommand);
  must(((await f.call("format-disk")) as any).status === "pending", "an unrecognised command was not held");
});

await check("without classify the declared sideEffects decides, as before", async () => {
  const read = await fixture("read", undefined);
  must(((await read.call("send")) as any).status === "succeeded", "a declared read was held");
  const write = await fixture("write", undefined);
  must(((await write.call("look")) as any).status === "pending", "a declared write was not held");
});

await check("classify picks the read half too: under read-approval a classified read is held and a classified write runs", async () => {
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
