/**
 * A call to a tool the model was not offered (src/runtime/unavailable-tool.ts): what the explanation says, the
 * retired table it reads (`Plugin.retired`, raft's `RETIRED`), and, on each engine, that the request after such a
 * call carries the explanation where pi's own line was, that a real tool's identical text is left alone, and that
 * pi's line and code are still the ones the recognisers key on (docs/pi-upstream.md §3).
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { fromResponse, toRequest } from "../src/model/pi-bridge.ts";
import { RETIRED, raftPlugin } from "../src/plugins/raft.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { DurableAgent, PdHost, UNAVAILABLE_IDS_PER_QUERY } from "../src/runtime/durable-agent.ts";
import { PiAgent } from "../src/runtime/pi-agent.ts";
import { qualifyMountedTools, type MountedTool, type ToolHost } from "../src/runtime/pi-tools.ts";
import { readPdRecords } from "../src/runtime/pd-transcript.ts";
import { admitTools } from "../src/runtime/mount-tools.ts";
import {
  explainUnavailableTool, isPdUnavailableEntry, isPiUnavailableResult, looksPdUnavailable, pdUnavailableText, piUnavailableText,
  type UnavailableToolContext,
} from "../src/runtime/unavailable-tool.ts";
import { ApStore } from "../src/store/ap-store.ts";
import type { DurableSqlHost } from "../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace } from "../src/store/sql-namespace.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { UnknownJob } from "../cf/src/model-queue.ts";
import { runDriveCases, type DriveCase } from "./spec/durable-drive-spec.ts";
import { MODEL, SYSTEM, calls, converse, say, type Engine, type Request } from "./spec/pd-tools-spec.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
const AGAIN = "Retrying the same call will not help.";

// ---- the explanation -------------------------------------------------------------------------------

/** One raft mount, offered `messages_send` and `receive_events`, as the catalogue names them. */
const raftOffered = [
  { name: "raft__messages_send", address: "raft.messages_send" },
  { name: "raft__receive_events", address: "raft.receive_events" },
];
const raftCtx = (extra: Partial<UnavailableToolContext> = {}, skipped: Array<{ name: string; reason: string }> = []): UnavailableToolContext => ({
  mounts: [{ alias: "raft", plugin: raftPlugin, toolSnapshot: { skipped } }],
  offered: raftOffered,
  ...extra,
});
const RENAMED = "There is no tool named \"raft__send_message\" any more: the `raft` mount renamed it to raft__messages_send. " +
  `Call raft__messages_send instead. ${AGAIN}`;

