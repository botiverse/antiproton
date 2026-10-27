/**
 * `Plugin.policyKey` (botiverse/antiproton#1092): a call is decided under its tool's policy and the key's, and the
 * stricter of the two wins, so a key only tightens. Asserted on outcomes — the call ran, is awaiting approval, or was
 * refused, and what the operation row and the approval request say — over the six mount settings that tell the
 * directions apart: allowing only one of the two leaves the call held, both allow it, and an allow beside a deny is a
 * deny. A `stricter` written backwards (the looser of the two) turns the held rows into runs and the deny into a run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { stricter } from "../src/plugins/types.ts";
import type { Plugin } from "../src/plugins/types.ts";
import type { MountPolicy } from "../src/core/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const caller = { tenantId: "t", agentId: "a", taskId: "k" };

/**
 * A fixture shaped like the case the hook is for: one generic `api` tool, whose calls to a route nobody listed are
 * decided under a second key, `api.unlisted`, held for a person by the plugin's default.
 */
function fixture(opts: { throws?: boolean } = {}) {
  const ran: unknown[] = [];
  const plugin: Plugin = {
    id: "svc", version: "1.0.0",
    tools: [{ name: "api", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" }],
    defaultPolicy: { tools: { api: "approval", "api.unlisted": "approval" } },
    policyKey(tool, args) {
      if (opts.throws) throw new Error("the hook could not decide");
      return tool === "api" && (args as { listed?: boolean }).listed !== true ? "api.unlisted" : undefined;
    },
    async invoke(_tool, args) { ran.push(args); return { ok: true }; },
  };
  return { plugin, ran };
}

async function gatewayWith(policy: MountPolicy | null, plugin: Plugin) {
  const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), "policy-key-")), "s.sqlite"));
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy,
  });
  return { gw: new ToolGateway(store, [plugin], new Set(["svc"]), { async resolve() { return null; } }), store };
}

async function outcome(policy: MountPolicy | null, args: Record<string, unknown> = {}, opts: { throws?: boolean } = {}) {
  const f = fixture(opts);
  const { gw, store } = await gatewayWith(policy, f.plugin);
  const r: any = await gw.invoke(caller, "svc.api", args as any);
  const approvals = await store.listApprovals("t", "pending");
  const op = r.operationId ? await store.getOperation("t", r.operationId) : null;
  return { r, ran: f.ran.length, approvals, op };
}

await check("stricter: deny over approval over allow, in either order", async () => {
  must(stricter("allow", "approval") === "approval" && stricter("approval", "allow") === "approval", "approval vs allow");
  must(stricter("deny", "allow") === "deny" && stricter("allow", "deny") === "deny", "deny vs allow");
  must(stricter("approval", "deny") === "deny" && stricter("allow", "allow") === "allow", "deny vs approval; allow alone");
});

const rows: Array<{ name: string; policy: MountPolicy | null; expect: "ran" | "pending" | "denied" }> = [
  { name: "nothing set", policy: null, expect: "pending" },
  { name: "write: allow", policy: { write: "allow" }, expect: "pending" },
  { name: "only the tool allowed", policy: { tools: { api: "allow" } }, expect: "pending" },
  { name: "only the key allowed", policy: { tools: { "api.unlisted": "allow" } }, expect: "pending" },
  { name: "both allowed", policy: { tools: { api: "allow", "api.unlisted": "allow" } }, expect: "ran" },
  { name: "tool allowed, key denied", policy: { tools: { api: "allow", "api.unlisted": "deny" } }, expect: "denied" },
  { name: "tool denied, key allowed", policy: { tools: { api: "deny", "api.unlisted": "allow" } }, expect: "denied" },
];
for (const row of rows) {
  await check(`a keyed call with ${row.name}: ${row.expect}`, async () => {
    const { r, ran, approvals, op } = await outcome(row.policy);
    if (row.expect === "ran") {
      must(r.status === "succeeded" && ran === 1, `it did not run: ${JSON.stringify(r)}`);
      must(op?.status === "succeeded", `the operation reads ${op?.status}`);
    } else if (row.expect === "pending") {
      must(r.status === "pending" && r.error?.code === "awaiting_approval", `it was not held: ${JSON.stringify(r)}`);
      must(ran === 0, "a held call reached the plugin");
      must(approvals.length === 1 && (approvals[0]!.request as any).policyKey === "api.unlisted",
        `the approval request does not name the key: ${JSON.stringify(approvals.map((a) => a.request))}`);
    } else {
      must(r.status === "rejected" && r.error?.code === "policy_denied", `it was not refused: ${JSON.stringify(r)}`);
      must(ran === 0 && approvals.length === 0, "a refused call ran or was held");
    }
  });
}

await check("the tool's own per-tool entry still applies to a keyed call: tools.api deny stays deny though the key allows", async () => {
  const { r, ran } = await outcome({ tools: { api: "deny", "api.unlisted": "allow" } });
  must(r.status === "rejected" && r.error?.code === "policy_denied" && ran === 0, `deny was weakened: ${JSON.stringify(r)}`);
});

await check("a call the hook gives no key is decided by the tool alone: tools.api allow runs it", async () => {
  const { r, ran, op } = await outcome({ tools: { api: "allow" } }, { listed: true });
  must(r.status === "succeeded" && ran === 1 && op?.status === "succeeded", `an unkeyed call did not run: ${JSON.stringify(r)}`);
});

await check("a hook that throws holds the call for a person, even where the tool and every key are allowed", async () => {
  const { r, ran, approvals } = await outcome({ tools: { api: "allow", "api.unlisted": "allow" }, write: "allow" }, {}, { throws: true });
  must(r.status === "pending" && r.error?.code === "awaiting_approval", `a throwing hook did not hold: ${JSON.stringify(r)}`);
  must(ran === 0 && approvals.length === 1, "it ran, or left no approval");
});

await check("a hook that throws does not lift a deny: tools.api deny stays deny", async () => {
  const { r } = await outcome({ tools: { api: "deny" } }, {}, { throws: true });
  must(r.status === "rejected" && r.error?.code === "policy_denied", `deny was lifted: ${JSON.stringify(r)}`);
});

await check("an approved replay of a keyed call runs it once", async () => {
  const f = fixture();
  const { gw } = await gatewayWith({ tools: { api: "allow" } }, f.plugin);
  const r: any = await gw.invoke(caller, "svc.api", { n: 1 });
  must(r.status === "pending", `not held: ${JSON.stringify(r)}`);
  const done: any = await gw.applyApproval("t", r.operationId, "approved", "person");
  must(done.ok && done.executed && done.result?.status === "succeeded" && f.ran.length === 1, `the replay did not run once: ${JSON.stringify(done)}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
