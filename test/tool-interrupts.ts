/**
 * Tools as generators: a plugin tool that asks the AGENT a question before it
 * acts (src/plugins/types.ts `Interrupt`), the model's `resume` that answers it,
 * and the runtime around them — through the real gateway and store, both
 * executors, the registry's clock, and the Durable Object runtime's wiring.
 *
 * The plugin here is a test-only SQL tool, not shipped: `DELETE … WHERE …`
 * runs at once, and a `DELETE` with no `WHERE` asks "confirm / cancel" first,
 * running only on "confirm". `DROP TABLE` asks twice (the second time for the
 * table's name as text), which pins a resume that asks again.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { Interrupt, interrupt, type Plugin } from "../src/plugins/types.ts";
import type { Json } from "../src/core/types.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { DynamicWorkerExecutor } from "../src/runtime/dynamic-worker-executor.ts";
import {
  AFTER_PROGRAM_NOTE, EXPIRED_NOTE, RESUME_DESCRIPTION, TOOL_IN_PROGRAM_NOTE, TOOL_QUESTION_NOTE,
  bridgeTools, qualifyMountedTools, resumeTool, runJsTool, type ToolHost,
} from "../src/runtime/pi-tools.ts";
import { RunJsContinuations } from "../src/runtime/run-js-resume.ts";
import { systemPrompt } from "../src/runtime/pi-prompt.ts";
import { raftPlugin } from "../src/plugins/raft.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).slice(0, 800) }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const body = (out: any) => JSON.parse(out.content[0].text);

// ---- the SQL plugin --------------------------------------------------------

/** What the plugin did, for the assertions: every statement run, every resume and cancel it saw. */
interface Db { rows: Map<string, number[]>; ran: string[]; resumes: Array<{ state: Json; answer: Json }>; cancels: Json[] }
/** A marker in every interrupt's state: it must never reach the model or a program. */
const SECRET = "plugin-state-never-shown";

function sqlPlugin(db: Db): Plugin {
  const exec = (sql: string): Json => {
    db.ran.push(sql);
    const del = /^\s*delete\s+from\s+(\w+)(?:\s+where\s+id\s*=\s*(\d+))?\s*$/i.exec(sql);
    if (del) {
      const rows = db.rows.get(del[1]!) ?? [];
      const keep = del[2] === undefined ? [] : rows.filter((id) => id !== Number(del[2]));
      db.rows.set(del[1]!, keep);
      return { deleted: rows.length - keep.length };
    }
    const drop = /^\s*drop\s+table\s+(\w+)\s*$/i.exec(sql);
    if (drop) { db.rows.delete(drop[1]!); return { dropped: drop[1]! }; }
    const sel = /^\s*select\s+count\(\*\)\s+from\s+(\w+)\s*$/i.exec(sql);
    if (sel) return { count: (db.rows.get(sel[1]!) ?? []).length };
    throw new Error(`unsupported statement: ${sql}`);
  };
  return {
    id: "sql", version: "1.0.0",
    tools: [{ name: "query", summary: "Run one SQL statement.", parameters: { type: "object", properties: { sql: { type: "string" } } }, sideEffects: "write", idempotency: "none" }],
    async invoke(_tool, args) {
      const sql = String((args as any)?.sql ?? "");
      // The tool decides from its own arguments: a DELETE that names no rows removes every row.
      const unbounded = /^\s*delete\s+from\s+(\w+)\s*$/i.exec(sql);
      if (unbounded) {
        const n = (db.rows.get(unbounded[1]!) ?? []).length;
        return interrupt({
          question: `DELETE with no WHERE removes every row of ${unbounded[1]} (${n} rows). Run it?`,
          context: { table: unbounded[1]!, rows: n },
          answer: { choices: ["confirm", "cancel"] },
          state: { sql, step: "delete", secret: SECRET },
        });
      }
      // A reminder, not a decision (`Interrupt.ifApproved`): an approved replay answers it "confirm" for the agent.
      // `... TWICE` asks again when answered, as a Raft send does when the conversation moved again in between.
      const truncate = /^\s*truncate\s+(\w+)(\s+twice)?\s*$/i.exec(sql);
      if (truncate) {
        return interrupt({
          question: `Truncate ${truncate[1]}?`, answer: { choices: ["confirm", "cancel"] }, ifApproved: "confirm",
          state: { sql: `DELETE FROM ${truncate[1]}`, step: truncate[2] ? "truncate-again" : "truncate", secret: SECRET },
        });
      }
      const drop = /^\s*drop\s+table\s+(\w+)\s*$/i.exec(sql);
      if (drop) {
        return interrupt({
          question: `Drop table ${drop[1]}?`, answer: { kind: "yes_no" },
          state: { sql, table: drop[1]!, step: "drop-1", secret: SECRET },
        });
      }
      return exec(sql);
    },
    interrupts: {
      async resume(_tool, state, answer) {
        db.resumes.push({ state, answer });
        const s = state as { sql: string; step: string; table?: string };
        if (s.step === "delete" || s.step === "truncate") return answer === "confirm" ? exec(s.sql) : { cancelled: true };
        if (s.step === "truncate-again") {
          return interrupt({
            question: `More rows arrived; truncate anyway?`, answer: { choices: ["confirm", "cancel"] }, ifApproved: "confirm",
            state: { ...s, step: "truncate-again" },
          });
        }
        if (s.step === "drop-1") {
          if (answer !== true) return { kept: s.table! };
          return interrupt({
            question: `Type the table's name to drop it`, answer: { kind: "text" },
            state: { ...s, step: "drop-2" },
          });
        }
        return answer === s.table ? exec(s.sql) : { kept: s.table!, note: "the name did not match" };
      },
      async cancel(_tool, state) { db.cancels.push(state); },
    },
  };
}

/** Returns a question but cannot take an answer: the plugin's bug, refused by the gateway. */
const mute: Plugin = {
  id: "mute", version: "1.0.0",
  tools: [{ name: "ask", summary: "", parameters: { type: "object" }, sideEffects: "write", idempotency: "none" }],
  async invoke() { return interrupt({ question: "?", answer: { choices: ["a"] } }); },
};
/** Asks with a spec nobody could answer. */
const garbled: Plugin = {
  id: "garbled", version: "1.0.0",
  tools: [{ name: "ask", summary: "", parameters: { type: "object" }, sideEffects: "write", idempotency: "none" }],
  async invoke() { return new Interrupt({ question: "?", answer: { choices: [] } as any }); },
  interrupts: { async resume() { return null; } },
};

const CTX = { tenantId: "t", agentId: "a", taskId: "k" };