const explainCases: DriveCase[] = [
  {
    group: "explanation", name: "renamed: the new name as the model sees it, and to call that instead",
    run: async () => {
      const text = explainUnavailableTool("raft__send_message", raftCtx());
      check(text === RENAMED, `got ${show(text)}`);
    },
  },
  {
    group: "explanation", name: "renamed to a tool this mount does not offer: says so, with the recorded reason, and does not say to call it",
    run: async () => {
      const text = explainUnavailableTool("raft__join_channel", raftCtx({}, [{ name: "channels_join", reason: "the credential lacks the Raft capability channels:write" }]));
      check(text === "There is no tool named \"raft__join_channel\" any more: the `raft` mount renamed it to raft__channels_join, which this mount " +
        `does not offer you (the credential lacks the Raft capability channels:write). ${AGAIN} The tools you can call are the ones in your tool list.`, `got ${show(text)}`);
      check(!text.includes("Call raft__channels_join"), "told to call a tool it was not offered");
    },
  },
  {
    group: "explanation", name: "removed (null): the mount does not offer it, without claiming it once did (raft__mentions_execute never was)",
    run: async () => {
      const text = explainUnavailableTool("raft__mentions_execute", raftCtx());
      check(text === `The \`raft\` mount does not offer "raft__mentions_execute". ${AGAIN} The tools you can call are the ones in your tool list.`, `got ${show(text)}`);
      check(!/no longer|any more|renamed/.test(text), `implies it was once offered: ${show(text)}`);
    },
  },
  {
    group: "explanation", name: "left out of the mount's tool list: the reason the snapshot recorded",
    run: async () => {
      const text = explainUnavailableTool("raft__tasks_create", raftCtx({}, [{ name: "tasks_create", reason: "the credential lacks the Raft capability tasks:write" }]));
      check(text === "The `raft` mount does not offer \"raft__tasks_create\" to you: the credential lacks the Raft capability tasks:write. " +
        `${AGAIN} The tools you can call are the ones in your tool list.`, `got ${show(text)}`);
    },
  },
  {
    group: "explanation", name: "a name the mount never had: this mount has no such tool",
    run: async () => {
      const text = explainUnavailableTool("raft__nope", raftCtx());
      check(text === `The \`raft\` mount has no tool named "raft__nope". ${AGAIN} The tools you can call are the ones in your tool list.`, `got ${show(text)}`);
    },
  },
  {
    group: "explanation", name: "an alias no mount has, and a name with no alias at all",
    run: async () => {
      const a = explainUnavailableTool("gh__issues_list", raftCtx());
      check(a === `No mount has the alias "gh", so there is no tool named "gh__issues_list". ${AGAIN} The tools you can call are the ones in your tool list.`, `got ${show(a)}`);
      const b = explainUnavailableTool("send_message", raftCtx());
      check(b === `There is no tool named "send_message". ${AGAIN} The tools you can call are the ones in your tool list.`, `got ${show(b)}`);
    },
  },
  {
    group: "explanation", name: "a mount that is switched off: the gateway's reason, not 'no mount has that alias'",
    run: async () => {
      const text = explainUnavailableTool("gh__issues_list", raftCtx({ unoffered: [{ alias: "gh", plugin: "github", reason: "switched_off" }] }));
      check(text === `The \`gh\` mount is switched off for this agent; someone has to turn it back on, so "gh__issues_list" cannot be called. ${AGAIN}`, `got ${show(text)}`);
    },
  },
  {
    group: "explanation", name: "retired is asked before skipped: a retired name an old snapshot also lists reads as renamed",
    run: async () => {
      const text = explainUnavailableTool("raft__send_message", raftCtx({}, [{ name: "send_message", reason: "the credential lacks the Raft capability messages:write" }]));
      check(text === RENAMED, `got ${show(text)}`);
    },
  },
  {
    group: "explanation", name: "the longest alias owns the name: `my__gh` beside `my`",
    run: async () => {
      const text = explainUnavailableTool("my__gh__old", {
        mounts: [{ alias: "my", plugin: { retired: { gh__old: null } } }, { alias: "my__gh", plugin: { retired: { old: "new" } } }],
        offered: [{ name: "my__gh__new", address: "my__gh.new" }],
      });
      check(text.includes("renamed it to my__gh__new"), `got ${show(text)}`);
    },
  },
  {
    group: "explanation", name: "every text says retrying the same call will not help",
    run: async () => {
      const ctx = raftCtx({ unoffered: [{ alias: "gh", plugin: "github", reason: "plugin_unavailable" }] }, [{ name: "tasks_create", reason: "r" }]);
      for (const n of ["raft__send_message", "raft__tasks_create", "raft__nope", "zz__x", "x", "gh__x", "raft__join_channel"]) {
        check(explainUnavailableTool(n, ctx).includes(AGAIN), `${n}: ${explainUnavailableTool(n, ctx)}`);
      }
    },
  },
];

/** What raft's own listing records for a mount with no credential, admitted as the kernel stores it. */
const credentialless = async () => admitTools(await raftPlugin.snapshotTools!({ credential: null } as never), 0);

/**
 * What raft's own listing records for a mount whose credential Raft refuses (`identity.whoami` answering 401), admitted
 * as the kernel stores it. The listing itself is returned too, for its `refused` flag, which admission does not keep.
 */
const refusedListing = async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })) as never;
  try {
    const listed = await raftPlugin.snapshotTools!({
      caller: { tenantId: "t", agentId: "a", taskId: "tool-snapshot" }, alias: "raft", credential: "sk_agent_refused_1234567890",
      publicConfig: { serverUrl: "https://raft.example" },
    } as never);
    return { listed, snap: await admitTools(listed, 0) };
  } finally { globalThis.fetch = realFetch; }
};

