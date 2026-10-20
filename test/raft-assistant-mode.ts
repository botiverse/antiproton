// A personal assistant that speaks first (Raft RFC 075 §4.2; src/plugins/raft-assistant.ts): the rules its code keeps
// whatever the model does — each item told once, the owner's reminder rules, nothing at night, one message per wake —
// the code that decides before any model call whether a doorbell or a brief is worth one, the short session a check
// runs in, the pause on `403 assistant_not_enabled`, and what the runtime offers an assistant's model.
//
// The real plugin over a real plugin database (node:sqlite) and the real SDK, with Raft as a fake `fetch` shaped like
// its contract, as test/raft-plugin.ts does; the runtime rows drive the real `AgentRuntime` as test/stable-prompt.ts does.
//
//   node test/raft-assistant-mode.ts
import { createHmac } from "node:crypto";
import { raftPlugin, wakeInstruction } from "../src/plugins/raft.ts";
import {
  ASSISTANT_STORE, CHAT_TOOLS, CHECK_TOOLS, COUNTS_KEY, DEFERRED_KEY, OWNER_KEY, REMINDED_STORE, assistantCheckPrompt, assistantMountOf, assistantPrompt,
  assistantWakeInstruction, isQuietHours, itemOf, localDay, nextBriefAt, zoneOf,
} from "../src/plugins/raft-assistant.ts";
import { askWake } from "../src/runtime/plugin-wakes.ts";
import { recordedEngine } from "../src/runtime/durable-agent.ts";
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

/** One conversation of the owner's inbox, as Raft's route sends it (UUIDs where its contract wants them). */
const conv = (n: number, o: Record<string, unknown> = {}) => ({
  kind: "channel", channelId: `c0ffee00-0000-4000-8000-00000000000${n}`, channelName: `ch${n}`, channelType: "channel",
  parentChannelId: null, parentMessageId: null, unread: 1, hasMention: false, latestAt: "2026-10-20T09:50:00.000Z",
  latestSenderName: "bob", latestPreview: "can you pick a date?", firstUnreadMessageId: `aaaaaaa${n}-1111-4222-8333-444455556666`, ...o,
});

/** Raft as an assistant's credential meets it: its context, its owner DM, its events, the owner inbox. */
function raft(o: { zone?: unknown; owner?: boolean; dm?: unknown } = {}) {
  const r = {
    owner: o.owner ?? true, zone: "zone" in o ? o.zone : "Europe/Berlin", dm: o.dm, contextStatus: 200,
    sends: [] as any[], send: "sent" as "sent" | "held", events: [] as unknown[], inbox: 200, contexts: 0,
    unread: [] as unknown[], all: [] as unknown[], inboxReads: [] as string[],
  };
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = new URL(String(url));
    const path = u.pathname.replace("/internal/agent-api", "");
    if (u.pathname === "/internal/agent-api") return json(200, { agentId: "agent-1", agentName: "ada-assistant", agentDisplayName: null, serverId: "server-1" });
    if (path === "/context") {
      r.contexts++;
      if (r.contextStatus !== 200) return json(r.contextStatus, { error: "no", code: "forbidden" });
      return json(200, {
        agent: { id: "agent-1", name: "ada-assistant", displayName: null, description: null, runtime: "external", external: true,
          assistantOf: r.owner ? { userId: OWNER, ...(r.zone !== undefined ? { timezone: r.zone } : {}), ...(r.dm !== undefined ? { dmTarget: r.dm } : {}) } : null },
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
      const filter = u.searchParams.get("filter") ?? "unread";
      r.inboxReads.push(filter);
      return r.inbox === 200 ? json(200, { owner: { userId: OWNER }, filter, items: filter === "all" ? r.all : r.unread, hasMore: false, nextOffset: null })
        : json(r.inbox, { code: "assistant_not_enabled" });
    }
    return json(404, { error: "not found", code: "NOT_FOUND" });
  }) as any;
  return r;
}

/** One raft mount: a real database, offered every tool, in a model turn; `traced` keeps its trace rows. */
function mount(offered: readonly string[] = ALL_TOOLS) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "tenant", agentId: "agent", alias: "raft", plugin: raftPlugin.id };
  const traced: Array<{ kind: string; status: string; attrs: Record<string, unknown> }> = [];
  const ctx = {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "task", contextId: "ctx_turn" },
    alias: "raft", credential: "sk_agent_test_1234567890", publicConfig: { serverUrl: "https://raft.example" },
    db: openPluginDatabase(tables, scope, raftPlugin.database), offered,
    sibling: async () => null, sandboxForms: async () => [], trace: (row: any) => traced.push(row),
  } as any;
  const read = (store: string, key: string) => tables.get(scope, store, key) as any;
  const write = (store: string, key: string, value: unknown) => tables.put(scope, store, key, value as never, null);
  return { ctx, read, write, traced };
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
const wake = (ctx: unknown) => raftPlugin.wake!(ctx as never) as Promise<any>;
const ITEMS = [
  { ref: "#launch:aaaaaaa1", summary: "Bob asks you to pick the launch date", kind: "decision", sender: "@bob", since: "2026-10-20T07:00:00Z" },
  { ref: "task #7", channel: "eng", summary: "Review the rollout plan", kind: "task" },
];
const DAY = "2026-10-20T10:00:00Z"; // 12:00 in Berlin
const NIGHT = "2026-10-20T21:00:00Z"; // 23:00 in Berlin
/** A brief turn posted today, as the timer leaves it, so `brief: true` counts. */
const briefPosted = (a: { read: any; write: any }, day: string) => a.write(ASSISTANT_STORE, OWNER_KEY, { ...a.read(ASSISTANT_STORE, OWNER_KEY), lastBrief: day });

