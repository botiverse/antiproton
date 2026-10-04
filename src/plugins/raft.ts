/**
 * Raft messaging for an agent running inside Antiproton.
 *
 * The tools are generated from the SDK's operation manifest (`RAFT_OPERATIONS`): one tool per operation,
 * named by its `toolName`, described and typed by the manifest, and run through `raft.invoke`. What is
 * written by hand here is what the manifest cannot say: which operations a hosted agent is not offered
 * (`EXCLUDED`), how a paged result is kept under the parking line (`pagingCap`), which caller counts as
 * the model (`originOf`), the question a held call asks, and the inbox pull and push tools, which are this
 * runtime's plumbing rather than Raft operations. The Raft credential stays in the host plugin and is
 * attached only to the operator-configured Raft origin.
 */
import { clip, logEvent, routeOf } from "../core/log.ts";
import type { Json, MountRecord } from "../core/types.ts";
import {
  createRaft, isInterrupted, RAFT_OPERATIONS, RAFT_STATE_SCHEMA,
  type Raft, type RaftInboxBatch, type RaftInterrupt, type RaftMessage, type RaftOperationSpec, type RaftState, type RaftStateStore, type RaftFailure,
} from "@botiverse/raft-sdk";
import { PARK_BYTES } from "./artifacts.ts";
import {
  interrupt, originProblem,
  type ActivityEvent, type InboundEvent, type InboundResult, type Interrupt, type ListedTools, type Plugin, type PluginContext,
  type PluginErrorFields, type ToolSchema,
} from "./types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;
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

/**
 * A Raft SDK client for this mount: its origin, its credential, its timeout, and its saved state.
 *
 * `{ state: false }` gives a client whose state lives only for the call and is never saved: the snapshot's
 * `identity.whoami` uses it, having nothing to record, and so does a history read, which must not count as seen
 * (`runOperation` says why). Every other operation runs on the saved state, because what the model has seen is
 * booked there per context (`originOf`) — by receive_events and by a held call's question — and a send attests it.
 */
