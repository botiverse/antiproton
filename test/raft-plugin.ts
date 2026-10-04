import { createHmac } from "node:crypto";
import { createRaft, isInterrupted, RAFT_OPERATIONS } from "@botiverse/raft-sdk";
import { raftPlugin, EXCLUDED, GENERATED, INBOX_STORE, PAGE_ROWS, PUSH_KEY, PUSH_STORE, originOf, pagingArg, toolOf, commandsAsTools, CLI_COMMANDS } from "../src/plugins/raft.ts";
import { readFileSync } from "node:fs";
import { PARK_BYTES } from "../src/plugins/artifacts.ts";
import { Interrupt, toolsOf, type PluginErrorFields } from "../src/plugins/types.ts";
import { admitTools } from "../src/runtime/mount-tools.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { QuickJsExecutor } from "../src/runtime/executor.ts";
import { bridgeTools, qualifyMountedTools, runJsTool, type MountedTool } from "../src/runtime/pi-tools.ts";

const originalFetch = globalThis.fetch;
const PUSH_SECRET = "raft-push-secret-for-tests";
const results: Array<{ name: string; ok: boolean; error?: string }> = [];

async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

function fakeInbound() {
  let serial = 0;
  const revoked: string[] = [];
  return {
    api: {
      create: async () => {
        serial++;
        return { hookId: `hook-${serial}`, url: `https://hooks.example/hook-${serial}`, secret: `hook-secret-${serial}` };
      },
      revoke: async (hookId: string) => { revoked.push(hookId); return true; },
    },
    revoked,
  };
}

function ctx(
  credential: string | null = "sk_agent_test_1234567890",
  config: Record<string, unknown> = {},
  inbound: ReturnType<typeof fakeInbound>["api"] | undefined = fakeInbound().api,
) {
  return {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "task" },
    alias: "raft",
    credential,
    publicConfig: { serverUrl: "https://raft.example", ...config },
    db: freshDb().db,
    inbound,
    sibling: async () => null, sandboxForms: async () => [],
  } as any;
}

/** A real, empty database for one raft mount, and a reader of its one record. */
function freshDb() {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "tenant", agentId: "agent", alias: "raft", plugin: raftPlugin.id };
  return {
    tables, scope,
    db: openPluginDatabase(tables, scope, raftPlugin.database),
    state: () => tables.get(scope, PUSH_STORE, PUSH_KEY) as any,
  };
}

function mount(initial: unknown = null, inbound = fakeInbound()) {
  const fresh = freshDb();
  if (initial !== null) fresh.tables.put(fresh.scope, PUSH_STORE, PUSH_KEY, initial, null);
  return {
    ctx: { ...ctx(), db: fresh.db, inbound: inbound.api } as any,
    state: fresh.state,
    inbound,
  };
}

const HOOK_ID = "hk_0123456789abcdef";
function pushed(payload: unknown, options: { secret?: string; deliveryId?: string; hookId?: string } = {}) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = createHmac("sha256", options.secret ?? PUSH_SECRET).update(body).digest("hex");
  return {
    headers: {
      "x-raft-signature-256": `sha256=${signature}`,
      "x-raft-delivery-id": options.deliveryId ?? String((payload as any)?.deliveryId ?? ""),
    },
    body,
    hookId: options.hookId ?? HOOK_ID,
  };
}

/** An inbox notice as Raft sends it (raft-agent-inbox-notice.v1). */
function notice(overrides: Record<string, unknown> = {}) {
  return {
    schema: "raft-agent-inbox-notice.v1", noticeId: "ntc_0123456789abcdef", recipientAgentId: "agent-1", occurredAt: "2026-09-28T08:50:00.000Z",
    text: "Inbox update: 2 unread messages total; 1 changed target\n#qa-browser  pending: 2 messages · latest sender @tygg · you were mentioned",
    targets: [{ target: "#qa-browser", channelId: "c1", channelType: "channel", pendingCount: 2, firstPendingMsgId: "m1", latestMsgId: "m2", latestSenderName: "tygg", latestSenderType: "human", flags: ["mention"] }],
    ...overrides,
  };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function one(answer: Response) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer;
  }) as any;
  return calls;
}

function many(...answers: Response[]) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected fetch");
    return answer;
  }) as any;
  return calls;
}

async function failure(fn: () => Promise<unknown>): Promise<Error & PluginErrorFields> {
  try { await fn(); }
  catch (e) { return e as Error & PluginErrorFields; }
  throw new Error("expected failure");
}

/** The tools this plugin writes by hand; every other tool is generated from the manifest. */
const OWN = ["receive_events", "enable_push", "disable_push", "push_status"];
const toolNamed = (name: string) => raftPlugin.tools.find((t) => t.name === name);
const opNamed = (name: string) => RAFT_OPERATIONS.find((op) => op.name === name)!;
/** A context in the model's own turn: no fromProgram, and a context id. */
const inTurn = (c: any, contextId = "ctx_turn") => ({ ...c, caller: { ...c.caller, contextId } });

await check("declares the inbox pull as a model-only write that repeats safely, and its push tools as before", async () => {
  if (raftPlugin.version !== "1.0.0") throw new Error(`unexpected plugin version: ${raftPlugin.version}`);
  // Only the model may pull: a program's pull would acknowledge and attest a batch the model never read.
  const pull = toolNamed("receive_events");
  if (pull?.modelOnly !== true) throw new Error(`receive_events is callable from a program: ${JSON.stringify(pull)}`);
  // Everything else stays callable from code: no generated operation is model-only (those the manifest marks so are excluded).
  const others = raftPlugin.tools.filter((tool) => tool.name !== "receive_events" && tool.modelOnly);
  if (others.length) throw new Error(`model-only beyond receive_events: ${others.map((t) => t.name).join(", ")}`);
  // Under cursor acknowledgement a pull acknowledges the previous batch (a write) and repeating it hands back
  // the same batch (native), which is what lets a failed pull be retried.
  if (pull.sideEffects !== "write" || pull.idempotency !== "native") throw new Error(`receive declaration: ${JSON.stringify(pull)}`);
  if ("since" in ((pull.parameters as any).properties ?? {})) throw new Error("the model can still pass since; the cursor is the plugin's");
  const enable = toolNamed("enable_push");
  const disable = toolNamed("disable_push");
  const status = toolNamed("push_status");
  if (enable?.sideEffects !== "write" || enable.idempotency !== "none") throw new Error("enable_push declaration changed");
  if (disable?.sideEffects !== "write" || disable.idempotency !== "native") throw new Error("disable_push declaration changed");
  if (status?.sideEffects !== "read" || status.idempotency !== "native") throw new Error("push_status declaration changed");
  const serverUrl = raftPlugin.config?.find((field) => field.name === "serverUrl");
  if (serverUrl?.format !== "origin") throw new Error("serverUrl lost its origin guard");
});

/**
 * The operations offered as tools, pinned by name. The plugin generates every manifest operation not in
 * `EXCLUDED`, so without this list an operation a new SDK adds would become a tool with nobody deciding it.
 */
const EXPECTED_GENERATED = [
  "identity.whoami", "inbox.list", "messages.read", "messages.send", "messages.reply", "messages.search", "messages.resolve",
  "messages.react", "messages.unreact", "attachments.comments", "mentions.pending", "mentions.deliveries", "actions.prepare",
  "manual.get", "manual.search", "tasks.claim", "tasks.list", "tasks.create", "tasks.unclaim", "tasks.assign", "tasks.unassign",
  "tasks.updateStatus", "tasks.amend", "tasks.history", "tasks.show", "tasks.convert", "tasks.delete", "channels.join", "channels.leave",
  "channels.mute", "channels.unmute", "channels.members", "channels.info", "threads.list", "threads.unfollow", "server.info", "users.info",
  "profile.show",
];

await check("every manifest operation is a generated tool or in the exclusion table, never both, and every exclusion names a real operation", async () => {
  const names = RAFT_OPERATIONS.map((op) => op.name);
  const excluded = Object.keys(EXCLUDED);
  const unaccounted = names.filter((n) => !EXPECTED_GENERATED.includes(n) && !excluded.includes(n));
  if (unaccounted.length) throw new Error(`neither generated nor excluded (decide which, and say why if excluded): ${unaccounted.join(", ")}`);
  const unreal = [...excluded, ...EXPECTED_GENERATED].filter((n) => !names.includes(n));
  if (unreal.length) throw new Error(`names no manifest operation: ${unreal.join(", ")}`);
  const both = excluded.filter((n) => EXPECTED_GENERATED.includes(n));
  if (both.length) throw new Error(`both generated and excluded: ${both.join(", ")}`);
  const reasonless = excluded.filter((n) => typeof EXCLUDED[n] !== "string" || EXCLUDED[n]!.length < 20);
  if (reasonless.length) throw new Error(`an exclusion without its reason: ${reasonless.join(", ")}`);
  // What the plugin actually offers follows the table: each generated operation once, by its manifest toolName, and no excluded one.
  const generated = GENERATED.map((op) => op.name);
  if (JSON.stringify(generated) !== JSON.stringify(names.filter((n) => EXPECTED_GENERATED.includes(n)))) throw new Error(`generated: ${generated.join(", ")}`);
  const offered = raftPlugin.tools.map((t) => t.name);
  const want = [...OWN, ...RAFT_OPERATIONS.filter((op) => EXPECTED_GENERATED.includes(op.name)).map((op) => op.toolName)];
  if (JSON.stringify(offered) !== JSON.stringify(want)) throw new Error(`offered: ${offered.join(", ")}`);
  if (new Set(offered).size !== offered.length) throw new Error("two tools share a name");
});

/** The JSON Schema a generated tool may use: what every model provider takes, and what the manifest promises to stay within. */
const SCHEMA_KEYWORDS = new Set(["type", "properties", "required", "items", "enum", "description", "additionalProperties", "minimum", "maximum", "minLength", "maxLength"]);
const SCHEMA_TYPES = new Set(["object", "string", "integer", "number", "boolean", "array"]);
function schemaProblems(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path}: not an inline schema object`];
  const s = schema as Record<string, unknown>;
  const out = Object.keys(s).filter((k) => !SCHEMA_KEYWORDS.has(k)).map((k) => `${path}: ${k}`);
  if (s.type !== undefined && (typeof s.type !== "string" || !SCHEMA_TYPES.has(s.type))) out.push(`${path}: type ${JSON.stringify(s.type)}`);
  if (s.type === undefined && s.enum === undefined) out.push(`${path}: neither a type nor an enum`);
  if (s.enum !== undefined && (!Array.isArray(s.enum) || !s.enum.every((v) => ["string", "number", "boolean"].includes(typeof v)))) out.push(`${path}: enum ${JSON.stringify(s.enum)}`);
  if (s.additionalProperties !== undefined && typeof s.additionalProperties !== "boolean") out.push(`${path}: additionalProperties is a schema`);
  for (const k of ["minimum", "maximum", "minLength", "maxLength"]) if (s[k] !== undefined && typeof s[k] !== "number") out.push(`${path}: ${k}`);
  if (s.description !== undefined && typeof s.description !== "string") out.push(`${path}: description`);
  if (s.properties !== undefined) {
    if (!s.properties || typeof s.properties !== "object" || Array.isArray(s.properties)) out.push(`${path}: properties`);
    else for (const [name, sub] of Object.entries(s.properties)) out.push(...schemaProblems(sub, `${path}.${name}`));
  }
  if (s.required !== undefined && (!Array.isArray(s.required) || !s.required.every((r) => typeof r === "string" && Object.hasOwn((s.properties ?? {}) as object, r)))) {
    out.push(`${path}: required ${JSON.stringify(s.required)}`);
  }
  if (s.items !== undefined) out.push(...schemaProblems(s.items, `${path}[]`));
  if (s.type === "array" && s.items === undefined) out.push(`${path}: an array without items`);
  return out;
}

await check("every tool's parameters stay inside the schema subset: inline objects, primitive types, enum, array — no $ref, oneOf, anyOf, allOf or const", async () => {
  const problems = raftPlugin.tools.flatMap((t) => {
    const p = t.parameters as any;
    return [...(p?.type !== "object" ? [`${t.name}: not an object at the top`] : []), ...schemaProblems(p, t.name)];
  });
  if (problems.length) throw new Error(problems.join("; "));
  // Positive control: the walker sees each kind of keyword it refuses, at any depth.
  for (const bad of [{ $ref: "#/x" }, { oneOf: [] }, { anyOf: [] }, { allOf: [] }, { const: 1 }, { $defs: {} }, { type: ["string", "null"] }, { type: "null" }]) {
    const nested = { type: "object", properties: { a: { type: "array", items: { type: "object", properties: { b: bad } } } } };
    if (!schemaProblems(nested, "control").length) throw new Error(`the walker accepted ${JSON.stringify(bad)}`);
  }
});

await check("the manifest's declarations map onto the tool: side effect, model-only, idempotency, description and schema", async () => {
  for (const op of GENERATED) {
    const t = toolNamed(op.toolName)!;
    if (t.sideEffects !== op.sideEffect) throw new Error(`${op.name}: sideEffects ${t.sideEffects}`);
    if ((t.modelOnly === true) !== op.modelOnly) throw new Error(`${op.name}: modelOnly ${t.modelOnly}`);
    const want = { natural: "native", key: "key", none: "none" }[op.idempotency.kind];
    if (t.idempotency !== want) throw new Error(`${op.name}: idempotency ${t.idempotency}`);
    if (!t.summary.startsWith(op.description.slice(0, 12))) throw new Error(`${op.name}: description ${t.summary}`);
    const props = Object.keys((t.parameters as any).properties ?? {});
    if (JSON.stringify(props) !== JSON.stringify(Object.keys(op.inputSchema.properties ?? {}))) throw new Error(`${op.name}: parameters ${props.join()}`);
    if (JSON.stringify((t.parameters as any).required ?? null) !== JSON.stringify(op.inputSchema.required ?? null)) throw new Error(`${op.name}: required`);
  }
  // The decisions the manifest makes that a hand-written tool once made differently.
  if (toolNamed("tasks_create")?.idempotency !== "none" || toolNamed("actions_prepare")?.idempotency !== "none") throw new Error("tasks_create or actions_prepare repeats on its own");
  if (toolNamed("messages_send")?.idempotency !== "key" || toolNamed("messages_send")?.sideEffects !== "write") throw new Error("messages_send lost its key idempotency");
  const assign = toolNamed("tasks_assign")!.parameters as any;
  if (!assign.required.includes("assignee") || !toolNamed("tasks_unassign")) throw new Error("tasks_assign no longer requires assignee, or tasks_unassign is gone");
  // A dotted operation name in a description is written as the tool the model is offered.
  if (!/tasks_unassign/.test(toolNamed("tasks_assign")!.summary) || /tasks\.unassign/.test(toolNamed("tasks_assign")!.summary)) throw new Error(toolNamed("tasks_assign")!.summary);
  // Model-only and an unknown side effect, on the manifest's own model-only operation (excluded here, so not offered): carried and made a write.
  const pull = toolOf(opNamed("inbox.check"));
  if (pull.modelOnly !== true) throw new Error(`a model-only operation lost modelOnly when generated: ${JSON.stringify(pull)}`);
  if (toolOf({ ...opNamed("profile.show"), sideEffect: "sometimes" as never }).sideEffects !== "write") throw new Error("an unknown side effect became a read");
});

await check("a model-only operation is refused from a program twice: by the gateway on modelOnly, and by the SDK as MODEL_ONLY before any request", async () => {
  // The gateway layer: a mount offering a generated model-only operation, called from a run_js program.
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("tenant", "agent");
  await store.addMount({ tenantId: "tenant", agentId: "agent", alias: "inbox", plugin: "raft", installationId: "i", connectionId: null,
    toolVersion: raftPlugin.version, publicConfig: { serverUrl: "https://raft.example" }, secretRef: "secret:raft", policy: null });
  const withPull = { ...raftPlugin, mountTools: () => [...raftPlugin.tools, toolOf(opNamed("inbox.check"))] };
  const gateway = new ToolGateway(store, [withPull], new Set([raftPlugin.id]), { async resolve() { return "sk_agent_test_1234567890"; } });
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return json(200, {}); }) as any;
  const refused: any = await gateway.invoke({ tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "ctx_turn" } as any, "inbox.inbox_check", {}, { fromProgram: true });
  if (refused.status !== "rejected" || refused.error?.code !== "not_from_a_program") throw new Error(`gateway: ${JSON.stringify(refused)}`);
  // Control: the same call from the model gets past the gateway to the plugin (which offers no such operation of its own).
  const passed: any = await gateway.invoke({ tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "ctx_turn" } as any, "inbox.inbox_check", {});
  if (passed.error?.code === "not_from_a_program") throw new Error(`the model's call was refused too: ${JSON.stringify(passed)}`);
  // The SDK layer: under origin "code" a model-only operation fails with MODEL_ONLY and nothing is sent.
  const raft = createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_test_1234567890" });
  const out: any = await raft.invoke("inbox.check", {}, originOf({ caller: { tenantId: "t", agentId: "a", taskId: "k", fromProgram: true, contextId: "c" } } as any));
  if (out.ok || out.error?.code !== "MODEL_ONLY" || fetched !== 0) throw new Error(`SDK: ${JSON.stringify(out)} fetched=${fetched}`);
});