await check("the listing keeps the owner with Raft's zone and DM; an invalid or missing zone or DM is null; no owner drops the record", async () => {
  const a = await assistant(raft({ zone: "Europe/Berlin", dm: "dm:@ada" }));
  const kept = a.read(ASSISTANT_STORE, OWNER_KEY);
  must(kept.userId === OWNER && kept.timezone === "Europe/Berlin" && kept.dmTarget === "dm:@ada" && kept.serverId === "server-1" && kept.pausedAt === null, show(kept));
  for (const zone of [undefined, null, "Mars/Olympus"]) {
    const b = await assistant(raft({ zone }));
    must(b.read(ASSISTANT_STORE, OWNER_KEY).timezone === null, `${show(zone)}: ${show(b.read(ASSISTANT_STORE, OWNER_KEY))}`);
  }
  // Not a string at all fails the SDK's contract (0.25.0 types the field), and with it the whole listing, as any field does.
  raft({ zone: 7 });
  const typed = await raftPlugin.snapshotTools!(mount().ctx).then(() => null, (e) => e as Error);
  must(typed && /did not match the Raft SDK's contract/.test(typed.message), `a numeric zone: ${typed?.message}`);
  for (const dm of [undefined, null, "#general", "dm:@ada:abcdef12"]) {
    const b = await assistant(raft({ dm }));
    must(b.read(ASSISTANT_STORE, OWNER_KEY).dmTarget === null, `dm ${show(dm)}: ${show(b.read(ASSISTANT_STORE, OWNER_KEY))}`);
  }
  // Raft's null (no DM yet) does not forget one learnt from the DM itself.
  const c = await assistant(raft({ dm: null }));
  c.write(ASSISTANT_STORE, OWNER_KEY, { ...c.read(ASSISTANT_STORE, OWNER_KEY), dmTarget: "dm:@ada" });
  await raftPlugin.snapshotTools!(c.ctx);
  must(c.read(ASSISTANT_STORE, OWNER_KEY).dmTarget === "dm:@ada", "a learnt DM was dropped by Raft's null");
  raft({ owner: false });
  const after = await raftPlugin.snapshotTools!(a.ctx);
  must(!after.tools.some((t) => t.name.startsWith("assistant_")), "no owner: no assistant tools");
  must(a.read(ASSISTANT_STORE, OWNER_KEY) === undefined, `the record outlived the owner: ${show(a.read(ASSISTANT_STORE, OWNER_KEY))}`);
});

await check("several items in one call go out as one DM with a reference each; the same items again send nothing", async () => {
  const a = await assistant(raft({ dm: "dm:@ada" }));
  const first = await atTime(DAY, () => notify(a.ctx, { items: ITEMS }));
  must(first.state === "sent" && first.items === 2 && a.r.sends.length === 1, `first: ${show(first)} sends ${a.r.sends.length}`);
  const sent = a.r.sends[0];
  must(sent.target === "dm:@ada" && sent.content.includes("#launch:aaaaaaa1") && sent.content.includes("task #7") &&
    sent.content.startsWith("2 things are waiting on you:") && sent.content.includes("(waiting 3h)"), `content: ${show(sent)}`);
  must(a.read(REMINDED_STORE, "msg:aaaaaaa1") && a.read(REMINDED_STORE, "task:eng#7"), "what was said is recorded");
  const again = await atTime(DAY, () => notify(a.ctx, { items: ITEMS }));
  must(again.state === "nothing_to_send" && a.r.sends.length === 1, `again: ${show(again)} sends ${a.r.sends.length}`);
  must(again.dropped["#launch:aaaaaaa1"] === "already told" && again.dropped["task #7"] === "already told", show(again.dropped));
  const mixed = await atTime(DAY, () => notify(a.ctx, { items: [ITEMS[0], { ref: "#launch:bbbbbbb2", summary: "Cy asks for a review", kind: "review" }] }));
  must(mixed.state === "sent" && mixed.items === 1 && a.r.sends.length === 2 &&
    a.r.sends[1].content.startsWith("One thing is waiting on you:") && !a.r.sends[1].content.includes("aaaaaaa1"), `mixed: ${show(mixed)} ${show(a.r.sends[1])}`);
});

await check("with no DM from Raft and none learnt, notify refuses and says why; a held send records nothing and says to read the DM first", async () => {
  const a = await assistant(raft({ dm: null }));
  const unknown = await atTime(DAY, () => notify(a.ctx, { items: ITEMS }).then(() => null, (e) => e as Error));
  must(unknown && /DM is not known yet \(Raft gives none until the DM exists/.test(unknown.message) && a.r.sends.length === 0, `no target: ${unknown?.message}`);
  a.r.send = "held";
  const held = await atTime(DAY, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }));
  must(held.state === "not_sent" && a.r.sends.length === 1 && a.read(REMINDED_STORE, "msg:aaaaaaa1") === undefined, `held: ${show(held)}`);
  a.r.send = "sent";
  const sent = await atTime(DAY, () => notify(a.ctx, { items: ITEMS }));
  must(sent.state === "sent" && a.r.sends.length === 2 && a.r.sends[1].target === "dm:@ada" && a.r.sends[1].idempotencyKey === a.r.sends[0].idempotencyKey,
    `the target given once is kept, and the same items go under the same key: ${show(a.r.sends)}`);
});

