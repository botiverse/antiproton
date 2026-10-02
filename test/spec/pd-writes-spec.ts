/**
 * Every write the runtime makes on a `pd` object, kept out of pi-durable's transactions.
 *
 * pi-durable commits through `ctx.storage.transaction`, a savepoint over the object's one connection
 * that stays open across awaits (src/store/pi-durable-sqlite.ts): any other write issued while it is
 * open joins it, and is rolled back with it when the commit fails. Each case here runs an `AgentRuntime`
 * on a `pd` object whose every pi-durable transaction is held open across a timer, starts one of the
 * runtime's writes from INSIDE such a transaction (`World.during`), and asks two things: did the write
 * do what it is for, and did anything of ours join (`guardJoinedWrites`, which also throws at the write).
 *
 * Run over node:sqlite by test/pd-writes.ts, which adds the whole `AgentDO`, and on a real Durable
 * Object's storage by cf/src/conformance.ts (test/pd-writes-do.sh).
 */
import { AgentRuntime } from "../../cf/src/runtime.ts";
import type { Json } from "../../src/core/types.ts";
import { backgrounded, interrupt, type Plugin } from "../../src/plugins/types.ts";
import { guardJoinedWrites } from "../../src/runtime/durable-agent.ts";
import { ApStore } from "../../src/store/ap-store.ts";
import { PiDurableSqlite, type DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../../src/store/sql-namespace.ts";
import type { DriveCase, WithDriveHost } from "./durable-drive-spec.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const T = "t", A = "a";
const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/** What the test plugins did, in order. */
export type Seen = string[];

/**
 * Called from inside a plugin's work, before it writes: a case starts a pi-durable commit here, so a
 * write the plugin makes after it would land in that commit unless the whole of the work is kept apart.
 */
export type PluginHooks = { duringSend?: () => void; duringPoll?: () => void };

/**
 * The plugins a case's agent has: `web` (a read, a write held for approval, a tool that asks first),
 * `box` (work that goes to the background) and `lease` (a thing held until released).
 */
export function testPlugins(seen: Seen, held: { lastUsedAt: number | null }, hooks: PluginHooks = {}): Plugin[] {
  const obj = (props: Record<string, Json> = {}) => ({ type: "object", properties: props }) as never;
  const web: Plugin = {
    id: "web", version: "1.0.0",
    tools: [
      { name: "read_page", summary: "Read a page.", parameters: obj({ url: { type: "string" } }), sideEffects: "read", idempotency: "none" },
      { name: "send", summary: "Post.", parameters: obj({ url: { type: "string" } }), sideEffects: "write", idempotency: "none" },
      { name: "wipe", summary: "Wipe.", parameters: obj(), sideEffects: "write", idempotency: "none" },
    ] as never,
    async invoke(tool: string, args: Json, ctx: { db: { put(store: string, v: Json, k: string): Promise<void> } }) {
      seen.push(`web.${tool}`);
      if (tool === "read_page") return { title: `page ${(args as { url?: string }).url}` };
      // A post is recorded where the plugin keeps its state: a write the store's gate never sees.
      if (tool === "send") {
        hooks.duringSend?.();
        await sleep(1);
        await ctx.db.put("sent", { at: 1 }, String((args as { url?: string }).url));
        return { sent: (args as { url?: string }).url ?? null };
      }
      return interrupt({ question: "Wipe everything?", answer: { choices: ["confirm", "cancel"] }, state: { s: 1 } });
    },
    interrupts: {
      async resume(_t: string, _s: Json, a: Json) { seen.push(`web.resume:${a}`); return { wiped: a === "confirm" }; },
      // What a plugin gives back when nobody answers is written where it keeps its state.
      async cancel(_t: string, _s: Json, ctx: { db: { put(store: string, v: Json, k: string): Promise<void> } }) {
        seen.push("web.cancel");
        await ctx.db.put("asked", { cancelled: true }, "wipe");
      },
    },
    database: { version: 1, stores: { asked: {}, sent: {} } },
  } as unknown as Plugin;
  const box: Plugin = {
    id: "box", version: "1.0.0",
    tools: [{ name: "long", summary: "Runs for a while.", parameters: obj(), sideEffects: "read", idempotency: "native" }] as never,
    async invoke() { seen.push("box.long"); return backgrounded({ job: "j1" }, "still running"); },
    background: {
      async poll() {
        seen.push("box.poll");
        hooks.duringPoll?.();
        await sleep(1);
        return { done: true as const, result: { exitCode: 0 } };
      },
      async cancel() { seen.push("box.cancel"); },
    },
  } as Plugin;
  const lease: Plugin = {
    id: "lease", version: "1.0.0",
    tools: [
      { name: "take", summary: "Take the thing.", parameters: obj(), sideEffects: "write", idempotency: "none" },
      { name: "let_go", summary: "Let it go.", parameters: obj(), sideEffects: "write", idempotency: "none" },
    ] as never,
    async invoke(tool) { seen.push(`lease.${tool}`); held.lastUsedAt = tool === "take" ? Date.now() : null; return { ok: true }; },
    holds: {
      tools: { release: "let_go" },
      async activity() { return { live: held.lastUsedAt === null ? null : { id: "thing-1", startedAt: held.lastUsedAt, lastUsedAt: held.lastUsedAt } }; },
      async release() { seen.push("lease.release"); held.lastUsedAt = null; return true; },
    },
  } as Plugin;
  return [web, box, lease];
}

export interface WorldOptions {
  /** How long each pi-durable transaction is held open before its work. */
  slowCommitMs: number;
  autoRelease?: boolean;
  idle?: { warnMs: number; maxMs: number };
  runJsResumeMs?: number;
}

/** A `pd` agent `t/a` with the three plugins mounted, on `raw` behind the guard. */
export async function pdWorld(raw: DurableSqlHost, o: WorldOptions) {
  const seen: Seen = [];
  const held = { lastUsedAt: null as number | null };
  const hooks: PluginHooks = {};
  // What `during` armed: started inside the next pi-durable transaction, before its work.
  const armed: Array<() => unknown> = [];
  const slow: DurableSqlHost = {
    sql: raw.sql, transactionSync: (cb) => raw.transactionSync(cb),
    transaction: (cb) => raw.transaction(async () => {
      for (const start of armed.splice(0)) start();
      if (o.slowCommitMs > 0) await sleep(o.slowCommitMs);
      return cb();
    }),
  };
  const g = guardJoinedWrites(slow, { throwOnJoin: true });
  const storage = { sql: g.sql, transaction: g.transaction, transactionSync: g.transactionSync };
  // The engine choice, as a creation path writes it.
  const ap = new ApStore(raw.sql, new PiDurableSqlite(raw, prefixedNamespace("pd")), prefixedNamespace("ap"));
  await ap.ensure();
  await ap.setEngineOnce("pd");
  const sent: string[] = [];
  const rt = new AgentRuntime({
    ctx: { storage } as never, bucket: {} as never, bucketName: "b", sandbox: false,
    autoRelease: o.autoRelease ?? false, ...(o.idle ? { idle: o.idle } : {}),
    ...(o.runJsResumeMs ? { runJsResumeMs: o.runJsResumeMs } : {}),
    extraPlugins: testPlugins(seen, held, hooks),
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "k", model: "m1" },
    offloadModel: async (j: { commandId: string }) => { sent.push(j.commandId); },
  } as never);
  await rt.ready();
  await rt.store.createAgent(T, A);
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
  const w = {
    rt, seen, held, hooks, raw, storage, joined: g.joined, requests,
    /** Closes the harness, so no timer of it outlives the case. */
    async close() { await (await rt.agent(T, A)).close?.(); },
    /**
     * Start `fn` inside the next pi-durable transaction, and resolve with what it settled to once it
     * has. The transaction is the window a write of ours must not land in.
     */
    during<R>(fn: () => R | Promise<R>): Promise<{ ok: true; value: R } | { ok: false; error: string }> {
      return new Promise((resolve) => {
        armed.push(() => {
          Promise.resolve().then(fn).then((value) => resolve({ ok: true, value }), (e) => resolve({ ok: false, error: String(e?.message ?? e) }));
        });
      });
    },
    /** Step until the agent has asked the model something new, and answer it with `content`. */
    async answer(content: unknown[], stop: "toolUse" | "stop") {
      for (let i = 0; i < 100 && sent.length <= answered; i++) { await rt.step(T, A); if (sent.length <= answered) await sleep(10); }
      check(sent.length > answered, `the agent asked the model nothing new (${sent.length} jobs, ${answered} answered)`);
      const id = sent[answered++]!;
      const job = await rt.takeJob(T, A, id) as { model?: { api?: string; provider?: string } } | null;
      check(job, `job ${id} has no request`);
      requests.push(JSON.stringify(job));
      await rt.deliverAnswer(T, A, id, {
        role: "assistant", content, api: job.model?.api ?? "x", provider: job.model?.provider ?? "x", model: "m1",
        usage: USAGE, stopReason: stop, timestamp: 0,
      });
    },
    /** Step until nothing is open and nothing asks to be woken soon. */
    async settle(maxPasses = 100) {
      for (let i = 0; i < maxPasses; i++) {
        const out = await rt.step(T, A);
        if (out.open === 0 && (out.wakeInMs === null || out.wakeInMs > 5_000)) return out;
        await sleep(Math.min(out.wakeInMs ?? 10, 50));
      }
      throw new Error("the agent did not settle");
    },
    /** Answer whatever the agent asks with `text`, until it settles. */
    async drain(reply = "ok") {
      for (let i = 0; i < 100; i++) {
        if (sent.length > answered) { await w.answer([{ type: "text", text: reply }], "stop"); continue; }
        const out = await rt.step(T, A);
        if (sent.length > answered) continue;
        if (out.open === 0 && (out.wakeInMs === null || out.wakeInMs > 5_000)) return out;
        await sleep(Math.min(out.wakeInMs ?? 10, 50));
      }
      throw new Error("the agent did not settle");
    },
  };
  return w;
}