function raftFor(ctx: PluginContext, options: { state?: false } = {}): Raft {
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
    ...(options.state === false ? {} : { state: stateStore(ctx) }),
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
  // The next action is the SDK's own sentence, so its command is rewritten wherever it stands; the message is left
  // as it came (it may repeat what the caller asked for).
  const e = new Error(`${out.error.message}${out.error.nextAction ? ` — ${commandsAsTools(out.error.nextAction)}` : ""}`);
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
 * The manifest's operations a hosted agent is not offered, each with its reason. One table, so a reviewer
 * reads every exclusion and its reason in one place; every other operation becomes a tool. `test/raft-plugin.ts`
 * holds both directions — every manifest operation is generated or listed here, and every entry here names a
 * real operation — so an operation a new SDK adds turns that test red until someone decides which side it
 * belongs on.
 *
 * The manifest carries no channel or server administration (creating, updating or archiving a channel, adding
 * or removing its members, updating the server): those are Agent API routes reachable only through the SDK's
 * raw `routes`, which nothing here calls. A hosted agent proposes them with `actions_prepare`, for a person to
 * confirm.
 */
export const EXCLUDED: Readonly<Record<string, string>> = {
  "inbox.check": "the inbox is read with receive_events, which commits what it showed and pulls the next in one call; a second reader would move the same cursor",
  "inbox.drain": "pulls until the inbox is empty and hands it all over in one result, with no bound; receive_events pages the same inbox",
  "inbox.commit": "receive_events commits only the messages it showed, which its next pull acknowledges; a separate commit could acknowledge a batch before the model has read it",
  "mentions.execute": "its add action changes a conversation's membership; membership changes go through an action card a person confirms (actions_prepare)",
  "profile.update": "changes the account's public identity (display name, description, avatar); identity changes go through an action card a person confirms",
  "tasks.delete": "destructive, and new: agents could not delete tasks before; offered when someone asks for it",
};

/** The operations this plugin offers as tools: the manifest, less `EXCLUDED`, in the manifest's order. */
export const GENERATED: readonly RaftOperationSpec[] = RAFT_OPERATIONS.filter((op) => !Object.hasOwn(EXCLUDED, op.name));

/**
 * The parking line, in rows. A result longer than `PARK_BYTES` (src/plugins/artifacts.ts, which the runtime's
 * `offloadLimit` reads) is parked and the model is handed a preview. A page of `PAGE_ROWS` rows stays under it
 * when a row takes `ROW_CHARS` characters of the result — one message line with its header and a few
 * sentences. A bound on rows, not characters: one long message still parks, and nothing here can prevent that
 * short of cutting the message.
 */
const ROW_CHARS = 400;
export const PAGE_ROWS = Math.floor(PARK_BYTES / ROW_CHARS);

/**
 * The most messages one `receive_events` asks Raft for (the `/events` `limit`), and its default: as many rows
 * of `ROW_CHARS` as fit under `PARK_BYTES` once `EVENTS_FRAME_CHARS` is set aside for the rest of the result
 * (its keys, `hasMore`, a note, a reply target). A count, so it only makes the usual batch fit; long messages
 * can still overflow it, and `handOver` then shows fewer.
 */
const EVENTS_FRAME_CHARS = 400;
export const EVENTS_LIMIT = Math.floor((PARK_BYTES - EVENTS_FRAME_CHARS) / ROW_CHARS);

/**
 * The argument that sets how much an operation returns, when the manifest says its result may be large: only
 * `limit`. The other arguments in `output.boundBy` (a cursor, an offset, a view, a status filter) say where a
 * page starts or what it shows, not how long it is, so an operation bounded only by those is not capped here.
 */
export function pagingArg(op: RaftOperationSpec): "limit" | null {
  return op.output.mayBeLarge && op.output.boundBy.includes("limit") && op.inputSchema.properties?.limit ? "limit" : null;
}

const TOOL_NAME = new Map(RAFT_OPERATIONS.map((op) => [op.name, op.toolName]));
const IDEMPOTENCY = { natural: "native", key: "key", none: "none" } as const;

/** The answer that goes ahead with a held call: a message is sent; a task write proceeds. */
function goAhead(op: RaftOperationSpec): "send" | "proceed" {
  return op.name.startsWith("messages.") ? "send" : "proceed";
}

/**
 * What this plugin refuses of an operation's arguments before any request, and the sentence its tool's
 * description gains so the model knows before calling. The manifest's schema stays as it is; this narrows it.
 */
const ARGUMENT_CHECKS: Readonly<Record<string, { check(input: Record<string, unknown>): string | null; described: string }>> = {
  // The three cards a model may prepare. The integration cards take ids a model has no way to know, and are made
  // by Raft's own integration commands.
  "actions.prepare": {
    check: (input) => {
      const type = (input.action as { type?: unknown } | undefined)?.type;
      return type === "channel:create" || type === "channel:add_member" || type === "agent:create" ? null
        : "action.type must be channel:create, channel:add_member or agent:create: the integration cards take ids you have no way to know, and are made by Raft's own integration commands";
    },
    described: " Only channel:create, channel:add_member and agent:create cards can be prepared here: the integration cards take ids you have no way to know, and are made by Raft's own integration commands.",
  },
};

/**
 * One manifest operation as a tool. The description is the manifest's, with an operation named by its dotted
 * name (`tasks.unassign`) written as the tool name the model is offered (`tasks_unassign`), and, for an
 * operation that may be held, the answers the question takes here. The parameters are the manifest's, with the
 * paging argument capped (`pagingArg`). `sideEffect` decides the mount's policy half (an unknown value is a
 * write); `modelOnly` is carried, so the gateway refuses it from a program as a second layer over the SDK's own
 * MODEL_ONLY refusal; idempotency is the manifest's, `natural` being what this runtime calls `native`.
 */
export function toolOf(op: RaftOperationSpec): ToolSchema {
  const parameters = structuredClone(op.inputSchema) as Record<string, any>;
  const paging = pagingArg(op);
  if (paging) {
    const p = parameters.properties[paging];
    p.maximum = Math.min(typeof p.maximum === "number" ? p.maximum : PAGE_ROWS, PAGE_ROWS);
    p.description = `${p.description ? `${p.description} ` : ""}At most ${PAGE_ROWS} on this mount, and ${PAGE_ROWS} when omitted, so a page fits in the conversation.`;
  }
  const described = op.description.replace(/\b[a-z]+\.[a-z][A-Za-z]*\b/g, (name) => TOOL_NAME.get(name) ?? name);
  const held = op.mayInterrupt
    ? ` Held here, the call comes back as a question with those messages: answer "${goAhead(op)}" to go ahead as written, or "drop" to do nothing.`
    : "";
  return {
    name: op.toolName,
    summary: described + (ARGUMENT_CHECKS[op.name]?.described ?? "") + held,
    parameters: parameters as Json,
    sideEffects: op.sideEffect === "read" ? "read" : "write",
    idempotency: IDEMPOTENCY[op.idempotency.kind] ?? "none",
    ...(op.modelOnly ? { modelOnly: true as const } : {}),
  };
}

const GENERATED_TOOLS: readonly ToolSchema[] = GENERATED.map(toolOf);
const OPERATION_OF = new Map(GENERATED.map((op) => [op.toolName, op]));

/**
 * The caller as the SDK's `invoke` takes it. A call is the model's own only when it is made in the model's turn
 * and not by a program: no `caller.fromProgram`, and a `caller.contextId`, which only a call in a session's turn
 * carries. Every other call is "code": a run_js program, an approved call's replay (run with nobody reading the
 * result), provisioning, a bench shell. Under "code" the SDK refuses a model-only operation with MODEL_ONLY
 * before any request, and reads history with `consume: false`, recording nothing as seen. That is all "code"
 * changes in the SDK (0.8.0's `invoke`): a send, a claim or a task write runs the same under either, attesting
 * what was seen in the context it names. The context id goes along whatever the origin, so what a program sends
 * is attested by what its model read in that context.
 */
export function originOf(ctx: PluginContext): { origin: "model" | "code"; contextId?: string } {
  const contextId = ctx.caller.contextId;
  const byModel = ctx.caller.fromProgram !== true && typeof contextId === "string";
  return { origin: byModel ? "model" : "code", ...(typeof contextId === "string" ? { contextId } : {}) };
}

/**
 * The arguments a caller may give an operation: what its manifest schema advertises, and nothing else. The SDK
 * also accepts arguments it does not advertise — a send's `seen` overrides what the send attests, which is the
 * hold's whole question — so one of those from a caller is dropped here, and only a resume this plugin made
 * itself passes `seen`. The paging argument gets its cap and its default (`pagingArg`).
 */
function argumentsFor(op: RaftOperationSpec, args: unknown): Record<string, unknown> {
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
    throw new Error(`${op.toolName} takes an object of arguments`);
  }
  const advertised = op.inputSchema.properties ?? {};
  const input = Object.fromEntries(Object.entries(args ?? {}).filter(([name]) => Object.hasOwn(advertised, name)));
  const refused = ARGUMENT_CHECKS[op.name]?.check(input);
  if (refused) throw new Error(refused);
  const paging = pagingArg(op);
  if (paging) {
    const value = input[paging];
    if (value === undefined) input[paging] = PAGE_ROWS;
    else if (typeof value === "number" && value > PAGE_ROWS) {
      throw new Error(`${paging} is at most ${PAGE_ROWS} on this mount, so a page fits in the conversation; read further with the next page`);
    }
  }
  return input;
}

