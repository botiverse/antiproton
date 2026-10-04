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
import { createHash } from "node:crypto";
import { clip, logEvent, routeOf } from "../core/log.ts";
import type { Json, MountRecord } from "../core/types.ts";
import {
  createRaft, hashRaftSendContent, isInterrupted, RAFT_OPERATIONS, RAFT_STATE_SCHEMA, SeenFrontier,
  type Raft, type RaftInboxBatch, type RaftInterrupt, type RaftMessage, type RaftOperationSpec, type RaftState, type RaftStateStore, type RaftFailure,
} from "@botiverse/raft-sdk";
import { PARK_BYTES } from "./artifacts.ts";
import { internalHost } from "./http.ts";
import { toAgentRef } from "../store/refs.ts";
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
 * The SDK's state for this mount — inbox cursors, the seen frontier, held-send keys — kept as one record in
 * the mount's database. Its inbox cursors are read only by a pull on a mount that has no `SINCE_KEY` yet,
 * receive_events' own cursor; the frontier is what this agent was shown per conversation, which a send attests
 * so a reply into a conversation it has read is not held. All of it survives the object being a new process between calls.
 */
export const INBOX_STORE = "inbox";
const STATE_KEY = "state";
/**
 * The `since` the next `receive_events` pull sends, as `{ since: number | null }`, apart from the SDK's state.
 * Raft acknowledges with it every row of its previous response whose seq is at or below it, so it has to be
 * exactly the cursor the last call computed, which a cut that showed only part of a response can put BELOW the
 * one before (a lower seq handed out again, or newly, after an earlier cursor). The SDK's `inbox.commit` never
 * lowers its cursor, so it cannot hold this one: it would keep the higher value and acknowledge rows the model
 * was not shown. `null` sends no cursor, which acknowledges nothing.
 *
 * A cursor is spent once sent: the call that sends it sets `null` before its pull, and the new cursor only once
 * the pull has answered. A request that reached Raft and whose answer was lost made that lost batch Raft's
 * pending one, and an old cursor sent again would acknowledge it unread; so after any failure the next pull
 * acknowledges nothing, and the worst a failure costs is one batch handed out again.
 */
