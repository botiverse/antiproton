/**
 * The ledger: who owns what, and what existed for how long.
 *
 * Run against real SQLite rather than a fake, because the interesting parts are
 * the ones a fake would paper over: that closing a box leaves the row, that an
 * unreleased box is still counted, and that a tenant's `owned` set contains
 * only its own ids.
 */
import { DatabaseSync } from "node:sqlite";
import { Ledger, secondsOf, usage, type BoxRow } from "../broker/src/ledger.ts";

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
const A = { tenantId: "t-a", agentId: "a1" };
const B = { tenantId: "t-b", agentId: "b1" };

check("一个租户只看得见自己的 id", () => {
  const l = fresh();
  l.boxCreated(A, "b-a"); l.boxCreated(B, "b-b");
  l.execCreated(A, "b-a", "x-a"); l.execCreated(B, "b-b", "x-b");
  l.snapCreated(A, "s-a");

  const a = l.owned("t-a");
  if (!a.boxes.has("b-a") || a.boxes.has("b-b")) throw new Error(`boxes leaked across tenants: ${[...a.boxes]}`);
  if (!a.execs.has("x-a") || a.execs.has("x-b")) throw new Error(`execs leaked across tenants: ${[...a.execs]}`);
  if (!a.snaps.has("s-a")) throw new Error("a snapshot the tenant made is not theirs");
});

check("盒子没了,行还在 —— 只是被关上", () => {
  // A deleted box that left no trace is the case an audit exists for.
  const l = fresh();
  l.boxCreated(A, "b-1");
  clock += 60_000;
  l.boxGone("b-1");

  if (l.owned("t-a").boxes.has("b-1")) throw new Error("a released box is still addressable");
  const [row] = l.since(0);
  if (!row) throw new Error("the row was deleted with the box");
  if (row.endedAt === null) throw new Error("the row was left open");
  if (secondsOf(row, clock) !== 60) throw new Error(`60s of container read as ${secondsOf(row, clock)}`);
});

check("没归还的盒子照样计入,而且是最值得看的那一行", () => {
  const l = fresh();
  l.boxCreated(A, "b-leaked");
  clock += 3_600_000;
  const [row] = l.since(0);
  if (row!.endedAt !== null) throw new Error("an unreleased box was reported as finished");
  if (secondsOf(row!, clock) !== 3600) throw new Error(`an open box counted ${secondsOf(row!, clock)}s instead of 3600`);
  // The plugin's own session list would show nothing at all here: it writes a
  // session only at release. That is the half the ledger exists to supply.
});

check("execs 记在盒子上,而且不重复计数", () => {
  const l = fresh();
  l.boxCreated(A, "b-1");
  l.execCreated(A, "b-1", "x-1");
  l.execCreated(A, "b-1", "x-2");
  l.execCreated(A, "b-1", "x-1"); // a retry of the same id
  const [row] = l.since(0);
  if (row!.execs !== 2) throw new Error(`a repeated exec id was counted twice: ${row!.execs}`);
});

check("汇总按租户,只有量,没有钱", () => {
  const l = fresh();
  l.boxCreated(A, "b-a1"); l.boxCreated(A, "b-a2"); l.boxCreated(B, "b-b1");
  clock += 10_000;
  l.boxGone("b-a1");
  clock += 10_000;

  const lines = usage(l.since(0), clock);
  const a = lines.find((x) => x.tenantId === "t-a")!;
  if (a.boxes !== 2 || a.open !== 1) throw new Error(`t-a: ${JSON.stringify(a)}`);
  if (a.seconds !== 10 + 20) throw new Error(`t-a seconds: ${a.seconds}`);
  // No price, no rate, no total in money — deliberately. A stored amount is
  // computed from the rate of the day it was written and is wrong from the
  // next rate change onwards, with nothing to say so.
  if ("cost" in (a as any) || "price" in (a as any)) throw new Error("the ledger priced something");
});

check("token 认得出来,而且认不出没发过的", () => {
  const l = fresh();
  l.issue("hash-a", "t-a", "a1", "cody, first key");
  const who = l.tokenFor("hash-a");
  if (who?.tenantId !== "t-a" || who.agentId !== "a1") throw new Error(JSON.stringify(who));
  if (l.tokenFor("hash-unknown")) throw new Error("an unissued token was accepted");
});

console.log(`\n  The broker's ledger\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
