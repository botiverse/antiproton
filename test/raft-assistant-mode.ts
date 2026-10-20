// A personal assistant that speaks first (Raft RFC 075 §4.2; src/plugins/raft-assistant.ts): the rules its code keeps
// whatever the model does — each item told once, the owner's reminder rules, nothing at night, one message per wake —
// the morning brief's timer, the pause on `403 assistant_not_enabled`, the doorbell, and what the runtime offers an
// assistant's model (its tools, its prompt, no subagents).
//
// The real plugin over a real plugin database (node:sqlite) and the real SDK, with Raft as a fake `fetch` shaped like
// its contract, as test/raft-plugin.ts does; the runtime rows drive the real `AgentRuntime` as test/stable-prompt.ts does.
//
//   node test/raft-assistant-mode.ts
import { createHmac } from "node:crypto";
import { raftPlugin, wakeInstruction } from "../src/plugins/raft.ts";
import {
  ASSISTANT_MODE_TOOLS, ASSISTANT_STORE, DEFERRED_KEY, OWNER_KEY, REMINDED_STORE, assistantMountOf, assistantPrompt, assistantWakeInstruction, isQuietHours,
  itemOf, localDay, nextBriefAt, zoneOf,
} from "../src/plugins/raft-assistant.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";
import { operatorModelOf } from "../cf/src/model-request.ts";
import { fromResponse } from "../src/model/pi-bridge.ts";
import type { ModelResponse } from "../src/model/types.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): void { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const at = (iso: string) => Date.parse(iso);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---- the owner's clock --------------------------------------------------------------------------------------------------

await check("night is 22:00-08:00 owner-local, edges included and excluded as said", () => {
  // Berlin is UTC+2 until 2026-10-25.
  for (const [iso, quiet] of [
    ["2026-10-20T19:59:00Z", false], ["2026-10-20T20:00:00Z", true], ["2026-10-20T05:59:00Z", true], ["2026-10-20T06:00:00Z", false],
  ] as const) must(isQuietHours(at(iso), "Europe/Berlin") === quiet, `${iso} Berlin: ${!quiet}`);
  must(isQuietHours(at("2026-10-20T23:00:00Z"), "UTC") && !isQuietHours(at("2026-10-20T12:00:00Z"), "UTC"), "UTC");
});

await check("the next brief is the next 08:00 owner-local, strictly after now, across a DST change", () => {
  for (const [now, zone, want] of [
    ["2026-10-20T05:00:00Z", "Europe/Berlin", "2026-10-20T06:00:00.000Z"],
    // Saturday 09:00 CEST; Sunday 08:00 is CET, after the clocks went back.
    ["2026-10-24T07:00:00Z", "Europe/Berlin", "2026-10-25T07:00:00.000Z"],
    ["2026-10-20T08:00:00Z", "UTC", "2026-10-21T08:00:00.000Z"],
    ["2026-10-20T20:00:00Z", "America/Los_Angeles", "2026-10-21T15:00:00.000Z"],
    ["2026-10-20T23:30:00Z", "Asia/Shanghai", "2026-10-21T00:00:00.000Z"],
  ] as const) {
    const got = new Date(nextBriefAt(at(now), zone)).toISOString();
    must(got === want, `${now} ${zone}: ${got}, want ${want}`);
  }
  must(localDay(at("2026-10-20T23:30:00Z"), "Asia/Shanghai") === "2026-10-21", "local day");
  must(zoneOf({ timezone: null, statedTimezone: null }) === "UTC" && zoneOf({ timezone: null, statedTimezone: "Asia/Tokyo" }) === "Asia/Tokyo" &&
    zoneOf({ timezone: "Europe/Paris", statedTimezone: "Asia/Tokyo" }) === "Europe/Paris", "zone precedence: Raft's, then the owner's word, then UTC");
});