await check("reminder rules: a muted channel, sender or kind is dropped in code; unmute lets it through; list shows them", async () => {
  const a = await assistant(raft({ dm: "dm:@ada" }));
  const pref = (args: unknown) => raftPlugin.invoke("assistant_preferences", args, a.ctx) as Promise<any>;
  const added = await pref({ action: "mute", channel: "#launch", note: "launch is not mine" });
  must(added.state === "added" && added.rule.channel === "launch" && added.rule.id === "r1", show(added));
  must((await pref({ action: "mute", sender: "@cy", kind: "review" })).rule.id === "r2", "second rule");
  must((await pref({ action: "mute", channel: "launch" })).state === "exists", "the same rule twice is one");
  const out = await atTime(DAY, () => notify(a.ctx, { items: [...ITEMS, { ref: "#ops:ccccccc3", summary: "Cy wants a review", kind: "review", sender: "cy" }] }));
  must(out.state === "sent" && out.items === 1 && out.dropped["#launch:aaaaaaa1"] === "rule r1" && out.dropped["#ops:ccccccc3"] === "rule r2", show(out));
  must((await pref({ action: "unmute", id: "r1" })).state === "removed", "unmute");
  const listed = await pref({ action: "list" });
  must(listed.rules.length === 1 && listed.rules[0].id === "r2", show(listed));
  const later = await atTime(DAY, () => notify(a.ctx, { items: [ITEMS[0]] }));
  must(later.state === "sent" && a.r.sends.length === 2, show(later));
  for (const bad of [{ action: "mute" }, { action: "mute", kind: "fyi" }, { action: "unmute", id: "r9" }, { action: "timezone", timezone: "Nowhere/Land" }]) {
    must(await pref(bad).then(() => false, () => true), `accepted: ${show(bad)}`);
  }
});

await check("at night notify sends nothing and keeps the items for the brief; `brief: true` from the model does not get round it", async () => {
  const a = await assistant(raft({ dm: "dm:@ada" }));
  const night = await atTime(NIGHT, () => notify(a.ctx, { items: ITEMS }));
  must(night.state === "kept_for_brief" && night.kept === 2 && night.brief === "2026-10-21T06:00:00.000Z" && a.r.sends.length === 0, show(night));
  must(a.read(ASSISTANT_STORE, DEFERRED_KEY)?.length === 2 && a.read(REMINDED_STORE, "msg:aaaaaaa1") === undefined, "kept, not told");
  const forced = await atTime(NIGHT, () => notify(a.ctx, { items: [{ ref: "#ops:ddddddd4", summary: "x", kind: "question" }], brief: true }));
  must(forced.state === "kept_for_brief" && a.r.sends.length === 0, `a brief the timer did not post: ${show(forced)}`);
  await atTime(NIGHT, () => notify(a.ctx, { items: ITEMS }));
  must(a.read(ASSISTANT_STORE, DEFERRED_KEY)?.length === 3, "an item held twice is held once");
  // The brief its timer posted carries them, with a decision, in one DM, once.
  briefPosted(a, "2026-10-21");
  const brief = await atTime("2026-10-21T06:01:00Z", () => notify(a.ctx, { brief: true, items: [{ ref: "#eng:eeeeeee5", summary: "Ship on Friday", kind: "decided" }] }));
  must(brief.state === "sent" && brief.items === 4 && a.r.sends.length === 1, `brief: ${show(brief)}`);
  const content = a.r.sends[0].content as string;
  must(content.startsWith("Good morning. Your brief:\nWaiting on you:") && content.includes("Decided yesterday:\n• Ship on Friday — #eng:eeeeeee5"), content);
  must(a.read(ASSISTANT_STORE, DEFERRED_KEY) === undefined, "the night's items were left after the brief");
  const again = await atTime("2026-10-21T06:30:00Z", () => notify(a.ctx, { brief: true, items: [{ ref: "#eng:fffffff6", summary: "x", kind: "decided" }] }));
  must(again.state === "nothing_to_send" && again.dropped["#eng:fffffff6"] === "decisions go in the morning brief", show(again));
});

// ---- the wake: code first ---------------------------------------------------------------------------------------------

/** What a wake counted today, by trigger and outcome. */
const counted = (a: { read: any }, day: string) => a.read(ASSISTANT_STORE, COUNTS_KEY)?.[day] ?? {};