/**
 * The CLI commands the SDK's text names, in this mount's terms. The SDK's text is the CLI's output, so its hints say
 * `raft message read --target "#ops" --before 41`, a command this mount does not have; a model would go looking for
 * it. Each `raft <noun> <verb> …` is rewritten here, in one place, as the tool call it stands for
 * (`messages_read({ target: "#ops", before: 41 })`), or in neutral words where no tool does it. A stopgap: once the
 * SDK's `invoke` can write its hints as tool calls itself, `toolTerms` and `CLI_COMMANDS` are deleted together.
 *
 * Applied only where the SDK wrote the hint itself: a failure's next action, and the lines of an outcome's text that
 * are hint lines (`SDK_HINT_LINES`). What a person wrote is never rewritten (`toolTerms`).
 */
export const CLI_COMMANDS: Readonly<Record<string, { op?: string; tool?: string; positional?: string; flags?: Record<string, string | [string, Json]>; say?: string }>> = {
  "message read": { op: "messages.read", flags: { target: "target", after: "after", before: "before", around: "around", limit: "limit" } },
  "message send": { op: "messages.send", flags: { target: "target", "attachment-id": "attachmentIds" } },
  "message check": { tool: "receive_events" },
  "inbox check": { op: "inbox.list", flags: { view: "view", before: "before", limit: "limit" } },
  "server info": { op: "server.info", flags: { channels: ["view", "channels"], agents: ["view", "agents"], humans: ["view", "humans"], full: ["view", "full"], offset: "offset", limit: "limit", joined: ["joined", true] } },
  "server update": { say: "a server setting a person with a server role changes" },
  "user info": { op: "users.info", positional: "name", flags: { offset: "offset", limit: "limit" } },
  "channel info": { op: "channels.info", positional: "target" },
  "channel members": { op: "channels.members", positional: "target" },
  "channel join": { op: "channels.join", positional: "target" },
  "channel leave": { op: "channels.leave", positional: "target" },
  "channel mute": { op: "channels.mute", positional: "target" },
  "channel unmute": { op: "channels.unmute", positional: "target" },
  "channel create": { say: "an action card for a person to confirm (actions_prepare)" },
  "thread unfollow": { op: "threads.unfollow", positional: "target" },
  "task claim": { op: "tasks.claim", flags: { target: "target", number: "taskNumbers" } },
  "task show": { op: "tasks.show", flags: { target: "target", number: "taskNumber" } },
  "task list": { op: "tasks.list", flags: { target: "target", status: "status" } },
  "task update": { op: "tasks.updateStatus", flags: { target: "target", number: "taskNumber", status: "status" } },
  "task unassign": { op: "tasks.unassign", flags: { target: "target", number: "taskNumber" } },
  "mention pending": { op: "mentions.pending" },
  "mention notify": { say: "delivering the mention, which this mount does not offer" },
  "mention add": { say: "delivering the mention, which this mount does not offer" },
  "manual get": { op: "manual.get", positional: "topic", flags: { intent: "intent", reason: "reason" } },
  "manual search": { op: "manual.search", positional: "query", flags: { intent: "intent", reason: "reason" } },
  "attachment view": { say: "the attachment viewer, which this mount does not have," },
  "action prepare": { op: "actions.prepare" },
};
/** Arguments that are lists in the operation's schema, though the CLI takes one per flag. */
const LIST_ARGUMENTS = new Set(["attachmentIds", "taskNumbers"]);
const CLI_VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|<[^>\n]*>|…|[^\s\x60'"<>()\[\]-](?:[^\s\x60()\[\]]*[^\s\x60.,;:()\[\]])?)`;
const CLI_COMMAND = new RegExp(String.raw`\braft ([a-z][a-z-]*)(?: ([a-z][a-z-]*))?((?: +(?:--[a-z][a-z-]*(?: ${CLI_VALUE})?|"[^"\n]*"|<[^>\n]*>|@[\w.-]+|#[\w:.~-]+|[A-Za-z0-9_][\w.-]*\d[\w.-]*|[a-z0-9]+(?:-[a-z0-9]+)+|[\w.-]+(?= --)))*)`, "g");
const CLI_TOKEN = new RegExp(String.raw`--([a-z][a-z-]*)|${CLI_VALUE}`, "g");

/** A CLI command as the SDK writes one: `raft` and one of the CLI's nouns. */
export const CLI_HINT = /\braft (?:message|server|inbox|user|task|mention|channel|thread|manual|attachment|action|profile|agent|integration)\b/;

/**
 * The lines in which the SDK's formatters write a command hint, by how each line starts. Only these lines are
 * rewritten: a line that quotes what a person wrote — a message line (`[target=…`) or its continuation (`  │ `), a
 * task's title or description, a channel's or a user's description, a search preview, an attachment comment —
 * starts some other way, and is passed on as written. Each shape is one formatter's (0.8.0's), named beside it.
 */
const SDK_HINT_LINES: readonly RegExp[] = [
  /^(?:Older|Newer) exist: raft message read /, // a history page's next window
  /^More: raft /, // a paged listing's next page (inbox, server sections, channel info, users info)
  /^Next: open the first conversation above: raft message read /, // the inbox listing's next step
  /^ {2}open: raft message read /, // an inbox listing row's command
  /^- raft (?:server|channel|user) info\b/, // the server summary's narrow queries
  /^Full dump: raft server info --full$/, // the server summary
  /^#\d+ → raft message send --target /, // created or claimed tasks' thread
  /^raft message send --target "[^"\n]*"$/, // a converted task's thread
  /^ {2}(?:notify|add|recovery): raft mention (?:notify|add) /, // pending mention actions
  /^ {2}recovery: unavailable because the pending action id is invalid; inspect `raft mention pending`/,
  /^Do not rerun `raft message send`; the message is already queued/,
  /^Still unread: \d+ conversations?\. Run `raft inbox check` to list them\.$/,
  /^More messages are pending\. Run `raft message check` again\.$/,
  /^Visible public channels may appear even when `joined=false`\./, // the server overview's fixed guidance
  /^Server-profile changes still use raft server update /,
  /^To start a new DM: raft message send --target /,
];