await check("the origin is the model's only for a call in its turn that no program made; everything else is code", async () => {
  const of = (caller: Record<string, unknown>) => originOf({ caller: { tenantId: "t", agentId: "a", taskId: "k", ...caller } } as any);
  const cases: Array<[Record<string, unknown>, unknown]> = [
    [{ contextId: "c1" }, { origin: "model", contextId: "c1" }],
    [{ fromProgram: true, contextId: "c1" }, { origin: "code", contextId: "c1" }],
    [{ fromProgram: true }, { origin: "code" }],
    [{}, { origin: "code" }],
  ];
  for (const [caller, want] of cases) {
    if (JSON.stringify(of(caller)) !== JSON.stringify(want)) throw new Error(`${JSON.stringify(caller)} → ${JSON.stringify(of(caller))}`);
  }
});

/** A Server answer of the shape the SDK validates for one operation's request. */
const HELD = () => json(200, { ok: true, state: "held", newMessageCount: 1, seenUpToSeq: 20, omittedMessageCount: 0, freshnessContextMode: "inline",
  heldMessages: [{ seq: 20, id: "abcdef12-0000", content: "wait, one more thing", sender_type: "human", sender_name: "tygg", channel_name: "general", channel_type: "channel", timestamp: "2026-09-28T10:00:00Z" }] });
const HELD_LINE = "[target=#general msg=abcdef12 time=2026-09-28 10:00:00Z type=human] @tygg: wait, one more thing";
// The Server's held envelope as it is sent today: the message, with no conversation fields of its own.
const HELD_BARE = (extra: Record<string, unknown> = {}) => json(200, { ok: true, state: "held", newMessageCount: 1, seenUpToSeq: 20, omittedMessageCount: 0,
  freshnessContextMode: "inline", heldMessages: [{ seq: 20, id: "abcdef12-0000", channelId: "c-1", content: "a DM body", sender_type: "agent", sender_name: "cody" }], ...extra });
const SENT = (n = 21) => json(200, { ok: true, state: "sent", messageId: `m-${n}`, messageSeq: n });

/** One message of `GET /internal/agent-api/history` as the Server sends it. */
function historyMessage(seq: number, content: string, extra: Record<string, unknown> = {}) {
  return {
    id: `m-${seq}cccccc`, seq, content, sender_type: "human", sender_name: "tygg", timestamp: "2026-09-28T10:00:00Z",
    channel_name: "wg-raft-sdk", channel_type: "channel", ...extra,
  };
}
function history(messages: unknown[], more: { has_older?: boolean; has_newer?: boolean; target?: string } = {}) {
  return json(200, {
    target: more.target ?? "#wg-raft-sdk", messages,
    has_more: Boolean(more.has_older || more.has_newer), has_older: more.has_older ?? false, has_newer: more.has_newer ?? false,
  });
}

await check("serverUrl rejects cleartext non-loopback origins before sending the credential", async () => {
  globalThis.fetch = (async () => { throw new Error("network reached"); }) as any;
  const why = await failure(() => raftPlugin.invoke("messages_send", {
    target: "#general", content: "hello", idempotencyKey: "stable-http-rejection",
  }, ctx("sk_agent_test_1234567890", { serverUrl: "http://raft.example" })));
  if (!/https/.test(why.message) || /network reached/.test(why.message)) throw why;
});

await check("messages_send uses the configured origin, keeps the credential host-side, and answers with the SDK's state and text only", async () => {
  const calls = one(json(200, { ok: true, state: "sent", messageId: "m-1", messageSeq: 7, serverExtra: "also hidden" }));
  const out = await raftPlugin.invoke("messages_send", { target: "#general", content: "hello", idempotencyKey: "stable-1" }, inTurn(ctx())) as any;
  if (JSON.stringify(out) !== JSON.stringify({ state: "sent", text: "Message sent to #general. Message ID: m-1" })) throw new Error(`unexpected projection: ${JSON.stringify(out)}`);
  if (calls.length !== 1 || !calls[0]!.url.startsWith("https://raft.example/internal/agent-api/") || !/\/send$/.test(calls[0]!.url)) {
    throw new Error(`wrong request: ${JSON.stringify(calls.map((c) => c.url))}`);
  }
  const headers = new Headers(calls[0]!.init.headers);
  if (headers.get("authorization") !== "Bearer sk_agent_test_1234567890") throw new Error("credential not attached");
  if (String(calls[0]!.init.body).includes("sk_agent_")) throw new Error("credential entered the JSON body");
  const body = JSON.parse(String(calls[0]!.init.body));
  if (body.idempotencyKey !== "stable-1" || body.target !== "#general" || body.content !== "hello") throw new Error(`wrong send body: ${JSON.stringify(body)}`);
  if (calls[0]!.init.redirect !== "manual") throw new Error(`fetch must use the Workers-compatible manual redirect guard: ${calls[0]!.init.redirect}`);
});

await check("an argument the manifest does not advertise never reaches the SDK: a caller cannot pass seen to skip the hold", async () => {
  // `seen` is a code-only knob the SDK accepts on a send: it overrides what the send attests. From the model it would
  // answer the hold's question for it. The control is a resume this plugin makes itself, which does pass it.
  const calls = many(HELD());
  const out = await raftPlugin.invoke("messages_send", { target: "#general", content: "x", idempotencyKey: "k-seen", seen: { upToSeq: 999 } }, inTurn(mount().ctx));
  const body = JSON.parse(String(calls[0]!.init.body));
  if (body.seenUpToSeq === 999 || "seen" in body || !(out instanceof Interrupt)) throw new Error(`the caller's seen went through: ${JSON.stringify(body)}`);
  const m = mount();
  const resumed = many(SENT());
  await raftPlugin.interrupts!.resume("messages_send", { op: "messages.send", args: { target: "#general", content: "x", idempotencyKey: "k-seen" }, seen: { upToSeq: 20 } }, "send", inTurn(m.ctx));
  if (JSON.parse(String(resumed[0]!.init.body)).seenUpToSeq !== 20) throw new Error(`control: the plugin's own resume did not attest: ${resumed[0]!.init.body}`);
});

await check("a held send is a question for the agent: send or drop, with the newer messages as lines, and nothing sent", async () => {
  const m = mount();
  const calls = many(HELD());
  const held = await raftPlugin.invoke("messages_send", { target: "#general", content: "done", idempotencyKey: "k-held" }, inTurn(m.ctx)) as any;
  if (!(held instanceof Interrupt)) throw new Error(`a held send must interrupt, got ${JSON.stringify(held)}`);
  if (!/newer message arrived in #general/.test(held.question) || JSON.stringify(held.answer) !== '{"choices":["send","drop"]}' ||
      (held.context as any)?.messages?.[0] !== HELD_LINE) {
    throw new Error(`the question: ${JSON.stringify(held)}`);
  }
  const st = held.state as any;
  if (st.op !== "messages.send" || st.args?.target !== "#general" || st.args?.content !== "done" || st.args?.idempotencyKey !== "k-held" || st.seen?.upToSeq !== 20) {
    throw new Error(`the state must carry the call and its continuation: ${JSON.stringify(st)}`);
  }
  if (calls.length !== 1) throw new Error(`only the held attempt reached Raft: ${calls.length}`);
});

await check("resume \"send\" sends the same message under the same key and attests what the question showed", async () => {
  const m = mount();
  const calls = many(HELD(), SENT());
  const held = await raftPlugin.invoke("messages_send", { target: "#general", content: "done", idempotencyKey: "k-held" }, inTurn(m.ctx)) as any;
  const sent = await raftPlugin.interrupts!.resume("messages_send", held.state, "send", inTurn(m.ctx)) as any;
  const second = JSON.parse(String(calls[1]!.init.body));
  if (sent.state !== "sent" || second.seenUpToSeq !== 20 || second.idempotencyKey !== "k-held" || second.content !== "done") {
    throw new Error(`the resumed send did not attest what the model saw: ${JSON.stringify({ sent, second })}`);
  }
});

await check("a send with no key is held under the key the SDK made, and resume sends under that same key", async () => {
  const m = mount();
  const calls = many(HELD(), SENT());
  const held = await raftPlugin.invoke("messages_send", { target: "#general", content: "done" }, inTurn(m.ctx)) as any;
  const made = JSON.parse(String(calls[0]!.init.body)).idempotencyKey;
  if (typeof made !== "string" || (held.state as any).args?.idempotencyKey !== made) throw new Error(`state: ${JSON.stringify(held.state)} made=${made}`);
  await raftPlugin.interrupts!.resume("messages_send", held.state, "send", inTurn(m.ctx));
  if (JSON.parse(String(calls[1]!.init.body)).idempotencyKey !== made) throw new Error(`the resume used another key: ${calls[1]!.init.body}`);
});

await check("resume \"send\" into a conversation that moved again asks again, with the newer messages", async () => {
  const m = mount();
  many(HELD(), HELD());
  const held = await raftPlugin.invoke("messages_send", { target: "#general", content: "done", idempotencyKey: "k-held" }, inTurn(m.ctx)) as any;
  const again = await raftPlugin.interrupts!.resume("messages_send", held.state, "send", inTurn(m.ctx)) as any;
  if (!(again instanceof Interrupt) || (again.state as any).args?.idempotencyKey !== "k-held") throw new Error(`a second hold must ask again: ${JSON.stringify(again)}`);
});

await check("a held message with no conversation fields of its own is shown under the send's target, and attested", async () => {
  const m = mount();
  const calls = many(HELD_BARE(), SENT());
  const held = await raftPlugin.invoke("messages_send", { target: "dm:@cody", content: "done", idempotencyKey: "k-b" }, inTurn(m.ctx)) as any;
  const lines = (held.context as any)?.messages ?? [];
  if (!(held instanceof Interrupt) || lines.length !== 1 || !/a DM body/.test(lines[0]) || !/send your message anyway/.test(held.question) ||
      (held.state as any).seen?.upToSeq !== 20) {
    throw new Error(`the held message was not shown, or not attested: ${JSON.stringify(held)}`);
  }
  await raftPlugin.interrupts!.resume("messages_send", held.state, "send", inTurn(m.ctx));
  if (JSON.parse(String(calls[1]!.init.body)).seenUpToSeq !== 20) throw new Error("the resend did not attest what was shown");
});

for (const [why, extra] of [
  ["whose messages are not all shown", { newMessageCount: 2 }],
  ["that came without a boundary", { seenUpToSeq: undefined }],
] as const) {
  await check(`a held send ${why} attests nothing and tells the agent to read the conversation first`, async () => {
    const m = mount();
    const calls = many(HELD_BARE(extra), HELD_BARE(extra));
    const held = await raftPlugin.invoke("messages_send", { target: "dm:@cody", content: "done", idempotencyKey: "k-u" }, inTurn(m.ctx)) as any;
    if (!(held instanceof Interrupt) || !/read dm:@cody with messages_read first/.test(held.question) || (held.state as any).seen !== undefined) {
      throw new Error(`an unattestable hold was treated as seen: ${JSON.stringify(held)}`);
    }
    await raftPlugin.interrupts!.resume("messages_send", held.state, "send", inTurn(m.ctx));
    const second = JSON.parse(String(calls[1]!.init.body));
    if (second.seenUpToSeq !== undefined) throw new Error(`the resend attested what was not shown: ${JSON.stringify(second)}`);
  });
}

await check("drop sends nothing, and the plugin declares no cancel: an in-process held call leaves nothing to clear", async () => {
  const m = mount();
  one(HELD());
  const held = await raftPlugin.invoke("messages_send", { target: "#general", content: "done", idempotencyKey: "k-cancel" }, inTurn(m.ctx)) as any;
  if (!(held instanceof Interrupt)) throw new Error(`not held: ${JSON.stringify(held)}`);
  let sent = 0;
  globalThis.fetch = (async () => { sent++; return json(200, {}); }) as any;
  const dropped = await raftPlugin.interrupts!.resume("messages_send", held.state, "drop", inTurn(m.ctx)) as any;
  if (dropped.state !== "dropped" || !/new idempotencyKey/.test(dropped.note)) throw new Error(JSON.stringify(dropped));
  if (raftPlugin.interrupts!.cancel !== undefined) throw new Error("the plugin grew a cancel; this case no longer says what it does");
  if (sent !== 0) throw new Error(`drop reached Raft ${sent} time(s)`);
  const why = await failure(() => raftPlugin.interrupts!.resume("messages_send", held.state, "maybe", inTurn(m.ctx)));
  if (!/must be "send" or "drop"/.test(why.message) || sent !== 0) throw why;
  const notAsking = await failure(() => raftPlugin.interrupts!.resume("messages_read", held.state, "send", inTurn(m.ctx)));
  if (!/does not ask questions/.test(notAsking.message)) throw notAsking;
});

await check("the held call's key and the CLI's argv never reach the model: not in the question, its context, or what resume and drop return", async () => {
  // The key is distinctive so its presence in the SDK's interrupt is a positive control for the absence below.
  const KEY = "k-argv-sentinel-5e1d";
  const CLI = ["--send-draft", "--discard-draft", "--expected-draft-key", "raft message", "raft task", KEY];
  one(HELD());
  const raw = await createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_test_1234567890" })
    .messages.send({ target: "#general", content: "done", idempotencyKey: KEY });
  if (!isInterrupted(raw) || raw.interrupt.resume.idempotencyKey !== KEY || raw.interrupt.resume.argv !== undefined || raw.interrupt.cancel !== undefined) {
    throw new Error(`control: the SDK's interrupt: ${JSON.stringify(raw)}`);
  }
  // A held task claim carries the CLI's argv in its resume: the control that the check below can see one.
  one(HELD());
  const claimRaw = await createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_test_1234567890" }).tasks.claim({ target: "#general", taskNumbers: [7] });
  const argv = isInterrupted(claimRaw) ? claimRaw.interrupt.resume.argv ?? [] : [];
  if (!argv.includes("claim") || !argv.includes("--number")) throw new Error(`control: the claim's interrupt: ${JSON.stringify(claimRaw)}`);
  // The argv's flags and the command it spells, as the model would be shown them.
  CLI.push(...argv.filter((a) => a.startsWith("--")), argv.join(" "));
  const shown: Array<[string, unknown]> = [];
  for (const [tool, args, go] of [
    ["messages_send", { target: "#general", content: "done", idempotencyKey: KEY }, "send"],
    ["tasks_claim", { target: "#general", taskNumbers: [7] }, "proceed"],
  ] as const) {
    const m = mount();
    one(HELD());
    const held = await raftPlugin.invoke(tool, args, inTurn(m.ctx)) as any;
    if (!(held instanceof Interrupt)) throw new Error(`${tool} not held: ${JSON.stringify(held)}`);
    // What run_js and resume show the model of a question: question, context and answer (the state stays host-side).
    shown.push([`${tool}'s question`, { question: held.question, context: held.context, answer: held.answer }]);
    one(go === "send" ? SENT() : json(200, { results: [{ taskNumber: 7, success: true }] }));
    shown.push([`${tool} resumed`, await raftPlugin.interrupts!.resume(tool, held.state, go, inTurn(m.ctx))]);
    shown.push([`${tool} dropped`, await raftPlugin.interrupts!.resume(tool, held.state, "drop", inTurn(m.ctx))]);
  }
  for (const [where, value] of shown) {
    const text = JSON.stringify(value);
    const leaked = CLI.filter((piece) => text.includes(piece));
    if (leaked.length) throw new Error(`${where} carries ${leaked.join(", ")}: ${text}`);
  }
});