await check("an item's reference must be clickable, and its key is the message's short id or the task", () => {
  const msg = itemOf({ ref: "#launch:ABCDEF12-3456", summary: "  Bob asks\nfor a date ", kind: "question" });
  must(typeof msg !== "string" && msg.key === "msg:abcdef12" && msg.channel === "launch" && msg.summary === "Bob asks for a date", show(msg));
  const short = itemOf({ ref: "#launch:abcdef12", summary: "s", kind: "review" });
  must(typeof short !== "string" && short.key === "msg:abcdef12", "a short and a full id are one item");
  const task = itemOf({ ref: "task #12", summary: "s", kind: "task", channel: "#eng" });
  must(typeof task !== "string" && task.key === "task:eng#12", show(task));
  const prefixed = itemOf({ ref: "#eng task #12", summary: "s", kind: "task" });
  must(typeof prefixed !== "string" && prefixed.key === "task:eng#12", show(prefixed));
  for (const bad of [{ ref: "https://x", summary: "s", kind: "task" }, { ref: "#launch", summary: "s", kind: "task" }, { ref: "#a:abcdef12", summary: "", kind: "task" }, { ref: "#a:abcdef12", summary: "s", kind: "fyi" }]) {
    must(typeof itemOf(bad) === "string", `accepted: ${show(bad)}`);
  }
});

// ---- the plugin, end to end -----------------------------------------------------------------------------------------

const OWNER = "7a0e1b2c-3d4e-4f50-8a61-72839405a6b7";
const ALL_TOOLS = raftPlugin.tools.map((t) => t.name);

/** Raft as an assistant's credential meets it: its context, its owner DM, its events, the owner inbox. */
function raft(o: { zone?: unknown; owner?: boolean } = {}) {
  const r = {
    owner: o.owner ?? true, zone: "zone" in o ? o.zone : "Europe/Berlin", contextStatus: 200,
    sends: [] as any[], send: "sent" as "sent" | "held", events: [] as unknown[], inbox: 200, contexts: 0,
  };
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = new URL(String(url));
    const path = u.pathname.replace("/internal/agent-api", "");
    if (path === "/context") {
      r.contexts++;
      if (r.contextStatus !== 200) return json(r.contextStatus, { error: "no", code: "forbidden" });
      return json(200, {
        agent: { id: "agent-1", name: "ada-assistant", displayName: null, description: null, runtime: "external", external: true,
          assistantOf: r.owner ? { userId: OWNER, ...(r.zone !== undefined ? { timezone: r.zone } : {}) } : null },
        server: { id: "server-1", slug: "s", name: "S" }, credential: { capabilities: ["read", "send", "reactions"] }, prompt: null,
      });
    }
    if (path === "/v2/send") {
      r.sends.push(JSON.parse(String(init?.body ?? "{}")));
      if (r.send === "held") {
        return json(200, { ok: true, state: "held", newMessageCount: 1, seenUpToSeq: 20, omittedMessageCount: 0, freshnessContextMode: "inline",
          heldMessages: [{ seq: 20, id: "abcdef12-0000", content: "also, the budget?", sender_type: "human", sender_name: "ada", channel_name: "ada", channel_type: "dm", timestamp: "2026-10-20T10:00:00Z" }] });
      }
      return json(200, { ok: true, state: "sent", messageId: `m-${r.sends.length}`, messageSeq: 30 + r.sends.length });
    }
    if (path === "/events") {
      return json(200, { events: r.events.splice(0), last_seen_msgId: null, last_seen_seq: null, reply_target: null, has_more: false, ack_mode: "cursor" });
    }
    if (path === "/assistant/owner-inbox") {
      return r.inbox === 200 ? json(200, { owner: { userId: OWNER }, filter: "unread", items: [], hasMore: false, nextOffset: null })
        : json(r.inbox, { code: "assistant_not_enabled" });
    }
    return json(404, { error: "not found", code: "NOT_FOUND" });
  }) as any;
  return r;
}

/** One assistant's raft mount: a real database, offered every tool (so the notify tool is offered), in a model turn. */
function mount(offered: readonly string[] = ALL_TOOLS) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "tenant", agentId: "agent", alias: "raft", plugin: raftPlugin.id };
  const ctx = {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "ctx_turn" },
    alias: "raft", credential: "sk_agent_test_1234567890", publicConfig: { serverUrl: "https://raft.example" },
    db: openPluginDatabase(tables, scope, raftPlugin.database), offered,
    sibling: async () => null, sandboxForms: async () => [],
  } as any;
  const read = (store: string, key: string) => tables.get(scope, store, key) as any;
  return { ctx, read };
}

