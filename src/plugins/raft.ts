/**
 * Raft messaging for an agent running inside Antiproton.
 *
 * The QuickJS program sees structured tools. The Raft credential stays
 * in the host plugin and is attached only to the operator-configured Raft
 * origin. Responses are projected so a new server field cannot silently enter
 * the model's context.
 */
import { clip, logEvent, routeOf } from "../core/log.ts";
import type { Json } from "../core/types.ts";
import { createRaft, RAFT_STATE_SCHEMA, type Raft, type RaftMessage, type RaftState, type RaftStateStore, type RaftFailure } from "@botiverse/raft-sdk";
import { interrupt, originProblem, type ActivityEvent, type InboundEvent, type InboundResult, type Interrupt, type Plugin, type PluginContext, type PluginErrorFields } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EVENTS = 200;
/**
 * Raft's push is a NOTICE that the inbox changed — the same "Inbox update" text
 * Raft's daemon injects into a managed agent — never the messages (tygg,
 * 2026-09-28). The agent reads them itself with `receive_events`, which
 * acknowledges by cursor. So a lost or repeated notice costs nothing, a 2xx
 * here means only "received", and no receiver-side dedupe of messages exists.
 */
const NOTICE_SCHEMA = "raft-agent-inbox-notice.v1";
/**
 * Under the runtime's 4,000-character cut (src/runtime/inbound.ts INBOUND_TEXT_MAX) with room for the
 * one instruction below it: the two caps stack, and the instruction used to be exactly the part a
 * long notice lost. The instruction also goes first, so no cut can reach it.
 */
const NOTICE_TEXT_MAX = 3_600;
const PUSH_REGISTRATION_PATH = "/internal/agent-api/push-webhook";
const ACTIVITY_PATH = "/internal/agent-api/activity";
const ACTIVITY_SCHEMA = "raft-agent-activity-ingest.v1";
const PUSH_ID = /^[A-Za-z0-9._:-]{1,128}$/;

type ObjectValue = Record<string, any>;

function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

type PushState = {
  /**
   * Whether a record exists at all. `false` is not "disabled": disabling
   * writes a record that says so. No record means push was never enabled on
   * this mount, or the record was lost — and a delivery that verifies tells
   * those two apart, since only a registered hook receives one.
   */
  known: boolean;
  enabled: boolean;
  agentId: string | null;
  agentName: string | null;
  hookId: string | null;
  staleHookIds: string[];
  registration: "active" | "uncertain" | null;
  lastReached: { deliveryId: string; at: number } | null;
};

function pushState(value: unknown): PushState {
  const state = object(value);
  const reached = object(state.lastReached);
  const staleHookIds = Array.isArray(state.staleHookIds)
    ? [...new Set(state.staleHookIds.filter((value): value is string => typeof value === "string" && PUSH_ID.test(value)))]
    : [];
  return {
    known: value !== null && value !== undefined,
    enabled: state.enabled === true,
    agentId: text(state.agentId) ?? null,
    agentName: text(state.agentName) ?? null,
    hookId: typeof state.hookId === "string" && PUSH_ID.test(state.hookId) ? state.hookId : null,
    staleHookIds,
    registration: state.registration === "active" || state.registration === "uncertain" ? state.registration : null,
    lastReached: typeof reached.deliveryId === "string" && typeof reached.at === "number" &&
        Number.isFinite(reached.at) && Math.abs(reached.at) <= 8.64e15
      ? { deliveryId: reached.deliveryId, at: reached.at }
      : null,
  };
}

/**
 * Where the push state lives in this mount's database: one record under one
 * key. Exported for the provisioning reader, which projects the same record
 * for Raft without going through a call.
 */
export const PUSH_STORE = "push";
export const PUSH_KEY = "state";

async function loadPushState(ctx: PluginContext): Promise<PushState> {
  return pushState((await ctx.db.get(PUSH_STORE, PUSH_KEY)) ?? null);
}

async function savePushState(ctx: PluginContext, state: PushState): Promise<void> {
  // `known` is a fact about the row's existence, read on load; written down it would be a stale copy.
  const { known: _known, ...record } = state;
  await ctx.db.put(PUSH_STORE, record as unknown as Json, PUSH_KEY);
}

function baseUrl(ctx: PluginContext): URL {
  const raw = ctx.publicConfig.serverUrl;
  if (typeof raw !== "string") throw new Error("raft needs the serverUrl mount setting");
  const problem = originProblem(raw);
  if (problem) throw new Error(`raft serverUrl ${problem}`);
  const url = new URL(raw);
  url.pathname = "/";
  return url;
}

function requireCredential(ctx: PluginContext): string {
  if (!ctx.credential) throw new Error("raft needs an account: a person must attach an agent credential to this mount");
  return ctx.credential;
}

function timeout(ctx: PluginContext): number {
  const configured = ctx.publicConfig.timeoutMs;
  return typeof configured === "number" && Number.isFinite(configured)
    ? Math.max(1_000, Math.min(60_000, Math.floor(configured)))
    : DEFAULT_TIMEOUT_MS;
}

