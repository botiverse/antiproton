/**
 * The control plane's queries on real D1 (task #18). Run inside workerd by cf/src/conformance.ts
 * against a local database the migrations in cf/migrations were applied to; see
 * test/control-plane-d1.sh. Each case starts from an empty table.
 */
import { d1ApiKeys, d1Identities, d1InboundHooks } from "../../cf/src/control-plane.ts";

export interface SpecCase { name: string; run(): Promise<void> }

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

export function controlPlaneCases(db: D1Database): SpecCase[] {
  const dir = d1Identities(db);
  let clock = 1_800_000_000_000;
  const keys = d1ApiKeys(db, () => ++clock);
  const hooks = d1InboundHooks(db, () => ++clock);
  const wipe = () => db.batch([db.prepare("DELETE FROM identities"), db.prepare("DELETE FROM api_keys"), db.prepare("DELETE FROM inbound_hooks"), db.prepare("DELETE FROM hook_grants")]);
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
    assert(names === "activated_at,agent_id,alias,created_at,hook_id,revoked_at,tenant_id", `columns ${names}`);
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

  add("hook_grants has exactly the columns the grant queries read", async () => {
    const { results } = await db.prepare("PRAGMA table_info(hook_grants)").all();
    const names = (results as any[]).map((r) => String(r.name)).sort().join(",");
    assert(names === "created_at,expires_at,grant_hash,hook_id,nonce,outcome,used_at,version", `columns ${names}`);
  });

  add("a pending hook does not resolve until its first secret is stored, and can be revoked while it waits", async () => {
    await hooks.create({ hookId: "p1", tenantId: "t-1", agentId: "a-1", alias: "raft" }, { pending: true });
    assert((await hooks.lookup("p1")) === null, "a pending hook resolved");
    const live = await hooks.lookupLive("p1");
    assert(live?.pending === true && live.alias === "raft", `lookupLive ${JSON.stringify(live)}`);
    assert((await hooks.activate("p1")) === true, "activate did nothing");
    assert((await hooks.activate("p1")) === false, "a second activate reported a change");
    assert((await hooks.lookup("p1"))?.agentId === "a-1", "an activated hook does not resolve");
    await hooks.create({ hookId: "p2", tenantId: "t-1", agentId: "a-1", alias: "raft" }, { pending: true });
    assert((await hooks.revoke("p2"))?.hookId === "p2", "a pending hook could not be revoked");
    assert((await hooks.activate("p2")) === false && (await hooks.lookupLive("p2")) === null, "a revoked pending hook came back");
    const plain = await hooks.create({ hookId: "g1", tenantId: "t-1", agentId: "a-1", alias: "gh" });
    assert(plain === undefined && (await hooks.lookup("g1"))?.alias === "gh", "a hook created with its secret did not resolve at once");
  });

  add("a grant writes once, only for its hook, version and nonce, and only before it expires", async () => {
    const t0 = clock;
    await hooks.grant({ grantHash: "g", hookId: "h1", version: 1, nonce: "n", expiresAt: t0 + 1_000 });
    assert((await hooks.grantState("g", "h1"))?.state === "unused", "a fresh grant is not unused");
    assert((await hooks.grantState("g", "h2")) === null, "a grant read back for another hook");
    assert((await hooks.useGrant("g", "h2", 1, "n")) === null, "used for another hook");
    assert((await hooks.useGrant("g", "h1", 2, "n")) === null, "used for another version");
    assert((await hooks.useGrant("g", "h1", 1, "m")) === null, "used with another nonce");
    assert((await hooks.useGrant("x", "h1", 1, "n")) === null, "an unknown grant was used");
    assert((await hooks.useGrant("g", "h1", 1, "n"))?.version === 1, "the right write was refused");
    assert((await hooks.useGrant("g", "h1", 1, "n")) === null, "a grant wrote twice");
    assert((await hooks.grantState("g", "h1"))?.state === "in_progress", "a used, unfinished grant");
    await hooks.finishGrant("g", "stored");
    await hooks.finishGrant("g", "something later");
    const st = await hooks.grantState("g", "h1");
    assert(st?.state === "stored" && st.reason === null && st.usedAt !== null, `finished ${JSON.stringify(st)}`);
    await hooks.grant({ grantHash: "f", hookId: "h1", version: 2, nonce: "n", expiresAt: clock + 1_000 });
    await hooks.useGrant("f", "h1", 2, "n");
    await hooks.finishGrant("f", "no mount named raft");
    const failed = await hooks.grantState("f", "h1");
    assert(failed?.state === "failed" && failed.reason === "no mount named raft", `failed ${JSON.stringify(failed)}`);
    assert((await hooks.useGrant("f", "h1", 2, "n")) === null, "a failed grant wrote again");
    await hooks.grant({ grantHash: "e", hookId: "h1", version: 3, nonce: "n", expiresAt: clock + 2 });
    clock += 10;
    assert((await hooks.useGrant("e", "h1", 3, "n")) === null, "an expired grant was used");
    assert((await hooks.grantState("e", "h1"))?.state === "expired", "an expired grant did not say so");
    assert((await hooks.finishGrant("e", "stored")) === undefined && (await hooks.grantState("e", "h1"))?.state === "expired",
      "an unused grant was finished");
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

  return cases;
}