/** A mount whose listing has run against `r`: the owner kept, as the runtime's listing keeps it. */
async function assistant(r = raft(), offered?: readonly string[]) {
  const m = mount(offered);
  const listed = await raftPlugin.snapshotTools!(m.ctx);
  must(listed.tools.some((t) => t.name === "assistant_notify_owner"), `control: the listing offers the notify tool: ${listed.tools.map((t) => t.name)}`);
  return { ...m, r };
}

/** Run the plugin's code at a given moment. */
async function atTime<T>(iso: string, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => at(iso);
  try { return await fn(); } finally { Date.now = real; }
}

const notify = (ctx: unknown, args: unknown) => raftPlugin.invoke("assistant_notify_owner", args, ctx as never) as Promise<any>;
const ITEMS = [
  { ref: "#launch:aaaaaaa1", summary: "Bob asks you to pick the launch date", kind: "decision", sender: "@bob", since: "2026-10-20T07:00:00Z" },
  { ref: "task #7", channel: "eng", summary: "Review the rollout plan", kind: "task" },
];
const DAY = "2026-10-20T10:00:00Z"; // 12:00 in Berlin
const NIGHT = "2026-10-20T21:00:00Z"; // 23:00 in Berlin

await check("the listing keeps the owner with Raft's zone; an invalid or missing zone is null; a context with no owner drops the record", async () => {
  const a = await assistant(raft({ zone: "Europe/Berlin" }));
  const kept = a.read(ASSISTANT_STORE, OWNER_KEY);
  must(kept.userId === OWNER && kept.timezone === "Europe/Berlin" && kept.serverId === "server-1" && kept.pausedAt === null, show(kept));
  for (const zone of [undefined, null, "Mars/Olympus", 7]) {
    const b = await assistant(raft({ zone }));
    must(b.read(ASSISTANT_STORE, OWNER_KEY).timezone === null, `${show(zone)}: ${show(b.read(ASSISTANT_STORE, OWNER_KEY))}`);
  }
  raft({ owner: false });
  const after = await raftPlugin.snapshotTools!(a.ctx);
  must(!after.tools.some((t) => t.name.startsWith("assistant_")), "no owner: no assistant tools");
  must(a.read(ASSISTANT_STORE, OWNER_KEY) === undefined, `the record outlived the owner: ${show(a.read(ASSISTANT_STORE, OWNER_KEY))}`);
});

await check("several items in one call go out as one DM with a reference each; the same items again send nothing", async () => {
  const a = await assistant();
  const first = await atTime(DAY, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }));
  must(first.state === "sent" && first.items === 2 && a.r.sends.length === 1, `first: ${show(first)} sends ${a.r.sends.length}`);
  const sent = a.r.sends[0];
  must(sent.target === "dm:@ada" && sent.content.includes("#launch:aaaaaaa1") && sent.content.includes("task #7") &&
    sent.content.startsWith("2 things are waiting on you:") && sent.content.includes("(waiting 3h)"), `content: ${show(sent)}`);
  must(a.read(REMINDED_STORE, "msg:aaaaaaa1") && a.read(REMINDED_STORE, "task:eng#7"), "what was said is recorded");
  // Again, as a second doorbell or a rebuilt context would: dropped in code, nothing reaches Raft.
  const again = await atTime(DAY, () => notify(a.ctx, { items: ITEMS }));
  must(again.state === "nothing_to_send" && a.r.sends.length === 1, `again: ${show(again)} sends ${a.r.sends.length}`);
  must(again.dropped["#launch:aaaaaaa1"] === "already told" && again.dropped["task #7"] === "already told", show(again.dropped));
  // One new item beside an old one: only the new one, and the DM learnt from the first call is used without a target.
  const mixed = await atTime(DAY, () => notify(a.ctx, { items: [ITEMS[0], { ref: "#launch:bbbbbbb2", summary: "Cy asks for a review", kind: "review" }] }));
  must(mixed.state === "sent" && mixed.items === 1 && a.r.sends.length === 2 && a.r.sends[1].target === "dm:@ada" &&
    a.r.sends[1].content.startsWith("One thing is waiting on you:") && !a.r.sends[1].content.includes("aaaaaaa1"), `mixed: ${show(mixed)} ${show(a.r.sends[1])}`);
});

