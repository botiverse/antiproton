/**
 * The ledger: what was used, by whom, as it happened.
 *
 * Run against real SQLite rather than a fake, because the interesting parts are
 * the ones a fake would paper over: that a retried `opened` is one container,
 * that an unreleased one is still counted, and that a `closed` with no `opened`
 * is kept rather than dropped.
 */
import { DatabaseSync } from "node:sqlite";
import { Ledger, intervals, secondsOf, usage } from "../src/store/ledger.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

/** The Durable Object's `sql` shape, over node:sqlite. */
function sqlOf(db: DatabaseSync) {
  return {
    exec(query: string, ...bindings: unknown[]) {
      const st = db.prepare(query);
      const rows = /^\s*select/i.test(query) ? (st.all(...(bindings as any[])) as any[]) : (st.run(...(bindings as any[])), []);
      return { toArray: () => rows };
    },
  };
}

let clock = 1_000_000;
const fresh = () => new Ledger(sqlOf(new DatabaseSync(":memory:")), () => clock);
const A = { tenantId: "t-a", agentId: "a1", alias: "sandbox" };
const B = { tenantId: "t-b", agentId: "b1", alias: "sandbox" };
const open = (ref: string) => ({ kind: "container", event: "opened" as const, ref });
const close = (ref: string) => ({ kind: "container", event: "closed" as const, ref });

check("关掉的盒子是一段有头有尾的区间,行一条也没少", () => {
  const l = fresh();
  l.append(A, open("b-1"));
  clock += 60_000;
  l.append(A, close("b-1"));

  if (l.since(0).length !== 2) throw new Error(`two events became ${l.since(0).length} rows`);
  const [i] = intervals(l.since(0));
  if (!i || i.openedAt === null || i.closedAt === null) throw new Error(`not a closed interval: ${JSON.stringify(i)}`);
  if (secondsOf(i, clock) !== 60) throw new Error(`60s of container read as ${secondsOf(i, clock)}`);
});

check("没归还的盒子照样计入,而且是最值得看的那一行", () => {
  const l = fresh();
  l.append(A, open("b-leaked"));
  clock += 3_600_000;
  const [i] = intervals(l.since(0));
  if (i!.closedAt !== null) throw new Error("an unreleased box was reported as finished");
  if (secondsOf(i!, clock) !== 3600) throw new Error(`an open box counted ${secondsOf(i!, clock)}s instead of 3600`);
  const [line] = usage(l.since(0), clock);
  if (line!.open !== 1 || line!.seconds !== 3600) throw new Error(`the summary hid it: ${JSON.stringify(line)}`);
});

check("重试的 opened 还是一个盒子", () => {
  // The plugin's create-conflict path is a retry; an audit that counts retries
  // is not a record of what happened.
  const l = fresh();
  l.append(A, open("b-1"));
  l.append(A, open("b-1"));
  clock += 1_000;
  l.append(A, close("b-1"));
  l.append(A, close("b-1"));
  if (l.since(0).length !== 2) throw new Error(`retries were stored: ${l.since(0).length} rows`);
});

check("只有 closed 没有 opened 的,留着,并且被数出来", () => {
  // The known gap: run9 creates the box before the plugin has its id, so a
  // lost `opened` leaves only the end. Dropping it would make the gap invisible.
  const l = fresh();
  l.append(A, close("b-orphan"));
  const [i] = intervals(l.since(0));
  if (!i) throw new Error("a closed-only resource was dropped");
  if (i.openedAt !== null) throw new Error("a start was invented");
  const [line] = usage(l.since(0), clock);
  if (line!.unstarted !== 1) throw new Error(`the gap was not counted: ${JSON.stringify(line)}`);
});

check("一次说完的量按量加,不配对", () => {
  const l = fresh();
  l.append(A, { kind: "tokens", event: "closed", ref: "m-1", quantity: 120, unit: "token" });
  l.append(A, { kind: "tokens", event: "closed", ref: "m-1", quantity: 30, unit: "token" });
  if (intervals(l.since(0)).length !== 0) throw new Error("a one-shot quantity became an interval");
  const [line] = usage(l.since(0), clock);
  if (line!.quantity !== 150 || line!.unit !== "token") throw new Error(`quantities: ${JSON.stringify(line)}`);
});

check("汇总按租户,只有量,没有钱", () => {
  const l = fresh();
  l.append(A, open("b-a1")); l.append(A, open("b-a2")); l.append(B, open("b-b1"));
  clock += 10_000;
  l.append(A, close("b-a1"));
  clock += 10_000;

  const lines = usage(l.since(0), clock);
  const a = lines.find((x) => x.tenantId === "t-a")!;
  if (a.intervals !== 2 || a.open !== 1) throw new Error(`t-a: ${JSON.stringify(a)}`);
  if (a.seconds !== 10 + 20) throw new Error(`t-a seconds: ${a.seconds}`);
  if (lines.find((x) => x.tenantId === "t-b")!.intervals !== 1) throw new Error("t-b's box was not its own");
  // No price, no rate, no total in money — deliberately.
  if ("cost" in (a as any) || "price" in (a as any)) throw new Error("the ledger priced something");
});

console.log(`\n  The ledger\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