await check("the held send's question is the plugin's own: the SDK's held text, which names a CLI command, is not in it", async () => {
  // The SDK's `interrupt.context` (and the outcome's `text`) is the CLI's held text: it ends "Full text: raft message
  // read --target …", a command this mount has no tool for. 7341 formal @mentions is a fact only that text states,
  // so it is the sentinel: present there, and absent from what the model is shown.
  const SENTINEL = "Note: 7341 of these messages formally @mention you.";
  const held = () => json(200, { ok: true, state: "held", newMessageCount: 1, seenUpToSeq: 20, omittedMessageCount: 0, freshnessContextMode: "inline",
    mentionAnnotation: { formalMentionCount: 7341 },
    heldMessages: [{ seq: 20, id: "abcdef12-0000", content: "wait, one more thing", sender_type: "human", sender_name: "tygg", channel_name: "general", channel_type: "channel", timestamp: "2026-09-28T10:00:00Z" }] });
  one(held());
  const raw = await createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_test_1234567890" })
    .messages.send({ target: "#general", content: "done", idempotencyKey: "k-context" });
  if (!isInterrupted(raw) || !raw.interrupt.context.includes(SENTINEL) || !raw.text.includes(SENTINEL) || !raw.interrupt.context.includes("raft message read")) {
    throw new Error(`control: the SDK's held text: ${JSON.stringify(raw)}`);
  }
  const m = mount();
  one(held());
  const asked = await raftPlugin.invoke("messages_send", { target: "#general", content: "done", idempotencyKey: "k-context" }, inTurn(m.ctx)) as any;
  if (!(asked instanceof Interrupt)) throw new Error(`not held: ${JSON.stringify(asked)}`);
  const shown = JSON.stringify({ question: asked.question, context: asked.context, answer: asked.answer });
  for (const piece of [SENTINEL, "raft message read", raw.interrupt.context, raw.text]) {
    if (shown.includes(JSON.stringify(piece).slice(1, -1))) throw new Error(`the question carries ${JSON.stringify(piece.slice(0, 60))}: ${shown}`);
  }
});

await check("a held task claim asks proceed or drop, and proceed makes the identical claim again", async () => {
  const m = mount();
  const calls = many(HELD(), json(200, { results: [{ taskNumber: 7, success: true }] }));
  const held = await raftPlugin.invoke("tasks_claim", { target: "#general", taskNumbers: [7] }, inTurn(m.ctx)) as any;
  if (!(held instanceof Interrupt) || JSON.stringify(held.answer) !== '{"choices":["proceed","drop"]}' || !/go ahead with tasks_claim anyway/.test(held.question)) {
    throw new Error(`the question: ${JSON.stringify(held)}`);
  }
  if ("idempotencyKey" in ((held.state as any).args ?? {}) || "seen" in (held.state as any)) throw new Error(`a claim carries a send's continuation: ${JSON.stringify(held.state)}`);
  const out = await raftPlugin.interrupts!.resume("tasks_claim", held.state, "proceed", inTurn(m.ctx)) as any;
  if (calls.length !== 2 || calls[1]!.init.body !== calls[0]!.init.body || out.state !== "claimed") throw new Error(`resume: ${JSON.stringify({ out, bodies: calls.map((c) => c.init.body) })}`);
  const dropped = await raftPlugin.interrupts!.resume("tasks_claim", held.state, "drop", inTurn(m.ctx)) as any;
  if (dropped.state !== "dropped" || !/Nothing was done/.test(dropped.note)) throw new Error(JSON.stringify(dropped));
});

await check("a send held under the old send_message tool, still waiting across the change, resumes and drops as before", async () => {
  // The state the hand-written send_message recorded: the send plus its continuation ({ idempotencyKey, seen? }).
  const old = { target: "#general", content: "done", idempotencyKey: "k-032", seen: { upToSeq: 20 } };
  const m = mount();
  const calls = many(json(200, { ok: true, state: "sent", messageId: "m-032", messageSeq: 21 }));
  const sent = await raftPlugin.interrupts!.resume("send_message", old, "send", m.ctx) as any;
  const body = JSON.parse(String(calls[0]!.init.body));
  if (sent.state !== "sent" || body.idempotencyKey !== "k-032" || body.seenUpToSeq !== 20 || body.content !== "done" || body.target !== "#general") {
    throw new Error(`resumed: ${JSON.stringify({ sent, body })}`);
  }
  const { seen: _seen, ...withoutSeen } = old;
  const plain = many(json(200, { ok: true, state: "sent", messageId: "m-033", messageSeq: 22 }));
  await raftPlugin.interrupts!.resume("send_message", withoutSeen, "send", m.ctx);
  if (JSON.parse(String(plain[0]!.init.body)).idempotencyKey !== "k-032") throw new Error(`no-seen resume: ${plain[0]!.init.body}`);
  // Held again on resume, it asks again under the old tool, so the next answer comes back here too; its key stays host-side.
  one(HELD());
  const again = await raftPlugin.interrupts!.resume("send_message", old, "send", m.ctx) as any;
  if (!(again instanceof Interrupt) || (again.state as any).idempotencyKey !== "k-032" || JSON.stringify({ q: again.question, c: again.context }).includes("k-032")) {
    throw new Error(`held again: ${JSON.stringify(again)}`);
  }
  globalThis.fetch = (async () => { throw new Error("network reached on drop"); }) as any;
  const dropped = await raftPlugin.interrupts!.resume("send_message", old, "drop", m.ctx) as any;
  if (dropped.state !== "dropped" || !/messages_send/.test(dropped.note)) throw new Error(JSON.stringify(dropped));
  const bad = await failure(() => raftPlugin.interrupts!.resume("send_message", old, "maybe", m.ctx));
  if (!/must be "send" or "drop"/.test(bad.message)) throw bad;
});

await check("a Server conflict on a send is an ordinary refusal: not retryable, nothing landed", async () => {
  one(json(409, { errorCode: "conflict", message: "conflict" }));
  const why = await failure(() => raftPlugin.invoke("messages_send", { target: "#general", content: "x", idempotencyKey: "k-conflict" }, inTurn(ctx())));
  if (why.retryable !== false || why.transient !== false || why.mayHaveLanded === true) {
    throw new Error(`marks: retryable=${why.retryable} transient=${why.transient} mayHaveLanded=${why.mayHaveLanded} ${why.message}`);
  }
});

await check("the same send again with the same key, outside resume, still attests the held messages and goes through", async () => {
  const m = mount();
  const calls = many(HELD(), SENT());
  await raftPlugin.invoke("messages_send", { target: "#general", content: "done", idempotencyKey: "k-held" }, inTurn(m.ctx));
  const sent = await raftPlugin.invoke("messages_send", { target: "#general", content: "done", idempotencyKey: "k-held" }, inTurn(m.ctx)) as any;
  const second = JSON.parse(String(calls[1]!.init.body));
  if (sent.state !== "sent" || second.seenUpToSeq !== 20 || second.idempotencyKey !== "k-held") {
    throw new Error(`the resend did not attest what the model saw: ${JSON.stringify({ sent, second })}`);
  }
});

/** A /events answer in the shape the Raft SDK validates. */
function events(evs: unknown[], over: Record<string, unknown> = {}) {
  return json(200, { events: evs, last_seen_msgId: null, last_seen_seq: null, reply_target: null, has_more: false, ack_mode: "cursor", ...over });
}

await check("a pull acknowledges nothing on its own: the next pull carries the cursor, and messages reach the model as the CLI's lines", async () => {
  const m = mount();
  const calls = many(
    events([{
      id: "m-2aaaaaa", seq: 9, content: "hi", sender_type: "human", sender_name: "tygg", timestamp: "2026-09-28T10:00:00Z",
      channel_name: "wg-raft-sdk", channel_type: "channel", internalSecret: "hidden",
    }], { last_seen_seq: 9, last_seen_msgId: "m-2aaaaaa", reply_target: "#wg-raft-sdk", pending_notice_ids: ["hidden"], wake_reason: "hidden" }),
    events([]),
  );
  const out = await raftPlugin.invoke("receive_events", { limit: 4 }, m.ctx) as any;
  const first = new URL(calls[0]!.url);
  if (first.pathname !== "/internal/agent-api/events" || first.searchParams.get("ack") !== "cursor" || /^\d+$/.test(first.searchParams.get("since") ?? "")) {
    throw new Error(`the first pull: ${calls[0]!.url}`);
  }
  if (JSON.stringify(out.messages) !== JSON.stringify(["[target=#wg-raft-sdk msg=m-2aaaaa time=2026-09-28 10:00:00Z type=human] @tygg: hi"]) ||
      out.hasMore !== false || out.replyTarget !== "#wg-raft-sdk") {
    throw new Error(`projection: ${JSON.stringify(out)}`);
  }
  if (/internalSecret|pending_notice_ids|wake_reason|hidden/.test(JSON.stringify(out))) throw new Error(`unprojected data: ${JSON.stringify(out)}`);
  await raftPlugin.invoke("receive_events", {}, m.ctx);
  const second = new URL(calls[1]!.url);
  if (second.searchParams.get("since") !== "9" || second.searchParams.get("ack") !== "cursor") {
    throw new Error(`the next pull did not acknowledge the batch the model was handed: ${calls[1]!.url}`);
  }
});

await check("a message line never points at a CLI command this mount lacks, and a left-out body says it was left out", async () => {
  const m = mount();
  one(events([
    { id: "m-6aaaaaa", seq: 1, content: "see file", sender_type: "human", sender_name: "t", channel_name: "g", channel_type: "channel",
      attachments: [{ id: "att-1", filename: "plan.pdf" }] },
    { id: "m-7aaaaaa", seq: 2, content: "", truncated: true, sender_type: "human", sender_name: "t", channel_name: "g", channel_type: "channel" },
  ], { last_seen_seq: 2 }));
  const out = await raftPlugin.invoke("receive_events", {}, m.ctx) as any;
  const [withFile, cut] = out.messages as string[];
  if (/raft attachment view/.test(withFile!) || !/1 attachment: plan\.pdf — this mount has no tool to open attachments\]$/.test(withFile!)) {
    throw new Error(`attachment line: ${withFile}`);
  }
  if (!/content left out by Raft: too large/.test(cut!)) throw new Error(`a left-out body read as an empty message: ${cut}`);
  // An attachment on a task: the CLI puts the task suffix after the attachment's, so the attachment's is
  // not last. It must be replaced where it stands, once, with nothing of the CLI's left.
  const t = mount();
  one(events([
    { id: "m-8aaaaaa", seq: 3, content: "hi", sender_type: "human", sender_name: "t", channel_name: "g", channel_type: "channel",
      attachments: [{ id: "a1", filename: "f.png" }], task_number: 7, task_status: "todo" },
  ], { last_seen_seq: 3 }));
  const [onTask] = ((await raftPlugin.invoke("receive_events", {}, t.ctx)) as any).messages as string[];
  if (/raft attachment view/.test(onTask!) || (onTask!.match(/attachment/g) ?? []).length !== 2 ||
      !/@t: hi \[1 attachment: f\.png — this mount has no tool to open attachments\] \[task #7/.test(onTask!)) {
    throw new Error(`attachment on a task: ${onTask}`);
  }
});

await check("a version-2 mount's cursor and frontier become the SDK's state: the next pull acknowledges exactly that batch, and the old keys are gone", async () => {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "tenant", agentId: "agent", alias: "raft", plugin: raftPlugin.id };
  tables.setVersion(scope, 2);
  tables.put(scope, "inbox", "cursor", 41, null);
  tables.put(scope, "inbox", "frontier", { version: 1, targets: { "#general": { upTo: 30 } }, aliases: {} }, null);
  const db = openPluginDatabase(tables, scope, raftPlugin.database);
  const calls = one(events([]));
  await raftPlugin.invoke("receive_events", {}, { ...ctx(), db });
  const since = new URL(calls[0]!.url).searchParams.get("since");
  if (since !== "41") throw new Error(`the carried-over batch was not the one acknowledged: since=${since}`);
  const st = tables.get(scope, "inbox", "state") as any;
  if (tables.version(scope) !== 3 || st?.schema !== "raft-sdk-state.v1" || st.frontier?.targets?.["#general"]?.upTo !== 30) {
    throw new Error(`upgrade: version ${tables.version(scope)}, state ${JSON.stringify(st)}`);
  }
  if (tables.get(scope, "inbox", "cursor") !== undefined || tables.get(scope, "inbox", "frontier") !== undefined) throw new Error("version-2 keys survived");
});