await check("an owner's DM not known yet is asked for, not guessed; a held send records nothing and says to read the DM first", async () => {
  const a = await assistant();
  const unknown = await atTime(DAY, () => notify(a.ctx, { items: ITEMS }).then(() => null, (e) => e as Error));
  must(unknown && /DM is not known yet/.test(unknown.message) && a.r.sends.length === 0, `no target: ${unknown?.message}`);
  a.r.send = "held";
  const held = await atTime(DAY, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }));
  must(held.state === "not_sent" && a.r.sends.length === 1 && a.read(REMINDED_STORE, "msg:aaaaaaa1") === undefined, `held: ${show(held)}`);
  a.r.send = "sent";
  const sent = await atTime(DAY, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }));
  must(sent.state === "sent" && a.r.sends.length === 2 && a.r.sends[1].idempotencyKey === a.r.sends[0].idempotencyKey,
    `the same items go under the same key: ${show(a.r.sends.map((s: any) => s.idempotencyKey))}`);
});

await check("reminder rules: a muted channel, sender or kind is dropped in code; unmute lets it through; list shows them", async () => {
  const a = await assistant();
  const pref = (args: unknown) => raftPlugin.invoke("assistant_preferences", args, a.ctx) as Promise<any>;
  const added = await pref({ action: "mute", channel: "#launch", note: "launch is not mine" });
  must(added.state === "added" && added.rule.channel === "launch" && added.rule.id === "r1", show(added));
  must((await pref({ action: "mute", sender: "@cy", kind: "review" })).rule.id === "r2", "second rule");
  must((await pref({ action: "mute", channel: "launch" })).state === "exists", "the same rule twice is one");
  const out = await atTime(DAY, () => notify(a.ctx, { items: [...ITEMS, { ref: "#ops:ccccccc3", summary: "Cy wants a review", kind: "review", sender: "cy" }], target: "dm:@ada" }));
  must(out.state === "sent" && out.items === 1 && out.dropped["#launch:aaaaaaa1"] === "rule r1" && out.dropped["#ops:ccccccc3"] === "rule r2", show(out));
  must(!a.r.sends[0].content.includes("aaaaaaa1") && a.r.sends[0].content.includes("task #7"), show(a.r.sends[0]));
  // A muted item is not recorded as told: unmuted, it goes out.
  must((await pref({ action: "unmute", id: "r1" })).state === "removed", "unmute");
  const listed = await pref({ action: "list" });
  must(listed.rules.length === 1 && listed.rules[0].id === "r2", show(listed));
  const later = await atTime(DAY, () => notify(a.ctx, { items: [ITEMS[0]] }));
  must(later.state === "sent" && a.r.sends.length === 2, show(later));
  for (const bad of [{ action: "mute" }, { action: "mute", kind: "fyi" }, { action: "unmute", id: "r9" }, { action: "timezone", timezone: "Nowhere/Land" }]) {
    must(await pref(bad).then(() => false, () => true), `accepted: ${show(bad)}`);
  }
});

await check("at night nothing is sent: the items are kept for the brief, and `brief: true` from the model does not get round it", async () => {
  const a = await assistant();
  const night = await atTime(NIGHT, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }));
  must(night.state === "kept_for_brief" && night.kept === 2 && night.brief === "2026-10-21T06:00:00.000Z" && a.r.sends.length === 0, show(night));
  must(a.read(ASSISTANT_STORE, DEFERRED_KEY)?.length === 2 && a.read(REMINDED_STORE, "msg:aaaaaaa1") === undefined, "kept, not told");
  const forced = await atTime(NIGHT, () => notify(a.ctx, { items: [{ ref: "#ops:ddddddd4", summary: "x", kind: "question" }], brief: true }));
  must(forced.state === "kept_for_brief" && a.r.sends.length === 0, `a brief the timer did not post: ${show(forced)}`);
  must(a.read(ASSISTANT_STORE, DEFERRED_KEY)?.length === 3, "the night's items accumulate, once each");
  await atTime(NIGHT, () => notify(a.ctx, { items: ITEMS }));
  must(a.read(ASSISTANT_STORE, DEFERRED_KEY)?.length === 3, "an item held twice is held once");
});