/**
 * The two questions a failure answers, and the flag they replace.
 *
 * `retryable` alone could not say which of them was meant: this file set it for
 * an uncertain delivery while its own comment said callers must not retry, and
 * `github.ts` set the same flag for a refused quota where nothing happened at
 * all. So each site now says which question it is answering, and `retryable`
 * keeps being set exactly where it was until its consumer moves.
 */
function marked(
  error: Error, marks: { transient?: boolean; mayHaveLanded?: boolean; retryable?: boolean },
): Error {
  const e = error as Error & PluginErrorFields;
  if (marks.transient !== undefined) e.transient = marks.transient;
  // Only ever true: absent has to keep meaning "not reported" (see the contract).
  if (marks.mayHaveLanded) e.mayHaveLanded = true;
  e.retryable = marks.retryable ?? true;
  return e;
}

function retryable(error: Error, value = true): Error {
  // A transport answer: a 429 or a 5xx may clear on its own. Whether it landed
  // is not known from the status alone, and a 5xx may have.
  return marked(error, { transient: value, mayHaveLanded: value, retryable: value });
}

const DELIVERY_UNCERTAIN =
  "delivery acknowledgement may already have occurred; no retry was attempted";

function receiveFailure(message: string): Error {
  // `ToolGateway` uses this marker to persist an attempted write as `unknown`.
  // It does not mean callers may retry: receive_events drains/acks a batch, so
  // the message explicitly says the opposite.
  return marked(new Error(`${message}; ${DELIVERY_UNCERTAIN}`), { mayHaveLanded: true });
}

async function call(
  ctx: PluginContext,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  options: { cache?: "no-store"; deliveryMayHaveOccurred?: boolean } = {},
): Promise<{ status: number; data: ObjectValue }> {
  const origin = baseUrl(ctx);
  const url = new URL(path, origin);
  if (url.origin !== origin.origin) throw new Error("raft request escaped its configured server origin");
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${requireCredential(ctx)}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  let response: Response;
  try {
    // Node's bundled RequestInit type omits `cache`; Workers and fetch accept
    // it. Keep the runtime contract even when the Node type surface lags it.
    const init: any = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(options.cache ? { cache: options.cache } : {}),
      // workerd only accepts "follow" or "manual". Keep redirects manual so
      // the response-status check below rejects 3xx without forwarding the
      // Raft credential to the redirect target.
      redirect: "manual",
      signal: AbortSignal.timeout(timeout(ctx)),
    };
    const started = Date.now();
    const line = { tenantId: ctx.caller.tenantId, agentId: ctx.caller.agentId, mount: ctx.alias, method, route: routeOf(url.pathname) };
    try {
      response = await fetch(url, init);
    } catch (e) {
      logEvent("raft.call", { ...line, status: null, ms: Date.now() - started, error: clip(String((e as { message?: unknown })?.message ?? e)) });
      throw e;
    }
    logEvent("raft.call", { ...line, status: response.status, ms: Date.now() - started });
  } catch {
    throw options.deliveryMayHaveOccurred
      ? receiveFailure("raft event receive failed before a response was received")
      : marked(
        new Error("raft request failed before a response was received; the operation may already have landed"),
        { mayHaveLanded: true },
      );
  }
  let data: unknown = null;
  if (response.status === 204) return { status: response.status, data: {} };
  // A success with nothing to say (Raft's PUT push-webhook answers 200 bare) is not "not JSON".
  const raw = await response.text();
  if (response.ok && raw.trim() === "") return { status: response.status, data: {} };
  try { data = JSON.parse(raw); }
  catch {
    if (!response.ok) {
      const message = `raft returned HTTP ${response.status}`;
      throw options.deliveryMayHaveOccurred
        ? receiveFailure(message)
        : retryable(new Error(message), response.status === 429 || response.status >= 500);
    }
    throw options.deliveryMayHaveOccurred
      ? receiveFailure("raft returned a response that was not JSON")
      : new Error("raft returned a response that was not JSON");
  }
  if (!response.ok) {
    const parsed = object(data);
    const code = text(parsed.errorCode) ?? text(parsed.code);
    const message = `raft returned HTTP ${response.status}${code ? ` (${code})` : ""}`;
    throw options.deliveryMayHaveOccurred
      ? receiveFailure(message)
      : retryable(new Error(message), response.status === 429 || response.status >= 500);
  }
  return { status: response.status, data: object(data) };
}

function operationMayHaveLanded(error: unknown): boolean {
  return error instanceof Error && /operation may already have landed/.test(error.message);
}

function hookIds(state: PushState): string[] {
  return [...new Set([state.hookId, ...state.staleHookIds].filter((value): value is string => value !== null))];
}

async function revokeHooks(ctx: PluginContext, ids: string[]): Promise<string[]> {
  if (!ctx.inbound) return ids;
  const failed: string[] = [];
  for (const id of ids) {
    try { await ctx.inbound.revoke(id); }
    catch { failed.push(id); }
  }
  return failed;
}

function retainHookForCleanup(state: PushState, hookId: string): PushState {
  if (!state.hookId) return { ...state, hookId };
  return {
    ...state,
    staleHookIds: [...new Set([...state.staleHookIds, hookId])],
  };
}

