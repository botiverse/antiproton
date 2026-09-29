/**
 * The control plane's queries on real D1 (task #18). Run inside workerd by cf/src/conformance.ts
 * against a local database the migrations in cf/migrations were applied to; see
 * test/control-plane-d1.sh. Each case starts from an empty table.
 */
import { d1ApiKeys, d1Connections, d1Identities, d1InboundHooks, d1ProviderTokens, d1ProvisionedAgents, d1ServiceTokens } from "../../cf/src/control-plane.ts";

export interface SpecCase { name: string; run(): Promise<void> }

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

export function controlPlaneCases(db: D1Database): SpecCase[] {
  const dir = d1Identities(db);
  let clock = 1_800_000_000_000;
  const keys = d1ApiKeys(db, () => ++clock);
  const hooks = d1InboundHooks(db, () => ++clock);
  const tokens = d1ServiceTokens(db, () => clock);
  const provider = d1ProviderTokens(db, () => clock);
  const registry = d1ProvisionedAgents(db, () => clock);
  const wipe = () => db.batch([db.prepare("DELETE FROM identities"), db.prepare("DELETE FROM api_keys"), db.prepare("DELETE FROM inbound_hooks"), db.prepare("DELETE FROM service_tokens"),
    db.prepare("DELETE FROM provider_tokens"), db.prepare("DELETE FROM provisioned_agents"),
    db.prepare("DELETE FROM provisioned_connections"), db.prepare("DELETE FROM connect_links")]);
  const cases: SpecCase[] = [];
  const add = (name: string, fn: () => Promise<void>) => cases.push({ name, run: async () => { await wipe(); await fn(); } });

  add("the migration made exactly the columns the queries read", async () => {
    const { results } = await db.prepare("PRAGMA table_info(identities)").all();
    const names = (results as any[]).map((r) => String(r.name)).sort().join(",");
    assert(names === "added_by,agent_id,created_at,provider_key,tenant_id", `columns ${names}`);
  });

  add("inbound_hooks has exactly the columns the hook queries read", async () => {
    const { results } = await db.prepare("PRAGMA table_info(inbound_hooks)").all();
    const names = (results as any[]).map((r) => String(r.name)).sort().join(",");
    assert(names === "agent_id,alias,created_at,hook_id,revoked_at,tenant_id", `columns ${names}`);
  });

  add("a hook resolves to its agent's mount until it is revoked, and a revoke reports the row once", async () => {
    await hooks.create({ hookId: "h1", tenantId: "t-1", agentId: "a-1", alias: "gh" });
    const got = await hooks.lookup("h1");
    assert(got?.tenantId === "t-1" && got.agentId === "a-1" && got.alias === "gh", `lookup ${JSON.stringify(got)}`);
    assert((await hooks.lookup("h2")) === null, "an absent hook resolved");
    const first = await hooks.revoke("h1");
    assert(first?.agentId === "a-1", `revoke ${JSON.stringify(first)}`);
    assert((await hooks.revoke("h1")) === null, "a second revoke reported the row again");
    assert((await hooks.lookup("h1")) === null, "a revoked hook still resolves");
    const [row] = await hooks.list("t-1", "a-1");
    assert(row?.revokedAt !== null && row.hookId === "h1", `list ${JSON.stringify(row)}`);
  });

  add("an agent's hook list holds only that agent's hooks", async () => {
    await hooks.create({ hookId: "h1", tenantId: "t-1", agentId: "a-1", alias: "gh" });
    await hooks.create({ hookId: "h2", tenantId: "t-1", agentId: "a-2", alias: "gh" });
    await hooks.create({ hookId: "h3", tenantId: "t-2", agentId: "a-1", alias: "gh" });
    const ids = (await hooks.list("t-1", "a-1")).map((h) => h.hookId).join(",");
    assert(ids === "h1", `listed ${ids}`);
  });

  add("an upserted row reads back; a second upsert changes it and keeps the first created_at", async () => {
    await dir.upsert("github:1", { agentId: "u-a", tenantId: "demo" }, "automation");
    const [first] = await dir.list();
    await new Promise((r) => setTimeout(r, 5));
    await dir.upsert("github:1", { agentId: "u-b", tenantId: "t-1" }, "self");
    const got = await dir.lookup("github:1");
    assert(got?.agentId === "u-b" && got.tenantId === "t-1", `lookup ${JSON.stringify(got)}`);
    const [row] = await dir.list();
    assert(row.addedBy === "self" && row.createdAt === first.createdAt, `row ${JSON.stringify(row)} after ${JSON.stringify(first)}`);
    assert((await dir.lookup("github:2")) === null, "an absent key read as a row");
  });

  add("register writes an absent key, and returns the existing row without touching it when there is one", async () => {
    const fresh = await dir.register("github:1", { agentId: "u-new", tenantId: "t-new" }, "self");
    assert(fresh.agentId === "u-new", `fresh ${JSON.stringify(fresh)}`);
    await dir.upsert("github:2", { agentId: "u-op", tenantId: "demo" }, "automation");
    const held = await dir.register("github:2", { agentId: "u-new2", tenantId: "t-new2" }, "self");
    assert(held.agentId === "u-op" && held.tenantId === "demo", `held ${JSON.stringify(held)}`);
    const row = (await dir.list()).find((r) => r.key === "github:2");
    assert(row?.addedBy === "automation" && row.agentId === "u-op", `register overwrote: ${JSON.stringify(row)}`);
  });

  add("remove deletes the row; removing an absent key is not an error", async () => {
    await dir.upsert("github:1", { agentId: "u-a", tenantId: "demo" }, "automation");
    await dir.remove("github:1");
    await dir.remove("github:1");
    assert((await dir.lookup("github:1")) === null && (await dir.list()).length === 0, "the row survived");
  });

  add("list returns every field, oldest first", async () => {
    // Written with fixed created_at values, so the order is the rule and not the clock.
    await db.batch([
      db.prepare("INSERT INTO identities(provider_key, agent_id, tenant_id, added_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind("github:9", "u-late", "t-9", "self", 9000),
      db.prepare("INSERT INTO identities(provider_key, agent_id, tenant_id, added_by, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind("github:8", "u-early", "demo", "automation", 8000),
    ]);
    const rows = await dir.list();
    assert(rows.map((r) => r.key).join(",") === "github:8,github:9", `order ${rows.map((r) => r.key)}`);
    assert(JSON.stringify(rows[0]) === JSON.stringify({ key: "github:8", agentId: "u-early", tenantId: "demo", addedBy: "automation", createdAt: 8000 }), `row ${JSON.stringify(rows[0])}`);
  });

  add("the api_keys migration made exactly the columns the key queries read", async () => {
    const { results } = await db.prepare("PRAGMA table_info(api_keys)").all();
    const names = (results as any[]).map((r) => String(r.name)).sort().join(",");
    assert(names === "created_at,hash,label,owner_agent_id,revoked_at,tenant_id", `columns ${names}`);
  });

  add("a key resolves to its tenant and owner until it is revoked, and never after", async () => {
    await keys.issue({ hash: "h1", tenantId: "t-me", ownerAgentId: "u-me", label: "ci" });
    const r = await keys.lookup("h1");
    assert(r?.tenantId === "t-me" && r.ownerAgentId === "u-me", `lookup ${JSON.stringify(r)}`);
    assert((await keys.lookup("nope")) === null, "an unknown hash resolved");
    assert((await keys.revoke("h1")) === true, "revoking a live key reported nothing");
    assert((await keys.lookup("h1")) === null, "a revoked key still resolves");
    assert((await keys.revoke("h1")) === false, "revoking twice reported a revoke");
    const { results } = await db.prepare("SELECT label, created_at, revoked_at FROM api_keys WHERE hash = 'h1'").all();
    const row = (results as any[])[0];
    assert(row?.label === "ci" && Number(row.revoked_at) > Number(row.created_at), `the revoked row: ${JSON.stringify(row)}`);
  });

  add("a hash issued twice is refused, not silently re-pointed at another owner", async () => {
    await keys.issue({ hash: "h2", tenantId: "t-a", ownerAgentId: "u-a", label: "one" });
    let threw = false;
    try { await keys.issue({ hash: "h2", tenantId: "t-b", ownerAgentId: "u-b", label: "two" }); } catch { threw = true; }
    assert(threw, "a second issue of the same hash succeeded");
    const r = await keys.lookup("h2");
    assert(r?.tenantId === "t-a" && r.ownerAgentId === "u-a", `the first owner was replaced: ${JSON.stringify(r)}`);
  });

  add("an owner's keys are listed newest first, revoked ones with their time, and nobody else's", async () => {
    await keys.issue({ hash: "k1", tenantId: "t", ownerAgentId: "u-me", label: "first" });
    await keys.issue({ hash: "k2", tenantId: "t", ownerAgentId: "u-me", label: "second" });
    await keys.issue({ hash: "k3", tenantId: "t", ownerAgentId: "u-other", label: "theirs" });
    await keys.issue({ hash: "k4", tenantId: "t-2", ownerAgentId: "u-me", label: "same owner id, other tenant" });
    await keys.revoke("k1");
    const rows = await keys.list({ tenantId: "t", ownerAgentId: "u-me" });
    assert(rows.map((r) => r.hash).join() === "k2,k1", `listed ${rows.map((r) => r.hash)}`);
    assert(rows[0]!.label === "second" && rows[0]!.revokedAt === null, `the live key: ${JSON.stringify(rows[0])}`);
    assert(Number(rows[1]!.revokedAt) > rows[1]!.createdAt, `the revoked key: ${JSON.stringify(rows[1])}`);
    assert((await keys.list({ tenantId: "t", ownerAgentId: "u-nobody" })).length === 0, "an owner with no keys listed some");
  });

  add("the live-key limit holds for requests at the same time, and a revoke makes room", async () => {
    const me = { tenantId: "t", ownerAgentId: "u-me" };
    await keys.issue({ hash: "theirs", tenantId: "t", ownerAgentId: "u-other", label: "not counted" });
    const tries = await Promise.all(Array.from({ length: 5 }, (_, i) => keys.issueWithin({ ...me, hash: `c${i}`, label: `c${i}` }, 3)));
    const live = (await keys.list(me)).filter((k) => k.revokedAt === null);
    assert(tries.filter(Boolean).length === 3 && live.length === 3, `issued ${tries.filter(Boolean).length}, live ${live.length}`);
    assert((await keys.issueWithin({ ...me, hash: "over", label: "over" }, 3)) === false && (await keys.lookup("over")) === null, "a key past the limit was issued");
    await keys.revokeOwned(live[0]!.hash, me);
    assert((await keys.issueWithin({ ...me, hash: "after", label: "after" }, 3)) === true, "a revoked key still counted against the limit");
  });

  add("revokes and creates at the same time never leave more live keys than the limit", async () => {
    const me = { tenantId: "t", ownerAgentId: "u-me" };
    for (let i = 0; i < 3; i++) await keys.issue({ ...me, hash: `r${i}`, label: `r${i}` });
    // At the limit: one revoke and four creates race. Whatever order D1 runs them in, one create at most fits.
    const [revoked, ...created] = await Promise.all([
      keys.revokeOwned("r0", me),
      ...Array.from({ length: 4 }, (_, i) => keys.issueWithin({ ...me, hash: `n${i}`, label: `n${i}` }, 3)),
    ]);
    const live = (await keys.list(me)).filter((k) => k.revokedAt === null).length;
    assert(revoked === true, "the revoke did not happen");
    assert(created.filter(Boolean).length <= 1 && live <= 3, `created ${created.filter(Boolean).length}, live ${live}`);
    assert(live === 3 - 1 + created.filter(Boolean).length, `live ${live} does not match what was revoked and created`);
  });

  add("a person revokes only their own key", async () => {
    await keys.issue({ hash: "k5", tenantId: "t", ownerAgentId: "u-other", label: "theirs" });
    assert((await keys.revokeOwned("k5", { tenantId: "t", ownerAgentId: "u-me" })) === false, "revoked another owner's key");
    assert((await keys.revokeOwned("k5", { tenantId: "t-2", ownerAgentId: "u-other" })) === false, "revoked it from another tenant");
    assert((await keys.lookup("k5")) !== null, "a refused revoke still stopped the key");
    assert((await keys.revokeOwned("k5", { tenantId: "t", ownerAgentId: "u-other" })) === true, "the owner could not revoke it");
    assert((await keys.lookup("k5")) === null, "a revoked key still resolves");
    assert((await keys.revokeOwned("k5", { tenantId: "t", ownerAgentId: "u-other" })) === false, "revoking twice reported a revoke");
  });

  add("service_tokens has exactly the columns the token queries read", async () => {
    const { results } = await db.prepare("PRAGMA table_info(service_tokens)").all();
    const names = (results as any[]).map((r) => String(r.name)).sort().join(",");
    assert(names === "agent_id,created_at,hash,label,last_used_at,revoked_at,tenant_id", `columns ${names}`);
  });

  add("a service token resolves to its identity until it is revoked; the listing keeps it and says when", async () => {
    clock = 1_800_000_000_000;
    await tokens.issue({ hash: "s1", label: "nightly", tenantId: "demo", agentId: "u-nightly" });
    clock += 1;
    await tokens.issue({ hash: "s2", label: "probe", tenantId: "t-2", agentId: "u-probe" });
    const got = await tokens.lookup("s1");
    assert(got?.label === "nightly" && got.tenantId === "demo" && got.agentId === "u-nightly", `lookup ${JSON.stringify(got)}`);
    assert((await tokens.lookup("s9")) === null, "an absent token resolved");
    clock += 1;
    assert((await tokens.revoke("s1")) === true, "the first revoke did not report");
    assert((await tokens.revoke("s1")) === false, "a second revoke reported again");
    assert((await tokens.lookup("s1")) === null, "a revoked token still resolves");
    assert((await tokens.lookup("s2"))?.label === "probe", "revoking one token touched another");
    const list = await tokens.list();
    assert(list.map((t) => t.hash).join(",") === "s2,s1", `order ${list.map((t) => t.hash).join(",")}`);
    const s1 = list.find((t) => t.hash === "s1")!;
    assert(s1.revokedAt === 1_800_000_000_002 && s1.createdAt === 1_800_000_000_000 && s1.lastUsedAt === null, `s1 ${JSON.stringify(s1)}`);
  });

  add("touch records a use at most once an hour, and never for a revoked token's past", async () => {
    clock = 1_800_000_000_000;
    await tokens.issue({ hash: "s3", label: "cron", tenantId: "demo", agentId: "u-cron" });
    await tokens.touch("s3");
    const first = (await tokens.list())[0]!.lastUsedAt;
    assert(first === clock, `first touch ${first}`);
    clock += 1000;
    await tokens.touch("s3");
    assert((await tokens.list())[0]!.lastUsedAt === first, "a touch within the hour wrote");
    clock += 3600_000;
    await tokens.touch("s3");
    assert((await tokens.list())[0]!.lastUsedAt === clock, "a touch after an hour did not write");
    await tokens.touch("s9");
  });

  add("a connection is kept per agent and provider, replaced by a reconnect, and removed; a connect link is spent once", async () => {
    const c = d1Connections(db);
    await c.put({ tenantId: "t", raftAgentId: "a1", provider: "github", account: "octocat", connectedBy: "u1", connectedAt: 1000 });
    await c.put({ tenantId: "t", raftAgentId: "a1", provider: "github", account: "hubot", connectedBy: "u2", connectedAt: 2000 });
    const got = await c.get("t", "a1", "github");
    assert(got?.account === "hubot" && got.connectedBy === "u2" && got.connectedAt === 2000, `reconnect: ${JSON.stringify(got)}`);
    assert((await c.get("t", "a2", "github")) === null && (await c.get("t2", "a1", "github")) === null, "a connection leaked across agents or tenants");
    assert((await c.remove("t", "a1", "github")) === true && (await c.get("t", "a1", "github")) === null, "remove");
    assert((await c.remove("t", "a1", "github")) === false, "removing twice said it removed something");
    assert((await c.consumeLink("n1", 1)) === true && (await c.consumeLink("n1", 2)) === false, "a link was spent twice");
    const cols = async (t: string) => ((await db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all()).results as any[]).map((r) => r.name).sort().join(",");
    assert((await cols("provisioned_connections")) === "account,connected_at,connected_by,provider,raft_agent_id,tenant_id", `provisioned_connections ${await cols("provisioned_connections")}`);
    assert((await cols("connect_links")) === "nonce,used_at", `connect_links ${await cols("connect_links")}`);
  });

  add("provider_tokens and provisioned_agents have exactly the columns their queries read", async () => {
    const cols = async (table: string) => ((await db.prepare(`PRAGMA table_info(${table})`).all()).results as any[]).map((r) => String(r.name)).sort().join(",");
    assert((await cols("provider_tokens")) === "created_at,hash,label,last_used_at,raft_origin,revoked_at,scope,tenant_id", `provider_tokens ${await cols("provider_tokens")}`);
    assert((await cols("provisioned_agents")) === "agent_id,created_at,credential_hash,deleted_at,instructions,name,push_error,push_registered,raft_agent_id,raft_origin,raft_server_id,status,tenant_id,updated_at",
      `provisioned_agents ${await cols("provisioned_agents")}`);
  });

  add("a provider token resolves to its tenant and origin until it is revoked; touch writes once an hour", async () => {
    clock = 1_800_000_000_000;
    await provider.issue({ hash: "p1", label: "raft-prod", scope: "tenant", tenantId: "t-raft", raftOrigin: "https://api.raft.build" });
    const got = await provider.lookup("p1");
    assert(got?.scope === "tenant" && got.tenantId === "t-raft" && got.raftOrigin === "https://api.raft.build" && got.label === "raft-prod", `lookup ${JSON.stringify(got)}`);
    await provider.issue({ hash: "p2", label: "raft-deployment", scope: "platform", raftOrigin: "https://api-aws-staging.botiverse.dev" });
    const platform = await provider.lookup("p2");
    assert(platform?.scope === "platform" && !("tenantId" in platform) && platform.raftOrigin === "https://api-aws-staging.botiverse.dev", `platform ${JSON.stringify(platform)}`);
    const row: any = await db.prepare("SELECT scope, tenant_id FROM provider_tokens WHERE hash = 'p2'").first();
    assert(row.scope === "platform" && row.tenant_id === null, `stored ${JSON.stringify(row)}`);
    assert((await provider.lookup("p9")) === null, "an absent token resolved");
    await provider.touch("p1");
    const first = (await provider.list())[0]!;
    assert(first.lastUsedAt === clock, `first touch ${first.lastUsedAt}`);
    clock += 60_000;
    await provider.touch("p1");
    assert((await provider.list())[0]!.lastUsedAt === first.lastUsedAt, "a touch within the hour wrote");
    clock += 3_600_001;
    await provider.touch("p1");
    assert((await provider.list())[0]!.lastUsedAt === clock, "a touch after an hour did not write");
    assert((await provider.revoke("p1")) === true && (await provider.revoke("p1")) === false, "revoke did not report once");
    assert((await provider.lookup("p1")) === null, "a revoked token still resolves");
    assert((await provider.list())[0]!.revokedAt === clock, "the listing lost the revocation");
  });

  add("the registry keeps one row per Raft agent, finds it by either id, refuses a second claim on an agent id, and patches only what it is given", async () => {
    clock = 1_800_000_000_000;
    const base = { tenantId: "t-raft", raftAgentId: "01J", agentId: "raft_01J", raftServerId: "srv", raftOrigin: "https://api.raft.build",
      name: "Cody", instructions: "be brief", credentialHash: null, status: "provisioning" as const, pushRegistered: false, pushError: null };
    await registry.create(base);
    const byRaft = await registry.get("t-raft", "01J");
    const byAgent = await registry.getByAgentId("t-raft", "raft_01J");
    assert(byRaft && byAgent && JSON.stringify(byRaft) === JSON.stringify(byAgent), "the two lookups disagree");
    assert(byRaft!.createdAt === clock && byRaft!.updatedAt === clock && byRaft!.deletedAt === null && byRaft!.pushRegistered === false, JSON.stringify(byRaft));
    assert((await registry.get("t-other", "01J")) === null, "another tenant saw the row");
    let threw = false;
    try { await registry.create({ ...base, raftAgentId: "01J/x" }); } catch { threw = true; }
    assert(threw, "a second Raft id claimed the same agent id");
    clock += 5;
    assert((await registry.update("t-raft", "01J", { status: "active", pushRegistered: true, credentialHash: "ab".repeat(32) })) === true, "update did not report");
    const after = await registry.get("t-raft", "01J");
    assert(after!.status === "active" && after!.pushRegistered === true && after!.name === "Cody" && after!.credentialHash === "ab".repeat(32) && after!.updatedAt === clock && after!.createdAt === clock - 5, JSON.stringify(after));
    clock += 5;
    await registry.update("t-raft", "01J", { status: "deleted", deletedAt: clock, pushError: "disable_push: gone" });
    const gone = await registry.get("t-raft", "01J");
    assert(gone!.status === "deleted" && gone!.deletedAt === clock && gone!.pushError === "disable_push: gone" && gone!.pushRegistered === true, JSON.stringify(gone));
    assert((await registry.update("t-raft", "nope", { name: "x" })) === false, "an absent row reported a change");
  });

  return cases;
}