await check("the brief's timer: armed for the next 08:00, a turn once a day between 08:00 and noon, which carries the night's items in one DM", async () => {
  const a = await assistant();
  await atTime(NIGHT, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }));
  // The first wake (the runtime's, at an assistant's first open) at 23:00 only arms the next.
  const first = await atTime(NIGHT, () => raftPlugin.wake!(a.ctx)) as any;
  must(first && first.turn === undefined && first.wakeAt === at("2026-10-21T06:00:00Z"), `first: ${show(first)}`);
  const morning = await atTime("2026-10-21T06:00:05Z", () => raftPlugin.wake!(a.ctx)) as any;
  must(typeof morning.turn === "string" && morning.turnKey === "assistant.brief" && morning.wakeAt === at("2026-10-22T06:00:00Z") &&
    morning.turn.includes("raft__assistant_notify_owner") && morning.turn.includes("2 items kept overnight"), `morning: ${show(morning)}`);
  const twice = await atTime("2026-10-21T07:00:00Z", () => raftPlugin.wake!(a.ctx)) as any;
  must(twice.turn === undefined, `a second brief the same day: ${show(twice)}`);
  // The brief: one new decision and the night's two, in one DM; the night's store is emptied.
  const brief = await atTime("2026-10-21T06:01:00Z", () => notify(a.ctx, { brief: true, items: [{ ref: "#eng:eeeeeee5", summary: "Ship on Friday", kind: "decided" }] }));
  must(brief.state === "sent" && brief.items === 3 && a.r.sends.length === 1, `brief: ${show(brief)}`);
  const content = a.r.sends[0].content as string;
  must(content.startsWith("Good morning. Your brief:\nWaiting on you:") && content.includes("Decided yesterday:\n• Ship on Friday — #eng:eeeeeee5") &&
    content.includes("#launch:aaaaaaa1") && content.includes("task #7"), content);
  must(a.read(ASSISTANT_STORE, DEFERRED_KEY) === undefined, "the night's items were left after the brief");
  // The brief counts once: a second `brief: true` that day is an ordinary notify, which takes no decisions.
  const again = await atTime("2026-10-21T06:30:00Z", () => notify(a.ctx, { brief: true, items: [{ ref: "#eng:fffffff6", summary: "x", kind: "decided" }] }));
  must(again.state === "nothing_to_send" && again.dropped["#eng:fffffff6"] === "decisions go in the morning brief", show(again));
  // An eviction that ran the morning's wake after noon skips the day rather than brief at teatime.
  const b = await assistant();
  const late = await atTime("2026-10-21T11:00:00Z", () => raftPlugin.wake!(b.ctx)) as any;
  must(late.turn === undefined && late.wakeAt === at("2026-10-22T06:00:00Z"), `late: ${show(late)}`);
});

await check("with no zone from Raft the brief runs on UTC and asks the owner their zone once; a zone they give is used from then on", async () => {
  const a = await assistant(raft({ zone: null }));
  const wake = await atTime("2026-10-21T08:10:00Z", () => raftPlugin.wake!(a.ctx)) as any;
  must(typeof wake.turn === "string" && wake.turn.includes("UTC"), `UTC brief: ${show(wake)}`);
  const empty = await atTime("2026-10-21T08:11:00Z", () => notify(a.ctx, { brief: true, items: [], target: "dm:@ada" }));
  must(empty.state === "sent" && /Nothing is waiting on you[\s\S]*What time zone are you in\?/.test(a.r.sends[0].content), `asked: ${show(a.r.sends[0])}`);
  must(a.read(ASSISTANT_STORE, OWNER_KEY).askedTimezone === true, "asked once");
  const kept = await raftPlugin.invoke("assistant_preferences", { action: "timezone", timezone: "Asia/Tokyo" }, a.ctx) as any;
  must(kept.state === "kept" && a.read(ASSISTANT_STORE, OWNER_KEY).statedTimezone === "Asia/Tokyo", show(kept));
  // 23:30 UTC is 08:30 in Tokyo: the brief follows the owner's word.
  const tokyo = await atTime("2026-10-21T23:30:00Z", () => raftPlugin.wake!(a.ctx)) as any;
  must(typeof tokyo.turn === "string" && tokyo.turn.includes("Asia/Tokyo"), `Tokyo: ${show(tokyo)}`);
});