/** One CLI command, wherever it stands in `text`, as the tool call it stands for: for text the SDK wrote whole. */
export function commandsAsTools(text: string): string {
  return text.replace(CLI_COMMAND, (whole, noun: string, verb: string | undefined, rest: string) => {
    const entry = CLI_COMMANDS[`${noun} ${verb ?? ""}`.trim()];
    const op = entry?.op && !Object.hasOwn(EXCLUDED, entry.op) ? TOOL_NAME.get(entry.op) : undefined;
    const tool = entry?.tool ?? op;
    // A command this mount has no tool for keeps no CLI word, and the hint loses nothing a tool could act on.
    if (!tool) return entry?.say ?? (noun === "mention" ? CLI_COMMANDS["mention notify"]!.say! : "a Raft command this mount has no tool for");
    const args: Record<string, Json> = {};
    let flag: string | null = null;
    let trailing = "";
    const put = (name: string, raw: string) => {
      const value: Json = /^\d+$/.test(raw) ? Number(raw) : raw.replace(/^["']|["']$/g, "");
      args[name] = LIST_ARGUMENTS.has(name) ? [...((args[name] as Json[] | undefined) ?? []), value] : value;
    };
    for (const m of rest.matchAll(CLI_TOKEN)) {
      if (m[1] !== undefined) {
        const spec = entry?.flags?.[m[1]];
        if (Array.isArray(spec)) { args[spec[0]] = spec[1]; flag = null; } else flag = spec ?? "";
        continue;
      }
      if (flag !== null) { if (flag) put(flag, m[0]); flag = null; continue; }
      if (entry?.positional && !(entry.positional in args)) put(entry.positional, m[0]);
      else trailing += ` ${m[0]}`;
    }
    const shown = Object.entries(args).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
    return `${tool}(${shown ? `{ ${shown} }` : ""})${trailing}`;
  });
}

/**
 * The SDK's text in this mount's terms: its hint lines (`SDK_HINT_LINES`) rewritten, every other line as it came.
 * `quoted` are strings a person wrote that the outcome carries (its data's strings that name a CLI command): they are
 * set aside before the lines are judged, so one that happens to start a line the way a hint does is still not
 * rewritten, and put back after. A search preview, which the SDK reshapes, is skipped by its `<preview>` block.
 */
export function toolTerms(text: string, quoted: readonly string[] = []): string {
  const kept: string[] = [];
  let masked = text;
  for (const q of [...new Set(quoted)].sort((x, y) => y.length - x.length)) {
    if (!q || !masked.includes(q)) continue;
    masked = masked.split(q).join(`\uE000${kept.length}\uE001`);
    kept.push(q);
  }
  // A search result's preview is a person's words reshaped by the SDK (handles and channels neutralised), so it is not
  // found among the data's strings; its lines are skipped by the block the formatter puts them in.
  let preview = false;
  return masked.split("\n").map((line) => {
    if (line === "<preview>" || line === "</preview>") { preview = line === "<preview>"; return line; }
    return !preview && SDK_HINT_LINES.some((shape) => shape.test(line)) ? commandsAsTools(line) : line;
  }).join("\n")
    .replace(/\uE000(\d+)\uE001/g, (_, i: string) => kept[Number(i)]!);
}

/** The strings in an outcome's data that name a CLI command, and each of their lines: what `toolTerms` sets aside. */
function quotedCommands(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 8) return out;
  if (typeof value === "string") {
    if (CLI_HINT.test(value)) out.push(value, ...value.split(/\r\n|[\n\r]/).filter((l) => CLI_HINT.test(l)));
  } else if (Array.isArray(value)) for (const v of value) quotedCommands(v, depth + 1, out);
  else if (value && typeof value === "object") {
    // The SDK's own command fields are hints, not quotes.
    for (const [k, v] of Object.entries(value)) if (!/^(?:command|nextCommand|openCommand|text)$/.test(k)) quotedCommands(v, depth + 1, out);
  }
  return out;
}

/** A message the outcome carries, as `modelLine` reads it. */
function isMessage(value: unknown): value is RaftMessage {
  const m = value as RaftMessage | null;
  return !!m && typeof m === "object" && typeof m.text === "string" && Array.isArray(m.attachments) && !!m.raw;
}

/** One operation, run through the SDK's `invoke` under the caller's origin and context. */
async function runOperation(
  op: RaftOperationSpec, args: unknown, ctx: PluginContext, seen?: { upToSeq: number },
): Promise<Json | Interrupt> {
  const input = argumentsFor(op, args);
  const caller = originOf(ctx);
  // A history read does not count as seen, whoever makes it: only receive_events attests. The SDK records a
  // model-origin `messages.read` page as seen inside `invoke`, before this plugin hands the result on — and a page
  // over PARK_BYTES is then parked, so the model has read a preview, not the page, while the record says it saw
  // all of it. So an operation that books "seen" runs on a client whose state is not saved; what that costs is one
  // extra hold on a send after reading history, which asks the model with the newer messages: the safe side.
  // Only `messages.read` books it among the generated tools (the manifest's `consumes.model`; the inbox pulls,
  // which also do, are excluded and stay with receive_events).
  const raft = raftFor(ctx, op.consumes.model.includes("seen") ? { state: false } : {});
  const out = await raft.invoke(op.name, seen ? { ...input, seen } : input, caller);
  if (!out.ok) throw sdkFailure(out as RaftFailure, op.sideEffect !== "read");
  if (isInterrupted(out)) return heldCall(op, raft, caller, out.interrupt, input);
  // The SDK's text is the outcome as the model reads it (the CLI's output for the same operation, its command hints
  // put in this mount's terms); `data` is the Server's projection and stays out, so a new server field cannot
  // silently enter the model's context.
  // A message's line is rebuilt by `modelLine` from the message itself (its attachment suffix is the SDK's, not the
  // author's); everything else a person wrote is set aside by `toolTerms`.
  const data = (out as { data?: unknown }).data as Record<string, unknown> | undefined;
  const messages = [...(Array.isArray(data?.messages) ? data.messages : []), data?.message].filter(isMessage);
  let text = out.text.trim();
  for (const m of messages) text = text.replace(m.text, modelLine(m));
  return { state: out.state, text: toolTerms(text, quotedCommands(data)) };
}

/**
 * A held call, as a question for the model: the conversation has messages this agent has not seen. The held
 * messages are in the question, so the model sees them now: that is recorded before asking (in the caller's
 * context), so the answer "send"/"proceed" — or the model making the same call again — attests them instead of
 * being held again. The SDK records nothing when the context was withheld, does not account for every new
 * message, or came without a boundary; then nothing is attested and the model reads the conversation first.
 *
 * The state is the call itself: the operation, its arguments with the interrupt's `resume.idempotencyKey` under
 * the operation's key argument when it has one, and for a message the `seen` boundary when the question showed
 * every new message. Plain data, no credential, and never shown: the question, its context and its answers carry
 * none of it, and the interrupt's `resume.argv`/`cancel`, which belong to the CLI, are not used at all.
 */
async function heldCall(
  op: RaftOperationSpec, raft: Raft, caller: { contextId?: string }, held: RaftInterrupt, input: Record<string, unknown>,
): Promise<Interrupt> {
  const n = held.newMessageCount;
  const attested = raft.frontier.inContext(caller.contextId).recordHeld(held);
  if (attested) await raft.state.save();
  const unshown = held.withheld ? n : Math.max(0, n - held.heldMessages.length - held.omittedMessageCount);
  const go = goAhead(op);
  const key = op.idempotency.kind === "key" && held.resume.idempotencyKey ? { [op.idempotency.arg]: held.resume.idempotencyKey } : {};
  return interrupt({
    question: `${n === 1 ? "A newer message" : `${n} newer messages`} arrived in ${held.target} since you last read it; ` +
      (attested
        ? (go === "send" ? "send your message anyway?" : `go ahead with ${op.toolName} anyway?`)
        : `${unshown && unshown < n ? `${unshown} of them are not shown here, so ` : unshown ? "they are not shown here, so " : ""}` +
          `read ${held.target} with messages_read first, then answer "${go}" to go ahead or "drop".`),
    context: {
      target: held.target, newMessages: n,
      messages: held.heldMessages.map(modelLine),
      ...(held.omittedMessageCount ? { omitted: held.omittedMessageCount } : {}),
      ...(held.withheld ? { withheld: true } : {}),
      ...(unshown ? { unshown } : {}),
    },
    answer: { choices: [go, "drop"] },
    state: {
      op: op.name, args: { ...input, ...key } as Json,
      ...(go === "send" && attested && held.seenUpToSeq !== null ? { seen: { upToSeq: held.seenUpToSeq } } : {}),
    },
  });
}

/**
 * The resume path of `send_message`, the hand-written tool `messages_send` replaced, for a send held before that
 * change and still waiting for its answer. Its state is `{ target, content, idempotencyKey, seen? }`, and going
 * ahead is `messages.send` again with it, under the same key, exactly as the old tool did. To be removed in the
 * next release, when no send held under the old tool can still be waiting.
 */
const LEGACY_SEND = "send_message";

async function legacyResume(state: Json, answer: Json, ctx: PluginContext): Promise<Json | Interrupt> {
  const s = object(state);
  if (typeof s.target !== "string" || typeof s.content !== "string" || typeof s.idempotencyKey !== "string") {
    throw new Error("raft: the held send's state is incomplete; call messages_send again");
  }
  if (answer === "drop") {
    return { state: "dropped", target: s.target, note: "Not sent. To send something else, call messages_send with the new content and a new idempotencyKey." };
  }
  if (answer !== "send") throw new Error(`raft: the answer must be "send" or "drop", not ${JSON.stringify(answer)}`);
  const seen = object(s.seen);
  return legacySend(ctx, {
    target: s.target, content: s.content, idempotencyKey: s.idempotencyKey,
    ...(typeof seen.upToSeq === "number" ? { seen: { upToSeq: seen.upToSeq } } : {}),
  });
}

/** The old tool's send, unchanged, so a held send resumes as it would have; removed with `legacyResume`. */
async function legacySend(
  ctx: PluginContext,
  send: { target: string; content: string; idempotencyKey: string; seen?: { upToSeq: number } },
): Promise<Json | Interrupt> {
  const raft = raftFor(ctx);
  const out = await raft.messages.send(send);
  if (!out.ok) throw sdkFailure(out, true);
  if (isInterrupted(out)) {
    const held = out.interrupt;
    const n = held.newMessageCount;
    const attested = raft.frontier.recordHeld(held);
    if (attested) await raft.state.save();
    const unshown = held.withheld ? n : Math.max(0, n - held.heldMessages.length - held.omittedMessageCount);
    return interrupt({
      question: `${n === 1 ? "A newer message" : `${n} newer messages`} arrived in ${held.target} since you last read it; ` +
        (attested
          ? "send your message anyway?"
          : `${unshown && unshown < n ? `${unshown} of them are not shown here, so ` : unshown ? "they are not shown here, so " : ""}` +
            `read ${held.target} with messages_read first, then answer "send" to send your message or "drop".`),
      context: {
        target: held.target, newMessages: n,
        messages: held.heldMessages.map(modelLine),
        ...(held.omittedMessageCount ? { omitted: held.omittedMessageCount } : {}),
        ...(held.withheld ? { withheld: true } : {}),
        ...(unshown ? { unshown } : {}),
      },
      answer: { choices: ["send", "drop"] },
      state: {
        target: send.target, content: send.content, idempotencyKey: held.resume.idempotencyKey ?? send.idempotencyKey,
        ...(held.contextComplete && held.seenUpToSeq !== null ? { seen: { upToSeq: held.seenUpToSeq } } : {}),
      },
    });
  }
  return {
    state: "sent", messageId: out.data.messageId,
    ...(out.data.messageSeq !== null ? { messageSeq: out.data.messageSeq } : {}),
    ...(out.data.recentUnread.length ? { recentUnread: out.data.recentUnread.map(modelLine) } : {}),
  };
}

/**
 * What one `receive_events` hands the model out of the batch Raft returned, what it acknowledges, and whether it
 * records the shown messages as seen.
 *
 * The runtime parks a result whose `JSON.stringify` is longer than `PARK_BYTES` (cf/src/runtime.ts, where a mounted
 * call's result is measured whole: keys, escaping and all, not just the message text), and the model then reads a
 * preview, not the messages. So the result is measured here the same way, and only the longest run of whole
 * messages, oldest first, that keeps it under the line is shown. Only those are acknowledged: the cursor the next
 * pull sends is the last shown message's seq, and under cursor acks Raft acknowledges the rows of the batch at or
 * below it and hands the rest out again, first. A cut is made only after a message with a seq, since nothing
 * else can be acknowledged on its own (the SDK sorts a batch by seq, with the ones that have none last).
 *
 * A message too long to fit even alone is handed over alone, acknowledged, and NOT recorded as seen: the result is
 * parked, so the model was given a preview and a reference, not the message. Left unacknowledged it would head
 * every later batch and the inbox would never move; acknowledged, nothing is lost, since the parked result holds it
 * whole and the conversation's history still has it, and with no seen record a send into that conversation is held
 * and shows the model what is new there before it goes. The same holds for a Server that acknowledges on read: it
 * has already taken the whole batch, so all of it is handed over, and recorded as seen only when it fits.
 */
function handOver(batch: RaftInboxBatch): { result: Record<string, Json>; shown: RaftMessage[]; cursor: number | null; attested: boolean } {
  const all = batch.messages;
  const lines = all.map(modelLine);
  const onRead = batch.ackMode === "immediate";
  const resultOf = (k: number, attested: boolean): Record<string, Json> => {
    const left = all.length - k;
    const hasMore = batch.hasMore || left > 0;
    const notes = [
      // Kept short: it is read in the runtime's preview of a parked result, which cuts each string field.
      ...(attested ? [] : ["Too long to show whole; read the stored copy as the note beside this preview says. Not counted as seen, so a send there first shows what is new."]),
      ...(attested && left > 0 ? [`${left} more message${left === 1 ? " was" : "s were"} left unacknowledged so this result is not cut; they come first on your next call.`] : []),
      ...(hasMore ? ["More unread messages remain: call receive_events again until hasMore is false."] : []),
    ];
    return {
      messages: lines.slice(0, k),
      hasMore,
      ...(notes.length ? { note: notes.join(" ") } : {}),
      // Raft's reply target names the newest message of the whole batch, which may not be among those shown.
      ...(batch.replyTarget && left === 0 ? { replyTarget: batch.replyTarget } : {}),
      // A Server that predates cursor acks acknowledged this batch already; say so rather than imply safety.
      ...(onRead ? { acknowledged: "on this read" } : {}),
    };
  };
  const fits = (r: Record<string, Json>) => JSON.stringify(r).length <= PARK_BYTES;
  const cursorAt = (k: number) => (k === all.length ? batch.cursor : all[k - 1]!.seq);
  const pick = (k: number, attested: boolean) => ({ result: resultOf(k, attested), shown: all.slice(0, k), cursor: cursorAt(k), attested });
  if (onRead) return pick(all.length, fits(resultOf(all.length, true)));
  for (let k = all.length; k >= 1; k--) {
    if (cursorAt(k) === null && k < all.length) continue;
    if (fits(resultOf(k, true))) return pick(k, true);
  }
  if (all.length === 0) return pick(0, true);
  return pick(cursorAt(1) === null ? all.length : 1, false);
}

/**
 * The tools every mount has whatever its credential allows: the inbox pull and push, which are this runtime's
 * plumbing rather than Raft operations, and are written here by hand.
 */
const OWN_TOOLS: readonly ToolSchema[] = [
  {
    name: "receive_events",
    summary: "Read your queued Raft messages: the way to read after an inbox notice. Each message is one line, " +
      "`[target=… msg=… time=… type=…] @sender: content`; reply with messages_send to that target. A call hands out at most " +
      `${EVENTS_LIMIT} messages, fewer when they are long, and Raft at most a few per conversation: while hasMore is true, call again. ` +
      "What a call showed you is acknowledged by your next call, so a failed call loses nothing and may simply be repeated.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: EVENTS_LIMIT },
      },
    },
    // It acknowledges the previous batch, so it is a write; repeating it hands back the same batch.
    sideEffects: "write",
    idempotency: "native",
    // It acknowledges and records as seen what it shows, which only counts if the model reads it.
    modelOnly: true,
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
];

