// Render QA run records (qa/sdk/out/*.json) as one self-contained HTML report.
//
//   node qa/sdk/report.mjs <record.json>... [-o report.html]
//
// Several records become one report: each run is its own section, in the order given, and the
// summary counts them all. Nothing is fetched when the page opens — styles are inline, no scripts.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function renderReport(records) {
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const when = (iso) => iso ? iso.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "";
  const all = records.flatMap((r) => r.results);
  const passed = all.filter((x) => x.ok).length;
  const ok = passed === all.length;
  const builds = [...new Set(records.map((r) => r.build ?? "unknown"))].join(", ");
  const sdks = [...new Set(records.map((r) => r.sdk))].join(", ");
  const targets = [...new Set(records.map((r) => r.target))].join(", ");

  const runSection = (r, n) => `
  <section>
    <h2>Run ${n + 1} · tier <code>${esc(r.tier)}</code>${r.only ? ` · only <code>${esc(r.only)}</code>` : ""}
      <span class="count ${r.passed === r.total ? "pass" : "fail"}">${r.passed}/${r.total}</span></h2>
    <p class="meta">${esc(when(r.started))} → ${esc(when(r.finished))} · build <code>${esc(r.build ?? "unknown")}</code> · ${esc(r.sdk)}</p>
    <table>
      <thead><tr><th>result</th><th>tier</th><th>scenario</th><th class="num">time</th></tr></thead>
      <tbody>${r.results.map((x) => `
        <tr class="${x.ok ? "pass" : "fail"}">
          <td><span class="badge">${x.ok ? "PASS" : "FAIL"}</span></td>
          <td><code>${esc(x.tier)}</code></td>
          <td>${esc(x.name)}${x.note ? `<div class="note">${esc(x.note)}</div>` : ""}${x.error ? `<pre class="error">${esc(x.error)}</pre>` : ""}</td>
          <td class="num">${secs(x.ms)}</td>
        </tr>`).join("")}
      </tbody>
    </table>
  </section>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Agents API QA · ${passed}/${all.length}</title>
<style>
  :root { --fg:#1c1c1e; --muted:#6b6b70; --line:#e3e3e6; --pass:#1f7a3a; --pass-bg:#e8f5ec; --fail:#b3261e; --fail-bg:#fdecea; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--fg); background: #fafafa; }
  main { max-width: 1040px; margin: 0 auto; padding: 32px 20px 64px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  h2 { font-size: 17px; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  code { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: #f0f0f2; padding: 1px 5px; border-radius: 4px; }
  .summary { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; margin: 18px 0 26px; display: grid; grid-template-columns: auto 1fr; gap: 6px 18px; }
  .summary dt { color: var(--muted); } .summary dd { margin: 0; }
  .verdict { font-size: 28px; font-weight: 700; } .verdict.pass { color: var(--pass); } .verdict.fail { color: var(--fail); }
  section { background: #fff; border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; margin-bottom: 18px; }
  .meta { color: var(--muted); margin: 0 0 12px; font-size: 13px; }
  .count { font-size: 13px; padding: 2px 8px; border-radius: 999px; } .count.pass { background: var(--pass-bg); color: var(--pass); } .count.fail { background: var(--fail-bg); color: var(--fail); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; vertical-align: top; padding: 9px 8px; border-top: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 13px; border-top: 0; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .badge { font-size: 12px; font-weight: 700; padding: 2px 7px; border-radius: 4px; }
  tr.pass .badge { background: var(--pass-bg); color: var(--pass); } tr.fail .badge { background: var(--fail-bg); color: var(--fail); }
  .note { color: var(--muted); font-size: 13px; margin-top: 4px; word-break: break-word; }
  pre.error { white-space: pre-wrap; word-break: break-word; background: var(--fail-bg); color: var(--fail); padding: 8px 10px; border-radius: 6px; margin: 6px 0 0; font-size: 12.5px; }
  footer { color: var(--muted); font-size: 13px; margin-top: 26px; }
  @media (max-width: 640px) { th:nth-child(2), td:nth-child(2) { display: none; } }
</style>
</head>
<body>
<main>
  <h1>Agents API QA report</h1>
  <p class="meta">OpenAI-compatible agents API, exercised with the official OpenAI SDK (qa/sdk).</p>
  <dl class="summary">
    <dt>result</dt><dd><span class="verdict ${ok ? "pass" : "fail"}">${passed}/${all.length} passed</span></dd>
    <dt>runs</dt><dd>${records.length} (${records.map((r) => `${esc(r.tier)} ${r.passed}/${r.total}`).join(" · ")})</dd>
    <dt>target</dt><dd><code>${esc(targets)}</code></dd>
    <dt>build</dt><dd><code>${esc(builds)}</code></dd>
    <dt>client</dt><dd>${esc(sdks)} — <code>new OpenAI()</code> configured only by OPENAI_BASE_URL / OPENAI_API_KEY</dd>
    <dt>period</dt><dd>${esc(when(records[0].started))} → ${esc(when(records.at(-1).finished))}</dd>
  </dl>
  ${records.map(runSection).join("")}
  <footer>Generated ${esc(when(new Date().toISOString()))} from ${records.length} run record(s). A failed scenario keeps its error text above.</footer>
</main>
</body>
</html>
`;
}

// Run as a command, not when run.mjs imports renderReport.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const outAt = args.indexOf("-o");
  const out = outAt >= 0 ? args[outAt + 1] : null;
  const files = args.filter((a, i) => a !== "-o" && i !== outAt + 1 && a.endsWith(".json"));
  if (!files.length) { console.error("usage: node qa/sdk/report.mjs <record.json>... [-o report.html]"); process.exit(2); }
  const html = renderReport(files.map((f) => JSON.parse(readFileSync(f, "utf8"))));
  if (out) { writeFileSync(out, html); console.log(`  report ${out}`); } else process.stdout.write(html);
}
