// A personal assistant acting as its owner (src/plugins/raft-assistant-owner-actions.ts): one tool per action Raft lists
// in `assistantOf.ownerActions`, made from Raft's own name, description and parameters; only known tiers; only in the
// owner's chat; and Raft's answer handed to the model as Raft wrote it.
//
// The real plugin over a real plugin database and the real SDK (0.33.0 `raft.assistant.ownerActions`), with Raft as a
// fake `fetch` shaped like its contract, as test/raft-assistant-mode.ts does.
//
//   node test/raft-assistant-owner-actions.ts
import { raftPlugin } from "../src/plugins/raft.ts";
import { toolsOf } from "../src/plugins/types.ts";
import { admitTools } from "../src/runtime/mount-tools.ts";
import { assistantTools, CHAT_TOOLS, CHECK_TOOLS } from "../src/plugins/raft-assistant.ts";
import {
  OWNER_ACTION_MARK, OWNER_ACTION_TIERS, answerOf, ownerActionNames, ownerActionTools, ownerActionsOf, toolOf,
} from "../src/plugins/raft-assistant-owner-actions.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { newIsolatedSessionId } from "../src/runtime/isolated-session.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---- Raft's owner actions, as a context lists them ------------------------------------------------------------------

/** Each text is marked, so a test can tell Raft's words from anything this repository wrote. */
const SAVE = {
  tool: "save_message", tier: "direct", description: "RAFT-DESC save: save or unsave one message for your owner.",
  method: "POST", path: "/api/servers/:id/saved-messages",
  params: [
    { name: "message", kind: "text", description: "RAFT-PARAM message: the message id." },
    { name: "saved", kind: "boolean", description: "RAFT-PARAM saved: true to save, false to unsave." },
  ],
  mapping: [{ param: "message", into: "body", field: "messageId" }, { param: "saved", into: "body", field: "saved" }],
};
const LEVEL = {
  tool: "set_notification_level", tier: "direct", description: "RAFT-DESC level: how much your owner hears from the server.",
  method: "PUT", path: "/api/servers/:id/notification-level",
  params: [{ name: "level", kind: "enum", values: ["all", "mentions", "none"], description: "RAFT-PARAM level." }],
  mapping: [{ param: "level", into: "body", field: "level" }],
};
const MOVE = {
  tool: "move_agent", tier: "confirm", description: "RAFT-DESC move: move one of your owner's agents to another computer, once they confirm.",
  method: "POST", path: "/api/agents/:agentId/move",
  params: [
    { name: "agent", kind: "agent", description: "RAFT-PARAM agent: @name." },
    { name: "computer", kind: "text", description: "RAFT-PARAM computer: its name." },
  ],
  mapping: [{ param: "agent", into: "path", field: "agentId" }, { param: "computer", into: "body", field: "computer" }],
};
const CHANNELS = {
  tool: "list_owner_channels", tier: "read", description: "RAFT-DESC channels: the channels your owner is in.",
  method: "GET", path: "/api/servers/:id/assistant/owner-channels",
  params: [{ name: "filter", kind: "text", description: "RAFT-PARAM filter: words in the name.", optional: true }],
  mapping: [{ param: "filter", into: "query", field: "filter" }],
};
/** A tier a newer Raft added: neither this SDK nor this file knows it. */
const FUTURE = {
  tool: "delete_owner_account", tier: "irreversible", description: "RAFT-DESC future.", method: "DELETE", path: "/api/me",
  params: [], mapping: [],
};
const ALL = [SAVE, LEVEL, MOVE, CHANNELS, FUTURE];
const MADE = ["save_message", "set_notification_level", "move_agent", "list_owner_channels"];

