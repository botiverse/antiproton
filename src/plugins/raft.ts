/**
 * Raft messaging for an agent running inside Antiproton.
 *
 * The QuickJS program sees structured tools. The Raft credential stays
 * in the host plugin and is attached only to the operator-configured Raft
 * origin. Responses are projected so a new server field cannot silently enter
 * the model's context.
 */
import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_EVENTS = 200;
const PUSH_SCHEMA = "raft-agent-inbox.v1";
const PUSH_REASON = "inbox_changed";
const PUSH_REGISTRATION_PATH = "/internal/agent-api/push-webhook";
const PUSH_EVENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PUSH_FIELDS = new Set(["schema", "eventId", "recipientAgentId", "reason"]);

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
  lastReached: { eventId: string; at: number } | null;
};

function pushState(value: unknown): PushState {
  const state = object(value);
  const reached = object(state.lastReached);
  const staleHookIds = Array.isArray(state.staleHookIds)
    ? [...new Set(state.staleHookIds.filter((value): value is string => typeof value === "string" && PUSH_EVENT_ID.test(value)))].slice(0, 2)
    : [];
  return {
    enabled: state.enabled === true,
    agentId: text(state.agentId) ?? null,
    agentName: text(state.agentName) ?? null,
    hookId: typeof state.hookId === "string" && PUSH_EVENT_ID.test(state.hookId) ? state.hookId : null,
    staleHookIds,
    registration: state.registration === "active" || state.registration === "uncertain" ? state.registration : null,
    lastReached: typeof reached.eventId === "string" && typeof reached.at === "number" &&
        Number.isFinite(reached.at) && Math.abs(reached.at) <= 8.64e15
      ? { eventId: reached.eventId, at: reached.at }
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
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error("raft serverUrl must be an absolute http or https origin"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash ||
      (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("raft serverUrl must be an http or https origin without credentials, path, query, or fragment");
  }
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

function retryable(error: Error, value = true): Error {
  (error as Error & { retryable?: boolean }).retryable = value;
  return error;
}

const DELIVERY_UNCERTAIN =
  "delivery acknowledgement may already have occurred; no retry was attempted";

function receiveFailure(message: string): Error {
  // `ToolGateway` uses this marker to persist an attempted write as `unknown`.
  // It does not mean callers may retry: receive_events drains/acks a batch, so
  // the message explicitly says the opposite.
  return retryable(new Error(`${message}; ${DELIVERY_UNCERTAIN}`));
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
      : retryable(new Error("raft request failed before a response was received; the operation may already have landed"));
  }
  let data: unknown = null;
  if (response.status === 204) return { status: response.status, data: {} };
  try { data = await response.json(); }
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
    staleHookIds: [...new Set([...state.staleHookIds, hookId])].slice(0, 2),
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
    ...(text(e.channel_name) ? { channelName: text(e.channel_name) } : {}),
    ...(text(e.channel_type) ? { channelType: text(e.channel_type) } : {}),
    ...(text(e.parent_channel_name) ? { parentChannelName: text(e.parent_channel_name) } : {}),
    ...(text(e.parent_channel_type) ? { parentChannelType: text(e.parent_channel_type) } : {}),
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
    { name: "serverUrl", type: "string", required: true, summary: "Raft server origin, for example https://api.raft.build." },
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
      summary: "Receive and acknowledge queued Raft messages once. A failed call may already have consumed the returned batch; do not retry automatically.",
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
      summary: "Create and register this mount's signed, content-free Raft inbox wake endpoint.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "disable_push",
      summary: "Stop signed Raft inbox notifications from waking this agent through this mount.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      sideEffects: "write",
      idempotency: "native",
    },
    {
      name: "push_status",
      summary: "Show whether signed Raft inbox notifications are enabled and when one last reached this mount.",
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
      const current = await loadPushState(ctx);
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
            staleHookIds: replaced.slice(0, 2),
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
        staleHookIds: replaced.slice(0, 2),
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
      await call(ctx, "DELETE", PUSH_REGISTRATION_PATH);
      const staleHookIds = await revokeHooks(ctx, hookIds(current));
      await savePushState(ctx, {
        ...current,
        enabled: false,
        hookId: null,
        staleHookIds,
        registration: null,
      });
      return { enabled: false };
    }
    if (name === "push_status") {
      const current = await loadPushState(ctx);
      return {
        enabled: current.enabled,
        account: current.agentName ? `@${current.agentName}` : null,
        registration: current.registration,
        cleanupPending: current.staleHookIds.length,
        lastReached: current.lastReached
          ? { eventId: current.lastReached.eventId, at: new Date(current.lastReached.at).toISOString() }
          : null,
      };
    }
    throw new Error(`unknown raft tool: ${name}`);
  },

  async receive(inbound, secret, ctx) {
    const signature = inbound.headers["x-raft-signature-256"];
    if (!signature) {
      return { deliver: false, rejected: true, reason: "unsigned: the Raft webhook signature is missing" };
    }
    if (!(await validPushSignature(inbound.body, signature, secret))) {
      return { deliver: false, rejected: true, reason: "the signature does not match this mount's inbound secret" };
    }

    let payload: ObjectValue;
    try { payload = object(JSON.parse(new TextDecoder().decode(inbound.body))); }
    catch { return { deliver: false, rejected: true, reason: "signed, but the body is not JSON" }; }
    if (payload.schema !== PUSH_SCHEMA || payload.reason !== PUSH_REASON ||
        typeof payload.eventId !== "string" || !PUSH_EVENT_ID.test(payload.eventId) ||
        typeof payload.recipientAgentId !== "string" || !PUSH_EVENT_ID.test(payload.recipientAgentId)) {
      return { deliver: false, rejected: true, reason: `signed, but the body is not a ${PUSH_SCHEMA} event` };
    }
    const headerEventId = inbound.headers["x-raft-event-id"];
    if (!headerEventId || headerEventId !== payload.eventId) {
      return { deliver: false, rejected: true, reason: "the Raft event id header does not match the signed body" };
    }
    if (Object.keys(payload).some((field) => !PUSH_FIELDS.has(field))) {
      return {
        deliver: false,
        rejected: true,
        reason: "signed, but Raft inbox notifications must not carry message content",
      };
    }

    const state = await loadPushState(ctx);
    await savePushState(ctx, {
      ...state,
      lastReached: { eventId: payload.eventId, at: Date.now() },
    });
    if (!state.enabled) return { deliver: false, reason: "push is disabled for this mount" };
    if (!state.agentId || payload.recipientAgentId !== state.agentId) {
      return { deliver: false, reason: "the signed event names a different Raft agent" };
    }

    return {
      deliver: true,
      text: `Raft inbox state changed. Call the \`receive_events\` tool from the \`${ctx.alias}\` mount exactly once to retrieve and acknowledge ` +
        "the current canonical inbox batch. Do not retry automatically if that call reports uncertain delivery.",
      dedupeKey: payload.eventId,
    };
  },
};