async function fixture(o: { ttlMs?: number; now?: () => number; held?: number[] } = {}) {
  const db: Db = { rows: new Map([["users", [1, 2, 3]], ["logs", [7, 8]]]), ran: [], resumes: [], cancels: [] };
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  const plugins = [sqlPlugin(db), mute, garbled];
  for (const [alias, plugin] of [["db", "sql"], ["mute", "mute"], ["garbled", "garbled"]] as const) {
    await store.addMount({
      tenantId: "t", agentId: "a", alias, plugin, installationId: "i", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
    });
  }
  const gw = new ToolGateway(store, plugins, new Set(plugins.map((p) => p.id)));
  // The runtime's host, minus its result finishing (cf/src/runtime.ts #host; covered at the end).
  const host: ToolHost & { calls: any[] } = {
    calls: [],
    async invoke(call) { host.calls.push(call); return gw.invoke(CTX, call.tool, call.args, { ...(call.opts as any ?? {}), ...(call.callId ? { callId: call.callId } : {}) }) as any; },
    async resumeInterrupt(i, answer, callId) { return gw.resumeInterrupt(CTX, i, answer, { callId }) as any; },
    async cancelInterrupt(i) { return gw.cancelInterrupt(CTX, i); },
  };
  const reg = new RunJsContinuations({
    ...(o.ttlMs ? { ttlMs: o.ttlMs } : {}), ...(o.now ? { now: o.now } : {}),
    ...(o.held ? { onHold: (at: number) => { o.held!.push(at); } } : {}),
  });
  const TOOLS = qualifyMountedTools(plugins.flatMap((p, i) => p.tools.map((t) => ({
    name: t.name, address: `${["db", "mute", "garbled"][i]}.${t.name}`, description: t.summary, parameters: t.parameters,
    sideEffects: t.sideEffects, idempotency: t.idempotency,
  }))));
  const keeping = { continuations: reg, scope: "s" };
  const tools = bridgeTools(TOOLS, host, keeping) as any[];
  const query = tools.find((t) => t.name === "db__query");
  const resume: any = resumeTool(reg, { scope: "s" });
  return { db, store, gw, host, reg, TOOLS, tools, query, resume, keeping, plugins };
}

// ---- the direct call -------------------------------------------------------

await check("DELETE with WHERE runs at once: no question, no token", async () => {
  const f = await fixture();
  const out = body(await f.query.execute("c1", { sql: "DELETE FROM users WHERE id = 2" }));
  must(out.deleted === 1 && JSON.stringify(f.db.rows.get("users")) === "[1,3]", `ran: ${JSON.stringify(out)}`);
  must(f.reg.size === 0 && f.db.resumes.length === 0, "nothing held");
});

await check("DELETE without WHERE yields: the question, what the tool found, the answer spec, a token — and nothing ran, and the plugin's state is not shown", async () => {
  const held: number[] = [];
  const f = await fixture({ held });
  const out = await f.query.execute("c1", { sql: "DELETE FROM users" });
  const y = body(out);
  must(y.state === "yielded" && y.tool === "db__query" && /every row of users \(3 rows\)/.test(y.question), `yielded: ${JSON.stringify(y)}`);
  must(JSON.stringify(y.answer) === '{"choices":["confirm","cancel"]}' && JSON.stringify(y.context) === '{"table":"users","rows":3}', `spec/context: ${JSON.stringify(y)}`);
  must(typeof y.token === "string" && !Number.isNaN(Date.parse(y.expiresAt)) && y.note === TOOL_QUESTION_NOTE, `token/note: ${JSON.stringify(y)}`);
  must(!out.content[0].text.includes(SECRET) && !JSON.stringify(out.details).includes(SECRET), `the plugin's state reached the model: ${out.content[0].text}`);
  must(JSON.stringify(f.db.rows.get("users")) === "[1,2,3]" && f.db.ran.length === 0, "nothing ran");
  must(f.reg.size === 1, "held in the registry");
  // Kept awake as a suspended program is.
  must(held.length === 1, `the object was not asked to stay awake: ${held.length}`);
});

await check("resume \"confirm\" runs the DELETE as its own operation, the result comes back as resume's, and the token is spent", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  const out = await f.resume.execute("r1", { token: y.token, answer: "confirm" });
  must(JSON.stringify(body(out)) === '{"deleted":3}' && JSON.stringify(f.db.rows.get("users")) === "[]", `confirm: ${out.content[0].text}`);
  must(f.db.resumes.length === 1 && (f.db.resumes[0]!.state as any).secret === SECRET, "the plugin got its own state back");
  const op = await f.store.getOperation("t", out.details.operationId);
  must(op?.status === "succeeded" && op.tool === "sql.query", `the resume's operation: ${JSON.stringify(op)}`);
  must(f.reg.size === 0, "spent");
  const again = body(await f.resume.execute("r2", { token: y.token, answer: "confirm" }));
  must(again.expired === true && again.note === EXPIRED_NOTE && f.db.resumes.length === 1, `a used token: ${JSON.stringify(again)}`);
});

await check("resume \"cancel\" (the tool's own choice) reaches the plugin, which deletes nothing", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  const out = body(await f.resume.execute("r1", { token: y.token, answer: "cancel" }));
  must(out.cancelled === true && JSON.stringify(f.db.rows.get("users")) === "[1,2,3]" && f.db.ran.length === 0, `cancel choice: ${JSON.stringify(out)}`);
});

await check("resume with cancel: true tells the plugin nobody will answer, and nothing runs", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  const out = body(await f.resume.execute("r1", { token: y.token, cancel: true }));
  must(out.cancelled === true && out.tool === "db__query" && /did nothing/.test(out.note), `cancel: ${JSON.stringify(out)}`);
  must(f.db.cancels.length === 1 && f.db.resumes.length === 0 && f.db.ran.length === 0, `plugin saw: ${JSON.stringify(f.db)}`);
  must(f.reg.size === 0, "gone");
});

await check("an answer that does not fit is refused with invalidAnswer and the same token, and nothing reaches the plugin; a fitting one then works", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  for (const wrong of ["yes", true, undefined]) {
    const r = body(await f.resume.execute("r1", { token: y.token, ...(wrong === undefined ? {} : { answer: wrong }) }));
    must(r.state === "yielded" && r.token === y.token && /exactly one of "confirm", "cancel"/.test(r.invalidAnswer), `refused: ${JSON.stringify(r)}`);
    must(r.tool === "db__query" && JSON.stringify(r.context) === '{"table":"users","rows":3}' && !JSON.stringify(r).includes(SECRET), `refusal shape: ${JSON.stringify(r)}`);
  }
  must(f.db.resumes.length === 0 && f.reg.size === 1, "the plugin saw an unchecked answer, or the token was spent");
  const ok = body(await f.resume.execute("r2", { token: y.token, answer: "confirm" }));
  must(ok.deleted === 3, `then: ${JSON.stringify(ok)}`);
});

await check("a resume that asks again yields again with a new token and its own spec (DROP: yes, then the table's name)", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DROP TABLE logs" }));
  must(JSON.stringify(y.answer) === '{"kind":"yes_no"}', `first: ${JSON.stringify(y)}`);
  const y2 = body(await f.resume.execute("r1", { token: y.token, answer: true }));
  must(y2.state === "yielded" && y2.token !== y.token && JSON.stringify(y2.answer) === '{"kind":"text"}' && y2.tool === "db__query", `second: ${JSON.stringify(y2)}`);
  must(f.db.rows.has("logs") && f.reg.size === 1, "nothing dropped yet");
  const bad = body(await f.resume.execute("r2", { token: y2.token, answer: 3 }));
  must(bad.invalidAnswer && bad.token === y2.token, `text spec: ${JSON.stringify(bad)}`);
  const done = body(await f.resume.execute("r3", { token: y2.token, answer: "logs" }));
  must(done.dropped === "logs" && !f.db.rows.has("logs"), `dropped: ${JSON.stringify(done)}`);
});

