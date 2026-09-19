/**
 * The usage view (/ui/usage): what the whole tenant used, over a window, in
 * hourly or daily buckets, as a total or split by agent, model or tool.
 *
 * The route answers with rows of the tenant ledger (task #8), already summed
 * to the bucket and group asked for:
 *
 *   { bucket, group, resource, key, quantity, unit, cost? }
 *
 *   resource            key                         units
 *   model.tokens        "<model>:<kind>"            tokens   (kind: input, output, cache_read, cache_write, reasoning)
 *   js.run              "run_js"                    runs, failed, ms, tool_calls
 *   tool.call           "<plugin>.<tool>"           calls, failed, ms
 *   sandbox.container   "<plugin>"                  seconds, execs
 *   object.active       ""                          ms
 *
 * `group` is the agent id, model or tool the rows were split by, "" when the
 * split does not apply to that resource (a container has no model), and
 * "total" when nothing was split. `cost` is credits: a number once a price
 * applied, `null` when none exists for that row yet. The page keeps those
 * apart — an unpriced amount reads "not priced yet", never "0 credits" — and
 * says how much of the tally the headline leaves out.
 *
 * Why this shape on the page: the resources are measured in different units,
 * so there is no single axis they can share. Each resource gets its own
 * chart (small multiples), every chart on its own scale, and the group
 * colours mean the same thing in every chart. Credits are the one unit that
 * does add up across resources, so once prices exist they get the headline.
 */
import { WINDOW_NAMES } from "./usage-windows.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

export type UsageRow = {
  bucket: number | string;
  group: string;
  resource: string;
  key: string;
  quantity: number;
  unit: string;
  cost?: number | null;
};

export type UsageData = {
  window: string;
  bucket: "1h" | "1d";
  by: "total" | "agent" | "model" | "tool";
  from: number;
  to: number;
  rows: UsageRow[];
  /** Display names for groups; agent ids are not for reading. */
  labels?: Record<string, string>;
  /** Whether any price exists yet. Until then every figure is free. */
  priced?: boolean;
  /**
   * The first hour the ledger has anything for a resource, by resource. When
   * that hour falls inside the window, the part of the window before it holds
   * no rows for that resource — either nothing happened or nothing was counted
   * yet, and the ledger cannot tell those apart. The tile says so rather than
   * showing a partial figure as a whole one.
   */
  firstHours?: Record<string, number>;
};

const BYS = ["total", "agent", "model", "tool"] as const;
const HOUR = 3_600_000;

const count = (n: number) =>
  n >= 1e9 ? `${+(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}k` : String(Math.round(n));
const duration = (ms: number) => {
  const s = ms / 1000;
  if (s < 1) return `${Math.round(ms)}ms`;
  if (s < 60) return `${+s.toFixed(1)}s`;
  if (s < 3600) return `${+(s / 60).toFixed(1)} min`;
  return `${+(s / 3600).toFixed(1)} h`;
};

/**
 * The average time of n events (n > 0 at both call sites). A per-call `ms` is
 * recorded whatever the outcome, already rounded to whole milliseconds, so an
 * average below half a millisecond means "too short to measure", not "not
 * measured" — and `avg 0ms` reads as the second. Same shape as `credits`'
 * `<0.01`.
 *
 * The test is what `duration` would print, not the total: three calls totalling
 * 1ms average below the resolution while the total is positive, so a guard on
 * the total would print `avg 0ms` for them.
 */
const average = (ms: number, n: number) => (Math.round(ms / n) ? duration(ms / n) : "<1ms");

const credits = (c: number) => (c === 0 ? "0" : c < 0.01 ? "<0.01" : c < 100 ? c.toFixed(2) : count(c));

