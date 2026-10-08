/**
 * The provisioning steps inside the agent's object (cf/src/provision/steps.ts) through the real
 * runtime, gateway and store, with Raft stood in for by a recording fetch: the record, the model
 * binding, the `raft` mount, the sealed credential, and push registered and withdrawn by the plugin's
 * own tools. The hook index is a stand-in, as in test/plugin-hooks.ts.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { adoptProvisionedAgent, provisionTool, provisionPushStatus, PROVISION_MOUNT_ALIAS, PROVISIONED_BY } from "../cf/src/provision/steps.ts";
import { NO_CREDENTIAL, reminderPlugin } from "../src/plugins/reminder.ts";
import { toolsOf } from "../src/plugins/types.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { HookRow } from "../cf/src/control-plane.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";

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

async function runtime(opts: { reminderApp?: { origin?: string; credential?: string } } = {}) {
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
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "deepseek-flash",
      MODEL_PROVIDERS: [{ id: "deepseek", baseUrl: "https://model.example/v1", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
        { id: "gw", baseUrl: "https://gw.example/compat", auth: { secret: "GW_TOKEN", header: "cf-aig-authorization" }, modelFormat: "vendor/model" }],
      GW_TOKEN: "gt" } as any),
    hooks: { origin: "https://hooks.test", directory },
    ...(opts.reminderApp ? { reminderApp: opts.reminderApp } : {}),
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
  // All but the one seed that cannot work on Raft.
  must(!aliases.includes("reminder"), `a Raft agent was seeded reminder: ${aliases.join(",")}`);
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

await check("adopt binds the operator's model as chosen for the agent, and the default when nothing is chosen", async () => {
  const { rt, host } = await runtime();
  raft();
  must((await adoptProvisionedAgent(rt, "t", "raft_m1", SPEC, { provider: "gw", model: "anthropic/claude-sonnet-5" })).ok, "adopt");
  const chosen = await rt.store.getModelBinding("t", "raft_m1");
  must(chosen?.model === "anthropic/claude-sonnet-5" && chosen.secretRef === "operator:model:gw" && chosen.baseUrl === "https://gw.example/compat", JSON.stringify(chosen));
  // A choice that could not be read (null) leaves the existing binding alone: a control plane that did not
  // answer does not move the agent back to the default.
  must((await adoptProvisionedAgent(rt, "t", "raft_m1", SPEC, null)).ok, "adopt again");
  must((await rt.store.getModelBinding("t", "raft_m1"))?.model === "anthropic/claude-sonnet-5", "an unread choice moved the agent back to the default");
  // No choice at all (undefined) is the default.
  must((await adoptProvisionedAgent(rt, "t", "raft_m1", SPEC)).ok, "adopt a third time");
  const back = await rt.store.getModelBinding("t", "raft_m1");
  must(back?.model === "deepseek-flash" && back.secretRef === "operator:model" && back.baseUrl === "https://model.example/v1", `no choice did not fall back to the default: ${JSON.stringify(back)}`);
  // A choice the providers refuse (a provider since removed, a name in the wrong form) keeps the existing
  // binding and reports why, as #bindModel does, rather than failing the adopt.
  must((await adoptProvisionedAgent(rt, "t", "raft_m1", SPEC, { provider: "gw", model: "openai/gpt-5" })).ok, "adopt onto the gateway");
  for (const refused of [{ provider: "gone", model: "openai/gpt-5" }, { provider: "gw", model: "gpt-5" }]) {
    const r = await adoptProvisionedAgent(rt, "t", "raft_m1", SPEC, refused);
    const kept = await rt.store.getModelBinding("t", "raft_m1");
    must(r.ok && "modelRefused" in r && /unknown provider gone|vendor\/model/.test(String(r.modelRefused)), `a refused choice failed the adopt or was not reported: ${JSON.stringify(r)}`);
    must(kept?.model === "openai/gpt-5" && kept.secretRef === "operator:model:gw", `a refused choice replaced the binding: ${JSON.stringify(kept)}`);
  }
  // A new agent whose choice could not be read still gets a binding: the default.
  must((await adoptProvisionedAgent(rt, "t", "raft_m2", SPEC, null)).ok && (await rt.store.getModelBinding("t", "raft_m2"))?.model === "deepseek-flash", "a new agent was left unbound");
  host.dispose();
});

/** A deployment with reminder-app configured, as REMINDER_APP_ORIGIN and REMINDER_APP_CREDENTIAL give it. */
const REMINDER_APP = { origin: "https://reminders.example", credential: "rmc.client.secret" };

