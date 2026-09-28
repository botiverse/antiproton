/**
 * The provisioning steps inside the agent's object (cf/src/provision/steps.ts) through the real
 * runtime, gateway and store, with Raft stood in for by a recording fetch: the record, the model
 * binding, the `raft` mount, the sealed credential, and push registered and withdrawn by the plugin's
 * own tools. The hook index is a stand-in, as in test/plugin-hooks.ts.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { adoptProvisionedAgent, provisionTool, provisionPushStatus, PROVISION_MOUNT_ALIAS } from "../cf/src/provision/steps.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { HookRow } from "../cf/src/control-plane.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const ORIGIN = "https://raft.example";
const CRED = "sk_agent_" + "R".repeat(32);
const originalFetch = globalThis.fetch;

/** Raft, as the plugin sees it: identity, registration, deregistration. Records every request. */
function raft() {
  const calls: Array<{ method: string; url: string; auth: string | null; body: any }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    const method = String(init?.method ?? "GET");
    const headers = new Headers(init?.headers ?? {});
    calls.push({ method, url: u, auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (headers.get("authorization") !== `Bearer ${CRED}`) return new Response(JSON.stringify({ errorCode: "UNAUTHORIZED" }), { status: 401, headers: { "content-type": "application/json" } });
    if (u === `${ORIGIN}/internal/agent-api` && method === "GET") {
      return new Response(JSON.stringify({ agentId: "ag-1", agentName: "cody", agentDisplayName: "Cody", serverId: "srv-1" }), { headers: { "content-type": "application/json" } });
    }
    if (u === `${ORIGIN}/internal/agent-api/push-webhook`) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ errorCode: "NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } });
  }) as any;
  return calls;
}

async function runtime() {
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
    secretKek: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "operator-key", model: "deepseek-flash" },
    hooks: { origin: "https://hooks.test", directory },
  } as any);
  await rt.ready();
  return { rt, host, rows };
}

const SPEC = { name: "Cody", instructions: "be brief", raftOrigin: ORIGIN, avatar: "0badcafe" };

await check("adopt makes the record with the persona, binds the operator model, and mounts raft at the Raft origin; a second adopt changes only the persona", async () => {
  const { rt, host } = await runtime();
  const first = await adoptProvisionedAgent(rt, "t", "raft_01J", SPEC);
  must(first.ok && first.avatar === "0badcafe", JSON.stringify(first));
  const agent = await rt.store.loadAgent("t", "raft_01J");
  const config = agent?.config as any;
  must(config?.name === "Cody" && config.description === "be brief" && config.avatar === "0badcafe" && config.provisionedBy === "raft", JSON.stringify(agent));
  const binding = await rt.store.getModelBinding("t", "raft_01J");
  must(binding?.model === "deepseek-flash", `binding ${JSON.stringify(binding)}`);
  const mount = await rt.store.getMountByAlias("t", "raft_01J", PROVISION_MOUNT_ALIAS);
  must(mount?.plugin === "raft" && (mount.publicConfig as any).serverUrl === ORIGIN && mount.secretRef === null, JSON.stringify(mount));
  // The defaults every agent gets, memory and artifacts among them: a provisioned agent is not a lesser agent.
  const aliases = (await rt.store.listMounts("t", "raft_01J")).map((m) => m.alias).sort();
  for (const a of ["artifacts", "state", "tools", "web", "gh", "sandbox", "raft"]) must(aliases.includes(a), `no ${a} mount: ${aliases.join(",")}`);
  const second = await adoptProvisionedAgent(rt, "t", "raft_01J", { ...SPEC, name: "Cody 2", instructions: "be thorough", avatar: "ffffffff" });
  must(second.ok && second.avatar === "0badcafe", `avatar changed: ${JSON.stringify(second)}`);
  const after = (await rt.store.loadAgent("t", "raft_01J"))?.config as any;
  must(after.name === "Cody 2" && after.description === "be thorough", JSON.stringify(after));
  must((await rt.store.listMounts("t", "raft_01J")).filter((m) => m.plugin === "raft").length === 1, "a second raft mount appeared");
  host.dispose();
});