await check("expiry: past the registry's time the plugin is told nobody will answer, nothing runs, and resume says the token is gone", async () => {
  let now = 1_000_000;
  const f = await fixture({ ttlMs: 5_000, now: () => now });
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  now += 5_000;
  must(f.reg.sweep() === 1, "expired and swept");
  await new Promise((r) => setTimeout(r, 10));
  must(f.db.cancels.length === 1 && f.db.ran.length === 0, `cancel on expiry: ${JSON.stringify(f.db)}`);
  const late = body(await f.resume.execute("r1", { token: y.token, answer: "confirm" }));
  must(late.expired === true && late.note === EXPIRED_NOTE && f.db.ran.length === 0, `late: ${JSON.stringify(late)}`);
  must(/call the tool again/.test(EXPIRED_NOTE), "the expired note must say what to do for a tool");
});

await check("a token unknown to this registry (the object restarted) or given to another session is answered as gone, never run", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  const restarted: any = resumeTool(new RunJsContinuations(), { scope: "s" });
  const lost = body(await restarted.execute("r1", { token: y.token, answer: "confirm" }));
  must(lost.expired === true && lost.note === EXPIRED_NOTE, `after a restart: ${JSON.stringify(lost)}`);
  const other: any = resumeTool(f.reg, { scope: "other" });
  must(body(await other.execute("r2", { token: y.token, answer: "confirm" })).expired === true, "another session answered it");
  must(f.db.ran.length === 0 && f.reg.size === 1, "nothing ran, and the owner's token is still there");
});

await check("with nowhere to keep a question, it is dropped at once: the plugin is told, nothing runs, and no token is offered", async () => {
  const f = await fixture();
  const [bare] = bridgeTools(f.TOOLS.filter((t) => t.name === "db__query"), f.host) as any[];
  const out = await bare.execute("c1", { sql: "DELETE FROM users" });
  const y = body(out);
  must(y.state === "interrupted" && !("token" in y) && /cannot be answered here/.test(y.note) && /every row/.test(y.question), `no keeping: ${JSON.stringify(y)}`);
  must(f.db.cancels.length === 1 && f.db.ran.length === 0 && !out.content[0].text.includes(SECRET), "told, nothing ran, nothing leaked");
});

await check("a plugin that asks but cannot take an answer, or asks with an unusable spec, fails the call: no question nobody can answer", async () => {
  const f = await fixture();
  for (const name of ["mute__ask", "garbled__ask"]) {
    const tool = f.tools.find((t) => t.name === name);
    let why = "";
    try { await tool.execute("c", {}); } catch (e) { why = String((e as Error).message); }
    must(new RegExp(`^${name}: `).test(why) && /cannot take an answer|unusable/.test(why), `${name}: ${why}`);
  }
  must(f.reg.size === 0, "nothing held");
});

await check("a held call (confirm: true) that a person approves and that then asks has nobody to ask: dropped, nothing runs, recorded as not run, the question rides back", async () => {
  const f = await fixture();
  const pending: any = await f.gw.invoke(CTX, "db.query", { sql: "DELETE FROM users" }, { confirm: true });
  must(pending.status === "pending", `held: ${JSON.stringify(pending)}`);
  const decided: any = await f.gw.applyApproval("t", pending.operationId, "approved", "person");
  // Recorded as not run everywhere a person or the agent reads it, never `executed` / `succeeded`: checked first, so
  // a change that records it as run fails here, on what outlives the turn, not on the text the agent is handed.
  const a: any = await f.store.getApproval("t", pending.operationId);
  // Its outcome, which Raft's card shows to whoever decided, is the reason alone: the question (here the table's row
  // count; for Raft the held messages) goes to the agent only.
  must(a?.state === "failed" && a.outcome?.summary === "cancelled: asked_before_acting; nothing was done", `hold: ${JSON.stringify({ state: a?.state, outcome: a?.outcome })}`);
  must(!/every row|3 rows/.test(JSON.stringify(a.outcome)), `the question reached the outcome: ${JSON.stringify(a.outcome)}`);
  const told: any = (await f.store.untoldApprovals("t")).find((u: any) => u.operationId === pending.operationId);
  must(/but not run: cancelled/.test(told?.notice ?? "") && /asked_before_acting/.test(told?.notice ?? "") && /every row/.test(told?.notice ?? ""), `notice: ${told?.notice}`);
  const op: any = await f.store.getOperation("t", pending.operationId);
  must(op?.status === "cancelled", `operation: ${JSON.stringify(op?.status)}`);
  must(decided.ok && !decided.executed && decided.result.status === "cancelled" && decided.result.error?.code === "asked_before_acting"
    && /nothing was done/.test(decided.result.error.message) && /every row/.test(decided.result.error.message), `approved: ${JSON.stringify(decided)}`);
  must(!JSON.stringify(decided).includes(SECRET), "the plugin's state rode the completion");
  must(f.db.cancels.length === 1 && f.db.ran.length === 0, `nothing ran: ${JSON.stringify(f.db)}`);
});

await check("an approved call whose question declares ifApproved is answered once for the agent: resumed exactly once, ran once, executed", async () => {
  const f = await fixture();
  const pending: any = await f.gw.invoke(CTX, "db.query", { sql: "TRUNCATE users" }, { confirm: true });
  must(pending.status === "pending", `held: ${JSON.stringify(pending)}`);
  const decided: any = await f.gw.applyApproval("t", pending.operationId, "approved", "person");
  // Stored state first: what outlives the turn says it ran, once.
  const a: any = await f.store.getApproval("t", pending.operationId);
  must(a?.state === "executed", `hold: ${JSON.stringify({ state: a?.state, outcome: a?.outcome })}`);
  const op: any = await f.store.getOperation("t", pending.operationId);
  must(op?.status === "succeeded", `operation: ${JSON.stringify(op?.status)}`);
  must(f.db.resumes.length === 1 && f.db.resumes[0]!.answer === "confirm" && f.db.ran.length === 1 && f.db.cancels.length === 0,
    `resumed once, ran once: ${JSON.stringify({ resumes: f.db.resumes.length, ran: f.db.ran, cancels: f.db.cancels.length })}`);
  must(JSON.stringify(f.db.rows.get("users")) === "[]", `rows: ${JSON.stringify(f.db.rows.get("users"))}`);
  must(decided.ok && decided.executed && decided.result.status === "succeeded" && decided.result.operationId === pending.operationId
    && decided.result.result?.deleted === 3, `approved: ${JSON.stringify(decided)}`);
  must(!JSON.stringify(decided).includes(SECRET), "the plugin's state rode the completion");
});

await check("an approved call answered once for the agent that asks AGAIN is not answered twice: not run, the second question cancelled", async () => {
  const f = await fixture();
  const pending: any = await f.gw.invoke(CTX, "db.query", { sql: "TRUNCATE users TWICE" }, { confirm: true });
  must(pending.status === "pending", `held: ${JSON.stringify(pending)}`);
  const decided: any = await f.gw.applyApproval("t", pending.operationId, "approved", "person");
  const a: any = await f.store.getApproval("t", pending.operationId);
  must(a?.state === "failed" && /^cancelled: asked_before_acting/.test(a.outcome?.summary ?? ""), `hold: ${JSON.stringify({ state: a?.state, outcome: a?.outcome })}`);
  const op: any = await f.store.getOperation("t", pending.operationId);
  must(op?.status === "cancelled", `operation: ${JSON.stringify(op?.status)}`);
  must(f.db.resumes.length === 1, `resumed ${f.db.resumes.length} times, not once`);
  must(f.db.ran.length === 0 && JSON.stringify(f.db.rows.get("users")) === "[1,2,3]", `nothing ran: ${JSON.stringify(f.db.ran)}`);
  must(f.db.cancels.length === 1 && (f.db.cancels[0] as any).step === "truncate-again", `the second question cancelled: ${JSON.stringify(f.db.cancels)}`);
  must(decided.ok && !decided.executed && decided.result.status === "cancelled" && decided.result.error?.code === "asked_before_acting"
    && /answered for you once/.test(decided.result.error.message) && /asked again/.test(decided.result.error.message)
    && /More rows arrived/.test(decided.result.error.message), `approved: ${JSON.stringify(decided)}`);
  must(!JSON.stringify(decided).includes(SECRET), "the plugin's state rode the completion");
});