const SINCE_KEY = "since";

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
 * booked there per context (`originOf`) — by receive_events, by a held call's question when it is the model's own
 * call's result, and by the model's answer to one (`heldCall`) — and a send attests it.
 *
 * Every client writes its hints as tool calls (`hints: "tool"`, SDK 0.10.0), never as `raft …` CLI commands;
 * `offeredTerms` puts in words the few that name a tool this mount does not offer. `response` sees each answer
 * before the SDK reads it (the attachment download's size cap).
 */
function raftFor(ctx: PluginContext, options: { state?: false; response?: (res: Response) => Response } = {}): Raft {
  return createRaft({
    serverUrl: baseUrl(ctx).origin, credential: requireCredential(ctx), hints: "tool",
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
      return options.response ? options.response(res) : res;
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
 * to lose: what its cursor may have acknowledged the previous call showed, and a cursor is spent once sent
 * (`SINCE_KEY`), so the next pull acknowledges nothing of the batch this one asked for.
 */
function sdkFailure(
  out: RaftFailure, unoffered: ReadonlySet<string>, write = false, retry?: { tool: string; key?: string },
): Error {
  const unanswered = out.error.code === "TRANSPORT_ERROR" || out.error.code === "UNAVAILABLE" ||
    (out.error.status !== undefined && out.error.status >= 500);
  // The next action is the SDK's own sentence, so a hint in it at a tool this mount lacks is rewritten wherever it
  // stands (`offeredTerms`); the message is left as it came (it may repeat what the caller asked for). A keyed write that may have landed says the key it went
  // out under (`retryKey`), so a retry is the same request and Raft answers the first one instead of acting twice.
  const retried = write && unanswered && retry?.key
    ? ` It may still have gone through: to try again without doing it twice, call ${retry.tool} again with the same arguments and idempotencyKey ${JSON.stringify(retry.key)}.`
    : "";
  // A write whose request got no answer at all. The SDK says "The request did not reach the Raft Server" and "retry if
  // the operation is safe to repeat", but a timeout or a dropped connection cannot tell a request that never arrived
  // from one whose answer was lost — which is why it is marked as one that may have landed — so both sentences are
  // replaced here with what is known: no answer came, and how to try again without acting twice.
  const lost = write && out.error.code === "TRANSPORT_ERROR";
  const said = lost
    ? `No answer came back from the Raft Server, so whether this went through is not known.${retried ||
      (retry ? ` Check whether it did before calling ${retry.tool} again, or it may happen twice.` : " Check whether it did before trying again, or it may happen twice.")}`
    : `${out.error.message}${out.error.nextAction ? ` — ${offeredTerms(out.error.nextAction, unoffered)}` : ""}${retried}`;
  const e = new Error(said);
  // `retryable` is still what the gateway reads as "may have landed" (it records such a call as unknown), so it
  // follows `mayHaveLanded`, not the SDK's own retryable; whether the failure may clear is `transient`.
  const landed = write && unanswered;
  return marked(e, { retryable: landed, transient: out.error.retryable, mayHaveLanded: landed });
}

/**
 * One message as the model reads it: the SDK's canonical line, with the two things it says that may not be true on
 * this mount put right. The SDK ends a message that has attachments with "use attachments_download_url(…) to
 * download"; on a mount that is not offered that tool — a plugin built with no object storage or with an exclusion table
 * that leaves it out, a credential without its capability, a snapshot older than the build that added it
 * (`unofferedFor` in `createRaftPlugin`) — a model would go looking for it, so there the attachments are named and the
 * missing tool is said.
 * And a message whose content Raft left out because it was too large renders as a sender and nothing after the
 * colon, which reads as an empty message; here it says the content
 * was left out. Both are fixed by rebuilding the suffix from the message's own fields and replaced where the SDK put
 * it; the tests assert whole lines, so a change to the SDK's wording shows as a failing test rather than a doubled
 * suffix. A person's words in the line are never touched: only the SDK's suffix is replaced.
 */
function modelLine(m: RaftMessage, unoffered: ReadonlySet<string>): string {
  let line = m.text;
  if (m.attachments.length && unoffered.has(DOWNLOAD_TOOL)) {
    const n = m.attachments.length;
    // The SDK's suffix (0.10.0 `hints: "tool"`): one attachment names its id, several leave it to fill.
    const call = `${DOWNLOAD_TOOL}({ attachmentId: ${n === 1 ? JSON.stringify(m.attachments[0]!.id) : "…"} })`;
    const cli = ` [${n} attachment${n > 1 ? "s" : ""}: ${m.attachments.map((a) => `${a.filename} (id:${a.id})`).join(", ")} — use ${call} to download]`;
    const ours = ` [${n} attachment${n > 1 ? "s" : ""}: ${m.attachments.map((a) => a.filename).join(", ")} — this mount has no tool to open attachments]`;
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
  "mentions.add": "it changes a conversation's membership; membership changes go through an action card a person confirms (actions_prepare)",
  "profile.update": "changes the account's public identity (display name, description, avatar); identity changes go through an action card a person confirms",
  "tasks.delete": "destructive, and new: agents could not delete tasks before; offered when someone asks for it",
};

/**
 * The operations a plugin built with `excluded` offers as tools: the manifest, less those, in the manifest's order.
 * An operation the manifest marks `deprecated` is still generated, under the same name, until the SDK removes it or
 * it is excluded here: a tool name an agent has been using does not disappear because a replacement exists.
 */
function generatedFrom(excluded: Readonly<Record<string, string>>): readonly RaftOperationSpec[] {
  return RAFT_OPERATIONS.filter((op) => !Object.hasOwn(excluded, op.name));
}
/** The operations this plugin offers as tools: the manifest, less `EXCLUDED`, in the manifest's order. */
export const GENERATED: readonly RaftOperationSpec[] = generatedFrom(EXCLUDED);
/** The tool names a hint may carry that this plugin does not offer (`offeredTerms`). */
const DEFAULT_UNOFFERED = unofferedNames(EXCLUDED);

/**
 * The hand-written tools the generated ones replaced (#729), old name to new (`Plugin.retired`). Each old tool
 * did what its replacement's operation does: `list_channels` paged `server.info`'s channel view, `join_channel`
 * joined through Raft's routes directly, and the rest called the SDK operation their replacement is generated
 * from. `test/unavailable-tool.ts` holds that every target is a tool this plugin offers and that no old name is
 * offered again. `receive_events` and the push tools stayed hand-written, under
 * their names, so they are not here.
 */
export const RETIRED: Readonly<Record<string, string | null>> = {
  send_message: "messages_send",
  join_channel: "channels_join",
  prepare_action: "actions_prepare",
  list_channels: "server_info",
  channel_members: "channels_members",
  read_messages: "messages_read",
  search_messages: "messages_search",
};

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

/**
 * How long Raft remembers an idempotency key: 24 hours. The SDK's README states it under "Retrying a create or a
 * card" ("valid for **24 hours** … after that the key is forgotten, and the same key is a new request"), and its Agent
 * API body schemas give a task write's and a card's key "the same rules as message send's". A held keyed write is
 * not sent on an answer given this long after it was held (`interrupts.resume`): the same call repeated meanwhile
 * may have landed under the key, and Raft would no longer know it.
 */
export const KEY_LIFETIME_MS = 24 * 60 * 60 * 1000;
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
 * The manifest's text in this mount's terms, for a tool's description and every parameter description in its schema:
 * an operation named by its dotted name (`tasks.unassign`) is written as the tool name the model is offered
 * (`tasks_unassign`); a parenthesised SDK field path (`(interrupt.resume.idempotencyKey)`), which names an object this
 * mount never shows, is dropped; a CLI flag (`--after`) is written as the argument it stands for (`after`).
 * `test/raft-plugin.ts` walks every description and fails on anything of these kinds left over, so a new phrasing in
 * the manifest is caught there rather than read by a model.
 */
function inMountTerms(text: string): string {
  return text
    .replace(/\s*\((?:interrupt|resume|next|data)\.[A-Za-z.]+\)/g, "")
    .replace(/`--([a-z]+)`/g, "`$1`")
    .replace(/\b[a-z]+\.[a-z][A-Za-z]*\b/g, (name) => TOOL_NAME.get(name) ?? name);
}

/** Every `description` in a JSON schema, at any depth, put in this mount's terms (`inMountTerms`), in place. */
function describeInMountTerms(schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) { for (const s of schema) describeInMountTerms(s); return; }
  const node = schema as Record<string, unknown>;
  if (typeof node.description === "string") node.description = inMountTerms(node.description);
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value && typeof value === "object") for (const p of Object.values(value)) describeInMountTerms(p);
    else if (key === "items" || key === "anyOf" || key === "oneOf" || key === "allOf" || key === "additionalProperties") describeInMountTerms(value);
  }
}

/**
 * One manifest operation as a tool. The description and every parameter description are the manifest's, in this
 * mount's terms (`inMountTerms`), and, for an operation that may be held, the description says the answers the
 * question takes here. The parameters are the manifest's, with the
 * paging argument capped (`pagingArg`). `sideEffect` decides the mount's policy half (an unknown value is a
 * write); `modelOnly` is carried, so the gateway refuses it from a program as a second layer over the SDK's own
 * MODEL_ONLY refusal; idempotency is the manifest's, `natural` being what this runtime calls `native`.
 *
 * A keyed operation (`{ kind: "key" }`) stays `"key"`, never `"native"`: when the model gives no key, its key is the
 * gateway's operation id (`keyedInput`), and a re-run after a crash is a new operation with a new id, so it would
 * land twice. `"key"` is not replayed on its own (`replayPolicy`, src/runtime/pi-tools.ts). Its key argument stays
 * optional and is described for the model in plain words (`keyDescription`), since the manifest's text names the
 * SDK's interrupt and a key handed back that this mount never shows.
 */
export function toolOf(op: RaftOperationSpec): ToolSchema {
  const parameters = structuredClone(op.inputSchema) as Record<string, any>;
  const paging = pagingArg(op);
  if (paging) {
    const p = parameters.properties[paging];
    p.maximum = Math.min(typeof p.maximum === "number" ? p.maximum : PAGE_ROWS, PAGE_ROWS);
    p.description = `${p.description ? `${p.description} ` : ""}At most ${PAGE_ROWS} on this mount, and ${PAGE_ROWS} when omitted, so a page fits in the conversation.`;
  }
  if (op.idempotency.kind === "key" && parameters.properties?.[op.idempotency.arg]) {
    parameters.properties[op.idempotency.arg].description = keyDescription(op);
  }
  describeInMountTerms(parameters);
  // The download's manifest text is about the URL Raft mints; this mount keeps the file and never shows the URL.
  const described = op.name === DOWNLOAD_OP
    ? `Download an attachment (by the id a message line shows) into this agent's storage, up to ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MiB: ` +
      "returns an artifact reference to the file with its name, type and size."
    : inMountTerms(op.description);
  const held = op.mayInterrupt
    ? ` Held here, the call comes back as a question with those messages: answer "${goAhead(op)}" to go ahead as written, or "drop" to do nothing.` +
      (op.idempotency.kind === "key"
        ? ` An answer given ${KEY_LIFETIME_MS / 3_600_000} hours or more after the question does nothing: read the conversation, then call again if it is still wanted.`
        : "")
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

/** What a keyed operation's key argument is for, as the model reads it. */
function keyDescription(op: RaftOperationSpec): string {
  const one = op.name.startsWith("messages.") ? "message" : op.name === "tasks.create" ? "set of tasks" : op.name === "actions.prepare" ? "card" : "call";
  return `Optional: a name you choose for this one ${one}, such as a short random string. Raft acts at most once per name: ` +
    `if a call failed in a way that may still have gone through, call again with the same arguments and the same ` +
    `idempotencyKey, and you get the first call's answer instead of a second ${one}. Use a new name for anything ` +
    `different; the same name with different arguments is refused. Without one, calling again is a new request.`;
}


/**
 * The caller as the SDK's `invoke` takes it. A call is the model's own only when it is made in the model's turn
 * and not by a program: no `caller.fromProgram`, and a `caller.contextId`, which only a call in a session's turn
 * carries. Every other call is "code": a run_js program, an approved call's replay (run with nobody reading the
 * result), provisioning, a bench shell. Under "code" the SDK refuses a model-only operation with MODEL_ONLY
 * before any request, and reads history with `consume: false`, recording nothing as seen. That is all "code"
 * changes in the SDK (`invoke`, 0.9.0 and 0.10.0): a send, a claim or a task write runs the same under either, attesting
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
 * Every client here is made with `hints: "tool"` (`raftFor`), so the SDK writes each "do this next" hint as the tool
 * call it stands for — `messages_read({ target: "#ops", before: 41 })` — in its text, its failures' next actions and
 * its message lines, using the manifest's `toolName`, which is the name this plugin gives each tool. What the SDK
 * cannot know is which of those tools this mount offers. A hint naming one it does not — an operation in `EXCLUDED`,
 * a generated tool missing from the mount's own list (`PluginContext.offered`: its credential lacks the capability,
 * or its stored snapshot predates the build that added the tool), the download on a plugin with no object storage,
 * or the SDK's code-only `raft.<operation>(…)` form — would send the model after a tool it does not have, so such a
 * call is written here as what it stands for instead (`UNOFFERED_SAY`), or as the tool this mount has for it.
 *
 * Only that, and only in text the SDK wrote: a string a person wrote that happens to contain such a call (a message,
 * a description, a title) is set aside first (`quotedCalls`) and comes back as written.
 *
 * Which generated tools the mount offers is the kernel's answer, not this file's: `ctx.offered` is the mount's list
 * as the model was given it (`toolsOf`), so a tool the credential does not reach (`snapshotTools` leaves it out) is
 * said in words like an excluded one. A context without `offered` is read as offering every generated tool. A name
 * missing from `UNOFFERED_SAY` is said with `UNOFFERED_DEFAULT`, so a tool left out only by a credential needs no
 * entry here.
 */
const UNOFFERED_SAY: Readonly<Record<string, string>> = {
  // The SDK names `inbox.check` for "check for new messages"; on this mount that is receive_events.
  inbox_check: "receive_events()",
  // Since 0.11.0 the SDK's notify hint names mentions_notify, which is offered; its add hint names mentions_add.
  mentions_add: "adding them to the conversation, which this mount does not offer",
  // Reached on a plugin built with no object storage, a credential without the capability, or a table that excludes it.
  attachments_download_url: "downloading the attachment, which this mount does not offer",
  "raft.attachments.download": "downloading the attachment, which this mount does not offer",
};
const UNOFFERED_DEFAULT = "a Raft operation this mount does not offer";

/** The names, as the SDK writes them in a hint, of the tools a mount with `excluded` does not offer. */
function unofferedNames(excluded: Readonly<Record<string, string>>): ReadonlySet<string> {
  return new Set(RAFT_OPERATIONS.filter((op) => Object.hasOwn(excluded, op.name)).map((op) => op.toolName));
}

/** The index just past the `)` closing the call whose `(` is at `open`, reading its JSON arguments; -1 if unclosed. */
function callEnd(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") { if (--depth === 0) return i + 1; }
  }
  return -1;
}

/** A hint's call, or a tool's bare name, that this mount does not offer, wherever it stands: for text the SDK wrote. */
function unofferedPattern(unoffered: ReadonlySet<string>): RegExp {
  const names = [...unoffered].sort((a, b) => b.length - a.length).join("|");
  return new RegExp(`(?<![\\w.])(raft\\.[a-z]+\\.[A-Za-z]+${names ? `|${names}` : ""})(?![\\w])`, "g");
}

/**
 * `@handle`, `#channel`, `dm:@peer` and `task #N` as the SDK neutralises them in what it quotes (a search preview), so
 * a call a person wrote can be recognised after that: the same four replacements as the SDK's
 * `neutralizeAgentRaftRefLiterals` (0.10.0), which it does not export. If the SDK changes them, a person's call with a
 * reference in its arguments is rewritten in a preview, and the "never rewritten" test's preview case goes red.
 */
function neutralizedRefs(text: string): string {
  return text.replace(/\bdm:@([A-Za-z0-9][A-Za-z0-9_-]*(?:~(?:agent|human))?)/g, "dm:user:$1").replace(/\btask #([0-9]+)\b/g, "task:$1")
    .replace(/(^|[\n\s([{"'`;])@([A-Za-z0-9][A-Za-z0-9_-]*)/g, "$1user:$2").replace(/(^|[\n\s([{"'`;])#([A-Za-z][A-Za-z0-9_-]*)/g, "$1channel:$2");
}

/**
 * The SDK's text with every hint at a tool this mount does not offer written as what it stands for. `quoted` are the
 * strings a person wrote that the outcome carries, in the forms the SDK may print them (`quotedCalls`).
 *
 * Two guards keep a person's words as written. Each quoted form found whole in the text is set aside first. And
 * because the SDK also prints a person's words cut or changed — a search preview windowed and its references
 * neutralised, an anchor quote cut at 60 characters — where no whole form is found, a call is left alone when its
 * exact text (its name and the arguments `callEnd` finds) appears in any quoted form, or in its neutralised form
 * (`neutralizedRefs`); and a call whose arguments do not close (cut off by a window) is never an SDK hint, which
 * always closes, so it is left alone too. The trade-off: an SDK hint whose call text happens to be exactly what a
 * person wrote stays as the SDK wrote it, and if the model calls it the gateway refuses it as a tool this mount does
 * not have. That costs one refused call; rewriting would change someone's words.
 */
export function offeredTerms(text: string, unoffered: ReadonlySet<string>, quoted: readonly string[] = []): string {
  // What is set aside is put back through a placeholder, `\uE000<index>\uE001`. A person can write those characters
  // too, and one of theirs would be "put back" as something else (or as `undefined`), so the text and every quoted
  // form are escaped first (`escapeMarks`): after that no `\uE000` is left but the ones placed here.
  text = escapeMarks(text);
  quoted = quoted.map(escapeMarks);
  const kept: string[] = [];
  // A search result's preview is a person's words and nothing else: the SDK (0.10.0 `formatAgentSearchResults`) puts
  // `renderSearchPreview` alone between a `<preview>` line and a `</preview>` line, and that renders only the content,
  // windowed, with its references neutralised and `<match>`/`<omit />` marks added, never a hint. A person cannot end
  // the block early: the SDK escapes `<preview>`, `</preview>`, `<match>` and `<result>` tags in what it quotes there
  // (`escapeSearchComponentLiterals`), so no line of theirs is exactly `</preview>`. The marks it adds are why the
  // verbatim check below cannot see a call inside a preview (a hit wrapped in `<match>` splits it), so the whole block
  // is set aside, first, before anything a person wrote could be mistaken for the tags.
  let masked = text.replace(/^<preview>\n[\s\S]*?\n<\/preview>$/gm, (block) => { kept.push(block); return `\uE000${kept.length - 1}\uE001`; });
  for (const q of [...new Set(quoted)].sort((x, y) => y.length - x.length)) {
    if (!q || !masked.includes(q)) continue;
    masked = masked.split(q).join(`\uE000${kept.length}\uE001`);
    kept.push(q);
  }
  const forms = [...new Set([...quoted, ...quoted.map(neutralizedRefs)])];
  const pattern = unofferedPattern(unoffered);
  let out = "";
  let at = 0;
  for (const m of masked.matchAll(pattern)) {
    if (m.index! < at) continue;
    const name = m[1]!;
    const after = m.index! + m[0].length;
    const end = masked[after] === "(" ? callEnd(masked, after) : after;
    if (end === -1) continue;
    const call = masked.slice(m.index, end);
    if (forms.some((f) => f.includes(call))) continue;
    out += masked.slice(at, m.index) + (UNOFFERED_SAY[name] ?? UNOFFERED_DEFAULT);
    at = end;
  }
  return unescapeMarks((out + masked.slice(at)).replace(/\uE000(\d+)\uE001/g, (_, i: string) => kept[Number(i)]!));
}

/**
 * `offeredTerms`'s placeholder opener, and the escape character itself, written so neither appears in the result. Every
 * character written is a private-use one, never a word character: a tool name is matched only where no word character
 * stands before it (`unofferedPattern`), so an escape that wrote a letter could complete one — a person's
 * `\uE000ttachments_download_url(…)` read as `attachments_download_url(…)` and rewritten (on a mount not offering it).
 */
export function escapeMarks(text: string): string {
  return text.replace(/[\uE000\uE002]/g, (c) => (c === "\uE000" ? "\uE002\uE003" : "\uE002\uE004"));
}
export function unescapeMarks(text: string): string {
  return text.replace(/\uE002([\uE003\uE004])/g, (_, c: string) => (c === "\uE003" ? "\uE000" : "\uE002"));
}

/**
 * The strings in an outcome's data that contain a call `offeredTerms` would rewrite: each as written, each of its
 * lines, and each of those with its whitespace collapsed, since the SDK prints some of what a person wrote that way
 * (a task title on a board is one line with single spaces), and the collapsed form is then the only one in the text;
 * and each of those JSON-escaped, as a formatter that prints a value through JSON.stringify shows it.
 */
function quotedCalls(value: unknown, pattern: RegExp, depth = 0, out: string[] = []): string[] {
  if (depth > 8) return out;
  const names = (v: string) => { pattern.lastIndex = 0; return pattern.test(v); };
  const collapsed = (v: string) => v.replace(/\s+/g, " ").trim();
  if (typeof value === "string") {
    if (names(value)) {
      const lines = value.split(/\r\n|[\n\r]/);
      // And as JSON writes it, for a formatter that prints a value through JSON.stringify (a task event's payload).
      const forms = [value, collapsed(value), ...lines, ...lines.map(collapsed)];
      out.push(...[...forms, ...forms.map((f) => JSON.stringify(f).slice(1, -1))].filter(names));
    }
  } else if (Array.isArray(value)) for (const v of value) quotedCalls(v, pattern, depth + 1, out);
  else if (value && typeof value === "object") {
    // The SDK's own command fields are hints, not quotes.
    for (const [k, v] of Object.entries(value)) if (!/^(?:command|nextCommand|openCommand|text)$/.test(k)) quotedCalls(v, pattern, depth + 1, out);
  }
  return out;
}

/** A message the outcome carries, as `modelLine` reads it. */
function isMessage(value: unknown): value is RaftMessage {
  const m = value as RaftMessage | null;
  return !!m && typeof m === "object" && typeof m.text === "string" && Array.isArray(m.attachments) && !!m.raw;
}

/**
 * The arguments of a keyed operation (the manifest's `idempotency.kind === "key"`: a send, a reply, a task create,
 * an action card) with the key Raft dedupes on (for `KEY_LIFETIME_MS`):
 * - the model's own `idempotencyKey` when it gave one. A model calling again after an outcome it could not know
 *   (a timeout, a 5xx) reuses its own key, so Raft answers the first call instead of acting twice; and a held
 *   message re-sent with the same key is that message going ahead, attesting what the question showed (`heldCall`).
 *   A resume passes the interrupt's key here too, which is the key the held call was sent with;
 * - else the gateway's operation id (`PluginContext.operationId`). An approved call's replay and a resume carry no
 *   key of the model's but run under the id of the call they continue, so they dedupe on it; two model calls are
 *   two operations, two ids, and never dedupe by accident;
 * - else, with no operation (no id), nothing: the SDK makes a key of its own, as it always has.
 *
 * One exception to the operation id: a send or reply the model repeats, without a key, after it was held. The
 * SDK reuses the held send's key for the same target and content (its saved continuation), so the repeat and a
 * later "send" answer to the question land once; a fresh operation id would make them two messages.
 */
async function keyedInput(op: RaftOperationSpec, input: Record<string, unknown>, ctx: PluginContext, raft: Raft): Promise<Record<string, unknown>> {
  if (op.idempotency.kind !== "key") return input;
  const arg = op.idempotency.arg;
  const given = input[arg];
  if (typeof given === "string" && given.trim()) return input;
  if (!ctx.operationId) return input;
  if (await continuesHeldSend(op, input, raft)) return input;
  return { ...input, [arg]: ctx.operationId };
}

/** Whether the SDK will send this as the continuation of a held send (`sendWithState` in the SDK, 0.10.0). */
async function continuesHeldSend(op: RaftOperationSpec, input: Record<string, unknown>, raft: Raft): Promise<boolean> {
  const target = op.name === "messages.send" ? input.target : op.name === "messages.reply" ? object(input.message).target : undefined;
  if (typeof target !== "string" || typeof input.content !== "string") return false;
  const ids = Array.isArray(input.attachmentIds) ? input.attachmentIds.filter((id): id is string => typeof id === "string") : [];
  await raft.state.load();
  const held = raft.state.snapshot().continuations ?? [];
  if (!held.some((c) => c.target === target)) return false;
  const hash = await hashRaftSendContent(target, input.content, ids);
  return held.some((c) => c.target === target && c.contentHash === hash);
}

/**
 * The key a keyed write's failure tells the model to retry with: the key the request actually went out under. The
 * SDK names it on a create's or a card's failure it says to retry (`next.kind: "retry_same_key"`). A send's or a
 * reply's failure names no next step (0.10.0), so for those it is the key passed here, on a failure the SDK marks
 * `retryable` — the same condition the SDK uses for the other two. A dedupe token, not a secret, whether the model's
 * or the operation id. A held call's key is never shown: its question is answered, not retried. Unknown, and so not
 * shown, when the SDK made the key for a send with no operation behind it.
 */
function retryKey(op: RaftOperationSpec, out: RaftFailure, sent: Record<string, unknown>): string | undefined {
  if (op.idempotency.kind !== "key") return undefined;
  const named = out.next?.kind === "retry_same_key" ? out.next.args?.idempotencyKey : undefined;
  if (typeof named === "string" && named) return named;
  const passed = sent[op.idempotency.arg];
  // Trimmed, as the SDK trims it before sending.
  return out.error.retryable && typeof passed === "string" && passed.trim() ? passed.trim() : undefined;
}

/** One operation, run through the SDK's `invoke` under the caller's origin and context. */
async function runOperation(
  op: RaftOperationSpec, args: unknown, ctx: PluginContext, unoffered: ReadonlySet<string>,
  resumed: { seen?: { upToSeq: number }; heldAt?: number } = {},
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
  const keyed = await keyedInput(op, input, ctx, raft);
  // Taken before the request, so it is never later than when Raft first saw the key.
  const started = Date.now();
  const { seen } = resumed;
  const out = await raft.invoke(op.name, seen ? { ...keyed, seen } : keyed, caller);
  if (!out.ok) {
    const key = retryKey(op, out as RaftFailure, keyed);
    throw sdkFailure(out as RaftFailure, unoffered, op.sideEffect !== "read", { tool: op.toolName, ...(key ? { key } : {}) });
  }
  // A call held again on resume keeps when it was first held: its key is the same one, as old as that.
  if (isInterrupted(out)) return heldCall(op, raft, caller, out.interrupt, input, resumed.heldAt ?? started, unoffered);
  // The SDK's text is the outcome as the model reads it (the CLI's output for the same operation, its hints written as
  // tool calls, and a call at a tool this mount lacks put in words by `offeredTerms`); `data` is the Server's
  // projection and stays out, so a new server field cannot silently enter the model's context.
  // A message's line is rebuilt by `modelLine` from the message itself (its attachment suffix is the SDK's, not the
  // author's); everything else a person wrote is set aside by `quotedCalls`.
  const data = (out as { data?: unknown }).data as Record<string, unknown> | undefined;
  const messages = [...(Array.isArray(data?.messages) ? data.messages : []), data?.message].filter(isMessage);
  let text = out.text.trim();
  for (const m of messages) text = text.replace(m.text, modelLine(m, unoffered));
  return { state: out.state, text: offeredTerms(text, unoffered, quotedCalls(data, unofferedPattern(unoffered))) };
}

/**
 * A held call, as a question for the model: the conversation has messages this agent has not seen, and they are in
 * the question. They count as seen only once the model has been shown them, and when that is depends on who called:
 * - the model's own call (`originOf` → "model"): the question is that call's result, handed straight back and never
 *   parked (only a succeeded result is), so the model sees it now. It is recorded before asking (in the caller's
 *   context), so the answer "send"/"proceed" — or the model making the same call again — attests them instead of
 *   being held again.
 * - any other caller: a run_js program's call ends the program there, and its question reaches the model only if it
 *   is the first one that run asked and the run stopped cleanly (`deliverRun`, src/runtime/pi-tools.ts); otherwise it
 *   is dropped unseen. An approved call's replay has nobody to show it to at all. So nothing is recorded now; the
 *   state carries what the question would attest (`attest`), and the model's answer records it (`interrupts.resume`),
 *   since only the model can answer.
 * The SDK attests nothing when the context was withheld, does not account for every new message, or came without
 * a boundary (`SeenFrontier.recordHeld`); then nothing is attested and the model reads the conversation first.
 *
 * The state is the call itself: the operation, its arguments with the interrupt's `resume.idempotencyKey` under
 * the operation's key argument when it has one, for a message the `seen` boundary when the question showed
 * every new message, `attest` when it showed them all, and `heldAt`, when the call was first held
 * (`KEY_LIFETIME_MS`). Plain data, no credential, and never shown: the question, its context and its answers carry
 * none of it, and the interrupt's `resume.argv`/`cancel`, which belong to the CLI, are not used at all.
 */
async function heldCall(
  op: RaftOperationSpec, raft: Raft, caller: { origin: "model" | "code"; contextId?: string }, held: RaftInterrupt,
  input: Record<string, unknown>, heldAt: number, unoffered: ReadonlySet<string>,
): Promise<Interrupt> {
  const n = held.newMessageCount;
  // Whether the question shows every new message up to a boundary: asked of a frontier nothing reads, so asking
  // records nothing.
  const attested = new SeenFrontier().recordHeld(held);
  if (attested && caller.origin === "model") {
    raft.frontier.inContext(caller.contextId).recordHeld(held);
    await raft.state.save();
  }
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
      messages: held.heldMessages.map((m) => modelLine(m, unoffered)),
      ...(held.omittedMessageCount ? { omitted: held.omittedMessageCount } : {}),
      ...(held.withheld ? { withheld: true } : {}),
      ...(unshown ? { unshown } : {}),
    },
    answer: { choices: [go, "drop"] },
    state: {
      op: op.name, args: { ...input, ...key } as Json, heldAt,
      ...(go === "send" && attested && held.seenUpToSeq !== null ? { seen: { upToSeq: held.seenUpToSeq } } : {}),
      ...(attested && held.seenUpToSeq !== null ? { attest: { target: held.target, upToSeq: held.seenUpToSeq } } : {}),
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

async function legacyResume(state: Json, answer: Json, ctx: PluginContext, unoffered: ReadonlySet<string>): Promise<Json | Interrupt> {
  const s = object(state);
  if (typeof s.target !== "string" || typeof s.content !== "string" || typeof s.idempotencyKey !== "string") {
    throw new Error("raft: the held send's state is incomplete; call messages_send again");
  }
  if (answer === "drop") {
    return { state: "dropped", target: s.target, note: "Not sent. To send something else, call messages_send with the new content and a new idempotencyKey." };
  }
  if (answer !== "send") throw new Error(`raft: the answer must be "send" or "drop", not ${JSON.stringify(answer)}`);
  const seen = object(s.seen);
  return legacySend(ctx, unoffered, {
    target: s.target, content: s.content, idempotencyKey: s.idempotencyKey,
    ...(typeof seen.upToSeq === "number" ? { seen: { upToSeq: seen.upToSeq } } : {}),
  });
}

/** The old tool's send, unchanged, so a held send resumes as it would have; removed with `legacyResume`. */
async function legacySend(
  ctx: PluginContext, unoffered: ReadonlySet<string>,
  send: { target: string; content: string; idempotencyKey: string; seen?: { upToSeq: number } },
): Promise<Json | Interrupt> {
  const raft = raftFor(ctx);
  const out = await raft.messages.send(send);
  if (!out.ok) throw sdkFailure(out, unoffered, true);
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
        messages: held.heldMessages.map((m) => modelLine(m, unoffered)),
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
    ...(out.data.recentUnread.length ? { recentUnread: out.data.recentUnread.map((m) => modelLine(m, unoffered)) } : {}),
  };
}

/**
 * What one `receive_events` hands the model out of the batch Raft returned, what it acknowledges, and whether it
 * records the shown messages as seen.
 *
 * The runtime parks a result whose `JSON.stringify` is longer than `PARK_BYTES` (cf/src/runtime.ts, where a mounted
 * call's result is measured whole: keys, escaping and all, not just the message text), and the model then reads a
 * preview, not the messages. So the result is measured here the same way, and only the messages that keep it under
 * the line are shown, the rest left for the next call.
 *
 * Which ones, and the cursor, follow from how Raft acknowledges: `since = n` acknowledges every pending row with
 * seq ≤ n, seq being the message's global seq, while a batch comes in delivery-queue order with conversations
 * interleaved, not in seq order. So the messages are taken in ascending seq — here, not trusting the SDK's own sort
 * to stay — and the shown ones are always a lowest-seq prefix. The cursor is the smallest unshown seq less one, or
 * the largest shown seq when all of them fit: it can never cover a message the model was not shown. A message with
 * no seq (a third-party event) has no place in that order and was acknowledged when it was handed out, so it is
 * always shown and never decides the cursor.
 *
 * A message too long to fit even alone is handed over alone, acknowledged, and NOT recorded as seen: the result is
 * parked, so the model was given a preview and a reference, not the message. It is the lowest seq, so left
 * unacknowledged it would head every later batch and the inbox would never move; acknowledged, nothing is lost,
 * since the parked result holds it whole and the conversation's history still has it, and with no seen record a
 * send into that conversation is held and shows the model what is new there before it goes. The same holds for a
 * Server that acknowledges on read: it has already taken the whole batch, so all of it is handed over, and
 * recorded as seen only when it fits.
 */
export function handOver(batch: RaftInboxBatch, unoffered: ReadonlySet<string> = DEFAULT_UNOFFERED): { result: Record<string, Json>; shown: RaftMessage[]; cursor: number | null; attested: boolean } {
  const queued = batch.messages.filter((m) => m.seq !== null).sort((x, y) => x.seq! - y.seq!);
  const handedOff = batch.messages.filter((m) => m.seq === null);
  const onRead = batch.ackMode === "immediate";
  const shownAt = (k: number) => [...queued.slice(0, k), ...handedOff];
  const resultOf = (k: number, attested: boolean): Record<string, Json> => {
    const left = queued.length - k;
    const hasMore = batch.hasMore || left > 0;
    const notes = [
      // Kept short: it is read in the runtime's preview of a parked result, which cuts each string field.
      ...(attested ? [] : ["Too long to show whole; read the stored copy as the note beside this preview says. Not counted as seen, so a send there first shows what is new."]),
      ...(attested && left > 0 ? [`${left} more message${left === 1 ? " was" : "s were"} left unacknowledged so this result is not cut; they come first on your next call.`] : []),
      ...(hasMore ? ["More unread messages remain: call receive_events again until hasMore is false."] : []),
    ];
    return {
      messages: shownAt(k).map((m) => modelLine(m, unoffered)),
      hasMore,
      ...(notes.length ? { note: notes.join(" ") } : {}),
      // Raft's reply target names the newest message of the whole batch, which may not be among those shown.
      ...(batch.replyTarget && left === 0 ? { replyTarget: batch.replyTarget } : {}),
      // A Server that predates cursor acks acknowledged this batch already; say so rather than imply safety.
      ...(onRead ? { acknowledged: "on this read" } : {}),
    };
  };
  const fits = (r: Record<string, Json>) => JSON.stringify(r).length <= PARK_BYTES;
  const cursorAt = (k: number) =>
    queued.length === 0 ? null : k === queued.length ? queued[k - 1]!.seq : queued[k]!.seq! - 1;
  const pick = (k: number, attested: boolean) => ({ result: resultOf(k, attested), shown: shownAt(k), cursor: cursorAt(k), attested });
  if (onRead || queued.length === 0) return pick(queued.length, fits(resultOf(queued.length, true)));
  // Showing no queued message is a cut only when something else is shown; otherwise the lowest is too long alone.
  for (let k = queued.length; k >= (handedOff.length ? 0 : 1); k--) {
    if (fits(resultOf(k, true))) return pick(k, true);
  }
  // Nothing fits. With seq-less events, they alone are over the line: they are shown, having been acknowledged when
  // handed out, and no queued message is, so none is acknowledged. Without them, the lowest is too long alone.
  return pick(handedOff.length ? 0 : 1, false);
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
      "What a call showed you is acknowledged by your next call. A call that fails acknowledges nothing: repeat it, and it may hand you messages you were already given.",
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

/**
 * The attachment download (`attachments.downloadUrl`, tool `attachments_download_url`). Raft answers it with a
 * 5-minute presigned URL; the URL is a bearer capability, so it is fetched here and never shown: the model gets an
 * artifact reference to the file, its name, type and size.
 */
const DOWNLOAD_OP = "attachments.downloadUrl";
const DOWNLOAD_TOOL = "attachments_download_url";

/**
 * The largest attachment the download keeps: 25 MiB. Raft accepts uploads up to 200 MB, but the file is held in
 * the Worker's memory whole (128 MB per isolate) on the way into storage, and again by `artifacts.read` when it
 * is read back, which pages text 16 KiB at a time (READ_PAGE); a file the size of a document or an image fits
 * many times over, and nothing larger is useful to read that way. A larger one is refused before it is kept.
 */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;

function tooLarge(): Error {
  return new Error(`the attachment is larger than ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MiB, the most this mount keeps; nothing was kept`);
}

/** A response whose body stops at `ATTACHMENT_MAX_BYTES`: past it, `over()` is told and the body ends in an error. */
function capped(res: Response, over: () => void): Response {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > ATTACHMENT_MAX_BYTES) {
    over();
    // Not read at all, so the connection is let go of now rather than left holding the rest.
    res.body?.cancel().catch(() => {});
    return new Response(null, { status: 413, headers: res.headers });
  }
  if (!res.body) return res;
  let seen = 0;
  const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > ATTACHMENT_MAX_BYTES) { over(); controller.error(tooLarge()); return; }
      controller.enqueue(chunk);
    },
  }));
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/**
 * The bytes behind a presigned URL. Nothing about the URL leaves this function — not in an error, not in the log —
 * and nothing of the mount's goes with it: no credential, and redirects stay manual, so a 3xx is a failure here.
 *
 * The URL is Raft's answer, not configuration, so it is checked before anything is fetched: https only; no user name
 * or password in it (a presigned URL carries its grant in the query, and `user:pass@` is how a URL points somewhere
 * other than it reads); and no host that is inward by construction, by the same rule the http and mcp plugins use
 * (`internalHost`, src/plugins/http.ts: localhost, names under .local, .internal or home.arpa, private, link-local and metadata
 * addresses, v4 carried in v6, the resolver services that answer with the address in the name). Any port is allowed,
 * as in the http plugin: a port says nothing about where a host is.
 */
async function fetchPresigned(url: string, ctx: PluginContext): Promise<Uint8Array> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Raft returned a download address that is not a URL; nothing was kept"); }
  if (parsed.protocol !== "https:") throw new Error("Raft returned a download address that is not https; nothing was kept");
  if (parsed.username || parsed.password) throw new Error("Raft returned a download address that carries a user name or password; nothing was fetched or kept");
  if (internalHost(parsed.hostname)) throw new Error("Raft returned a download address on a private or local network; nothing was fetched or kept");
  let over = false;
  let res: Response;
  try {
    res = await fetch(parsed, { redirect: "manual", signal: AbortSignal.timeout(timeout(ctx)) } as RequestInit);
  } catch {
    throw marked(new Error("the attachment's bytes could not be fetched (no answer from storage); nothing was kept"), { transient: true });
  }
  if (!res.ok) throw marked(new Error(`storage answered HTTP ${res.status} for the attachment's bytes; nothing was kept`), { transient: res.status >= 500 || res.status === 403 });
  const body = capped(res, () => { over = true; });
  // A declared length over the cap is refused before any of the body is read.
  if (over) throw tooLarge();
  try {
    return new Uint8Array(await body.arrayBuffer());
  } catch {
    if (over) throw tooLarge();
    throw marked(new Error("the attachment's bytes stopped arriving; nothing was kept"), { transient: true });
  }
}

/** A storage path segment from a name someone chose: plain characters only, never `.`/`..` or empty. */
function pathSegment(name: string, fallback: string): string {
  const plain = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return plain && plain !== "." && plain !== ".." ? plain : fallback;
}

/** A filename from a `content-disposition` header, when the fallback download has one. */
function dispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header)?.[1];
  if (star) { try { return decodeURIComponent(star.trim().replace(/^"|"$/g, "")); } catch { /* the plain form below */ } }
  return /filename="?([^";]+)"?/i.exec(header)?.[1]?.trim() ?? null;
}