await check("a Raft origin that is not an origin is refused by the mount's own settings", async () => {
  const { rt, host } = await runtime();
  const r = await adoptProvisionedAgent(rt, "t", "raft_bad", { ...SPEC, raftOrigin: "http://raft.example/path" });
  must(!r.ok && /serverUrl/.test(r.error), JSON.stringify(r));
  host.dispose();
});

await check("the credential is sealed onto the mount and checked against Raft, and enable_push through the gateway registers a hook whose secret goes only to Raft", async () => {
  const { rt, host, rows } = await runtime();
  const calls = raft();
  must((await adoptProvisionedAgent(rt, "t", "raft_01J", SPEC)).ok, "adopt failed");
  const attached = await rt.attachCredential("t", "raft_01J", PROVISION_MOUNT_ALIAS, { token: CRED });
  must(attached.ok && attached.verified && attached.account === "Cody (@cody)", JSON.stringify(attached));
  const mount = await rt.store.getMountByAlias("t", "raft_01J", PROVISION_MOUNT_ALIAS);
  must(mount?.secretRef && !JSON.stringify(mount).includes(CRED), `the mount carries the value: ${JSON.stringify(mount)}`);
  const push = await provisionTool(rt, "t", "raft_01J", "enable_push");
  must(push.ok && (push.result as any).enabled === true && (push.result as any).registration === "active", JSON.stringify(push));
  const put = calls.find((c) => c.method === "PUT");
  must(put && put.url === `${ORIGIN}/internal/agent-api/push-webhook` && put.auth === `Bearer ${CRED}`, JSON.stringify(calls.map((c) => [c.method, c.url])));
  must(/^https:\/\/hooks\.test\/hooks\/[A-Za-z0-9_-]{43}$/.test(put!.body.url) && /^[0-9a-f]{64}$/.test(put!.body.secret), JSON.stringify({ ...put!.body, secret: "…" }));
  must([...rows.values()].filter((r) => r.agentId === "raft_01J" && r.revokedAt === null).length === 1, "not exactly one live hook");
  const before = Number((await rt.store.listMounts("t", "raft_01J")).length);
  const status = await provisionPushStatus(rt, "t", "raft_01J");
  must(status?.enabled === true && status.registration === "active" && !JSON.stringify(status).includes(put!.body.secret), JSON.stringify(status));
  must(Number((await rt.store.listMounts("t", "raft_01J")).length) === before, "reading push status changed the mounts");
  const off = await provisionTool(rt, "t", "raft_01J", "disable_push");
  must(off.ok && (off.result as any).enabled === false && (off.result as any).remoteDeregistration === "confirmed", JSON.stringify(off));
  must(calls.some((c) => c.method === "DELETE" && c.url === `${ORIGIN}/internal/agent-api/push-webhook`), "no DELETE reached Raft");
  must([...rows.values()].every((r) => r.revokedAt !== null), "a hook survived disable_push");
  must((await rt.removeCredential("t", "raft_01J", PROVISION_MOUNT_ALIAS)) === true, "the credential did not come off");
  host.dispose();
});

await check("a push tool without a credential on the mount fails as a tool failure, not a throw", async () => {
  const { rt, host } = await runtime();
  raft();
  must((await adoptProvisionedAgent(rt, "t", "raft_01J", SPEC)).ok, "adopt failed");
  const push = await provisionTool(rt, "t", "raft_01J", "enable_push");
  must(!push.ok && /enable_push: /.test(push.error) && /credential|account/i.test(push.error), JSON.stringify(push));
  host.dispose();
});

globalThis.fetch = originalFetch;
console.log(`\n  provision runtime steps\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