await check("an approval whose run has ended is never run again: runApproved answers null and nothing resumes or runs", async () => {
  const f = await fixture();
  const pending: any = await f.gw.invoke(CTX, "db.query", { sql: "TRUNCATE users" }, { confirm: true });
  await f.gw.applyApproval("t", pending.operationId, "approved", "person");
  must((await f.store.getApproval("t", pending.operationId) as any)?.state === "executed", "control: the first run executed");
  must(f.db.resumes.length === 1 && f.db.ran.length === 1, `control: ${JSON.stringify({ resumes: f.db.resumes.length, ran: f.db.ran })}`);
  const again = await f.gw.runApproved("t", pending.operationId);
  must(again === null, `ran again: ${JSON.stringify(again)}`);
  must(f.db.resumes.length === 1 && f.db.ran.length === 1, `ran again: ${JSON.stringify({ resumes: f.db.resumes.length, ran: f.db.ran })}`);
});

await check("ifApproved is host-side: a model's own call that asks it shows the question, never the answer the gateway would give", async () => {
  const f = await fixture();
  const out = await f.query.execute("c1", { sql: "TRUNCATE users" });
  const y = body(out);
  must(y.state === "yielded" && /Truncate users/.test(y.question), `yielded: ${JSON.stringify(y)}`);
  must(!out.content[0].text.includes("ifApproved") && !JSON.stringify(out.details).includes("ifApproved"), `ifApproved reached the model: ${out.content[0].text}`);
  must(f.db.ran.length === 0 && f.db.resumes.length === 0, "nothing answered for the model");
});

await check("resume after the mount was switched off is refused like a call, and nothing runs", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  await f.store.setPluginChoice("t", "a", "sql", "disable");
  let why = "";
  try { await f.resume.execute("r1", { token: y.token, answer: "confirm" }); } catch (e) { why = String((e as Error).message); }
  must(/switched off/.test(why) && f.db.ran.length === 0 && f.db.resumes.length === 0, `switched off: ${why}`);
});

await check("resume after the mount was re-pinned to another plugin version is refused like a call, and nothing runs", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  // The state was written by the version the mount pinned; another version must not be handed it.
  (f.plugins[0] as any).version = "2.0.0";
  let why = "";
  try { await f.resume.execute("r1", { token: y.token, answer: "confirm" }); } catch (e) { why = String((e as Error).message); }
  must(/mount pins 1\.0\.0, registry has 2\.0\.0/.test(why) && f.db.ran.length === 0 && f.db.resumes.length === 0, `re-pinned: ${why}`);
});

await check("resume after the mount is gone (renamed away) is refused, and nothing runs", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  must((await f.store.renameMount("t", "a", "db", "elsewhere", null)).ok, "renamed");
  let why = "";
  try { await f.resume.execute("r1", { token: y.token, answer: "confirm" }); } catch (e) { why = String((e as Error).message); }
  must(/`db` mount no longer exists/.test(why) && f.db.ran.length === 0 && f.db.resumes.length === 0, `gone: ${why}`);
});

// Removal marks the mount before its cleanup runs and deletes it only after (`markRemoving`), so while the mark is
// held the mount is still found: only the mark keeps an answer from acting on it and reading its credential.
await check("resume on a mount being removed is refused: no operation, nothing resolved, the plugin not reached", async () => {
  const resumed: unknown[] = [];
  const asker: Plugin = {
    id: "asker", version: "1.0.0",
    tools: [{ name: "ask", summary: "", parameters: { type: "object" }, sideEffects: "write", idempotency: "none" }],
    async invoke() { return interrupt({ question: "go?", answer: { kind: "yes_no" } }); },
    interrupts: { async resume(_t, _s, _a, c) { resumed.push(c.credential); return { ok: true }; } },
  };
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({ tenantId: "t", agentId: "a", alias: "acct", plugin: "asker", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: "ref:acct", policy: null });
  const resolved: string[] = [];
  const gw = new ToolGateway(store, [asker], new Set(["asker"]), {
    async resolve(ref: string) { resolved.push(ref); return `secret-of-${ref}`; },
  } as any);
  let recorded = 0;
  const record = store.recordOperation.bind(store);
  store.recordOperation = async (op) => { recorded++; return record(op); };
  const operations = async () => recorded;
  const asked: any = await gw.invoke(CTX, "acct.ask", {});
  must(asked.status === "interrupted", `asked: ${JSON.stringify(asked)}`);
  const opsBefore = await operations();
  resolved.length = 0;
  const unmark = gw.markRemoving("t", "a", "acct");
  const r: any = await gw.resumeInterrupt(CTX, asked.interrupt, true);
  must(r.status === "rejected" && r.error?.code === "not_mounted" && /being removed/.test(r.error?.message), `resumed while being removed: ${JSON.stringify(r)}`);
  must(!resolved.includes("ref:acct"), `its credential was resolved while it is being removed: ${JSON.stringify(resolved)}`);
  must(resumed.length === 0, `the plugin's resume ran while the mount is being removed: ${JSON.stringify(resumed)}`);
  must((await operations()) === opsBefore, `an operation was recorded while the mount is being removed: ${opsBefore} -> ${await operations()}`);
  unmark();
  const again: any = await gw.resumeInterrupt(CTX, asked.interrupt, true);
  must(again.status === "succeeded" && resumed.length === 1, `control: after the mark is lifted the answer goes on: ${JSON.stringify(again)} ${JSON.stringify(resumed)}`);
});