/** Raft's answers, marked; each has text over several lines, so a cut or a fold shows. */
const SAVE_ANSWER = { ok: true, assistant: { done: "RAFT-DONE Saved the message for Ada.", undo: { tool: "save_message", args: { message: "m-1", saved: false }, text: "RAFT-UNDO To unsave it,\ncall save_message with saved false." } } };
const CARD_TEXT = "RAFT-CARD Not done yet: Ada has a card in your DM to confirm moving @bot to box-2.\nIt expires in 10 minutes.\n— nothing has run.";
const CARD_AGAIN = "RAFT-CARD Already waiting for Ada to confirm moving @bot to box-2.\nSame card as before.";
const READ_TEXT = "──── begin: Ada's channels (RAFT) ────\n#design  member\n#eng  member\n" + "x".repeat(6000) + "\n──── end ────";

interface Raft {
  /** The context's `ownerActions`; null leaves the field out, as a Server without the routes does. */
  actions: unknown[] | null; contexts: number; contextOk: number;
  calls: Array<{ method: string; path: string; query: string; body: any }>;
  resolves: string[];
  answers: Record<string, Array<() => Response>>;
}

function raft(actions: unknown[] | null = ALL): Raft {
  const r: Raft = { actions, contexts: 0, contextOk: Infinity, calls: [], resolves: [], answers: {} };
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = new URL(String(url));
    const path = u.pathname.replace("/internal/agent-api", "");
    if (path === "/context") {
      r.contexts++;
      if (r.contexts > r.contextOk) return json(503, { error: "unavailable" });
      return json(200, {
        agent: { id: "agent-1", name: "ada-assistant", displayName: null, description: null, runtime: "external", external: true,
          assistantOf: { userId: "u-ada", name: "ada", displayName: "Ada", ...(r.actions !== null ? { ownerActions: r.actions } : {}) } },
        server: { id: "server-1", slug: "s", name: "S" }, credential: { capabilities: ["read", "send"] }, prompt: null,
      });
    }
    if (path === "/assistant/owner-resolve") {
      const name = u.searchParams.get("name") ?? "";
      r.resolves.push(name);
      if (name === "@bot~agent") return json(200, { id: "ag-9", type: "agent", name: "bot" });
      return json(404, { error: "not found", code: "owner_resolve_not_found" });
    }
    if (u.pathname.startsWith("/api/")) {
      r.calls.push({ method: init?.method ?? "GET", path: u.pathname, query: u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const next = r.answers[u.pathname]?.shift();
      return next ? next() : json(500, { error: "no answer scripted" });
    }
    return json(404, { error: "not found", code: "NOT_FOUND" });
  }) as any;
  return r;
}

/** One raft mount over a real database; `traced` keeps its trace rows. The chat (`main`) unless `session` says otherwise. */
function mount(offered?: readonly string[], session = "main", fromProgram = false) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "tenant", agentId: "agent", alias: "raft", plugin: raftPlugin.id };
  const traced: Array<{ kind: string; status: string; verdict?: string; attrs: Record<string, any> }> = [];
  const ctx = {
    caller: { tenantId: "tenant", agentId: "agent", taskId: session, contextId: "ctx_turn", ...(fromProgram ? { fromProgram: true } : {}) },
    alias: "raft", credential: "sk_agent_test_1234567890", publicConfig: { serverUrl: "https://raft.example" },
    db: openPluginDatabase(tables, scope, raftPlugin.database), ...(offered ? { offered } : {}),
    sibling: async () => null, sandboxForms: async () => [], trace: (row: any) => traced.push(row),
  } as any;
  return { ctx, traced };
}

const BASE: any = { tenantId: "t", agentId: "a", alias: "raft", plugin: "raft" };
/** The listing, admitted as the kernel keeps it, and what the mount then offers. */
async function listed(r: Raft) {
  const m = mount();
  const out = await raftPlugin.snapshotTools!(m.ctx);
  const snapshot = await admitTools(out, 0);
  const offered = toolsOf(raftPlugin, { ...BASE, toolSnapshot: snapshot });
  return { out, snapshot, offered, traced: m.traced, r };
}
const named = (tools: ReadonlyArray<{ name: string }>, n: string) => tools.find((t) => t.name === n) as any;