/** Every request the code under test makes, answered 404. */
function recordFetch() {
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => { urls.push(String(url)); return new Response("{}", { status: 404 }); }) as any;
  return urls;
}

await check("on a deployment with reminder-app configured, a new agent Raft did not make is seeded a reminder mount, which lists its tools and opens in the harness", async () => {
  const { rt, host, rows } = await runtime({ reminderApp: REMINDER_APP });
  const urls = recordFetch();
  try {
    // The path the console's first open and a bench seed take: the record does not exist yet.
    const made = await rt.provision("t", "plain_1");
    must(made.created, "provision did not create the agent");
    const mount = await rt.store.getMountByAlias("t", "plain_1", "reminder");
    must(mount?.plugin === "reminder" && mount.secretRef === null && mount.policy === null, `no reminder mount: ${JSON.stringify(mount)}`);
    // Seeded, not chosen: no plugin answer is written for it, so the owner's switch starts at the default.
    must((await rt.store.pluginChoices("t", "plain_1")).reminder === undefined, "seeding recorded a choice for reminder");
    must(AgentRuntime.seededSecretRef(mount!) === null, "the seed says the mount reverts to a credential");
    must(toolsOf(reminderPlugin, mount!).map((t) => t.name).sort().join() === "create,delete,list", "the mount does not list create, list and delete");
    await rt.bindOperatorModel("t", "plain_1");
    await rt.agent("t", "plain_1");
  } finally { globalThis.fetch = originalFetch; }
  // Mounting reaches nothing: the hook is opened on the first create, not at mount time.
  must(urls.length === 0, `requests went out: ${urls.join(", ")}`);
  must([...rows.values()].length === 0, `a hook was opened: ${JSON.stringify([...rows.values()])}`);
  host.dispose();
});

await check("on a deployment missing reminder-app's origin or credential, no agent is seeded reminder; a mount added anyway refuses and sends nothing", async () => {
  for (const [why, reminderApp] of [
    ["neither", undefined],
    ["no credential", { origin: REMINDER_APP.origin }],
    ["no origin", { credential: REMINDER_APP.credential }],
    ["an origin that is not one", { origin: "http://reminders.example/path", credential: REMINDER_APP.credential }],
  ] as const) {
    const { rt, host } = await runtime({ reminderApp });
    await rt.provision("t", "plain_2");
    must(!(await rt.store.getMountByAlias("t", "plain_2", "reminder")), `${why}: reminder was seeded`);
    // Control: the rest of the defaults arrived in the same pass.
    must(!!(await rt.store.getMountByAlias("t", "plain_2", "state")), `${why}: nothing was seeded at all`);
    host.dispose();
  }
  // An agent can still hold one (seeded while the deployment had the config, or added by an operator): it refuses.
  const { rt, host, rows } = await runtime();
  await rt.provision("t", "plain_3");
  must((await rt.addMount("t", "plain_3", { alias: "reminder", plugin: "reminder", config: {} })).ok, "the explicit mount was refused");
  const urls = recordFetch();
  try {
    const ctx = { tenantId: "t", agentId: "plain_3", taskId: "plain_3:main" };
    const created: any = await rt.gateway().invoke(ctx, "reminder.create", { delayMinutes: 5, note: "stretch" });
    must(created.status === "failed" && JSON.stringify(created.error).includes(NO_CREDENTIAL), `create was not refused for the missing config: ${JSON.stringify(created)}`);
  } finally { globalThis.fetch = originalFetch; }
  must(urls.length === 0 && [...rows.values()].length === 0, `something was sent or opened: ${urls.join(", ")}`);
  host.dispose();
});

