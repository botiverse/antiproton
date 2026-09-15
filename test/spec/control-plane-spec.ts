/**
 * The control plane's queries on real D1 (task #18). Run inside workerd by cf/src/conformance.ts
 * against a local database the migrations in cf/migrations were applied to; see
 * test/control-plane-d1.sh. Each case starts from an empty table.
 */
import { d1ApiKeys, d1Identities } from "../../cf/src/control-plane.ts";

export interface SpecCase { name: string; run(): Promise<void> }

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

export function controlPlaneCases(db: D1Database): SpecCase[] {
  const dir = d1Identities(db);
  let clock = 1_800_000_000_000;
  const keys = d1ApiKeys(db, () => ++clock);
  const wipe = () => db.batch([db.prepare("DELETE FROM identities"), db.prepare("DELETE FROM api_keys")]);
  const cases: SpecCase[] = [];
  const add = (name: string, fn: () => Promise<void>) => cases.push({ name, run: async () => { await wipe(); await fn(); } });

  add("the migration made exactly the columns the queries read", async () => {
    const { results } = await db.prepare("PRAGMA table_info(identities)").all();
    const names = (results as any[]).map((r) => String(r.name)).sort().join(",");
    assert(names === "added_by,agent_id,created_at,provider_key,tenant_id", `columns ${names}`);
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