await check("403 assistant_not_enabled pauses: no proactive send and no brief until a context check names the owner again", async () => {
  const a = await assistant();
  a.r.inbox = 403;
  const failed = await raftPlugin.invoke("assistant_owner_inbox", {}, a.ctx).then(() => null, (e) => e as Error);
  must(failed?.message === "403 assistant_not_enabled", `the read's own failure: ${failed?.message}`);
  must(typeof a.read(ASSISTANT_STORE, OWNER_KEY).pausedAt === "number", "paused");
  // While Raft's context refuses too: refused, nothing sent; the brief only re-arms.
  a.r.contextStatus = 403;
  const refused = await atTime(DAY, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }).then(() => null, (e) => e as Error));
  must(refused && /not enabled/.test(refused.message) && a.r.sends.length === 0, `paused notify: ${refused?.message}`);
  const wake = await atTime("2026-10-21T06:00:05Z", () => raftPlugin.wake!(a.ctx)) as any;
  must(wake.turn === undefined && wake.wakeAt === at("2026-10-22T06:00:00Z"), `paused wake: ${show(wake)}`);
  // The context names the owner again: the next call un-pauses and goes ahead.
  a.r.contextStatus = 200;
  const contexts = a.r.contexts;
  const resumed = await atTime(DAY, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }));
  must(resumed.state === "sent" && a.r.contexts === contexts + 1 && a.read(ASSISTANT_STORE, OWNER_KEY).pausedAt === null, show(resumed));
  // Other refusals are the call's alone.
  const b = await assistant();
  globalThis.fetch = (async () => json(403, { error: "no", code: "assistant_route_not_allowed" })) as any;
  await raftPlugin.invoke("messages_read", { target: "#general" }, b.ctx).then(() => null, (e) => e);
  must(b.read(ASSISTANT_STORE, OWNER_KEY).pausedAt === null, "assistant_route_not_allowed paused the assistant");
});

await check("the doorbell is taken out of receive_events and becomes the check's steps; an agent that is not an assistant drops it", async () => {
  const doorbell = (id: string, first: string, last: string, type = "owner_inbox_updated", client = "system.assistant") => ({
    message_id: id, timestamp: last, channel_type: "dm", channel_name: "third-party-agent-events:agent-1", sender_type: "third_party_app",
    sender_name: client, content: "System event: Your owner's inbox has new activity",
    third_party_event: { id, kind: "event", client_id: client, client_name: client, payload: { type, owner_user_id: OWNER, first_change_at: first, last_change_at: last }, payload_hash: "h" },
  });
  const a = await assistant();
  a.r.events.push(
    doorbell("11111111-0000-4000-8000-000000000001", "2026-10-20T09:00:00Z", "2026-10-20T09:05:00Z"),
    doorbell("11111111-0000-4000-8000-000000000002", "2026-10-20T09:06:00Z", "2026-10-20T09:11:00Z"),
    { id: "22222222-0000-4000-8000-000000000003", seq: 4, content: "anything for me?", sender_type: "human", sender_name: "ada", timestamp: "2026-10-20T09:12:00Z", channel_name: "ada", channel_type: "dm" },
  );
  const out = await raftPlugin.invoke("receive_events", {}, a.ctx) as any;
  must(Object.keys(out)[0] === "ownerActivity" && out.ownerActivity.includes("from 2026-10-20T09:00:00Z to 2026-10-20T09:11:00Z") &&
    out.ownerActivity.includes("raft__assistant_owner_inbox") && out.ownerActivity.includes("raft__assistant_notify_owner"), show(out));
  must(out.messages.length === 1 && out.messages[0].includes("anything for me?") && !JSON.stringify(out.messages).includes("system.assistant"), show(out.messages));
  must(a.read(ASSISTANT_STORE, OWNER_KEY).dmTarget === "dm:@ada", `the DM was not learnt: ${show(a.read(ASSISTANT_STORE, OWNER_KEY))}`);
  // Not an assistant (not offered the notify tool): dropped, nothing to do.
  const plain = mount(ALL_TOOLS.filter((n) => !n.startsWith("assistant_")));
  const r = raft();
  r.events.push(doorbell("11111111-0000-4000-8000-000000000009", "2026-10-20T09:00:00Z", "2026-10-20T09:05:00Z"));
  const dropped = await raftPlugin.invoke("receive_events", {}, plain.ctx) as any;
  must(!("ownerActivity" in dropped) && dropped.messages.length === 0, show(dropped));
  // The same payload from another app, or another type from the assistant app, is an ordinary event line.
  const b = await assistant();
  b.r.events.push(doorbell("11111111-0000-4000-8000-00000000000a", "2026-10-20T09:00:00Z", "2026-10-20T09:05:00Z", "owner_inbox_updated", "acme.app"),
    doorbell("11111111-0000-4000-8000-00000000000b", "2026-10-20T09:00:00Z", "2026-10-20T09:05:00Z", "something_else"));
  const other = await raftPlugin.invoke("receive_events", {}, b.ctx) as any;
  must(!("ownerActivity" in other) && other.messages.length === 2, show(other));
});

