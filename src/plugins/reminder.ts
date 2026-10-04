/**
 * Reminders for an agent, kept and fired by reminder-app.
 *
 * reminder-app stores each reminder and, at its due time, delivers it to the target the reminder names. This
 * plugin's target is always a webhook: on the first `create`, the mount opens one of its own inbound hooks
 * (`ctx.inbound`), registers that URL and its signing secret with reminder-app, and gets back reminder-app's id for
 * the registration. Every reminder this mount creates carries `{ kind: "webhook", hookId }` with that id, filled
 * here and never taken from the model, so an agent cannot aim a reminder at another mount's hook. When one fires,
 * reminder-app posts it signed with the registered secret, and `receive` checks the signature and wakes the agent.
 *
 * Every call to reminder-app goes through one interface, {@link ReminderService}, injected into
 * {@link createReminderPlugin}. Its HTTP implementation ({@link httpReminderService}) is provisional: reminder-app's
 * wire format and its authentication are not settled, and every place that depends on them says TODO.
 *
 * Two ids, kept apart by name throughout: the INBOUND hook id is the runtime's (the address reminder-app posts to,
 * `InboundEvent.hookId`), and the SERVICE hook id is reminder-app's (what a reminder's target names).
 *
 * Recurrence is not offered: a repeating reminder needs a rule reminder-app evaluates, and its format for one is not
 * known yet. An agent that wants a repeat creates the next reminder when one fires.
 */
import { clip, logEvent } from "../core/log.ts";
import type { Json } from "../core/types.ts";
import type { InboundEvent, InboundResult, Plugin, PluginContext, PluginErrorFields, ToolSchema } from "./types.ts";

// ---- the reminder-app boundary

/** Where a reminder is delivered. reminder-app also knows `{ kind: "raft", agentId }`; this plugin never makes one. */
export type ReminderTarget = { kind: "webhook"; hookId: string };

/** One reminder as reminder-app reports it. `target` is whatever reminder-app says, and is checked before use. */
export interface ServiceReminder {
  id: string;
  dueAt: string;
  note: string;
  createdAt: string | null;
  target: { kind: string; hookId?: string; [k: string]: unknown };
}

/** What a call to reminder-app needs from the mount: its settings, and its credential once one is declared. */
export interface ReminderConnection {
  baseUrl: string;
  /** Always null today: the plugin declares no credential until reminder-app's authentication is known. */
  credential: string | null;
  timeoutMs: number;
}

/**
 * Every call this plugin makes to reminder-app. One interface, so the wire format is decided in one place and a test
 * stands in for the whole service.
 *
 * Failures are {@link ReminderServiceError}s; the plugin reads their `code`, never their message.
 */
export interface ReminderService {
  /** Register a push URL and its signing secret; reminder-app's id for the registration. https URLs only. */
  register(conn: ReminderConnection, hook: { url: string; secret: string }): Promise<{ hookId: string }>;
  /** Make one reminder. `idempotencyKey` is the gateway's operation id: the same key twice makes one reminder. */
  create(conn: ReminderConnection, reminder: { target: ReminderTarget; dueAt: string; note: string; idempotencyKey?: string }):
    Promise<{ id: string; dueAt: string }>;
  /** Reminders not yet fired that target this registration, oldest due first. */
  list(conn: ReminderConnection, query: { hookId: string; limit: number; cursor?: string }):
    Promise<{ reminders: ServiceReminder[]; nextCursor: string | null }>;
  /** One reminder, or null when reminder-app has none by that id (fired, deleted, or never existed). */
  get(conn: ReminderConnection, id: string): Promise<ServiceReminder | null>;
  /** Delete one reminder: false when it was already gone. */
  delete(conn: ReminderConnection, id: string): Promise<boolean>;
}

/**
 * - `unknown_hook`: the registration a reminder names is not reminder-app's (any more); the plugin registers again.
 * - `refused`: reminder-app said no to the request as made (a 4xx); the message says why, for the model.
 * - `unavailable`: no usable answer (a 5xx, a timeout, an unreadable body); `mayHaveLanded` when it may have taken.
 */