type Resource = {
  id: string;
  title: string;
  /** The unit the chart draws. */
  unit: string;
  /** The chart's number, in its own words. */
  fmt: (q: number) => string;
  /** The small print under the headline, from the resource's other units. */
  detail: (rows: UsageRow[]) => string;
  /** Which splits this resource has an answer for. */
  splits: string[];
  /**
   * Whether the ledger records this resource yet. A tile for one it does not
   * says "not counted yet": an empty chart would read as "nothing was used".
   * Flip it in the PR that starts recording it.
   */
  counted: boolean;
};

const sum = (rows: UsageRow[], unit: string, pred: (r: UsageRow) => boolean = () => true) =>
  rows.reduce((a, r) => a + (r.unit === unit && pred(r) ? Number(r.quantity) || 0 : 0), 0);

/**
 * Credits, and how much of the tally they leave out.
 *
 * A row's `cost` is a number only when a price applied to it; `null` means no
 * price exists for that resource, key and unit yet. Summing with `?? 0` turns
 * that absence into a value, and "not priced yet" then reads as "free" — the
 * same mistake as an empty chart reading as "nothing was used". So every place
 * that shows credits also knows how many rows had no price.
 */
const money = (rows: UsageRow[], pred: (r: UsageRow) => boolean = () => true) => {
  let credits = 0, priced = 0, unpriced = 0;
  for (const r of rows) {
    if (!pred(r)) continue;
    if (typeof r.cost === "number") { credits += r.cost; priced++; } else unpriced++;
  }
  return { credits, priced, unpriced };
};
const kind = (r: UsageRow) => r.key.slice(r.key.lastIndexOf(":") + 1);

export const RESOURCES: Resource[] = [
  {
    id: "model.tokens", title: "model tokens", unit: "tokens", fmt: count, splits: ["agent", "model"], counted: true,
    detail: (rows) => {
      const k = (name: string) => sum(rows, "tokens", (r) => kind(r) === name);
      const parts = [["in", k("input")], ["out", k("output")], ["cache read", k("cache_read")], ["cache write", k("cache_write")]] as const;
      return parts.filter(([, n]) => n).map(([l, n]) => `${l} ${count(n)}`).join(" · ");
    },
  },
  {
    id: "js.run", title: "JS runs", unit: "runs", fmt: count, splits: ["agent", "tool"], counted: true,
    detail: (rows) => {
      const runs = sum(rows, "runs"), failed = sum(rows, "failed"), ms = sum(rows, "ms"), inner = sum(rows, "tool_calls");
      return [failed ? `${count(failed)} failed` : "", runs ? `avg ${average(ms, runs)}` : "", inner ? `${count(inner)} tool calls inside` : ""].filter(Boolean).join(" · ");
    },
  },
  {
    id: "tool.call", title: "tool calls", unit: "calls", fmt: count, splits: ["agent", "tool"], counted: true,
    detail: (rows) => {
      const calls = sum(rows, "calls"), failed = sum(rows, "failed"), ms = sum(rows, "ms");
      return [failed ? `${count(failed)} failed` : calls ? "none failed" : "", calls ? `avg ${average(ms, calls)}` : ""].filter(Boolean).join(" · ");
    },
  },
  {
    id: "sandbox.container", title: "container time", unit: "seconds", fmt: (s) => duration(s * 1000), splits: ["agent", "tool"], counted: true,
    detail: (rows) => { const n = sum(rows, "execs"); return n ? `${count(n)} commands run` : ""; },
  },
  {
    id: "object.active", title: "agent running time", unit: "ms", fmt: duration, splits: ["agent"], counted: true,
    // The union of the object's busy spans, not their sum: handlers overlap at
    // await points, so summing them reports more time than was billed
    // (src/usage/active.ts).
    detail: () => "billed time of the agents themselves",
  },
];

/**
 * The resources the headline leaves out, named the way the tiles name them.
 * A count of unpriced rows would be an artifact of the split — one row per
 * bucket per group — so a single unpriced resource could read "63 amounts".
 * A resource priced only in part is named too, with "some".
 */
