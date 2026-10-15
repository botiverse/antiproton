/**
 * The deadline on the OpenAI-compatible client (src/model/openai-compatible.ts): a provider that
 * accepts a request and never finishes answering must fail the call, inside the deadline and with a
 * message that says so, rather than hold it until the platform kills whoever is waiting.
 *
 * Each stub honours the request's signal the way a real fetch does — the pending promise, or the
 * body stream, errors with the signal's reason — and otherwise never settles.
 */
import { MODEL_CALL_DEADLINE_MS, OpenAiCompatibleModel } from "../src/model/openai-compatible.ts";
import { MODEL_BUSY_ERROR } from "../src/model/model-fallback.ts";
import { callQueuedModel } from "../cf/src/model-request.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const DEADLINE_MS = 150;
/** Far past the deadline, so a call still out by then is one the deadline did not end. */
const WATCHDOG_MS = 3000;

const ANSWER = JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} });

/** A promise that rejects with the signal's reason when it aborts, and otherwise never settles. */
function untilAborted(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) return;
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

/** Runs one `complete` under a stubbed fetch; returns how it settled and how long it took. */
async function callWith(stub: (init: RequestInit | undefined, n: number) => Promise<Response>) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => stub(init, ++calls)) as typeof fetch;
  const t0 = Date.now();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const m = new OpenAiCompatibleModel({ baseUrl: "https://provider.example/v1", apiKey: "k", model: "m", deadlineMs: DEADLINE_MS });
    const outcome = await Promise.race([
      m.complete([{ role: "user", content: "hi" }]).then(
        (r) => ({ settled: "resolved" as const, text: r.text }),
        (e) => ({ settled: "rejected" as const, error: String((e as Error)?.message ?? e) })),
      new Promise<{ settled: "pending" }>((r) => { watchdog = setTimeout(() => r({ settled: "pending" }), WATCHDOG_MS); }),
    ]);
    return { ...outcome, ms: Date.now() - t0, calls };
  } finally {
    clearTimeout(watchdog);
    globalThis.fetch = original;
  }
}

function assertTimedOut(r: Awaited<ReturnType<typeof callWith>>) {
  assert(r.settled !== "pending", `the call was still out after ${WATCHDOG_MS} ms against a ${DEADLINE_MS} ms deadline`);
  assert(r.settled === "rejected", `the call resolved: ${JSON.stringify(r)}`);
  const error = (r as { error: string }).error;
  assert(/timed out/.test(error) && error.includes(`${DEADLINE_MS / 1000} s total deadline`),
    `the error does not say it timed out, after how long and on which deadline: ${error}`);
  assert(r.ms < DEADLINE_MS + 1000, `took ${r.ms} ms against a ${DEADLINE_MS} ms deadline`);
}

await check("a provider that never answers fails the call as a timeout, inside the deadline, without another attempt", async () => {
  const r = await callWith((init) => untilAborted(init?.signal));
  assertTimedOut(r);
  assert(r.calls === 1, `${r.calls} requests: an attempt after the deadline has no time to run in`);
});

await check("headers that arrive and a body that stalls fail the same way: the deadline covers the body read", async () => {
  const r = await callWith(async (init) => {
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        // Some of the body, then nothing: the read of the rest is what has to be bounded.
        controller.enqueue(new TextEncoder().encode("{\"choices\":"));
        signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  });
  assertTimedOut(r);
});

// DeepSeek answers 200 with headers early and then, while the request is queued, sends only blank
// lines (non-streaming) or ": keep-alive" comments (streaming) for minutes (probed 2026-10-01). Bytes
// that keep arriving are not an answer, so they must not hold the call open past its deadline.
await check("headers then only keep-alive lines, blank or SSE comment, still fail as a timeout", async () => {
  let ticker: ReturnType<typeof setInterval> | undefined;
  let sent = 0;
  try {
    const r = await callWith(async (init) => {
      const signal = init?.signal;
      if (signal?.aborted) throw signal.reason;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          ticker = setInterval(() => { controller.enqueue(enc.encode(sent++ % 2 ? "\n" : ": keep-alive\n\n")); }, 20);
          signal?.addEventListener("abort", () => { clearInterval(ticker); controller.error(signal.reason); }, { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    });
    assertTimedOut(r);
    assert(sent >= 3, `only ${sent} keep-alive lines were sent, so the case did not run as described`);
  } finally { clearInterval(ticker); }
});

await check("the deadline spans attempts: a 503 then a hang is one timeout, naming the error before it", async () => {
  const r = await callWith(async (init, n) =>
    n === 1 ? new Response("overloaded", { status: 503 }) : untilAborted(init?.signal));
  assertTimedOut(r);
  assert(r.calls === 2, `${r.calls} requests`);
  assert((r as { error: string }).error.includes("model 503: overloaded"), `the earlier error is lost: ${(r as { error: string }).error}`);
});

await check("an answer inside the deadline is the answer it always was", async () => {
  const r = await callWith(async () => new Response(ANSWER, { status: 200 }));
  assert(r.settled === "resolved" && (r as { text: string }).text === "ok", JSON.stringify(r));
});

await check("the default deadline is under the queue consumer's 15-minute wall-time limit, with room to spare", async () => {
  assert(MODEL_CALL_DEADLINE_MS > 0 && MODEL_CALL_DEADLINE_MS <= 15 * 60_000 - 3 * 60_000,
    `MODEL_CALL_DEADLINE_MS is ${MODEL_CALL_DEADLINE_MS}`);
});

await check("a first-turn call marked to fall back: each model under its own limit, the two together far inside the call deadline", async () => {
  const original = globalThis.fetch;
  const hosts: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => { hosts.push(new URL(String(url)).host); return untilAborted(init?.signal); }) as typeof fetch;
  const t0 = Date.now();
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    const env = { DEEPSEEK_BASE_URL: "https://provider.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "deepseek-flash", GW: "g",
      MODEL_PROVIDERS: [{ id: "deepseek", baseUrl: "https://provider.example/v1", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } },
        { id: "cloudflare", baseUrl: "https://gw.example/compat", auth: { secret: "GW", header: "cf-aig-authorization" }, modelFormat: "vendor/model" }] } as any;
    const job = { context: { systemPrompt: "s", messages: [{ role: "user", content: "hi", timestamp: 0 }] }, operatorModel: "deepseek-flash", operatorProvider: "deepseek",
      fallback: { provider: "cloudflare", model: "openai/gpt-5.6-luna", primaryMs: DEADLINE_MS, fallbackMs: DEADLINE_MS } };
    const a = await Promise.race([
      callQueuedModel(env, job, "mj_t") as Promise<any>,
      new Promise<null>((r) => { watchdog = setTimeout(() => r(null), WATCHDOG_MS); }),
    ]);
    const ms = Date.now() - t0;
    assert(a !== null, `the call was still out after ${WATCHDOG_MS} ms`);
    assert(a.errorMessage === MODEL_BUSY_ERROR && a.fallback?.primaryOutcome === "timeout" && a.fallback?.fallbackOutcome === "timeout", JSON.stringify(a));
    assert(ms >= 2 * DEADLINE_MS && ms < 2 * DEADLINE_MS + 1000, `took ${ms} ms against two ${DEADLINE_MS} ms limits`);
    assert(JSON.stringify(hosts) === JSON.stringify(["provider.example", "gw.example"]), JSON.stringify(hosts));
  } finally { clearTimeout(watchdog); globalThis.fetch = original; }
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