/**
 * `attachments_download_url`: the attachment's bytes, kept in the agent's object storage, and the reference to them.
 * Raft mints a URL (`attachments.downloadUrl`), fetched here (`fetchPresigned`). A Server whose storage cannot mint
 * one answers `CONFLICT` (`download_url_unavailable`) with `next.kind: "download_bytes"`, and the bytes then come
 * through Raft itself (`attachments.download`, the SDK's typed method), in the same call. Either way the file is at
 * most `ATTACHMENT_MAX_BYTES`, and what the model is shown is `{ attachmentId, ref, name, type, bytes }`.
 */
export async function downloadAttachment(
  args: unknown, ctx: PluginContext, artifacts: RaftArtifacts | null, unoffered: ReadonlySet<string> = DEFAULT_UNOFFERED,
): Promise<Json> {
  const op = RAFT_OPERATIONS.find((o) => o.name === DOWNLOAD_OP)!;
  const input = argumentsFor(op, args);
  const attachmentId = typeof input.attachmentId === "string" ? input.attachmentId.trim() : "";
  if (!attachmentId) throw new Error("attachmentId is required: the id a message line shows as (id:…)");
  if (!artifacts) throw new Error("this deployment has no object storage to keep an attachment in; nothing was downloaded");
  let file: { bytes: Uint8Array; filename: string; type: string };
  const minted = await raftFor(ctx, { state: false }).attachments.downloadUrl({ attachmentId });
  if (minted.ok) {
    file = { bytes: await fetchPresigned(minted.data.url, ctx), filename: minted.data.filename, type: minted.data.mimeType };
  } else if (minted.error.code === "CONFLICT" || minted.next?.kind === "download_bytes") {
    let over = false;
    let header: { type: string | null; filename: string | null } = { type: null, filename: null };
    const raft = raftFor(ctx, { state: false, response: (res) => {
      header = { type: res.headers.get("content-type"), filename: dispositionName(res.headers.get("content-disposition")) };
      return capped(res, () => { over = true; });
    } });
    const got = await raft.attachments.download({ attachmentId });
    if (over) throw tooLarge();
    if (!got.ok) throw sdkFailure(got as RaftFailure, unoffered);
    file = {
      bytes: got.data.bytes instanceof Uint8Array ? got.data.bytes : new Uint8Array(got.data.bytes as ArrayBuffer),
      filename: header.filename ?? `attachment-${attachmentId}`,
      type: header.type?.split(";")[0]?.trim() || "application/octet-stream",
    };
  } else {
    throw sdkFailure(minted as RaftFailure, unoffered);
  }
  if (file.bytes.byteLength > ATTACHMENT_MAX_BYTES) throw tooLarge();
  const key = `t/${ctx.caller.tenantId}/${ctx.caller.agentId}/raft/attachments/${pathSegment(attachmentId, "attachment")}/${pathSegment(file.filename, "file")}`;
  const stored = await artifacts.put(key, file.bytes, file.type);
  const ref = toAgentRef(stored.ref, ctx.caller);
  if (!ref) throw new Error("the attachment was stored where this agent cannot read it back");
  return { attachmentId, ref, name: file.filename, type: file.type, bytes: file.bytes.byteLength };
}