await check("actions_prepare posts the card the manifest describes, as a write that never repeats on its own", async () => {
  const calls = one(json(200, { messageId: "abcdef12-3456", metadata: { kind: "action-card" } }));
  const out = await raftPlugin.invoke("actions_prepare", {
    target: "#general", action: { type: "channel:create", name: "launch-room", draftHint: "for Thursday's launch" },
  }, inTurn(ctx())) as any;
  if (out.state === undefined || !/Action card posted to #general/.test(out.text)) throw new Error(JSON.stringify(out));
  const body = JSON.parse(String(calls[0]!.init.body));
  if (!/\/internal\/agent-api\/prepare-action$/.test(calls[0]!.url) || body.target !== "#general" || body.action?.type !== "channel:create" ||
      body.action.name !== "launch-room" || body.action.draftHint !== "for Thursday's launch") {
    throw new Error(`request: ${calls[0]!.url} ${JSON.stringify(body)}`);
  }
  // A card Raft's contract refuses (a name too long) is refused by the SDK before sending, and landed nothing.
  let sent = 0;
  globalThis.fetch = (async () => { sent++; return json(200, {}); }) as any;
  const tooLong = await failure(() => raftPlugin.invoke("actions_prepare", { target: "#general", action: { type: "channel:create", name: "x".repeat(121) } }, inTurn(ctx())));
  if (sent !== 0 || tooLong.mayHaveLanded === true || !/Invalid request/.test(tooLong.message)) throw new Error(`contract refusal: sent=${sent} ${tooLong.message}`);
  // An integration card needs ids a model cannot know: refused before anything is sent, and the description says so.
  for (const type of ["integration:register_app", "integration:approve_agent_login", undefined]) {
    const why = await failure(() => raftPlugin.invoke("actions_prepare", { target: "#general", action: { type, name: "x", returnUrl: "https://x" } }, inTurn(ctx())));
    if (sent !== 0 || !/action\.type must be channel:create, channel:add_member or agent:create: the integration cards take ids/.test(why.message)) throw new Error(`${type}: sent=${sent} ${why.message}`);
  }
  if (!/Only channel:create, channel:add_member and agent:create cards can be prepared here/.test(toolNamed("actions_prepare")!.summary)) throw new Error(toolNamed("actions_prepare")!.summary);
  // Control: the three a model may prepare all reach Raft.
  for (const type of ["channel:create", "channel:add_member", "agent:create"]) {
    one(json(200, { messageId: "abcdef12-3456", metadata: { kind: "action-card" } }));
    const action = type === "channel:add_member" ? { type, channel: "#general", humans: ["tygg"] } : { type, name: "launch-room" };
    await raftPlugin.invoke("actions_prepare", { target: "#general", action }, inTurn(ctx()));
  }
});

await check("a truncated pull says so in words, and a complete one carries no such note", async () => {
  const m = mount();
  const calls = one(events([{ message_id: "m-9aaaaaa", seq: 12, content: "x", sender_type: "human", sender_name: "t", timestamp: "2026-09-28T10:00:00.000Z", channel_name: "g", channel_type: "channel" }], { last_seen_seq: 12, has_more: true }));
  const out = await raftPlugin.invoke("receive_events", { limit: 10 }, m.ctx) as any;
  if (out.hasMore !== true || !/call receive_events again until hasMore is false/.test(out.note) || calls.length !== 1) throw new Error(JSON.stringify(out));
  one(events([], { last_seen_seq: 12 }));
  const done = await raftPlugin.invoke("receive_events", {}, m.ctx) as any;
  if (done.hasMore !== false || "note" in done) throw new Error(JSON.stringify(done));
});

await check("a failed pull loses nothing: the cursor stays, and the next pull asks for the same batch again", async () => {
  const m = mount();
  const calls = many(events([{ id: "m-3aaaaaa", seq: 5, content: "x", sender_type: "human", sender_name: "t", channel_name: "g", channel_type: "channel" }], { last_seen_seq: 5 }));
  await raftPlugin.invoke("receive_events", {}, m.ctx);
  let attempts = 0;
  const seen: string[] = [];
  globalThis.fetch = (async (url: any) => { attempts++; seen.push(String(url)); throw new Error("socket closed"); }) as any;
  const why = await failure(() => raftPlugin.invoke("receive_events", {}, m.ctx));
  if (attempts !== 1) throw new Error(`receive made ${attempts} attempts`);
  if (why.mayHaveLanded === true) throw new Error("a pull under cursor acks was reported as possibly consuming messages");
  if (/socket closed/.test(why.message)) throw new Error(`the transport cause leaked: ${why.message}`);
  const again = one(events([]));
  await raftPlugin.invoke("receive_events", {}, m.ctx);
  if (new URL(seen[0]!).searchParams.get("since") !== "5" || new URL(again[0]!.url).searchParams.get("since") !== "5") {
    throw new Error(`the failed pull moved the cursor: ${JSON.stringify({ failed: seen[0], next: again[0]!.url })}`);
  }
  if (calls.length !== 1) throw new Error("the first pull made more than one request");
});

await check("receive rejects an invalid response without exposing its body, and keeps the cursor", async () => {
  const m = mount();
  one(json(200, { events: "wrong", secret: "body-secret" }));
  const why = await failure(() => raftPlugin.invoke("receive_events", {}, m.ctx));
  if (/body-secret/.test(why.message)) throw why;
  const st = (await m.ctx.db.get("inbox", "state")) as any;
  if (st?.pendingCursor != null || st?.cursor != null) throw new Error(`an invalid answer set a cursor: ${JSON.stringify(st)}`);
});

await check("receive HTTP and non-JSON failures do not leak bodies", async () => {
  for (const response of [
    json(500, { message: "private upstream detail" }),
    new Response("private proxy page", { status: 502, headers: { "content-type": "text/html" } }),
  ]) {
    one(response);
    const why = await failure(() => raftPlugin.invoke("receive_events", {}, mount().ctx));
    if (/private upstream detail|private proxy page/.test(why.message)) throw new Error(`body leaked: ${why.message}`);
    if (why.mayHaveLanded === true) throw new Error(`a failed pull was reported as possibly consuming messages: ${why.message}`);
  }
});

await check("a Server that still acknowledges on read is named in the result, and no cursor is kept for it", async () => {
  const m = mount();
  one(events([{ id: "m-4aaaaaa", seq: 3, content: "x", sender_type: "human", sender_name: "t", channel_name: "g", channel_type: "channel" }], { last_seen_seq: 3, ack_mode: "immediate" }));
  const out = await raftPlugin.invoke("receive_events", {}, m.ctx) as any;
  if (out.acknowledged !== "on this read") throw new Error(JSON.stringify(out));
  // What matters is what the next pull sends: the batch was acknowledged on read, so no cursor may make it look pending.
  const next = one(events([]));
  await raftPlugin.invoke("receive_events", {}, m.ctx);
  const since = new URL(next[0]!.url).searchParams.get("since");
  if (since !== null && since !== "latest" && Number(since) < 3) throw new Error(`the pull after an on-read batch sent since=${since}`);
});

await check("the gateway records a failed pull as failed, not unknown: under cursor acks nothing was consumed", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("tenant", "agent");
  await store.addMount({
    tenantId: "tenant", agentId: "agent", alias: "raft", plugin: "raft",
    installationId: "raft-test", connectionId: null, toolVersion: raftPlugin.version,
    publicConfig: { serverUrl: "https://raft.example" }, secretRef: "secret:raft", policy: null,
  });
  const gateway = new ToolGateway(
    store,
    [raftPlugin], new Set([raftPlugin.id]),
    { async resolve() { return "sk_agent_test_1234567890"; } },
  );
  const invoke = () => gateway.invoke(
    { tenantId: "tenant", agentId: "agent", taskId: "task" },
    "raft.receive_events",
    {},
  );
  const cases: Array<[string, () => void]> = [
    ["transport", () => {
      globalThis.fetch = (async () => { throw new Error("private socket detail"); }) as any;
    }],
    ["HTTP JSON", () => { one(json(500, { message: "private upstream detail" })); }],
    ["HTTP non-JSON", () => {
      one(new Response("private proxy page", { status: 200, headers: { "content-type": "text/html" } }));
    }],
    ["invalid success", () => { one(json(200, { events: "wrong", secret: "body-secret" })); }],
  ];
  for (const [name, arrange] of cases) {
    arrange();
    const out = await invoke();
    if (out.status !== "failed") throw new Error(`${name} persisted as ${out.status}: ${JSON.stringify(out)}`);
    const message = out.error?.message ?? "";
    if (/private socket detail|private upstream detail|private proxy page|body-secret/.test(message)) {
      throw new Error(`${name} leaked: ${message}`);
    }
  }
});

/**
 * Raft mounted under an alias that is not the plugin's id, behind a real gateway, and the host the runtime gives
 * run_js (cf/src/runtime.ts `dispatch`): the program's options go to the gateway as they are.
 */
async function raftBehindGateway(policy: unknown = null) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("tenant", "agent");
  await store.addMount({
    tenantId: "tenant", agentId: "agent", alias: "inbox", plugin: "raft",
    installationId: "raft-test", connectionId: null, toolVersion: raftPlugin.version,
    publicConfig: { serverUrl: "https://raft.example" }, secretRef: "secret:raft", policy: policy as any,
  });
  const gateway = new ToolGateway(store, [raftPlugin], new Set([raftPlugin.id]), { async resolve() { return "sk_agent_test_1234567890"; } });
  const ctx = { tenantId: "tenant", agentId: "agent", taskId: "task" };
  // The runtime's host makes every call in the session's turn, so each carries the turn's context id (`inTurn`).
  const inTurn = { ...ctx, contextId: "ctx_turn" };
  const host = {
    seen: [] as any[],
    async invoke(call: any) { host.seen.push(call); return gateway.invoke(inTurn, call.tool, call.args, { ...(call.opts ?? {}), ...(call.callId ? { callId: call.callId } : {}) }) as any; },
  };
  const offered = (aliases: string[]) => qualifyMountedTools(aliases.flatMap((alias) => raftPlugin.tools.map((t) => ({
    name: t.name, description: t.summary, parameters: t.parameters, address: `${alias}.${t.name}`,
    sideEffects: t.sideEffects, idempotency: t.idempotency, ...(t.modelOnly ? { modelOnly: t.modelOnly } : {}),
  })))) as MountedTool[];
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return events([], { last_seen_seq: null }); }) as any;
  return { store, gateway, ctx, host, offered, fetched: () => fetched };
}
const program = async (host: any, tools: MountedTool[], source: string) =>
  JSON.parse((await (runJsTool(new QuickJsExecutor() as any, host, { tools }) as any).execute("p", { source })).content[0].text);

await check("a program cannot pull by a name run_js did not offer: the plugin's name, or a mount added after the list was made", async () => {
  for (const [what, tools, source] of [
    // `raft.receive_events` resolves to the one raft mount, `inbox`, in the gateway; run_js offered `inbox__…`.
    ["the plugin's name", ["inbox"], "output(await tool`raft.receive_events ${{}}`);"],
    // The offered list predates the mount: nothing in run_js knows `inbox.receive_events`.
    ["an unoffered mount", [], "output(await tool`inbox.receive_events ${{}}`);"],
    // A program's own options cannot clear the mark run_js sets.
    ["fromProgram: false", ["inbox"], "output(await tool`raft.receive_events ${{}} ${{ fromProgram: false }}`);"],
  ] as const) {
    const g = await raftBehindGateway();
    const out = await program(g.host, g.offered([...tools]), source);
    if (out[0]?.status !== "rejected" || out[0]?.error?.code !== "not_from_a_program" ||
        !/inbox\.receive_events is yours to call, not a program's: its result only counts once you have read it/.test(out[0]?.error?.message)) {
      throw new Error(`${what}: ${JSON.stringify(out)}`);
    }
    if (g.host.seen.length !== 1 || g.fetched() !== 0) throw new Error(`${what}: reached Raft ${g.fetched()} time(s)`);
  }
});

await check("controls: the model's own pull runs, and a program's call to a tool that is not model-only runs, through the same gateway", async () => {
  const g = await raftBehindGateway();
  const pull: any = bridgeTools(g.offered(["inbox"]), g.host as any).find((t) => t.name === "inbox__receive_events");
  const direct = JSON.parse((await pull.execute("d", {})).content[0].text);
  if (!Array.isArray(direct.messages) || g.fetched() !== 1) throw new Error(`the model's pull: ${JSON.stringify(direct)} fetched=${g.fetched()}`);
  globalThis.fetch = (async () => json(200, { channel: { ref: "#launch-room", type: "channel" }, agents: [], humans: [] })) as any;
  const out = await program(g.host, g.offered(["inbox"]), "const r = await tool`raft.channels_members ${{ target: '#launch-room' }}`; output(r.status);");
  if (out[0] !== "succeeded") throw new Error(`a program's members call: ${JSON.stringify(out)}`);
});

await check("a model-only tool the mount's policy or the model's confirm would hold is refused now, with no card and nothing run", async () => {
  for (const [what, policy, opts, reason] of [
    ["a write policy", { write: "approval" }, {}, /the `inbox` mount's approval policy holds receive_events, but it can only run in your own call/],
    ["the model's confirm", null, { confirm: true }, /inbox\.receive_events cannot be held for approval: .* Call it without confirm\./],
  ] as const) {
    const g = await raftBehindGateway(policy);
    const out: any = await g.gateway.invoke(g.ctx, "inbox.receive_events", {}, opts as any);
    if (out.status !== "rejected" || out.error?.code !== "not_from_a_program" || !reason.test(out.error?.message)) throw new Error(`${what}: ${JSON.stringify(out)}`);
    if ((await g.store.listApprovals("tenant", "pending")).length !== 0 || g.fetched() !== 0) throw new Error(`${what}: a card was made or Raft reached`);
  }
  // Control: under the same write policy, an ordinary write is held for a person as before.
  const g = await raftBehindGateway({ write: "approval" });
  const join: any = await g.gateway.invoke(g.ctx, "inbox.channels_join", { target: "#launch-room" });
  if (join.status !== "pending" || (await g.store.listApprovals("tenant", "pending")).length !== 1) throw new Error(`join: ${JSON.stringify(join)}`);
});

/** The Server's overview as `GET /internal/agent-api/server` answers it: the SDK pages its channels itself. */
function server(channels: unknown[]) {
  return json(200, {
    runtimeContext: { agentId: "agent-1", serverId: "server-1" }, channels,
    agents: [{ name: "other-agent", status: "online" }], humans: [{ name: "tygg", role: "owner" }],
  });
}

await check("channels_join resolves a visible channel through the server, then joins it", async () => {
  const seen: string[] = [];
  let n = 0;
  globalThis.fetch = (async (url: any) => {
    seen.push(String(url));
    return n++ === 0 ? server([{ id: "c-9", name: "engineering", joined: false, type: "channel" }]) : json(200, { ok: true });
  }) as any;
  const out = await raftPlugin.invoke("channels_join", { target: "#engineering" }, inTurn(ctx())) as any;
  if (typeof out.text !== "string" || seen.length !== 2 || !/\/channels\/c-9\/join$/.test(seen[1]!)) throw new Error(JSON.stringify({ out, seen }));
});

await check("channels_members lists agents and humans with their role labels, asking for the channel named", async () => {
  const calls = one(json(200, {
    channel: { ref: "#launch-room", type: "channel" },
    agents: [{ name: "piper", status: "online" }],
    humans: [{ name: "tygg", role: "owner", description: "runs it" }, { name: "bo", role: "member" }],
  }));
  const out = await raftPlugin.invoke("channels_members", { target: "#launch-room" }, inTurn(ctx())) as any;
  if (!/@piper \(online\)/.test(out.text) || !/@tygg \(owner\) — runs it/.test(out.text)) throw new Error(out.text);
  if (calls[0]!.url !== "https://raft.example/internal/agent-api/channel-members?channel=%23launch-room") throw new Error(`request: ${calls[0]!.url}`);
  // Raft's refusal of a read landed nothing.
  one(json(404, { error: "channel not found", code: "NOT_FOUND" }));
  const why = await failure(() => raftPlugin.invoke("channels_members", { target: "#nowhere" }, inTurn(ctx())));
  if (why.mayHaveLanded === true || why.retryable === true) throw new Error(`a read claimed it may have landed: ${why.message}`);
  // An argument the schema refuses is refused by the SDK before any request, naming the field and not the value.
  let sent = 0;
  globalThis.fetch = (async () => { sent++; return json(200, {}); }) as any;
  const bad = await failure(() => raftPlugin.invoke("channels_members", { target: 42 }, inTurn(ctx())));
  if (sent !== 0 || !/target/.test(bad.message) || /42/.test(bad.message)) throw new Error(`bad target: sent=${sent} ${bad.message}`);
});

await check("messages_search passes its parameters through and answers with the SDK's text", async () => {
  const calls = one(json(200, { results: [], hasMore: false }));
  const out = await raftPlugin.invoke("messages_search", { query: "launch plan", target: "#wg-raft-sdk", sort: "recent", limit: 2, offset: 4 }, inTurn(ctx())) as any;
  const p = new URL(calls[0]!.url).searchParams;
  if (p.get("q") !== "launch plan" || p.get("channel") !== "#wg-raft-sdk" || p.get("sort") !== "recent" || p.get("limit") !== "2" || p.get("offset") !== "4") {
    throw new Error(`request: ${calls[0]!.url}`);
  }
  if (out.text !== "No search results. (truncated=false)") throw new Error(JSON.stringify(out));
});

/** The operations whose result the manifest says may be large and that page by `limit`: the ones capped here. */
// users.info's limit is how many visible channels it inspects for memberships, one request each: capped, it bounds
// both the result and the requests one call makes.
const CAPPED = ["inbox.list", "messages.read", "messages.search", "attachments.comments", "mentions.pending", "server.info", "users.info"];

await check("a paged result stays under the parking line: limit is capped and defaulted on every operation that pages by it", async () => {
  if (PAGE_ROWS < 1 || PAGE_ROWS * 400 > PARK_BYTES) throw new Error(`PAGE_ROWS=${PAGE_ROWS} against PARK_BYTES=${PARK_BYTES}`);
  const capped = GENERATED.filter((op) => pagingArg(op) !== null).map((op) => op.name);
  if (JSON.stringify(capped) !== JSON.stringify(CAPPED)) throw new Error(`capped: ${capped.join(", ")}`);
  for (const name of CAPPED) {
    const limit = (toolNamed(opNamed(name).toolName)!.parameters as any).properties.limit;
    if (limit.maximum !== PAGE_ROWS || !new RegExp(`At most ${PAGE_ROWS} on this mount`).test(limit.description)) throw new Error(`${name}: ${JSON.stringify(limit)}`);
  }
  // Omitted, the page is the cap; over it, refused before any request.
  const calls = one(history([]));
  await raftPlugin.invoke("messages_read", { target: "#wg-raft-sdk" }, inTurn(ctx()));
  if (new URL(calls[0]!.url).searchParams.get("limit") !== String(PAGE_ROWS)) throw new Error(`default: ${calls[0]!.url}`);
  let sent = 0;
  globalThis.fetch = (async () => { sent++; return json(200, {}); }) as any;
  const over = await failure(() => raftPlugin.invoke("messages_read", { target: "#wg-raft-sdk", limit: PAGE_ROWS + 1 }, inTurn(ctx())));
  if (sent !== 0 || !/at most/.test(over.message)) throw new Error(`over the cap: sent=${sent} ${over.message}`);
  // What the cap is for: a full page of ordinary messages comes back under the line at which a result is parked.
  const body = "A message of ordinary length, a few sentences long, the way people write in a channel. ".repeat(3);
  one(history(Array.from({ length: PAGE_ROWS }, (_, i) => historyMessage(100 + i, body))));
  const page = await raftPlugin.invoke("messages_read", { target: "#wg-raft-sdk" }, inTurn(ctx()));
  const size = JSON.stringify(page).length;
  if (size > PARK_BYTES) throw new Error(`a full page of ${body.length}-character messages is ${size} characters; the parking line is ${PARK_BYTES}`);
});

await check("users_info inspects at most a capped page of channels, one members request each, and the page fits under the parking line", async () => {
  const channels = Array.from({ length: PAGE_ROWS + 5 }, (_, i) => ({ id: `c${i}`, name: `ch${i}`, joined: true, type: "channel" }));
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => {
    urls.push(String(url));
    return new URL(String(url)).pathname.endsWith("/server") ? server(channels)
      : json(200, { channel: { ref: "#x", type: "channel" }, agents: [], humans: [{ name: "tygg", role: "owner" }] });
  }) as any;
  const out = await raftPlugin.invoke("users_info", { name: "@tygg" }, inTurn(ctx())) as any;
  const memberRequests = urls.filter((u) => /channel-members/.test(u)).length;
  if (memberRequests !== PAGE_ROWS || out.state !== "info") throw new Error(`requests: ${memberRequests} ${JSON.stringify(out).slice(0, 300)}`);
  if (JSON.stringify(out).length > PARK_BYTES) throw new Error(`a full page is ${JSON.stringify(out).length} characters`);
  const toolInfo = toolNamed("users_info")!;
  if (toolInfo.sideEffects !== "read" || toolInfo.idempotency !== "native" || toolInfo.modelOnly) throw new Error(JSON.stringify(toolInfo));
});