export type ReminderServiceErrorCode = "unknown_hook" | "refused" | "unavailable";

export class ReminderServiceError extends Error {
  code: ReminderServiceErrorCode;
  constructor(code: ReminderServiceErrorCode, message: string, marks: { mayHaveLanded?: boolean } = {}) {
    super(message);
    this.code = code;
    const fields = this as Error & PluginErrorFields;
    // Only ever true: absent has to keep meaning "not reported" (PluginErrorFields.mayHaveLanded).
    if (marks.mayHaveLanded) fields.mayHaveLanded = true;
    if (code === "unavailable") { fields.transient = true; fields.retryable = true; }
  }
}

// ---- the provisional HTTP client

/**
 * TODO(reminder-app): every path and field name in this table is a proposal, not reminder-app's API. Confirm or
 * replace each with the reminder-app owner; nothing outside `httpReminderService` depends on them.
 */
const PROVISIONAL = {
  hooks: "/v1/hooks",                       // POST { url, secret } → { hookId }
  reminders: "/v1/reminders",               // POST { target, dueAt, note } → { id, dueAt }; GET ?hookId&limit&cursor → { reminders, nextCursor }
  reminder: (id: string) => `/v1/reminders/${encodeURIComponent(id)}`, // GET → reminder | 404; DELETE → 204 | 404
  unknownHookCode: "unknown_hook",          // the error code a create answers when the target's registration is gone
} as const;

/**
 * reminder-app over HTTP, against the mount's `serviceUrl` origin.
 *
 * What is settled here is what does not depend on reminder-app's format: requests stay on the configured origin,
 * redirects are not followed, every request has a timeout, and a failure is reported by status, never with the
 * request body (a registration's body carries the secret).
 *
 * TODO(reminder-app): authentication. No credential is sent, because none is known: reminder-app's rule that a hook
 * serves only its registrant's reminders needs it to know who the registrant is, so a real deployment cannot use this
 * until it does. When the scheme is known, declare `credential` on the plugin and send `conn.credential` here.
 */
