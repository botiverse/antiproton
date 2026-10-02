/**
 * Moving a pi085 agent to the pd engine and back (src/runtime/pd-migrate.ts). Run over node:sqlite by
 * test/pd-migrate.ts and on a real Durable Object's storage by cf/src/conformance.ts (test/pd-migrate-do.sh).
 *
 * The world is test/spec/pd-tools-spec.ts's. One history is made on pi085 — a tool call, a turn cancelled mid model
 * call, a compaction with a retained tail, a second session — once on storage that is migrated and once on storage
 * that never is. What is compared is what the model is sent next (every request through `toRequest`): pd after the
 * migration against pi085 never migrated, and pi085 after the rollback against pi085 never migrated. The tables are
 * compared too: pi 0.85's are never written, and the object's other tables (mounts, credentials, state, the usage and
 * trace outboxes) are not touched by the import.
 */
import { BACKGROUND_CONTEXT as CTX } from "@earendil-works/pi-agent-core/harness/context";
import { branchTip, setValue } from "@earendil-works/pi-agent-core/harness/session";
import { fromResponse, toRequest } from "../../src/model/pi-bridge.ts";
import { DurableAgent, PdHost } from "../../src/runtime/durable-agent.ts";
import { importDrafts, MIGRATED, migrateToPd, revertToPi085 } from "../../src/runtime/pd-migrate.ts";
import { PiAgent } from "../../src/runtime/pi-agent.ts";
import { ensureBackgroundTable } from "../../src/runtime/background-jobs.ts";
import { PiSqliteStorage } from "../../src/store/pi-storage.ts";
import { ApStore } from "../../src/store/ap-store.ts";
import type { DurableSqlHost } from "../../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../../src/store/sql-namespace.ts";
import { UnknownJob } from "../../cf/src/model-queue.ts";
import { CANCELLED_NOTE, sessionTranscript, TURN_CANCELLED } from "../../cf/src/agents-api/transcript.ts";
import type { DriveCase, WithDriveHost } from "./durable-drive-spec.ts";
import { calls, MODEL, say, seen, SYSTEM, toolOptions, transcript, world, type Engine, type Request, type Turn, type World } from "./pd-tools-spec.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const CANCEL = { marker: TURN_CANCELLED, note: CANCELLED_NOTE };
const NOTE_PROJECTOR = {
  [TURN_CANCELLED]: (entry: { timestamp: number }) => [{ role: "user" as const, content: [{ type: "text" as const, text: CANCELLED_NOTE }], timestamp: entry.timestamp }],
};
const SUMMARY = "Summary: one exchange before this point, settled.";

/** pi085 on one session, wired as cf/src/runtime.ts `agent()` wires it (the cancel marker's projector included). */
async function pi085(storage: DurableSqlHost, w: World, session = "main"): Promise<Engine & { agent: PiAgent }> {
  const dispatched: string[] = [];
  const agent = await PiAgent.open({
    host: storage, sessionId: session === "main" ? "t/a" : `t/a#${session}`, session, systemPrompt: SYSTEM, model: MODEL,
    dispatch: async (id) => { dispatched.push(id); }, ...toolOptions(w), entryProjectors: NOTE_PROJECTOR as never,
  });
  return { name: "pi085", agent, dispatched };
}

/** pd's host and one agent per session on it, as the runtime opens them after a migration. */
function pdHost(storage: DurableSqlHost) {
  return new PdHost({ storage, pollAfterMs: 20, minParkMs: 1, stepDeadlineMs: 3_000 });
}
/** One dispatch per host, as the runtime has: the host dispatches through the binding of the agent opened last. */
const sent = new WeakMap<PdHost, string[]>();
function pd(host: PdHost, w: World, session = "main"): Engine & { agent: DurableAgent } {
  const dispatched = sent.get(host) ?? [];
  sent.set(host, dispatched);
  const agent = DurableAgent.open({
    host, tenantId: "t", agentId: "a", model: MODEL, systemPrompt: SYSTEM, session,
    dispatch: async (id) => { dispatched.push(id); }, unknownJob: (id) => new UnknownJob(id),
    ...toolOptions(w), cancelNote: CANCELLED_NOTE,
  });
  return { name: "pd", agent, dispatched, pd: host };
}