/**
 * A Server that holds a send into #wg-raft-sdk unless the send attests seq 42, the newest message there: what
 * Raft does with the `seenUpToSeq` / `seenExactSeqs` the SDK attests from the mount's saved frontier.
 */
function freshnessServer(answers: { history?: Response; events?: Response }) {
  const sends: any[] = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/history")) return answers.history!.clone();
    if (path.endsWith("/events")) return answers.events!.clone();
    const body = JSON.parse(String(init?.body));
    sends.push(body);
    const attested = (body.seenUpToSeq ?? 0) >= 42 || (body.seenExactSeqs ?? []).includes(42);
    return attested
      ? json(200, { ok: true, state: "sent", messageId: "m-sent", messageSeq: 43 })
      : json(200, { ok: true, state: "held", newMessageCount: 1, seenUpToSeq: 41, omittedMessageCount: 0, freshnessContextMode: "inline",
        heldMessages: [historyMessage(42, "wait, one more thing")] });
  }) as any;
  return sends;
}

const SEEN_PAGE = { target: "#wg-raft-sdk", messages: [historyMessage(41, "one"), historyMessage(42, "wait, one more thing")],
  has_more: false, has_older: false, has_newer: false, last_read_seq: 42, model_seen_up_to_seq: 42 };

await check("a history read does not count as seen, even the model's own in its turn: a send after it is still held, and nothing is saved", async () => {
  // The SDK would book the page as seen inside invoke, before the runtime parks a result over PARK_BYTES: the model
  // would then have read a preview while the record says it saw the page. Only receive_events attests.
  const fresh = freshDb();
  const m = { ...inTurn(ctx(), "ctx_a"), db: fresh.db };
  const reads: string[] = [];
  freshnessServer({ history: json(200, SEEN_PAGE) });
  const serve = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => { if (new URL(String(url)).pathname.endsWith("/history")) reads.push(String(url)); return serve(url, init); }) as any;
  await raftPlugin.invoke("messages_read", { target: "#wg-raft-sdk" }, m);
  // The model's own read still consumes on the Server's side (no consume=false): only the seen record is withheld.
  if (reads.length !== 1 || new URL(reads[0]!).searchParams.has("consume")) throw new Error(`request: ${reads[0]}`);
  if (fresh.tables.get(fresh.scope, INBOX_STORE, "state") !== undefined) throw new Error("the read saved the mount's Raft state");
  const held = await raftPlugin.invoke("messages_send", { target: "#wg-raft-sdk", content: "y", idempotencyKey: "k-a" }, m);
  if (!(held instanceof Interrupt)) throw new Error(`the read let the send through: ${JSON.stringify(held)}`);
  // Positive control: the same conversation handed over by receive_events, in the same context, does attest.
  const c = mount();
  freshnessServer({ events: events([historyMessage(42, "wait, one more thing")], { last_seen_seq: 42 }) });
  await raftPlugin.invoke("receive_events", {}, inTurn(c.ctx, "ctx_a"));
  const sent = await raftPlugin.invoke("messages_send", { target: "#wg-raft-sdk", content: "y", idempotencyKey: "k-c" }, inTurn(c.ctx, "ctx_a")) as any;
  if (sent instanceof Interrupt || sent.state !== "sent") throw new Error(`control: receive_events did not attest: ${JSON.stringify(sent)}`);
});

await check("of the generated tools, only messages_read books anything as seen, so it is the one run without saved state", async () => {
  const booking = GENERATED.filter((op) => op.consumes.model.includes("seen")).map((op) => op.name);
  if (JSON.stringify(booking) !== JSON.stringify(["messages.read"])) throw new Error(`book seen: ${booking.join(", ")}`);
});

await check("a program's messages_read, made in a turn and so carrying a context id, still reads with consume=false and counts nothing as seen", async () => {
  // fromProgram alone decides it: the context id is present here, as it is on every call run_js makes in a turn.
  const m = mount();
  const sends = freshnessServer({ history: json(200, SEEN_PAGE) });
  const reads: string[] = [];
  const serve = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => { if (new URL(String(url)).pathname.endsWith("/history")) reads.push(String(url)); return serve(url, init); }) as any;
  const program = { ...m.ctx, caller: { ...m.ctx.caller, fromProgram: true, contextId: "ctx_turn" } };
  const out = await raftPlugin.invoke("messages_read", { target: "#wg-raft-sdk", after: 40 }, program) as any;
  if (reads.length !== 1 || new URL(reads[0]!).searchParams.get("consume") !== "false") throw new Error(`request: ${reads[0]}`);
  if (!/wait, one more thing/.test(out.text)) throw new Error(`result: ${JSON.stringify(out)}`);
  // Nothing attests the page: the model's send in the same context is still held.
  const sent = await raftPlugin.invoke("messages_send", { target: "#wg-raft-sdk", content: "done", idempotencyKey: "k-after-program-read" }, inTurn(m.ctx, "ctx_turn"));
  if (!(sent instanceof Interrupt)) throw new Error(`the program's read let the send through: ${JSON.stringify(sends)}`);
});

await check("a messages_read made in no session's turn (neither fromProgram nor contextId) leaves the page unread", async () => {
  const calls = one(json(200, SEEN_PAGE));
  await raftPlugin.invoke("messages_read", { target: "#wg-raft-sdk" }, ctx());
  if (calls.length !== 1 || new URL(calls[0]!.url).searchParams.get("consume") !== "false") throw new Error(`request: ${calls[0]?.url}`);
});

await check("receive_events books what it hands over in the caller's context, so a reply in that context is not held", async () => {
  const m = mount();
  const sends = freshnessServer({ events: events([historyMessage(42, "wait, one more thing")], { last_seen_seq: 42 }) });
  await raftPlugin.invoke("receive_events", {}, inTurn(m.ctx, "ctx_a"));
  const sent = await raftPlugin.invoke("messages_send", { target: "#wg-raft-sdk", content: "done", idempotencyKey: "k-after-receive" }, inTurn(m.ctx, "ctx_a")) as any;
  if (sent instanceof Interrupt || sent.state !== "sent") throw new Error(`receive_events did not attest its context: ${JSON.stringify(sends)}`);
  // Control: the same pull in another context does not attest a send in this one.
  const c = mount();
  freshnessServer({ events: events([historyMessage(42, "wait, one more thing")], { last_seen_seq: 42 }) });
  await raftPlugin.invoke("receive_events", {}, inTurn(c.ctx, "ctx_old"));
  const held = await raftPlugin.invoke("messages_send", { target: "#wg-raft-sdk", content: "done", idempotencyKey: "k-ctl" }, inTurn(c.ctx, "ctx_a"));
  if (!(held instanceof Interrupt)) throw new Error("control: a pull in another context attested this one");
});

await check("an approved call's replay of messages_read, run with nobody reading it, leaves the page unread", async () => {
  const g = await raftBehindGateway({ read: "approval" });
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => { urls.push(String(url)); return json(200, SEEN_PAGE); }) as any;
  const read: any = bridgeTools(g.offered(["inbox"]), g.host as any).find((t) => t.name === "inbox__messages_read");
  await read.execute("d", { target: "#wg-raft-sdk" }).catch(() => {});
  const [card] = await g.store.listApprovals("tenant", "pending");
  const whileHeld = urls.splice(0);
  if (!card || whileHeld.length !== 0) throw new Error(`held: card=${JSON.stringify(card)} fetched=${whileHeld.length}`);
  const ok: any = await g.gateway.applyApproval("tenant", card.operationId, "approved", "tygg");
  if (!ok.ok || !ok.executed || ok.result?.status !== "succeeded") throw new Error(`approval: ${JSON.stringify(ok)}`);
  if (urls.length !== 1 || new URL(urls[0]!).searchParams.get("consume") !== "false") throw new Error(`replay request: ${urls[0]}`);
});

await check("through the gateway, a run_js program's messages_read runs with consume=false and the model's without it", async () => {
  const g = await raftBehindGateway();
  const urls: string[] = [];
  globalThis.fetch = (async (url: any) => { urls.push(String(url)); return json(200, SEEN_PAGE); }) as any;
  const out = await program(g.host, g.offered(["inbox"]), "const r = await tool`inbox.messages_read ${{ target: '#wg-raft-sdk' }}`; output(r.status); output(r.result?.state);");
  if (out[0] !== "succeeded" || out[1] !== "page") throw new Error(`a program's read: ${JSON.stringify(out)}`);
  const fromProgram = urls.splice(0);
  if (fromProgram.length !== 1 || new URL(fromProgram[0]!).searchParams.get("consume") !== "false") throw new Error(`program request: ${fromProgram[0]}`);
  const read: any = bridgeTools(g.offered(["inbox"]), g.host as any).find((t) => t.name === "inbox__messages_read");
  const direct = JSON.parse((await read.execute("d", { target: "#wg-raft-sdk" })).content[0].text);
  if (direct.state !== "page") throw new Error(`the model's read: ${JSON.stringify(direct)}`);
  if (urls.length !== 1 || new URL(urls[0]!).searchParams.has("consume")) throw new Error(`model request: ${urls[0]}`);
});

/** The Agent API's credential context (`GET /internal/agent-api/context`), which `identity.whoami` reads. */
function context(capabilities: string[]) {
  return json(200, {
    agent: { id: "agent-1", name: "raft-bot", displayName: null, description: null, runtime: "external", external: true },
    server: { id: "server-1", slug: "s", name: "S" }, credential: { capabilities }, prompt: null,
  });
}
const allowedBy = (caps: string[]) => GENERATED.filter((op) => op.capability.every((c) => caps.includes(c))).map((op) => op.toolName);

await check("a mount's snapshot lists only the operations whose every capability its credential holds", async () => {
  const calls = one(context(["read", "send"]));
  const listed = await raftPlugin.snapshotTools!(ctx());
  if (!/\/internal\/agent-api\/context$/.test(calls[0]!.url)) throw new Error(`asked: ${calls[0]!.url}`);
  const names = listed.tools.map((t) => t.name);
  if (JSON.stringify(names) !== JSON.stringify(allowedBy(["read", "send"]))) throw new Error(`listed: ${names.join(", ")}`);
  // channels.join needs channels and read; a task operation needs tasks: neither is offered, and each says which scope it lacks.
  if (!names.includes("messages_send") || !names.includes("messages_read") || names.includes("channels_join") || names.includes("tasks_list")) throw new Error(names.join(", "));
  // The read-only operations 0.8.0 added are filtered the same way: channels_info and users_info need channels, tasks_show needs tasks.
  if (names.includes("channels_info") || names.includes("users_info") || names.includes("tasks_show")) throw new Error(`a new operation escaped the filter: ${names.join(", ")}`);
  one(context(["read", "channels", "tasks"]));
  const wider = (await raftPlugin.snapshotTools!(ctx())).tools.map((t) => t.name);
  if (!wider.includes("channels_info") || !wider.includes("users_info") || !wider.includes("tasks_show")) throw new Error(`control: ${wider.join(", ")}`);
  const join = listed.skipped?.find((s) => s.name === "channels_join");
  if (!join || !/lacks the Raft capability channels$/.test(join.reason)) throw new Error(`skipped: ${JSON.stringify(listed.skipped)}`);
  // No credential, or one Raft refuses, has no capabilities at all; Raft not answering is a throw, which keeps the stored list.
  const none = await raftPlugin.snapshotTools!(ctx(null));
  if (none.tools.length !== 0 || !/no Raft credential/.test(none.skipped?.[0]?.reason ?? "")) throw new Error(JSON.stringify(none));
  one(json(401, { error: "unauthorized" }));
  const refused = await raftPlugin.snapshotTools!(ctx());
  if (refused.tools.length !== 0 || !/refused/.test(refused.skipped?.[0]?.reason ?? "")) throw new Error(JSON.stringify(refused));
  one(json(503, { error: "down" }));
  await failure(() => raftPlugin.snapshotTools!(ctx()));
});

