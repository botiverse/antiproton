/**
 * The usage view (task #8), checked where a person would read it.
 *
 * The route hands the page ledger rows already summed to bucket and group.
 * The checks: a rail item and a lazy tenant-wide panel exist and the view can
 * be opened by URL; every resource gets its own chart (units never share an
 * axis); at most three groups get a colour and the rest fold into "other",
 * with the colour following the name, not the rank; the table carries every
 * group; no prices means the page says free; and nothing a row carries
 * reaches the markup unescaped.
 */
import { page } from "../cf/src/ui.ts";
import { usagePanel, buckets, namedGroups, RESOURCES, type UsageData, type UsageRow } from "../cf/src/usage.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

const H = 3_600_000;
const to = Date.parse("2026-09-17T12:00:00Z");
const row = (group: string, resource: string, key: string, unit: string, quantity: number, hoursAgo = 1, cost?: number): UsageRow =>
  ({ bucket: to - hoursAgo * H, group, resource, key, unit, quantity, ...(cost === undefined ? {} : { cost }) });
const data = (rows: UsageRow[], over: Partial<UsageData> = {}): UsageData =>
  ({ window: "24h", bucket: "1h", by: "agent", from: to - 24 * H, to, rows, labels: { a1: "alpha", a2: "bravo", a3: "charlie", a4: "delta" }, ...over });

check("the rail has a usage item and the view is a lazy, tenant-wide panel", () => {
  const html = page("t_u-x", "someone", "u-x");
  must(/class="rail-item" data-view="usage"/.test(html), "a rail item for usage");
  must(/<section class="view" data-view="usage">/.test(html), "a usage view");
  const panel = html.match(/<div class="body" id="usage"[^>]*>/)?.[0] ?? "";
  must(/data-lazy/.test(panel) && /hx-get="\/ui\/usage"/.test(panel), "the panel reads /ui/usage when shown");
  must(!/agentId/.test(panel), "the panel is not scoped to an agent");
  must(/\['agents', 'plugins', 'usage', 'keys'\]\.includes\(v\)/.test(html), "?view=usage opens the view");
  must(/usage\(form, changed\)/.test(html) && /setAttribute\('hx-get', '\/ui\/usage\?' \+ q\)/.test(html), "a choice is kept in the URL and in the panel's read");
  must(/body\.shell\[data-view\]:not\(\[data-view=agents\]\) \.inspector\{display:none\}/.test(html), "no inspector sliver beside the view");
});

check("one chart per resource, each on its own scale", () => {
  const html = usagePanel(data([
    row("a1", "model.tokens", "m:input", "tokens", 900000),
    row("a1", "sandbox.container", "sandbox", "seconds", 120),
  ]));
  must(count(html, /<section class="u-tile( off)?">/g) === RESOURCES.length, "a tile per resource");
  must(/<div class="u-max">900k<\/div>/.test(html), "the token chart tops at its own maximum");
  const counted = RESOURCES.filter((r) => r.counted).length;
  must(count(html, /nothing in this window/g) === counted - 1, "an idle counted resource says so instead of drawing an empty axis");
});

check("a resource the ledger does not record yet says so, not \"nothing\"", () => {
  const off = RESOURCES.filter((r) => !r.counted);
  const html = usagePanel(data([row("a1", "js.run", "run_js", "runs", 1), row("a1", "sandbox.container", "sandbox", "seconds", 60)]));
  must(count(html, /<section class="u-tile off">[\s\S]*?not counted yet/g) === off.length, "each uncounted tile says not counted yet");
  must(!/<div class="u-max">1 min<\/div>/.test(html), "a stray row for an uncounted resource draws nothing");
  must(count(html, /<span class="faint">not counted<\/span>/g) === off.length, "the table says so in the column too");
});

check("every bucket in the window is a column, idle ones included", () => {
  const d = data([row("a1", "js.run", "run_js", "runs", 3, 2)]);
  must(buckets(d).length === 24, "24 hourly columns in a day");
  must(buckets({ ...d, bucket: "1d", from: to - 7 * 24 * H }).length === 8, "a week ending at noon touches 8 UTC days; both part-days are columns");
});

