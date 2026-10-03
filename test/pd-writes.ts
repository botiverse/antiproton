/**
 * Writes on a `pd` object: the runtime's cases (test/spec/pd-writes-spec.ts) over node:sqlite, and, node's
 * only, the whole `AgentDO`: a pd agent driven through the object's own entry points — a console message,
 * the alarm, the model queue's take and deliver, an approval, an API input that rebinds the model, a
 * question left to expire, a background job, the idle lease — with some of them started as a pi-durable
 * commit ends (test/spec/pd-commits.ts), each checked for what it is for.
 * `npm run pd-writes:do` runs the spec's cases on a real Durable Object; the whole object needs the
 * `cloudflare:workers` module, which node has only as the stand-in below.
 */
import { register } from "node:module";
import type { Json } from "../src/core/types.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { runDriveCases, type DriveCase } from "./spec/durable-drive-spec.ts";
import { pdWritesCases, testPlugins, type Seen } from "./spec/pd-writes-spec.ts";
import { afterPdCommits } from "./spec/pd-commits.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

// `cloudflare:workers`, as much of it as cf/src/index.ts touches when constructed under node.
const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO } = await import("../cf/src/index.ts");

const T = "t", A = "a";
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** D1 as far as the alarm's flush and the model choice ask it: nothing stored, every write accepted. */
const d1 = () => {
  const stmt = {
    bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({ meta: { changes: 1 } }),
  };
  return { prepare: () => stmt, batch: async (s: unknown[]) => s.map(() => ({ results: [], meta: { changes: 1 } })) };
};