await check("on a mount that holds something, the answer waits its turn behind a call already running there", async () => {
  const order: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const box: Plugin = {
    id: "box", version: "1.0.0",
    tools: ["slow", "ask"].map((name) => ({ name, summary: "", parameters: { type: "object" }, sideEffects: "write" as const, idempotency: "none" as const })),
    holds: { tools: { release: "slow" }, async activity() { return { live: null }; }, async release() {} } as any,
    async invoke(tool) {
      if (tool === "ask") return interrupt({ question: "go?", answer: { kind: "yes_no" } });
      order.push("slow:start"); await gate; order.push("slow:end"); return null;
    },
    interrupts: { async resume() { order.push("resume"); return { ok: true }; } },
  };
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({ tenantId: "t", agentId: "a", alias: "box", plugin: "box", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  const gw = new ToolGateway(store, [box], new Set(["box"]));
  const asked: any = await gw.invoke(CTX, "box.ask", {});
  must(asked.status === "interrupted", `asked: ${JSON.stringify(asked)}`);
  const slow = gw.invoke(CTX, "box.slow", {});
  await new Promise((r) => setTimeout(r, 10));
  const answered = gw.resumeInterrupt(CTX, asked.interrupt, true);
  await new Promise((r) => setTimeout(r, 20));
  must(order.join() === "slow:start", `the answer ran beside a call on the same mount: ${order}`);
  open();
  await Promise.all([slow, answered]);
  must(order.join() === "slow:start,slow:end,resume", `order: ${order}`);
});

// ---- inside run_js ---------------------------------------------------------

const standIn = standInLoader();
const EXECUTORS: Array<[string, any]> = [
  ["quickjs", new QuickJsExecutor()],
  ["worker", new DynamicWorkerExecutor({ loader: standIn.loader, makeToolBinding: standIn.makeToolBinding })],
];

for (const [label, exec] of EXECUTORS) {
  await check(`${label}: a tool that asks inside run_js ends the program at that call and yields the question; resume answers the tool, not the program`, async () => {
    const f = await fixture();
    const run: any = runJsTool(exec, f.host, { tools: f.TOOLS, continuations: f.reg, scope: "s" });
    const out = await run.execute("p1", { source:
      "const a = await tool`db__query ${{ sql: 'DELETE FROM users WHERE id = 1' }}`; output(a.result); " +
      "let r; try { r = await tool`db__query ${{ sql: 'DELETE FROM logs' }}`; } catch (e) { output('caught'); } " +
      "output({ after: r }); await tool`db__query ${{ sql: 'DELETE FROM users WHERE id = 2' }}`.catch(() => {});" });
    const y = body(out);
    must(y.state === "yielded" && y.tool === "db__query" && /every row of logs/.test(y.question) && y.note === TOOL_IN_PROGRAM_NOTE, `yielded: ${JSON.stringify(y)}`);
    must(JSON.stringify(y.soFar) === '{"outputs":[{"deleted":1}],"calls":2}', `so far: ${JSON.stringify(y.soFar)}`);
    must(JSON.stringify(y.held) === "[]" && !("programPause" in y), `the question is not a held call: ${JSON.stringify(y)}`);
    must(!out.content[0].text.includes(SECRET), "the plugin's state reached the model");
    // Nothing after the asking call ran.
    must(JSON.stringify(f.db.rows.get("users")) === "[2,3]" && JSON.stringify(f.db.rows.get("logs")) === "[7,8]", `rows: ${JSON.stringify([...f.db.rows])}`);
    must(f.host.calls.length === 2, `calls after the question reached the host: ${f.host.calls.length}`);
    const done = body(await f.resume.execute("r1", { token: y.token, answer: "confirm" }));
    must(done.tool === "db__query" && done.result?.deleted === 2 && done.note === AFTER_PROGRAM_NOTE, `resumed: ${JSON.stringify(done)}`);
    must(JSON.stringify(f.db.rows.get("logs")) === "[]" && JSON.stringify(f.db.rows.get("users")) === "[2,3]", "the tool ran; the program did not continue");
  });

  await check(`${label}: the program never sees the interrupt's state, even when it awaits the call itself`, async () => {
    const f = await fixture();
    const run: any = runJsTool(exec, f.host, { tools: f.TOOLS, continuations: f.reg, scope: "s" });
    const out = await run.execute("p1", { source:
      "const p = tool`db__query ${{ sql: 'DELETE FROM logs' }}`; " +
      "p.then((r) => output(JSON.stringify(r)), (e) => output(String(e && e.message)));" +
      "await p.catch(() => {});" });
    must(!out.content[0].text.includes(SECRET), `state reached the program or the model: ${out.content[0].text}`);
  });

  await check(`${label}: a resumed program that reaches an asking tool yields the tool's question`, async () => {
    const f = await fixture();
    const run: any = runJsTool(exec, f.host, { tools: f.TOOLS, continuations: f.reg, scope: "s" });
    const p = body(await run.execute("p1", { source:
      "const go = await pause('go?', null, { kind: 'yes_no' }); " +
      "if (go) await tool`db__query ${{ sql: 'DELETE FROM users' }}`;" }));
    must(p.state === "yielded" && p.question === "go?" && !p.tool, `the program's pause: ${JSON.stringify(p)}`);
    const t = body(await f.resume.execute("r1", { token: p.token, answer: true }));
    must(t.state === "yielded" && t.tool === "db__query" && /every row of users/.test(t.question) && t.token !== p.token, `the tool's question: ${JSON.stringify(t)}`);
    must(JSON.stringify(f.db.rows.get("users")) === "[1,2,3]", "nothing deleted");
    const c = body(await f.resume.execute("r2", { token: t.token, cancel: true }));
    must(c.cancelled === true && f.db.cancels.length === 1 && f.db.ran.length === 0, `cancelled: ${JSON.stringify(c)}`);
  });

  await check(`${label}: two questions from one program: the first is asked, the second is dropped and named`, async () => {
    const f = await fixture();
    const run: any = runJsTool(exec, f.host, { tools: f.TOOLS, continuations: f.reg, scope: "s" });
    const y = body(await run.execute("p1", { source:
      "await Promise.allSettled([tool`db__query ${{ sql: 'DELETE FROM users' }}`, tool`db__query ${{ sql: 'DELETE FROM logs' }}`]);" }));
    // The invariant on both: one question held, every other one that reached the plugin dropped and named,
    // nothing run. The Dynamic Worker's calls arrive late, so the second may be refused before it reaches
    // the plugin at all (the run already stopped); QuickJS sends both, so there the drop is pinned.
    const also = Array.isArray(y.alsoAsked) ? y.alsoAsked : [];
    must(y.state === "yielded" && also.every((a: any) => a.dropped === true) && f.db.cancels.length === also.length, `two: ${JSON.stringify(y)}`);
    must(f.reg.size === 1 && f.db.ran.length === 0, `one held: ${JSON.stringify(f.db)}`);
    if (label === "quickjs") must(also.length === 1 && f.db.cancels.length === 1, `both reached the plugin under QuickJS: ${JSON.stringify(y)}`);
  });

  await check(`${label}: run_js with nowhere to keep a question drops it and says so; nothing runs`, async () => {
    const f = await fixture();
    const run: any = runJsTool(exec, f.host, { tools: f.TOOLS });
    const y = body(await run.execute("p1", { source: "await tool`db__query ${{ sql: 'DELETE FROM users' }}`;" }));
    must(y.state === "interrupted" && !("token" in y) && f.db.cancels.length === 1 && f.db.ran.length === 0, `no keeping: ${JSON.stringify(y)}`);
  });
}

/** A sandbox that makes one call and ends as told, so when the call comes back is the test's to choose. */
function scripted(o: { status: "completed" | "failed"; awaitCall: boolean }) {
  let late!: Promise<unknown>;
  return {
    late: () => late,
    sandbox: {
      async execute(_src: string, host: any) {
        late = host.invoke({ tool: "db__query", args: { sql: "DELETE FROM users" } });
        if (o.awaitCall) await late;
        return { status: o.status, outputs: [], hostCalls: 1, ...(o.status === "failed" ? { error: { code: "eval_error" } } : {}) };
      },
    },
  };
}

await check("a question that comes back to a run that ended another way (a failure) is dropped, never held or left unanswered", async () => {
  const f = await fixture();
  const s = scripted({ status: "failed", awaitCall: true });
  const run: any = runJsTool(s.sandbox as any, f.host, { tools: f.TOOLS, continuations: f.reg, scope: "s" });
  let why = "";
  try { await run.execute("p1", { source: "" }); } catch (e) { why = String((e as Error).message); }
  must(/run_js failed/.test(why) && f.reg.size === 0 && f.db.cancels.length === 1 && f.db.ran.length === 0, `failed run: ${why} ${JSON.stringify(f.db)}`);
});

await check("a question that comes back after its program was reported (the call outlived it) is dropped at once", async () => {
  const f = await fixture();
  const s = scripted({ status: "completed", awaitCall: false });
  const run: any = runJsTool(s.sandbox as any, f.host, { tools: f.TOOLS, continuations: f.reg, scope: "s" });
  await run.execute("p1", { source: "" });
  await s.late();
  await new Promise((r) => setTimeout(r, 10));
  must(f.reg.size === 0 && f.db.cancels.length === 1 && f.db.ran.length === 0, `late question: ${JSON.stringify({ size: f.reg.size, db: f.db })}`);
});

// ---- the Raft held send, end to end ----------------------------------------

function json(status: number, b: unknown) {
  return new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
}
const originalFetch = globalThis.fetch;
function many(...answers: Response[]) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    const a = answers.shift();
    if (!a) throw new Error("unexpected fetch");
    return a;
  }) as any;
  return calls;
}
const HELD = () => json(200, { ok: true, state: "held", newMessageCount: 1, seenUpToSeq: 20, omittedMessageCount: 0, freshnessContextMode: "inline",
  heldMessages: [{ seq: 20, id: "abcdef12-0000", content: "wait, one more thing", sender_type: "human", sender_name: "tygg", channel_name: "general", channel_type: "channel", timestamp: "2026-09-28T10:00:00Z" }] });

