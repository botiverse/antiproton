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
/**
 * One tile's markup, by the title a reader sees. A claim about a tile has to be
 * made inside that tile: `/tool calls<\/h3>[\s\S]*?0 credits/` reads past the
 * tile's end and can be satisfied by the next one.
 */
const tile = (html: string, title: string) => {
  const found = html.split(/(?=<section class="u-tile)/).filter((t) => t.includes(`<h3>${title}</h3>`));
  if (found.length !== 1) throw new Error(`${found.length} tiles titled ${title}`);
  return found[0]!;
};

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
  // Derived from the fixture rather than from "all but one": container time is
  // counted now, so these two rows cover two resources, and a hard-coded
  // `counted - 1` was really a statement about how many rows the fixture had.
  const drawn = new Set(["model.tokens", "sandbox.container"]);
  const idle = RESOURCES.filter((r) => r.counted && !drawn.has(r.id)).length;
  must(count(html, /nothing in this window/g) === idle, "an idle counted resource says so instead of drawing an empty axis");
});

check("every resource is recorded now, so the page says \"not counted\" nowhere", () => {
  // This check used to assert the opposite: that each uncounted resource said
  // "not counted yet" in its tile, that a stray row for one drew nothing, and
  // that the table's column said so too. Nothing is uncounted any more, and
  // those assertions cannot be written without a resource to write them about —
  // `usagePanel` reads the module's RESOURCES rather than taking them.
  //
  // So the sentinel is here: adding an uncounted resource fails this check, and
  // the assertions to restore are named above. Meanwhile the claim that can
  // still be made is made: the page says it about nothing.
  const off = RESOURCES.filter((r) => !r.counted);
  must(off.length === 0, `restore this check's old assertions: ${off.map((r) => r.id).join(", ")} is not counted`);
  const html = usagePanel(data([row("a1", "js.run", "run_js", "runs", 1), row("a1", "sandbox.container", "sandbox", "seconds", 60)]));
  must(!/not counted/.test(html), "no tile and no table cell may say not counted");
  must(/<div class="u-max">1 min<\/div>/.test(html), "and a container row now draws, which is what being counted means");
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

check("an amount with no price reads 'not priced yet', never 0 credits", () => {
  // What the page looks like the day the first price is set: model tokens are
  // priced, tool calls are not. A `cost` of null is the ledger saying no price
  // exists for that row — summing it as 0 would make it read as free.
  const unpriced = (r: UsageRow): UsageRow => ({ ...r, cost: null });
  const html = usagePanel(data([
    row("a1", "model.tokens", "m:input", "tokens", 1000, 1, 1.5),
    unpriced(row("a1", "tool.call", "gh.x", "calls", 2)),
  ], { priced: true }));
  must(/<span class="u-big">1\.50<\/span> credits in this window/.test(html), "the headline counts only what has a price");
  must(/Not priced yet, so not in this number: tool calls<\/div>/.test(html), "and names what it leaves out, by resource, not by row count");
  const calls = tile(html, "tool calls");
  must(/<span class="u-cost">not priced yet<\/span>/.test(calls), "the unpriced tile says so instead of 0 credits");
  must(!/<span class="u-cost">0 credits/.test(calls), "the unpriced tile never claims a zero cost it cannot know");
  must(/1\.50<span class="faint" title="some amounts here are not priced yet"> \+<\/span>/.test(html), "the table marks a group whose sum leaves something out");
});

check("a resource priced in part says so, and the sum stays the priced part", () => {
  const html = usagePanel(data([
    row("a1", "model.tokens", "m:input", "tokens", 1000, 1, 2),
    { ...row("a1", "model.tokens", "n:input", "tokens", 500), cost: null },
  ], { priced: true }));
  must(/<span class="u-cost">2\.00 credits, some not priced yet<\/span>/.test(html), "the tile names the part it could not price");
  must(/<span class="u-big">2\.00<\/span> credits in this window\. Not priced yet, so not in this number: some model tokens/.test(html), "the headline agrees with the tile, and says only part of that resource is priced");
});

check("many unpriced rows of one resource are named once, not counted", () => {
  // The route hands one row per bucket per group, so an unpriced resource
  // arrives as dozens of rows. The headline has to name the resource, or it
  // reports a number that means nothing to a person.
  const rows: UsageRow[] = [row("a1", "model.tokens", "m:input", "tokens", 1000, 1, 1.5)];
  for (let h = 1; h <= 20; h++) for (const g of ["a1", "a2"]) rows.push({ ...row(g, "tool.call", "gh.x", "calls", 2, h), cost: null });
  const html = usagePanel(data(rows, { priced: true }));
  must(/Not priced yet, so not in this number: tool calls<\/div>/.test(html), "the resource is named once");
  must(!/\d+ amounts? (is|are) not priced/.test(html), "no row count leaks into the sentence");
});

check("a window that reaches further back than the record says so, per resource", () => {
  // The day a resource starts being recorded, the window still asks for 24
  // hours. What the ledger holds is the last part of it, and a tile that shows
  // only a number reads as the whole window.
  const rows = [row("a1", "object.active", "", "ms", 90_000, 2), row("a1", "model.tokens", "m:input", "tokens", 10, 20)];
  const started = to - 3 * H;
  const html = usagePanel(data(rows, { firstHours: { "object.active": started, "model.tokens": to - 30 * H } }));
  const active = tile(html, "agent running time");
  must(/nothing recorded before 09-17 09:00Z/.test(active), `the tile names the line: ${active}`);
  must(/1\.5 min/.test(active), "and still shows what it does have");
  must(!/nothing recorded before/.test(tile(html, "model tokens")),
    "a resource recorded from before the window says nothing");
  const all = usagePanel(data(rows, { firstHours: { "object.active": to - 24 * H } }));
  must(!/nothing recorded before/.test(tile(all, "agent running time")),
    "a first hour at the window's own start is not a gap");
  must(!/nothing recorded before/.test(usagePanel(data(rows))),
    "no firstHours at all: the page claims nothing about where the record begins");
});

check("the object's billed time is counted, and is a duration", () => {
  const res = RESOURCES.find((r) => r.id === "object.active")!;
  must(res.counted, "object.active is recorded now");
  must(res.unit === "ms" && res.fmt(90_000) === "1.5 min", `a duration, not a count: ${res.fmt(90_000)}`);
  const html = usagePanel(data([row("a1", "object.active", "", "ms", 3_600_000)]));
  must(/agent running time<\/h3>[\s\S]*?1 h/.test(html), "the tile shows the time");
  must(!/<span class="faint">not counted<\/span>[\s\S]*?agent running time/.test(html), "and the table no longer says not counted for it");
});

check("every amount priced: no hedge anywhere", () => {
  const html = usagePanel(data([
    row("a1", "model.tokens", "m:input", "tokens", 1000, 1, 1.5),
    row("a1", "tool.call", "gh.x", "calls", 2, 1, 0.25),
  ], { priced: true }));
  must(!/not priced/.test(html), "nothing says 'not priced' when everything is");
  must(!/some not priced yet/.test(html) && !/not in this number/.test(html), "and the headline carries no caveat");
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

check("an empty window says that nothing is charged, and claims nothing about what is not recorded", () => {
  // Everyone who opens the page before the first turn finishes sees only this
  // branch. It used to be the only place that could say a resource was not
  // recorded at all; every resource is recorded now, so that sentence must be
  // gone rather than left hanging about something that is no longer true
  // (Nova's instruction, and her own test asked for this by failing).
  const html = usagePanel(data([]));
  must(!RESOURCES.some((r) => !r.counted), "every resource is counted; if one is added uncounted, restore the naming check");
  must(!/not counted yet/.test(html), "nothing is uncounted, so the empty window must not say anything is");
  must(/no prices are set yet, so nothing here is charged/.test(html), "an unpriced account is told so before it has any usage");
  must(!/no prices are set yet/.test(usagePanel(data([], { priced: true }))), "once a price exists the empty window drops that line");
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