export function httpReminderService(): ReminderService {
  async function call(conn: ReminderConnection, method: "GET" | "POST" | "DELETE", path: string,
    body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: any }> {
    const origin = new URL(conn.baseUrl);
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) throw new ReminderServiceError("refused", "a reminder-app request escaped its configured origin");
    const headers: Record<string, string> = { accept: "application/json", ...extra };
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(url, {
        method, headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(conn.timeoutMs),
      });
    } catch {
      // The transport's own message can name the URL; it is not passed on.
      throw new ReminderServiceError("unavailable", "reminder-app did not answer", { mayHaveLanded: method !== "GET" });
    }
    if (response.status === 204) return { status: 204, data: null };
    let data: any = null;
    try { const raw = await response.text(); data = raw.trim() ? JSON.parse(raw) : null; }
    catch { if (response.ok) throw new ReminderServiceError("unavailable", "reminder-app answered with something that is not JSON", { mayHaveLanded: method !== "GET" }); }
    if (response.ok) return { status: response.status, data };
    const code = typeof data?.code === "string" ? data.code : null;
    if (code === PROVISIONAL.unknownHookCode) throw new ReminderServiceError("unknown_hook", "reminder-app does not know this mount's registration");
    if (response.status >= 500 || response.status === 429) {
      throw new ReminderServiceError("unavailable", `reminder-app returned HTTP ${response.status}`, { mayHaveLanded: method !== "GET" && response.status !== 429 });
    }
    if (response.status === 404) return { status: 404, data: null };
    // reminder-app's own reason, clipped and on one line: it is about the request the model made.
    const reason = typeof data?.message === "string" ? `: ${oneLine(data.message, 200)}` : "";
    throw new ReminderServiceError("refused", `reminder-app refused the request (HTTP ${response.status}${code ? `, ${oneLine(code, 40)}` : ""})${reason}`);
  }
  const reminderOf = (r: any): ServiceReminder | null =>
    r && typeof r.id === "string" && typeof r.dueAt === "string" && r.target && typeof r.target === "object"
      ? { id: r.id, dueAt: r.dueAt, note: typeof r.note === "string" ? r.note : "", createdAt: typeof r.createdAt === "string" ? r.createdAt : null, target: r.target }
      : null;
  return {
    async register(conn, hook) {
      const { status, data } = await call(conn, "POST", PROVISIONAL.hooks, { url: hook.url, secret: hook.secret });
      if (status === 404 || typeof data?.hookId !== "string") throw new ReminderServiceError("unavailable", "reminder-app's registration answer had no hookId", { mayHaveLanded: true });
      return { hookId: data.hookId };
    },
    async create(conn, reminder) {
      const { idempotencyKey, ...body } = reminder;
      // TODO(reminder-app): whether it honours an idempotency key, and under which header.
      const { status, data } = await call(conn, "POST", PROVISIONAL.reminders, body, idempotencyKey ? { "idempotency-key": idempotencyKey } : {});
      if (status === 404) throw new ReminderServiceError("unknown_hook", "reminder-app does not know this mount's registration");
      if (typeof data?.id !== "string") throw new ReminderServiceError("unavailable", "reminder-app's answer had no reminder id", { mayHaveLanded: true });
      return { id: data.id, dueAt: typeof data.dueAt === "string" ? data.dueAt : reminder.dueAt };
    },
    async list(conn, query) {
      const q = new URLSearchParams({ hookId: query.hookId, limit: String(query.limit), ...(query.cursor ? { cursor: query.cursor } : {}) });
      const { data } = await call(conn, "GET", `${PROVISIONAL.reminders}?${q}`);
      const reminders = Array.isArray(data?.reminders) ? data.reminders.map(reminderOf).filter((r: ServiceReminder | null): r is ServiceReminder => r !== null) : [];
      return { reminders, nextCursor: typeof data?.nextCursor === "string" ? data.nextCursor : null };
    },
    async get(conn, id) {
      const { status, data } = await call(conn, "GET", PROVISIONAL.reminder(id));
      return status === 404 ? null : reminderOf(data);
    },
    async delete(conn, id) {
      const { status } = await call(conn, "DELETE", PROVISIONAL.reminder(id));
      return status !== 404;
    },
  };
}

// ---- the mount's record

/**
 * This mount's registration with reminder-app, one record under one key. The secret is not in it, by design: the
 * contract keeps a hook's secret at the hook layer (`InboundHooks.create`, and `InboundEvent.hookId` for why that
 * matters), and the runtime hands it to `receive` on each delivery. So dropping this record leaves the hook and its
 * secret standing, and there is never a second copy to disagree with the one deliveries are checked against.
 */
export const HOOK_STORE = "hook";
export const HOOK_KEY = "state";

/** reminder-app's ids and the runtime's hook ids, as far as this plugin accepts one: short, and nothing that could break a line. */
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

type HookState = {
  /** The runtime's hook reminder-app posts to. */
  inboundHookId: string | null;
  /** reminder-app's id for the registration; what every reminder's target names. */
  serviceHookId: string | null;
  /** Inbound hooks that must still be revoked: what a failed revoke left behind. Cleared before anything new is made. */
  staleInboundHookIds: string[];
  registeredAt: number | null;
};

function hookState(value: unknown): HookState & { known: boolean } {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const id = (x: unknown) => typeof x === "string" && ID.test(x) ? x : null;
  return {
    known: value !== null && value !== undefined,
    inboundHookId: id(v.inboundHookId),
    serviceHookId: id(v.serviceHookId),
    staleInboundHookIds: Array.isArray(v.staleInboundHookIds) ? [...new Set(v.staleInboundHookIds.map(id).filter((x): x is string => x !== null))] : [],
    registeredAt: typeof v.registeredAt === "number" && Number.isFinite(v.registeredAt) ? v.registeredAt : null,
  };
}