await check("an agent Raft made gets no reminder mount: not at adopt, not on a later provision, not on a second adopt", async () => {
  const { rt, host } = await runtime({ reminderApp: REMINDER_APP });
  raft();
  must((await adoptProvisionedAgent(rt, "t", "raft_r1", SPEC)).ok, "adopt failed");
  must(((await rt.store.loadAgent("t", "raft_r1"))?.config as any)?.provisionedBy === PROVISIONED_BY, "the record does not say Raft made it");
  const reminders = async () => (await rt.store.listMounts("t", "raft_r1")).filter((m) => m.plugin === "reminder" || m.alias === "reminder");
  must((await reminders()).length === 0, `adopt seeded reminder: ${JSON.stringify(await reminders())}`);
  // Control: the rest of the defaults did arrive in the same pass, so the absence is the exception and not an empty seed.
  must(!!(await rt.store.getMountByAlias("t", "raft_r1", "state")), "adopt seeded nothing at all");
  // A push's wake (#deliverInbound) and the console's open (uiEnsure; test/reminder-default.ts drives that one whole).
  await rt.provision("t", "raft_r1");
  const { seeds } = await rt.provision("t", "raft_r1", AgentRuntime.DEFAULT_MOUNTS);
  must(!seeds.some((d) => d.plugin === "reminder"), "provision reports the reminder seed as this agent's, so uiEnsure would reconcile it");
  must((await adoptProvisionedAgent(rt, "t", "raft_r1", { ...SPEC, name: "Cody 2" })).ok, "second adopt failed");
  must((await reminders()).length === 0, `a later provision seeded reminder: ${JSON.stringify(await reminders())}`);
  // Left out, not switched off: the owner's switch has nothing written on it.
  must((await rt.store.pluginChoices("t", "raft_r1")).reminder === undefined, "the exclusion recorded a choice for reminder");
  host.dispose();
});

await check("an agent made before reminder was seeded gets it on its next provision, unless Raft made it", async () => {
  // What `provision` does on every console open (uiEnsure) and, for a Raft agent, before a push is posted
  // (#deliverInbound): it adds each missing seed, so a new seed reaches existing agents too.
  const { rt, host } = await runtime({ reminderApp: REMINDER_APP });
  const without = AgentRuntime.DEFAULT_MOUNTS.filter((d) => d.plugin !== "reminder");
  await rt.store.createAgent("t", "old_console", { name: "Old" });
  await rt.store.createAgent("t", "old_raft", { name: "Old Raft", provisionedBy: PROVISIONED_BY });
  for (const a of ["old_console", "old_raft"]) await rt.provision("t", a, without);
  for (const a of ["old_console", "old_raft"]) must(!(await rt.store.getMountByAlias("t", a, "reminder")), `control: ${a} already had reminder`);
  for (const a of ["old_console", "old_raft"]) await rt.provision("t", a);
  must((await rt.store.getMountByAlias("t", "old_console", "reminder"))?.plugin === "reminder", "an existing console agent was not given reminder on its next open");
  must(!(await rt.store.getMountByAlias("t", "old_raft", "reminder")), "an existing Raft agent was given reminder on its next wake");
  host.dispose();
});

