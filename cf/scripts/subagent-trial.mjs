#!/usr/bin/env node
// What subagents did to one agent's work, before and after they were on, from its trace rows. Read-only.
//
//   node cf/scripts/subagent-trial.mjs [--preview] --tenant <tenantId> --agent <agentId> --from <ISO|ms> --to <ISO|ms>
//   node cf/scripts/subagent-trial.mjs --file <rows.ndjson> [--file …] [--from …] [--to …]
//
// Rows come from the agent's trace export in R2 (`trace/<tenant>/<agent>/<fromSeq>-<toSeq>.ndjson`, cf/src/trace-r2.ts),
// through the Cloudflare API: CF_API_TOKEN (R2 read) and R2_ACCOUNT_ID in the environment, as ~/.secrets/antiproton.env
// provides; the bucket is antiproton-artifacts, or antiproton-preview-artifacts with --preview. Rows still in the agent's
// outbox (the last pass's) are not there yet. --file reads ndjson instead (one row a line, the export's shape, or the
// preview trace route's `rows`). Prints one line per UTC day, then the window's totals, as JSON with --json.
//
// What it counts, all from rows the runtime writes (docs/agent-surface.md, "Trace"):
//   - model calls and tokens per session class: `main` (the agent's own conversations) and `sub` (`sub_…` sessions),
//     from `model.call` rows' `session`, `input` and `output`;
//   - main-context growth: the median and p90 of `input` tokens per main-session model call;
//   - rebuilds: `rebuild.decision` rows that ran (`shadow: false`);
//   - delegation: `subagent.start` rows by `how` (spawn, follow_up, wake), `subagent.turn` ends by outcome, and the
//     reports' sizes (`reportChars`).
// Ids and counts only: the trace holds no task text or report text, and nothing here prints any.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const ENDS = new Set(["done", "failed", "cancelled", "stopped"]);

/** The q-quantile (0..1) of numbers, by nearest rank; null for none. */
export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function bucket() {
  return {
    modelCalls: { main: 0, sub: 0 }, inputTokens: { main: 0, sub: 0 }, outputTokens: { main: 0, sub: 0 },
    mainInputs: [], rebuilds: 0, starts: { spawn: 0, follow_up: 0, wake: 0 }, ends: { done: 0, failed: 0, cancelled: 0, stopped: 0 },
    reportChars: [],
  };
}

function shape(b) {
  return {
    modelCalls: b.modelCalls, inputTokens: b.inputTokens, outputTokens: b.outputTokens,
    mainInputTokens: { median: quantile(b.mainInputs, 0.5), p90: quantile(b.mainInputs, 0.9), calls: b.mainInputs.length },
    rebuilds: b.rebuilds, delegations: b.starts, childTurns: b.ends,
    reportChars: { total: b.reportChars.reduce((a, n) => a + n, 0), median: quantile(b.reportChars, 0.5), reports: b.reportChars.length },
  };
}

/** Per UTC day and in total, from trace rows `{ at, kind, status, attrs, … }`, those with `from <= at < to`. */
export function summarize(rows, window = {}) {
  const from = window.from ?? -Infinity, to = window.to ?? Infinity;
  const days = new Map();
  const total = bucket();
  for (const r of rows) {
    if (!(r.at >= from && r.at < to)) continue;
    const day = new Date(r.at).toISOString().slice(0, 10);
    if (!days.has(day)) days.set(day, bucket());
    for (const b of [days.get(day), total]) {
      const a = r.attrs ?? {};
      if (r.kind === "model.call") {
        const cls = typeof a.session === "string" && a.session.startsWith("sub_") ? "sub" : "main";
        b.modelCalls[cls] += 1;
        if (typeof a.input === "number") b.inputTokens[cls] += a.input;
        if (typeof a.output === "number") b.outputTokens[cls] += a.output;
        if (cls === "main" && typeof a.input === "number") b.mainInputs.push(a.input);
      } else if (r.kind === "rebuild.decision" && a.shadow === false) {
        b.rebuilds += 1;
      } else if (r.kind === "subagent.start" && r.status in b.starts) {
        b.starts[r.status] += 1;
      } else if (r.kind === "subagent.turn" && ENDS.has(r.status)) {
        b.ends[r.status] += 1;
        if (typeof a.reportChars === "number" && r.status !== "stopped") b.reportChars.push(a.reportChars);
      }
    }
  }
  return { days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, b]) => ({ day, ...shape(b) })), total: shape(total) };
}

const when = (v) => v === undefined ? undefined : /^\d+$/.test(v) ? Number(v) : Date.parse(v);

async function fromR2({ tenant, agent, preview }) {
  const { CF_API_TOKEN: token, R2_ACCOUNT_ID: account } = process.env;
  if (!token || !account) throw new Error("CF_API_TOKEN and R2_ACCOUNT_ID are required (or give --file)");
  const bucketName = preview ? "antiproton-preview-artifacts" : "antiproton-artifacts";
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucketName}/objects`;
  const headers = { authorization: `Bearer ${token}` };
  const rows = [];
  let cursor;
  do {
    const q = new URLSearchParams({ prefix: `trace/${tenant}/${agent}/`, per_page: "1000", ...(cursor ? { cursor } : {}) });
    const listed = await (await fetch(`${base}?${q}`, { headers })).json();
    if (!listed.success) throw new Error(`listing the trace export failed: ${JSON.stringify(listed.errors ?? listed).slice(0, 300)}`);
    for (const o of listed.result ?? []) {
      const text = await (await fetch(`${base}/${encodeURIComponent(o.key)}`, { headers })).text();
      for (const line of text.split("\n")) if (line.trim()) rows.push(JSON.parse(line));
    }
    cursor = listed.result_info?.is_truncated ? listed.result_info.cursor : undefined;
  } while (cursor);
  return rows;
}

function fromFiles(files) {
  const rows = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8").trim();
    // The preview route answers a page `{ rows: [...] }`; the export is a row a line.
    if (text.startsWith("{") && text.includes('"rows"') && !text.includes("\n")) rows.push(...JSON.parse(text).rows);
    else for (const line of text.split("\n")) if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const files = args.flatMap((a, i) => (a === "--file" ? [args[i + 1]] : []));
  const window = { from: when(opt("--from")), to: when(opt("--to")) };
  if (!files.length && (!opt("--tenant") || !opt("--agent"))) { console.error("give --tenant and --agent, or --file"); process.exit(2); }
  const rows = files.length ? fromFiles(files)
    : await fromR2({ tenant: opt("--tenant"), agent: opt("--agent"), preview: args.includes("--preview") });
  const out = summarize(rows, window);
  if (args.includes("--json")) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
  const line = (label, s) => console.log(`${label}  calls main ${s.modelCalls.main} sub ${s.modelCalls.sub} | tokens in main ${s.inputTokens.main} sub ${s.inputTokens.sub}` +
    ` out main ${s.outputTokens.main} sub ${s.outputTokens.sub} | main input median ${s.mainInputTokens.median ?? "-"} p90 ${s.mainInputTokens.p90 ?? "-"}` +
    ` | rebuilds ${s.rebuilds} | delegations ${s.delegations.spawn}+${s.delegations.follow_up} follow-ups+${s.delegations.wake} wakes` +
    ` | child turns done ${s.childTurns.done} failed ${s.childTurns.failed} ceiling ${s.childTurns.cancelled} stopped ${s.childTurns.stopped}` +
    ` | report chars ${s.reportChars.total} (median ${s.reportChars.median ?? "-"})`);
  for (const d of out.days) line(d.day, d);
  line("total     ", out.total);
}