const wholeObject: DriveCase = {
  group: "the whole object", name: "a pd turn through AgentDO's entry points — approval, API input with a model binding, a caller's function result, a cancel, question expiry, background job, idle lease, alarms",
  async run() {
    const raw = sqliteHost();
    try {
      let armed: Array<() => void> = [];
      // Started as the next pi-durable commit ends.
      const g = afterPdCommits(raw, () => { for (const start of armed.splice(0)) start(); });
      const during = <R>(fn: () => Promise<R>) => new Promise<{ ok: boolean; value?: R; error?: string }>((resolve) => {
        armed.push(() => { fn().then((value) => resolve({ ok: true, value }), (e) => resolve({ ok: false, error: String(e?.message ?? e) })); });
      });
      // The engine choice, as a creation path writes it, before the object first wakes.
      const ap = new ApStore(raw, prefixedNamespace("ap"));
      ap.ensure();
      ap.setEngineOnce("pd");

      const seen: Seen = [];
      const held = { lastUsedAt: null as number | null };
      const plugins = testPlugins(seen, held);
      class TestDO extends AgentDO { protected override extraPlugins() { return plugins; } }
      const jobs: string[] = [];
      let alarmAt: number | null = null;
      const ctx = {
        storage: {
          sql: g.sql, transactionSync: g.transactionSync,
          getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; },
        },
        id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
      };
      const env = {
        MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
        ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
        ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "m1",
        DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k",
        RUN9_WARN_MINUTES: "1", RUN9_MAX_IDLE_MINUTES: "2", RUN_JS_RESUME_MS: "400",
      };
      const D = new TestDO(ctx as never, env as never);

      // An agent as the console makes it, with the three test mounts. Nothing of pi-durable's is open yet.
      await D.uiAdoptAgent(T, A, { name: "n", description: "d", avatar: "x" });
      const rt = D.runtime();
      await rt.ready();
      await rt.bindOperatorModel(T, A);
      for (const plugin of ["web", "box", "lease"]) {
        await rt.store.setPluginChoice(T, A, plugin, "enable");
        await rt.store.addMount({
          tenantId: T, agentId: A, alias: plugin, plugin, installationId: "i", connectionId: null, toolVersion: "1.0.0",
          publicConfig: {}, secretRef: null, policy: plugin === "web" ? { tools: { send: "approval" } } as never : null,
        });
      }

      const requests: string[] = [];
      let answered = 0;
      /** Alarm until the agent asks the model something new; answer it through the queue's entry points. */
      const answer = async (content: unknown[], stop: "toolUse" | "stop") => {
        for (let i = 0; i < 100 && jobs.length <= answered; i++) { await D.alarm(); if (jobs.length <= answered) await sleep(10); }
        check(jobs.length > answered, `the agent asked nothing new (${jobs.length} jobs)`);
        const id = jobs[answered++]!;
        const job = await D.takeJob(T, A, id) as { model?: { api?: string; provider?: string } } | null;
        check(job && !("unknownJob" in job), `job ${id}: ${show(job)}`);
        requests.push(JSON.stringify(job));
        await D.deliverAnswer(T, A, id, { role: "assistant", content, api: job.model?.api ?? "x", provider: job.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: stop, timestamp: 0 }, 5);
      };
      // Bounded by time, not passes: a pass costs whatever the commits in it cost, and the agent's own waits
      // (each poll is 2 s after its job) are what decide how long settling takes.
      const drain = async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          if (jobs.length > answered) { await answer([{ type: "text", text: "ok" }], "stop"); continue; }
          await D.alarm();
          if (jobs.length > answered) continue;
          if (alarmAt === null || alarmAt - Date.now() > 5_000) return;
          await sleep(Math.max(0, Math.min(alarmAt - Date.now(), 50)));
        }
        throw new Error("the agent did not settle");
      };
      const call = (id: string, name: string, args: Json = {}) => ({ type: "toolCall", id, name, arguments: args });

      await D.uiSay(T, A, `t_${A}`, "go", "steer");
      await answer([call("c1", "web__send", { url: "u1" }), call("c2", "box__long"), call("c3", "lease__take"), call("c4", "web__wipe")], "toolUse");
      await answer([{ type: "text", text: "started" }], "stop");
      check(D.runtime().runJsContinuations.size === 1, "the question is not held");

      // As commits end: the approval, an API input that rebinds the model, a console message, an alarm.
      const op = (await rt.store.listApprovals(T, "pending"))[0]?.operationId;
      check(op, "no approval is pending");
      const approved = during(() => D.uiDecide(T, A, "", op, "approved", "human"));
      const api = during(() => D.apiPostInput(T, A, JSON.stringify({ name: "n", instructions: "be brief" }), "s1", "hello from the API"));
      await D.uiSay(T, A, `t_${A}`, "and now?", "steer");
      for (const [what, r] of [["approval", await approved], ["API input", await api]] as const) check(r.ok, `${what} threw: ${r.error}`);
      check(seen.filter((s) => s === "web.send").length === 1, `the approved call ran: ${show(seen)}`);
      check(D.runtime().store && (await rt.store.getModelBinding(T, A))?.model === "m1", "the binding");
      const alarmed = during(() => D.alarm());
      await D.uiSay(T, A, `t_${A}`, "still there?", "steer");
      check((await alarmed).ok, "the alarm threw");
      await drain();
      check(requests.some((r) => r.includes("hello from the API")), "the API input never reached the model");

      // A function the API caller runs: its result submitted, then a turn cancelled — each as a commit ends.
      const weather = { name: "n", instructions: "be brief", tools: [{ name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } }] };
      await D.apiPostInput(T, A, JSON.stringify(weather), "s2", "weather?");
      await answer([call("w1", "get_weather")], "toolUse");
      let status = await D.apiSessionStatus(T, A, "s2");
      for (let i = 0; i < 100 && status.status !== "requires_action"; i++) { await D.alarm(); await sleep(10); status = await D.apiSessionStatus(T, A, "s2"); }
      check(status.status === "requires_action" && status.pending[0]?.call_id === "w1", `the caller's function is not waiting: ${show(status)}`);
      const submitted = during(() => D.apiToolResults(T, A, "s2", [{ turnId: status.pending[0]!.turn_id, callId: "w1", output: "sunny", isError: false }]));
      await D.uiSay(T, A, `t_${A}`, "meanwhile", "steer");
      const sub = await submitted;
      check(sub.ok && show(sub.value) === show({ unknown: [] }), `the results threw or were refused: ${show(sub)}`);
      await drain();
      check(requests.some((r) => r.includes("sunny")), "the caller's result never reached the model");
      await D.apiPostInput(T, A, JSON.stringify(weather), "s2", "write a long story");
      for (let i = 0; i < 100 && jobs.length <= answered; i++) { await D.alarm(); if (jobs.length <= answered) await sleep(10); }
      const cancelled = during(() => D.apiCancelSession(T, A, "s2"));
      await D.uiSay(T, A, `t_${A}`, "and the story?", "steer");
      const can = await cancelled;
      check(can.ok && typeof can.value?.cancelledTurn === "string", `the cancel threw or found nothing: ${show(can)}`);
      answered = jobs.length;
      await drain();

      // The question expires; the background job comes due; the lease reaches its warning, then its end.
      await sleep(450);
      raw.sql.exec("UPDATE background_jobs SET next_poll_at = 0");
      held.lastUsedAt = Date.now() - 90_000;
      const swept = during(() => D.alarm());
      await D.uiSay(T, A, `t_${A}`, "anything new?", "steer");
      check((await swept).ok, "the alarm threw");
      await drain();
      check(seen.includes("web.cancel"), `the expired question was not cancelled: ${show(seen)}`);
      check(raw.sql.exec("SELECT 1 FROM plugin_db WHERE store = 'asked'").toArray().length === 1, "the plugin's cancel did not write");
      check(seen.includes("box.poll") && requests.some((r) => r.includes("[background job")), `the job was not delivered: ${show(seen)}`);
      check(requests.some((r) => r.includes("let_go")), "the idle warning never reached the model");
      held.lastUsedAt = Date.now() - 200_000;
      await drain();
      check(seen.includes("lease.release"), `the lease was not released: ${show(seen)}`);

      const kinds = new Set(raw.sql.exec("SELECT kind FROM do_activity").toArray().map((r) => String((r as { kind: unknown }).kind)));
      for (const k of ["uiSay", "uiDecide", "apiPostInput", "apiToolResults", "apiCancelSession", "alarm", "deliver", "offload_dispatch", "offload_provider"]) check(kinds.has(k), `no do_activity row of kind ${k}: ${show([...kinds])}`);
      check(raw.sql.exec("SELECT COUNT(*) AS n FROM alarms").toArray()[0] as { n: number }, "no alarm rows");
      // The object was pd from its first wake, so nothing above — the constructor, the console, the API, the alarms,
      // the queue — made a pi085 table: the engine keeps its own records.
      const pi = raw.sql.exec("SELECT name FROM sqlite_master").toArray().map((r) => String(r.name)).filter((n) => n.startsWith("pi_"));
      check(pi.length === 0, `a pd object made pi085 objects: ${show(pi)}`);
      await (await rt.agent(T, A)).close?.();
    } finally { raw.dispose(); }
  },
};