await check("a push that is only the doorbell asks the plugin's wake and gives the model nothing; one with the owner's DM does both", async () => {
  const secret = "push-secret-0123456789";
  const delivered = async (ctx: unknown, targets: unknown[]) => {
    const payload = { schema: "raft-agent-inbox-notice.v1", noticeId: "ntc_0123456789abcdef", recipientAgentId: "agent-1", text: "Inbox update: 1 event", targets };
    const body = new TextEncoder().encode(JSON.stringify(payload));
    const headers = { "x-raft-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`, "x-raft-delivery-id": payload.noticeId };
    return raftPlugin.receive!({ headers, body, hookId: "hk_0123456789abcdef" } as never, secret, ctx as never) as Promise<any>;
  };
  const BELL = { target: "agent-event:11111111", pendingCount: 1, latestSenderName: "system.assistant", latestSenderType: "third_party_app", flags: [] };
  const DM = { target: "dm:@ada", channelType: "dm", pendingCount: 1, latestSenderName: "ada", latestSenderType: "human", flags: [] };
  const a = await assistant();
  const bell = await delivered(a.ctx, [BELL]);
  must(!bell.deliver && bell.wake === true && !("text" in bell), `doorbell only: ${show(bell)}`);
  must(typeof a.read(ASSISTANT_STORE, OWNER_KEY).doorbellAt === "number", "the doorbell is kept for the wake");
  const both = await delivered(a.ctx, [BELL, DM]);
  must(both.deliver && both.wake === true && both.text.startsWith(assistantWakeInstruction("raft")), `doorbell and DM: ${show(both)}`);
  const dm = await delivered(a.ctx, [DM]);
  must(dm.deliver && !("wake" in dm), `DM only: ${show(dm)}`);
  // Not an assistant: the default wake, a doorbell or not.
  const plain = await delivered(mount().ctx, [BELL]);
  must(plain.deliver && !("wake" in plain) && plain.text.startsWith(wakeInstruction("raft")), show(plain));
});

await check("a doorbell whose activity is all told, muted or already looked at ends in code: no turn, counted skipped_filtered", async () => {
  const a = await assistant();
  a.write(REMINDED_STORE, "msg:aaaaaaa1", { at: 1 });
  await raftPlugin.invoke("assistant_preferences", { action: "mute", channel: "ch2" }, a.ctx);
  a.r.unread = [conv(1), conv(2)];
  await atTime(DAY, async () => { await (await import("../src/plugins/raft-assistant.ts")).noteDoorbell(a.ctx); });
  const out = await atTime(DAY, () => wake(a.ctx));
  must(out && out.turn === undefined && out.wakeAt === at("2026-10-21T06:00:00Z"), `filtered: ${show(out)}`);
  must(show(a.r.inboxReads) === show(["unread"]), `reads: ${show(a.r.inboxReads)}`);
  const row = a.traced.find((t) => t.kind === "raft.assistant_wake");
  must(row?.status === "skipped_filtered" && row.attrs.trigger === "doorbell" && row.attrs.told === 1 && row.attrs.muted === 1 && row.attrs.candidates === 0, show(a.traced));
  must(counted(a, "2026-10-20")["doorbell.skipped_filtered"] === 1, show(a.read(ASSISTANT_STORE, COUNTS_KEY)));
  // An empty inbox is skipped_empty; a wake with no doorbell kept and no brief due reads nothing at all.
  a.r.unread = [];
  await atTime(DAY, async () => { await (await import("../src/plugins/raft-assistant.ts")).noteDoorbell(a.ctx); });
  await atTime(DAY, () => wake(a.ctx));
  must(counted(a, "2026-10-20")["doorbell.skipped_empty"] === 1, show(counted(a, "2026-10-20")));
  const reads = a.r.inboxReads.length;
  const idle = await atTime(DAY, () => wake(a.ctx));
  must(idle.turn === undefined && a.r.inboxReads.length === reads, `an idle wake read the inbox: ${show(idle)}`);
});

await check("a doorbell with new activity starts one short session of its own with the candidates as input; activity looked at is not new again", async () => {
  const a = await assistant();
  a.r.unread = [conv(1), conv(3, { unread: 2, latestPreview: "@ada review this?" })];
  const { noteDoorbell } = await import("../src/plugins/raft-assistant.ts");
  await atTime(DAY, () => noteDoorbell(a.ctx));
  const out = await atTime(DAY, () => wake(a.ctx));
  must(out.isolated === true && out.turnKey === "assistant.check" && out.wakeAt === at("2026-10-21T06:00:00Z"), `invoked: ${show(out)}`);
  must(out.turn.includes(conv(1).channelId) && out.turn.includes("@ada review this?") && out.turn.includes("raft__assistant_notify_owner"), out.turn);
  must(a.traced.at(-1)?.status === "invoked" && a.traced.at(-1)?.attrs.candidates === 2, show(a.traced));
  must(a.read(ASSISTANT_STORE, OWNER_KEY).doorbellAt === null, "the doorbell was taken");
  // The same activity rung again is not new: no turn.
  await atTime(DAY, () => noteDoorbell(a.ctx));
  const again = await atTime(DAY, () => wake(a.ctx));
  must(again.turn === undefined && a.traced.at(-1)?.status === "skipped_filtered" && a.traced.at(-1)?.attrs.seen === 2, `again: ${show(again)} ${show(a.traced.at(-1))}`);
  // Newer activity in one of them is.
  a.r.unread = [conv(1, { latestAt: "2026-10-20T09:58:00.000Z" }), conv(3, { unread: 2 })];
  await atTime(DAY, () => noteDoorbell(a.ctx));
  const newer = await atTime(DAY, () => wake(a.ctx));
  must(newer.isolated === true && newer.turn.includes(conv(1).channelId) && !newer.turn.includes(conv(3).channelId), `newer: ${show(newer)}`);
});

await check("a doorbell at night reads nothing and calls no model (night_deferred); a paused assistant does neither (paused)", async () => {
  const { noteDoorbell } = await import("../src/plugins/raft-assistant.ts");
  const a = await assistant();
  a.r.unread = [conv(1)];
  await atTime(NIGHT, () => noteDoorbell(a.ctx));
  const night = await atTime(NIGHT, () => wake(a.ctx));
  must(night.turn === undefined && a.r.inboxReads.length === 0 && a.traced.at(-1)?.status === "night_deferred", `night: ${show(night)}`);
  // 403 assistant_not_enabled from the owner inbox pauses; while Raft's context refuses too, a doorbell is only counted.
  a.r.inbox = 403;
  await raftPlugin.invoke("assistant_owner_inbox", {}, a.ctx).then(() => null, (e) => e);
  must(typeof a.read(ASSISTANT_STORE, OWNER_KEY).pausedAt === "number", "paused");
  a.r.contextStatus = 403;
  await atTime(DAY, () => noteDoorbell(a.ctx));
  const reads = a.r.inboxReads.length;
  const paused = await atTime(DAY, () => wake(a.ctx));
  must(paused.turn === undefined && a.r.inboxReads.length === reads && a.traced.at(-1)?.status === "paused", `paused: ${show(paused)} ${show(a.traced.at(-1))}`);
  const refused = await atTime(DAY, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }).then(() => null, (e) => e as Error));
  must(refused && /not enabled/.test(refused.message) && a.r.sends.length === 0, `paused notify: ${refused?.message}`);
  // The context names the owner again: the next call un-pauses and goes ahead.
  a.r.contextStatus = 200;
  a.r.inbox = 200;
  const resumed = await atTime(DAY, () => notify(a.ctx, { items: ITEMS, target: "dm:@ada" }));
  must(resumed.state === "sent" && a.read(ASSISTANT_STORE, OWNER_KEY).pausedAt === null, show(resumed));
  // A wake's own inbox read refused the same way pauses as well.
  const b = await assistant();
  b.r.inbox = 403;
  await atTime(DAY, () => noteDoorbell(b.ctx));
  await atTime(DAY, () => wake(b.ctx));
  must(typeof b.read(ASSISTANT_STORE, OWNER_KEY).pausedAt === "number" && b.traced.at(-1)?.status === "paused", show(b.traced));
  // Other refusals are the call's alone.
  const c = await assistant();
  globalThis.fetch = (async () => json(403, { error: "no", code: "assistant_route_not_allowed" })) as any;
  await raftPlugin.invoke("messages_read", { target: "#general" }, c.ctx).then(() => null, (e) => e);
  must(c.read(ASSISTANT_STORE, OWNER_KEY).pausedAt === null, "assistant_route_not_allowed paused the assistant");
});