check("three named groups at most; colour follows the name, not the rank", () => {
  const rows = [
    row("a1", "js.run", "run_js", "runs", 1), row("a2", "js.run", "run_js", "runs", 50),
    row("a3", "js.run", "run_js", "runs", 30), row("a4", "js.run", "run_js", "runs", 20),
  ];
  must(JSON.stringify(namedGroups(data(rows))) === JSON.stringify(["a2", "a3", "a4"]), "the three largest, in name order");
  const html = usagePanel(data(rows));
  must(/<em class="k s1"><\/em>bravo/.test(html) && /<em class="k s3"><\/em>delta/.test(html), "legend slots by name order");
  must(/<em class="k so"><\/em>other/.test(html), "the rest fold into other");
  must(!/class="s4"/.test(html), "no fourth colour");
  const flipped = usagePanel(data(rows.map((r) => r.group === "a2" ? { ...r, quantity: 25 } : r)));
  must(/<em class="k s1"><\/em>bravo/.test(flipped), "reordering the ranking inside the three does not repaint");
  must(count(html, /<tr><td><a href="\/ui\?view=agents&agentId=/g) === 4, "the table lists every agent, linked");
});

check("a resource the split does not apply to is drawn whole, in a neutral colour", () => {
  const html = usagePanel(data([
    row("claude-a", "model.tokens", "claude-a:input", "tokens", 10),
    row("", "tool.call", "github.issue_list", "calls", 4),
  ], { by: "model" }));
  must(/not split by model/.test(html), "the tile says the split does not apply");
  must(/<i class="sa"/.test(html) && /<i class="s1"/.test(html), "the unsplit bars are neutral, the split ones coloured");
  must(/no model/.test(html), "the table names the unsplit row");
});

check("without prices the page says free; with prices it adds credits up", () => {
  const rows = [row("a1", "model.tokens", "m:input", "tokens", 1000, 1, 1.5), row("a1", "tool.call", "gh.x", "calls", 2, 1, 0.25)];
  const free = usagePanel(data(rows));
  must(/<span class="u-big">free<\/span>/.test(free) && !/credits in this window/.test(free), "free when nothing is priced");
  const paid = usagePanel(data(rows, { priced: true }));
  must(/<span class="u-big">1\.75<\/span> credits in this window/.test(paid), "credits add across resources");
  must(/<th class="num">credits<\/th>/.test(paid), "the table gains a credits column");
});

check("failed runs and calls show in the tile's small print, only when there are any", () => {
  const html = usagePanel(data([row("a1", "js.run", "run_js", "runs", 4), row("a1", "js.run", "run_js", "failed", 1), row("a1", "tool.call", "gh.x", "calls", 3)]));
  must(/1 failed · avg/.test(html), "a failed run is counted");
  must(/none failed/.test(html), "tool calls without failures say so");
  must(count(html, / failed/g) === 2, "nothing else claims a failure");
});

check("the tooltip and the table name a bucket in UTC", () => {
  const html = usagePanel(data([row("a1", "js.run", "run_js", "runs", 3, 5)]));
  must(/<b>09-17 07:00Z<\/b>/.test(html), "hourly buckets carry date and hour");
  must(/aria-label="09-17 07:00Z: 3"/.test(html), "the column is labelled for keyboard and screen readers");
});

check("nothing used says so, and keeps the controls", () => {
  const html = usagePanel(data([]));
  must(/nothing used in the last 24h/.test(html), "an empty window says so");
  must(/onchange="ap\.usage\(this, event\.target\)"/.test(html) && /name="window"/.test(html), "the controls stay");
});

check("row values never reach the markup unescaped", () => {
  const bad = `<img src=x onerror=1>`;
  const html = usagePanel(data([row(bad, "tool.call", bad, "calls", 1)], { by: "tool", labels: {} }));
  must(!html.includes(bad), "group and key are escaped");
  const html2 = usagePanel(data([row(bad, "js.run", "run_js", "runs", 1)], { labels: { [bad]: bad } }));
  must(!html2.includes(bad), "labels and agent links are escaped");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