const unpricedNames = (rows: UsageRow[]) =>
  RESOURCES.map((res) => ({ res, m: money(rows, (r) => r.resource === res.id) }))
    .filter(({ m }) => m.unpriced)
    .map(({ res, m }) => (m.priced ? `some ${res.title}` : res.title));

/** A group's name as a person reads it. */
const label = (d: UsageData, g: string) =>
  g === "total" ? "total" : g === "" ? "—" : d.labels?.[g] ?? (d.by === "agent" ? g.slice(0, 12) : g);

const at = (b: number | string) => (typeof b === "number" ? b : Date.parse(b));

/** Every bucket start in the window, so an idle hour is a gap, not a missing column. */
export function buckets(d: UsageData): number[] {
  const step = d.bucket === "1d" ? 24 * HOUR : HOUR;
  const first = Math.floor(d.from / step) * step;
  const out: number[] = [];
  for (let t = first; t < d.to && out.length < 800; t += step) out.push(t);
  return out;
}

/**
 * Chart colours: three named groups at most, the rest folded into "other".
 * Three is the most the palette keeps apart for every pair across a set of
 * small multiples, colour-blind readers included; the table below carries
 * every group by name. The three are the largest in the window, then placed
 * in name order, so a colour belongs to the name, not to the ranking.
 */
export function namedGroups(d: UsageData): string[] {
  if (d.by === "total") return [];
  // Size is each group's share of every resource, summed, so tokens (in the
  // millions) do not drown container seconds (in the hundreds).
  const size = new Map<string, number>();
  for (const res of RESOURCES) {
    const rows = d.rows.filter((r) => r.resource === res.id && r.unit === res.unit && r.group !== "" && r.group !== "total");
    const total = sum(rows, res.unit) || 1;
    for (const r of rows) size.set(r.group, (size.get(r.group) ?? 0) + (Number(r.quantity) || 0) / total);
  }
  return [...size.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([g]) => g)
    .sort((a, b) => label(d, a).localeCompare(label(d, b)));
}