/** Step and answer from `script` until nothing is open or due. Returns the requests the model was sent. */
async function settle(e: Engine, script: Turn[]): Promise<Request[]> {
  const requests: Request[] = [];
  const answered = new Set<string>();
  for (let guard = 0; guard < 300; guard++) {
    const out = await e.agent.step();
    const pending = e.dispatched.filter((id) => !answered.has(id));
    for (const id of pending) {
      answered.add(id);
      const job = await Promise.resolve(e.agent.takeJob(id)).catch(() => null) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] } | null;
      if (!job) continue;
      const req = toRequest(job.context) as Request;
      requests.push(req);
      const turn = script[requests.length - 1];
      check(turn, `${e.name}: the model was called ${requests.length} times; the script has ${script.length} turns. Last: ${show(req.messages.slice(-2))}`);
      await e.agent.deliver(id, fromResponse(turn(req), job.model, id));
    }
    if (pending.length) continue;
    if (out.open === 0 && out.wakeInMs === null) return requests;
    check(out.wakeInMs !== null && out.wakeInMs <= 5_000, `${e.name}: stuck: ${show(out)}`);
    await sleep(out.wakeInMs);
  }
  throw new Error(`${e.name}: did not settle`);
}

async function turn(e: Engine, text: string, script: Turn[]): Promise<Request[]> {
  await e.agent.say(text);
  return settle(e, script);
}

/**
 * The history every case starts from, on pi085. main: an early turn, a compaction whose retained tail is a later turn,
 * a tool call, a turn cancelled while its model call was out, and a turn after it; `s2` has one turn. The entries
 * before the compaction are in the transcript and out of the model's context.
 */
async function history(storage: DurableSqlHost): Promise<World> {
  const w = await world(storage);
  // What a migration must not touch, beside the mounts the world made: a credential and a state entry.
  await w.store.putSecret("t", "a", "GITHUB_TOKEN", { ciphertext: "sealed", iv: "iv", account: "octocat", verified: true });
  await w.store.putState("t", "a", "notes", { value: { kept: true }, ref: null, bytes: 13 });
  let e = await pi085(storage, w);
  await turn(e, "an early question", [say("an early answer")]);
  await turn(e, "a kept question", [say("a kept answer")]);
  // A compaction as pi 0.85 records one: its entry at the tip, the summary and a copy of the kept tail.
  const branch = await e.agent.branch();
  const messages = branch.map((x) => (x as { message?: { role?: string; stopReason?: string } }).message).filter((m) => m && m.stopReason !== "deferred");
  const tail = messages.slice(messages.map((m) => m!.role).lastIndexOf("user"));
  check(tail.length === 2, `the retained tail: ${show(tail)}`);
  await e.agent.close();
  const id = "compaction-1";
  await new PiSqliteStorage(storage).commit([
    { kind: "entry", entry: { id, parentId: branch.at(-1)!.id, type: "compaction", summary: SUMMARY, retainedTail: tail, tokensBefore: 1234, fromHook: true } as never },
    setValue(branchTip("main"), id),
  ], CTX);
  e = await pi085(storage, w);
  await turn(e, "read page x", [calls(["c1", "web__read_page", { url: "x" }]), say("page x is read")]);
  await e.agent.say("write a long story");
  await e.agent.step();
  check(e.dispatched.length === 3, `pi085: the story's model call was not dispatched (${show(e.dispatched)})`);
  check(await e.agent.cancel(TURN_CANCELLED) !== null, "pi085: the story's turn was not cancelled");
  await settle(e, []);
  await turn(e, "after the cancel", [say("fine")]);
  await e.agent.close();
  const s2 = await pi085(storage, w, "s2");
  await turn(s2, "hello from the second session", [say("second session reply")]);
  await s2.agent.close();
  return w;
}

