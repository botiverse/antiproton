/**
 * One scripted conversation, run for real on either engine through `AgentRuntime` (cf/src/runtime.ts) over
 * node:sqlite: the readers' suites (test/pd-transcript.ts, test/transcript-read.ts, test/diagnose-read.ts,
 * test/admin-transcript.ts) read what each engine actually stored, rather than a hand-written copy of it.
 *
 * The model is the worker's side done by hand: each dispatched job is taken and answered with the next
 * scripted reply, as test/durable-agent.ts does for one turn.
 */
import { AgentRuntime } from "../../cf/src/runtime.ts";
import { fromResponse } from "../../src/model/pi-bridge.ts";
import { ApStore } from "../../src/store/ap-store.ts";
import { prefixedNamespace } from "../../src/store/sql-namespace.ts";
import type { sqliteHost } from "../../src/store/sqlite-host.ts";
import { operatorModelOf } from "../../cf/src/model-request.ts";

type Host = ReturnType<typeof sqliteHost>;
export type Engine = "pi085" | "pd";

/** A person's message and the model's reply to it: text, with usage the readers sum. */
export type ScriptedTurn = { say: string; reply: string; usage: { promptTokens: number; completionTokens: number; cachedPromptTokens: number; reasoningTokens: number } };

export const SCRIPT: ScriptedTurn[] = [
  { say: "Capital of France?", reply: "Paris.", usage: { promptTokens: 12, completionTokens: 3, cachedPromptTokens: 0, reasoningTokens: 0 } },
  { say: "And of Italy?", reply: "Rome.", usage: { promptTokens: 20, completionTokens: 2, cachedPromptTokens: 8, reasoningTokens: 1 } },
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * An agent's object as production leaves it, `demo/u-a` on `engine`: the owner row AgentDO writes, the
 * store's tables, the operator's model bound, and for pd the engine row written before anything opens it.
 */
export async function agentRuntime(host: Host, engine: Engine) {
  host.sql.exec("CREATE TABLE IF NOT EXISTS owner(k TEXT PRIMARY KEY, tenant_id TEXT, agent_id TEXT)");
  host.sql.exec("INSERT INTO owner(k, tenant_id, agent_id) VALUES ('self','demo','u-a')");
  if (engine === "pd") {
    const ap = new ApStore(host, prefixedNamespace("ap"));
    ap.ensure();
    ap.setEngineOnce("pd");
  }
  const sent: string[] = [];
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    sandbox: false, autoRelease: false,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  await rt.ready();
  await rt.bindOperatorModel("demo", "u-a");
  return { rt, sent };
}

/** Run `script` to its end: each message posted, its job answered, and the agent stepped until nothing is open. */
export async function converse(host: Host, engine: Engine, script: ScriptedTurn[] = SCRIPT) {
  const { rt, sent } = await agentRuntime(host, engine);
  let answered = 0;
  for (const turn of script) {
    await rt.postMessage("demo", "u-a", turn.say);
    for (let i = 0; i < 20; i++) {
      const out = await rt.step("demo", "u-a");
      while (answered < sent.length) {
        const id = sent[answered++]!;
        const job = await rt.takeJob("demo", "u-a", id) as { model: { api: string; provider: string; id: string } } | null;
        if (!job) continue;
        await rt.deliverAnswer("demo", "u-a", id, fromResponse({ text: turn.reply, finishReason: "stop", truncated: false, usage: turn.usage }, job.model, id), undefined);
      }
      if (out.wakeInMs === null && !(await (await rt.agent("demo", "u-a")).running())) break;
      await sleep(Math.min(out.wakeInMs ?? 0, 2_500));
    }
  }
  const agent = await rt.agent("demo", "u-a");
  return { rt, agent };
}