/** The model queue's replay of one delivery, through AgentDO's own entry points down to `PdHost.deliver`. */
const replayedDelivery: DriveCase = {
  group: "the whole object", name: "a delivery replayed under the same taker, through AgentDO → runtime → PdHost, meters nothing more; another taker's answer to the answered job is metered unaccepted",
  async run() {
    const raw = sqliteHost();
    try {
      const ap = new ApStore(raw, prefixedNamespace("ap"));
      ap.ensure();
      ap.setEngineOnce("pd");
      const jobs: string[] = [];
      let alarmAt: number | null = null;
      const ctx = {
        storage: {
          sql: raw.sql, transactionSync: raw.transactionSync,
          getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; },
        },
        id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
      };
      const env = {
        MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
        ARTIFACTS: { put: async () => ({}), get: async () => null, head: async () => null, list: async () => ({ objects: [] }) },
        ARTIFACT_BUCKET: "b", CONTROL_DB: d1(), HARNESS_MODEL: "m1", DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k",
      };
      const D = new AgentDO(ctx as never, env as never);
      await D.uiAdoptAgent(T, A, { name: "n", description: "d", avatar: "x" });
      await D.runtime().bindOperatorModel(T, A);
      await D.uiSay(T, A, `t_${A}`, "go", "steer");
      for (let i = 0; i < 100 && jobs.length === 0; i++) { await D.alarm(); if (jobs.length === 0) await sleep(10); }
      const id = jobs[0];
      check(id, "the agent asked the model nothing");
      const job = await D.takeJob(T, A, id, "attempt-1") as { model?: { api?: string; provider?: string } } | null;
      check(job && !("unknownJob" in job), `job ${id}: ${show(job)}`);
      const answer = { role: "assistant", content: [{ type: "text", text: "ok" }], api: job.model?.api ?? "x", provider: job.model?.provider ?? "x", model: "m1", usage: USAGE, stopReason: "stop", timestamp: 0, jobId: id };
      const rows = () => raw.sql.exec("SELECT resource, key, quantity FROM usage_outbox ORDER BY seq").toArray().map((r) => `${r.resource} ${r.key} ${r.quantity}`);
      check(await D.deliverAnswer(T, A, id, answer, 5, "attempt-1") === true, "the first delivery was refused");
      const first = rows();
      check(show(first) === show(["model.tokens m1:input 1", "model.tokens m1:output 1"]), `the first delivery metered ${show(first)}`);
      check(await D.deliverAnswer(T, A, id, answer, 5, "attempt-1") === true, "the replay did not answer as the first delivery did");
      check(show(rows()) === show(first), `the replay metered again: ${show(rows())}`);
      check(await D.deliverAnswer(T, A, id, answer, 5, "attempt-2") === false, "another attempt's answer was taken");
      check(show(rows()) === show([...first, "model.tokens.unaccepted m1:input 1", "model.tokens.unaccepted m1:output 1"]), `another attempt: ${show(rows())}`);
      await (await D.runtime().agent(T, A)).close?.();
    } finally { raw.dispose(); }
  },
};

const results = await runDriveCases([
  ...pdWritesCases(async (use) => {
    const host = sqliteHost();
    try { await use(host); } finally { host.dispose(); }
  }),
  wholeObject,
  replayedDelivery,
]);

let g = "";
for (const r of results) {
  if (r.group !== g) { g = r.group; console.log(`  ${g}`); }
  console.log(r.ok ? `    ✓ ${r.name}` : `    ✗ ${r.name}\n        ${r.error}`);
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