/** The next turn on each session, as each engine is asked it. */
async function nextTurns(make: (session: string) => Promise<Engine> | Engine) {
  const out: Record<string, Request[]> = {};
  for (const session of ["main", "s2"]) {
    const e = await make(session);
    try { out[session] = await turn(e, `next on ${session}`, [say(`ok ${session}`)]); }
    finally { await e.agent.close(); }
  }
  return out;
}

function sameRequests(a: Record<string, Request[]>, b: Record<string, Request[]>, what: string) {
  for (const session of Object.keys(a)) {
    const [x, y] = [a[session]!, b[session]!];
    check(x.length === 1 && y.length === 1, `${what}, ${session}: ${x.length} and ${y.length} model calls`);
    const [p, q] = [seen(x[0]!), seen(y[0]!)];
    check(show(p.tools) === show(q.tools), `${what}, ${session}: the tools differ`);
    p.messages.forEach((m, i) => check(m === q.messages[i], `${what}, ${session}: message ${i} differs\n never migrated ${m}\n here           ${q.messages[i]}`));
    check(p.messages.length === q.messages.length, `${what}, ${session}: ${p.messages.length} messages never migrated, ${q.messages.length} here`);
  }
}

/** Every row of the tables `which` selects, as text: what "untouched" is measured with. */
function dump(storage: DurableSqlHost, which: (table: string) => boolean): string {
  const names = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").toArray()
    .map((r) => String(r.name)).filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_") && which(n));
  return names.map((n) => `${n}: ${storage.sql.exec(`SELECT * FROM "${n}"`).toArray().map((r) => show(r)).sort().join("\n")}`).join("\n\n");
}
/** pi085's: its transcript tables, and its record of the calls waiting for the API caller. */
const isPi = (t: string) => t.startsWith("pi_") || t === "api_client_calls";
/** Not an engine's: what a migration must leave as it was. */
const notEngine = (t: string) => !t.startsWith("pi_") && !t.startsWith("pd_") && !t.startsWith("ap_") && t !== "api_client_calls";
const count = (storage: DurableSqlHost, table: string) => Number(storage.sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]!.n);