// ---- the tools --------------------------------------------------------------------------------------------------------

await check("each owner action becomes one tool with Raft's name, description and parameter descriptions verbatim; optional params are not required", async () => {
  const { offered, snapshot } = await listed(raft());
  const names = offered.map((t) => t.name);
  must(MADE.every((n) => names.includes(n)), `made: ${names.filter((n) => !CHAT_TOOLS.includes(n))}`);
  for (const a of [SAVE, LEVEL, MOVE, CHANNELS]) {
    const t = named(offered, a.tool);
    must(t.summary === a.description, `${a.tool}: summary ${show(t.summary)}`);
    const props = t.parameters.properties;
    must(show(Object.keys(props)) === show(a.params.map((p) => p.name)), `${a.tool}: params ${show(Object.keys(props))}`);
    for (const p of a.params) must(props[p.name].description === p.description, `${a.tool}.${p.name}: ${show(props[p.name])}`);
    must(show(t.parameters.required) === show(a.params.filter((p) => !(p as { optional?: boolean }).optional).map((p) => p.name)), `${a.tool}: required ${show(t.parameters.required)}`);
    // The mark is the snapshot's alone: the offered tool does not carry it, and is model-only.
    must(!(OWNER_ACTION_MARK in t.parameters) && t.modelOnly === true, `${a.tool}: offered as ${show(t)}`);
    must(named(snapshot.tools, a.tool).parameters[OWNER_ACTION_MARK] === a.tier, `${a.tool}: the snapshot's mark`);
  }
  // Kinds as JSON types where there is one; the enum's values are Raft's.
  must(named(offered, "save_message").parameters.properties.saved.type === "boolean", "boolean");
  must(show(named(offered, "set_notification_level").parameters.properties.level.enum) === show(["all", "mentions", "none"]), "enum");
  must(named(offered, "move_agent").parameters.properties.agent.type === "string", "agent");
  must(show(named(offered, "list_owner_channels").parameters.required) === "[]", "the optional filter is required");
  // A read is a read; every other tier is a write.
  must(named(offered, "list_owner_channels").sideEffects === "read" && named(offered, "move_agent").sideEffects === "write" && named(offered, "save_message").sideEffects === "write", "sideEffects");
});

await check("an entry with an unknown tier makes no tool and is counted filtered: the SDK's skipped, and this file's own filter for a tier the SDK lists", async () => {
  const { offered, traced } = await listed(raft());
  must(!offered.some((t) => t.name === FUTURE.tool), "the unknown tier was offered");
  const row = traced.find((t) => t.kind === "raft.assistant_owner_actions" && t.status === "listed");
  must(row && row.attrs.entries === 5 && row.attrs.generated === 4 && row.attrs.filtered === 1 && row.attrs.sdk_skipped === 1 && row.attrs.unknown_tier === 0 &&
    row.attrs.direct === 2 && row.attrs.confirm === 1 && row.attrs.read === 1 && row.attrs.left_out === "delete_owner_account:irreversible:sdk_skipped", `listed row: ${show(row)}`);
  // A tier the SDK lists but this file does not know (a newer SDK's) is left out here too.
  const own = ownerActionTools([SAVE, FUTURE], { actions: [SAVE, FUTURE] as any, skipped: [] }, () => false);
  must(show(own.tools.map((t) => t.name)) === show(["save_message"]) && show(own.filtered) === show([{ tool: FUTURE.tool, tier: FUTURE.tier, why: "unknown_tier" }]), show(own));
  // Control: the known tiers are exactly three.
  must(show(OWNER_ACTION_TIERS) === show(["direct", "confirm", "read"]), show(OWNER_ACTION_TIERS));
});