await check("the brief: once a day between 08:00 and noon, in a short session with the inbox as input; a morning with nothing calls no model", async () => {
  const a = await assistant();
  // The first wake (the runtime's, at an assistant's first open) at 23:00 only arms the next.
  const first = await atTime(NIGHT, () => wake(a.ctx));
  must(first.turn === undefined && first.wakeAt === at("2026-10-21T06:00:00Z") && a.r.inboxReads.length === 0, `first: ${show(first)}`);
  a.r.unread = [conv(1)];
  a.r.all = [conv(1), conv(4, { unread: 0, latestAt: "2026-10-20T15:00:00.000Z", latestPreview: "agreed: ship Friday" })];
  const morning = await atTime("2026-10-21T06:00:05Z", () => wake(a.ctx));
  must(morning.isolated === true && morning.turnKey === "assistant.brief" && morning.wakeAt === at("2026-10-22T06:00:00Z") &&
    morning.turn.includes("agreed: ship Friday") && morning.turn.includes(conv(1).channelId), `morning: ${show(morning)}`);
  must(a.traced.at(-1)?.status === "invoked" && a.traced.at(-1)?.attrs.trigger === "brief", show(a.traced.at(-1)));
  const twice = await atTime("2026-10-21T07:00:00Z", () => wake(a.ctx));
  must(twice.turn === undefined, `a second brief the same day: ${show(twice)}`);
  // A quiet morning: nothing unread, nothing active, nothing held, the zone known. No turn, no model call.
  const b = await assistant();
  const quiet = await atTime("2026-10-21T06:00:05Z", () => wake(b.ctx));
  must(quiet.turn === undefined && show(b.r.inboxReads) === show(["unread", "all"]) && b.traced.at(-1)?.status === "skipped_empty", `quiet: ${show(quiet)} ${show(b.traced)}`);
  must(counted(b, "2026-10-21")["brief.skipped_empty"] === 1, show(b.read(ASSISTANT_STORE, COUNTS_KEY)));
  // An eviction that ran the morning's wake after noon skips the day rather than brief at teatime.
  const c = await assistant();
  const late = await atTime("2026-10-21T11:00:00Z", () => wake(c.ctx));
  must(late.turn === undefined && late.wakeAt === at("2026-10-22T06:00:00Z") && c.r.inboxReads.length === 0, `late: ${show(late)}`);
});

await check("with no zone from Raft the brief runs on UTC and asks the owner their zone once, even on a quiet morning; a zone they give is used", async () => {
  const a = await assistant(raft({ zone: null, dm: "dm:@ada" }));
  const w = await atTime("2026-10-21T08:10:00Z", () => wake(a.ctx));
  must(w.isolated === true && w.turn.includes("UTC"), `UTC brief, to ask: ${show(w)}`);
  const empty = await atTime("2026-10-21T08:11:00Z", () => notify(a.ctx, { brief: true, items: [] }));
  must(empty.state === "sent" && /Nothing is waiting on you[\s\S]*What time zone are you in\?/.test(a.r.sends[0].content), `asked: ${show(a.r.sends[0])}`);
  must(a.read(ASSISTANT_STORE, OWNER_KEY).askedTimezone === true, "asked once");
  const kept = await raftPlugin.invoke("assistant_preferences", { action: "timezone", timezone: "Asia/Tokyo" }, a.ctx) as any;
  must(kept.state === "kept" && a.read(ASSISTANT_STORE, OWNER_KEY).statedTimezone === "Asia/Tokyo", show(kept));
  a.r.unread = [conv(1)];
  // 23:30 UTC is 08:30 in Tokyo: the brief follows the owner's word.
  const tokyo = await atTime("2026-10-21T23:30:00Z", () => wake(a.ctx));
  must(tokyo.isolated === true && tokyo.turn.includes("Asia/Tokyo"), `Tokyo: ${show(tokyo)}`);
});

await check("receive_events never shows the model a doorbell; an assistant learns its owner's DM from the DM", async () => {
  const doorbell = (id: string, client = "system.assistant") => ({
    message_id: id, timestamp: "2026-10-20T09:05:00Z", channel_type: "dm", channel_name: "third-party-agent-events:agent-1", sender_type: "third_party_app",
    sender_name: client, content: "System event: Your owner's inbox has new activity",
    third_party_event: { id, kind: "event", client_id: client, client_name: client, payload: { type: "owner_inbox_updated", owner_user_id: OWNER, first_change_at: "2026-10-20T09:00:00Z", last_change_at: "2026-10-20T09:05:00Z" }, payload_hash: "h" },
  });
  const a = await assistant();
  a.r.events.push(doorbell("11111111-0000-4000-8000-000000000001"),
    { id: "22222222-0000-4000-8000-000000000003", seq: 4, content: "anything for me?", sender_type: "human", sender_name: "ada", timestamp: "2026-10-20T09:12:00Z", channel_name: "ada", channel_type: "dm" });
  const out = await raftPlugin.invoke("receive_events", {}, a.ctx) as any;
  must(!("ownerActivity" in out) && out.messages.length === 1 && out.messages[0].includes("anything for me?") && !JSON.stringify(out).includes("system.assistant"), show(out));
  must(a.read(ASSISTANT_STORE, OWNER_KEY).dmTarget === "dm:@ada", `the DM was not learnt: ${show(a.read(ASSISTANT_STORE, OWNER_KEY))}`);
  // The same payload from another app is an ordinary event line.
  const b = await assistant();
  b.r.events.push(doorbell("11111111-0000-4000-8000-00000000000a", "acme.app"));
  const other = await raftPlugin.invoke("receive_events", {}, b.ctx) as any;
  must(other.messages.length === 1, show(other));
});

