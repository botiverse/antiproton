/**
 * The check the console's mount reports pass on the way in (cf/src/mount-reports.ts): what reads is kept exactly,
 * what does not is left out, and nothing the contract types do not declare gets through.
 */
import { asMountReports } from "../cf/src/mount-reports.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const good = {
  box: {
    activity: { live: { id: "b1", startedAt: 1000, lastUsedAt: 2000 }, quietUntil: null, billing: "billed for every second" },
    usage: [{ id: "b0", startedAt: 10, endedAt: 20, lastUsedAt: 19, uses: 3, kept: ["r2://a"] }],
  },
  web: { activity: { live: null }, usage: [] },
};

check("a report that reads passes through exactly", () => {
  const r = asMountReports(JSON.parse(JSON.stringify(good)));
  must(JSON.stringify(r) === JSON.stringify(good), `changed on the way in: ${JSON.stringify(r)}`);
});

check("a payload that is not a reports object is null, not an empty guess", () => {
  for (const bad of [null, undefined, [], "reports", 5, true]) {
    must(asMountReports(bad) === null, `accepted ${JSON.stringify(bad)}`);
  }
  must(JSON.stringify(asMountReports({})) === "{}", "an empty reports object is not null");
});

check("a usage row that does not read is dropped, and the rows that do are kept", () => {
  const r = asMountReports({ box: { activity: { live: null }, usage: [
    null, {}, "row",
    { id: "b1", startedAt: "yesterday", endedAt: 2, lastUsedAt: 2 },
    { id: "b2", startedAt: 1, endedAt: 2, lastUsedAt: 2, uses: "three" },
    { id: "b3", startedAt: 1, endedAt: 2, lastUsedAt: 2, kept: ["r2://a", 7] },
    { id: "b4", startedAt: 1, endedAt: 2, lastUsedAt: 2 },
  ] } });
  const ids = r?.box?.usage.map((u) => u.id).join(",");
  must(ids === "b4", `kept ${ids}`);
  must(JSON.stringify(asMountReports({ box: { activity: { live: null }, usage: "none" } })?.box?.usage) === "[]", "a non-array usage is not an empty list");
});

check("a mount whose activity does not read is not reported; the others are", () => {
  const r = asMountReports({
    bad1: { activity: { live: { id: "b", startedAt: "now", lastUsedAt: 1 } }, usage: [] },
    bad2: { activity: { live: null, billing: 42 }, usage: [] },
    bad3: { activity: { live: null, quietUntil: "later" }, usage: [] },
    bad4: { usage: [] },
    ok: { activity: { live: null }, usage: [] },
  });
  must(Object.keys(r ?? {}).join(",") === "ok", `reported ${Object.keys(r ?? {})}`);
});

check("only declared fields reach the page", () => {
  const r = asMountReports({ box: {
    activity: { live: { id: "b", startedAt: 1, lastUsedAt: 2, boxSecret: "s" }, billing: "b", credential: "x" },
    usage: [{ id: "u", startedAt: 1, endedAt: 2, lastUsedAt: 2, placeholder: "__AP_TOKEN__" }],
    connection: { boxId: "raw" },
  } });
  const text = JSON.stringify(r);
  must(!/boxSecret|credential|placeholder|connection/.test(text), `undeclared fields passed: ${text}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
