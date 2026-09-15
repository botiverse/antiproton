/**
 * The control plane's queries on real D1 (task #18). Run inside workerd by cf/src/conformance.ts
 * against a local database the migrations in cf/migrations were applied to; see
 * test/control-plane-d1.sh. Each case starts from an empty table.
 */
import { d1Identities } from "../../cf/src/control-plane.ts";

export interface SpecCase { name: string; run(): Promise<void> }

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

export function controlPlaneCases(db: D1Database): SpecCase[] {
  const dir = d1Identities(db);
  const wipe = () => db.prepare("DELETE FROM identities").run();
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

  return cases;
}
