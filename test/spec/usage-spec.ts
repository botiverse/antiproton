/**
 * The tenant's hourly usage on real D1, with a real Durable Object's SQLite as
 * the agent's outbox (cf/src/usage-d1.ts, src/usage/outbox.ts). Run inside
 * workerd by cf/src/conformance.ts; see test/control-plane-d1.sh.
 */
import { flushUsage, foldUsage, parseUsageQuery, priceFor, readUsage, sendUsage, usageCursor, usageFirstHours, usageGroup, DAY_MS, KEEP_HOURLY_DAYS, USAGE_WINDOWS, type UsageQuery } from "../../cf/src/usage-d1.ts";
import { appendUsage, pendingUsage, type OutboxRow } from "../../src/usage/outbox.ts";
import type { SpecCase } from "./control-plane-spec.ts";

function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

type Sql = { exec(q: string, ...b: unknown[]): { toArray(): any[] } };
const H = 3_600_000;
const T0 = 1_800_000_000_000 - (1_800_000_000_000 % DAY_MS); // a UTC midnight

export function usageCases(db: D1Database, sql: Sql): SpecCase[] {
  const wipe = async () => {
    await db.batch([db.prepare("DELETE FROM usage_hourly"), db.prepare("DELETE FROM usage_daily"), db.prepare("DELETE FROM usage_cursor"), db.prepare("DELETE FROM usage_prices")]);
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
  const dailySum = async (tenant = "t") => {
    const r: any = await db.prepare("SELECT COALESCE(SUM(quantity), 0) AS q FROM usage_daily WHERE tenant_id = ?").bind(tenant).first();
    return Number(r.q);
  };
  const hours = async (tenant = "t") => {
    const { results } = await db.prepare("SELECT hour FROM usage_hourly WHERE tenant_id = ? ORDER BY hour").bind(tenant).all();
    return (results as any[]).map((r) => (Number(r.hour) - T0) / H);
  };

  add("the migration made exactly the columns the usage queries read", async () => {
    for (const [table, want] of [
      ["usage_hourly", "agent_id,hour,key,quantity,resource,tenant_id,unit"],
      ["usage_daily", "agent_id,day,key,quantity,resource,tenant_id,unit"],
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

  add("a window whose record was damaged reads as a lower bound, and a whole one carries no flag", async () => {
    await sendUsage(db, "t", "a", 0, [
      row(1, { at: T0, resource: "sandbox.container", key: "sandbox", quantity: 60, unit: "seconds" }),
      row(2, { at: T0 + H, resource: "sandbox.container", key: "sandbox", quantity: 1, unit: "unreadable" }),
      row(3, { at: T0 + 2 * H, resource: "sandbox.container", key: "sandbox", quantity: 30, unit: "seconds" }),
    ]);
    const damaged = await readUsage(db, "t", { window: "custom", from: T0, to: T0 + 2 * H, bucket: "1h", by: "total" });
    assert(damaged.partial === true, "the window containing the marker says it is a lower bound");
    const whole = await readUsage(db, "t", { window: "custom", from: T0 + 2 * H, to: T0 + 4 * H, bucket: "1h", by: "total" });
    assert(whole.rows.some((r) => r.resource === "sandbox.container"), "the clean window is not empty — it holds real seconds");
    assert(!("partial" in whole), "a clean window carries no flag, rather than a false one");
    await sendUsage(db, "u", "b", 0, [row(1, { tenantId: "u", agentId: "b", at: T0 + 3 * H, resource: "sandbox.container", key: "sandbox", quantity: 1, unit: "unreadable" })]);
    const mine = await readUsage(db, "t", { window: "custom", from: T0 + 2 * H, to: T0 + 4 * H, bucket: "1h", by: "total" });
    assert(!("partial" in mine), "another tenant's damage is not this tenant's flag");
    const theirs = await readUsage(db, "u", { window: "custom", from: T0 + 2 * H, to: T0 + 4 * H, bucket: "1h", by: "total" });
    assert(theirs.partial === true, "and it is theirs");
  });

  // A day old enough to fold, a day that is not, and a `now` that sits between
  // them: 40 days of ledger, of which the last 35 keep their hours.
  const OLD = T0, OLDER_STILL = T0 - DAY_MS, YOUNG = T0 + 39 * DAY_MS, NOW = T0 + 40 * DAY_MS;

  add("a fold moves whole days into the days table and leaves the young hours alone", async () => {
    await sendUsage(db, "t", "a", 0, [
      row(1, { at: OLDER_STILL + 3 * H, quantity: 1 }),
      row(2, { at: OLD + 2 * H, quantity: 10 }),
      row(3, { at: OLD + 20 * H, quantity: 100 }),
      row(4, { at: YOUNG + H, quantity: 1000 }),
    ]);
    const before = await sum();
    const { days, hours: moved } = await foldUsage(db, NOW);
    assert(days.length === 2 && days[0] === OLDER_STILL && days[1] === OLD, `days ${JSON.stringify(days.map((d) => (d - T0) / DAY_MS))}`);
    assert(moved === 3, `hours moved ${moved}`);
    // The young day still has its hour, and only it.
    assert((await hours()).join(",") === String(39 * 24 + 1), `hours left ${(await hours()).join(",")}`);
    // Nothing was gained or lost, only moved.
    assert((await sum()) === 1000 && (await dailySum()) === 111, `hourly ${await sum()}, daily ${await dailySum()}`);
    assert((await sum()) + (await dailySum()) === before, `total changed: ${before} -> ${(await sum()) + (await dailySum())}`);
    // One row per (day, resource, key, unit): the two hours of OLD became one day.
    const { results } = await db.prepare("SELECT day, quantity FROM usage_daily ORDER BY day").all();
    const d = (results as any[]).map((r) => `${(Number(r.day) - T0) / DAY_MS}=${Number(r.quantity)}`).join(",");
    assert(d === "-1=1,0=110", d);
  });

  add("folding twice counts nothing twice: the second run has nothing to move", async () => {
    // The property the whole design turns on. It holds because a fold MOVES
    // rows — insert and delete are one batch, so after it the hours it summed
    // are gone — and not because anything remembers that the day was folded.
    await sendUsage(db, "t", "a", 0, [row(1, { at: OLD + 2 * H, quantity: 10 }), row(2, { at: OLD + 5 * H, quantity: 7 })]);
    const first = await foldUsage(db, NOW);
    const after = await dailySum();
    const second = await foldUsage(db, NOW);
    assert(first.days.length === 1 && second.days.length === 0, `first ${first.days.length}, second ${second.days.length}`);
    assert(second.hours === 0 && (await dailySum()) === after && after === 17, `daily ${await dailySum()} (was ${after})`);
    assert((await sum()) === 0, `hours left ${await sum()}`);
  });

  add("a row that arrives for an already folded day is added to it, not lost and not doubled", async () => {
    await sendUsage(db, "t", "a", 0, [row(1, { at: OLD + 2 * H, quantity: 10 })]);
    await foldUsage(db, NOW);
    // Late: the agent's object was asleep, or a send was retried after the fold ran.
    await sendUsage(db, "t", "a", 1, [row(2, { at: OLD + 9 * H, quantity: 5 })]);
    // Before the next fold it is already counted, because a read sums both tables.
    const across = await read(OLD, OLD + DAY_MS, "1d", "total");
    assert(across.length === 1 && across[0]!.quantity === 15, JSON.stringify(across));
    await foldUsage(db, NOW);
    assert((await dailySum()) === 15 && (await sum()) === 0, `daily ${await dailySum()}, hourly ${await sum()}`);
    const again = await read(OLD, OLD + DAY_MS, "1d", "total");
    assert(again.length === 1 && again[0]!.quantity === 15, JSON.stringify(again));
  });

  add("a window that reaches past the fold reads the same totals it did before", async () => {
    await sendUsage(db, "t", "a", 0, [
      row(1, { at: OLD + 2 * H, quantity: 10 }),
      row(2, { at: OLD + 5 * H, resource: "tool.call", key: "github.issue_list", quantity: 2, unit: "calls" }),
      row(3, { at: YOUNG + H, quantity: 1000 }),
    ]);
    const shape = (rows: Awaited<ReturnType<typeof read>>) =>
      rows.map((r) => `${(r.bucket - T0) / DAY_MS}/${r.resource}/${r.key}/${r.unit}=${r.quantity}`).join(" ");
    const before = shape(await read(OLD, NOW, "1d", "total"));
    await foldUsage(db, NOW);
    const after = shape(await read(OLD, NOW, "1d", "total"));
    assert(before === after, `the fold changed a read:\n  before ${before}\n  after  ${after}`);
    assert(after.includes("0/model.tokens/m1:input/tokens=10") && after.includes("39/model.tokens/m1:input/tokens=1000"), after);
    // And grouping still works over folded rows: the agent is kept per day.
    await sendUsage(db, "t", "b", 0, [row(1, { agentId: "b", at: OLD + 3 * H, quantity: 3 })]);
    await foldUsage(db, NOW);
    const byAgent = await read(OLD, OLD + DAY_MS, "1d", "agent");
    const g = byAgent.filter((r) => r.resource === "model.tokens").map((r) => `${r.group}=${r.quantity}`).sort().join(",");
    assert(g === "a=10,b=3", g);
  });

  add("the record's first hour survives the fold", async () => {
    // usageFirstHours asking usage_hourly alone would report a record that
    // begins later every time a fold runs — and the page would tell a reader
    // that a resource started being counted on a day it was already counted.
    await sendUsage(db, "t", "a", 0, [
      row(1, { at: OLD + 2 * H, resource: "object.active", key: "", quantity: 30_000, unit: "ms" }),
      row(2, { at: YOUNG + H, resource: "object.active", key: "", quantity: 60_000, unit: "ms" }),
    ]);
    const before = (await usageFirstHours(db, "t"))["object.active"];
    await foldUsage(db, NOW);
    const after = (await usageFirstHours(db, "t"))["object.active"];
    assert(before === OLD + 2 * H, `before ${before}`);
    assert(after === OLD, `after the fold the record begins at the folded day, not at the youngest hour left: ${after}`);
    assert(after < YOUNG, "a fold must never move the beginning of the record forward");
  });

  add("hourly detail outlives every window the page offers", async () => {
    // Not a tuning constant. A folded day placed in an hourly bucket would sit
    // at 00:00Z as if the whole day had happened at midnight; that is only
    // harmless while no window the page offers can reach a folded day. Shorten
    // this below a window, or add a longer window, and the page has to say
    // something about it first — so this assertion is where that conversation
    // starts.
    const longest = Math.max(...Object.values(USAGE_WINDOWS));
    assert(KEEP_HOURLY_DAYS * DAY_MS > longest, `${KEEP_HOURLY_DAYS} days of hours does not cover a ${longest / DAY_MS}-day window`);
  });

  add("a fold keeps tenants apart", async () => {
    await sendUsage(db, "t", "a", 0, [row(1, { at: OLD + 2 * H, quantity: 10 })]);
    await sendUsage(db, "u", "a", 0, [row(1, { tenantId: "u", at: OLD + 2 * H, quantity: 7 })]);
    await foldUsage(db, NOW);
    assert((await dailySum("t")) === 10 && (await dailySum("u")) === 7, `t ${await dailySum("t")}, u ${await dailySum("u")}`);
    const { results } = await db.prepare("SELECT COUNT(*) AS n FROM usage_daily").all();
    assert(Number((results as any[])[0]!.n) === 2, `one row per tenant: ${JSON.stringify(results)}`);
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
