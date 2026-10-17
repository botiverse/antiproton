/**
 * A turn the operator starts through `/agent/message` (cf/src/index.ts, AgentDO `startTask`) is reported to the service
 * the agent belongs to as any turn is: the message is an `inbound` row, `delivered`, which activity reads as the turn's
 * UserPromptSubmit (src/runtime/activity.ts), and the model's answer is its Stop. Without the row the turn had a Stop
 * and no start, so a per-turn summary had nothing to begin from.
 *
 * The whole `AgentDO` under node, as test/capability-reconcile.ts runs it, the model faked at the queue.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { activityEvents } from "../src/runtime/activity.ts";
import { pendingTrace } from "../src/trace/outbox.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const stmt = (q: string, b: unknown[] = []): any => ({
    q, b,
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.prepare(q).get(...(b as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...(b as any[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  return { prepare: (q: string) => stmt(q), batch: async (s: any[]) => s.map((x) => ({ results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } })) };
}

await check("a message through /agent/message makes one UserPromptSubmit, then the agent's Stop", async () => {
  const host = sqliteHost();
  const jobs: string[] = [];
  /** What the alarm's export wrote: trace rows leave the outbox once exported (cf/src/trace-r2.ts). */
  const exported: any[] = [];
  let alarmAt: number | null = null;
  const env = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: {
      put: async (key: string, body: unknown) => {
        // The export's batches are rows a line; anything else it writes under the prefix is not rows.
        const text = body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body);
        if (key.startsWith("trace/") && key.endsWith(".ndjson")) for (const line of text.split("\n")) if (line.trim()) exported.push(JSON.parse(line));
        return {};
      },
      head: async () => null, list: async () => ({ objects: [] }), get: async () => null,
    },
    ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "deepseek-flash", DEEPSEEK_BASE_URL: "https://api.deepseek.com",
    MODEL_PROVIDERS: [{ id: "deepseek", baseUrl: "https://api.deepseek.com", auth: { secret: "DEEPSEEK_API_KEY", header: "authorization" } }],
    DEEPSEEK_API_KEY: "dk", SESSION_SECRET: "s".repeat(32), SECRET_KEK: Buffer.alloc(32, 7).toString("base64"),
  };
  const name = agentObjectName("t", "a");
  const o: any = new AgentDO({
    storage: { sql: host.sql, transactionSync: host.transactionSync, getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; } },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(), id: { toString: () => name }, getWebSockets: () => [], exports: {}, waitUntil: () => {},
  } as never, { ...env, AGENT: { idFromName: (n: string) => n, get: () => o } } as never);
  await o.startTask("t", "a", "task_op1", "what is two plus two");
  for (let i = 0; i < 10 && !jobs.length && alarmAt !== null; i++) await o.alarm();
  must(jobs.length === 1, `no model call: ${jobs.length}`);
  const id = jobs.shift()!;
  const job = await o.takeJob("t", "a", id) as any;
  const answer: ModelResponse = { text: "four", finishReason: "stop", truncated: false, usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 } } as ModelResponse;
  await o.deliverAnswer("t", "a", id, fromResponse(answer, job.model, id), 5);
  for (let i = 0; i < 5 && alarmAt !== null; i++) await o.alarm();
  const rows = [...exported, ...pendingTrace(host.sql as never, 0).rows].sort((a, b) => a.seq - b.seq);
  const inbound = rows.filter((r) => r.kind === "inbound");
  must(inbound.length === 1 && inbound[0]!.status === "delivered" && inbound[0]!.attrs.alias === "operator" && inbound[0]!.spanId === "operator:task_op1", `the inbound row: ${show(inbound)}`);
  // The text is not in the row: ids only, as a push's is.
  must(!JSON.stringify(inbound).includes("two plus two"), "the message's text is in its row");
  const events = activityEvents("a", rows).filter((e) => e.hookEventName);
  const names = events.map((e) => e.hookEventName);
  must(names.filter((n) => n === "UserPromptSubmit").length === 1 && names.filter((n) => n === "Stop").length === 1
    && names.indexOf("UserPromptSubmit") < names.indexOf("Stop"), `events: ${show(names)}`);
  host.dispose();
});

let failed = 0;
for (const r of results) {
  if (r.ok) console.log(`  \x1b[32m✓\x1b[0m ${r.name}`);
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`); }
}
console.log(`\n  ${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