await check("an entry named like one of the plugin's own tools, or in the MCP namespace, is left out as name_taken; a marked snapshot tool under such a name is not offered", async () => {
  const clash = { ...SAVE, tool: "messages_send" }, mcp = { ...SAVE, tool: "mcp_x__y" };
  const { offered, traced } = await listed(raft([SAVE, clash, mcp]));
  must(named(offered, "messages_send")?.summary !== SAVE.description, "an owner action replaced messages_send");
  must(!offered.some((t) => t.name === "mcp_x__y"), "an owner action took the MCP namespace");
  const row = traced.find((t) => t.kind === "raft.assistant_owner_actions");
  must(row?.attrs.name_taken === 2 && row.attrs.generated === 1, show(row));
  const marked = { ...toolOf(SAVE as any), name: "messages_send" };
  must(ownerActionsOf([marked], (n) => n === "messages_send").length === 0, "reserved name offered");
});

await check("no ownerActions in the context, or an empty list: no owner tools, no second context read, a listed row of zeros", async () => {
  for (const [what, actions] of [["absent", null], ["empty", []]] as const) {
    const r = raft(actions as unknown[] | null);
    const { offered, traced, snapshot } = await listed(r);
    must(r.contexts === 1, `${what}: context reads ${r.contexts}`);
    must(!offered.some((t) => MADE.includes(t.name)) && ownerActionNames(snapshot).length === 0, `${what}: ${offered.map((t) => t.name)}`);
    const row = traced.find((t) => t.kind === "raft.assistant_owner_actions");
    must(row?.status === "listed" && row.attrs.entries === 0 && row.attrs.generated === 0 && row.attrs.filtered === 0, `${what}: ${show(row)}`);
  }
  // Control: with entries, the SDK reads the context a second time.
  const r = raft();
  await listed(r);
  must(r.contexts === 2, `with entries: ${r.contexts}`);
});

await check("a second context read that fails fails the listing, so the stored list stays, rather than dropping the owner's tools", async () => {
  const r = raft();
  r.contextOk = 1;
  let threw = false;
  try { await raftPlugin.snapshotTools!(mount().ctx); } catch { threw = true; }
  must(threw, "the listing went through with the owner actions gone");
});

// ---- chat only ---------------------------------------------------------------------------------------------------------

await check("only in the chat: assistantTools adds owner actions to the chat's list and never to a check's, even when handed them", () => {
  const catalogue = ["raft.receive_events", "raft.assistant_notify_owner", "raft.save_message", "raft.move_agent", "state.get"].map((address) => ({ address }));
  const chat = assistantTools(catalogue, "raft", "chat", "state", ["save_message", "move_agent"]).map((t) => t.address);
  must(chat.includes("raft.save_message") && chat.includes("raft.move_agent"), `chat: ${chat}`);
  const check_ = assistantTools(catalogue, "raft", "check", "state", ["save_message", "move_agent"]).map((t) => t.address);
  must(!check_.includes("raft.save_message") && !check_.includes("raft.move_agent") && check_.includes("raft.assistant_notify_owner"), `check: ${check_}`);
  // Control: without the names, the chat has none either (they are not in CHAT_TOOLS).
  must(!assistantTools(catalogue, "raft", "chat", "state").some((t) => t.address === "raft.save_message"), "CHAT_TOOLS names an owner action");
  must(!CHECK_TOOLS.some((n) => MADE.includes(n)), "CHECK_TOOLS names an owner action");
});

await check("only in the chat: a call from a check's short session, another session, or a program is refused before any request to Raft", async () => {
  const when = "save_message works only while you are replying in your chat with your owner.";
  for (const [what, session, program, said] of [
    // A check can still tell the owner (assistant_notify_owner), so it is pointed there.
    ["check", newIsolatedSessionId(), false, `${when} Here, leave it undone; if it still needs doing, say so to your owner in that chat.`],
    // Another session cannot reach the owner: it only leaves it undone.
    ["agents API session", "sess_abc", false, `${when} Leave it undone.`],
    // A program in the chat is in the chat already; what it lacks is being the model's own call.
    ["program", "main", true, "save_message works only when you call it yourself, not from a program. Call it directly in your reply to your owner."],
  ] as const) {
    const r = raft();
    const m = mount(MADE, session, program);
    let error = "";
    try { await raftPlugin.invoke("save_message", { message: "m-1", saved: true }, m.ctx); } catch (e) { error = String((e as Error).message); }
    must(error === said, `${what}: ${error}`);
    must(r.calls.length === 0 && r.contexts === 0, `${what}: reached Raft: ${show(r.calls)} contexts ${r.contexts}`);
    const row = m.traced.find((t) => t.kind === "raft.assistant_owner_actions");
    must(row?.status === "called" && row.attrs.result === "refused:not_chat" && row.verdict === "blocked", `${what}: ${show(row)}`);
  }
});

