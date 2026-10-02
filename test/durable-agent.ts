/**
 * The `pd` engine (test/spec/durable-agent-spec.ts) over node:sqlite, and the engine choice in
 * `AgentRuntime.agent()` (cf/src/runtime.ts). `npm run durable-agent:do` runs the spec's cases on a
 * real Durable Object; the runtime cases are node's only, because the conformance worker does not
 * carry the runtime.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { UnknownJob } from "../cf/src/model-queue.ts";
import { pdDeliveryWake } from "../cf/src/alarm-next.ts";
import { fromResponse, toRequest } from "../src/model/pi-bridge.ts";
import { DurableAgent } from "../src/runtime/durable-agent.ts";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { ApStore } from "../src/store/ap-store.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { runDriveCases, type DriveCase } from "./spec/durable-drive-spec.ts";
import { durableAgentCases } from "./spec/durable-agent-spec.ts";
import { afterPdCommits } from "./spec/pd-commits.ts";

const activeTimers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** An AgentRuntime over node:sqlite, as test/provision-runtime.ts builds one, with the dispatches it makes. */
async function runtime(host: ReturnType<typeof sqliteHost>) {
  const sent: string[] = [];
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    sandbox: false, autoRelease: false,
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "operator-key", model: "m1" },
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
  } as never);
  await rt.ready();
  await rt.bindOperatorModel("t", "a");
  return { rt, sent };
}

/** Every schema object whose name starts with `prefix` (compared in JS: LIKE would read `_` as a wildcard). */
const objects = (host: ReturnType<typeof sqliteHost>, prefix: string) =>
  host.sql.exec("SELECT name FROM sqlite_master").toArray().map((r) => String(r.name)).filter((n) => n.startsWith(prefix));