await check("the notify and preferences tools are refused on a mount not offered them", async () => {
  const m = mount(ALL_TOOLS.filter((n) => !n.startsWith("assistant_")));
  raft();
  for (const name of ["assistant_notify_owner", "assistant_preferences"]) {
    const e = await raftPlugin.invoke(name, { items: [], action: "list" }, m.ctx).then(() => null, (x) => x as Error);
    must(e && /is not offered on this mount/.test(e.message), `${name}: ${e?.message}`);
  }
});

// ---- the runtime: the chat, the short sessions, and what each is offered and told --------------------------------------

type Ctx = { systemPrompt: string; messages: any[]; tools: Array<{ name: string }> };
const usage = { promptTokens: 1, completionTokens: 1, reasoningTokens: 0, cachedPromptTokens: 0 };
const say = (text: string): ModelResponse => ({ text, finishReason: "stop", truncated: false, usage });

/** A zone where it is 14:00 now: daytime, outside the brief's window, whenever the suite runs. */
function afternoonZone(): string {
  const offset = ((14 - new Date().getUTCHours()) % 24 + 24) % 24;
  const k = offset > 12 ? offset - 24 : offset;
  return k === 0 ? "UTC" : `Etc/GMT${k > 0 ? "-" : "+"}${Math.abs(k)}`;
}

async function runtimeWith(owner: boolean, answer: (c: Ctx) => ModelResponse = () => say("noted")) {
  const host = sqliteHost();
  const sent: string[] = [], answered = new Set<string>(), calls: Ctx[] = [];
  const standIn = standInLoader();
  /** The object storage parked results go to: every put and delete recorded. */
  const r2 = { puts: [] as string[], deletes: [] as string[] };
  const bucket = {
    put: async (key: string) => { r2.puts.push(key); return {}; },
    delete: async (keys: string | string[]) => { r2.deletes.push(...(Array.isArray(keys) ? keys : [keys])); },
    get: async () => null, head: async () => null, list: async () => ({ objects: [], truncated: false }),
  };
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } },
    bucket: bucket as never, bucketName: "b", models: { resolve: () => null },
    autoRelease: false, subagentsDefault: true, loader: standIn.loader, makeToolBinding: standIn.makeToolBinding,
    operatorModel: operatorModelOf({ DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "operator-key", HARNESS_MODEL: "m1" }),
    offloadModel: async (job: { commandId: string }) => { sent.push(job.commandId); },
    secretKek: Buffer.from(new Uint8Array(32)).toString("base64"),
  } as never);
  await rt.ready();
  await rt.store.createAgent("t", "a", { name: "Ada's assistant", description: "ASSISTANT-PERSONA" } as never);
  await rt.store.setPluginChoice("t", "a", "raft", "enable");
  const zone = afternoonZone();
  const r = raft({ owner, zone, dm: "dm:@ada" });
  const added = await rt.addMount("t", "a", { alias: "raft", plugin: "raft", config: { serverUrl: "https://raft.example" } });
  must(added.ok, `the mount was refused: ${show(added)}`);
  const attached = await rt.attachCredential("t", "a", "raft", { token: "sk_agent_assist_1234567890" });
  must(attached.ok, `attach: ${show(attached)}`);
  await rt.bindOperatorModel("t", "a");
  /** Every pass until nothing is left to do now, answering every model call with plain text. */
  const drive = async () => {
    for (let guard = 0; guard < 200; guard++) {
      const out = await rt.step("t", "a") as { wakeInMs?: number | null };
      const pending = sent.filter((id) => !answered.has(id));
      for (const id of pending) {
        answered.add(id);
        const job = await rt.takeJob("t", "a", id) as { model: { api: string; provider: string; id: string }; context: Ctx } | null;
        if (!job) continue;
        const c = JSON.parse(JSON.stringify(job.context)) as Ctx;
        calls.push(c);
        await rt.deliverAnswer("t", "a", id, fromResponse(answer(c), { api: job.model.api, provider: job.model.provider, id: job.model.id }, id), undefined);
      }
      if (pending.length) continue;
      if (out?.wakeInMs === null || out?.wakeInMs === undefined || out.wakeInMs > 1000) return;
      await new Promise((res) => setTimeout(res, Math.min(out.wakeInMs ?? 20, 50)));
    }
    throw new Error("the agent did not settle");
  };
  const turn = async (text: string) => { await rt.postMessage("t", "a", text, "prompt", "main"); await drive(); };
  const tables = new PluginDbTables(host).ensure();
  const scope = { tenantId: "t", agentId: "a", alias: "raft", plugin: "raft" };
  const db = { read: (store: string, key: string) => tables.get(scope, store, key) as any, write: (store: string, key: string, v: unknown) => tables.put(scope, store, key, v as never, null) };
  /** A doorbell as the push leaves it: kept, and the mount's wake asked for now. */
  const doorbell = () => { db.write(ASSISTANT_STORE, OWNER_KEY, { ...db.read(ASSISTANT_STORE, OWNER_KEY), doorbellAt: Date.now() }); askWake(host.sql, "raft", Date.now()); };
  const sessions = () => (host.sql.exec("SELECT session FROM pi_sessions").toArray() as Array<{ session: string }>).map((x) => x.session);
  const wakeRows = () => (host.sql.exec("SELECT status, attrs FROM trace_outbox WHERE kind = 'raft.assistant_wake' ORDER BY seq").toArray() as any[])
    .map((x) => ({ status: String(x.status), attrs: JSON.parse(String(x.attrs)) }));
  return { rt, host, r, calls, sent, turn, drive, db, doorbell, sessions, wakeRows, zone, r2 };
}