const call = (id: string, name: string, args: Json = {}) => ({ type: "toolCall", id, name, arguments: args });
const text = (t: string) => ({ type: "text", text: t });

export function pdWritesCases(withRawHost: WithDriveHost, opts: { slowCommitMs: number }): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (name: string, run: () => Promise<void>) => cases.push({ group: "pd writes", name, run });
  const world = (o: Partial<WorldOptions>, use: (w: Awaited<ReturnType<typeof pdWorld>>) => Promise<void>) =>
    withRawHost(async (raw) => {
      const w = await pdWorld(raw, { slowCommitMs: opts.slowCommitMs, ...o });
      try {
        await use(w);
        check(w.joined.length === 0, `${w.joined.length} writes joined an open pi-durable transaction: ${show(w.joined.slice(0, 5))}`);
      } finally { await w.close(); }
    });

  add("control: a write straight at the storage, started inside a pd commit, is seen joining it", () =>
    withRawHost(async (raw) => {
      const w = await pdWorld(raw, { slowCommitMs: opts.slowCommitMs });
      try {
        const r = w.during(() => w.storage.sql.exec("INSERT INTO agents(tenant_id, agent_id, config, created_at) VALUES ('x', 'y', '{}', 0)"));
        await w.rt.postMessage(T, A, "hello");
        const got = await r;
        check(!got.ok && /joined write/.test(got.error), `the ungated write: ${show(got)}`);
        check(w.joined.length === 1, `the guard saw ${show(w.joined)}`);
      } finally { await w.close(); }
    }));

  add("approving a held call while a pd commit is open runs the call once and joins nothing", () =>
    world({}, async (w) => {
      await w.rt.postMessage(T, A, "post it");
      await w.answer([call("c1", "web__send", { url: "u1" })], "toolUse");
      // The held call's turn goes on; the approval lands inside its next commit.
      await w.answer([text("waiting for approval")], "stop");
      const op = (await w.rt.store.listApprovals(T, "pending"))[0]?.operationId;
      check(op, "no approval was pending");
      const decided = w.during(() => w.rt.gateway().applyApproval(T, op, "approved", "human"));
      // And while the approved call runs, another message: its commit must wait for the call to finish.
      let meanwhile: Promise<unknown> | null = null;
      w.hooks.duringSend = () => { meanwhile = w.rt.postMessage(T, A, "meanwhile"); };
      await w.rt.postMessage(T, A, "anything yet?");
      const r = await decided;
      check(w.joined.length === 0, `joined: ${show(w.joined)}`);
      check(r.ok, `the approval threw: ${r.ok ? "" : r.error}`);
      check(show(r.value).includes('"executed":true'), `the approval: ${show(r.value)}`);
      check(meanwhile, "the approved call did not run");
      await meanwhile;
      check(w.seen.filter((s) => s === "web.send").length === 1, `the plugin ran ${show(w.seen)}`);
      check(w.raw.sql.exec("SELECT 1 FROM plugin_db WHERE store = 'sent'").toArray().length === 1, "the approved call's own write is not there");
      await w.drain();
    }));

  add("a tool question that expires is cancelled at the plugin outside every pd commit", () =>
    world({ runJsResumeMs: 400 }, async (w) => {
      await w.rt.postMessage(T, A, "wipe it");
      await w.answer([call("c1", "web__wipe")], "toolUse");
      await w.answer([text("asked")], "stop");
      check(w.rt.runJsContinuations.size === 1, `held questions: ${w.rt.runJsContinuations.size}`);
      await sleep(450);
      // The sweep a pass makes, inside a commit: its cancel must wait the commit out.
      const swept = w.during(() => w.rt.runJsContinuations.wakeInMs());
      await w.rt.postMessage(T, A, "never mind");
      check((await swept).ok, "the sweep threw");
      for (let i = 0; i < 50 && !w.seen.includes("web.cancel"); i++) await sleep(10);
      check(w.joined.length === 0, `joined: ${show(w.joined)}`);
      check(w.seen.includes("web.cancel"), `the plugin was not told: ${show(w.seen)}`);
      for (let i = 0; i < 50 && !w.raw.sql.exec("SELECT 1 FROM plugin_db WHERE store = 'asked'").toArray().length; i++) await sleep(10);
      check(w.raw.sql.exec("SELECT 1 FROM plugin_db WHERE store = 'asked'").toArray().length === 1, "the plugin's write is not there");
      await w.answer([text("ok")], "stop");
      await w.settle();
    }));

  add("binding the operator's model while a pd commit is open writes the binding and joins nothing", () =>
    world({}, async (w) => {
      const bound = w.during(() => w.rt.bindOperatorModel(T, A, "m2"));
      await w.rt.postMessage(T, A, "hello");
      const r = await bound;
      check(r.ok, `the binding threw: ${r.ok ? "" : r.error}`);
      check((await w.rt.store.getModelBinding(T, A))?.model === "m2", "the binding was not kept");
      await w.answer([text("hi")], "stop");
      await w.settle();
    }));

  add("a background job a pd agent starts is polled, finished and delivered as a message", () =>
    world({}, async (w) => {
      await w.rt.postMessage(T, A, "run the tests");
      await w.answer([call("c1", "box__long")], "toolUse");
      await w.answer([text("started")], "stop");
      // Due now rather than in two seconds.
      w.raw.sql.exec("UPDATE background_jobs SET next_poll_at = 0");
      await w.answer([text("the tests passed")], "stop");
      check(w.seen.includes("box.poll"), `the job was never polled: ${show(w.seen)}`);
      const last = w.requests.at(-1)!;
      check(/background job/.test(last) && last.includes("exitCode"), `the completion did not reach the model: ${last.slice(-400)}`);
      const row = w.raw.sql.exec("SELECT state FROM background_jobs").toArray()[0] as { state?: string } | undefined;
      check(row?.state === "done", `the job row: ${show(row)}`);
      await w.settle();
    }));

  add("a pass that starts inside a pd commit polls the job once and delivers it once, joining nothing", () =>
    world({}, async (w) => {
      await w.rt.postMessage(T, A, "run the tests");
      await w.answer([call("c1", "box__long")], "toolUse");
      await w.answer([text("started")], "stop");
      w.raw.sql.exec("UPDATE background_jobs SET next_poll_at = 0");
      // While the job is polled, a message: its commit must wait for the pass's writes.
      let meanwhile: Promise<unknown> | null = null;
      w.hooks.duringPoll = () => { meanwhile ??= w.rt.postMessage(T, A, "meanwhile"); };
      const passed = w.during(() => w.rt.step(T, A));
      await w.rt.postMessage(T, A, "status?");
      const r = await passed;
      check(r.ok, `the pass threw: ${r.ok ? "" : r.error}`);
      check(meanwhile, "the job was not polled");
      await meanwhile;
      await w.drain();
      check(w.seen.filter((s) => s === "box.poll").length === 1, `polled: ${show(w.seen)}`);
      const told = w.requests.at(-1)!.split("[background job").length - 1;
      check(told === 1, `the completion reached the model ${told} times`);
    }));

  add("auto-release on pd: a settled turn hands back what it held", () =>
    world({ autoRelease: true }, async (w) => {
      await w.rt.postMessage(T, A, "take it");
      await w.answer([call("c1", "lease__take")], "toolUse");
      await w.answer([text("done")], "stop");
      await w.settle();
      check(w.seen.includes("lease.release"), `nothing was released: ${show(w.seen)}`);
    }));

  add("the idle pass on pd warns the agent with a turn, then releases at the release time", () =>
    world({ autoRelease: true, idle: { warnMs: 60_000, maxMs: 120_000 } }, async (w) => {
      await w.rt.postMessage(T, A, "take it");
      await w.answer([call("c1", "lease__take")], "toolUse");
      await w.answer([text("done")], "stop");
      // Inside the warning window: the next idle pass tells the agent, as a turn.
      w.held.lastUsedAt = Date.now() - 90_000;
      await w.answer([text("noted")], "stop");
      check(/let_go/.test(w.requests.at(-1)!), `the warning did not reach the model: ${w.requests.at(-1)!.slice(-400)}`);
      const warned = w.raw.sql.exec("SELECT release_at FROM held_warnings").toArray();
      check(warned.length === 1, `held_warnings: ${show(warned)}`);
      // Past the release time: taken, and its warning row with it.
      w.held.lastUsedAt = Date.now() - 200_000;
      await w.settle();
      check(w.seen.includes("lease.release"), `nothing was released: ${show(w.seen)}`);
      check(w.raw.sql.exec("SELECT * FROM held_warnings").toArray().length === 0, "the warning row outlived the release");
    }));

  return cases;
}