async function raftFixture() {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "raft", plugin: "raft", installationId: "i", connectionId: null,
    toolVersion: raftPlugin.version, publicConfig: { serverUrl: "https://raft.example" }, secretRef: "secret:raft", policy: null,
  });
  const gw = new ToolGateway(store, [raftPlugin], new Set([raftPlugin.id]), { async resolve() { return "sk_agent_test_1234567890"; } });
  const host: ToolHost = {
    async invoke(call) { return gw.invoke(CTX, call.tool, call.args, call.callId ? { callId: call.callId } : {}) as any; },
    async resumeInterrupt(i, answer, callId) { return gw.resumeInterrupt(CTX, i, answer, { callId }) as any; },
    async cancelInterrupt(i) { return gw.cancelInterrupt(CTX, i); },
  };
  const reg = new RunJsContinuations();
  const tools = bridgeTools(qualifyMountedTools(raftPlugin.tools.map((t) => ({
    name: t.name, address: `raft.${t.name}`, description: t.summary, parameters: t.parameters, sideEffects: t.sideEffects, idempotency: t.idempotency,
  }))), host, { continuations: reg, scope: "s" }) as any[];
  // Every trace row the store is asked to keep, as written (src/trace/outbox.ts), read here rather than from its table.
  const traced: any[] = [];
  const record = store.recordTrace.bind(store);
  store.recordTrace = async (rows) => { traced.push(...rows); return record(rows); };
  return { send: tools.find((t) => t.name === "raft__messages_send"), resume: resumeTool(reg, { scope: "s" }) as any, reg, traced, store, gw };
}

await check("raft: a held send yields send/drop with the SDK's held text; resume \"send\" sends it once, attesting what was shown", async () => {
  const f = await raftFixture();
  const calls = many(HELD(), json(200, { ok: true, state: "sent", messageId: "m-2", messageSeq: 21 }));
  const out = await f.send.execute("c1", { target: "#general", content: "done", idempotencyKey: "k1" });
  const y = body(out);
  must(y.state === "yielded" && y.question.startsWith("Held — 1 unread message in #general.") && JSON.stringify(y.answer) === '{"choices":["send","drop"]}', `held: ${JSON.stringify(y)}`);
  must(y.question.includes("@tygg 10:00  wait, one more thing") && y.context?.reason === "unread_messages" && !out.content[0].text.includes('"content":"done"'), `the held text, and the state kept back: ${out.content[0].text}`);
  must(calls.length === 1, "one attempt so far");
  const sent = body(await f.resume.execute("r1", { token: y.token, answer: "send" }));
  const second = JSON.parse(String(calls[1]!.init.body));
  must(sent.state === "sent" && second.seenUpToSeq === 20 && second.idempotencyKey === "k1" && second.content === "done", `sent: ${JSON.stringify({ sent, second })}`);
});

await check("raft: through the gateway, a hold and its answer are trace rows joined to the call's operation, under the mount's name", async () => {
  const f = await raftFixture();
  many(HELD(), json(200, { ok: true, state: "sent", messageId: "m-2", messageSeq: 21 }));
  const y = body(await f.send.execute("c1", { target: "#general", content: "done", idempotencyKey: "k1" }));
  await f.resume.execute("r1", { token: y.token, answer: "send" });
  const held = f.traced.find((r) => r.kind === "raft.held");
  const answer = f.traced.find((r) => r.kind === "raft.held_answer");
  // A resume runs under the operation it continues (`PluginContext.operationId`), so both rows join that one operation.
  const op = held ? await f.store.getOperation("t", held.spanId) : null;
  must(held && held.tenantId === "t" && held.agentId === "a" && Object.keys(held.attrs)[0] === "mount" && held.attrs.mount === "raft" &&
    held.attrs.reason === "unread_messages" && op?.tool === "raft.messages_send" && op?.mountAlias === "raft", `the held row: ${JSON.stringify({ traced: f.traced, op })}`);
  must(answer && answer.status === "send" && answer.attrs.outcome === "sent" && answer.spanId === held.spanId && typeof answer.ms === "number",
    `the answer row: ${JSON.stringify(f.traced)}`);
});