async function raftIdentity(ctx: PluginContext): Promise<{
  agentId: string;
  agentName: string;
  agentDisplayName: string | null;
}> {
  const { data } = await call(ctx, "GET", "/internal/agent-api");
  if (typeof data.agentId !== "string" || typeof data.agentName !== "string" || typeof data.serverId !== "string") {
    throw new Error("Raft returned an unexpected server identity response");
  }
  return {
    agentId: data.agentId,
    agentName: data.agentName,
    agentDisplayName: typeof data.agentDisplayName === "string" && data.agentDisplayName.trim()
      ? data.agentDisplayName
      : null,
  };
}

async function validPushSignature(body: Uint8Array, signature: string | undefined, secret: string): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(signature ?? "")?.[1];
  if (!hex || !secret) return false;
  const actual = Uint8Array.from(hex.match(/../g)!, (pair) => Number.parseInt(pair, 16));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, actual, body);
}

/**
 * The SDK's state for this mount — committed and pending inbox cursors, the seen frontier, held-send
 * keys — kept as one record in the mount's database. The next pull acknowledges what was committed;
 * the frontier is what this agent was shown per conversation, which a send attests so a reply into a
 * conversation it has read is not held. All of it survives the object being a new process between calls.
 */
export const INBOX_STORE = "inbox";
const STATE_KEY = "state";

function isRaftState(value: unknown): value is RaftState {
  const v = object(value);
  return v.schema === RAFT_STATE_SCHEMA && typeof v.version === "number" && typeof v.frontier === "object" && v.frontier !== null;
}

/** The mount's database as the SDK's state store: a read, and a compare-and-set write in one transaction. */
function stateStore(ctx: PluginContext): RaftStateStore {
  return {
    async load() {
      const v = await ctx.db.get(INBOX_STORE, STATE_KEY);
      return isRaftState(v) ? v : null;
    },
    async save(state, { expectedVersion }) {
      await ctx.db.transaction(INBOX_STORE, "readwrite", (tx) => {
        const cur = tx.get(INBOX_STORE, STATE_KEY);
        const stored = isRaftState(cur) ? cur.version : undefined;
        if (stored !== expectedVersion) throw new Error(`stale Raft state: stored ${stored ?? "none"}, expected ${expectedVersion ?? "none"}`);
        tx.put(INBOX_STORE, state as unknown as Json, STATE_KEY);
      });
    },
  };
}

/** A Raft SDK client for this mount: its origin, its credential, its timeout, and its saved state. */
function raftFor(ctx: PluginContext): Raft {
  return createRaft({
    serverUrl: baseUrl(ctx).origin, credential: requireCredential(ctx),
    // Redirects stay manual, as on every other request here, so a 3xx never carries the credential elsewhere.
    fetch: async (input, init) => {
      const started = Date.now();
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const line = { tenantId: ctx.caller.tenantId, agentId: ctx.caller.agentId, mount: ctx.alias, method: init?.method ?? "GET", route: routeOf(u.pathname) };
      let res: Response;
      try {
        res = await fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeout(ctx)) });
      } catch (e) {
        logEvent("raft.call", { ...line, status: null, ms: Date.now() - started, error: clip(String((e as { message?: unknown })?.message ?? e)) });
        throw e;
      }
      logEvent("raft.call", { ...line, status: res.status, ms: Date.now() - started });
      return res;
    },
    state: stateStore(ctx),
    // A save that failed or lost a race costs at most one repeated batch or one extra hold; it never fails
    // the call, and the SDK does not retry it. Said in the Worker's log, where an operator would look.
    onStateSaveError: (error, { phase }) => console.warn(`raft state ${phase} failed for mount ${ctx.alias}: ${String((error as Error)?.message ?? error)}`),
  });
}

/**
 * An SDK failure as this plugin's error: the SDK's safe text and next step, and whether a retry may help.
 * `write` says the operation had an effect to lose: for a send, a request that got no answer or a 5xx may
 * have landed (a repeat with the same key is still safe). A pull under cursor acknowledgement has nothing
 * to lose, since the batch it asked for is acknowledged only by the next pull.
 */
function sdkFailure(out: RaftFailure, write = false): Error {
  const e = new Error(`${out.error.message}${out.error.nextAction ? ` — ${out.error.nextAction}` : ""}`);
  const unanswered = out.error.code === "TRANSPORT_ERROR" || out.error.code === "UNAVAILABLE" ||
    (out.error.status !== undefined && out.error.status >= 500);
  // `retryable` is still what the gateway reads as "may have landed" (it records such a call as unknown), so it
  // follows `mayHaveLanded`, not the SDK's own retryable; whether the failure may clear is `transient`.
  const landed = write && unanswered;
  return marked(e, { retryable: landed, transient: out.error.retryable, mayHaveLanded: landed });
}

/**
 * One message as the model reads it: the SDK's canonical line, which is the CLI's, with the two things
 * the CLI says that are not true on this mount put right. The CLI ends a message that has attachments with
 * "use raft attachment view to download", a command this mount has no tool for, so a model would go looking
 * for it; here the attachments are named and the missing tool is said. And a message whose content Raft left
 * out because it was too large renders as a sender and nothing after the colon, which reads as an empty
 * message; here it says the content was left out. Both are fixed by rebuilding the suffix from the message's
 * own fields and replaced where the CLI put it; the tests assert whole lines, so a change to the SDK's
 * wording shows as a failing test rather than a doubled suffix.
 */
