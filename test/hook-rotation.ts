/**
 * Hook secrets a service writes itself (Raft, task #47), through the real
 * runtime and store: versions go up by one, the newest is tried first, an
 * older one works only until the newer proves itself, and a revoke forgets
 * all of them. The Worker's grant route is exercised on preview; the grant
 * table in test/spec/control-plane-spec.ts.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { hookSecretName, HOOK_ROTATION_MS } from "../src/runtime/inbound.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

// Stands in for a signature check: the event names the secret it was signed with.
const heard: string[] = [];
const signed: Plugin = {
  id: "signed", version: "1.0.0", defaultForAllAgents: true, tools: [],
  async invoke() { return null; },
  async receive(event, secret) {
    heard.push(secret);
    // A careless plugin: ignores pings before looking at the signature.
    if (event.headers["x-kind"] === "ping") return { deliver: false, reason: "ping" };
    if (event.headers["x-kind"] === "bad-body") return { deliver: false, reason: `bad body (${secret.slice(0, 1)})`, rejected: true };
    return event.headers["x-signed-with"] === secret
      ? { deliver: true, text: "ok" }
      : { deliver: false, reason: "bad signature", rejected: true };
  },
};
const S1 = "1".repeat(43), S2 = "2".repeat(43), S3 = "3".repeat(43);
const ev = (secret: string) => ({ headers: { "x-signed-with": secret }, body: new Uint8Array([1]) });

async function runtime() {
  const host = sqliteHost();
  const kek = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    extraPlugins: [signed], secretKek: kek,
  } as any);
  await rt.ready();
  await rt.store.createAgent("t", "a");
  await rt.store.addMount({
    tenantId: "t", agentId: "a", alias: "r", plugin: "signed", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  const posted: string[] = [];
  (rt as any).postMessage = async (_t: string, _a: string, text: string) => { posted.push(text); };
  heard.length = 0;
  return { rt, host, posted };
}
const receive = (rt: AgentRuntime, secret: string) => rt.receiveHook("t", "a", "r", "h", ev(secret));

await check("versions start at 1 and go up by one; a skipped or repeated version is refused", async () => {
  const { rt, host } = await runtime();
  must((await rt.hookSecretVersion("t", "a", "h")).current === 0, "a new hook has a version");
  const skip = await rt.putHookSecret("t", "a", "r", "h", 2, S2);
  must(!skip.ok && /next version is 1/.test(skip.error), `skipped: ${JSON.stringify(skip)}`);
  must((await rt.putHookSecret("t", "a", "r", "h", 1, S1)).ok, "version 1 refused");
  const again = await rt.putHookSecret("t", "a", "r", "h", 1, S1);
  must(!again.ok && /next version is 2/.test(again.error), `repeated: ${JSON.stringify(again)}`);
  must((await rt.hookSecretVersion("t", "a", "h")).current === 1, "version did not move");
  host.dispose();
});

await check("an event signed with the only version is delivered", async () => {
  const { rt, host, posted } = await runtime();
  await rt.putHookSecret("t", "a", "r", "h", 1, S1);
  must((await receive(rt, S1)).outcome === "delivered" && posted.length === 1, "not delivered");
  must((await receive(rt, "wrong".padEnd(43, "x"))).outcome === "rejected", "a wrong signature was not rejected");
  host.dispose();
});

await check("during a rotation both versions work, newest first, until the newer one proves itself", async () => {
  const { rt, host } = await runtime();
  await rt.putHookSecret("t", "a", "r", "h", 1, S1);
  await rt.putHookSecret("t", "a", "r", "h", 2, S2);
  heard.length = 0;
  must((await receive(rt, S1)).outcome === "delivered", "the older version stopped working mid-rotation");
  must(heard.join(",") === `${S2},${S1}`, `tried ${heard.length} secrets, newest first expected`);
  must((await receive(rt, S2)).outcome === "delivered", "the newer version did not work");
  heard.length = 0;
  must((await receive(rt, S1)).outcome === "rejected", "the older version still works after the newer one proved itself");
  must(heard.join(",") === S2, "a retired version was still tried");
  host.dispose();
});

await check("an older version stops working once the rotation window has passed", async () => {
  const { rt, host } = await runtime();
  await rt.putHookSecret("t", "a", "r", "h", 1, S1);
  await rt.putHookSecret("t", "a", "r", "h", 2, S2);
  host.sql.exec("UPDATE hook_secret_versions SET added_at = ? WHERE hook_id = 'h' AND version = 2", Date.now() - HOOK_ROTATION_MS - 1);
  must((await receive(rt, S1)).outcome === "rejected", "the older version outlived the window");
  must((await receive(rt, S2)).outcome === "delivered", "the newer version stopped working");
  host.dispose();
});

await check("a third version drops the oldest; a revoke forgets every version", async () => {
  const { rt, host } = await runtime();
  for (const [v, s] of [[1, S1], [2, S2], [3, S3]] as const) await rt.putHookSecret("t", "a", "r", "h", v, s);
  must((await receive(rt, S1)).outcome === "rejected", "three versions were kept");
  must((await receive(rt, S2)).outcome === "delivered", "the one before the newest was dropped");
  must((await rt.dropHookSecret("t", "a", "h")) === true, "drop reported nothing");
  must((await receive(rt, S3)).outcome === "failed", "a dropped hook still verified");
  must((await rt.hookSecretVersion("t", "a", "h")).current === 0, "versions survived the drop");
  host.dispose();
});

await check("a hook whose secret was generated here takes no service-written version, and keeps working", async () => {
  const { rt, host, posted } = await runtime();
  const made = await rt.createHookSecret("t", "a", "r", "g");
  must(made.ok, JSON.stringify(made));
  const r = await rt.putHookSecret("t", "a", "r", "g", 1, S1);
  must(!r.ok && /generated by this deployment/.test(r.error), `versioned a generated hook: ${JSON.stringify(r)}`);
  const secret = made.ok ? made.secret : "";
  must((await rt.receiveHook("t", "a", "r", "g", ev(secret))).outcome === "delivered" && posted.length === 1, "the generated secret stopped working");
  must(hookSecretName("g") === "hook:g", "the generated secret's name changed");
  host.dispose();
});

await check("no secret is stored for a mount that is missing or switched off", async () => {
  const { rt, host } = await runtime();
  const gone = await rt.putHookSecret("t", "a", "nope", "h", 1, S1);
  must(!gone.ok && /no mount named nope/.test(gone.error), JSON.stringify(gone));
  await rt.store.setPluginChoice("t", "a", "signed", "disable");
  const off = await rt.putHookSecret("t", "a", "r", "h", 1, S1);
  must(!off.ok && /switched off/.test(off.error), JSON.stringify(off));
  must((await rt.hookSecretVersion("t", "a", "h")).current === 0, "a version was recorded");
  host.dispose();
});

await check("only a delivery ends a rotation, and every version's refusal is recorded", async () => {
  const { rt, host } = await runtime();
  await rt.putHookSecret("t", "a", "r", "h", 1, S1);
  await rt.putHookSecret("t", "a", "r", "h", 2, S2);
  const ping = await rt.receiveHook("t", "a", "r", "h", { headers: { "x-kind": "ping" }, body: new Uint8Array([1]) });
  must(ping.outcome === "ignored", `ping: ${JSON.stringify(ping)}`);
  must((await receive(rt, S1)).outcome === "delivered", "an unsigned ping ended the rotation");
  const bad = await rt.receiveHook("t", "a", "r", "h", { headers: { "x-kind": "bad-body" }, body: new Uint8Array([1]) });
  must(bad.outcome === "rejected", JSON.stringify(bad));
  const [last] = await rt.inboundLog(1);
  must(last?.reason === "v2: bad body (2); v1: bad body (1)", `reason: ${JSON.stringify(last?.reason)}`);
  host.dispose();
});

console.log(`\n  Service-written hook secrets\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