await check("an assistant's chat is offered its owner DM, the reads and its preferences, no notify, run_js, jobs or subagents, under its own prompt", async () => {
  const w = await runtimeWith(true);
  try {
    must(assistantMountOf(await w.rt.store.listMounts("t", "a")) === "raft", "control: the snapshot makes it an assistant");
    const offered = (await w.rt.offeredTools("t", "a"))!.tools.map((t) => t.name);
    const allowed = new Set([...CHAT_TOOLS.map((n: string) => `raft__${n}`), "resume"]);
    must(offered.every((n) => allowed.has(n)), `offered beyond the chat's: ${offered.filter((n) => !allowed.has(n))}`);
    for (const n of ["raft__assistant_preferences", "raft__assistant_owner_inbox", "raft__messages_send", "raft__receive_events", "resume"]) must(offered.includes(n), `missing ${n}: ${offered}`);
    for (const n of ["raft__assistant_notify_owner", "run_js", "jobs", "send_to_agent", "raft__tasks_list", "raft__enable_push"]) must(!offered.includes(n), `offered ${n}`);
    await w.turn("anything for me?");
    const prompt = w.calls[0]!.systemPrompt;
    must(prompt.startsWith("You are Ada's assistant.\n\nASSISTANT-PERSONA\n\n") && prompt.endsWith(assistantPrompt("raft")), `prompt: ${prompt.slice(0, 200)}`);
    // The timer was armed at the open, and its first wake (outside the brief's window) re-armed it for the next 08:00.
    const wakes = w.host.sql.exec("SELECT alias, at FROM plugin_wakes").toArray() as Array<{ alias: string; at: number }>;
    must(wakes.length === 1 && wakes[0]!.alias === "raft" && wakes[0]!.at === nextBriefAt(wakes[0]!.at - 1, w.zone), `wakes: ${show(wakes)} in ${w.zone}`);
    must(w.wakeRows().length === 0, `an idle wake was counted: ${show(w.wakeRows())}`);
  } finally { w.host.dispose(); }
});

await check("a doorbell whose activity is all filtered makes no model call and starts no session", async () => {
  const w = await runtimeWith(true);
  try {
    await w.turn("hello");
    const calls = w.sent.length, sessions = show(w.sessions());
    w.r.unread = [conv(1)];
    w.db.write(REMINDED_STORE, "msg:aaaaaaa1", { at: 1 });
    w.doorbell();
    await w.drive();
    must(w.sent.length === calls, `model calls: ${w.sent.length - calls}`);
    must(show(w.sessions()) === sessions, `sessions: ${sessions} -> ${show(w.sessions())}`);
    must(show(w.wakeRows().map((x) => x.status)) === show(["skipped_filtered"]) && w.wakeRows()[0]!.attrs.trigger === "doorbell", show(w.wakeRows()));
    must(show(w.r.inboxReads) === show(["unread"]), `reads: ${show(w.r.inboxReads)}`);
  } finally { w.host.dispose(); }
});

await check("a doorbell with candidates runs in a fresh short session: the check prompt and tools, nothing of the chat, erased after", async () => {
  const w = await runtimeWith(true);
  try {
    await w.turn("CHAT-ONLY-LINE");
    const chatCalls = w.calls.length;
    w.r.unread = [conv(1, { latestAt: new Date(Date.now() - 60_000).toISOString(), latestPreview: "@ada can you approve?" })];
    w.doorbell();
    const step = await w.rt.step("t", "a");
    must(step, "control: a pass ran");
    const iso = w.sessions().filter((s) => s.startsWith("iso_"));
    must(iso.length === 1, `one short session: ${show(w.sessions())}`);
    await w.drive();
    const check = w.calls.slice(chatCalls);
    must(check.length === 1, `model calls for the check: ${check.length}`);
    const c = check[0]!;
    must(c.systemPrompt.endsWith(assistantCheckPrompt("raft")), `check prompt: ${c.systemPrompt.slice(-200)}`);
    must(!JSON.stringify(c.messages).includes("CHAT-ONLY-LINE") && JSON.stringify(c.messages).includes("@ada can you approve?"), `the check's input: ${JSON.stringify(c.messages).slice(0, 400)}`);
    // The check's tools, and the parked-result reader every assistant session keeps.
    const tools = c.tools.map((t) => t.name).sort();
    must(show(tools) === show([...CHECK_TOOLS.map((n: string) => `raft__${n}`), "artifacts__read"].sort()), `check tools: ${show(tools)}`);
    // Nothing of the check reached the chat, and the short session is gone.
    const main = (w.host.sql.exec("SELECT body FROM pi_entries").toArray() as any[]).map((x) => String(x.body)).join("\n");
    must(main.includes("CHAT-ONLY-LINE") && !main.includes("can you approve"), "the check reached the chat");
    must(w.sessions().every((s) => !s.startsWith("iso_")) && w.host.sql.exec("SELECT COUNT(*) AS n FROM isolated_sessions").toArray()[0].n === 0, `left: ${show(w.sessions())}`);
    const tables = (w.host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pi_s_iso_%'").toArray() as any[]).map((x) => x.name);
    must(tables.length === 0, `the short session's transcript outlived it: ${show(tables)}`);
    must(show(w.wakeRows().map((x) => x.status)) === show(["invoked"]), show(w.wakeRows()));
  } finally { w.host.dispose(); }
});

await check("an owner read too large to hand back is cut and never parked, though a reader is mounted", async () => {
  const CH = "c0ffee00-0000-4000-8000-000000000001";
  const big = Array.from({ length: 40 }, (_, i) => ({ seq: i + 1, id: `0000000${i % 10}-aaaa-4bbb-8ccc-dddddddddddd`, timestamp: "2026-10-20T09:00:00.000Z",
    sender_type: "human", sender_name: "bob", channel_type: "channel", channel_name: "general", content: `OWNER-PRIVATE ${"x".repeat(300)} ${i}` }));
  let step = 0;
  const w = await runtimeWith(true, () => step++ === 0
    ? { text: "", finishReason: "tool_calls", truncated: false, usage, toolCalls: [{ id: "r1", name: "raft__assistant_owner_messages", arguments: { channelId: CH, limit: 40 } }] } as ModelResponse
    : say("noted"));
  try {
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => new URL(String(url)).pathname === "/internal/agent-api/assistant/owner-messages"
      ? json(200, { owner: { userId: OWNER }, channelId: CH, messages: big, hasMore: true, hasOlder: true, hasNewer: false })
      : inner(url, init)) as typeof fetch;
    await w.turn("what is happening in #general?");
    const result = JSON.stringify(w.calls.at(-1)!.messages.filter((m: any) => m.role === "toolResult"));
    must(/never kept outside this conversation/.test(result) && !/"ref"/.test(result), `the tool result: ${result.slice(0, 600)}`);
    must(w.r2.puts.length === 0, `parked: ${show(w.r2.puts)}`);
    const refs = w.host.sql.exec("SELECT COUNT(*) AS n FROM operations WHERE result_ref IS NOT NULL").toArray()[0].n;
    must(refs === 0, `operations with a stored result: ${refs}`);
  } finally { w.host.dispose(); }
});