await check("a name the mount's list does not offer is not an owner action: the plugin's unknown tool, nothing sent", async () => {
  const r = raft();
  let error = "";
  try { await raftPlugin.invoke("save_message", {}, mount(["receive_events"]).ctx); } catch (e) { error = String((e as Error).message); }
  must(error === "unknown raft tool: save_message" && r.calls.length === 0, `${error} ${show(r.calls)}`);
});

// ---- what the model reads ----------------------------------------------------------------------------------------------

/** One call in the chat, offered every owner action; Raft answers `path` with `answers` in turn. */
async function call(r: Raft, tool: string, args: Record<string, unknown>) {
  const m = mount(MADE);
  const out = await raftPlugin.invoke(tool, args, m.ctx) as any;
  return { out, traced: m.traced };
}

await check("direct: the result is Raft's assistant block verbatim (done and undo, line breaks and all), sent once to the owner's route", async () => {
  const r = raft();
  r.answers["/api/servers/server-1/saved-messages"] = [() => json(200, SAVE_ANSWER)];
  const { out, traced } = await call(r, "save_message", { message: "m-1", saved: true });
  must(show(out) === show({ ok: true, status: 200, assistant: SAVE_ANSWER.assistant }), `out: ${show(out)}`);
  must(r.calls.length === 1 && r.calls[0]!.method === "POST" && show(r.calls[0]!.body) === show({ messageId: "m-1", saved: true }), show(r.calls));
  const row = traced.find((t) => t.kind === "raft.assistant_owner_actions");
  must(row?.status === "called" && row.attrs.tool === "save_message" && row.attrs.result === "ok" && row.attrs.status === 200, show(row));
  must(!show(row).includes("m-1") && !show(row).includes("RAFT-DONE"), `the row carries an argument or Raft's text: ${show(row)}`);
});

await check("confirm: 202 is Raft's pending block with its text verbatim; the same call again is Raft's same-card text; a declined one is Raft's 409 error verbatim", async () => {
  const r = raft();
  const pending = { state: "pending_owner_confirm", text: CARD_TEXT, cardMessageId: "msg-card-1", expiresAt: "2026-11-05T12:10:00Z" };
  r.answers["/api/agents/ag-9/move"] = [
    () => json(202, { assistant: pending }),
    () => json(202, { assistant: { ...pending, text: CARD_AGAIN } }),
    () => json(409, { error: "RAFT-DECLINED Ada declined moving @bot to box-2.\nAsk again only after Ada writes to you.", code: "owner_declined" }),
  ];
  const first = await call(r, "move_agent", { agent: "@bot", computer: "box-2" });
  must(show(first.out) === show({ ok: true, status: 202, assistant: pending }), `first: ${show(first.out)}`);
  must(first.out.assistant.text === CARD_TEXT, "the card text changed");
  must(r.resolves.includes("@bot~agent") && show(r.calls[0]!.body) === show({ computer: "box-2" }), `resolved: ${show(r.resolves)} ${show(r.calls)}`);
  must(first.traced.find((t) => t.kind === "raft.assistant_owner_actions")?.attrs.state === "pending_owner_confirm", "the row's state");
  const again = await call(r, "move_agent", { agent: "@bot", computer: "box-2" });
  must(again.out.status === 202 && again.out.assistant.text === CARD_AGAIN, `again: ${show(again.out)}`);
  const declined = await call(r, "move_agent", { agent: "@bot", computer: "box-2" });
  must(show(declined.out) === show({ ok: false, error: "RAFT-DECLINED Ada declined moving @bot to box-2.\nAsk again only after Ada writes to you.", code: "HTTP_ERROR", status: 409, errorCode: "owner_declined" }),
    `declined: ${show(declined.out)}`);
  const row = declined.traced.find((t) => t.kind === "raft.assistant_owner_actions");
  must(row?.attrs.result === "HTTP_ERROR" && row.attrs.status === 409 && row.attrs.error_code === "owner_declined" && row.verdict === "failed", show(row));
});

