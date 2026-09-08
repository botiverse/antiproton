/**
 * How does tool-selection accuracy decay as the action space grows?
 *
 * The harness cannot change the model's selection ability, but it decides how
 * many options to put in front of it — so it needs the curve. Everything is
 * held fixed except the number of distractors: same request, same correct tool,
 * same prompt, same model. The only variable is |catalogue|.
 *
 * The request is built from the target API's own description, which is about as
 * favourable as a query can get. Whatever decay shows up here is therefore a
 * LOWER bound on the decay under real task phrasing.
 *
 *   TRIALS=40 node --experimental-strip-types bench/appworld/selection.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { OpenAiCompatibleModel } from "../../src/model/openai-compatible.ts";
import { appworldPlugins, type Catalogue } from "../../src/plugins/appworld.ts";
import { qualifyMountedTools, type MountedTool } from "../../src/harness/hybrid.ts";

for (const l of readFileSync(`${homedir()}/.secrets/agent-harness.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}
const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!,
  model: process.env.HARNESS_MODEL ?? "deepseek-v4-pro",
});

const catalogue = JSON.parse(
  readFileSync(new URL("./catalogue.json", import.meta.url).pathname, "utf8"),
) as Catalogue;
const every: MountedTool[] = qualifyMountedTools(
  appworldPlugins(catalogue, { apiBaseUrl: "http://unused" }).flatMap((p) =>
    p.tools.map((t) => ({
      name: t.name, description: t.summary, parameters: t.parameters, address: `${p.id}.${t.name}`,
    })),
  ),
);

// Deterministic sampling: the same trials at every catalogue size, so the sizes
// are compared on identical requests rather than on different luck.
let seed = Number(process.env.SEED ?? 20260908);
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const shuffled = <T,>(xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; }
  return a;
};

const TRIALS = Number(process.env.TRIALS ?? 30);
const CONC = Number(process.env.CONC ?? 6);
// This provider refuses tool_choice:"required" for reasoning models
// ("Thinking mode does not support this tool_choice"), so abstention cannot be
// forced away — it is measured and reported separately instead.
const FORCE = (process.env.FORCE ?? "0") !== "0";
const SIZES = (process.env.SIZES ?? "8,32,128,447").split(",").map(Number);
const targets = shuffled(every).slice(0, TRIALS);

const tokensOf = (ts: MountedTool[]) =>
  Math.round(JSON.stringify(ts.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length / 4);

async function trial(target: MountedTool, size: number) {
  const others = shuffled(every.filter((t) => t.name !== target.name)).slice(0, Math.max(0, size - 1));
  const offered = shuffled([target, ...others]);
  const t0 = Date.now();
  const r = await model.complete(
    [
      { role: "system", content: "Pick the single tool that performs the requested action. Call it with any plausible arguments." },
      { role: "user", content: `I want to do this: ${target.description} Which tool does that? Call it.` },
    ],
    {
      // Reasoning tokens are billed against max_tokens: too tight a cap yields
      // finish_reason=length with no tool call, which would read as a wrong pick.
      maxTokens: 2000,
      tools: offered.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
      // Forcing a call removes "decided not to act" from the measurement, so
      // what is left is discrimination among alternatives — the thing the
      // catalogue size is supposed to affect.
      toolChoice: FORCE ? "required" : "auto",
    },
  );
  const picked = r.toolCalls?.[0]?.name ?? null;
  return {
    ok: picked === target.name, picked, ms: Date.now() - t0,
    prompt: r.usage.promptTokens, cached: r.usage.cachedPromptTokens,
    abstained: !picked,
  };
}

console.log(`\n  tool selection vs action-space size — ${TRIALS} trials per size, ` +
  `tool_choice=${FORCE ? "required" : "auto"}, ` +
  `model ${process.env.HARNESS_MODEL ?? "deepseek-v4-pro"}\n  ${"─".repeat(78)}`);
console.log("   size   catalogue tok   accuracy   abstained   mean latency   mean prompt tok");
const summary: any[] = [];
for (const size of SIZES) {
  // Concurrency only shortens wall clock; each trial is independent and the
  // measured latency is per-call, so it does not change what is being measured.
  const rows: any[] = [];
  const queue = [...targets];
  const workers = Array.from({ length: CONC }, async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      try { rows.push(await trial(t, size)); }
      catch (e) { rows.push({ ok: false, picked: null, ms: 0, prompt: 0, cached: 0, abstained: true, err: (e as Error).message }); }
    }
  });
  await Promise.all(workers);
  const acc = rows.filter((r) => r.ok).length / rows.length;
  const abst = rows.filter((r) => r.abstained).length;
  const ms = Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length);
  const pt = Math.round(rows.reduce((a, r) => a + r.prompt, 0) / rows.length);
  const catTok = tokensOf(shuffled(every).slice(0, size));
  summary.push({ size, acc, abst, ms, pt, catTok });
  console.log(`  ${String(size).padStart(5)}   ${String(catTok).padStart(13)}   ` +
    `${(100 * acc).toFixed(1).padStart(7)}%   ${String(abst).padStart(9)}   ` +
    `${String(ms + " ms").padStart(12)}   ${String(pt).padStart(15)}`);
}
console.log(`  ${"─".repeat(78)}`);
const base = summary[0]!;
for (const s of summary.slice(1)) {
  console.log(`  ${base.size} -> ${s.size} tools: accuracy ${(100 * base.acc).toFixed(1)}% -> ${(100 * s.acc).toFixed(1)}%` +
    `  (${((s.acc - base.acc) * 100).toFixed(1)} pts), prompt ×${(s.pt / Math.max(base.pt, 1)).toFixed(1)},` +
    ` latency ×${(s.ms / Math.max(base.ms, 1)).toFixed(1)}`);
}
console.log();