async function loadHook(ctx: PluginContext) {
  return hookState(await ctx.db.get(HOOK_STORE, HOOK_KEY));
}

async function saveHook(ctx: PluginContext, s: HookState): Promise<void> {
  const record: HookState = { inboundHookId: s.inboundHookId, serviceHookId: s.serviceHookId, staleInboundHookIds: s.staleInboundHookIds, registeredAt: s.registeredAt };
  await ctx.db.put(HOOK_STORE, record as unknown as Json, HOOK_KEY);
}

async function revokeAll(ctx: PluginContext, ids: string[]): Promise<string[]> {
  if (!ctx.inbound) return ids;
  const failed: string[] = [];
  for (const id of ids) {
    try { await ctx.inbound.revoke(id); } catch { failed.push(id); }
  }
  return failed;
}

// ---- the tools

export const NOTE_MAX = 1_000;
/** The furthest ahead a reminder may be set. A bound, so a typo in a year is refused rather than kept for ever. */
export const MAX_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
const MAX_DELAY_MINUTES = MAX_AHEAD_MS / 60_000;
export const LIST_MAX = 50;
const LIST_DEFAULT = 20;
const DEFAULT_TIMEOUT_MS = 10_000;

const TOOLS: ToolSchema[] = [
  {
    name: "create",
    summary: "Set a reminder: at the time you choose, a message with your note wakes you in this conversation. " +
      "Give exactly one of `at` (an absolute time) or `delayMinutes` (from now). One-off only; to repeat, set the next one when it fires.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        at: { type: "string", description: "When, as ISO 8601 with a time zone: 2026-10-05T09:00:00Z or 2026-10-05T11:00:00+02:00. Must be in the future, at most a year ahead." },
        delayMinutes: { type: "integer", minimum: 1, maximum: MAX_DELAY_MINUTES, description: "When, as minutes from now." },
        note: { type: "string", minLength: 1, maxLength: NOTE_MAX, description: "What the reminder should tell you: write it for yourself, with what you will need to act on it." },
      },
      required: ["note"],
    },
    sideEffects: "write",
    // Keyed by the gateway's operation id, which reminder-app is asked to honour; not "native", because a re-run after
    // a crash is a new operation with a new id (PluginContext.operationId), and the first call may open the push hook.
    idempotency: "key",
  },
  {
    name: "list",
    summary: "List the reminders this mount has set that have not fired yet, soonest first.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: LIST_MAX, description: `At most this many (default ${LIST_DEFAULT}).` },
        cursor: { type: "string", description: "The nextCursor of a previous list, for the next page." },
      },
    },
    sideEffects: "read",
    idempotency: "native",
  },
  {
    name: "delete",
    summary: "Cancel one of this mount's reminders by its id, before it fires.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: { id: { type: "string", description: "The reminder's id, as create or list gave it." } },
      required: ["id"],
    },
    sideEffects: "write",
    // Not "native": a second call finds nothing to cancel and says so, which is a different result.
    idempotency: "none",
  },
];

function args(value: Json, allowed: readonly string[], tool: string): Record<string, unknown> {
  const a = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const extra = Object.keys(a).filter((k) => !allowed.includes(k));
  if (extra.length) {
    // The delivery target in particular is the plugin's to fill: refused, not ignored, so the model learns it.
    const target = extra.some((k) => /target|hook/i.test(k)) ? " Where a reminder is delivered is fixed by this mount: it always wakes you here." : "";
    throw new Error(`${tool} does not take ${extra.map((k) => JSON.stringify(k)).join(", ")}; it takes ${allowed.join(", ")}.${target}`);
  }
  return a;
}