explainCases.push(
  {
    group: "explanation", name: "a refused credential: the listing says so (`refused`, and a skipped entry marked `every`), and any tool of the plugin the mount leaves out gets Raft's refusal as the reason",
    run: async () => {
      const { listed, snap } = await refusedListing();
      check(listed.refused === true && listed.tools.length === 0, `the listing: ${show({ refused: listed.refused, tools: listed.tools.length })}`);
      check(snap.skipped.length === 1 && snap.skipped[0]!.every === true && /^Raft refused this mount's credential \(HTTP 401\)$/.test(snap.skipped[0]!.reason),
        `admission kept ${show(snap.skipped)}`);
      const ctx: UnavailableToolContext = { mounts: [{ alias: "raft", plugin: raftPlugin, toolSnapshot: snap }], offered: [{ name: "raft__receive_events", address: "raft.receive_events" }] };
      const text = explainUnavailableTool("raft__messages_send", ctx);
      check(text === "The `raft` mount does not offer \"raft__messages_send\" to you: Raft refused this mount's credential (HTTP 401). " +
        `${AGAIN} The tools you can call are the ones in your tool list.`, `got ${show(text)}`);
    },
  },
  {
    group: "explanation", name: "no credential: a skipped entry marked `every` gives its reason for any tool of the plugin the mount leaves out",
    run: async () => {
      const snap = await credentialless();
      check(snap.skipped.length === 1 && snap.skipped[0]!.every === true, `control: admission kept ${show(snap.skipped)}`);
      const ctx: UnavailableToolContext = { mounts: [{ alias: "raft", plugin: raftPlugin, toolSnapshot: snap }], offered: [{ name: "raft__receive_events", address: "raft.receive_events" }] };
      const text = explainUnavailableTool("raft__messages_send", ctx);
      check(text === "The `raft` mount does not offer \"raft__messages_send\" to you: this mount has no Raft credential, so it has no capabilities. " +
        `${AGAIN} The tools you can call are the ones in your tool list.`, `got ${show(text)}`);
      const renamed = explainUnavailableTool("raft__send_message", ctx);
      check(renamed.includes("renamed it to raft__messages_send, which this mount does not offer you (this mount has no Raft credential"), `retired on that mount: ${show(renamed)}`);
      const none = explainUnavailableTool("raft__nope", ctx);
      check(none === `The \`raft\` mount has no tool named "raft__nope". ${AGAIN} The tools you can call are the ones in your tool list.`, `a name raft never had: ${show(none)}`);
    },
  },
  {
    group: "explanation", name: "without `every`, a skipped entry is about the one name it carries, however that name reads",
    run: async () => {
      const ctx: UnavailableToolContext = {
        mounts: [{ alias: "raft", plugin: raftPlugin, toolSnapshot: { skipped: [{ name: "(every Raft operation)", reason: "no credential" }] } }], offered: [],
      };
      const text = explainUnavailableTool("raft__messages_send", ctx);
      check(text === `The \`raft\` mount has no tool named "raft__messages_send". ${AGAIN} The tools you can call are the ones in your tool list.`, `got ${show(text)}`);
    },
  },
);

// ---- the retired table -------------------------------------------------------------------------------

/** What is wrong with a plugin's `retired` table: a target it does not offer, or an old name it offers again. */
function retiredProblems(p: Pick<Plugin, "tools" | "retired">): string[] {
  const names = new Set(p.tools.map((t) => t.name));
  const out: string[] = [];
  for (const [old, next] of Object.entries(p.retired ?? {})) {
    if (names.has(old)) out.push(`${old} is retired and still a tool`);
    if (next !== null && !names.has(next)) out.push(`${old} → ${next}, which is not a tool of the plugin`);
  }
  return out;
}

const tableCases: DriveCase[] = [
  {
    group: "retired table", name: "raft: every target is a tool it offers, and no retired name is offered again",
    run: async () => {
      check(raftPlugin.retired === RETIRED, "raftPlugin does not declare RETIRED");
      check(Object.keys(RETIRED).length === 9, `control: ${show(RETIRED)}`);
      const problems = retiredProblems(raftPlugin);
      check(problems.length === 0, problems.join("; "));
      // The two operations SDK 0.12.0 removed: one renamed, one gone.
      check(RETIRED.mentions_deliveries === "mentions_delivery" && RETIRED.mentions_execute === null, `0.12.0's removals: ${show(RETIRED)}`);
    },
  },
  {
    group: "retired table", name: "the check sees both directions (a target that is not a tool, an old name that is one)",
    run: async () => {
      const p = retiredProblems({ tools: raftPlugin.tools, retired: { send_message: "messages_sendx", receive_events: "messages_read" } });
      check(show(p) === show(["send_message → messages_sendx, which is not a tool of the plugin", "receive_events is retired and still a tool"]), show(p));
    },
  },
];