function chart(d: UsageData, res: Resource, rows: UsageRow[], named: string[], times: number[]): string {
  const drawn = rows.filter((r) => r.unit === res.unit);
  const split = d.by !== "total" && res.splits.includes(d.by);
  const series = split ? [...named, "other"] : ["all"];
  const slot = (g: string) => (!split ? "all" : named.includes(g) ? g : "other");
  const cols = times.map((t) => {
    const per = new Map<string, number>();
    for (const r of drawn) if (at(r.bucket) === t) per.set(slot(r.group), (per.get(slot(r.group)) ?? 0) + (Number(r.quantity) || 0));
    return { t, per, total: [...per.values()].reduce((a, b) => a + b, 0) };
  });
  const max = Math.max(0, ...cols.map((c) => c.total));
  if (!max) return `<div class="u-plot empty-plot">nothing in this window</div>`;
  const stamp = (t: number) => {
    const iso = new Date(t).toISOString();
    return d.bucket === "1d" ? iso.slice(0, 10) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}Z`;
  };
  const bars = cols.map((c) => {
    const segs = series.filter((s) => c.per.get(s)).map((s) => {
      const i = split ? (s === "other" ? "o" : String(named.indexOf(s) + 1)) : "a";
      return `<i class="s${i}" style="height:${(c.per.get(s)! / max) * 100}%"></i>`;
    }).join("");
    const tip = c.total
      ? `<span class="u-tip" role="tooltip"><b>${stamp(c.t)}</b>${series.filter((s) => c.per.get(s)).map((s) =>
        `<span>${split ? `<em class="k s${s === "other" ? "o" : named.indexOf(s) + 1}"></em>${esc(s === "other" ? "other" : label(d, s))} ` : ""}${res.fmt(c.per.get(s)!)}</span>`).join("")}</span>`
      : "";
    const aria = `${stamp(c.t)}: ${res.fmt(c.total)}`;
    return `<div class="u-col"${c.total ? ` tabindex="0" aria-label="${esc(aria)}"` : ""}><div class="u-stack">${segs}</div>${tip}</div>`;
  }).join("");
  const mid = times[Math.floor(times.length / 2)]!;
  return `<div class="u-plot">
  <div class="u-max">${res.fmt(max)}</div>
  <div class="u-bars" style="--n:${times.length}">${bars}</div>
  <div class="u-axis"><span>${stamp(times[0]!)}</span><span>${times.length > 2 ? stamp(mid) : ""}</span><span>${stamp(times[times.length - 1]!)}</span></div>
</div>${split || d.by === "total" ? "" : `<div class="u-note">not split by ${esc(d.by)}</div>`}`;
}

export function usagePanel(d: UsageData): string {
  const times = buckets(d);
  const named = namedGroups(d);
  const opt = (v: string, cur: string, text = v) => `<option value="${v}"${v === cur ? " selected" : ""}>${text}</option>`;

  const controls = `<form class="u-controls" onchange="ap.usage(this, event.target)" onsubmit="return false">
  <label><span>window</span><select name="window">${WINDOW_NAMES.map((w) => opt(w, d.window, `last ${w}`)).join("")}</select></label>
  <label><span>each bar</span><select name="bucket">${opt("1h", d.bucket, "1 hour")}${opt("1d", d.bucket, "1 day")}</select></label>
  <label><span>split by</span><select name="by">${BYS.map((b) => opt(b, d.by, b === "total" ? "nothing" : b)).join("")}</select></label>
</form>`;

  const legend = named.length
    ? `<div class="u-legend">${named.map((g, i) => `<span><em class="k s${i + 1}"></em>${esc(label(d, g))}</span>`).join("")}${
      new Set(d.rows.map((r) => r.group).filter((g) => g !== "" && g !== "total")).size > named.length ? `<span><em class="k so"></em>other</span>` : ""}</div>`
    : "";

  const whole = money(d.rows);
  const left = unpricedNames(d.rows);
  const headline = d.priced
    ? `<div class="u-credits"><span class="u-big">${credits(whole.credits)}</span> credits in this window${
      left.length ? `. Not priced yet, so not in this number: ${esc(left.join(", "))}` : ""}</div>`
    : `<div class="u-credits"><span class="u-big">free</span> no prices are set yet, so nothing here is charged. The amounts are real and kept for audit.</div>`;

  // A resource whose first recorded hour is inside the window: the window
  // reaches further back than the record does, so the figure is a part and must
  // not be shown as a whole. Worded as what the ledger holds, because it cannot
  // tell "nothing happened then" from "nothing was counted then". It sits under
  // the chart, with the tile's other small print: above the chart it pushes one
  // chart down, and small multiples only compare if they share a baseline.
  const cut = (res: Resource) => {
    const first = d.firstHours?.[res.id];
    if (typeof first !== "number" || !(first > d.from)) return "";
    const iso = new Date(first).toISOString();
    return `<div class="u-note">nothing recorded before ${iso.slice(5, 10)} ${iso.slice(11, 16)}Z,` +
      ` part-way into this window</div>`;
  };

  const tiles = RESOURCES.map((res) => {
    if (!res.counted) {
      return `<section class="u-tile off">
  <h3>${res.title}</h3>
  <div class="u-num">not counted yet</div>
  <div class="u-detail">recording this is still being built</div>
</section>`;
    }
    const rows = d.rows.filter((r) => r.resource === res.id);
    const total = sum(rows, res.unit);
    const c = money(rows);
    return `<section class="u-tile">
  <h3>${res.title}</h3>
  <div class="u-num">${res.fmt(total)}${d.priced ? `<span class="u-cost">${
      c.unpriced === 0 ? `${credits(c.credits)} credits`
        : c.priced === 0 ? "not priced yet"
        : `${credits(c.credits)} credits, some not priced yet`}</span>` : ""}</div>
  <div class="u-detail">${esc(res.detail(rows)) || "&nbsp;"}</div>
  ${chart(d, res, rows, named, times)}${cut(res)}
</section>`;
  }).join("");

  // The table view: every group by name, every resource in its own unit.
  // It is the chart's accessible twin and the only place past three groups.
  const groups = [...new Set(d.rows.map((r) => r.group))]
    .filter((g) => d.by === "total" || g !== "total")
    .sort((a, b) => (a === "" ? 1 : b === "" ? -1 : label(d, a).localeCompare(label(d, b))));
  const cell = (g: string, res: Resource) => {
    if (!res.counted) return `<td class="num"><span class="faint">not counted</span></td>`;
    const n = sum(d.rows, res.unit, (r) => r.group === g && r.resource === res.id);
    return `<td class="num">${n ? res.fmt(n) : `<span class="faint">·</span>`}</td>`;
  };
  const name = (g: string) =>
    d.by === "agent" && g
      ? `<a href="/ui?view=agents&agentId=${encodeURIComponent(g)}">${esc(label(d, g))}</a>`
      : esc(g === "" ? `no ${d.by}` : label(d, g));
  const table = groups.length
    ? `<div class="u-wrap"><table class="u-table"><thead><tr><th>${d.by === "total" ? "" : esc(d.by)}</th>${RESOURCES.map((r) => `<th class="num">${r.title}</th>`).join("")}${d.priced ? `<th class="num">credits</th>` : ""}</tr></thead>
<tbody>${groups.map((g) => `<tr><td>${name(g)}</td>${RESOURCES.map((res) => cell(g, res)).join("")}${d.priced
      ? `<td class="num">${((m) => m.unpriced === 0
        ? credits(m.credits)
        : m.priced === 0 ? `<span class="faint">not priced</span>`
        : `${credits(m.credits)}<span class="faint" title="some amounts here are not priced yet"> +</span>`)(money(d.rows, (r) => r.group === g))}</td>` : ""}</tr>`).join("")}</tbody></table></div>`
    : "";

  // An empty window is the whole page for everyone who opens it before the
  // first turn finishes, so it carries the two things that are true with or
  // without usage: what is not being recorded at all, and that nothing is
  // charged. Without them a new account is told only that it used nothing,
  // and would read the silence about container time as "none used".
  if (!d.rows.length) {
    const off = RESOURCES.filter((res) => !res.counted).map((res) => res.title);
    return `${controls}<div class="empty">nothing used in the last ${esc(d.window)}. Usage is recorded as each agent finishes a turn.${
      off.length ? `<div class="u-note">not counted yet, still being built: ${esc(off.join(", "))}</div>` : ""}${
      d.priced ? "" : `<div class="u-note">no prices are set yet, so nothing here is charged</div>`}</div>`;
  }
  return `${controls}${headline}${legend}<div class="u-grid">${tiles}</div>
<h3 class="u-h">by ${d.by === "total" ? "resource" : esc(d.by)}</h3>${table}
<div class="hint u-foot">Updated as each agent finishes a turn. Times are UTC.</div>`;
}

/**
 * Colours: three categorical slots (blue, orange, aqua), validated as a set
 * for every pair in both modes; "other" is neutral. Aqua sits under 3:1 on
 * the light card, which the table view answers. Text never wears a series
 * colour: the swatch beside it carries the identity.
 */
export const USAGE_CSS = `
.u-controls{display:flex;gap:14px;flex-wrap:wrap;align-items:end;margin:0 0 14px;padding:0;border:0}
.u-controls label{display:flex;flex-direction:column;gap:2px;font-size:11px;color:var(--dim)}
.u-controls select{background:var(--layer-card);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:3px 6px;font:inherit;font-size:12px}
.shell{--s1:#2a78d6;--s2:#eb6834;--s3:#1baf7a;--so:var(--foreground-placeholder)}
html.dark .shell{--s1:#3987e5;--s2:#d95926;--s3:#199e70}
.u-credits{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;color:var(--dim);font-size:12px;margin:0 0 10px}
.u-big{font-size:26px;font-weight:600;color:var(--strong);letter-spacing:-.01em}
.u-legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--ink);margin:0 0 10px}
.u-legend span{display:inline-flex;align-items:center;gap:6px}
em.k{display:inline-block;width:10px;height:10px;border-radius:3px;flex:none}
.s1{background:var(--s1)}.s2{background:var(--s2)}.s3{background:var(--s3)}.so{background:var(--so)}.sa{background:var(--dim)}
.u-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
.u-tile{border:1px solid var(--line);border-radius:8px;padding:10px 12px;background:var(--layer-card);min-width:0;overflow:visible}
.u-tile h3{margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);font-weight:500}
.u-num{font-size:22px;font-weight:600;color:var(--strong);display:flex;align-items:baseline;gap:8px;margin-top:2px}
.u-tile.off .u-num{font-size:14px;font-weight:500;color:var(--dim);margin-top:8px}
.u-cost{font-size:11px;font-weight:400;color:var(--dim)}
.u-detail{font-size:11px;color:var(--dim);min-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.u-plot{position:relative;margin-top:8px}
.u-plot.empty-plot{height:96px;display:flex;align-items:center;justify-content:center;color:var(--faint);font-size:11px;border-bottom:1px solid var(--line)}
.u-max{position:absolute;top:-2px;left:0;font-size:10px;color:var(--faint);pointer-events:none}
.u-bars{height:84px;padding-top:14px;display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:2px;align-items:end;border-bottom:1px solid var(--line)}
.u-col{position:relative;height:100%;display:flex;align-items:end;outline:none}
.u-col:hover,.u-col:focus-visible{background:var(--fill-muted)}
.u-stack{width:100%;height:100%;display:flex;flex-direction:column-reverse;gap:2px;justify-content:flex-start}
.u-stack i{display:block;width:100%;min-height:1px;flex:none}
.u-stack i:last-child{border-radius:4px 4px 0 0}
.u-tip{display:none;position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);z-index:5;min-width:120px;
background:var(--layer-card);border:1px solid var(--line-strong);border-radius:6px;padding:6px 8px;font-size:11px;color:var(--ink);
white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.12);pointer-events:none}
.u-tip b{display:block;color:var(--dim);font-weight:500;margin-bottom:2px}
.u-tip span{display:flex;align-items:center;gap:6px}
.u-col:hover .u-tip,.u-col:focus-visible .u-tip{display:block}
.u-col:first-child .u-tip,.u-col:nth-child(2) .u-tip{left:0;transform:none}
.u-col:last-child .u-tip,.u-col:nth-last-child(2) .u-tip{left:auto;right:0;transform:none}
.u-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--faint);margin-top:3px}
.u-h{margin:18px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);font-weight:500}
table.u-table{width:100%;border-collapse:collapse;font-size:12px}
table.u-table th,table.u-table td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);white-space:nowrap}
table.u-table th{font-weight:500;color:var(--dim);font-size:11px}
table.u-table .num{text-align:right;font-variant-numeric:tabular-nums}
table.u-table tbody tr:hover{background:var(--fill-muted)}
table.u-table a{color:var(--strong);text-decoration:underline;text-decoration-color:var(--line-strong);text-underline-offset:2px}
.u-wrap{overflow-x:auto}
.faint{color:var(--faint)}
.u-foot{margin-top:8px;padding:0}
.u-note{font-size:11px;color:var(--faint);margin-top:2px}
[data-theme="brutal"] .u-tile{border-radius:0}
[data-theme="brutal"] .u-stack i:last-child{border-radius:0}
`;