await check("mountTools offers the snapshot's operations and the plugin's own tools; a mount with no snapshot is offered every generated tool", async () => {
  const snap = await admitTools(await (async () => { one(context(["read"])); return raftPlugin.snapshotTools!(ctx()); })(), 0);
  const base: any = { tenantId: "t", agentId: "a", alias: "raft", plugin: "raft" };
  const offered = toolsOf(raftPlugin, { ...base, toolSnapshot: snap }).map((t) => t.name);
  if (JSON.stringify(offered) !== JSON.stringify([...OWN, ...allowedBy(["read"])])) throw new Error(`offered: ${offered.join(", ")}`);
  // Only names are read from the snapshot: each tool is this build's, model-only flag and all.
  const own = toolsOf(raftPlugin, { ...base, toolSnapshot: snap }).find((t) => t.name === "receive_events");
  if (own?.modelOnly !== true || toolsOf(raftPlugin, { ...base, toolSnapshot: snap }).some((t) => t.replay === "never")) throw new Error("a tool came from the stored copy");
  const empty = await admitTools({ tools: [] }, 0);
  if (JSON.stringify(toolsOf(raftPlugin, { ...base, toolSnapshot: empty }).map((t) => t.name)) !== JSON.stringify(OWN)) throw new Error("an empty snapshot offered generated tools");
  for (const missing of [null, undefined]) {
    const all = toolsOf(raftPlugin, { ...base, toolSnapshot: missing }).map((t) => t.name);
    if (JSON.stringify(all) !== JSON.stringify(raftPlugin.tools.map((t) => t.name))) throw new Error(`no snapshot (${missing}): ${all.join(", ")}`);
  }
  // The gateway asks the same list: an operation the snapshot left out is an unknown tool on that mount.
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("tenant", "agent");
  await store.addMount({ tenantId: "tenant", agentId: "agent", alias: "inbox", plugin: "raft", installationId: "i", connectionId: null,
    toolVersion: raftPlugin.version, publicConfig: { serverUrl: "https://raft.example" }, secretRef: "secret:raft", policy: null });
  await store.updateMountToolSnapshot("tenant", "agent", "inbox", snap);
  const gateway = new ToolGateway(store, [raftPlugin], new Set([raftPlugin.id]), { async resolve() { return "sk_agent_test_1234567890"; } });
  let fetched = 0;
  globalThis.fetch = (async () => { fetched++; return json(200, {}); }) as any;
  const out: any = await gateway.invoke({ tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "c" } as any, "inbox.tasks_list", { mine: true });
  if (out.status !== "rejected" || out.error?.code !== "unknown_tool" || fetched !== 0) throw new Error(`tasks_list on a read-only mount: ${JSON.stringify(out)}`);
});

/** A CLI command as the SDK's text writes one: `raft` and one of the CLI's nouns. */
const CLI_HINT = /\braft (?:message|server|inbox|user|task|mention|channel|thread|manual|attachment|action|profile|agent|integration)\b/;

/** Arguments a schema accepts, made up from the schema: what a model might send. */
function sampleArgs(schema: any, name = ""): any {
  if (schema.enum) return schema.enum[0];
  switch (schema.type) {
    case "object": return Object.fromEntries((schema.required ?? []).map((k: string) => [k, sampleArgs(schema.properties[k], k)]));
    case "array": return [sampleArgs(schema.items, name)];
    case "integer": case "number": return Math.max(schema.minimum ?? 0, 7);
    case "boolean": return true;
    default: {
      const v = name === "target" ? "#ops" : name === "name" ? "@nobody" : "sample-value-xyz";
      return v.length < (schema.minLength ?? 0) ? v.padEnd(schema.minLength, "-") : v;
    }
  }
}

/** A Server whose answers carry the SDK's command hints: an older page, a held send and claim, a summary, members, a missing user. */
function hintingServer() {
  globalThis.fetch = (async (url: any) => {
    const path = new URL(String(url)).pathname.replace("/internal/agent-api", "");
    if (path === "/history") return history([historyMessage(41, "one", { attachments: [{ id: "att-9", filename: "plan.pdf" }] })], { has_older: true, target: "#ops" });
    if (path === "/v2/send" || path === "/tasks/claim" || path === "/tasks/status") return HELD();
    if (path === "/server") return server([{ id: "c1", name: "ops", joined: true, type: "channel", description: "Ops" }]);
    if (path === "/channel-members") return json(200, { channel: { ref: "#ops", type: "channel" }, agents: [{ name: "piper", status: "online" }], humans: [{ name: "tygg", role: "owner" }] });
    if (path === "/tasks") return json(200, { tasks: [] });
    if (path === "/context") return context(["read", "send", "channels", "tasks"]);
    return json(404, { error: "not found", code: "NOT_FOUND" });
  }) as any;
}

/** Everything one call shows the model: its result, or its question and choices, or its error. */
async function shownBy(tool: string, args: unknown): Promise<string> {
  try {
    const out = await raftPlugin.invoke(tool, args as any, inTurn(mount().ctx));
    return out instanceof Interrupt ? JSON.stringify({ q: out.question, c: out.context, a: out.answer }) : JSON.stringify(out);
  } catch (e) { return String((e as Error).message); }
}

await check("no CLI command reaches the model: every generated operation's text, errors, held questions and next hints are in tool terms", async () => {
  hintingServer();
  const raw = createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_test_1234567890" });
  const leaks: string[] = [];
  const hinted: string[] = [];
  for (const op of GENERATED) {
    const args = { ...sampleArgs(op.inputSchema), ...(op.name === "tasks.claim" ? { taskNumbers: [7] } : {}) };
    // Control: what the SDK itself says for the same call, which is where a hint would come from.
    const sdk: any = await raw.invoke(op.name, args, { origin: "model", contextId: "ctx_turn" });
    const said = sdk.ok ? `${sdk.text} ${sdk.interrupt?.context ?? ""}` : `${sdk.error.message} ${sdk.error.nextAction ?? ""}`;
    if (CLI_HINT.test(said)) hinted.push(op.toolName);
    const shown = await shownBy(op.toolName, args);
    if (CLI_HINT.test(shown)) leaks.push(`${op.toolName}: ${shown.match(new RegExp(`.{0,60}${CLI_HINT.source}.{0,60}`))?.[0]}`);
  }
  if (leaks.length) throw new Error(`a CLI command reached the model: ${leaks.join(" | ")}`);
  // The fixtures above must make the SDK hint at all, or this check proves nothing: the older page, the summary's
  // narrow queries, the missing user's next step, the held claim, the missing task.
  for (const want of ["messages_read", "server_info", "users_info", "tasks_claim", "tasks_show"]) {
    if (!hinted.includes(want)) throw new Error(`control: the SDK gave ${want} no CLI hint here (hinted: ${hinted.join(", ")})`);
  }
});

await check("no CLI command the SDK can write survives the rewrite: every line of its source that names one", async () => {
  // Static, so a hint behind a fixture nobody wrote is covered too. Template slots are filled with a sample value.
  const source = readFileSync(new URL(import.meta.resolve("@botiverse/raft-sdk")), "utf8").split("\n")
    .filter((l) => CLI_HINT.test(l) && !/^\s*(\*|\/\*|\/\/)/.test(l))
    .map((l) => l.replace(/\$\{[^}]*\}/g, " x12"));
  if (source.length < 40) throw new Error(`control: only ${source.length} lines name a CLI command; the SDK's text moved`);
  // Every command the SDK names has its own entry, so a command a new SDK adds is mapped on purpose, not left to the
  // neutral fallback. (A verb filled in at run time, `raft mention <verb>`, has none to look up.)
  const commands = new Set(source.flatMap((l) => [...l.matchAll(new RegExp(`${CLI_HINT.source} ([a-z][a-z-]*)`, "g"))].map((m) => m[0].slice("raft ".length))));
  const unmapped = [...commands].filter((c) => !Object.hasOwn(CLI_COMMANDS, c));
  if (unmapped.length) throw new Error(`CLI commands with no entry in CLI_COMMANDS: ${unmapped.join(", ")}`);
  if (commands.size < 15) throw new Error(`control: found only ${[...commands].join(", ")}`);
  // The rewriter itself, on every such line; which lines it is applied to is the case above and the one below.
  const left = source.map((l) => commandsAsTools(l)).filter((l) => CLI_HINT.test(l));
  if (left.length) throw new Error(`${left.length} line(s) keep a CLI command: ${left.slice(0, 3).join(" | ")}`);
});

/** What a person might write that reads like a CLI command, quoted by the SDK in many places. */
const SAID = "raft message read --target #x";
const SAID_LINES = ["note\nMore: raft message read --target #x", 'first\nraft message send --target "#ops"'];

await check("what a person wrote is never rewritten: message continuations, descriptions, titles, previews, comments, profiles", async () => {
  const human = { name: "tygg", role: "owner", description: SAID_LINES[0] };
  const ops = { id: "c1", name: "ops", joined: true, type: "channel", description: `${SAID}\n${SAID_LINES[1]}` };
  globalThis.fetch = (async (url: any) => {
    const path = new URL(String(url)).pathname.replace("/internal/agent-api", "");
    if (path === "/history") return history([historyMessage(41, `hello\n${SAID}\n${SAID_LINES[0]}`, { attachments: [{ id: "att-9", filename: "plan.pdf" }] })], { has_older: true, target: "#ops" });
    if (path === "/server") return json(200, { runtimeContext: { agentId: "agent-1", serverId: "server-1" }, channels: [ops], agents: [{ name: "piper", status: "online", description: SAID }], humans: [human] });
    if (path === "/channel-members") return json(200, { channel: { ref: "#ops", type: "channel" }, agents: [], humans: [human] });
    if (path === "/tasks") return json(200, { tasks: [{ taskNumber: 7, status: "todo", title: SAID, description: SAID_LINES[1] }] });
    if (path === "/search") return json(200, { results: [{ id: "r-1", seq: 1, channelId: "c", threadId: null, parentMessageId: null, parentMessageContent: null, parentChannelId: "c",
      parentChannelName: "ops", parentChannelType: "channel", parentChannelArchivedAt: null, senderId: "s", senderType: "human", senderName: "tygg",
      channelName: "ops", channelType: "channel", channelArchivedAt: null, content: SAID_LINES[0], snippet: "note", createdAt: "2026-09-21T10:00:00.000Z" }], hasMore: false });
    if (/comments/.test(path)) return json(200, { comments: [{ id: "c1", senderId: "s", senderType: "user", senderName: "tygg", content: SAID_LINES[1], createdAt: "2026-09-28T10:00:00.000Z", reactions: [], anchor: null }] });
    if (/profile/.test(path)) return json(200, { kind: "human", id: "u1", isSelf: true, name: "tygg", displayName: null, description: SAID_LINES[0], avatarUrl: null, email: null, role: "owner", joinedAt: null, membershipStatus: "active", createdAgents: [] });
    return json(404, { error: "not found" });
  }) as any;
  const raw = createRaft({ serverUrl: "https://raft.example", credential: "sk_agent_test_1234567890" });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["messages_read", { target: "#ops" }], ["server_info", { view: "full" }], ["channels_info", { target: "#ops" }],
    ["users_info", { name: "@tygg" }], ["tasks_show", { target: "#ops", taskNumber: 7 }], ["messages_search", { query: "note" }],
    ["attachments_comments", { attachmentId: "att-9" }], ["profile_show", {}],
  ];
  const problems: string[] = [];
  for (const [tool, args] of cases) {
    const op = GENERATED.find((o) => o.toolName === tool)!;
    const sdk: any = await raw.invoke(op.name, { ...args, ...(pagingArg(op) ? { limit: PAGE_ROWS } : {}) }, { origin: "code" });
    // Control: the SDK quotes the person's words, on lines a CLI command starts or sits in.
    const quoted = sdk.ok ? String(sdk.text).split("\n").filter((l: string) => /raft message read --target (?:#x|channel:x)/.test(l) || l.includes('raft message send --target "#ops"')) : [];
    if (!quoted.length) { problems.push(`${tool}: control: the SDK quoted nothing here (${sdk.ok ? sdk.text.slice(0, 120) : sdk.error.message})`); continue; }
    const shown = String(((await raftPlugin.invoke(tool, args, inTurn(ctx()))) as any).text).split("\n");
    for (const line of quoted) {
      // A message line is rebuilt by modelLine, whose attachment suffix is ours; the person's part of it is compared.
      const want = line.replace(/ \[1 attachment: .*$/, "");
      if (!shown.some((l) => l.startsWith(want))) problems.push(`${tool}: ${JSON.stringify(line)} did not come back as written`);
    }
  }
  if (problems.length) throw new Error(problems.join(" | "));
  // Controls: the hints around those words were still rewritten.
  const page = String(((await raftPlugin.invoke("messages_read", { target: "#ops" }, inTurn(ctx()))) as any).text);
  if (!/^Older exist: messages_read\(\{ target: "#ops", before: 41 \}\)$/m.test(page) || !/this mount has no tool to open attachments\]/.test(page)) throw new Error(`page: ${page}`);
  const full = String(((await raftPlugin.invoke("server_info", { view: "full" }, inTurn(ctx()))) as any).text);
  if (!/^Server-profile changes still use a server setting/m.test(full)) throw new Error(`overview: ${full}`);
});

/** The real runtime over a SQLite host, with raft mounted, its credential attached through the console's path. */
async function raftRuntime() {
  const host = sqliteHost();
  const rt: any = new AgentRuntime({
    ctx: { storage: host } as any, bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any, extraPlugins: [],
    secretKek: Buffer.from(new Uint8Array(32)).toString("base64"),
  } as any);
  await rt.store.init();
  rt.ready = async () => {};
  await rt.store.createAgent("t", "a");
  await rt.store.setPluginChoice("t", "a", "raft", "enable");
  await rt.store.addMount({ tenantId: "t", agentId: "a", alias: "raft", plugin: "raft", installationId: "i", connectionId: null,
    toolVersion: raftPlugin.version, publicConfig: { serverUrl: "https://raft.example" }, secretRef: null, policy: null });
  const offered = async () => toolsOf(raftPlugin, (await rt.store.getMountByAlias("t", "a", "raft"))!).map((t: any) => t.name);
  return { rt, offered };
}
/** Raft as the attach path meets it: the identity check, then the credential's context, with the capabilities given. */
function raftServer(capabilities: () => string[] | "down") {
  globalThis.fetch = (async (url: any) => {
    const path = new URL(String(url)).pathname;
    if (path === "/internal/agent-api") return json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" });
    if (path === "/internal/agent-api/context") { const c = capabilities(); return c === "down" ? json(503, { error: "down" }) : context(c); }
    throw new Error(`unexpected request: ${path}`);
  }) as any;
}

await check("attaching, replacing and removing a mount's credential re-lists its tools, so a scope the credential lost stops being offered", async () => {
  const { rt, offered } = await raftRuntime();
  let caps: string[] | "down" = ["read", "send", "channels", "tasks"];
  raftServer(() => caps);
  const first = await rt.attachCredential("t", "a", "raft", { token: "sk_agent_first_1234567890" });
  if (!first.ok) throw new Error(`attach: ${JSON.stringify(first)}`);
  if (JSON.stringify(await offered()) !== JSON.stringify([...OWN, ...allowedBy(caps)])) throw new Error(`after attach: ${(await offered()).join(", ")}`);
  if (!(await offered()).includes("tasks_list")) throw new Error("control: the full credential does not offer tasks_list");
  // Replaced by a credential that lost tasks and channels: those tools go.
  caps = ["read", "send"];
  const second = await rt.attachCredential("t", "a", "raft", { token: "sk_agent_second_1234567890" });
  if (!second.ok) throw new Error(`replace: ${JSON.stringify(second)}`);
  const narrowed = await offered();
  if (narrowed.includes("tasks_list") || narrowed.includes("channels_join") || !narrowed.includes("messages_send")) throw new Error(`after replace: ${narrowed.join(", ")}`);
  // Replaced while Raft cannot say what the new one may do: the previous list stays, and why is kept for the mount's page.
  caps = "down";
  await rt.attachCredential("t", "a", "raft", { token: "sk_agent_third_12345678901" });
  if (JSON.stringify(await offered()) !== JSON.stringify(narrowed)) throw new Error(`after an unlistable replace: ${(await offered()).join(", ")}`);
  if (!/could not ask Raft/.test(rt.snapshotError("raft") ?? "")) throw new Error(`no reason kept: ${rt.snapshotError("raft")}`);
  // Removed: no credential, no capabilities.
  caps = ["read", "send"];
  await rt.attachCredential("t", "a", "raft", { token: "sk_agent_fourth_1234567890" });
  if (!(await offered()).includes("messages_send")) throw new Error("control: re-attached credential offers nothing");
  if (!(await rt.removeCredential("t", "a", "raft"))) throw new Error("remove refused");
  if (JSON.stringify(await offered()) !== JSON.stringify(OWN)) throw new Error(`after remove: ${(await offered()).join(", ")}`);
});

await check("a mount whose first listing fails, with no list before it, is offered every tool, as at deploy", async () => {
  const { rt, offered } = await raftRuntime();
  raftServer(() => "down");
  const r = await rt.attachCredential("t", "a", "raft", { token: "sk_agent_first_1234567890" });
  if (!r.ok) throw new Error(`attach: ${JSON.stringify(r)}`);
  if ((await rt.store.getMountByAlias("t", "a", "raft"))?.toolSnapshot) throw new Error("a list was stored from a failed listing");
  if (JSON.stringify(await offered()) !== JSON.stringify(raftPlugin.tools.map((t) => t.name))) throw new Error(`offered: ${(await offered()).join(", ")}`);
});

await check("a credential Raft refuses on attach changes neither the credential nor the tool list", async () => {
  const { rt, offered } = await raftRuntime();
  raftServer(() => ["read"]);
  await rt.attachCredential("t", "a", "raft", { token: "sk_agent_first_1234567890" });
  const before = await offered();
  globalThis.fetch = (async () => json(401, { error: "unauthorized" })) as any;
  const r = await rt.attachCredential("t", "a", "raft", { token: "sk_agent_bad_12345678901" });
  if (r.ok) throw new Error(`a refused key was kept: ${JSON.stringify(r)}`);
  if (JSON.stringify(await offered()) !== JSON.stringify(before)) throw new Error(`the list moved: ${(await offered()).join(", ")}`);
});

await check("the mount setting cannot redirect a credential to a path or embedded user", async () => {
  globalThis.fetch = (async () => { throw new Error("network reached"); }) as any;
  for (const serverUrl of ["https://evil.example/path", "https://user@evil.example", "file:///tmp/socket"]) {
    const why = await failure(() => raftPlugin.invoke("receive_events", {}, ctx(undefined, { serverUrl })));
    if (!/serverUrl/.test(why.message)) throw why;
  }
});

await check("credential check distinguishes rejection from an unreachable server", async () => {
  one(json(401, { errorCode: "UNAUTHORIZED", message: "secret response text" }));
  const rejected = await raftPlugin.checkCredential!(ctx());
  if (rejected.ok || rejected.kind !== "rejected" || /secret response text/.test(rejected.reason)) {
    throw new Error(`rejection: ${JSON.stringify(rejected)}`);
  }
  globalThis.fetch = (async () => { throw new Error("secret socket detail"); }) as any;
  const unreachable = await raftPlugin.checkCredential!(ctx());
  if (unreachable.ok || unreachable.kind !== "unreachable" || /secret socket detail/.test(unreachable.reason)) {
    throw new Error(`unreachable: ${JSON.stringify(unreachable)}`);
  }
});

await check("credential check returns the bound Raft identity", async () => {
  const calls = one(json(200, {
    agentId: "agent-1", agentName: "raft-bot", agentDisplayName: "Release Bot", serverId: "server-1",
    credentialId: "secret-id", scopes: ["all"],
  }));
  const checked = await raftPlugin.checkCredential!(ctx());
  if (!checked.ok || checked.account !== "Release Bot (@raft-bot)") throw new Error(JSON.stringify(checked));
  if (calls.length !== 1 || calls[0]!.url !== "https://raft.example/internal/agent-api") {
    throw new Error(`credential check used the wrong endpoint: ${JSON.stringify(calls)}`);
  }
});

await check("credential check falls back to the stable Raft agent name", async () => {
  one(json(200, {
    agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1",
    credentialId: "secret-id", scopes: ["all"],
  }));
  const checked = await raftPlugin.checkCredential!(ctx());
  if (!checked.ok || checked.account !== "@raft-bot") throw new Error(JSON.stringify(checked));
});

await check("enable_push creates a hook and registers it without exposing its secret", async () => {
  const calls = many(
    json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: "Release Bot", serverId: "server-1" }),
    json(200, { ok: true }),
  );
  const m = mount();
  const out = await raftPlugin.invoke("enable_push", {}, m.ctx) as any;
  if (!out.enabled || out.account !== "Release Bot (@raft-bot)" || out.registration !== "active") {
    throw new Error(`enable result: ${JSON.stringify(out)}`);
  }
  if (calls.length !== 2 || calls[0]!.url !== "https://raft.example/internal/agent-api" ||
      calls[1]!.url !== "https://raft.example/internal/agent-api/push-webhook" || calls[1]!.init.method !== "PUT") {
    throw new Error(`enable used the wrong identity endpoint: ${JSON.stringify(calls)}`);
  }
  const registered = JSON.parse(String(calls[1]!.init.body));
  if (registered.url !== "https://hooks.example/hook-1" || registered.secret !== "hook-secret-1") {
    throw new Error(`wrong registration: ${JSON.stringify(registered)}`);
  }
  const encoded = JSON.stringify({ out, state: m.state() });
  if (encoded.includes("hook-secret") || encoded.includes("hooks.example")) throw new Error(`hook material leaked: ${encoded}`);
  if (JSON.stringify(m.state()) !== JSON.stringify({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-1",
    staleHookIds: [], registration: "active", lastReached: null,
  })) {
    throw new Error(`push state: ${JSON.stringify(m.state())}`);
  }
});