const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** When a reminder is due, from exactly one of `at` and `delayMinutes`; refused when unreadable, past, or too far. */
export function dueTime(a: Record<string, unknown>, now: number): number {
  const hasAt = a.at !== undefined, hasDelay = a.delayMinutes !== undefined;
  if (hasAt === hasDelay) throw new Error("give exactly one of `at` (an ISO 8601 time with a zone) or `delayMinutes`");
  let due: number;
  if (hasDelay) {
    const m = a.delayMinutes;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > MAX_DELAY_MINUTES) {
      throw new Error(`delayMinutes must be a whole number from 1 to ${MAX_DELAY_MINUTES}`);
    }
    due = now + m * 60_000;
  } else {
    const s = a.at;
    const parts = typeof s === "string" ? ISO_WITH_ZONE.exec(s) : null;
    // Date.parse alone accepts 2026-02-30 (as 2 March) and a time with no zone (as local time, whichever that is).
    const [, y, mo, d, h, mi, sec] = parts ?? [];
    const valid = parts && +mo! >= 1 && +mo! <= 12 && +d! >= 1 && +d! <= new Date(Date.UTC(+y!, +mo!, 0)).getUTCDate() &&
      +h! <= 23 && +mi! <= 59 && +(sec ?? 0) <= 59;
    due = valid ? Date.parse(s as string) : NaN;
    if (!Number.isFinite(due)) {
      throw new Error(`at ${JSON.stringify(typeof s === "string" ? clip(s, 60) : s)} is not a time this reads: write ISO 8601 with a zone, such as 2026-10-05T09:00:00Z`);
    }
    if (due <= now) throw new Error(`at ${new Date(due).toISOString()} has already passed (it is now ${new Date(now).toISOString()}); choose a future time`);
  }
  if (due - now > MAX_AHEAD_MS) throw new Error("a reminder can be set at most a year ahead");
  return due;
}

function connection(ctx: PluginContext): ReminderConnection {
  const baseUrl = ctx.publicConfig.serviceUrl;
  if (typeof baseUrl !== "string" || !baseUrl) throw new Error("this mount has no serviceUrl setting; its operator sets reminder-app's origin");
  const t = ctx.publicConfig.timeoutMs;
  const timeoutMs = typeof t === "number" && Number.isFinite(t) ? Math.min(60_000, Math.max(1_000, t)) : DEFAULT_TIMEOUT_MS;
  return { baseUrl, credential: ctx.credential ?? null, timeoutMs };
}

/** The line a failure from reminder-app becomes for the model: its message, which our client writes and never fills with a URL or a secret. */
function forModel(e: unknown): Error {
  return e instanceof ReminderServiceError ? e : new Error("reminder-app could not be reached");
}

/**
 * This mount's registration with reminder-app, made on first use.
 *
 * Follows the inbound contract's rules for a hook a plugin makes itself (docs/plugins.md, "Hooks the plugin makes
 * itself"): leftovers of failed attempts are revoked before anything new is made, the new hook's id is written down
 * before it is relied on, and a registration that fails takes its hook away again. Unlike Raft's push, a
 * registration that MAY have landed is revoked too: no reminder can name a registration whose id never came back, so
 * nothing would ever post to that hook.
 *
 * The secret is used once, for `register`, and dropped: see {@link HOOK_STORE}.
 */