export function pdMigrateCases(withHost: WithDriveHost): DriveCase[] {
  const cases: DriveCase[] = [];
  const add = (group: string, name: string, run: () => Promise<void>) => cases.push({ group, name, run });

  /** The next turns of the history on pi085, never migrated: what every case compares with. */
  let never: Promise<Record<string, Request[]>> | null = null;
  const neverMigrated = () => never ??= (async () => {
    let out: Record<string, Request[]> = {};
    await withHost(async (storage) => {
      const w = await history(storage);
      out = await nextTurns((s) => pi085(storage, w, s));
    });
    return out;
  })();

  add("migrate", "a pi085 history (tool call, cancel, compaction, two sessions) moves to pd: the next requests are pi085's, the readers show it, and the import bills nothing and touches nothing else", async () => {
    const expected = await neverMigrated();
    await withHost(async (storage) => {
      const w = await history(storage);
      const transcripts: Record<string, string[]> = {};
      for (const s of ["main", "s2"]) { const e = await pi085(storage, w, s); transcripts[s] = await transcript(e); await e.agent.close(); }
      const [pi, other, usage, trace] = [dump(storage, isPi), dump(storage, notEngine), count(storage, "usage_outbox"), count(storage, "trace_outbox")];
      check(count(storage, "mounts") === 3 && count(storage, "secrets") === 1 && count(storage, "agent_state") === 1 && usage > 0,
        "the world lacks what the check below is about");
      const host = pdHost(storage);
      host.bind({ tenantId: "t", agentId: "a", model: MODEL, dispatch: async () => {}, unknownJob: (id) => new UnknownJob(id) });
      const out = await migrateToPd({ storage, host, cancel: CANCEL });
      check(out.ok && out.action === "migrated" && out.engine === "pd", `not migrated: ${show(out)}`);
      check(out.sessions.map((s) => s.session).join() === "main,s2", `sessions: ${show(out.sessions)}`);
      check(new ApStore(storage, prefixedNamespace("ap")).engine() === "pd", "the engine did not move");
      check(dump(storage, isPi) === pi, "pi 0.85's tables were written");
      check(dump(storage, notEngine) === other, "a table that is no engine's was written (mounts, credentials, state, outboxes)");
      check(count(storage, "usage_outbox") === usage && count(storage, "trace_outbox") === trace, "the import wrote usage or trace rows");
      // The readers: the console's lines and the Agents API's turns read the imported history.
      const agents = { main: pd(host, w, "main"), s2: pd(host, w, "s2") };
      for (const s of ["main", "s2"] as const) {
        const lines = await transcript(agents[s]);
        let at = 0;
        for (const line of transcripts[s]!) { at = lines.indexOf(line, at); check(at >= 0, `${s}: the pd transcript lacks pi085's line ${line}\n pd ${show(lines)}`); at++; }
      }
      const api = sessionTranscript({ entries: await agents.main.agent.entries({}), running: false, pending: [] }, { sessionId: "s", agentId: "a" });
      check(show(api.turns.map((t) => t.status)) === show(["completed", "completed", "completed", "cancelled", "completed"]), `the Agents API's turns: ${show(api.turns.map((t) => t.status))}`);
      const next = await nextTurns((s) => agents[s as "main" | "s2"]);
      sameRequests(expected, next, "pd after the migration");
      const req = next.main![0]!;
      check(seen(req).messages.some((m) => m.includes(SUMMARY)), "the next request lacks the compaction's summary");
      check(seen(req).messages.some((m) => m.includes("page x") && m.includes("\"tool\"")), "the next request lacks the tool's result");
      check(seen(req).messages.some((m) => m.includes(CANCELLED_NOTE.slice(0, 30))), "the next request lacks the cancel's note");
      check(!seen(req).messages.some((m) => m.includes("an early question")), "the next request carries what the compaction summarised");
      check(count(storage, "usage_outbox") > usage, "pd's own turn was not billed");
      // What the import reports, checked last: the behaviour above is what it is about.
      const main = out.sessions.find((s) => s.session === "main")!;
      check(main.counts.toolResult === 1 && main.counts.compaction === 1 && main.counts.notes[TURN_CANCELLED] === 1 && main.counts.user === 5 && main.counts.assistant === 5,
        `main's import: ${show(main)}`);
    });
  });

  add("migrate", "dry-run reports what would be imported and writes nothing", async () => {
    await withHost(async (storage) => {
      await history(storage);
      const before = dump(storage, () => true);
      const host = pdHost(storage);
      host.bind({ tenantId: "t", agentId: "a", model: MODEL, dispatch: async () => {}, unknownJob: (id) => new UnknownJob(id) });
      const out = await migrateToPd({ storage, host, cancel: CANCEL, dryRun: true });
      check(out.ok && out.action === "dry-run" && out.engine === "pi085", `dry-run: ${show(out)}`);
      const main = out.sessions.find((s) => s.session === "main")!;
      check(main.counts.assistant === 5 && main.counts.toolResult === 1 && main.counts.compaction === 1 && !main.imported && (main.counts.dropped.deferred ?? 0) > 0,
        `the report: ${show(main)}`);
      check(dump(storage, () => true) === before, "a dry-run wrote something");
      check(!host.open, "a dry-run opened pi-durable");
    });
  });

  add("migrate", "refused while busy (a model call out, a background job running), writing nothing; once idle it goes ahead", async () => {
    await withHost(async (storage) => {
      const w = await history(storage);
      const e = await pi085(storage, w);
      await e.agent.say("one more");
      await e.agent.step();
      const before = dump(storage, () => true);
      const host = pdHost(storage);
      host.bind({ tenantId: "t", agentId: "a", model: MODEL, dispatch: async () => {}, unknownJob: (id) => new UnknownJob(id) });
      const refused = await migrateToPd({ storage, host, cancel: CANCEL });
      check(!refused.ok && /not idle/.test(refused.refused) && /run in progress/.test(refused.refused) && /model call/.test(refused.refused), `busy: ${show(refused)}`);
      check(dump(storage, () => true) === before, "a refused migration wrote something");
      await settle(e, [say("done")]);
      await e.agent.close();
      // Background work still running: its result would be a message to a session mid-move.
      ensureBackgroundTable(storage.sql as never);
      storage.sql.exec("INSERT INTO background_jobs(id, tenant_id, agent_id, session, mount, tool, handle, state, created_at, polls, next_poll_at) VALUES ('bg1','t','a','main','box','shell','{}','running',0,0,0)");
      const background = await migrateToPd({ storage, host, cancel: CANCEL });
      check(!background.ok && /1 background job\(s\) running/.test(background.refused), `with a background job: ${show(background)}`);
      storage.sql.exec("UPDATE background_jobs SET state = 'done' WHERE id = 'bg1'");
      const out = await migrateToPd({ storage, host, cancel: CANCEL });
      check(out.ok && out.action === "migrated", `once idle: ${show(out)}`);
    });
  });

  add("migrate", "idempotent: a second run is a no-op, and a run that stopped before the engine moved is finished without a second import", async () => {
    await withHost(async (storage) => {
      await history(storage);
      const host = pdHost(storage);
      host.bind({ tenantId: "t", agentId: "a", model: MODEL, dispatch: async () => {}, unknownJob: (id) => new UnknownJob(id) });
      check((await migrateToPd({ storage, host, cancel: CANCEL })).ok, "the first run");
      const entries = count(storage, "pd_entries");
      const again = await migrateToPd({ storage, host, cancel: CANCEL });
      check(again.ok && again.action === "already", `the second run: ${show(again)}`);
      // As if the first run had stopped after its imports: the engine never moved.
      new ApStore(storage, prefixedNamespace("ap")).migrateEngine("pd", "pi085");
      const dry = await migrateToPd({ storage, host, cancel: CANCEL, dryRun: true });
      check(dry.ok && dry.sessions.every((s) => s.imported), `the imports were not recognised: ${show(dry)}`);
      const third = await migrateToPd({ storage, host, cancel: CANCEL });
      check(third.ok && third.action === "migrated" && third.engine === "pd", `the resumed run: ${show(third)}`);
      check(count(storage, "pd_entries") === entries, `imported again: ${entries} entries, now ${count(storage, "pd_entries")}`);
      const markers = Number(storage.sql.exec("SELECT COUNT(*) AS n FROM pd_entries WHERE json_extract(record, '$.kind') = ?", MIGRATED).toArray()[0]!.n);
      check(markers === 2, `${markers} ${MIGRATED} entries for two sessions`);
    });
  });

  add("migrate", "a compaction's retained tail: kept where it stands when it is the entries before it, else appended after a compaction that starts at itself", () => {
    const at = (id: string, parentId: string | null, rest: object) => ({ id, parentId, seq: 0, timestamp: 1, ...rest });
    const user = { role: "user", content: [{ type: "text", text: "kept" }], timestamp: 1 };
    const answer = { role: "assistant", content: [{ type: "text", text: "kept too" }], stopReason: "stop", timestamp: 2 };
    const before = [at("1", null, { type: "message", message: { role: "user", content: [{ type: "text", text: "old" }], timestamp: 0 } }),
      at("2", "1", { type: "message", message: user }), at("3", "2", { type: "message", message: answer })];
    const compaction = (tail: object[]) => at("4", "3", { type: "compaction", summary: "S", retainedTail: tail, tokensBefore: 0, fromHook: false });
    const inPlace = importDrafts([...before, compaction([user, answer])]);
    check(inPlace.drafts.length === 4 && inPlace.heads.get(3) === 1 && inPlace.counts.user === 2, `in place: ${show({ ...inPlace, heads: [...inPlace.heads] })}`);
    const copied = importDrafts([...before, compaction([{ ...user, content: [{ type: "text", text: "elsewhere" }] }])]);
    check(copied.drafts.length === 5 && copied.heads.size === 0 && copied.drafts[3]!.head === "self" && show(copied.drafts[4]!.model).includes("elsewhere"),
      `copied: ${show({ ...copied, heads: [...copied.heads] })}`);
    return Promise.resolve();
  });

  add("revert", "the rollback returns pi085 exactly: its tables as before the migration, its next requests the never-migrated ones, pd's state gone", async () => {
    const expected = await neverMigrated();
    await withHost(async (storage) => {
      const w = await history(storage);
      const [pi, other] = [dump(storage, isPi), dump(storage, (t) => notEngine(t) && t !== "usage_outbox" && t !== "trace_outbox")];
      const host = pdHost(storage);
      host.bind({ tenantId: "t", agentId: "a", model: MODEL, dispatch: async () => {}, unknownJob: (id) => new UnknownJob(id) });
      check((await migrateToPd({ storage, host, cancel: CANCEL })).ok, "migrated");
      // A turn on pd: the rollback does not carry it back.
      const e = pd(host, w);
      await turn(e, "a turn on pd", [say("pd reply")]);
      await e.agent.close();
      // Busy pd is refused.
      await e.agent.say("another");
      await e.agent.step();
      const busy = await revertToPi085({ storage, host });
      check(!busy.ok && /not idle/.test(busy.refused), `busy revert: ${show(busy)}`);
      await settle(e, [say("pd again")]);
      await e.agent.close();
      const dry = await revertToPi085({ storage, host, dryRun: true });
      check(dry.ok && dry.action === "dry-run" && (dry.dropped?.conversations ?? 0) === 2, `dry-run: ${show(dry)}`);
      const out = await revertToPi085({ storage, host });
      check(out.ok && out.action === "reverted" && out.engine === "pi085", `reverted: ${show(out)}`);
      check(dump(storage, isPi) === pi, "pi 0.85's tables differ from before the migration");
      check(dump(storage, (t) => notEngine(t) && t !== "usage_outbox" && t !== "trace_outbox") === other, "a table that is no engine's changed");
      check(dump(storage, (t) => t.startsWith("pd_")) === "", "pi-durable's tables are still there");
      const ap = new ApStore(storage, prefixedNamespace("ap"));
      check(ap.query("SELECT 1 FROM conversations").length === 0 && ap.migratedFrom() === null, "the ap tables still list conversations");
      sameRequests(expected, await nextTurns((s) => pi085(storage, w, s)), "pi085 after the rollback");
      check((await revertToPi085({ storage, host: pdHost(storage) })).ok, "a second rollback");
    });
  });

  add("revert", "refused for an agent created on pd", async () => {
    await withHost(async (storage) => {
      const ap = new ApStore(storage, prefixedNamespace("ap"));
      ap.ensure();
      ap.setEngineOnce("pd");
      const host = pdHost(storage);
      host.bind({ tenantId: "t", agentId: "a", model: MODEL, dispatch: async () => {}, unknownJob: (id) => new UnknownJob(id) });
      const out = await revertToPi085({ storage, host });
      check(!out.ok && /created on pd/.test(out.refused), `${show(out)}`);
      check(ap.engine() === "pd", "the engine moved");
      const kept = await migrateToPd({ storage, host });
      check(kept.ok && kept.action === "already", `migrating a pd agent: ${show(kept)}`);
    });
  });

  return cases;
}