await check("enable_push revokes a newly created hook after a definite registration failure", async () => {
  many(
    json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" }),
    json(400, { errorCode: "INVALID_PUSH_ENDPOINT" }),
  );
  const original = {
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old",
    staleHookIds: [], registration: "active", lastReached: null,
  };
  const m = mount(original);
  const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
  if (!/HTTP 400/.test(why.message) || JSON.stringify(m.state()) !== JSON.stringify(original)) throw why;
  if (m.inbound.revoked.join(",") !== "hook-1") throw new Error(`revoked ${m.inbound.revoked}`);
});

await check("a failed hook cleanup remains recorded without replacing the registration error", async () => {
  many(
    json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" }),
    json(400, { errorCode: "INVALID_PUSH_ENDPOINT" }),
  );
  const inbound = fakeInbound();
  inbound.api.revoke = async () => { throw new Error("private cleanup detail"); };
  const m = mount(null, inbound);
  const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
  if (!/HTTP 400/.test(why.message) || /private cleanup detail/.test(why.message)) throw why;
  if (m.state().hookId !== "hook-1" || m.state().enabled !== false) throw new Error(JSON.stringify(m.state()));
});

await check("enable_push preserves an ambiguous new registration for recovery without leaking its secret", async () => {
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) return json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" });
    throw new Error("private transport detail");
  }) as any;
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old",
    staleHookIds: [], registration: "active", lastReached: null,
  });
  const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
  const encoded = JSON.stringify({ message: why.message, state: m.state() });
  if (!/may already have landed/.test(why.message) || m.state().registration !== "uncertain" ||
      m.state().hookId !== "hook-1" || m.state().staleHookIds.join(",") !== "hook-old") throw why;
  if (encoded.includes("hook-secret") || encoded.includes("hooks.example") || /private transport detail/.test(encoded)) {
    throw new Error(`hook material leaked: ${encoded}`);
  }
  if (m.inbound.revoked.length !== 0) throw new Error(`ambiguous hook was revoked: ${m.inbound.revoked}`);
});

await check("enable_push recovers after three ambiguous registrations without exhausting hook capacity", async () => {
  let serial = 0;
  const active = new Set<string>();
  const inbound = {
    api: {
      create: async () => {
        if (active.size >= 3) throw new Error("already has 3 live hooks");
        const hookId = `hook-${++serial}`;
        active.add(hookId);
        return { hookId, url: `https://hooks.example/${hookId}`, secret: `hook-secret-${serial}` };
      },
      revoke: async (hookId: string) => active.delete(hookId),
    },
    revoked: [],
  };
  let registrations = 0;
  globalThis.fetch = (async (url: any) => {
    if (String(url) === "https://raft.example/internal/agent-api") {
      return json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" });
    }
    registrations++;
    if (registrations <= 3) throw new Error("private transport detail");
    return json(200, { ok: true });
  }) as any;
  const m = mount(null, inbound);
  for (let attempt = 0; attempt < 3; attempt++) {
    const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
    if (!/may already have landed/.test(why.message)) throw why;
  }
  const enabled = await raftPlugin.invoke("enable_push", {}, m.ctx) as any;
  if (!enabled.enabled || enabled.registration !== "active" || active.size !== 1 || !active.has("hook-4")) {
    throw new Error(JSON.stringify({ enabled, active: [...active], state: m.state() }));
  }
  if (m.state().hookId !== "hook-4" || m.state().staleHookIds.length !== 0) {
    throw new Error(JSON.stringify(m.state()));
  }
});

await check("enable_push clears stale hooks before create and revokes the current hook after replacement", async () => {
  const order: string[] = [];
  const inbound = fakeInbound();
  const originalRevoke = inbound.api.revoke;
  inbound.api.revoke = async (hookId: string) => { order.push(`revoke:${hookId}`); return originalRevoke(hookId); };
  let request = 0;
  globalThis.fetch = (async (_url: any, init?: any) => {
    request++;
    if (request === 1) return json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" });
    order.push(`register:${init?.method}`);
    return json(200, { ok: true });
  }) as any;
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old",
    staleHookIds: ["hook-older"], registration: "uncertain", lastReached: null,
  }, inbound);
  await raftPlugin.invoke("enable_push", {}, m.ctx);
  if (order.join(",") !== "revoke:hook-older,register:PUT,revoke:hook-old") throw new Error(order.join(","));
  if (m.state().hookId !== "hook-1" || m.state().staleHookIds.length !== 0 || m.state().registration !== "active") {
    throw new Error(JSON.stringify(m.state()));
  }
});

await check("push state keeps every valid hook id until it is explicitly revoked", async () => {
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-current",
    staleHookIds: ["hook-1", "hook-2", "hook-3"], registration: "uncertain", lastReached: null,
  });
  one(new Response(null, { status: 204 }));
  const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
  if (disabled.cleanupPending !== 0 || m.inbound.revoked.sort().join(",") !== "hook-1,hook-2,hook-3,hook-current") {
    throw new Error(JSON.stringify({ disabled, revoked: m.inbound.revoked, state: m.state() }));
  }
});

await check("a bare 200 on push registration is a registration, not a malformed answer", async () => {
  const m = mount();
  const calls = many(json(200, { agentId: "agent-1", agentName: "raft-bot", serverId: "srv" }), new Response("", { status: 200 }));
  const out = await raftPlugin.invoke("enable_push", {}, m.ctx) as any;
  if (out.enabled !== true || out.registration !== "active" || calls[1]!.init.method !== "PUT") throw new Error(JSON.stringify({ out, calls: calls.map((c) => c.init.method) }));
});