async function ensureRegistered(ctx: PluginContext, service: ReminderService, conn: ReminderConnection): Promise<string> {
  let state = await loadHook(ctx);
  if (state.inboundHookId && state.serviceHookId) return state.serviceHookId;
  if (!ctx.inbound) throw new Error("this deployment cannot take pushed events, so a reminder could never reach you; nothing was set");
  if (state.staleInboundHookIds.length) {
    const left = await revokeAll(ctx, state.staleInboundHookIds);
    state = { ...state, staleInboundHookIds: left };
    await saveHook(ctx, state);
    if (left.length) throw new Error("an earlier push endpoint of this mount could not be revoked; try again");
  }
  // A half-made record (an inbound hook with no registration) is replaced, and its hook revoked below.
  const replaced = state.inboundHookId ? [state.inboundHookId] : [];
  const line = { tenantId: ctx.caller.tenantId, agentId: ctx.caller.agentId, mount: ctx.alias };
  const created = await ctx.inbound.create();
  let serviceHookId: string;
  try {
    if (new URL(created.url).protocol !== "https:") {
      throw new ReminderServiceError("refused", "this deployment's push endpoints are not https, and reminder-app accepts only https");
    }
    let registered: { hookId: string };
    try { registered = await service.register(conn, { url: created.url, secret: created.secret }); }
    catch (e) {
      // Written here from the code alone: whatever a client put in its message was composed with the URL and the
      // secret in reach, and a tool error lands in the transcript.
      const code: ReminderServiceErrorCode = e instanceof ReminderServiceError ? e.code : "unavailable";
      throw new ReminderServiceError(code, code === "refused"
        ? "reminder-app refused this mount's push endpoint; nothing was set"
        : "reminder-app could not register this mount's push endpoint; nothing was set, try again later");
    }
    if (typeof registered?.hookId !== "string" || !ID.test(registered.hookId)) {
      throw new ReminderServiceError("unavailable", "reminder-app's registration answer carried no usable id; nothing was set");
    }
    serviceHookId = registered.hookId;
  } catch (e) {
    const left = await revokeAll(ctx, [created.hookId]);
    if (left.length) await saveHook(ctx, { ...state, staleInboundHookIds: [...state.staleInboundHookIds, ...left] });
    logEvent("reminder.register", { ...line, outcome: "failed", code: e instanceof ReminderServiceError ? e.code : "error" });
    throw forModel(e);
  }
  const next: HookState = { inboundHookId: created.hookId, serviceHookId, staleInboundHookIds: replaced, registeredAt: Date.now() };
  await saveHook(ctx, next);
  const left = await revokeAll(ctx, replaced);
  if (left.length !== replaced.length) await saveHook(ctx, { ...next, staleInboundHookIds: left });
  logEvent("reminder.register", { ...line, outcome: "registered" });
  return serviceHookId;
}

/** reminder-app no longer knows the registration: forget it, keeping its hook for revoking, so the next use registers anew. */
async function forgetRegistration(ctx: PluginContext): Promise<void> {
  const state = await loadHook(ctx);
  const stale = state.inboundHookId ? [...state.staleInboundHookIds, state.inboundHookId] : state.staleInboundHookIds;
  await saveHook(ctx, { inboundHookId: null, serviceHookId: null, staleInboundHookIds: [...new Set(stale)], registeredAt: null });
}

const ownedBy = (r: ServiceReminder, serviceHookId: string) => r.target?.kind === "webhook" && r.target.hookId === serviceHookId;
const shown = (r: ServiceReminder) => ({ id: r.id, dueAt: isoOrNull(r.dueAt), createdAt: isoOrNull(r.createdAt), note: clip(r.note, NOTE_MAX) ?? "" });

// ---- receiving

/** TODO(reminder-app): the header it signs under, and the signature's form; this is GitHub's form, which Raft also uses. */
export const SIGNATURE_HEADER = "x-reminder-signature-256";