// ---- the engines --------------------------------------------------------------------------------------

/** A mount `raft` offering `messages_send`, as the catalogue builds it; the host answers every call. */
const catalogue: MountedTool[] = qualifyMountedTools([{
  name: "messages_send", description: "Send a message.", parameters: { type: "object", properties: { text: { type: "string" } } },
  address: "raft.messages_send", sideEffects: "write", idempotency: "none",
}]);
const toolHost: ToolHost = { async invoke() { return { status: "succeeded", result: { sent: true }, operationId: "op_1" } as never; } };

/** A tool of the harness's own (as run_js is), whose answer is an error with exactly `text`: what a tool can say. */
const liar = (name: string, text: string): AgentHarnessTool<undefined> => ({
  name, label: name, description: "Fails.", parameters: { type: "object", properties: {} } as never,
  async execute() { throw new Error(text); },
}) as AgentHarnessTool<undefined>;

const explainRaft = (offered: ReadonlyArray<{ name: string; address: string }> = catalogue) =>
  (name: string) => explainUnavailableTool(name, { mounts: [{ alias: "raft", plugin: raftPlugin }], offered });

type Opened = { extraTools?: AgentHarnessTool<undefined>[]; explain?: (name: string) => string; tools?: MountedTool[] };

async function openPi(storage: DurableSqlHost, o: Opened): Promise<Engine> {
  const dispatched: string[] = [];
  const agent = await PiAgent.open({
    host: storage, sessionId: "t/a", session: "main", systemPrompt: SYSTEM, model: MODEL,
    dispatch: async (id) => { dispatched.push(id); },
    tools: o.tools ?? catalogue, toolHost, extraTools: (o.extraTools ?? []) as never,
    ...(o.explain ? { explainUnavailable: o.explain } : {}),
  });
  return { name: "pi085", agent, dispatched };
}

function openPd(storage: DurableSqlHost, o: Opened, host?: PdHost): Engine {
  const dispatched: string[] = [];
  const pd = host ?? new PdHost({ storage, pollAfterMs: 20, minParkMs: 1 });
  const agent = DurableAgent.open({
    host: pd, tenantId: "t", agentId: "a", model: MODEL, systemPrompt: SYSTEM,
    dispatch: async (id) => { dispatched.push(id); }, unknownJob: (id) => new UnknownJob(id),
    tools: o.tools ?? catalogue, toolHost, extraTools: (o.extraTools ?? []) as never,
    ...(o.explain ? { explainUnavailable: o.explain } : {}),
  });
  return { name: "pd", agent, dispatched, pd };
}

type Which = "pi085" | "pd";
const open = (which: Which, storage: DurableSqlHost, o: Opened) => (which === "pi085" ? openPi(storage, o) : Promise.resolve(openPd(storage, o)));
/** pi's own line for a call to `name`, on this engine. */
const piLine = (which: Which, name: string) => (which === "pi085" ? piUnavailableText(name) : pdUnavailableText(name));

/** The tool result for call `id` in a request, as the model reads it. */
function resultIn(req: Request, id: string): string {
  const m = req.messages.find((x) => x.role === "tool" && (x as { tool_call_id?: string }).tool_call_id === id);
  check(m, `no result for ${id} in ${show(req.messages)}`);
  return String(m.content);
}

/** How many pi-durable tool tasks the object ever made: one means the call reached a tool task (pi-durable 1.0.0 dist/harness/tool.js). */
const toolTasks = (storage: DurableSqlHost) => Number(storage.sql.exec(
  `SELECT COUNT(*) AS n FROM ${prefixedNamespace("pd").qualify("tasks", "table")} WHERE kind = ?`, JSON.stringify("pi.tool")).toArray()[0]?.n ?? 0);

async function withStorage(use: (storage: DurableSqlHost) => Promise<void>) {
  const host = sqliteHost();
  try { await use(host); } finally { host.dispose(); }
}

/** The stored tool results, as each engine's transcript keeps them. */
async function storedResults(e: Engine) {
  return (await e.agent.entries({}))
    .map((x) => (x as unknown as { message?: { role?: string } }).message)
    .filter((m): m is { role: string } => m?.role === "toolResult");
}