await check("a short session's erase deletes anything its calls parked, and the references to it (belt and braces)", async () => {
  const w = await runtimeWith(true);
  try {
    w.r.unread = [conv(1, { latestAt: new Date(Date.now() - 60_000).toISOString() })];
    w.doorbell();
    await w.rt.step("t", "a");
    const iso = w.sessions().find((s) => s.startsWith("iso_"))!;
    must(iso, `control: a short session: ${show(w.sessions())}`);
    // As a parked result of one of its calls would leave it.
    w.host.sql.exec("INSERT INTO operations (operation_id, tenant_id, agent_id, task_id, mount_alias, tool, tool_version, status, result_ref, created_at, updated_at) " +
      "VALUES ('op_iso_1', 't', 'a', ?, 'raft', 'assistant_owner_messages', '1.0.0', 'succeeded', 'r2://b/t/t/a/op_iso_1.json', 1, 1)", iso);
    await w.drive();
    must(show(w.r2.deletes) === show(["t/t/a/op_iso_1.json"]), `deleted: ${show(w.r2.deletes)}`);
    must(w.host.sql.exec("SELECT result_ref FROM operations WHERE operation_id = 'op_iso_1'").toArray()[0].result_ref === null, "the reference outlived the object");
  } finally { w.host.dispose(); }
});

await check("an assistant cannot be moved to the pd engine: the migration is refused, saying why, and the engine stays pi085", async () => {
  const w = await runtimeWith(true);
  try {
    const out = await w.rt.migrateEngine("t", "a", "migrate") as any;
    must(out && out.ok === false && /personal assistant[\s\S]*pi085 only/.test(out.refused), `migrate: ${show(out)}`);
    must(recordedEngine(w.host.sql as never) === null, "the engine moved");
  } finally { w.host.dispose(); }
});

await check("an assistant already on pd: each wake is counted failed (engine_pd_unsupported), not dropped in silence, and calls no model", async () => {
  // Migrated while no one's assistant, then given an owner: the one way to be an assistant on pd.
  const w = await runtimeWith(false);
  try {
    const moved = await w.rt.migrateEngine("t", "a", "migrate") as any;
    must(moved && moved.ok !== false && recordedEngine(w.host.sql as never) === "pd", `control: the migration of a non-assistant: ${show(moved)}`);
    w.r.owner = true;
    const relisted = await w.rt.attachCredential("t", "a", "raft", { token: "sk_agent_assist_2234567890" });
    must(relisted.ok && assistantMountOf(await w.rt.store.listMounts("t", "a")) === "raft", "control: it is an assistant now");
    w.r.unread = [conv(1, { latestAt: new Date(Date.now() - 60_000).toISOString() })];
    const calls = w.sent.length;
    w.doorbell();
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
    try { await w.rt.step("t", "a"); } finally { console.warn = warn; }
    must(show(w.wakeRows()) === show([{ status: "failed", attrs: { reason: "engine_pd_unsupported", mount: "raft" } }]), `rows: ${show(w.wakeRows())}`);
    must(warned.some((l) => l.includes("engine_pd_unsupported")), `warned: ${show(warned)}`);
    must(w.sent.length === calls && w.r.inboxReads.length === 0, `model calls ${w.sent.length - calls}, reads ${show(w.r.inboxReads)}`);
  } finally { w.host.dispose(); }
});

await check("control: the same agent without an owner is offered its whole catalogue, subagents included, under the default prompt", async () => {
  const w = await runtimeWith(false);
  try {
    must(assistantMountOf(await w.rt.store.listMounts("t", "a")) === null, "an assistant without an owner");
    const offered = (await w.rt.offeredTools("t", "a"))!.tools.map((t) => t.name);
    for (const n of ["raft__messages_send", "send_to_agent"]) must(offered.includes(n), `missing ${n}: ${offered}`);
    must(!offered.some((n) => n.startsWith("raft__assistant_")), "assistant tools offered to a non-assistant");
    await w.turn("hello");
    must(w.calls[0]!.systemPrompt.startsWith("You are a long-running agent"), "control: the default prompt");
    must(w.host.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'plugin_wakes'").toArray().length === 0 ||
      w.host.sql.exec("SELECT 1 FROM plugin_wakes").toArray().length === 0, "a non-assistant got a timer");
  } finally { w.host.dispose(); }
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${r.name}${r.ok ? "" : `\n      \x1b[31m${r.error}\x1b[0m`}`);
console.log("  ────────────────────────────────────────────────────────");
console.log(`  ${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