globalThis.fetch = originalFetch;
console.log(`\n  provision runtime steps\n  ${"─".repeat(56)}`);
await check("a held connection becomes the GitHub mount's credential once, only for the user it was held for, and only before it expires", async () => {
  const { rt, host } = await runtime();
  await adoptProvisionedAgent(rt, "t", "raft_c1", SPEC);
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any) => String(url).startsWith("https://api.github.com/user")
    ? new Response(JSON.stringify({ login: "octocat", id: 1 }), { headers: { "content-type": "application/json" } })
    : new Response("{}", { status: 404 })) as any;
  try {
    const later = Date.now() + 600_000;
    await rt.holdConnection("t", "raft_c1", "github", "gho_one", "pend_aaaaaaaa", later, "u_owner");
    const stranger = await rt.confirmConnection("t", "raft_c1", "github", "pend_aaaaaaaa", "u_stranger");
    must(!stranger.ok && (stranger as any).missing, `a stranger confirmed: ${JSON.stringify(stranger)}`);
    const after = await rt.confirmConnection("t", "raft_c1", "github", "pend_aaaaaaaa", "u_owner");
    must(!after.ok, "a hold survived a refused confirm: an id is spent by any attempt");
    const gh0 = await rt.store.getMountByAlias("t", "raft_c1", "gh");
    must(gh0?.secretRef === null || !String(gh0?.secretRef).startsWith("agent:"), `the mount got a credential from a refused confirm: ${gh0?.secretRef}`);

    await rt.holdConnection("t", "raft_c1", "github", "gho_two", "pend_bbbbbbbb", later, "u_owner");
    const ok = await rt.confirmConnection("t", "raft_c1", "github", "pend_bbbbbbbb", "u_owner");
    must(ok.ok && ok.account === "octocat", JSON.stringify(ok));
    const gh = await rt.store.getMountByAlias("t", "raft_c1", "gh");
    must(String(gh?.secretRef).startsWith("agent:"), `the GitHub mount did not get the credential: ${gh?.secretRef}`);
    must(!(await rt.confirmConnection("t", "raft_c1", "github", "pend_bbbbbbbb", "u_owner")).ok, "a hold was confirmed twice");
    // What confirm hands back is the tenant's connector: sealed under the same key, it goes onto another agent's mount as is.
    await adoptProvisionedAgent(rt, "t", "raft_c2", SPEC);
    const seen: string[] = [];
    const answer = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => { seen.push(new Headers(init?.headers ?? {}).get("authorization") ?? ""); return answer(url, init); }) as any;
    const shared = ok.ok ? await rt.attachSealedConnection("t", "raft_c2", "github", ok.sealed) : { ok: false as const, error: "no sealed" };
    globalThis.fetch = answer;
    must(shared.ok && shared.account === "octocat" && seen.some((h) => h.endsWith("gho_two")), `the connector did not reach another agent: ${JSON.stringify(shared)}`);
    must(String((await rt.store.getMountByAlias("t", "raft_c2", "gh"))?.secretRef).startsWith("agent:"), "the second agent's GitHub mount has no credential");
    // When the connector goes, a key someone put on the mount since stays; the connector's own copy goes.
    must((await rt.attachCredential("t", "raft_c2", "gh", { token: "gho_mine" })).ok, "a console key was refused");
    must(ok.ok && !(await rt.detachConnectionIfFrom("t", "raft_c2", "github", ok.sealed)), "a key put on the mount since was taken with the connector");
    must(String((await rt.store.getMountByAlias("t", "raft_c2", "gh"))?.secretRef).startsWith("agent:"), "the console key is gone");
    must(ok.ok && (await rt.detachConnectionIfFrom("t", "raft_c1", "github", ok.sealed)), "the connector's own copy was not taken");
    must(!String((await rt.store.getMountByAlias("t", "raft_c1", "gh"))?.secretRef).startsWith("agent:"), "the connector's copy is still on the mount");

    await rt.holdConnection("t", "raft_c1", "github", "gho_old", "pend_cccccccc", Date.now() - 1, "u_owner");
    must(!(await rt.confirmConnection("t", "raft_c1", "github", "pend_cccccccc", "u_owner")).ok, "an expired hold was confirmed");
    must((await rt.store.listSecretNames("t", "raft_c1", "pending:")).length === 0, "held rows were left behind");
  } finally { globalThis.fetch = real; }
  host.dispose();
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