await check("a plugin writes only its own trace kinds: a kernel kind, or the retired raft.state_save_failed, through PluginContext.trace is not written", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({ tenantId: "t", agentId: "a", alias: "p", plugin: "tracer", installationId: "i", connectionId: null, toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  const tracer: Plugin = {
    id: "tracer", version: "1.0.0",
    tools: [{ name: "go", summary: "Write two rows.", parameters: { type: "object", properties: {} }, sideEffects: "read", idempotency: "native" }],
    async invoke(_t, _a, ctx) {
      ctx.trace?.({ kind: "tool.call" as any, status: "succeeded", verdict: "ok", attrs: { forged: true } });
      ctx.trace?.({ kind: "raft.state_save_failed" as any, status: "save", verdict: "failed", attrs: { phase: "save" } });
      ctx.trace?.({ kind: "raft.state_failed", status: "load", verdict: "failed", attrs: { mount: "not-the-mount", phase: "load" } });
      return { ok: true };
    },
  };
  const traced: any[] = [];
  const record = store.recordTrace.bind(store);
  store.recordTrace = async (rows) => { traced.push(...rows); return record(rows); };
  const gw = new ToolGateway(store, [tracer], new Set([tracer.id]), { async resolve() { return null; } });
  const out = await gw.invoke(CTX, "p.go", {}, {}) as any;
  must(out.status === "succeeded", `the call: ${JSON.stringify(out)}`);
  const own = traced.filter((r) => r.kind !== "tool.call" || r.attrs?.forged);
  must(own.length === 1 && own[0].kind === "raft.state_failed" && own[0].attrs.mount === "p" && own[0].attrs.phase === "load" && own[0].spanId === out.operationId,
    `the plugin's rows: ${JSON.stringify(traced)}`);
});

/**
 * A Raft server with one conversation, #general, as far as a send needs it: messages with seqs, a send that is held
 * for `unread_messages` unless it attests (`seenUpToSeq`) the latest seq, answered with the latest seq as its boundary
 * at the time it is held, and an idempotencyKey that commits a message once. Every send attempt is kept as sent.
 */
function raftServer(o: { latest: number; notShown?: number; ownerTalks?: boolean }) {
  const committed: Array<{ seq: number; content: string; idempotencyKey: string; sender: string }> = [];
  const messages: Array<{ seq: number; content: string; sender: string }> = [];
  for (let seq = 1; seq <= o.latest; seq++) messages.push({ seq, content: `earlier ${seq}`, sender: "tygg" });
  const sends: any[] = [];
  /** What each send attempt was answered: "held:<reason>" or "sent". */
  const answers: string[] = [];
  const other: string[] = [];
  const latest = () => messages.at(-1)?.seq ?? 0;
  globalThis.fetch = (async (url: any, init?: any) => {
    const path = new URL(String(url)).pathname;
    if (!path.endsWith("/send")) { other.push(path); return json(404, { error: "not found", code: "NOT_FOUND" }); }
    const b = JSON.parse(String(init?.body ?? "{}"));
    sends.push(b);
    // A busy conversation: the owner posts again just before every send lands.
    if (o.ownerTalks) messages.push({ seq: latest() + 1, content: `OWNER-WORDS-${latest() + 1}`, sender: "owner" });
    const done = committed.find((c) => c.idempotencyKey === b.idempotencyKey);
    if (done) { answers.push("sent"); return json(200, { ok: true, state: "sent", messageId: `m-${done.seq}`, messageSeq: done.seq }); }
    const seen = typeof b.seenUpToSeq === "number" ? b.seenUpToSeq : 0;
    if (seen < latest()) {
      const unread = messages.filter((m) => m.seq > seen).slice(-1);
      answers.push("held:unread_messages");
      return json(200, {
        ok: true, state: "held", newMessageCount: unread.length + (o.notShown ?? 0), seenUpToSeq: latest(), omittedMessageCount: 0, freshnessContextMode: "inline",
        heldMessages: unread.map((m) => ({ seq: m.seq, id: `abcdef${m.seq}-0000`, content: m.content, sender_type: "human", sender_name: m.sender,
          channel_name: "general", channel_type: "channel", timestamp: "2026-09-28T10:00:00Z" })),
      });
    }
    const seq = latest() + 1;
    messages.push({ seq, content: String(b.content), sender: "agent" });
    committed.push({ seq, content: String(b.content), idempotencyKey: String(b.idempotencyKey), sender: "agent" });
    answers.push("sent");
    return json(200, { ok: true, state: "sent", messageId: `m-${seq}`, messageSeq: seq });
  }) as any;
  return {
    sends, answers, committed, other, latest,
    /** A person posts in #general, outside any agent: the conversation moves on. */
    post(content: string) { messages.push({ seq: latest() + 1, content, sender: "owner" }); },
  };
}

await check("raft, end to end: a confirm:true send, the owner posts after the card and before approving, approve: the replay is held at the NEW latest seq, answered once with that boundary under the same key, and lands once", async () => {
  const f = await raftFixture();
  const server = raftServer({ latest: 20 });
  // (1) The agent's send, held for approval: the card exists, nothing reached Raft.
  const pending: any = await f.gw.invoke(CTX, "raft.messages_send", { target: "#general", content: "shipping it", idempotencyKey: "k-e2e" }, { confirm: true });
  must(pending.status === "pending" && (await f.store.getApproval("t", pending.operationId) as any)?.state === "pending" && server.sends.length === 0,
    `held for approval: ${JSON.stringify({ pending, sends: server.sends })}`);
  // (2) After the card, before the decision, the owner posts: latest moves from 20 to 21.
  server.post("hold on, use the new branch");
  must(server.latest() === 21, "control: the owner's message is the latest");
  // (3) Approved: the replay is held for unread messages at 21, and answered once with 21 under the same key.
  const decided: any = await f.gw.applyApproval("t", pending.operationId, "approved", "person");
  const a: any = await f.store.getApproval("t", pending.operationId);
  must(a?.state === "executed", `hold: ${JSON.stringify({ state: a?.state, outcome: a?.outcome, sends: server.sends })}`);
  const op: any = await f.store.getOperation("t", pending.operationId);
  must(op?.status === "succeeded", `operation: ${JSON.stringify(op?.status)}`);
  must(server.committed.length === 1 && server.committed[0]!.content === "shipping it" && server.committed[0]!.idempotencyKey === "k-e2e",
    `committed once: ${JSON.stringify(server.committed)}`);
  // Precondition: the replay's first attempt really was held for unread messages, else this proves nothing.
  must(JSON.stringify(server.answers) === JSON.stringify(["held:unread_messages", "sent"]), `held, then sent: ${JSON.stringify(server.answers)}`);
  must(server.sends.length === 2 && server.sends.every((b) => b.idempotencyKey === "k-e2e"), `two attempts, one key: ${JSON.stringify(server.sends)}`);
  must(server.sends[0].seenUpToSeq === undefined && server.sends[1].seenUpToSeq === 21, `the resume attests the boundary of the replay's hold (21, the owner's message): ${JSON.stringify(server.sends)}`);
  must(decided.ok && decided.executed && decided.result.status === "succeeded", `approved: ${JSON.stringify(decided)}`);
});

await check("raft, end to end: an approved send held with more unread than the hold shows still goes out once, at Raft's boundary", async () => {
  const f = await raftFixture();
  // Raft holds counting 3 more new messages than it shows or reports omitted: the question is incomplete
  // (`contextComplete: false`), so the SDK attests nothing for a model.
  const server = raftServer({ latest: 20, notShown: 3 });
  const pending: any = await f.gw.invoke(CTX, "raft.messages_send", { target: "#general", content: "shipping it", idempotencyKey: "k-omit" }, { confirm: true });
  must(pending.status === "pending", `held: ${JSON.stringify(pending)}`);
  server.post("one more thing");
  const decided: any = await f.gw.applyApproval("t", pending.operationId, "approved", "person");
  const a: any = await f.store.getApproval("t", pending.operationId);
  must(a?.state === "executed", `hold: ${JSON.stringify({ state: a?.state, outcome: a?.outcome, sends: server.sends })}`);
  must(JSON.stringify(server.answers) === JSON.stringify(["held:unread_messages", "sent"]), `held, then sent: ${JSON.stringify(server.answers)}`);
  must(server.committed.length === 1 && server.sends.length === 2 && server.sends[1].seenUpToSeq === 21, `once, at 21: ${JSON.stringify(server.sends)}`);
  must(decided.ok && decided.executed, `approved: ${JSON.stringify(decided)}`);
});

await check("raft, end to end: an approved send that is held again after its one answer is recorded not run, and the held messages reach neither the outcome nor the card, only the agent", async () => {
  const f = await raftFixture();
  const server = raftServer({ latest: 20, ownerTalks: true });
  const pending: any = await f.gw.invoke(CTX, "raft.messages_send", { target: "#general", content: "shipping it", idempotencyKey: "k-busy" }, { confirm: true });
  must(pending.status === "pending", `held: ${JSON.stringify(pending)}`);
  // Every log line the run writes (logEvent and plain console output), kept to check that none carries the held messages.
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) console[k] = (...a: unknown[]) => { lines.push(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")); };
  let decided: any;
  try { decided = await f.gw.applyApproval("t", pending.operationId, "approved", "person"); } finally { Object.assign(console, saved); }
  must(!lines.some((l) => l.includes("OWNER-WORDS")), `a log line carries the held messages: ${lines.find((l) => l.includes("OWNER-WORDS"))?.slice(0, 300)}`);
  const a: any = await f.store.getApproval("t", pending.operationId);
  must(a?.state === "failed" && a.outcome?.summary === "cancelled: asked_before_acting (unread_messages); nothing was done",
    `hold: ${JSON.stringify({ state: a?.state, outcome: a?.outcome })}`);
  must(!JSON.stringify(a.outcome).includes("OWNER-WORDS"), `the held messages reached the outcome: ${JSON.stringify(a.outcome)}`);
  must(JSON.stringify(server.answers) === JSON.stringify(["held:unread_messages", "held:unread_messages"]) && server.committed.length === 0,
    `held twice, answered once, nothing sent: ${JSON.stringify({ answers: server.answers, committed: server.committed })}`);
  const told: any = (await f.store.untoldApprovals("t")).find((u: any) => u.operationId === pending.operationId);
  must(/OWNER-WORDS/.test(told?.notice ?? "") && /answered for you once/.test(told?.notice ?? ""), `control: the agent's notice has the question: ${String(told?.notice).slice(0, 300)}`);
  must(decided.ok && !decided.executed, `approved: ${JSON.stringify(decided).slice(0, 300)}`);
});

await check("raft: resume \"drop\" sends nothing, and an answer outside send/drop is refused with the same token", async () => {
  const f = await raftFixture();
  const calls = many(HELD());
  const y = body(await f.send.execute("c1", { target: "#general", content: "done", idempotencyKey: "k1" }));
  const bad = body(await f.resume.execute("r0", { token: y.token, answer: "yes" }));
  must(bad.invalidAnswer && bad.token === y.token, `refused: ${JSON.stringify(bad)}`);
  const dropped = body(await f.resume.execute("r1", { token: y.token, answer: "drop" }));
  must(dropped.state === "dropped" && calls.length === 1, `dropped: ${JSON.stringify(dropped)} after ${calls.length} requests`);
});
globalThis.fetch = originalFetch;

// ---- what the model is told -----------------------------------------------

await check("the prompt and resume's description say any tool may yield and resume answers it", async () => {
  const p = systemPrompt({ sandbox: true });
  must(/Any tool, called directly or from run_js, may also answer "yielded"/.test(p) && /resume answers the tool/.test(p), "the sandbox prompt");
  must(/a tool that asked you a question before acting/.test(RESUME_DESCRIPTION) && /drops a tool's question/.test(RESUME_DESCRIPTION), "resume's description");
  const raftSend = raftPlugin.tools.find((t) => t.name === "messages_send")!;
  must(/comes back as a question/.test(raftSend.summary) && /answer "send" to go ahead as written, or "drop"/.test(raftSend.summary), `raft's description: ${raftSend.summary}`);
});

// ---- the Durable Object runtime's wiring ----------------------------------

await check("runtime: resume is offered without run_js when a mounted plugin can ask, and not otherwise; its host answers through the gateway", async () => {
  const { AgentRuntime } = await import("../cf/src/runtime.ts");
  const { sqliteHost } = await import("../src/store/sqlite-host.ts");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/pi-agent-core/harness/context");
  const db: Db = { rows: new Map([["users", [1, 2]]]), ran: [], resumes: [], cancels: [] };
  const host = sqliteHost();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", loader: {} as any, makeToolBinding: () => ({}),
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "deepseek-flash" }),
    extraPlugins: [sqlPlugin(db)], sandbox: false, autoRelease: false,
  } as any);
  await rt.ready();
  for (const agentId of ["a", "b"]) {
    await rt.store.createAgent("t", agentId);
    await rt.bindOperatorModel("t", agentId);
  }
  await rt.store.setPluginChoice("t", "a", "sql", "enable");
  await rt.store.addMount({ tenantId: "t", agentId: "a", alias: "db", plugin: "sql", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  const tools = await (await rt.agent("t", "a")).tools() as any[];
  const names = tools.map((t) => t.name);
  must(names.includes("resume") && !names.includes("run_js") && names.includes("db__query"), `offered: ${names}`);
  const y = body(await tools.find((t) => t.name === "db__query").execute("c1", { sql: "DELETE FROM users" }));
  must(y.state === "yielded" && typeof y.token === "string" && rt.runJsContinuations.size === 1, `yielded: ${JSON.stringify(y)}`);
  const done = body(await tools.find((t) => t.name === "resume").execute("r1", { token: y.token, answer: "confirm" }));
  must(done.deleted === 2 && JSON.stringify(db.rows.get("users")) === "[]", `resumed through the runtime's host: ${JSON.stringify(done)}`);
  const other = (await (await rt.agent("t", "b")).tools()).map((t) => t.name);
  must(!other.includes("resume"), `resume offered with nothing that can ask: ${other}`);
  host.dispose();
});

await check("runtime: once the task has ended, a call and the answer to a question already asked are both refused, and the plugin runs neither", async () => {
  // The runtime's `ended` (cf/src/runtime.ts): a benchmark task the runner has finished. The question was asked
  // before the end, and the answer comes after it — that answer is a call too, and must not act.
  const { AgentRuntime } = await import("../cf/src/runtime.ts");
  const { sqliteHost } = await import("../src/store/sqlite-host.ts");
  const db: Db = { rows: new Map([["users", [1, 2]]]), ran: [], resumes: [], cancels: [] };
  const host = sqliteHost();
  let ended = false;
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", loader: {} as any, makeToolBinding: () => ({}),
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", HARNESS_MODEL: "deepseek-flash" }),
    extraPlugins: [sqlPlugin(db)], sandbox: false, autoRelease: false,
    ended: (o: { agentId: string }) => ended && o.agentId === "a",
  } as any);
  await rt.ready();
  await rt.store.createAgent("t", "a");
  await rt.bindOperatorModel("t", "a");
  await rt.store.setPluginChoice("t", "a", "sql", "enable");
  await rt.store.addMount({ tenantId: "t", agentId: "a", alias: "db", plugin: "sql", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
  const tools = await (await rt.agent("t", "a")).tools() as any[];
  const y = body(await tools.find((t) => t.name === "db__query").execute("c1", { sql: "DELETE FROM users" }));
  must(y.state === "yielded" && typeof y.token === "string", `the question was not asked, so this case tests nothing: ${JSON.stringify(y)}`);
  ended = true;
  const answered = await tools.find((t) => t.name === "resume").execute("r1", { token: y.token, answer: "confirm" }).then(
    (out: any) => JSON.stringify(out), (e: any) => String(e?.message ?? e));
  must(/task_ended|has ended/.test(answered), `the answer was not refused as ended: ${answered.slice(0, 300)}`);
  must(db.resumes.length === 0 && JSON.stringify(db.rows.get("users")) === "[1,2]", `the plugin acted on the answer: ${JSON.stringify(db)}`);
  const called = await tools.find((t) => t.name === "db__query").execute("c2", { sql: "DELETE FROM users WHERE id = 1" }).then(
    (out: any) => JSON.stringify(out), (e: any) => String(e?.message ?? e));
  must(/task_ended|has ended/.test(called) && db.ran.length === 0, `a call after the end ran: ${called.slice(0, 300)} ran=${JSON.stringify(db.ran)}`);
  host.dispose();
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log("  ────────────────────────────────────────────────────────");
console.log(`  ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