await check("an inbox notice reaches the agent as Raft wrote it, with the one instruction to read, and is deduped on its notice id", async () => {
  const m = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  globalThis.fetch = (async () => { throw new Error("receive called the network"); }) as any;
  const out = await raftPlugin.receive!(pushed(notice(), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, m.ctx);
  if (!out.deliver || out.dedupeKey !== "ntc_0123456789abcdef") throw new Error(JSON.stringify(out));
  if (!out.text.startsWith("Read your Raft inbox with the `receive_events` tool from the `raft` mount") || !out.text.includes("Inbox update: 2 unread") || !/acknowledges/.test(out.text)) throw new Error(out.text);
  if (m.state()?.lastReached?.deliveryId !== "ntc_0123456789abcdef") throw new Error(JSON.stringify(m.state()));
  const extra = await raftPlugin.receive!(pushed(notice({ latestPreview: "added later", other: 1 }), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, m.ctx);
  if (!extra.deliver) throw new Error(`a field it does not know was refused: ${JSON.stringify(extra)}`);
  // A long notice is cut under the runtime's 4,000 with the instruction intact and first, so no later cut can take it.
  const long = await raftPlugin.receive!(pushed(notice({ text: "y".repeat(5000) }), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, m.ctx);
  if (!long.deliver || !long.text.includes("… (cut)") || long.text.length > 4000 || !long.text.startsWith("Read your Raft inbox")) throw new Error(`length ${long.deliver ? long.text.length : "-"}`);
});

await check("a notice is checked for its signature and header before any state is read, and a signed body Raft got wrong is 400, never 401", async () => {
  let reads = 0;
  const guarded = { ...ctx(), db: { get: async () => { reads++; return undefined; }, put: async () => { throw new Error("state written"); } } } as any;
  const unsigned = pushed(notice(), { deliveryId: "ntc_0123456789abcdef" }); delete (unsigned.headers as any)["x-raft-signature-256"];
  const rej = await raftPlugin.receive!(unsigned, PUSH_SECRET, guarded);
  if (rej.deliver || !rej.rejected) throw new Error(JSON.stringify(rej));
  const wrongSecret = await raftPlugin.receive!(pushed(notice(), { secret: "wrong", deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, guarded);
  if (wrongSecret.deliver || !wrongSecret.rejected) throw new Error(JSON.stringify(wrongSecret));
  for (const [bad, expect] of [
    [notice({ text: "" }), /not a notice: text missing/], [notice({ targets: "none" }), /targets missing/], [notice({ noticeId: "has space" }), /noticeId missing/],
    [{ schema: "raft-agent-inbox.v2", deliveryId: "ibx_x", recipientAgentId: "agent-1", cursor: { fromSeq: 1, toSeq: 1 }, events: [{ content: "raw message" }] }, /schema is "raft-agent-inbox\.v2", not raft-agent-inbox-notice\.v1/],
    [{ schema: "raft-agent-inbox.v1", eventId: "e", recipientAgentId: "agent-1", reason: "inbox_changed" }, /schema is "raft-agent-inbox\.v1"/],
    [{ noticeId: "n", recipientAgentId: "agent-1", text: "x", targets: [] }, /schema is "undefined"/],
  ] as const) {
    const r = await raftPlugin.receive!(pushed(bad, { deliveryId: String((bad as any).noticeId ?? (bad as any).deliveryId ?? (bad as any).eventId) }), PUSH_SECRET, guarded);
    if (r.deliver || r.rejected || !r.malformed || !expect.test(r.reason) || JSON.stringify(r).includes("raw message")) throw new Error(JSON.stringify({ bad, r }));
  }
  const wrongHeader = await raftPlugin.receive!(pushed(notice(), { deliveryId: "ntc_other" }), PUSH_SECRET, guarded);
  if (wrongHeader.deliver || !wrongHeader.malformed || reads !== 0) throw new Error(JSON.stringify({ wrongHeader, reads }));
});

await check("a signed notice at a mount with no push record rebuilds the record from the delivery and goes through; a record that says off stays off", async () => {
  // No record at all: never enabled, or the record was lost. The signature verified against this
  // hook's secret, so Raft points at this hook, and the notice names the agent — enough to rebuild.
  const m = mount();
  globalThis.fetch = (async () => { throw new Error("rebuilding the record called the network"); }) as any;
  const out = await raftPlugin.receive!(pushed(notice(), { deliveryId: "ntc_0123456789abcdef", hookId: "hk_from_the_delivery" }), PUSH_SECRET, m.ctx);
  if (!out.deliver) throw new Error(`not delivered: ${JSON.stringify(out)}`);
  const s = m.state();
  if (s?.enabled !== true || s?.agentId !== "agent-1" || s?.hookId !== "hk_from_the_delivery" || s?.registration !== "active" || s?.lastReached?.deliveryId !== "ntc_0123456789abcdef") {
    throw new Error(`the record was not rebuilt from the delivery: ${JSON.stringify(s)}`);
  }
  // From here on it is an ordinary enabled mount: a notice for another agent is refused by the rebuilt id.
  const cross = await raftPlugin.receive!(pushed(notice({ recipientAgentId: "agent-2" }), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, m.ctx);
  if (cross.deliver || !/different/.test(cross.reason)) throw new Error(JSON.stringify(cross));
  // The rebuilt record is what enable_push would have written, so disable_push can revoke the hook it names.
  const status = await raftPlugin.invoke("push_status", {}, m.ctx) as any;
  if (status.enabled !== true || status.registration !== "active") throw new Error(`push_status after the rebuild: ${JSON.stringify(status)}`);
});

await check("a notice for a mount whose push is off, or for another Raft agent, is ignored and not delivered", async () => {
  const off = mount({ enabled: false, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const ignored = await raftPlugin.receive!(pushed(notice(), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, off.ctx);
  if (ignored.deliver || ignored.malformed || ignored.rejected || !/disabled/.test(ignored.reason)) throw new Error(JSON.stringify(ignored));
  const on = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const cross = await raftPlugin.receive!(pushed(notice({ recipientAgentId: "agent-2" }), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, on.ctx);
  if (cross.deliver || !/different/.test(cross.reason)) throw new Error(JSON.stringify(cross));
});

await check("a 400 on a batch is the batch's own fault: sent once, status and all, and it throws", async () => {
  const on = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const events = [
    { eventId: "raft_x:1:pre", hookEventName: "PreToolUse" as const, occurredAt: "2026-09-29T05:00:00.000Z", toolName: "raft__messages_send", status: "working" as const },
    { eventId: "raft_x:2:status:start", occurredAt: "2026-09-29T05:00:01.000Z", status: "thinking" as const },
  ];
  const once = one(json(400, { errorCode: "event_field_unknown" }));
  const why = await failure(() => raftPlugin.reportActivity!(events, on.ctx));
  if (once.length !== 1 || !/HTTP 400/.test(why.message) || JSON.parse(once[0]!.init.body).events.length !== 2) {
    throw new Error(`400: ${once.length} ${why.message}`);
  }
});

await check("a 200 that counts refused events is said, and sent counts only what Raft took", async () => {
  const on = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const events = [
    { eventId: "raft_x:1", hookEventName: "Stop" as const, occurredAt: "2026-09-29T05:00:02.000Z", status: "online" as const },
    { eventId: "raft_x:2:status:start", occurredAt: "2026-09-29T05:00:01.000Z", status: "thinking" as const },
  ];
  one(json(200, { ok: true, acceptedCount: 1, rejectedCount: 1 }));
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => { warned.push(String(m)); };
  let out: any;
  try { out = await raftPlugin.reportActivity!(events, on.ctx); } finally { console.warn = warn; }
  if (out.sent !== 1 || warned.length !== 1 || !/refused 1 of 2/.test(warned[0]!) || !/1 status-only/.test(warned[0]!)) {
    throw new Error(JSON.stringify({ out, warned }));
  }
  one(json(200, { ok: true, acceptedCount: 2, rejectedCount: 0 }));
  const quiet: string[] = [];
  console.warn = (m: string) => { quiet.push(String(m)); };
  try { out = await raftPlugin.reportActivity!(events, on.ctx); } finally { console.warn = warn; }
  if (out.sent !== 2 || quiet.length !== 0) throw new Error(`a clean answer was reported: ${JSON.stringify({ out, quiet })}`);
});

await check("activity posts the events as given to Raft's ingest while push is on, and says skipped when it is off", async () => {
  const on = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const calls = one(json(200, { accepted: 2 }));
  const events = [
    { eventId: "raft_x:1", hookEventName: "UserPromptSubmit" as const, occurredAt: "2026-09-28T08:00:00.000Z" },
    { eventId: "raft_x:2", hookEventName: "Stop" as const, occurredAt: "2026-09-28T08:00:05.000Z" },
  ];
  const out = await raftPlugin.reportActivity!(events, on.ctx);
  if (!("sent" in out) || out.sent !== 2) throw new Error(JSON.stringify(out));
  const body = JSON.parse(calls[0]!.init.body);
  if (calls[0]!.url !== "https://raft.example/internal/agent-api/activity" || calls[0]!.init.method !== "POST" ||
      body.schema !== "raft-agent-activity-ingest.v1" || JSON.stringify(body.events) !== JSON.stringify(events) || Object.keys(body).length !== 2) {
    throw new Error(JSON.stringify({ url: calls[0]!.url, body }));
  }
  if (!String(calls[0]!.init.headers.authorization).startsWith("Bearer sk_agent_")) throw new Error("no credential on the activity call");
  const off = mount({ enabled: false, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const quiet = one(json(200, {}));
  const skipped = await raftPlugin.reportActivity!(events, off.ctx);
  if (!("skipped" in skipped) || quiet.length !== 0) throw new Error(JSON.stringify({ skipped, calls: quiet.length }));
  const none = await raftPlugin.reportActivity!([], on.ctx);
  if (!("sent" in none) || none.sent !== 0 || quiet.length !== 0) throw new Error(JSON.stringify(none));
});

await check("activity for a mount with no account is skipped, not an error: a deleted agent must not re-arm the alarm for ever", async () => {
  const m = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  m.ctx.credential = null;
  const calls = one(json(200, {}));
  const out = await raftPlugin.reportActivity!([{ eventId: "raft_x:1", hookEventName: "Stop", occurredAt: "2026-09-28T08:00:00.000Z" }], m.ctx);
  if (!("skipped" in out) || !/no account/.test(out.skipped) || calls.length !== 0) throw new Error(JSON.stringify({ out, calls: calls.length }));
});

await check("an activity post that fails throws, so the runtime keeps the events for the next pass", async () => {
  const on = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  one(json(503, { errorCode: "UNAVAILABLE" }));
  const why = await failure(() => raftPlugin.reportActivity!([{ eventId: "raft_x:1", hookEventName: "Stop", occurredAt: "2026-09-28T08:00:00.000Z" }], on.ctx));
  if (!/HTTP 503/.test(why.message)) throw new Error(why.message);
});

await check("disable_push tells Raft the session ended and the agent is offline before deregistering, and still deregisters when that post fails", async () => {
  const m = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old", staleHookIds: [], registration: "active", lastReached: null });
  const calls = many(json(500, {}), new Response(null, { status: 204 }));
  const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
  if (disabled.enabled !== false || disabled.remoteDeregistration !== "confirmed") throw new Error(JSON.stringify(disabled));
  const first = JSON.parse(calls[0]!.init.body);
  if (calls[0]!.url !== "https://raft.example/internal/agent-api/activity" || first.events[0].hookEventName !== "SessionEnd" ||
      first.events[0].status !== "offline" || !String(first.events[0].eventId).startsWith("agent-1:session-end:") ||
      calls.length !== 2 || calls[1]!.init.method !== "DELETE") {
    throw new Error(JSON.stringify(calls.map((c) => [c.init.method, c.url])));
  }
  const off = mount({ enabled: false, agentId: "agent-1", agentName: "raft-bot", hookId: null, staleHookIds: [], registration: null, lastReached: null });
  const quiet = one(new Response(null, { status: 204 }));
  await raftPlugin.invoke("disable_push", {}, off.ctx);
  if (quiet.length !== 1 || quiet[0]!.init.method !== "DELETE") throw new Error(`a disabled mount announced a session end: ${JSON.stringify(quiet.map((c) => c.init.method))}`);
});

await check("disable_push stops later delivery and push_status exposes no secret", async () => {
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot",
    hookId: "hook-old", staleHookIds: ["hook-stale"], registration: "active",
    lastReached: { deliveryId: "delivery-old", at: Date.parse("2026-09-17T00:00:00.000Z") },
  });
  const calls = many(json(200, {}), new Response(null, { status: 204 }));
  const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
  const status = await raftPlugin.invoke("push_status", {}, m.ctx) as any;
  if (disabled.enabled !== false || disabled.remoteDeregistration !== "confirmed" || disabled.cleanupPending !== 0 ||
      status.enabled !== false || status.account !== "@raft-bot") {
    throw new Error(JSON.stringify({ disabled, status }));
  }
  if (status.lastReached?.deliveryId !== "delivery-old" || JSON.stringify(status).includes(PUSH_SECRET)) {
    throw new Error(JSON.stringify(status));
  }
  if (calls.length !== 2 || calls[1]!.init.method !== "DELETE" ||
      calls[1]!.url !== "https://raft.example/internal/agent-api/push-webhook") throw new Error(JSON.stringify(calls.map((c) => [c.init.method, c.url])));
  if (m.inbound.revoked.sort().join(",") !== "hook-old,hook-stale" || m.state().hookId !== null) {
    throw new Error(JSON.stringify({ state: m.state(), revoked: m.inbound.revoked }));
  }
});

await check("disable_push closes the local endpoint even when Raft returns an error", async () => {
  for (const remote of ["network", "not-found"] as const) {
    globalThis.fetch = remote === "network"
      ? (async () => { throw new Error("private delete detail"); }) as any
      : (async () => json(404, { errorCode: "PUSH_WEBHOOK_NOT_FOUND" })) as any;
    const m = mount({
      enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: `hook-${remote}`,
      staleHookIds: [`stale-${remote}`], registration: "active", lastReached: null,
    });
    const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
    const expectedRemote = remote === "not-found" ? "confirmed" : "unconfirmed";
    if (disabled.enabled !== false || disabled.remoteDeregistration !== expectedRemote || disabled.cleanupPending !== 0 ||
        m.state().enabled !== false || m.state().hookId !== null || m.state().staleHookIds.length !== 0 ||
        m.inbound.revoked.sort().join(",") !== `hook-${remote},stale-${remote}`) {
      throw new Error(JSON.stringify({ remote, disabled, state: m.state(), revoked: m.inbound.revoked }));
    }
  }
});

await check("disable_push stays disabled while retaining hooks whose local revoke failed", async () => {
  globalThis.fetch = (async () => { throw new Error("private delete detail"); }) as any;
  const inbound = fakeInbound();
  inbound.api.revoke = async () => { throw new Error("private cleanup detail"); };
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old",
    staleHookIds: ["hook-stale"], registration: "active", lastReached: null,
  }, inbound);
  const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
  if (disabled.enabled !== false || disabled.remoteDeregistration !== "unconfirmed" || disabled.cleanupPending !== 2 ||
      m.state().enabled !== false || m.state().hookId !== null ||
      m.state().staleHookIds.sort().join(",") !== "hook-old,hook-stale") {
    throw new Error(JSON.stringify({ disabled, state: m.state() }));
  }
});

await check("push_status safely normalizes a corrupt persisted record", async () => {
  for (const lastReached of [{ deliveryId: 9, at: "yesterday" }, { deliveryId: "event-future", at: 1e100 }, { eventId: "v1-shape", at: 1 }]) {
    const m = mount({ enabled: "yes", agentId: 42, agentName: ["bad"], lastReached });
    const status = await raftPlugin.invoke("push_status", {}, m.ctx) as any;
    if (JSON.stringify(status) !== JSON.stringify({
      enabled: false, account: null, registration: null, cleanupPending: 0, lastReached: null,
    })) {
      throw new Error(JSON.stringify(status));
    }
  }
});

/**
 * Which question a failure answers, per site.
 *
 * One flag could not say. This file set `retryable` for an uncertain delivery
 * while its own comment said callers must not retry; `github.ts` set the same
 * flag for a refused quota where nothing happened; `appworld.ts` set it for a
 * 5xx with the comment "5xx may have landed". Two questions — will this clear
 * on its own, and may the last attempt have landed — and a 5xx answers yes to
 * both (@Vera counted the three sites, 2026-09-20).
 */
await check("a send that got no answer says it may have landed, and does not say it will clear", async () => {
  globalThis.fetch = (async () => { throw new Error("socket closed"); }) as any;
  const why = await failure(() => raftPlugin.invoke("messages_send", { target: "#general", content: "x", idempotencyKey: "k-u" }, inTurn(ctx())));
  if (why.mayHaveLanded !== true) throw new Error(`uncertainty was lost: mayHaveLanded=${why.mayHaveLanded}`);
  const refused = await (async () => {
    one(json(403, { error: "forbidden" }));
    return failure(() => raftPlugin.invoke("messages_send", { target: "#general", content: "x", idempotencyKey: "k-r" }, inTurn(ctx())));
  })();
  if (refused.mayHaveLanded === true) throw new Error("a refusal was reported as possibly landed");
  // A read that got no answer landed nothing.
  globalThis.fetch = (async () => { throw new Error("socket closed"); }) as any;
  const read = await failure(() => raftPlugin.invoke("messages_read", { target: "#general" }, inTurn(ctx())));
  if (read.mayHaveLanded === true) throw new Error("a read was reported as possibly landed");
});


/**
 * A state holding as many ids as the cap still enables push, once they are gone.
 *
 * There used to be a cap check in `enable_push` between the cleanup and
 * `create()`, and it could not fire: the cleanup either throws or empties the
 * list. This pins the reason not to "fix" it by moving it earlier — the ids it
 * would count are the ones the cleanup removes, so refusing first would leave a
 * mount whose revokes had failed a few times unable to enable push ever again.
 */
await check("a mount carrying a cap's worth of superseded endpoints can still enable push once they are revoked", async () => {
  const calls = many(
    json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: "Release Bot", serverId: "server-1" }),
    json(200, { ok: true }),
  );
  const inbound = fakeInbound();
  const m = mount(
    { hookId: "hook-live", staleHookIds: ["hook-old-1", "hook-old-2"], registration: "active", lastReached: null },
    inbound,
  );
  const out = await raftPlugin.invoke("enable_push", {}, m.ctx) as any;
  if (out.enabled !== true) throw new Error(`refused a recoverable state: ${JSON.stringify(out)}`);
  if (inbound.revoked.length !== 3) {
    throw new Error(`expected the three old ids revoked, got ${JSON.stringify(inbound.revoked)}`);
  }
  if (calls.length !== 2) throw new Error(`unexpected requests: ${JSON.stringify(calls.map((c) => c.url))}`);
});

await check("a leftover endpoint that could not be revoked says a retry may work, and not that it landed", async () => {
  // The reachable half of enable_push's cleanup: the revoke failed, so nothing
  // was created and nothing landed, and the sentence invites another attempt.
  one(json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: "Release Bot", serverId: "server-1" }));
  const refuses = {
    api: {
      create: async () => ({ hookId: "hook-9", url: "https://hooks.example/hook-9", secret: "s" }),
      revoke: async () => { throw new Error("revoke refused"); },
    },
    revoked: [] as string[],
  };
  const m = mount({ hookId: null, staleHookIds: ["hook-old"], registration: null, lastReached: null }, refuses);
  const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
  if (!/could not be cleaned up/.test(why.message)) throw new Error(`a different failure: ${why.message}`);
  if (why.transient !== true) throw new Error(`does not invite the retry its sentence asks for: ${why.transient}`);
  if (why.mayHaveLanded !== undefined) throw new Error(`claimed something may have landed: ${why.mayHaveLanded}`);
});

globalThis.fetch = originalFetch;
console.log(`\n  raft plugin\n  ${"─".repeat(56)}`);
for (const result of results) {
  console.log(result.ok ? `  \x1b[32m✓\x1b[0m ${result.name}` : `  \x1b[31m✗\x1b[0m ${result.name}\n      \x1b[31m${result.error}\x1b[0m`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