await check("read: a GET with the optional filter as the only query (none when left out); Raft's text whole, with omitted and omittedReason as Raft sent them", async () => {
  const r = raft();
  const reason = "RAFT-OMITTED Ada keeps her DMs from you, so DMs are left out.";
  r.answers["/api/servers/server-1/assistant/owner-channels"] = [
    () => json(200, { assistant: { text: READ_TEXT }, omitted: "assistant_reads_dms_off", omittedReason: reason }),
    () => json(200, { assistant: { text: READ_TEXT } }),
  ];
  const filtered = await call(r, "list_owner_channels", { filter: "des" });
  must(show(filtered.out) === show({ ok: true, status: 200, assistant: { text: READ_TEXT, omitted: "assistant_reads_dms_off", omittedReason: reason } }), `filtered: ${show(filtered.out).slice(0, 300)}`);
  must(filtered.out.assistant.text.length === READ_TEXT.length, "the read text was cut");
  must(r.calls[0]!.method === "GET" && r.calls[0]!.query === "?filter=des" && r.calls[0]!.body === undefined, show(r.calls[0]));
  const all = await call(r, "list_owner_channels", {});
  must(all.out.assistant.text === READ_TEXT && !("omitted" in all.out.assistant), show(all.out).slice(0, 200));
  must(r.calls[1]!.query === "", `no filter, yet: ${r.calls[1]!.query}`);
});

await check("a route's refusal: Raft's error text verbatim, with the SDK's code, the HTTP status and Raft's code", async () => {
  const r = raft();
  const error = "RAFT-403 Ada's assistant may not change her notification level on this server.";
  r.answers["/api/servers/server-1/notification-level"] = [() => json(403, { error, code: "assistant_route_not_allowed" })];
  const { out } = await call(r, "set_notification_level", { level: "none" });
  must(show(out) === show({ ok: false, error, code: "HTTP_ERROR", status: 403, errorCode: "assistant_route_not_allowed" }), show(out));
});

await check("answerOf: a success without an assistant block is the SDK's text; omitted already in the block is not replaced", () => {
  must(show(answerOf({ ok: true, status: 200, assistant: null, data: {}, text: "save_message done." })) === show({ ok: true, status: 200, assistant: { text: "save_message done." } }), "no block");
  const block = { text: "T", omitted: "in-block" };
  must(show(answerOf({ ok: true, status: 200, assistant: block, data: { omitted: "top" }, text: "T" })) === show({ ok: true, status: 200, assistant: block }), "omitted replaced");
});

await check("a tool the SDK no longer knows (Raft dropped it since the listing) is the SDK's text, and the mount is listed again at the next turn", async () => {
  const r = raft();
  const m = mount([...MADE, "gone_action"]);
  const out = await raftPlugin.invoke("gone_action", {}, m.ctx) as any;
  must(out.ok === false && out.code === "UNKNOWN_TOOL" && /^No owner action named gone_action\./.test(out.error), show(out));
  const snap = { hash: "h", tools: [], skipped: [], takenAt: Date.now() };
  must(raftPlugin.toolsDue!({ ...BASE, tenantId: "tenant", agentId: "agent", secretRef: "agent:x", toolSnapshot: snap } as any, Date.now()) === true, "not due again");
  must(r.calls.length === 0, show(r.calls));
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