function modelLine(m: RaftMessage): string {
  let line = m.text;
  if (m.attachments.length) {
    const cli = ` [${m.attachments.length} attachment${m.attachments.length > 1 ? "s" : ""}: ${m.attachments.map((a) => `${a.filename} (id:${a.id})`).join(", ")} — use raft attachment view to download]`;
    const ours = ` [${m.attachments.length} attachment${m.attachments.length > 1 ? "s" : ""}: ${m.attachments.map((a) => a.filename).join(", ")} — this mount has no tool to open attachments]`;
    // Replaced where it stands: the CLI puts task and reply suffixes after it, so it is not always last.
    // Not found means the SDK's wording changed; the SDK is pinned to an exact version, and the tests that
    // assert whole lines go red on the upgrade that changes it, rather than a model reading both suffixes.
    line = line.includes(cli) ? line.replace(cli, ours) : line + ours;
  }
  if ((m.raw as { truncated?: unknown }).truncated === true) line += " [content left out by Raft: too large for one pull; this mount has no tool to read it in full]";
  return line;
}

function integer(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}


/**
 * One send, and what to do when the Server holds it: the conversation has messages this agent has not
 * seen. A held send is a question for the model — these arrived; send anyway, or drop? — so it comes
 * back as an `Interrupt` carrying the held messages, and the plugin's `interrupts.resume` takes the answer.
 *
 * The held messages are in the question, so the model sees them now: that is recorded before asking, so
 * the answer "send" (or the model sending the same message again itself, with the same key) attests them
 * instead of being held again. The SDK records nothing when the context was withheld, and then a send is
 * held again with the same count; that is the SDK's rule, not something this can attest for the model.
 *
 * The state is the send itself plus the SDK's continuation (the key and the `seen` boundary): plain data,
 * which is what the SDK hands out for a send continued in a later step. Nothing in it is a credential.
 */
async function sendMessage(
  ctx: PluginContext,
  send: { target: string; content: string; idempotencyKey: string; seen?: { upToSeq: number } },
): Promise<Json | Interrupt> {
  const raft = raftFor(ctx);
  const out = await raft.messages.send(send);
  if (!out.ok) throw sdkFailure(out, true);
  if (out.state === "held") {
    raft.frontier.recordHeld(out.data);
    await raft.state.save();
    const n = out.data.newMessageCount;
    return interrupt({
      question: `${n === 1 ? "A newer message" : `${n} newer messages`} arrived in ${out.data.target} since you last read it; send your message anyway?`,
      context: {
        target: out.data.target, newMessages: n,
        messages: out.data.heldMessages.map(modelLine),
        ...(out.data.omittedMessageCount ? { omitted: out.data.omittedMessageCount } : {}),
        ...(out.data.withheld ? { withheld: true } : {}),
      },
      answer: { choices: ["send", "drop"] },
      state: {
        target: send.target, content: send.content, idempotencyKey: out.data.continuation.idempotencyKey,
        ...(out.data.continuation.seen ? { seen: { upToSeq: out.data.continuation.seen.upToSeq } } : {}),
      },
    });
  }
  return {
    state: "sent", messageId: out.data.messageId,
    ...(out.data.messageSeq !== null ? { messageSeq: out.data.messageSeq } : {}),
    ...(out.data.recentUnread.length ? { recentUnread: out.data.recentUnread.map(modelLine) } : {}),
  };
}