function engineCases(which: Which): DriveCase[] {
  return [
    {
      group: which, name: "the model calls raft__send_message: the next request's result is the rename explanation; the transcript keeps pi's line",
      run: () => withStorage(async (storage) => {
        const e = await open(which, storage, { explain: explainRaft() });
        try {
          const reqs = await converse(e, "hello", [calls(["c1", "raft__send_message", { text: "hi" }]), say("ok")]);
          const got = resultIn(reqs[1]!, "c1");
          check(got === RENAMED, `${which}: the model read ${show(got)}`);
          const stored = await storedResults(e);
          const line = (stored[0] as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text;
          check(stored.length === 1 && line === piLine(which, "raft__send_message"), `${which}: stored ${show(stored)}`);
        } finally { await e.agent.close(); }
      }),
    },
    {
      group: which, name: "control: with no explainer the model reads pi's own line",
      run: () => withStorage(async (storage) => {
        const e = await open(which, storage, {});
        try {
          const reqs = await converse(e, "hello", [calls(["c1", "raft__send_message", {}]), say("ok")]);
          const got = resultIn(reqs[1]!, "c1");
          check(got === piLine(which, "raft__send_message"), `${which}: ${show(got)}`);
        } finally { await e.agent.close(); }
      }),
    },
    {
      group: which, name: "a real tool named raft__send_message whose answer is pi's line verbatim is left as it is",
      run: () => withStorage(async (storage) => {
        const e = await open(which, storage, {
          explain: explainRaft(), extraTools: [liar("raft__send_message", piLine(which, "raft__send_message"))],
        });
        try {
          const reqs = await converse(e, "hello", [calls(["c1", "raft__send_message", {}]), say("ok")]);
          const got = resultIn(reqs[1]!, "c1");
          check(got === piLine(which, "raft__send_message"), `${which}: a real tool's answer was rewritten to ${show(got)}`);
        } finally { await e.agent.close(); }
      }),
    },
    {
      group: which, name: "in one round, pi's result is explained and a real tool's identical text beside it is not",
      run: () => withStorage(async (storage) => {
        const e = await open(which, storage, {
          explain: explainRaft(), extraTools: [liar("echo", piLine(which, "raft__send_message"))],
        });
        try {
          const reqs = await converse(e, "hello", [calls(["c1", "raft__send_message", {}], ["c2", "echo", {}]), say("ok")]);
          check(resultIn(reqs[1]!, "c1") === RENAMED, `${which}: c1 ${show(resultIn(reqs[1]!, "c1"))}`);
          check(resultIn(reqs[1]!, "c2") === piLine(which, "raft__send_message"), `${which}: c2 ${show(resultIn(reqs[1]!, "c2"))}`);
        } finally { await e.agent.close(); }
      }),
    },
    {
      group: which, name: `pi's wording: an unknown call's stored result is what the ${which} recogniser keys on`,
      run: () => withStorage(async (storage) => {
        const e = await open(which, storage, {});
        try {
          await converse(e, "hello", [calls(["c1", "raft__send_message", {}]), say("ok")]);
          const [m] = await storedResults(e);
          const current = new Set(catalogue.map((t) => t.name));
          if (which === "pi085") {
            check(isPiUnavailableResult(m, current), `pi-agent-core's unknown-tool result moved: ${show(m)}; ` +
              `the recogniser expects ${show(piUnavailableText("raft__send_message"))}, isError, no details`);
          } else {
            check(looksPdUnavailable(m, current), `pi-durable's unknown-tool text moved: ${show(m)}; expected ${show(pdUnavailableText("raft__send_message"))}`);
            const records = readPdRecords(storage.sql as never, "main").filter((r) => r.kind === "pi.tool-result");
            check(records.length === 1 && isPdUnavailableEntry(records[0]), `pi-durable's unknown-tool entry moved: ${show(records)}`);
            // The round's own path (pi-durable 1.0.0 dist/harness/generation.js `startToolRound`): no tool task was made for the call.
            check(toolTasks(storage) === 0, `control: ${toolTasks(storage)} tool tasks, so this was not the round's path`);
          }
        } finally { await e.agent.close(); }
      }),
    },
  ];
}

/**
 * `storage` with a Durable Object's limit on bound parameters, which node:sqlite does not have (it allows 32766):
 * a statement binding more than 100 throws "too many SQL variables", as workerd's SQLite does. `most` is the
 * largest number any statement bound.
 */
function doLimited(storage: DurableSqlHost): DurableSqlHost & { most: number } {
  const out = {
    most: 0,
    transactionSync: storage.transactionSync,
    sql: {
      exec(query: string, ...bindings: unknown[]) {
        out.most = Math.max(out.most, bindings.length);
        if (bindings.length > 100) throw new Error(`too many SQL variables: ${bindings.length}`);
        return (storage.sql.exec as (q: string, ...b: unknown[]) => ReturnType<DurableSqlHost["sql"]["exec"]>)(query, ...bindings);
      },
    },
  };
  return out as never;
}

const pdOnly: DriveCase[] = [
  {
    group: "pd", name: `250 unknown calls in one round are all explained, under a Durable Object's 100-variable limit (${UNAVAILABLE_IDS_PER_QUERY} ids a query)`,
    run: () => withStorage(async (raw) => {
      const storage = doLimited(raw);
      const e = openPd(storage, { explain: explainRaft() });
      try {
        const n = 250;
        const round = Array.from({ length: n }, (_, i) => [`c${i}`, `raft__gone_${i}`, {}] as [string, string, unknown]);
        const reqs = await converse(e, "hello", [calls(...round), say("ok")]);
        const untouched = round.filter(([id]) => resultIn(reqs[1]!, id).startsWith("<harness>"));
        check(untouched.length === 0, `${untouched.length} of ${n} results reached the model as pi-durable's own text, first ${show(untouched[0])}`);
        check(resultIn(reqs[1]!, "c249") === `The \`raft\` mount has no tool named "raft__gone_249". ${AGAIN} The tools you can call are the ones in your tool list.`,
          `c249: ${show(resultIn(reqs[1]!, "c249"))}`);
        check(storage.most <= 100, `a statement bound ${storage.most}`);
      } finally { await e.agent.close(); }
    }),
  },
  {
    group: "pd", name: "a tool since removed whose answer was pi-durable's text verbatim: not rewritten, its entry has no tool_unavailable",
    run: () => withStorage(async (storage) => {
      const first = openPd(storage, { explain: explainRaft(), extraTools: [liar("web__flaky", pdUnavailableText("web__flaky"))] });
      try {
        await converse(first, "hello", [calls(["c1", "web__flaky", {}]), say("ok")]);
      } finally { await first.agent.close(); }
      const again = openPd(storage, { explain: explainRaft() });
      try {
        const reqs = await converse(again, "and now", [say("done")]);
        const got = resultIn(reqs[0]!, "c1");
        check(got === pdUnavailableText("web__flaky"), `a real tool's old answer was rewritten to ${show(got)}`);
      } finally { await again.agent.close(); }
    }),
  },
  {
    group: "pd", name: "pi's wording, the tool task's path: a tool offered in the request but gone when its task runs gets tool_unavailable too",
    run: () => withStorage(async (storage) => {
      const host = new PdHost({ storage, pollAfterMs: 20, minParkMs: 1 });
      const before = openPd(storage, { extraTools: [liar("web__soon_gone", "never runs")] }, host);
      try {
        await before.agent.say("hello");
        for (let i = 0; i < 50 && before.dispatched.length === 0; i++) { await before.agent.step(); await sleep(5); }
        check(before.dispatched.length === 1, `dispatched ${show(before.dispatched)}`);
        const id = before.dispatched[0]!;
        const job = await before.agent.takeJob(id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
        check((toRequest(job.context).tools ?? []).some((t) => t.name === "web__soon_gone"), "control: the request does not offer web__soon_gone");
        // The catalogue moves while the call is out: the session's tools are installed again without it.
        const after = openPd(storage, {}, host);
        await after.agent.deliver(id, fromResponse(calls(["c1", "web__soon_gone", {}])({ messages: [] }), job.model, id));
        for (let i = 0; i < 100; i++) {
          await after.agent.step();
          const records = readPdRecords(storage.sql as never, "main").filter((r) => r.kind === "pi.tool-result");
          if (records.length) {
            check(toolTasks(storage) === 1, `control: ${toolTasks(storage)} tool tasks, so this was not the tool task's path`);
            check(isPdUnavailableEntry(records[0]), `pi-durable's tool task wrote ${show(records[0])}`);
            return;
          }
          await sleep(5);
        }
        throw new Error("no tool result was written");
      } finally { await before.agent.close(); }
    }),
  },
];

const piOnly: DriveCase[] = [
  {
    group: "pi085", name: "an old error from a tool since removed, in its own words, is not rewritten (only pi's exact line is)",
    run: () => withStorage(async (storage) => {
      const own = "raft__send_message: the held send's state is incomplete; call messages_send again";
      const first = await openPi(storage, { explain: explainRaft(), extraTools: [liar("raft__send_message", own)] });
      try {
        await converse(first, "hello", [calls(["c1", "raft__send_message", {}]), say("ok")]);
      } finally { await first.agent.close(); }
      const again = await openPi(storage, { explain: explainRaft() });
      try {
        const reqs = await converse(again, "and now", [say("done")]);
        const got = resultIn(reqs[0]!, "c1");
        check(got === own, `a removed tool's own error was rewritten to ${show(got)}`);
      } finally { await again.agent.close(); }
    }),
  },
];

// ---- through the runtime ---------------------------------------------------------------------------------

/** A plugin whose `fetch` was renamed to `get`. */
const kv: Plugin = {
  id: "kv", version: "1.0.0",
  tools: [{ name: "get", summary: "Read a note.", parameters: { type: "object", properties: { key: { type: "string" } } }, sideEffects: "read", idempotency: "none" }] as never,
  retired: { fetch: "get" },
  async invoke() { return {}; },
};

/** AgentRuntime.agent() wires the explanation on `engine`: the model calls notes__fetch, then reads its result. */
async function throughRuntime(engine: Which) {
  const host = sqliteHost();
  try {
    if (engine === "pd") {
      const ap = new ApStore(host, prefixedNamespace("ap"));
      ap.ensure();
      ap.setEngineOnce("pd");
    }
    const sent: string[] = [];
    const rt = new AgentRuntime({
      ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
      bucket: {} as never, bucketName: "b", models: { resolve: () => null },
      autoRelease: false, extraPlugins: [kv],
      operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
      offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
    } as never);
    await rt.ready();
    await rt.store.createAgent("t", "a");
    await rt.store.setPluginChoice("t", "a", "kv", "enable");
    const added = await rt.addMount("t", "a", { alias: "notes", plugin: "kv", config: {} });
    check(added.ok, `${engine}: the mount was refused: ${show(added)}`);
    await rt.bindOperatorModel("t", "a");
    const agent = await rt.agent("t", "a");
    check(agent instanceof (engine === "pd" ? DurableAgent : PiAgent), `${engine}: opened ${agent.constructor.name}`);
    await rt.postMessage("t", "a", "hello");
    const turns = [calls(["c1", "notes__fetch", { key: "k" }]), say("ok")];
    const requests: Request[] = [];
    for (let i = 0; i < 200 && requests.length < turns.length; i++) {
      await rt.step("t", "a");
      const id = sent[requests.length];
      if (id === undefined) { await sleep(10); continue; }
      const job = await rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string }; context: Parameters<typeof toRequest>[0] };
      const req = toRequest(job.context) as Request;
      requests.push(req);
      await rt.deliverAnswer("t", "a", id, fromResponse(turns[requests.length - 1]!(req), job.model, id), undefined);
    }
    check(requests.length === 2, `${engine}: ${requests.length} requests`);
    const got = resultIn(requests[1]!, "c1");
    check(got === `There is no tool named "notes__fetch" any more: the \`notes\` mount renamed it to notes__get. Call notes__get instead. ${AGAIN}`,
      `${engine}: the model read ${show(got)}`);
    await agent.close();
  } finally { host.dispose(); }
}

const runtimeCases: DriveCase[] = (["pi085", "pd"] as const).map((engine) => ({
  group: "runtime", name: `${engine}: AgentRuntime.agent() hands the engine the explanation from the agent's mounts and their plugins' retired tables`,
  run: () => throughRuntime(engine),
}));

const results = await runDriveCases([
  ...explainCases, ...tableCases, ...engineCases("pi085"), ...piOnly, ...engineCases("pd"), ...pdOnly, ...runtimeCases,
]);

console.log(`\n  a call to a tool that is not offered\n  ${"─".repeat(56)}`);
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