/**
 * The basis of a raft snapshot (`Plugin.toolsBasis`): a digest of every tool this build can offer, each as its name and
 * the capabilities it needs, sorted, so it moves exactly when what a listing could return moves — an SDK upgrade that
 * adds or removes an operation or changes the capability one needs (which changes which credentials list it), a change
 * to `EXCLUDED`, a plugin built with or without object storage — and not when a description or a schema is reworded,
 * which a snapshot never carried anyway (`mountTools` reads only its names). The same set in any order gives the same
 * basis. Exported for the test that holds both.
 */
export function toolsBasisOf(tools: ReadonlyArray<{ name: string; capability?: readonly string[] }>): string {
  const canonical = tools.map((t) => [t.name, [...(t.capability ?? [])].sort()] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `raft-tools:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16)}`;
}

/** What a mount whose credential has no capability at all is told, in its snapshot's `skipped`. */
const EVERY_OPERATION = "(every Raft operation)";

/**
 * Where the attachment download keeps a file: the agent's object storage, as the runtime hands it to the plugins that
 * store files (`sandboxPlugin`'s `save`, `statePlugin`), so the same reader (`artifacts.read`) and the same reference
 * form (`artifact://…`, src/store/refs.ts) apply.
 */
export interface RaftArtifacts {
  put(key: string, body: Uint8Array, contentType?: string): Promise<{ ref: string; bytes: number }>;
}

/**
 * The plugin, built for a runtime. `artifacts` is where `attachments_download_url` keeps what it fetches (none: the
 * tool is not offered, and every pointer at it is said in words). `excluded` is the exclusion table, `EXCLUDED` unless
 * a test builds it otherwise: every list below derives from it — which tools are generated and offered, how each is dispatched, which hints are
 * put in words (`offeredTerms`), and a message line's attachment suffix (`modelLine`) — so taking an operation out of
 * the table is the whole change that offers it.
 */
export function createRaftPlugin(deps: { artifacts?: RaftArtifacts | null; excluded?: Readonly<Record<string, string>> } = {}): Plugin {
  const excluded = deps.excluded ?? EXCLUDED;
  const artifacts = deps.artifacts ?? null;
  const generated = excluded === EXCLUDED ? GENERATED : generatedFrom(excluded);
  // With nowhere to keep a file the download could only fail, so it is not offered at all: not in `tools`, not in
  // any mount's list, and named in words wherever the SDK points at it. It stays in `operationOf`, so a direct
  // `invoke` (which the gateway never makes for a tool the mount lacks) still says why nothing was downloaded.
  const offerable = artifacts ? generated : generated.filter((op) => op.name !== DOWNLOAD_OP);
  /** What no mount of this plugin offers: the excluded operations, and the download when there is no storage. */
  const notGenerated = excluded === EXCLUDED ? DEFAULT_UNOFFERED : unofferedNames(excluded);
  const unoffered: ReadonlySet<string> = artifacts ? notGenerated : new Set([...notGenerated, DOWNLOAD_TOOL]);
  const generatedTools: readonly ToolSchema[] = offerable.map(toolOf);
  const operationOf = new Map(generated.map((op) => [op.toolName, op]));
  /** Every tool a mount can be offered: what a mount with no snapshot is offered, and the plugin's `tools`. */
  const allTools: ToolSchema[] = [...OWN_TOOLS, ...generatedTools];
  /**
   * What this call's mount does not offer, for the hints and the attachment suffix: `unoffered`, plus every generated
   * tool the kernel says this mount is not offered right now (`PluginContext.offered`) — one its credential lacks the
   * capability for, or one this build added that the mount's stored snapshot predates. A context without `offered`
   * (a test's, or one made outside the gateway) is answered with `unoffered` alone, which is what a mount with no
   * snapshot is offered.
   */
  const unofferedFor = (ctx: PluginContext): ReadonlySet<string> => {
    const offered = ctx.offered;
    if (!offered) return unoffered;
    const on = new Set(offered);
    const missing = generatedTools.filter((t) => !on.has(t.name));
    return missing.length ? new Set([...unoffered, ...missing.map((t) => t.name)]) : unoffered;
  };
  /** One generated operation: the attachment download is this plugin's own (`downloadAttachment`), the rest the SDK's. */
  const operate = (op: RaftOperationSpec, args: unknown, ctx: PluginContext, resumed?: { seen?: { upToSeq: number }; heldAt?: number }) =>
    op.name === DOWNLOAD_OP ? downloadAttachment(args, ctx, artifacts, unofferedFor(ctx)) : runOperation(op, args, ctx, unofferedFor(ctx), resumed);
  return {
    id: "raft",
    version: "1.0.0",
    /**
     * Which tools this build can offer, and what each needs, as one string: it moves when the SDK's manifest
     * (an operation or its capability), `EXCLUDED` or the presence of object storage changes the generated set, and a snapshot taken under another basis is re-taken at the next
     * turn (`Plugin.toolsBasis`), so a tool a deploy added reaches a mount without anyone refreshing it.
     */
    toolsBasis: toolsBasisOf([...OWN_TOOLS.map((t) => ({ name: t.name })), ...offerable.map((op) => ({ name: op.toolName, capability: op.capability }))]),
    /** The push registration this mount holds: whether it exists is listable, what it holds is not. */
    database: {
      version: 3, stores: { [PUSH_STORE]: { listed: [PUSH_KEY] }, [INBOX_STORE]: { listed: [STATE_KEY, SINCE_KEY] } },
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
    tools: allTools,
    retired: RETIRED,

    /**
     * The tools this mount offers: its own tools, and the generated ones its snapshot lists — the operations whose
     * every capability the mount's credential held when the snapshot was taken (`snapshotTools`). Only the names
     * are read from the snapshot, and only those this build generates; each tool's description and schema are this
     * build's, so the stored copy cannot offer a schema this code does not run, nor a tool this build no longer has.
     * A snapshot taken by an older build lacks what this one added until it is re-taken, which the runtime does at
     * the next turn when its `basis` is not this plugin's `toolsBasis`.
     *
     * A mount with no snapshot is offered every generated tool. That is every mount made before tools were
     * generated, which nothing recomputes, and one whose credential was seeded rather than attached: its model sees
     * all of them, and a call its credential may not make is refused by Raft (CAPABILITY_NOT_AUTHORIZED) as it was
     * before there was a filter. An empty snapshot is not "none taken": it offers only this plugin's own tools.
     */
    mountTools(mount: MountRecord): ToolSchema[] {
      const snapshot = mount.toolSnapshot;
      if (!snapshot) return allTools;
      const allowed = new Set(snapshot.tools.map((t) => t.name));
      return [...OWN_TOOLS, ...generatedTools.filter((t) => allowed.has(t.name))];
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
          return { tools: [], refused: true, skipped: [{ name: EVERY_OPERATION, reason: `Raft refused this mount's credential (HTTP ${me.status})` }] };
        }
        throw new Error(`could not ask Raft what this mount's credential may do: ${me.error.message}`);
      }
      const capabilities = new Set(me.data.capabilities);
      const tools: ToolSchema[] = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      for (const op of offerable) {
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
     * in-process held call leaves nothing on the Server, and cancelling is not making the call. Going ahead with a
     * keyed write held `KEY_LIFETIME_MS` or longer ago does nothing either, and says why.
     */
    interrupts: {
      async resume(tool, state, answer, ctx) {
        if (tool === LEGACY_SEND) return legacyResume(state, answer, ctx, unofferedFor(ctx));
        const op = operationOf.get(tool);
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
        // A state with no `heldAt` was made before it was recorded. Such a state cannot reach this line: held calls
        // live only in the object's memory (src/plugins/types.ts `Interrupt`) for about a minute (RUN_JS_RESUME_MS), and a
        // deploy restarts the object, so none outlives the change that added it. It goes ahead as it always did, rather
        // than refusing an answer for a reason that cannot apply to it.
        const heldAt = typeof s.heldAt === "number" && Number.isFinite(s.heldAt) ? s.heldAt : undefined;
        if (op.idempotency.kind === "key" && heldAt !== undefined && Date.now() - heldAt >= KEY_LIFETIME_MS) {
          const where = typeof s.args.target === "string" ? s.args.target
            : typeof object(s.args.message).target === "string" ? object(s.args.message).target as string : null;
          const hours = KEY_LIFETIME_MS / 3_600_000;
          return {
            state: "expired", ...(where ? { target: where } : {}),
            note: `Nothing was done: this question was asked ${hours} hours or more ago, and Raft remembers a call's ` +
              `idempotencyKey for only ${hours} hours, so if the same call already went through it would now happen twice. ` +
              `Read ${where ?? "the conversation"} with messages_read to see whether it is there, and call ${op.toolName} ` +
              "again only if it is not.",
          };
        }
        // The answer is the model's (only the model can resume), and the question it answers showed the held
        // messages: they are seen now, in the context answering, so a later send there attests them. Recorded before
        // the call goes ahead, as the model's own hold records before asking; a save that fails costs one more hold.
        const attest = object(s.attest);
        if (typeof attest.target === "string" && typeof attest.upToSeq === "number" && Number.isSafeInteger(attest.upToSeq) && attest.upToSeq > 0) {
          const raft = raftFor(ctx);
          await raft.state.load();
          raft.frontier.inContext(typeof ctx.caller.contextId === "string" ? ctx.caller.contextId : undefined).recordUpTo(attest.target, attest.upToSeq);
          await raft.state.save();
        }
        const seen = object(s.seen);
        return operate(op, s.args, ctx, {
          ...(typeof seen.upToSeq === "number" ? { seen: { upToSeq: seen.upToSeq } } : {}),
          ...(heldAt !== undefined ? { heldAt } : {}),
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
      const op = operationOf.get(name);
      if (op) return operate(op, args, ctx) as Promise<Json>;
      const a = object(args);
      if (name === "receive_events") {
        const limit = integer(a.limit, "limit", 1, EVENTS_LIMIT) ?? EVENTS_LIMIT;
        const raft = raftFor(ctx);
        // Cursor acknowledgement: nothing is acknowledged by being fetched. The cursor the previous call computed
        // (`SINCE_KEY`, kept in the mount's database, since the object may be a new process by now) goes as `since`,
        // which is what acknowledges what that call showed.
        //
        // A mount with no such record yet takes the SDK's own cursor, `commit()` first promoting a pending one. Only the
        // flow before this record existed wrote it, and that flow kept the cursor of a whole response, every message of
        // which it had handed to the model, so sending it acknowledges what that flow handed over and nothing more.
        const kept = object(await ctx.db.get(INBOX_STORE, SINCE_KEY));
        let since: number | null;
        if ("since" in kept) since = typeof kept.since === "number" ? kept.since : null;
        else { await raft.inbox.commit(); since = raft.state.snapshot().cursor; }
        // Spent before it is sent (`SINCE_KEY` says why); a write that fails here fails the call before any pull.
        await ctx.db.put(INBOX_STORE, { since: null }, SINCE_KEY);
        // The pull runs on a client whose state is not saved: the SDK books every message a pull returns as seen,
        // and only those `handOver` shows may be. As the model's own: receive_events is model-only, so the gateway
        // has already refused it from a program and from an approved call's replay.
        const out = await raftFor(ctx, { state: false }).invoke("inbox.check",
          { ack: "cursor", limit, ...(since !== null ? { since } : {}) }, { origin: "model" });
        if (!out.ok) throw sdkFailure(out as RaftFailure, unofferedFor(ctx));
        const batch = (out as { data: RaftInboxBatch }).data;
        const given = handOver(batch, unofferedFor(ctx));
        // Exactly this call's cursor, lower than the last one or not: the next pull acknowledges what was shown here.
        // A Server that acknowledged on read has nothing pending, so the next pull sends none. Written before anything
        // is recorded as seen, so a write that fails leaves nothing attested and the next pull acknowledging nothing.
        await ctx.db.put(INBOX_STORE, { since: batch.ackMode === "cursor" ? given.cursor : null }, SINCE_KEY);
        // Booked under the caller's context id, the one a later send in that context attests with (`originOf`). A
        // save that fails is reported and does not fail the call (`raftFor`): the messages are then shown unattested,
        // which only means a send into their conversation is held first.
        if (given.attested && given.shown.length) {
          const seen = raft.frontier.inContext(typeof ctx.caller.contextId === "string" ? ctx.caller.contextId : undefined);
          const byTarget = new Map<string, number[]>();
          for (const m of given.shown) if (m.seq !== null) byTarget.set(m.target, [...(byTarget.get(m.target) ?? []), m.seq]);
          for (const [target, seqs] of byTarget) seen.recordExact(target, seqs);
          await raft.state.save();
        }
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
}

/** The plugin as most of the codebase names it: the exclusion table as written, and no object storage, so no download. */
export const raftPlugin: Plugin = createRaftPlugin();

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

