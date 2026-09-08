/**
 * What actually invalidates the prompt cache?
 *
 * The AppWorld arms turned on this: the 447-tool arm cached 98.9% of its prompt
 * while the narrowing arm managed 82%, and the narrowing arm's whole purpose was
 * to spend fewer tokens. If editing the tool block discards the cached prefix,
 * then "trim the context to what is needed" is a negative-value idea on a cached
 * provider unless the trim is itself stable.
 *
 * Deterministic, so a few dozen calls settle it. One variable per arm:
 *   static   tools identical every turn                (the 447-tool arm)
 *   churn    one tool swapped every turn               (the narrowing arm)
 *   grow     tools appended every turn                 (progressive disclosure)
 *   sysedit  tools identical, system message edited    (control: any prefix edit)
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import type { ModelMessage, ToolDefinition } from "../src/model/types.ts";

for (const l of readFileSync(`${homedir()}/.secrets/agent-harness.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim());
  if (m) process.env[m[1]!] = m[2]!;
}
const model = new OpenAiCompatibleModel({
  baseUrl: process.env.DEEPSEEK_BASE_URL!, apiKey: process.env.DEEPSEEK_API_KEY!,
  model: process.env.HARNESS_MODEL ?? "deepseek-v4-pro",
});

const POOL: ToolDefinition[] = Array.from({ length: 200 }, (_, i) => ({
  name: `tool_${i}`,
  description: `Perform operation number ${i} on a record, returning its identifier and status.`,
  parameters: {
    type: "object",
    properties: { id: { type: "integer", description: "record id" }, note: { type: "string" } },
    required: ["id"],
  },
}));
const BASE = 100;
const TURNS = Number(process.env.TURNS ?? 7);
const RUN = Math.random().toString(36).slice(2, 8);

type Arm = "static" | "churn" | "grow" | "sysedit";
const toolsFor = (arm: Arm, turn: number): ToolDefinition[] => {
  if (arm === "churn") return [...POOL.slice(1, BASE), POOL[BASE + turn]!];
  if (arm === "grow") return POOL.slice(0, BASE + turn * 4);
  return POOL.slice(0, BASE);
};
const systemFor = (arm: Arm, turn: number) =>
  `You are a terse assistant for run ${RUN}.` + (arm === "sysedit" ? ` Turn ${turn}.` : "");

async function arm(a: Arm) {
  const msgs: ModelMessage[] = [];
  const rows: Array<{ turn: number; prompt: number; cached: number }> = [];
  for (let turn = 0; turn < TURNS; turn++) {
    msgs.push({ role: "user", content: `Question ${turn}: reply with the single word "ok".` });
    const all: ModelMessage[] = [{ role: "system", content: systemFor(a, turn) }, ...msgs];
    const r = await model.complete(all, { maxTokens: 900, tools: toolsFor(a, turn) });
    msgs.push({ role: "assistant", content: r.text || "ok" });
    rows.push({ turn, prompt: r.usage.promptTokens, cached: r.usage.cachedPromptTokens });
  }
  return rows;
}

console.log(`\n  prompt-cache stability — ${BASE} tools, ${TURNS} turns, model ` +
  `${process.env.HARNESS_MODEL ?? "deepseek-v4-pro"}\n  ${"─".repeat(76)}`);
console.log("  arm       " + Array.from({ length: TURNS }, (_, i) => `t${i}`.padStart(7)).join("") +
  "    cached%   uncached tok");
const out: Record<string, any> = {};
for (const a of ["static", "churn", "grow", "sysedit"] as Arm[]) {
  const rows = await arm(a);
  const prompt = rows.reduce((s, r) => s + r.prompt, 0);
  const cached = rows.reduce((s, r) => s + r.cached, 0);
  out[a] = { prompt, cached, uncached: prompt - cached };
  console.log(`  ${a.padEnd(9)} ` +
    rows.map((r) => `${Math.round((100 * r.cached) / Math.max(r.prompt, 1))}%`.padStart(7)).join("") +
    `  ${((100 * cached) / Math.max(prompt, 1)).toFixed(1).padStart(7)}%   ${String(prompt - cached).padStart(12)}`);
}
console.log(`  ${"─".repeat(76)}`);
const s = out.static, c = out.churn;
console.log(`  swapping one tool of ${BASE} costs ${(c.uncached / Math.max(s.uncached, 1)).toFixed(1)}x ` +
  `the uncached tokens of leaving them alone (${s.uncached} -> ${c.uncached})\n`);