await check("a push notice wakes an assistant with its own instruction, and any other agent with the default one", async () => {
  const secret = "push-secret-0123456789";
  const delivered = async (ctx: unknown) => {
    const payload = { schema: "raft-agent-inbox-notice.v1", noticeId: "ntc_0123456789abcdef", recipientAgentId: "agent-1", text: "Inbox update: 1 event", targets: [] };
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const headers = { "x-raft-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`, "x-raft-delivery-id": payload.noticeId };
    return raftPlugin.receive!({ headers, body, hookId: "hk_0123456789abcdef" } as never, secret, ctx as never) as Promise<any>;
  };
  const a = await assistant();
  const mine = await delivered(a.ctx);
  must(mine.deliver && mine.text.startsWith(assistantWakeInstruction("raft")) && mine.text.endsWith("Inbox update: 1 event"), show(mine));
  const plain = await delivered(mount().ctx);
  must(plain.deliver && plain.text.startsWith(wakeInstruction("raft")), show(plain));
});

await check("the notify and preferences tools are refused on a mount not offered them", async () => {
  const m = mount(ALL_TOOLS.filter((n) => !n.startsWith("assistant_")));
  raft();
  for (const name of ["assistant_notify_owner", "assistant_preferences"]) {
    const e = await raftPlugin.invoke(name, { items: [], action: "list" }, m.ctx).then(() => null, (x) => x as Error);
    must(e && /is not offered on this mount/.test(e.message), `${name}: ${e?.message}`);
  }
});

// ---- the runtime: what an assistant's model is offered and told ------------------------------------------------------

type Ctx = { systemPrompt: string; tools: Array<{ name: string }> };
const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage });

async function runtimeWith(owner: boolean) {
  const host = sqliteHost();
  const sent: string[] = [], answered = new Set<string>(), calls: Ctx[] = [];
  const standIn = standInLoader();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: {} as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, subagentsDefault: true, loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
    secretKek: Buffer.from(new Uint8Array(32)).toString("base64"),
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a", { name: "Ada's assistant", description: "ASSISTANT-PERSONA" } as never);
  await rt.store.setPluginChoice("t", "a", "raft", "enable");
  const r = raft({ owner });
  globalThis.fetch = ((inner) => async (url: any, init?: any) => {
    if (new URL(String(url)).pathname === "/internal/agent-api") return json(200, { agentId: "agent-1", agentName: "ada-assistant", agentDisplayName: null, serverId: "server-1" });
    return inner(url, init);
  })(globalThis.fetch);
  const added = await rt.addMount("t", "a", { alias: "raft", plugin: "raft", config: { serverUrl: "https://raft.example" } });
  must(added.ok, `the mount was refused: ${show(added)}`);
  const attached = await rt.attachCredential("t", "a", "raft", { token: "sk_agent_assist_1234567890" });
  must(attached.ok, `attach: ${show(attached)}`);
  await rt.bindOperatorModel("t", "a");
  const turn = async (text: string) => {
    await rt.postMessage("t", "a", text, "prompt", "main");
    for (let guard = 0; guard < 200; guard++) {
      const out = await rt.step("t", "a") as { wakeInMs?: number | null };
      const pending = sent.filter((id) => !answered.has(id));
      for (const id of pending) {
        answered.add(id);
        const job = await rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string }; context: Ctx } | null;
        if (!job) continue;
        calls.push(JSON.parse(JSON.stringify(job.context)));
        await rt.deliverAnswer("t", "a", id, fromResponse(say("noted"), { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
      }
      if (pending.length) continue;
      if (out?.wakeInMs === null || out?.wakeInMs === undefined || out.wakeInMs > 1000) return;
      await new Promise((res) => setTimeout(res, Math.min(out.wakeInMs ?? 20, 50)));
    }
    throw new Error("the turn did not settle");
  };
  return { rt, host, r, calls, turn };
}

await check("an assistant's model is offered its owner DM, the owner reads and its own tools, no run_js, jobs or subagents, under its own prompt", async () => {
  const w = await runtimeWith(true);
  try {
    must(assistantMountOf(await w.rt.store.listMounts("t", "a")) === "raft", "control: the snapshot makes it an assistant");
    const offered = (await w.rt.offeredTools("t", "a"))!.tools.map((t) => t.name);
    const allowed = new Set([...ASSISTANT_MODE_TOOLS.map((n) => `raft__${n}`), "resume"]);
    must(offered.every((n) => allowed.has(n)), `offered beyond the assistant's: ${offered.filter((n) => !allowed.has(n))}`);
    for (const n of ["raft__assistant_notify_owner", "raft__assistant_owner_inbox", "raft__messages_send", "raft__receive_events", "resume"]) {
      must(offered.includes(n), `missing ${n}: ${offered}`);
    }
    for (const n of ["run_js", "jobs", "send_to_agent", "raft__tasks_list", "raft__channels_join", "raft__enable_push"]) must(!offered.includes(n), `offered ${n}`);
    await w.turn("anything for me?");
    const prompt = w.calls[0]!.systemPrompt;
    must(prompt.startsWith("You are Ada's assistant.\n\nASSISTANT-PERSONA\n\n") && prompt.endsWith(assistantPrompt("raft")), `prompt: ${prompt.slice(0, 200)}`);
    must(!prompt.includes("run_js") && !prompt.includes("long-running agent"), "the default prompt leaked in");
    // The brief's timer was armed at the open, and its first wake re-armed it for the owner's next 08:00.
    const wakes = w.host.sql.exec("SELECT alias, at FROM plugin_wakes").toArray() as Array<{ alias: string; at: number }>;
    must(wakes.length === 1 && wakes[0]!.alias === "raft" && wakes[0]!.at === nextBriefAt(wakes[0]!.at - 1, "Europe/Berlin"), `wakes: ${show(wakes)}`);
  } finally { w.host.dispose(); }
});

await check("control: the same agent without an owner is offered its whole catalogue, subagents included, under the default prompt", async () => {
  const w = await runtimeWith(false);
  try {
    must(assistantMountOf(await w.rt.store.listMounts("t", "a")) === null, "an assistant without an owner");
    const offered = (await w.rt.offeredTools("t", "a"))!.tools.map((t) => t.name);
    for (const n of ["raft__messages_send", "send_to_agent"]) must(offered.includes(n), `missing ${n}: ${offered}`);
    must(!offered.includes("raft__assistant_notify_owner"), "the notify tool offered to a non-assistant");
    await w.turn("hello");
    must(w.calls[0]!.systemPrompt.startsWith("You are a long-running agent"), "control: the default prompt");
    must(w.host.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'plugin_wakes'").toArray().length === 0 ||
      w.host.sql.exec("SELECT 1 FROM plugin_wakes").toArray().length === 0, "a non-assistant got a brief timer");
  } finally { w.host.dispose(); }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.ok ? "" : `\n      \x1b[31m${r.error}\x1b[0m`}`);
console.log("  ────────────────────────────────────────────────────────");
console.log(`  ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
