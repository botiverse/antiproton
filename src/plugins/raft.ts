/**
 * Raft messaging for an agent running inside Antiproton.
 *
 * The QuickJS program sees structured tools. The Raft credential stays
 * in the host plugin and is attached only to the operator-configured Raft
 * origin. Responses are projected so a new server field cannot silently enter
 * the model's context.
 */
import type { Json } from "../core/types.ts";
import { originProblem, type ActivityEvent, type InboundResult, type Plugin, type PluginContext, type PluginErrorFields } from "./types.ts";

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
const NOTICE_TEXT_MAX = 4_000;
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

async function loadPushState(ctx: PluginContext): Promise<PushState> {
  return pushState(await ctx.connection.get());
}

async function savePushState(ctx: PluginContext, state: PushState): Promise<void> {
  await ctx.connection.set(state as unknown as Json);
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
    response = await fetch(url, init);
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

function attachment(value: unknown): Json | null {
  const a = object(value);
  if (typeof a.id !== "string" || typeof a.filename !== "string") return null;
  return {
    id: a.id,
    filename: a.filename,
    ...(typeof a.mimeType === "string" ? { mimeType: a.mimeType } : {}),
    ...(typeof a.sizeBytes === "number" ? { sizeBytes: a.sizeBytes } : {}),
  };
}

function event(value: unknown): Json {
  const e = object(value);
  const sender = text(e.sender_type) ?? text(e.senderType);
  const attachments = Array.isArray(e.attachments)
    ? e.attachments.map(attachment).filter((a): a is Json => a !== null)
    : [];
  return {
    type: "message",
    ...(text(e.message_id) ?? text(e.id) ? { messageId: text(e.message_id) ?? text(e.id) } : {}),
    ...(number(e.seq) !== undefined ? { seq: number(e.seq) } : {}),
    ...(text(e.content) !== undefined ? { content: text(e.content) } : {}),
    ...(text(e.timestamp) ?? text(e.createdAt) ? { timestamp: text(e.timestamp) ?? text(e.createdAt) } : {}),
    senderType: ["human", "agent", "system", "third_party_app"].includes(sender ?? "") ? sender! : "unknown",
    ...(text(e.sender_name) ?? text(e.senderName) ? { senderName: text(e.sender_name) ?? text(e.senderName) } : {}),
    ...(text(e.sender_id) ? { senderId: text(e.sender_id) } : {}),
    ...(text(e.channel_id) ? { channelId: text(e.channel_id) } : {}),
    ...(text(e.channel_name) ? { channelName: text(e.channel_name) } : {}),
    ...(text(e.channel_type) ? { channelType: text(e.channel_type) } : {}),
    ...(text(e.parent_channel_name) ? { parentChannelName: text(e.parent_channel_name) } : {}),
    ...(text(e.parent_channel_type) ? { parentChannelType: text(e.parent_channel_type) } : {}),
    // Where a reply to this message goes. A raft-agent-inbox.v2 batch names one
    // per message, since one batch spans conversations; the pull answer names
    // one for the whole batch instead.
    ...(text(e.reply_target) ? { replyTarget: text(e.reply_target) } : {}),
    ...(typeof e.mentioned === "boolean" ? { mentioned: e.mentioned } : {}),
    // Raft leaves out the content of a message too large for the batch and says so.
    ...(e.truncated === true ? { truncated: true } : {}),
    // A message that is a task carries the task's number and status.
    ...(number(e.task_number) !== undefined ? { taskNumber: number(e.task_number) } : {}),
    ...(text(e.task_status) ? { taskStatus: text(e.task_status) } : {}),
    attachments,
  } as Json;
}

function sendResult(data: ObjectValue): Json {
  if (data.state === "sent" && data.ok === true && typeof data.messageId === "string") {
    return {
      state: "sent", messageId: data.messageId,
      ...(number(data.messageSeq) !== undefined ? { messageSeq: number(data.messageSeq) } : {}),
    };
  }
  if (data.state === "held") {
    return {
      state: "held",
      ...(text(data.reason) ? { reason: text(data.reason) } : {}),
      ...(Array.isArray(data.available_actions)
        ? { availableActions: data.available_actions.filter((v): v is string => typeof v === "string") }
        : {}),
    };
  }
  throw new Error("raft send response did not match the expected contract");
}

function integer(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

export const raftPlugin: Plugin = {
  id: "raft",
  version: "1.0.0",
  config: [
    { name: "serverUrl", type: "string", required: true, format: "origin", summary: "Raft server origin, for example https://api.raft.build." },
    { name: "timeoutMs", type: "number", default: DEFAULT_TIMEOUT_MS, summary: "Request timeout in milliseconds, clamped to 1000–60000." },
  ],
  credential: {
    required: true,
    summary: "A Raft agent credential for the agent account this mount represents.",
    shape: "token",
    grants: "Send messages, receive queued events, and join visible channels as that Raft agent.",
    looksLike: [{ kind: "Raft agent credential", pattern: "sk_agent_[A-Za-z0-9_-]{16,}" }],
  },
  tools: [
    {
      name: "send_message",
      summary: "Send a message to a Raft channel, thread, or DM. The target is explicit; this tool does not infer a reply target.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          target: { type: "string", description: "For example #general, #general:abcd1234, or dm:@name." },
          content: { type: "string" },
          idempotencyKey: { type: "string", description: "Stable key for safely repeating this send." },
        },
        required: ["target", "content", "idempotencyKey"],
      },
      sideEffects: "write",
      idempotency: "key",
    },
    {
      name: "receive_events",
      summary: "Receive and acknowledge queued Raft messages once: the way to read after an inbox notice. A failed call may already have consumed the returned batch; do not retry automatically.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          since: { anyOf: [{ type: "integer", minimum: 0 }, { const: "latest" }] },
          limit: { type: "integer", minimum: 1, maximum: MAX_EVENTS },
        },
      },
      sideEffects: "write",
      idempotency: "none",
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
      name: "push_status",
      summary: "Show whether Raft push is enabled for this mount and when a delivery last reached it.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      sideEffects: "read",
      idempotency: "native",
    },
  ],

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
      const { data } = await call(ctx, "POST", "/internal/agent-api/send", {
        target: a.target, content: a.content, idempotencyKey: a.idempotencyKey,
      });
      return sendResult(data);
    }
    if (name === "receive_events") {
      const since = a.since === "latest" ? "latest" : integer(a.since, "since", 0, Number.MAX_SAFE_INTEGER);
      const limit = integer(a.limit, "limit", 1, MAX_EVENTS);
      const query = new URLSearchParams();
      if (since !== undefined) query.set("since", String(since));
      if (limit !== undefined) query.set("limit", String(limit));
      const { data } = await call(
        ctx,
        "GET",
        `/internal/agent-api/events${query.size ? `?${query}` : ""}`,
        undefined,
        { cache: "no-store", deliveryMayHaveOccurred: true },
      );
      if (!Array.isArray(data.events) || typeof data.has_more !== "boolean") {
        throw receiveFailure("raft events response did not match the expected contract");
      }
      return {
        events: data.events.map(event),
        lastSeenSeq: typeof data.last_seen_seq === "number" ? data.last_seen_seq : null,
        lastSeenMessageId: typeof data.last_seen_msgId === "string" ? data.last_seen_msgId : null,
        hasMore: data.has_more,
        replyTarget: typeof data.reply_target === "string" ? data.reply_target : null,
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
            eventId: `${current.agentId}:session-end:${Date.now()}`, hookEventName: "SessionEnd", occurredAt: new Date().toISOString(),
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
    if (events.length === 0) return { sent: 0 };
    await call(ctx, "POST", ACTIVITY_PATH, { schema: ACTIVITY_SCHEMA, events });
    return { sent: events.length };
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
      return { deliver: false, malformed: true, reason: `signed, but the body is not a ${NOTICE_SCHEMA} notice` };
    }
    return receiveNotice(payload, inbound.headers, ctx);
  },
};