const runtimeCases: DriveCase[] = [
  {
    group: "runtime", name: "no engine row: the agent is PiAgent, and opening it creates no ap_ or pd_ object",
    run: async () => {
      const host = sqliteHost();
      try {
        const { rt } = await runtime(host);
        const agent = await rt.agent("t", "a");
        check(agent instanceof PiAgent && !rt.servesPd, `opened ${agent.constructor.name}, servesPd ${rt.servesPd}`);
        check(objects(host, "ap_").length === 0 && objects(host, "pd_").length === 0,
          `created ${show([...objects(host, "ap_"), ...objects(host, "pd_")])}`);
        // The control for the probe: the pi085 tables are there, so the query sees what opening created.
        check(objects(host, "pi_model_jobs").length === 1, "control: pi_model_jobs not seen");
        let thrown: unknown;
        try { await rt.takeJob("t", "a", "mj_nope"); } catch (e) { thrown = e; }
        check(thrown instanceof UnknownJob, `pi085 unknown job: ${String(thrown)}`);
      } finally { host.dispose(); }
    },
  },
  {
    group: "runtime", name: "engine pd: the agent is DurableAgent, and a turn runs through postMessage, step, takeJob and deliverAnswer",
    run: async () => {
      const host = sqliteHost();
      try {
        const ap = new ApStore(host, prefixedNamespace("ap"));
        ap.ensure();
        ap.setEngineOnce("pd");
        const { rt, sent } = await runtime(host);
        const agent = await rt.agent("t", "a");
        check(agent instanceof DurableAgent, `opened ${agent.constructor.name}`);
        await rt.postMessage("t", "a", "Capital of France?");
        const parked = await rt.step("t", "a");
        check(parked.wakeInMs !== null && parked.wakeInMs > 0, `step: ${show(parked)}`);
        // What AgentDO arms at the end of that pass (index.ts `alarm`): the park's time.
        const parkAlarm = Date.now() + parked.wakeInMs;
        check(sent.length === 1, `dispatched ${show(sent)}`);
        const job = await rt.takeJob("t", "a", sent[0]!) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
        check(toRequest(job.context).messages.some((m) => m.role === "user" && m.content === "Capital of France?"), `job ${show(job)}`);
        const answer = fromResponse({ text: "Paris", finishReason: "stop", truncated: false, usage: { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 } },
          job.model, sent[0]!);
        check(await rt.deliverAnswer("t", "a", sent[0]!, answer) === true, "deliverAnswer refused");
        let thrown: unknown;
        try { await rt.deliverAnswer("t", "a", "mj_nope", answer); } catch (e) { thrown = e; }
        check(thrown instanceof UnknownJob, `pd unknown job: ${String(thrown)}`);
        // The delivery's wake (index.ts `deliverAnswer`): none while the park alarm is pending.
        check(rt.servesPd && pdDeliveryWake(parkAlarm, Date.now()) === null, "a delivery on pd asked for a wake while the park alarm was pending");
        const now = Date.now();
        check(pdDeliveryWake(null, now) === now, "with no alarm pending a delivery must wake now");
        // The control: the wake a delivery used to ask for, now, finds the poll still ahead and parks again.
        const early = await rt.step("t", "a");
        check(early.wakeInMs !== null && early.wakeInMs > 0, `a wake at delivery was productive after all: ${show(early)}`);
        await sleep(parkAlarm - Date.now());
        const done = await rt.step("t", "a");
        check(done.wakeInMs === null, `the one wake at the park alarm did not finish the turn: ${show(done)}`);
        // The other half of the first case's probe: on this object the same query does see ap_ and pd_ objects.
        check(objects(host, "ap_").length > 0 && objects(host, "pd_").length > 0, "control: ap_/pd_ objects not seen");
        const branch = await rt.branchEntries("t", "a", "main");
        const last = (branch.at(-1) as { message?: { role?: string; content?: Array<{ text?: string }> } } | undefined)?.message;
        check(last?.role === "assistant" && last.content?.[0]?.text === "Paris", `branch ${show(branch)}`);
        await agent.close();
      } finally { host.dispose(); }
    },
  },
  {
    group: "runtime", name: "engine pd: a message and a step started as a pi-durable commit ends both complete",
    run: async () => {
      const raw = sqliteHost();
      try {
        // The interleaving, pinned: as the first pi-durable commit after `armed` ends (`afterPdCommits`), a message
        // and a step are started, alongside the step that made the commit.
        let armed = false;
        let started: Array<Promise<unknown>> = [];
        let rt: AgentRuntime | undefined;
        const start = () => { armed = false; started = [rt!.postMessage("t", "a", "Q2", "steer"), rt!.step("t", "a")]; };
        const host = { ...raw, ...afterPdCommits(raw, () => { if (armed) start(); }) };
        const ap = new ApStore(raw, prefixedNamespace("ap"));
        ap.ensure();
        ap.setEngineOnce("pd");
        ({ rt } = await runtime(host));
        await rt.postMessage("t", "a", "Q1");
        armed = true;
        const first = await Promise.allSettled([rt.step("t", "a")]);
        check(started.length === 2, "control: no pi-durable commit ended after arming, so nothing was started");
        const results = [...first, ...await Promise.allSettled(started)];
        const failed = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason));
        check(failed.length === 0, `failed ${show(failed)}`);
        await (await rt.agent("t", "a")).close();
      } finally { raw.dispose(); }
    },
  },
];

/**
 * The runtime cases step through AgentRuntime, whose step deadline is the production 30 s; a case that cannot
 * finish fails here by name instead (the spec's cases carry their own deadline).
 */
const RUNTIME_CASE_DEADLINE_MS = 15_000;
const withDeadline = (c: DriveCase): DriveCase => ({
  ...c,
  run: async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`case "${c.name}" passed its ${RUNTIME_CASE_DEADLINE_MS} ms deadline`)), RUNTIME_CASE_DEADLINE_MS);
      timer.unref();
    });
    try { await Promise.race([c.run(), deadline]); } finally { clearTimeout(timer); }
  },
});

const results = await runDriveCases([
  ...durableAgentCases(async (use) => {
    const host = sqliteHost();
    try { await use(host); } finally { host.dispose(); }
  }, activeTimers),
  ...runtimeCases.map(withDeadline),
]);

console.log(`\n  durable agent: the pd engine — node:sqlite\n  ${"─".repeat(56)}`);
let group = "";
for (const r of results) {
  if (r.group !== group) { group = r.group; console.log(`  ${group}`); }
  console.log(r.ok
    ? `    \x1b[32m✓\x1b[0m ${r.name} \x1b[2m(${r.ms} ms)\x1b[0m`
    : `    \x1b[31m✗\x1b[0m ${r.name}\n        \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
