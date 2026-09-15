// QA for the OpenAI-compatible agents API, driven by the official SDK (task #17).
//
// Manually triggered, never part of the deploy gate (tygg, 2026-09-15: "有需要再跑").
// The target comes only from the SDK's own environment variables, so this is also
// the proof that a program written for the SDK needs nothing but an address:
//   OPENAI_BASE_URL   e.g. https://preview.antiproton.ai/v1
//   OPENAI_API_KEY    an ap- key issued by /admin/api-keys
//   QA_TIER           contract | model | all   (default: contract)
//   QA_ONLY           a substring to run matching scenarios only
//   QA_OUT            where to write the JSON record (default: qa/sdk/out/)
//
// Each scenario file in scenarios/ exports { name, tier, run }. `contract` needs no
// model and holds on any deployment; `model` needs the deployment to reach a real
// model. A scenario creates what it uses and registers its cleanup.
//
// Depends on: openai 7.15.0 (qa/sdk/package.json) — the SDK these scenarios call. When it
//   is upgraded, re-run every tier and re-check cf/src/agents-api/* against its new types.
import OpenAIModule from "openai";
import { readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport } from "./report.mjs";

const OpenAI = OpenAIModule.default ?? OpenAIModule;
const here = dirname(fileURLToPath(import.meta.url));
const tier = process.env.QA_TIER ?? "contract";
const only = process.env.QA_ONLY ?? "";
if (!process.env.OPENAI_BASE_URL || !process.env.OPENAI_API_KEY) {
  console.error("set OPENAI_BASE_URL and OPENAI_API_KEY (qa/sdk/run.sh does both)");
  process.exit(2);
}

const client = new OpenAI({ timeout: 240_000, maxRetries: 0 });
const sdkVersion = JSON.parse(readFileSync(join(here, "node_modules/openai/package.json"), "utf8")).version;
const base = client.baseURL;
const build = await fetch(new URL("/ui/whoami", base)).then((r) => r.json()).then((j) => j.build ?? null).catch(() => null);

const scenarios = [];
for (const file of readdirSync(join(here, "scenarios")).filter((f) => f.endsWith(".mjs")).sort()) {
  const mod = await import(join(here, "scenarios", file));
  for (const s of mod.default ?? []) scenarios.push({ ...s, file });
}
const chosen = scenarios.filter((s) => (tier === "all" || s.tier === tier) && s.name.includes(only));

function assert(cond, message) { if (!cond) throw new Error(message); }
const TERMINAL = /^agent\.session\.turn\.(completed|failed|cancelled)$/;

const results = [];
const started = new Date().toISOString();
console.log(`\n  agents API QA — ${chosen.length} scenario(s), tier ${tier}, openai ${sdkVersion}`);
console.log(`  target ${base}  build ${build ?? "unknown"}\n`);
for (const s of chosen) {
  const cleanups = [];
  const t0 = Date.now();
  const ctx = {
    client, OpenAI, assert, TERMINAL,
    tag: `qa-${s.name}-${Date.now().toString(36)}`,
    cleanup: (fn) => cleanups.push(fn),
  };
  let ok = false, note, error;
  try { note = await s.run(ctx); ok = true; }
  catch (e) { error = `${e?.constructor?.name}: ${String(e?.message ?? e).slice(0, 600)}`; }
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* cleanup is best effort */ } }
  const ms = Date.now() - t0;
  results.push({ name: s.name, tier: s.tier, file: s.file, ok, ms, ...(note ? { note: String(note).slice(0, 800) } : {}), ...(error ? { error } : {}) });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${s.tier.padEnd(8)} ${s.name} (${(ms / 1000).toFixed(1)}s)`);
  if (note) console.log(`         ${String(note).slice(0, 300)}`);
  if (error) console.log(`         ${error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length - failed}/${results.length} passed\n`);

const out = process.env.QA_OUT ?? join(here, "out");
mkdirSync(out, { recursive: true });
const record = { kind: "agents-api-sdk-qa", started, finished: new Date().toISOString(), target: base, build, sdk: `openai ${sdkVersion}`, tier, only: only || null, passed: results.length - failed, total: results.length, results };
const file = join(out, `qa-${started.replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify(record, null, 2));
writeFileSync(file.replace(/\.json$/, ".html"), renderReport([record]));
console.log(`  recorded ${file} (and .html)`);
process.exit(failed ? 1 : 0);
