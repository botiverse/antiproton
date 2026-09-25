/**
 * The reasoning dial on the OpenAI-compatible client (src/model/openai-compatible.ts):
 * what a request says about thinking, in DeepSeek's dialect, and — as important —
 * what it says when the caller said nothing.
 */
import { OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

/** The body of the one request the client made under a stubbed fetch. */
async function requestFor(opts: Parameters<OpenAiCompatibleModel["complete"]>[1]): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
  try {
    const m = new OpenAiCompatibleModel({ baseUrl: "https://provider.example/v1", apiKey: "k", model: "m" });
    const r = await m.complete([{ role: "user", content: "hi" }], opts);
    assert(r.text === "ok" && bodies.length === 1, `one request, one answer (got ${bodies.length})`);
    return bodies[0]!;
  } finally { globalThis.fetch = original; }
}

await check("a caller that says nothing sends the request it always did: no thinking field, no effort", async () => {
  const b = await requestFor({ maxTokens: 2000 });
  assert(!("thinking" in b) && !("reasoning_effort" in b), `unasked request carries ${Object.keys(b).join(",")}`);
  assert(b.max_tokens === 2000 && b.temperature === 0, "the rest of the body changed");
});

await check("reasoning off is DeepSeek's thinking.type=disabled, and no effort beside it", async () => {
  const b = await requestFor({ maxTokens: 2000, reasoning: "off" });
  assert(JSON.stringify(b.thinking) === JSON.stringify({ type: "disabled" }), `thinking ${JSON.stringify(b.thinking)}`);
  assert(!("reasoning_effort" in b), "an effort was sent with thinking off");
  assert(b.max_tokens === 2000, "the cap did not pass");
});

await check("low and high are reasoning_effort, with thinking left to the provider", async () => {
  for (const level of ["low", "high"] as const) {
    const b = await requestFor({ reasoning: level });
    assert(b.reasoning_effort === level && !("thinking" in b), `${level}: ${JSON.stringify({ e: b.reasoning_effort, t: b.thinking })}`);
  }
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