/**
 * A signed inbox notice: Raft's own words about what is unread, handed to the
 * model as they are, plus the one instruction Raft's daemon gives a managed
 * agent — read it yourself. The notice is Raft's text, not a person's, so it
 * goes under the outside-content label (`as` stays the default).
 */
async function receiveNotice(payload: ObjectValue, headers: Record<string, string>, ctx: PluginContext): Promise<InboundResult> {
  if (typeof payload.noticeId !== "string" || !PUSH_ID.test(payload.noticeId) ||
      typeof payload.recipientAgentId !== "string" || !PUSH_ID.test(payload.recipientAgentId) ||
      typeof payload.text !== "string" || !payload.text.trim() || !Array.isArray(payload.targets)) {
    return { deliver: false, malformed: true, reason: `signed, but the body is not a ${NOTICE_SCHEMA} notice` };
  }
  const headerId = headers["x-raft-delivery-id"];
  if (!headerId || headerId !== payload.noticeId) {
    return { deliver: false, malformed: true, reason: "the Raft delivery id header does not match the signed notice" };
  }
  const state = await loadPushState(ctx);
  await savePushState(ctx, { ...state, lastReached: { deliveryId: payload.noticeId, at: Date.now() } });
  if (!state.enabled) return { deliver: false, reason: "push is disabled for this mount" };
  if (!state.agentId || payload.recipientAgentId !== state.agentId) {
    return { deliver: false, reason: "the signed notice names a different Raft agent" };
  }
  const body = payload.text.length > NOTICE_TEXT_MAX ? `${payload.text.slice(0, NOTICE_TEXT_MAX)}… (cut)` : payload.text;
  return {
    deliver: true,
    text: `${body}\n\nRead them with the \`receive_events\` tool from the \`${ctx.alias}\` mount; that read is what acknowledges them.`,
    dedupeKey: payload.noticeId,
  };
}