export const raftPlugin: Plugin = {
  id: "raft",
  version: "1.0.0",
  /** The push registration this mount holds: whether it exists is listable, what it holds is not. */
  database: {
    version: 3, stores: { [PUSH_STORE]: { listed: [PUSH_KEY] }, [INBOX_STORE]: { listed: [STATE_KEY] } },
    /**
     * Version 2 kept the cursor and the frontier under their own keys; version 3 keeps the SDK's state record.
     * The version-2 cursor was the last batch handed to the model, not yet acknowledged, which is exactly the
     * SDK's pending cursor: carried over, the next call commits it and the pull after acknowledges it, so an
     * upgrade neither repeats a batch nor acknowledges one early.
     */
    upgrade(db, oldVersion) {
      if (oldVersion !== 2) return;
      const cursor = db.get(INBOX_STORE, "cursor");
      const frontier = db.get(INBOX_STORE, "frontier");
      const f = object(frontier);
      const state: RaftState = {
        schema: RAFT_STATE_SCHEMA, version: 0, cursor: null,
        pendingCursor: typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : null,
        frontier: f.version === 1 && typeof f.targets === "object" && f.targets !== null && typeof f.aliases === "object" && f.aliases !== null
          ? f as unknown as RaftState["frontier"] : { version: 1, targets: {}, aliases: {} },
      };
      db.put(INBOX_STORE, state as unknown as Json, STATE_KEY);
      db.delete(INBOX_STORE, "cursor");
      db.delete(INBOX_STORE, "frontier");
    },
  },
  config: [
    { name: "serverUrl", type: "string", required: true, format: "origin", summary: "Raft server origin, for example https://api.raft.build." },
    { name: "timeoutMs", type: "number", default: DEFAULT_TIMEOUT_MS, summary: "Request timeout in milliseconds, clamped to 1000–60000." },
  ],
  credential: {
    required: true,
    summary: "A Raft agent credential for the agent account this mount represents.",
    shape: "token",
    grants: "Send messages, receive queued events, join visible channels, and post action cards as that Raft agent.",
    looksLike: [{ kind: "Raft agent credential", pattern: "sk_agent_[A-Za-z0-9_-]{16,}" }],
  },
  tools: [
    {
      name: "send_message",
      summary: "Send a message to a Raft channel, thread, or DM. The target is explicit; copy it from the `target=` of the message you answer. " +
        "If newer messages arrived there that you have not seen, nothing is sent yet: the result is \"yielded\" with those messages " +
        "and the question whether to send anyway. Read them, then resume with \"send\" to send it as written or \"drop\" to send " +
        "nothing; to change the message, drop it and call send_message again with the new content and a new idempotencyKey.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          target: { type: "string", description: "For example #general, #general:abcd1234, or dm:@name." },
          content: { type: "string" },
          idempotencyKey: { type: "string", description: "One key per message: the same content again uses the same key; changed content uses a new key." },
        },
        required: ["target", "content", "idempotencyKey"],
      },
      sideEffects: "write",
      idempotency: "key",
    },
    {
      name: "receive_events",
      summary: "Read your queued Raft messages: the way to read after an inbox notice. Each message is one line, " +
        "`[target=… msg=… time=… type=…] @sender: content`; reply with send_message to that target. Raft hands out at most a few " +
        "per conversation per call: while hasMore is true, call again. A batch is acknowledged by your next call, so a failed call " +
        "loses nothing and may simply be repeated.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_EVENTS },
        },
      },
      // It acknowledges the previous batch, so it is a write; repeating it hands back the same batch.
      sideEffects: "write",
      idempotency: "native",
    },
    {
      name: "join_channel",
      summary: "Join one visible regular Raft channel. DMs and thread targets are not channel memberships.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: { target: { type: "string", description: "A regular channel such as #engineering." } },
        required: ["target"],
      },
      sideEffects: "write",
      idempotency: "native",
    },
    {
      name: "enable_push",
      summary: "Create and register this mount's signed Raft push endpoint: Raft then notifies this agent when its inbox changes.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "disable_push",
      summary: "Stop Raft from pushing this agent's messages through this mount.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      sideEffects: "write",
      idempotency: "native",
    },
    {
      name: "prepare_action",
      summary: "Post an action card in a Raft channel or DM for a person to confirm: creating a channel, adding members to one, " +
        "or creating an agent. Nothing happens until a person clicks it there; they act with their own permissions. " +
        "Use it for what you cannot or should not do yourself, and say in draftHint why you prepared it.",
      parameters: {
        type: "object", additionalProperties: false, required: ["target", "action"],
        properties: {
          target: { type: "string", description: "Where the card is posted, for example #general or dm:@name." },
          action: {
            oneOf: [
              {
                type: "object", additionalProperties: false, required: ["type", "name"],
                properties: {
                  type: { const: "channel:create" },
                  name: { type: "string", maxLength: 80 },
                  visibility: { enum: ["public", "private"] },
                  description: { type: "string", maxLength: 500 },
                  initialHumans: { type: "array", items: { type: "string" }, maxItems: 64, description: "handles or ids" },
                  initialAgents: { type: "array", items: { type: "string" }, maxItems: 64, description: "handles or ids" },
                  draftHint: { type: "string", maxLength: 2000 },
                },
              },
              {
                type: "object", additionalProperties: false, required: ["type", "channel"],
                properties: {
                  type: { const: "channel:add_member" },
                  channel: { type: "string", description: "#name or id" },
                  humans: { type: "array", items: { type: "string" }, maxItems: 64 },
                  agents: { type: "array", items: { type: "string" }, maxItems: 64 },
                  draftHint: { type: "string", maxLength: 2000 },
                },
              },
              {
                type: "object", additionalProperties: false, required: ["type", "name"],
                properties: {
                  type: { const: "agent:create" },
                  name: { type: "string", maxLength: 60 },
                  description: { type: "string", maxLength: 500 },
                  draftHint: { type: "string", maxLength: 2000 },
                },
              },
            ],
          },
        },
      },
      // Each call posts a card; a repeat posts another.
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "push_status",
      summary: "Show whether Raft push is enabled for this mount and when a delivery last reached it.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      sideEffects: "read",
      idempotency: "native",
    },
  ],

  /**
   * A held send's question, answered. "send" sends the same message under the same key, attesting what
   * the question showed (the continuation's `seen`, and the frontier `recordHeld` saved): so it goes
   * through unless the conversation moved again since, which asks again with the newer messages. "drop"
   * sends nothing; the model changes a message by dropping it and sending a new one. Expiry and cancel
   * need nothing back: holding a send takes nothing on the Server.
   */
  interrupts: {
    async resume(tool, state, answer, ctx) {
      if (tool !== "send_message") throw new Error(`raft: ${tool} does not ask questions`);
      const s = object(state);
      if (typeof s.target !== "string" || typeof s.content !== "string" || typeof s.idempotencyKey !== "string") {
        throw new Error("raft: the held send's state is incomplete; call send_message again");
      }
      if (answer === "drop") {
        return { state: "dropped", target: s.target, note: "Not sent. To send something else, call send_message with the new content and a new idempotencyKey." };
      }
      if (answer !== "send") throw new Error(`raft: the answer must be "send" or "drop", not ${JSON.stringify(answer)}`);
      const seen = object(s.seen);
      return sendMessage(ctx, {
        target: s.target, content: s.content, idempotencyKey: s.idempotencyKey,
        ...(typeof seen.upToSeq === "number" ? { seen: { upToSeq: seen.upToSeq } } : {}),
      });
    },
  },

  async checkCredential(ctx) {
    if (!ctx.credential) return { ok: false, kind: "rejected", reason: "no Raft agent credential was supplied" };
    try {
      const identity = await raftIdentity(ctx);
      return {
        ok: true,
        account: identity.agentDisplayName
          ? `${identity.agentDisplayName} (@${identity.agentName})`
          : `@${identity.agentName}`,
      };
    } catch (e) {
      const reason = String((e as Error)?.message ?? e);
      return { ok: false, kind: /HTTP (401|403)\b/.test(reason) ? "rejected" : "unreachable", reason };
    }
  },

  async invoke(name, args, ctx): Promise<Json> {
    const a = object(args);
    if (name === "send_message") {
      if (typeof a.target !== "string" || !a.target.trim()) throw new Error("target is required");
      if (typeof a.content !== "string" || !a.content.trim()) throw new Error("content is required");
      if (typeof a.idempotencyKey !== "string" || !a.idempotencyKey.trim()) throw new Error("idempotencyKey is required");
      return sendMessage(ctx, { target: a.target, content: a.content, idempotencyKey: a.idempotencyKey });
    }
    if (name === "receive_events") {
      const limit = integer(a.limit, "limit", 1, MAX_EVENTS);
      const raft = raftFor(ctx);
      // Cursor acknowledgement: nothing is acknowledged by being fetched. This call commits the batch the
      // previous call handed to the model (kept as pending in the mount's state, since the object may be a
      // new process by now), and the pull sends that as `since`, which is what acknowledges it on the
      // Server. A pull that fails leaves the new batch pending, so the next call gets it again.
      await raft.inbox.commit();
      const out = await raft.inbox.check({ ack: "cursor", ...(limit !== undefined ? { limit } : {}) });
      if (!out.ok) throw sdkFailure(out);
      const batch = out.data;
      return {
        messages: batch.messages.map(modelLine),
        hasMore: batch.hasMore,
        ...(batch.hasMore ? { note: "More unread messages remain: call receive_events again until hasMore is false." } : {}),
        ...(batch.replyTarget ? { replyTarget: batch.replyTarget } : {}),
        // A Server that predates cursor acks acknowledged this batch already; say so rather than imply safety.
        ...(batch.ackMode === "immediate" ? { acknowledged: "on this read" } : {}),
      };
    }
    if (name === "join_channel") {
      if (typeof a.target !== "string" || !a.target.startsWith("#") || a.target.includes(":")) {
        throw new Error("target must be a regular channel in the form #channel-name");
      }
      const channelName = a.target.slice(1).trim();
      if (!channelName) throw new Error("target must be a regular channel in the form #channel-name");
      const { status, data } = await call(ctx, "GET", "/internal/agent-api/server");
      const channels = Array.isArray(data.channels) ? data.channels.map(object) : [];
      const channel = channels.find((candidate) => candidate.name === channelName);
      if (!channel || typeof channel.id !== "string") throw new Error(`channel not found: ${a.target}`);
      if (channel.joined === true) return { state: "already_joined", target: a.target, channelId: channel.id, status };
      const joined = await call(ctx, "POST", `/internal/agent-api/channels/${encodeURIComponent(channel.id)}/join`);
      if (joined.data.ok !== true) throw new Error("raft join response did not match the expected contract");
      return { state: "joined", target: a.target, channelId: channel.id, status: joined.status };
    }
    if (name === "enable_push") {
      if (!ctx.inbound) throw new Error("this deployment cannot receive pushed Raft events");
      const identity = await raftIdentity(ctx);
      let current = await loadPushState(ctx);
      if (current.staleHookIds.length > 0) {
        const staleHookIds = await revokeHooks(ctx, current.staleHookIds);
        current = { ...current, staleHookIds };
        await savePushState(ctx, current);
        if (staleHookIds.length > 0) {
          throw marked(
            new Error("superseded Raft push endpoints could not be cleaned up; try enable_push again"),
            { transient: true },
          );
        }
      }
      // No cap check of its own here. One stood here and could not fire: the
      // block above either throws or leaves `staleHookIds` empty, so
      // `hookIds(current)` is at most the one live id and `>= 3` never held. A
      // reader who saw it would think this function checks the cap, when two
      // other things do — the throw above, which stops a mount with leftovers
      // from creating anything, and `create()` itself, which the runtime refuses
      // past `INBOUND_HOOKS_PER_MOUNT` (#388).
      //
      // Moving it earlier would be worse than leaving it dead: the ids it would
      // count are exactly the ones the block above clears, so refusing before
      // that ran would leave a mount whose revokes had failed a few times unable
      // to enable push ever again — the failure this ordering exists to prevent
      // (my review of #379).
      const created = await ctx.inbound.create();
      const replaced = hookIds(current);
      try {
        await call(ctx, "PUT", PUSH_REGISTRATION_PATH, { url: created.url, secret: created.secret });
      } catch (error) {
        if (operationMayHaveLanded(error)) {
          await savePushState(ctx, {
            ...current,
            enabled: true,
            agentId: identity.agentId,
            agentName: identity.agentName,
            hookId: created.hookId,
            staleHookIds: replaced,
            registration: "uncertain",
          });
        } else {
          const failed = await revokeHooks(ctx, [created.hookId]);
          if (failed.length > 0) await savePushState(ctx, retainHookForCleanup(current, created.hookId));
        }
        throw error;
      }
      const next: PushState = {
        ...current,
        enabled: true,
        agentId: identity.agentId,
        agentName: identity.agentName,
        hookId: created.hookId,
        staleHookIds: replaced,
        registration: "active",
      };
      await savePushState(ctx, next);
      const staleHookIds = await revokeHooks(ctx, replaced);
      if (staleHookIds.length !== next.staleHookIds.length) {
        await savePushState(ctx, { ...next, staleHookIds });
      }
      return {
        enabled: true,
        account: identity.agentDisplayName
          ? `${identity.agentDisplayName} (@${identity.agentName})`
          : `@${identity.agentName}`,
        registration: "active",
      };
    }
    if (name === "disable_push") {
      const current = await loadPushState(ctx);
      // The service would otherwise show the agent "online" for ever: say the session ended
      // first, best effort, before the account stops being able to say anything.
      if (current.enabled && current.agentId) {
        try {
          await call(ctx, "POST", ACTIVITY_PATH, { schema: ACTIVITY_SCHEMA, events: [{
            eventId: `${current.agentId}:session-end:${Date.now()}`, hookEventName: "SessionEnd", status: "offline", occurredAt: new Date().toISOString(),
          }] });
        } catch { /* deregistration matters more than the last status line */ }
      }
      let remoteDeregistration: "confirmed" | "unconfirmed" = "confirmed";
      try { await call(ctx, "DELETE", PUSH_REGISTRATION_PATH); }
      catch (error) {
        if (!(error instanceof Error) || !/\(PUSH_WEBHOOK_NOT_FOUND\)/.test(error.message)) {
          remoteDeregistration = "unconfirmed";
        }
      }
      const staleHookIds = await revokeHooks(ctx, hookIds(current));
      await savePushState(ctx, {
        ...current,
        enabled: false,
        hookId: null,
        staleHookIds,
        registration: null,
      });
      return { enabled: false, remoteDeregistration, cleanupPending: staleHookIds.length };
    }
    if (name === "prepare_action") {
      if (typeof a.target !== "string" || !a.target.trim()) throw new Error("target is required");
      const action = object(a.action);
      // The three a model may prepare. The integration cards take ids a model has no way to know, and are
      // made by Raft's own integration commands.
      if (action.type !== "channel:create" && action.type !== "channel:add_member" && action.type !== "agent:create") {
        throw new Error("action.type must be channel:create, channel:add_member or agent:create");
      }
      const out = await raftFor(ctx).actions.prepare({ target: a.target, action } as never);
      // A card that got no answer may have been posted; a refusal (Raft's contract, checked before sending,
      // or the Server's) did nothing.
      if (!out.ok) throw sdkFailure(out, true);
      return {
        prepared: true, target: out.data.target, messageId: out.data.messageId,
        // The SDK's own sentence, which is the CLI's; its `next` names a CLI command this mount has no tool
        // for, so it is not passed on.
        text: out.text.trim(),
        // Not "the outcome arrives in your inbox", though the SDK's `next.why` says so: as of 2026-09-29 Raft
        // sends the preparer nothing when a card is executed, and a model told to wait would wait for ever.
        note: "Nothing has happened yet. A person confirms the card in Raft, acting with their own permissions. " +
          "You are not told when that happens; if it matters, check for its effect later.",
      };
    }
    if (name === "push_status") {
      const current = await loadPushState(ctx);
      return {
        enabled: current.enabled,
        account: current.agentName ? `@${current.agentName}` : null,
        registration: current.registration,
        cleanupPending: current.staleHookIds.length,
        lastReached: current.lastReached
          ? { deliveryId: current.lastReached.deliveryId, at: new Date(current.lastReached.at).toISOString() }
          : null,
      };
    }
    throw new Error(`unknown raft tool: ${name}`);
  },

  /**
   * The agent's activity, to Raft's ingest, so Agent Activity shows this agent
   * the way it shows a managed one. Only while push is on: that is the state
   * in which Raft is running this agent and looking. The events are passed
   * through as given; the field set is the runtime's (src/runtime/activity.ts)
   * and Raft refuses an unknown field, so nothing is added here.
   */
  async reportActivity(events: readonly ActivityEvent[], ctx: PluginContext) {
    const state = await loadPushState(ctx);
    if (!state.enabled) return { skipped: "push is disabled for this mount, so Raft is not following this agent" };
    // A mount whose account is gone (a delete whose disable_push could not run) has nobody to tell; it
    // is skipped, not an error, or the alarm would retry every minute for ever.
    if (!ctx.credential) return { skipped: "this mount has no account, so Raft cannot be told" };
    if (events.length === 0) return { sent: 0 };
    const answer = (await call(ctx, "POST", ACTIVITY_PATH, { schema: ACTIVITY_SCHEMA, events })).data;
    // A 200 is not "all taken": Raft counts what it refused and still answers 200. Refused events are
    // not resent — they are the same events next time too — so they are said, where an operator would look.
    const refused = typeof answer.rejectedCount === "number" ? answer.rejectedCount : 0;
    if (refused > 0) {
      const statusOnly = events.filter((e) => !e.hookEventName).length;
      console.warn(`raft mount ${ctx.alias}: Raft refused ${refused} of ${events.length} activity event(s) (${statusOnly} status-only in the batch)`);
    }
    return { sent: Math.max(0, events.length - refused) };
  },

  /**
   * One signed inbox notice from Raft (raft-agent-inbox-notice.v1): a
   * reminder that this agent's inbox changed, in Raft's own words, delivered to
   * the agent as a wake, never the messages themselves.
   */
  async receive(inbound, secret, ctx) {
    const signature = inbound.headers["x-raft-signature-256"];
    if (!signature) {
      return { deliver: false, rejected: true, reason: "unsigned: the Raft webhook signature is missing" };
    }
    if (!(await validPushSignature(inbound.body, signature, secret))) {
      return { deliver: false, rejected: true, reason: "the signature does not match this mount's inbound secret" };
    }
    // Signed by Raft, so what follows is Raft's own mistake, not a stranger's:
    // `malformed` (400), never `rejected` (401), which Raft counts towards
    // switching the registration off. A field this version does not know is
    // ignored; a change that would need refusing is what a v2 schema is for.
    let payload: ObjectValue;
    try { payload = object(JSON.parse(new TextDecoder().decode(inbound.body))); }
    catch { return { deliver: false, malformed: true, reason: "signed, but the body is not JSON" }; }
    if (payload.schema !== NOTICE_SCHEMA) {
      // The schema value itself is named: it is the one fact that tells an old
      // format apart from a new one with a field wrong (the 09:44Z 400 on 2026-09-28
      // could not be told apart from our record).
      const schema = typeof payload.schema === "string" ? payload.schema.slice(0, 64) : typeof payload.schema;
      return { deliver: false, malformed: true, reason: `signed, but the schema is ${JSON.stringify(schema)}, not ${NOTICE_SCHEMA}` };
    }
    return receiveNotice(payload, inbound, ctx);
  },
};

