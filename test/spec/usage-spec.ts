/**
 * The tenant's hourly usage on real D1, with a real Durable Object's SQLite as
 * the agent's outbox (cf/src/usage-d1.ts, src/usage/outbox.ts). Run inside
 * workerd by cf/src/conformance.ts; see test/control-plane-d1.sh.
 */
import { flushUsage, readUsage, sendUsage, usageCursor, DAY_MS } from "../../cf/src/usage-d1.ts";
import { appendUsage, pendingUsage, type OutboxRow } from "../../src/usage/outbox.ts";
import type { SpecCase } from "./control-plane-spec.ts";

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

type Sql = { exec(q: string, ...b: unknown[]): { toArray(): any[] } };
const H = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % DAY_MS); // a UTC midnight

export function usageCases(db: D1Database, sql: Sql): SpecCase[] {
  const wipe = async () => {
    await db.batch([db.prepare("DELETE FROM usage_hourly"), db.prepare("DELETE FROM usage_cursor")]);
    sql.exec("DROP TABLE IF EXISTS usage_outbox");
    sql.exec("DROP TABLE IF EXISTS usage_sent");
  };
  const cases: SpecCase[] = [];
  const add = (name: string, fn: () => Promise<void>) => cases.push({ name, run: async () => { await wipe(); await fn(); } });
  const row = (seq: number, over: Partial<OutboxRow> = {}): OutboxRow => ({
    seq, at: T0 + 10 * 60_000, tenantId: "t", agentId: "a", resource: "model.tokens", key: "m1:input", quantity: 10, unit: "tokens", ...over,
  });
  const sum = async (tenant = "t") => {
    const r: any = await db.prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM usage_hourly WHERE tenant_id = ?").bind(tenant).first();
    return Number(r.q);
  };

  add("the migration made exactly the columns the usage queries read", async () => {
    for (const [table, want] of [
      ["usage_hourly", "agent_id,hour,key,quantity,resource,tenant_id,unit"],
      ["usage_cursor", "agent_id,last_seq,tenant_id"],
      ["usage_prices", "credits_per_unit,effective_from,key,resource,unit"],
    ]) {
      const { results } = await db.prepare(`PRAGMA table_info(${table})`).all();
      const names = (results as any[]).map((r) => String(r.name)).sort().join(",");
      assert(names === want, `${table}: ${names}`);
    }
  });

  add("a send adds to the hour, and moves the cursor to the last row sent", async () => {
    assert(await sendUsage(db, "t", "a", 0, [row(1), row(2, { quantity: 5 }), row(3, { at: T0 + H + 1 })]), "first send refused");
    const { results } = await db.prepare("SELECT hour, quantity FROM usage_hourly ORDER BY hour").all();
    const got = (results as any[]).map((r) => `${Number(r.hour) - T0}:${Number(r.quantity)}`).join(",");
    assert(got === `0:15,${H}:10`, `hours ${got}`);
    assert((await usageCursor(db, "t", "a")) === 3, "cursor did not move");
    assert(await sendUsage(db, "t", "a", 3, [row(4, { quantity: 1 })]), "second send refused");
    assert((await sum()) === 26, `sum ${await sum()}`);
  });

  add("a send against a stale cursor counts nothing: a retry is never counted twice", async () => {
    assert(await sendUsage(db, "t", "a", 0, [row(1), row(2)]), "first send refused");
    assert(!(await sendUsage(db, "t", "a", 0, [row(1), row(2)])), "a repeated send was accepted");
    assert(!(await sendUsage(db, "t", "a", 1, [row(2)])), "a send behind the cursor was accepted");
    assert((await sum()) === 20 && (await usageCursor(db, "t", "a")) === 2, `sum ${await sum()}`);
  });

  add("two sends of the same rows at once: exactly one counts", async () => {
    const results = await Promise.all([sendUsage(db, "t", "a", 0, [row(1), row(2)]), sendUsage(db, "t", "a", 0, [row(1), row(2)])]);
    assert(results.filter(Boolean).length === 1, `accepted ${results.filter(Boolean).length}`);
    assert((await sum()) === 20, `sum ${await sum()}`);
  });

  add("one agent's send never counts rows for another agent or tenant", async () => {
    assert(await sendUsage(db, "t", "a", 0, [row(1), row(2, { agentId: "b" }), row(3, { tenantId: "u" })]), "refused");
    assert((await sum("t")) === 10 && (await sum("u")) === 0, `t ${await sum("t")}, u ${await sum("u")}`);
    assert((await usageCursor(db, "t", "b")) === 0, "another agent's cursor moved");
  });

  add("a key with two units keeps them apart", async () => {
    assert(await sendUsage(db, "t", "a", 0, [
      row(1, { resource: "tool.call", key: "github.issue_list:ok", quantity: 1, unit: "calls" }),
      row(2, { resource: "tool.call", key: "github.issue_list:ok", quantity: 250, unit: "ms" }),
    ]), "refused");
    const { results } = await db.prepare("SELECT unit, quantity FROM usage_hourly ORDER BY unit").all();
    assert((results as any[]).map((r) => `${r.unit}=${r.quantity}`).join(",") === "calls=1,ms=250", JSON.stringify(results));
  });

  add("flush sends the outbox, forgets what D1 took, and sends nothing twice", async () => {
    appendUsage(sql as any, [row(0), row(0, { quantity: 7 })].map(({ seq: _s, ...r }) => r));
    const first = await flushUsage(db, sql, "t", "a");
    assert(first.rows === 2 && first.counted, JSON.stringify(first));
    assert(pendingUsage(sql as any, 0).length === 0, "the outbox kept sent rows");
    const again = await flushUsage(db, sql, "t", "a");
    assert(again.rows === 0 && (await sum()) === 17, `again ${JSON.stringify(again)}, sum ${await sum()}`);
    appendUsage(sql as any, [{ ...row(0, { quantity: 3 }) }].map(({ seq: _s, ...r }) => r));
    await flushUsage(db, sql, "t", "a");
    assert((await sum()) === 20, `sum ${await sum()}`);
  });

  add("flush with a stale local cursor takes D1's, and drops what D1 already counted", async () => {
    appendUsage(sql as any, [row(0), row(0)].map(({ seq: _s, ...r }) => r));
    const pending = pendingUsage(sql as any, 0);
    // This object believes nothing was sent; another send already counted both rows, and it never heard back.
    sql.exec("CREATE TABLE IF NOT EXISTS usage_sent (id INTEGER PRIMARY KEY CHECK (id = 1), through_seq INTEGER NOT NULL)");
    sql.exec("INSERT INTO usage_sent(id, through_seq) VALUES (1, 0)");
    assert(await sendUsage(db, "t", "a", 0, pending), "setup send refused");
    const r = await flushUsage(db, sql, "t", "a");
    assert(!r.counted && (await sum()) === 20, `flush ${JSON.stringify(r)}, sum ${await sum()}`);
    assert(pendingUsage(sql as any, 0).length === 0, "rows D1 already had were kept");
  });

  add("a new object takes D1's cursor before sending, so rows D1 already has are not sent again", async () => {
    appendUsage(sql as any, [row(0), row(0)].map(({ seq: _s, ...r }) => r));
    assert(await sendUsage(db, "t", "a", 0, pendingUsage(sql as any, 0)), "setup send refused");
    const r = await flushUsage(db, sql, "t", "a");
    assert(r.rows === 0 && (await sum()) === 20 && pendingUsage(sql as any, 0).length === 0, `flush ${JSON.stringify(r)}, sum ${await sum()}`);
  });

  add("a read groups by hour or day, and by agent, model or tool", async () => {
    await sendUsage(db, "t", "a", 0, [
      row(1), row(2, { at: T0 + H + 5, key: "m2:output", quantity: 4 }),
      row(3, { at: T0 + DAY_MS + 1, quantity: 100 }),
      row(4, { resource: "tool.call", key: "github.issue_list:ok", quantity: 1, unit: "calls" }),
    ]);
    await sendUsage(db, "t", "b", 0, [row(1, { agentId: "b", quantity: 1 })]);
    await sendUsage(db, "u", "a", 0, [row(1, { tenantId: "u", quantity: 999 })]);
    const hourly = await readUsage(db, "t", { from: T0, to: T0 + DAY_MS, bucket: "1h", by: "total" });
    const h = hourly.map((r) => `${r.bucket - T0}/${r.resource}/${r.key}/${r.unit}=${r.quantity}`).join(" ");
    assert(h === `0/model.tokens/m1:input/tokens=11 0/tool.call/github.issue_list:ok/calls=1 ${H}/model.tokens/m2:output/tokens=4`, h);
    const daily = await readUsage(db, "t", { from: T0, to: T0 + 2 * DAY_MS, bucket: "1d", by: "model" });
    const d = daily.map((r) => `${(r.bucket - T0) / DAY_MS}/${r.group}/${r.key}=${r.quantity}`).join(" ");
    assert(d === "0/m1/m1:input=11 0/m2/m2:output=4 0//github.issue_list:ok=1 1/m1/m1:input=100", d);
    const byAgent = await readUsage(db, "t", { from: T0, to: T0 + H, bucket: "1h", by: "agent" });
    const a = byAgent.filter((r) => r.resource === "model.tokens").map((r) => `${r.group}=${r.quantity}`).sort().join(",");
    assert(a === "a=10,b=1", a);
    const byTool = await readUsage(db, "t", { from: T0, to: T0 + H, bucket: "1h", by: "tool" });
    assert(byTool.find((r) => r.resource === "tool.call")?.group === "github.issue_list", JSON.stringify(byTool));
  });

  return cases;
}
