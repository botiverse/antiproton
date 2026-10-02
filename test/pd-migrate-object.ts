/**
 * The migration through the whole `AgentDO` (cf/src/index.ts), reached the way an operator reaches it: the worker's
 * `fetch` on `POST /admin/migrate-engine`, routed to the object (`AgentDO.migrateEngine`), with the console's entry
 * points driving the agent around it — a pi085 turn, the move to pd, a turn on pd, the rollback, a turn on pi085.
 * test/pd-migrate.ts has the importer's own cases; this is the wiring, on one object under node, with the
 * `cloudflare:workers` module as test/pd-writes.ts stands it in.
 */
import { register } from "node:module";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { recordedEngine, DurableAgent } from "../src/runtime/durable-agent.ts";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { runDriveCases, type DriveCase } from "./spec/durable-drive-spec.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");

const T = "t", A = "a", TOKEN = "operator-token";
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const d1 = () => {
  const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 1 } }) };
  return { prepare: () => stmt, batch: async (s: unknown[]) => s.map(() => ({ results: [], meta: { changes: 1 } })) };
};

const wholeObject: DriveCase = {
  group: "the whole object", name: "POST /admin/migrate-engine through the worker and AgentDO: auth refused without the token; a pi085 turn, the move, a pd turn carrying the history, the rollback, a pi085 turn",
  async run() {
    const raw = sqliteHost();
    try {
      const jobs: string[] = [];
      let alarmAt: number | null = null;
      let blocked = 0 as number;
      const ctx = {
        storage: {
          sql: raw.sql, transactionSync: raw.transactionSync,
          getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; },
        },
        // The platform's: nothing else runs in the object meanwhile. Counted, so the move is seen to ask for it.
        blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => { blocked++; return fn(); },
        id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
      };
      const objects = new Map<string, unknown>();
      const env: Record<string, unknown> = {
        MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
        ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
        ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "m1",
        DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", AUTOMATION_TOKEN: TOKEN,
        // Another name is another object: a fresh one, on storage of its own.
        AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? fresh(n) },
      };
      const others: Array<{ dispose(): void }> = [];
      const fresh = (n: string) => {
        const own = sqliteHost();
        others.push(own);
        const o = new AgentDO({ ...ctx, storage: { ...ctx.storage, sql: own.sql, transactionSync: own.transactionSync } } as never, env as never);
        objects.set(n, o);
        return o;
      };
      const D = new AgentDO(ctx as never, env as never);
      objects.set(agentObjectName(T, A), D);
      await D.uiAdoptAgent(T, A, { name: "n", description: "d", avatar: "x" });
      const rt = D.runtime();
      await rt.ready();
      await rt.bindOperatorModel(T, A);

      const requests: string[] = [];
      let answered = 0;
      const turn = async (text: string, reply: string) => {
        await D.uiSay(T, A, `t_${A}`, text, "steer");
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          if (jobs.length > answered) {
            const id = jobs[answered++]!;
            const job = await D.takeJob(T, A, id) as { model?: { api?: string; provider?: string } } | null;
            check(job, `job ${id} was not available`);
            requests.push(show(job));
            await D.deliverAnswer(T, A, id, { role: "assistant", content: [{ type: "text", text: reply }], api: job.model?.api ?? "x", provider: job.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0 }, 5);
            continue;
          }
          await D.alarm();
          if (jobs.length > answered) continue;
          if (alarmAt === null || alarmAt - Date.now() > 5_000) return requests.at(-1)!;
          await sleep(Math.max(0, Math.min(alarmAt - Date.now(), 50)));
        }
        throw new Error(`the turn "${text}" did not settle`);
      };
      const route = (query: string, headers: Record<string, string> = { "x-harness-token": TOKEN }) =>
        worker.fetch(new Request(`https://x/admin/migrate-engine?tenantId=${T}&agentId=${A}${query}`, { method: "POST", headers }), env as never);

      await turn("remember the word kumquat", "noted");
      check(await rt.agent(T, A) instanceof PiAgent, "control: the agent is not on pi085");

      // Auth: refused before the object is asked, which a refusal leaves exactly as it was.
      check((await route("", {})).status === 401, "no token was not refused");
      check((await route("", { "x-harness-token": "wrong" })).status === 401, "a wrong token was not refused");
      check((await worker.fetch(new Request(`https://x/admin/migrate-engine?tenantId=${T}&agentId=${A}`, { headers: { "x-harness-token": TOKEN } }), env as never)).status === 405, "GET was not refused");
      check(recordedEngine(raw.sql) === null, "a refused request moved the engine");

      const dry = await route("&dryRun=1");
      const dryBody = await dry.json() as { action?: string };
      check(dry.status === 200 && dryBody.action === "dry-run" && recordedEngine(raw.sql) === null && blocked === 0, `dry-run: ${dry.status} ${show(dryBody)}`);
      const moved = await route("");
      const movedBody = await moved.json() as { action?: string; engine?: string };
      check(moved.status === 200 && movedBody.action === "migrated" && movedBody.engine === "pd" && (blocked as number) === 1, `migrate: ${moved.status} ${show(movedBody)}`);
      check(await rt.agent(T, A) instanceof DurableAgent, "the object did not reopen the agent on pd");
      const again = await route("");
      check(again.status === 200 && (await again.json() as { action?: string }).action === "already", "a second migration");

      const onPd = await turn("what was the word?", "kumquat");
      check(onPd.includes("remember the word kumquat") && onPd.includes("noted"), `pd's request lacks the pi085 history: ${onPd.slice(0, 400)}`);

      const back = await route("&op=revert");
      const backBody = await back.json() as { action?: string; engine?: string };
      check(back.status === 200 && backBody.action === "reverted" && backBody.engine === "pi085", `revert: ${back.status} ${show(backBody)}`);
      check(await rt.agent(T, A) instanceof PiAgent, "the object did not reopen the agent on pi085");
      const onPi = await turn("and now?", "still here");
      check(onPi.includes("remember the word kumquat") && !onPi.includes("what was the word?"), `pi085's request after the rollback: ${onPi.slice(0, 400)}`);

      const nobody = await worker.fetch(new Request(`https://x/admin/migrate-engine?tenantId=${T}&agentId=other`, { method: "POST", headers: { "x-harness-token": TOKEN } }), env as never);
      check(nobody.status === 404, `an agent no object holds: ${nobody.status}`);
      for (const o of others) o.dispose();
    } finally { raw.dispose(); }
  },
};

const results = await runDriveCases([wholeObject]);
console.log(`\n  pd migration through AgentDO and its route — node:sqlite\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok
    ? `    \x1b[32m✓\x1b[0m ${r.name} \x1b[2m(${r.ms} ms)\x1b[0m`
    : `    \x1b[31m✗\x1b[0m ${r.name}\n        \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
