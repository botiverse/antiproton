/**
 * The tenant's hourly usage on real D1, with a real Durable Object's SQLite as
 * the agent's outbox (cf/src/usage-d1.ts, src/usage/outbox.ts). Run inside
 * workerd by cf/src/conformance.ts; see test/control-plane-d1.sh.
 */
import { flushUsage, parseUsageQuery, priceFor, readUsage, sendUsage, usageCursor, usageFirstHours, usageGroup, DAY_MS, type UsageQuery } from "../../cf/src/usage-d1.ts";
import { appendUsage, pendingUsage, type OutboxRow } from "../../src/usage/outbox.ts";
import type { SpecCase } from "./control-plane-spec.ts";

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

type Sql = { exec(q: string, ...b: unknown[]): { toArray(): any[] } };
const H = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % DAY_MS); // a UTC midnight

export function usageCases(db: D1Database, sql: Sql): SpecCase[] {
  const wipe = async () => {
    await db.batch([db.prepare("DELETE FROM usage_hourly"), db.prepare("DELETE FROM usage_cursor"), db.prepare("DELETE FROM usage_prices")]);
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
      row(1, { resource: "tool.call", key: "github.issue_list", quantity: 1, unit: "calls" }),
      row(2, { resource: "tool.call", key: "github.issue_list", quantity: 250, unit: "ms" }),
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

  const read = (from: number, to: number, bucket: "1h" | "1d", by: UsageQuery["by"]) =>
    readUsage(db, "t", { window: "custom", from, to, bucket, by }).then((r) => r.rows);

  add("a read groups by hour or day, and by agent, model or tool", async () => {
    await sendUsage(db, "t", "a", 0, [
      row(1), row(2, { at: T0 + H + 5, key: "m2:output", quantity: 4 }),
      row(3, { at: T0 + DAY_MS + 1, quantity: 100 }),
      row(4, { resource: "tool.call", key: "github.issue_list", quantity: 1, unit: "calls" }),
      row(5, { resource: "js.run", key: "run_js", quantity: 1, unit: "runs" }),
    ]);
    await sendUsage(db, "t", "b", 0, [row(1, { agentId: "b", quantity: 1 })]);
    await sendUsage(db, "u", "a", 0, [row(1, { tenantId: "u", quantity: 999 })]);
    const hourly = await read(T0, T0 + DAY_MS, "1h", "total");
    const h = hourly.map((r) => `${r.bucket - T0}/${r.group}/${r.resource}/${r.key}/${r.unit}=${r.quantity}`).join(" ");
    assert(h === `0/total/js.run/run_js/runs=1 0/total/model.tokens/m1:input/tokens=11 0/total/tool.call/github.issue_list/calls=1 ${H}/total/model.tokens/m2:output/tokens=4`, h);
    assert(hourly.every((r) => !("cost" in r)), "cost before any price");
    const daily = await read(T0, T0 + 2 * DAY_MS, "1d", "model");
    const d = daily.map((r) => `${(r.bucket - T0) / DAY_MS}/${r.group}/${r.key}=${r.quantity}`).join(" ");
    assert(d === "0//run_js=1 0/m1/m1:input=11 0/m2/m2:output=4 0//github.issue_list=1 1/m1/m1:input=100", d);
    const byAgent = await read(T0, T0 + H, "1h", "agent");
    const a = byAgent.filter((r) => r.resource === "model.tokens").map((r) => `${r.group}=${r.quantity}`).sort().join(",");
    assert(a === "a=10,b=1", a);
    const byTool = await read(T0, T0 + H, "1h", "tool");
    const t = byTool.map((r) => `${r.resource}:${r.group}`).sort().join(",");
    assert(t === "js.run:run_js,model.tokens:,tool.call:github.issue_list", t);
    // A window that starts mid-bucket still reads that whole bucket.
    const mid = await read(T0 + 30 * 60_000, T0 + H, "1h", "total");
    assert(mid.length === 3, `mid-hour window: ${mid.length}`);
  });

  add("once a price exists every row carries its cost, and a key with no price of its own falls back to the resource's *", async () => {
    await sendUsage(db, "t", "a", 0, [row(1, { quantity: 1000 }), row(2, { key: "m1:output", quantity: 10 }), row(3, { at: T0 + DAY_MS + 1, quantity: 1000 })]);
    await db.batch([
      db.prepare("INSERT INTO usage_prices VALUES ('model.tokens', '*', 'tokens', 0.001, 0)"),
      db.prepare("INSERT INTO usage_prices VALUES ('model.tokens', 'm1:input', 'tokens', 0.002, ?)").bind(T0),
      db.prepare("INSERT INTO usage_prices VALUES ('model.tokens', 'm1:input', 'tokens', 0.01, ?)").bind(T0 + DAY_MS),
    ]);
    const { rows, priced } = await readUsage(db, "t", { window: "custom", from: T0, to: T0 + 2 * DAY_MS, bucket: "1d", by: "total" });
    const c = rows.map((r) => `${(r.bucket - T0) / DAY_MS}/${r.key}=${r.cost}`).join(" ");
    assert(priced && c === "0/m1:input=2 0/m1:output=0.01 1/m1:input=10", `${priced} ${c}`);
  });

  add("a resource nobody priced reads null, not zero: the absence survives the read", async () => {
    // The case the suite above cannot reach. Its rows are all `model.tokens`,
    // so an unpriced key is still rescued by that resource's `*` price and
    // comes back as a number. A resource with no price at all has no fallback,
    // and `null` is the only answer that does not read as "free".
    await sendUsage(db, "t", "a", 0, [
      row(1, { quantity: 1000 }),
      row(2, { resource: "tool.call", key: "github.issue_list", quantity: 4, unit: "calls" }),
    ]);
    await db.prepare("INSERT INTO usage_prices VALUES ('model.tokens', '*', 'tokens', 0.001, 0)").run();
    const { rows, priced } = await readUsage(db, "t", { window: "custom", from: T0, to: T0 + DAY_MS, bucket: "1d", by: "total" });
    const c = rows.map((r) => `${r.resource}=${r.cost}`).sort().join(" ");
    assert(priced && c === "model.tokens=1 tool.call=null", `${priced} ${c}`);
    const call = rows.find((r) => r.resource === "tool.call")!;
    assert(call.cost === null && !(call.cost === 0), "an unpriced row is null, never 0");
  });

  add("the read says where each resource's record begins, so a window cannot look complete when it is not", async () => {
    // object.active started being recorded halfway through this window. Its
    // rows are real; the hours before them hold nothing, and nothing in the
    // rows themselves says which of "idle" or "not counted yet" that was.
    await sendUsage(db, "t", "a", 0, [
      row(1, { at: T0 + 1 * H, quantity: 100 }),
      row(2, { at: T0 + 5 * H, resource: "object.active", key: "", quantity: 30_000, unit: "ms" }),
      row(3, { at: T0 + 6 * H, resource: "object.active", key: "", quantity: 60_000, unit: "ms" }),
    ]);
    const first = await usageFirstHours(db, "t");
    assert(first["model.tokens"] === T0 + H && first["object.active"] === T0 + 5 * H, JSON.stringify(first));
    const { firstHours } = await readUsage(db, "t", { window: "custom", from: T0, to: T0 + 12 * H, bucket: "1h", by: "total" });
    assert(firstHours["object.active"] === T0 + 5 * H, `the read carries it: ${JSON.stringify(firstHours)}`);
    assert(firstHours["object.active"] > T0, "and it is later than this window's start, which is what the page tells the reader");
    // Another tenant's rows are not this tenant's first hour.
    await sendUsage(db, "u", "b", 0, [row(1, { tenantId: "u", agentId: "b", at: T0, resource: "object.active", key: "", quantity: 5, unit: "ms" })]);
    const mine = await usageFirstHours(db, "t");
    assert(mine["object.active"] === T0 + 5 * H, `still mine: ${JSON.stringify(mine)}`);
  });

  add("the query string: windows, default buckets, and refusals", async () => {
    const now = T0 + 5 * DAY_MS;
    const d = parseUsageQuery(new URLSearchParams(""), now);
    assert(typeof d === "object" && d.window === "24h" && d.bucket === "1h" && d.by === "total" && d.to === now && d.from === now - DAY_MS, JSON.stringify(d));
    const w = parseUsageQuery(new URLSearchParams("window=7d&by=agent"), now);
    assert(typeof w === "object" && w.bucket === "1d" && w.from === now - 7 * DAY_MS, JSON.stringify(w));
    for (const bad of ["window=1h", "bucket=5m", "by=plugin", "window=30d&bucket=hour"]) {
      assert(typeof parseUsageQuery(new URLSearchParams(bad), now) === "string", `accepted ${bad}`);
    }
    assert(usageGroup("tool", { agentId: "a", resource: "sandbox.container", key: "sandbox" }) === "sandbox", "sandbox group");
    assert(usageGroup("model", { agentId: "a", resource: "model.tokens", key: "vendor:model:input" }) === "vendor:model", "a model name with a colon");
    assert(priceFor([], { bucket: 0, resource: "r", key: "k", unit: "u" }) === null, "no price is free");
  });

  return cases;
}