/** HMAC-SHA256 of the exact body bytes, compared by WebCrypto's `verify`, which is constant-time. */
async function signedWith(body: Uint8Array, header: string | undefined, secret: string): Promise<boolean> {
  const hex = /^sha256=([0-9a-f]{64})$/i.exec(header ?? "")?.[1];
  if (!hex || !secret) return false;
  const sig = Uint8Array.from(hex.match(/../g)!, (h) => Number.parseInt(h, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, body);
}

const oneLine = (s: unknown, n: number) => clip(String(s ?? "").replace(/\s+/g, " ").trim(), n) ?? "";
function isoOrNull(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The text that wakes the agent. One line the plugin writes from checked fields (ids matched by {@link ID}, times
 * re-printed from a parsed instant), then the note with every line quoted: the note is data — the agent wrote it, and
 * it came back through reminder-app — so no line of it can start where the plugin's own line or the runtime's label
 * would.
 */
export function reminderText(fired: { reminderId: string; dueAt: string | null; createdAt: string | null; note: string }): string {
  const set = fired.createdAt ? `set ${fired.createdAt}` : "set earlier";
  const due = fired.dueAt ? `, due ${fired.dueAt}` : "";
  const note = (clip(fired.note, NOTE_MAX) ?? "").split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/).map((l) => `> ${l}`).join("\n");
  return `Reminder (${set}${due}; id ${fired.reminderId}). Your note:\n${note}`;
}

/**
 * One signed fire from reminder-app.
 *
 * TODO(reminder-app): the body's fields. Expected: `{ fireId, reminderId, hookId, dueAt, createdAt, note }`, the fire
 * id unique per fire and the same on every retry of it. It is read from the signed body, not a header, so a replayed
 * body cannot be given a new id to slip past the dedupe.
 */
async function receiveFire(event: InboundEvent, secret: string, ctx: PluginContext): Promise<InboundResult> {
  const header = event.headers[SIGNATURE_HEADER];
  if (!header) return { deliver: false, rejected: true, reason: `unsigned: no ${SIGNATURE_HEADER} header` };
  if (!(await signedWith(event.body, header, secret))) {
    return { deliver: false, rejected: true, reason: "the signature does not match this hook's secret" };
  }
  // Signed by reminder-app from here on: a body that does not fit is its bug to fix (400), not a stranger (401).
  let p: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(event.body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    p = parsed as Record<string, unknown>;
  } catch {
    return { deliver: false, malformed: true, reason: "signed, but the body is not a JSON object" };
  }
  const bad = [
    typeof p.fireId === "string" && ID.test(p.fireId) ? null : "fireId",
    typeof p.reminderId === "string" && ID.test(p.reminderId) ? null : "reminderId",
    typeof p.hookId === "string" && ID.test(p.hookId) ? null : "hookId",
    typeof p.note === "string" ? null : "note",
  ].filter((f): f is string => f !== null);
  // Field names only, never values: the record is read by an operator, and a value may be anything.
  if (bad.length) return { deliver: false, malformed: true, reason: `signed, but ${bad.join(", ")} missing or malformed` };
  const state = await loadHook(ctx);
  if (!state.known) {
    // No record, yet a fire signed with this hook's secret: reminder-app still points here and names its
    // registration, which is everything `ensureRegistered` would have written (InboundEvent.hookId).
    if (ID.test(event.hookId)) {
      await saveHook(ctx, { inboundHookId: event.hookId, serviceHookId: p.hookId as string, staleInboundHookIds: [], registeredAt: null });
    }
  } else if (p.hookId !== state.serviceHookId) {
    return { deliver: false, reason: "signed, but for a registration this mount no longer uses" };
  }
  return {
    deliver: true,
    text: reminderText({ reminderId: p.reminderId as string, dueAt: isoOrNull(p.dueAt), createdAt: isoOrNull(p.createdAt), note: p.note as string }),
    // The runtime drops a repeat of this key for 24 hours (`receiveHook`), which is the plugin's whole dedupe.
    dedupeKey: p.fireId as string,
  };
}

// ---- the plugin

export function createReminderPlugin(deps: { service?: ReminderService; now?: () => number } = {}): Plugin {
  const service = deps.service ?? httpReminderService();
  const now = deps.now ?? Date.now;
  return {
    id: "reminder",
    version: "1.0.0",
    /** This mount's registration: whether it exists is listable, what it holds is not. */
    database: { version: 1, stores: { [HOOK_STORE]: { listed: [HOOK_KEY] } } },
    config: [
      { name: "serviceUrl", type: "string", required: true, format: "origin", summary: "reminder-app's origin, for example https://reminders.example.com." },
      { name: "timeoutMs", type: "number", default: DEFAULT_TIMEOUT_MS, min: 1_000, max: 60_000, summary: "How long one request to reminder-app may take, in milliseconds." },
    ],
    // No `credential`: reminder-app's authentication is not known yet, and a declared one would put a form for an
    // invented key in front of people. TODO(reminder-app): declare it with the real shape, and send it in
    // `httpReminderService`.
    tools: TOOLS,

    async invoke(tool, raw, ctx): Promise<Json> {
      const conn = connection(ctx);
      if (tool === "create") {
        const a = args(raw, ["at", "delayMinutes", "note"], tool);
        const note = typeof a.note === "string" ? a.note.trim() : "";
        if (!note) throw new Error("note is required: write what the reminder should tell you");
        if (note.length > NOTE_MAX) throw new Error(`note has ${note.length} characters; the limit is ${NOTE_MAX}`);
        const dueAt = new Date(dueTime(a, now())).toISOString();
        const make = async (hookId: string) => service.create(conn, {
          target: { kind: "webhook", hookId }, dueAt, note,
          ...(ctx.operationId ? { idempotencyKey: ctx.operationId } : {}),
        });
        let made: { id: string; dueAt: string };
        try {
          try { made = await make(await ensureRegistered(ctx, service, conn)); }
          catch (e) {
            if (!(e instanceof ReminderServiceError) || e.code !== "unknown_hook") throw e;
            // reminder-app lost the registration: register again, once, and make the reminder against that.
            await forgetRegistration(ctx);
            made = await make(await ensureRegistered(ctx, service, conn));
          }
        } catch (e) { throw forModel(e); }
        return { id: made.id, dueAt: isoOrNull(made.dueAt) ?? dueAt, note };
      }
      if (tool === "list") {
        const a = args(raw, ["limit", "cursor"], tool);
        const limit = a.limit === undefined ? LIST_DEFAULT : a.limit;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) throw new Error(`limit must be a whole number from 1 to ${LIST_MAX}`);
        if (a.cursor !== undefined && typeof a.cursor !== "string") throw new Error("cursor must be the nextCursor a previous list returned");
        const state = await loadHook(ctx);
        if (!state.serviceHookId) return { reminders: [], nextCursor: null };
        let page;
        try { page = await service.list(conn, { hookId: state.serviceHookId, limit, ...(a.cursor ? { cursor: a.cursor as string } : {}) }); }
        catch (e) {
          if (e instanceof ReminderServiceError && e.code === "unknown_hook") return { reminders: [], nextCursor: null };
          throw forModel(e);
        }
        // Filtered here too: what this mount shows is what targets its own registration, whatever reminder-app returned.
        const mine = page.reminders.filter((r) => ownedBy(r, state.serviceHookId!)).slice(0, limit);
        return { reminders: mine.map(shown), nextCursor: page.nextCursor };
      }
      if (tool === "delete") {
        const a = args(raw, ["id"], tool);
        const id = a.id;
        if (typeof id !== "string" || !ID.test(id)) throw new Error("id must be a reminder id, as create or list gave it");
        const state = await loadHook(ctx);
        const notMine = new Error(`this mount has no pending reminder ${id}; list shows the ones it can cancel`);
        if (!state.serviceHookId) throw notMine;
        let found: ServiceReminder | null;
        try { found = await service.get(conn, id); } catch (e) { throw forModel(e); }
        // Another mount's reminder, or another registrant's, reads the same as none: this mount cannot touch it.
        if (!found || !ownedBy(found, state.serviceHookId)) throw notMine;
        let deleted: boolean;
        try { deleted = await service.delete(conn, id); } catch (e) { throw forModel(e); }
        return deleted ? { deleted: id } : { deleted: null, note: `reminder ${id} had already fired or been cancelled` };
      }
      throw new Error(`unknown reminder tool: ${tool}`);
    },

    receive: receiveFire,
  };
}

/** The plugin as the deployment registers it: reminder-app over HTTP. */
export const reminderPlugin: Plugin = createReminderPlugin();
