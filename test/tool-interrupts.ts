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
        if (s.step === "delete") return answer === "confirm" ? exec(s.sql) : { cancelled: true };
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
  return { db, store, gw, host, reg, TOOLS, tools, query, resume, keeping };
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

await check("a held call (confirm: true) that a person approves and that then asks has nobody to ask: dropped, nothing runs, the question rides back", async () => {
  const f = await fixture();
  const pending: any = await f.gw.invoke(CTX, "db.query", { sql: "DELETE FROM users" }, { confirm: true });
  must(pending.status === "pending", `held: ${JSON.stringify(pending)}`);
  const decided: any = await f.gw.applyApproval("t", pending.operationId, "approved", "person");
  must(decided.ok && decided.result.status === "succeeded" && decided.result.result.state === "interrupted", `approved: ${JSON.stringify(decided)}`);
  must(!JSON.stringify(decided).includes(SECRET), "the plugin's state rode the completion");
  must(f.db.cancels.length === 1 && f.db.ran.length === 0, `nothing ran: ${JSON.stringify(f.db)}`);
});

await check("resume after the mount was switched off is refused like a call, and nothing runs", async () => {
  const f = await fixture();
  const y = body(await f.query.execute("c1", { sql: "DELETE FROM users" }));
  await f.store.setPluginChoice("t", "a", "sql", "disable");
  let why = "";
  try { await f.resume.execute("r1", { token: y.token, answer: "confirm" }); } catch (e) { why = String((e as Error).message); }
  must(/switched off/.test(why) && f.db.ran.length === 0 && f.db.resumes.length === 0, `switched off: ${why}`);
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
  return { send: tools.find((t) => t.name === "raft__send_message"), resume: resumeTool(reg, { scope: "s" }) as any, reg };
}

await check("raft: a held send yields send/drop with the newer messages; resume \"send\" sends it once, attesting what was shown", async () => {
  const f = await raftFixture();
  const calls = many(HELD(), json(200, { ok: true, state: "sent", messageId: "m-2", messageSeq: 21 }));
  const out = await f.send.execute("c1", { target: "#general", content: "done", idempotencyKey: "k1" });
  const y = body(out);
  must(y.state === "yielded" && /arrived in #general/.test(y.question) && JSON.stringify(y.answer) === '{"choices":["send","drop"]}', `held: ${JSON.stringify(y)}`);
  must(y.context?.messages?.[0]?.includes("@tygg: wait, one more thing") && !out.content[0].text.includes('"content":"done"'), `context, and the state kept back: ${out.content[0].text}`);
  must(calls.length === 1, "one attempt so far");
  const sent = body(await f.resume.execute("r1", { token: y.token, answer: "send" }));
  const second = JSON.parse(String(calls[1]!.init.body));
  must(sent.state === "sent" && second.seenUpToSeq === 20 && second.idempotencyKey === "k1" && second.content === "done", `sent: ${JSON.stringify({ sent, second })}`);
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
  const raftSend = raftPlugin.tools.find((t) => t.name === "send_message")!;
  must(/resume with "send"/.test(raftSend.summary) && /drop it and call send_message again/.test(raftSend.summary), `raft's description: ${raftSend.summary}`);
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
    operatorModel: { baseUrl: "https://model.example/v1", apiKey: "k", model: "deepseek-flash" },
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
  const tools = await (await rt.agent("t", "a")).harness.getTools(BACKGROUND_CONTEXT as any) as any[];
  const names = tools.map((t) => t.name);
  must(names.includes("resume") && !names.includes("run_js") && names.includes("db__query"), `offered: ${names}`);
  const y = body(await tools.find((t) => t.name === "db__query").execute("c1", { sql: "DELETE FROM users" }));
  must(y.state === "yielded" && typeof y.token === "string" && rt.runJsContinuations.size === 1, `yielded: ${JSON.stringify(y)}`);
  const done = body(await tools.find((t) => t.name === "resume").execute("r1", { token: y.token, answer: "confirm" }));
  must(done.deleted === 2 && JSON.stringify(db.rows.get("users")) === "[]", `resumed through the runtime's host: ${JSON.stringify(done)}`);
  const other = (await (await rt.agent("t", "b")).harness.getTools(BACKGROUND_CONTEXT as any) as any[]).map((t) => t.name);
  must(!other.includes("resume"), `resume offered with nothing that can ask: ${other}`);
  host.dispose();
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log("  ────────────────────────────────────────────────────────");
console.log(`  ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