/**
 * A signed inbox notice: Raft's own words about what is unread, handed to the
 * model as they are, plus the one instruction Raft's daemon gives a managed
 * agent — read it yourself. The notice is Raft's text, not a person's, so it
 * goes under the outside-content label (`as` stays the default).
 */
async function receiveNotice(payload: ObjectValue, inbound: InboundEvent, ctx: PluginContext): Promise<InboundResult> {
  const headers = inbound.headers;
  const missing = [
    typeof payload.noticeId !== "string" || !PUSH_ID.test(payload.noticeId) ? "noticeId" : null,
    typeof payload.recipientAgentId !== "string" || !PUSH_ID.test(payload.recipientAgentId) ? "recipientAgentId" : null,
    typeof payload.text !== "string" || !payload.text.trim() ? "text" : null,
    !Array.isArray(payload.targets) ? "targets" : null,
  ].filter((f): f is string => f !== null);
  if (missing.length) {
    // Field names only, never values: the record is read by an operator, and a value may be anything.
    return { deliver: false, malformed: true, reason: `signed ${NOTICE_SCHEMA}, but not a notice: ${missing.join(", ")} missing or malformed` };
  }
  const headerId = headers["x-raft-delivery-id"];
  if (!headerId || headerId !== payload.noticeId) {
    return { deliver: false, malformed: true, reason: "the Raft delivery id header does not match the signed notice" };
  }
  let state = await loadPushState(ctx);
  if (!state.known) {
    // No record, yet a notice signed with this hook's secret: Raft still points at this hook, and the
    // notice names the agent it is for. That is everything `enable_push` would have recorded, so the
    // record is rebuilt from the delivery and the notice goes through — without calling Raft, and
    // without a new hook. A storage change that dropped per-mount state was the first occasion; a
    // record that says disabled is not this case, and stays ignored below.
    state = {
      known: true, enabled: true, agentId: payload.recipientAgentId, agentName: null,
      hookId: PUSH_ID.test(inbound.hookId) ? inbound.hookId : null, staleHookIds: [], registration: "active", lastReached: null,
    };
  }
  await savePushState(ctx, { ...state, lastReached: { deliveryId: payload.noticeId, at: Date.now() } });
  if (!state.enabled) return { deliver: false, reason: "push is disabled for this mount" };
  if (!state.agentId || payload.recipientAgentId !== state.agentId) {
    return { deliver: false, reason: "the signed notice names a different Raft agent" };
  }
  const body = payload.text.length > NOTICE_TEXT_MAX ? `${payload.text.slice(0, NOTICE_TEXT_MAX)}… (cut)` : payload.text;
  return {
    deliver: true,
    text: `Read your Raft inbox with the \`receive_events\` tool from the \`${ctx.alias}\` mount, until hasMore is false; your next read acknowledges what you were given.\n\n${body}`,
    dedupeKey: payload.noticeId,
  };
}

