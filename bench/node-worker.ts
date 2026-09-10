/**
 * What the queue does in production, as a function.
 *
 * The shape that matters is preserved, and it is the reason this is not simply
 * an inline call: `dispatch` returns immediately, so a pass is never blocked on
 * the provider, and the answer arrives later through `deliver()` exactly as it
 * does when a Worker hands it back. On Cloudflare the waiting happens in a
 * Worker billed for CPU; here it happens on a promise nobody is awaiting.
 *
 * Shared by both benchmarks so neither measures a loop the deployment does not
 * run.
 */
import type { PiAgent } from "../src/runtime/pi-agent.ts";
import type { ModelAdapter } from "../src/model/types.ts";
import { toRequest, fromResponse, errorMessage } from "../src/model/pi-bridge.ts";

export function nodeWorker(model: ModelAdapter, agentOf: () => PiAgent, fallbackModelId: string) {
  let inFlight = 0;
  let calls = 0;
  return {
    get inFlight() { return inFlight; },
    get calls() { return calls; },
    dispatch(jobId: string) {
      const agent = agentOf();
      const job = agent.takeJob(jobId) as any;
      // Null means it was already answered — a second dispatch of the same job
      // must not call the provider again.
      if (!job) return;
      inFlight += 1;
      calls += 1;
      const identity = {
        api: String(job.model?.api ?? "offloaded"),
        provider: String(job.model?.provider ?? "openai-compatible"),
        id: String(job.model?.id ?? fallbackModelId),
      };
      void (async () => {
        try {
          const { messages, tools } = toRequest(job.context);
          const r = await model.complete(messages, tools ? { tools } : {});
          agent.deliver(jobId, fromResponse(r, identity));
        } catch (e: any) {
          agent.deliver(jobId, errorMessage(String(e?.message ?? e).slice(0, 300), identity));
        } finally { inFlight -= 1; }
      })();
    },
  };
}

/**
 * Drive one lane to rest, the way an alarm does: one pass, then come back when
 * the pass said to. Returns the agent's last plain reply, or null if it never
 * reached one.
 */
export async function runToRest(
  agent: PiAgent,
  worker: { inFlight: number },
  ctx: unknown,
  budgetMs = 300_000,
): Promise<{ answer: string | null; passes: number; ended: string }> {
  const t0 = Date.now();
  let passes = 0;
  while (Date.now() - t0 < budgetMs) {
    const out = await agent.step();
    passes += 1;
    // Idle counts only when nothing is still out: a pass can find no open
    // operation while the provider is mid-answer.
    if (out.wakeInMs === null && worker.inFlight === 0) {
      return { answer: await lastReply(agent, ctx), passes, ended: "idle" };
    }
    await new Promise((r) => setTimeout(r, Math.max(150, Math.min(out.wakeInMs ?? 300, 1_500))));
  }
  return { answer: await lastReply(agent, ctx), passes, ended: "budget" };
}

/** The last thing the agent said in its own voice — not a tool call. */
async function lastReply(agent: PiAgent, ctx: unknown): Promise<string | null> {
  const entries = await agent.storage.scanEntries({ order: "desc", limit: 40 }, ctx as any);
  for (const e of entries as any[]) {
    const m = e.message;
    if (m?.role !== "assistant" || m.stopReason === "deferred") continue;
    const calls = (m.content ?? []).filter((c: any) => c?.type === "toolCall");
    if (calls.length) continue;
    const text = (m.content ?? []).filter((c: any) => c?.type === "text")
      .map((c: any) => c.text).join("").trim();
    if (text) return text;
  }
  return null;
}