/** Every tool a mount can be offered: what a mount with no snapshot is offered, and `raftPlugin.tools`. */
const ALL_TOOLS: ToolSchema[] = [...OWN_TOOLS, ...GENERATED_TOOLS];

/** What a mount whose credential has no capability at all is told, in its snapshot's `skipped`. */
const EVERY_OPERATION = "(every Raft operation)";

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
    grants: "As that Raft agent, and only as far as the credential's capabilities reach: send, read and search messages, receive queued events, " +
      "join, leave and mute channels and see their members, react, work its task boards, read the Raft Manual, and post action cards for a person to confirm.",
    looksLike: [{ kind: "Raft agent credential", pattern: "sk_agent_[A-Za-z0-9_-]{16,}" }],
  },
  /** Every tool any mount can be offered; one mount's own list is `mountTools`. */
  tools: ALL_TOOLS,

  /**
   * The tools this mount offers: its own tools, and the generated ones its snapshot lists — the operations whose
   * every capability the mount's credential held when the snapshot was taken (`snapshotTools`). Only the names
   * are read from the snapshot; each tool's description and schema are this build's, so the stored copy cannot
   * offer a schema this code does not run.
   *
   * A mount with no snapshot is offered every generated tool. That is every mount made before tools were
   * generated, which nothing recomputes, and one whose credential was seeded rather than attached: its model sees
   * all of them, and a call its credential may not make is refused by Raft (CAPABILITY_NOT_AUTHORIZED) as it was
   * before there was a filter. An empty snapshot is not "none taken": it offers only this plugin's own tools.
   */
  mountTools(mount: MountRecord): ToolSchema[] {
    const snapshot = mount.toolSnapshot;
    if (!snapshot) return ALL_TOOLS;
    const allowed = new Set(snapshot.tools.map((t) => t.name));
    return [...OWN_TOOLS, ...GENERATED_TOOLS.filter((t) => allowed.has(t.name))];
  },

  /**
   * Which generated tools this mount's credential may use: an operation is listed only when the credential holds
   * every capability it names (`identity.whoami` → `capabilities`, the credential's scopes). Asked when the mount
   * is added, when an operator refreshes it, and whenever the mount's credential is attached, replaced or removed
   * (`AgentRuntime.attachCredential`/`removeCredential`), so a credential that lost a scope stops offering its
   * tools. No credential, or one Raft refuses, has no capabilities and lists nothing; Raft not answering is a
   * throw, which leaves the stored list as it was (after a credential change too).
   */
  async snapshotTools(ctx: PluginContext): Promise<ListedTools> {
    if (!ctx.credential) {
      return { tools: [], skipped: [{ name: EVERY_OPERATION, reason: "this mount has no Raft credential, so it has no capabilities" }] };
    }
    const me = await raftFor(ctx, { state: false }).identity.whoami();
    if (!me.ok) {
      if (me.status === 401 || me.status === 403) {
        return { tools: [], skipped: [{ name: EVERY_OPERATION, reason: `Raft refused this mount's credential (HTTP ${me.status})` }] };
      }
      throw new Error(`could not ask Raft what this mount's credential may do: ${me.error.message}`);
    }
    const capabilities = new Set(me.data.capabilities);
    const tools: ToolSchema[] = [];
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const op of GENERATED) {
      const missing = op.capability.filter((c) => !capabilities.has(c));
      if (missing.length) skipped.push({ name: op.toolName, reason: `the credential lacks the Raft capability ${missing.join(", ")}` });
      else tools.push(toolOf(op));
    }
    return { tools, skipped };
  },

  /**
   * A held call's question, answered. "send" (a message) or "proceed" (a task write) makes the same call again
   * with the same arguments — under the interrupt's `resume.idempotencyKey` for a send — attesting what the
   * question showed, so it goes through unless the conversation moved again since, which asks again with the
   * newer messages. "drop" does nothing. Expiry and cancel do nothing either, so no `cancel` is declared: an
   * in-process held call leaves nothing on the Server, and cancelling is not making the call.
   */
  interrupts: {
    async resume(tool, state, answer, ctx) {
      if (tool === LEGACY_SEND) return legacyResume(state, answer, ctx);
      const op = OPERATION_OF.get(tool);
      if (!op?.mayInterrupt) throw new Error(`raft: ${tool} does not ask questions`);
      const s = object(state);
      if (s.op !== op.name || !s.args || typeof s.args !== "object" || Array.isArray(s.args)) {
        throw new Error(`raft: the held call's state is incomplete; call ${op.toolName} again`);
      }
      const go = goAhead(op);
      const target = typeof s.args.target === "string" ? { target: s.args.target } : {};
      if (answer === "drop") {
        return {
          state: "dropped", ...target,
          note: go === "send"
            ? "Not sent. To send something else, call messages_send with the new content and a new idempotencyKey."
            : `Nothing was done. Call ${op.toolName} again if it is still wanted.`,
        };
      }
      if (answer !== go) throw new Error(`raft: the answer must be "${go}" or "drop", not ${JSON.stringify(answer)}`);
      const seen = object(s.seen);
      return runOperation(op, s.args, ctx, typeof seen.upToSeq === "number" ? { upToSeq: seen.upToSeq } : undefined);
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
    const op = OPERATION_OF.get(name);
    if (op) return runOperation(op, args, ctx) as Promise<Json>;
    const a = object(args);
    if (name === "receive_events") {
      const limit = integer(a.limit, "limit", 1, EVENTS_LIMIT) ?? EVENTS_LIMIT;
      const raft = raftFor(ctx);
      // Cursor acknowledgement: nothing is acknowledged by being fetched. The cursor the previous call committed
      // (kept in the mount's state, since the object may be a new process by now; `commit()` first promotes a
      // pending cursor an older state left behind) goes as `since`, which is what acknowledges it on the Server.
      // A pull that fails moves nothing, so the next call asks for the same messages again.
      await raft.inbox.commit();
      const since = raft.state.snapshot().cursor;
      // The pull runs on a client whose state is not saved: the SDK books every message a pull returns as seen,
      // and only those `handOver` shows may be. As the model's own: receive_events is model-only, so the gateway
      // has already refused it from a program and from an approved call's replay.
      const out = await raftFor(ctx, { state: false }).invoke("inbox.check",
        { ack: "cursor", limit, ...(since !== null ? { since } : {}) }, { origin: "model" });
      if (!out.ok) throw sdkFailure(out as RaftFailure);
      const batch = (out as { data: RaftInboxBatch }).data;
      const given = handOver(batch);
      // Booked under the caller's context id, the one a later send in that context attests with (`originOf`).
      if (given.attested) {
        const seen = raft.frontier.inContext(typeof ctx.caller.contextId === "string" ? ctx.caller.contextId : undefined);
        const byTarget = new Map<string, number[]>();
        for (const m of given.shown) if (m.seq !== null) byTarget.set(m.target, [...(byTarget.get(m.target) ?? []), m.seq]);
        for (const [target, seqs] of byTarget) seen.recordExact(target, seqs);
      }
      // What was shown is committed now and acknowledged by the next pull; one save carries the cursor and the record.
      if (batch.ackMode === "cursor" && given.cursor !== null) await raft.inbox.commit({ cursor: given.cursor });
      else if (given.attested && given.shown.length) await raft.state.save();
      return given.result;
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

