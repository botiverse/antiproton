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
 * The wire format is reminder-app/docs/webhook-delivery.md (reminder-app 0.1.0, PR #6, 311b1f5), with the agent-owned reminder routes
 * of reminder-app/docs/api.md (reminder-app 0.1.0, PR #6, 311b1f5); the reminder object's fields, which neither document lists, are
 * those reminder-app/src/server/workspace.ts (reminder-app 0.1.0, PR #6, 311b1f5) returns. Every call to reminder-app goes through one
 * interface, {@link ReminderService}, injected into {@link createReminderPlugin}; {@link httpReminderService} is
 * that format over HTTP.
 *
 * Two ids, kept apart by name throughout: the INBOUND hook id is the runtime's (the address reminder-app posts to,
 * `InboundEvent.hookId`), and the SERVICE hook id is reminder-app's (what a reminder's target names).
 *
 * Recurrence is not offered: reminder-app has a rule grammar for it, but a one-shot tool is what the agent needs
 * first, and an agent that wants a repeat creates the next reminder when one fires.
 */
import { clip, logEvent } from "../core/log.ts";
import type { Json } from "../core/types.ts";
import { originProblem } from "./types.ts";
import type { InboundEvent, InboundResult, Plugin, PluginContext, PluginErrorFields, ToolSchema } from "./types.ts";

// ---- the reminder-app boundary

/** Where a reminder is delivered. reminder-app also knows `{ kind: "raft", agentId }`; this plugin never makes one. */
export type ReminderTarget = { kind: "webhook"; hookId: string };

/** When a one-shot reminder fires, as reminder-app's `schedule` takes it: an instant, or seconds from now. */
export type ReminderSchedule = { fireAt: string } | { delaySeconds: number };

/** One reminder as reminder-app reports it, reduced to what this plugin reads. `target` is checked before use. */
export interface ServiceReminder {
  id: string;
  title: string;
  notes: string;
  /** Absent on a reminder with no target, which reminder-app delivers to Raft. */
  target: { kind: string; hookId?: string; [k: string]: unknown } | null;
  status: string;
  /** The next fire, epoch milliseconds; null once finished or cancelled. */
  nextAt: number | null;
  createdAt: number | null;
}

/** What a call to reminder-app needs: the deployment's origin and credential, and the agent it acts for. */
export interface ReminderConnection {
  baseUrl: string;
  /** The deployment's client credential (`rmc.<clientId>.<secret>`), given to the plugin when it is built; never shown to the model. */
  credential: string;
  /** The agent the call acts for (`X-Reminder-Subject`): always {@link subjectOf} the call's context. */
  subject: string;
  timeoutMs: number;
}

/**
 * Every call this plugin makes to reminder-app. One interface, so the wire format is decided in one place and a test
 * stands in for the whole service. Failures are {@link ReminderServiceError}s; the plugin reads their `code`.
 */
export interface ReminderService {
  /**
   * The subject's registrations, as reminder-app shows them: the id and the URL's origin, never the URL (its path may
   * carry a token). For telling, after an uncertain register, whether that register landed.
   */
  listHooks(conn: ReminderConnection): Promise<Array<{ hookId: string; origin: string }>>;
  /** Register a push URL and the secret it signs with; reminder-app's id for the registration. */
  register(conn: ReminderConnection, hook: { url: string; secret: string }): Promise<{ hookId: string }>;
  /** Make one reminder. The same `requestId` and body make one reminder however often they are sent. */
  create(conn: ReminderConnection, reminder: { requestId: string; title: string; notes: string; schedule: ReminderSchedule; target: ReminderTarget }):
    Promise<ServiceReminder>;
  /** The subject's active reminders, every hook's: reminder-app does not filter by hook, and the plugin does. */
  list(conn: ReminderConnection): Promise<ServiceReminder[]>;
  /** Cancel one reminder: the cancelled reminder, or null when reminder-app has none by that id for this subject. */
  cancel(conn: ReminderConnection, id: string): Promise<ServiceReminder | null>;
  /**
   * Delete a registration and, in the same step, cancel the reminders and pending firings that name it
   * (`cascade: "cancel"`). For `unmount`. A registration reminder-app does not know is `unknown_hook`.
   */
  unregister(conn: ReminderConnection, hookId: string): Promise<{ cancelledReminders: number }>;
}

/**
 * - `unknown_hook`: the registration is not this subject's (any more); the plugin registers again and retries once.
 * - `refused`: reminder-app said no to the request as made; the message says why, in words for the model. A
 *   delete refused with `hook_in_use` is one, which the plugin never sees: it always deletes with cascade.
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

// ---- reminder-app over HTTP

/** reminder-app/docs/webhook-delivery.md (reminder-app 0.1.0, PR #6, 311b1f5) "Hooks", and reminder-app/docs/api.md (reminder-app 0.1.0, PR #6, 311b1f5) "Agent-owned reminders". */
const ROUTES = {
  hooks: "/api/v1/agent/hooks",                 // POST { url, secret } → { hookId, origin, revision, createdAt, updatedAt }; GET → { hooks }
  hooksDelete: "/api/v1/agent/hooks/delete",    // POST { hookId, cascade: "cancel" } → { hookId, deleted, cancelledReminders, cancelledFirings }
  reminders: "/api/v1/agent/reminders",         // POST { requestId, reminder } → reminder; GET ?status=active → { reminders, occurrences }
  cancel: "/api/v1/agent/reminders/cancel",     // POST { id } → the cancelled reminder; 404 without a code for an unknown id
} as const;
/** The one refusal reminder-app words for a switched-off client (webhook-delivery.md "Authentication"). */

/**
 * reminder-app over HTTP, against the mount's `serviceUrl` origin.
 *
 * Every request carries the deployment's client credential and the subject (webhook-delivery.md "Authentication").
 * Requests stay on the configured origin, redirects are not followed, every request has a timeout, and a failure is
 * reported by status and reminder-app's own message, never with the request body (a registration's carries the
 * secret).
 */
export function httpReminderService(): ReminderService {
  async function call(conn: ReminderConnection, method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; result: any }> {
    const origin = new URL(conn.baseUrl);
    const url = new URL(path, origin);
    if (url.origin !== origin.origin) throw new ReminderServiceError("refused", "a reminder-app request escaped its configured origin");
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${conn.credential}`,
      "x-reminder-subject": conn.subject,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const mayHaveLanded = method === "POST";
    let response: Response;
    try {
      response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(conn.timeoutMs) });
    } catch {
      // The transport's own message can name the URL; it is not passed on.
      throw new ReminderServiceError("unavailable", "reminder-app did not answer", { mayHaveLanded });
    }
    // The envelope: { ok: true, result, status } or { ok: false, error: { message, code? }, status }.
    let envelope: any = null;
    try { const raw = await response.text(); envelope = raw.trim() ? JSON.parse(raw) : null; } catch { envelope = null; }
    if (response.ok) {
      if (envelope?.ok !== true || !("result" in envelope)) throw new ReminderServiceError("unavailable", "reminder-app answered with something that is not its envelope", { mayHaveLanded });
      return { status: response.status, result: envelope.result };
    }
    const code = typeof envelope?.error?.code === "string" ? envelope.error.code : null;
    const said = typeof envelope?.error?.message === "string" ? oneLine(envelope.error.message, 300) : "";
    if (response.status === 404 && code === "unknown_hook") throw new ReminderServiceError("unknown_hook", "reminder-app does not know this mount's registration");
    if (response.status >= 500 || response.status === 429 || response.status === 408) {
      throw new ReminderServiceError("unavailable", `reminder-app returned HTTP ${response.status}${said ? `: ${said}` : ""}`, { mayHaveLanded: mayHaveLanded && response.status >= 500 });
    }
    if (response.status === 404) return { status: 404, result: null };
    if (response.status === 401) {
      throw new ReminderServiceError("refused", "reminder-app did not accept this deployment's client credential (unknown, rotated or revoked); whoever deploys has to configure a current one");
    }
    if (response.status === 403) {
      // The two refusals reminder-app names (reminder-app#7): a client switched off, and an agent with a Raft identity,
      // which reaches its reminders through Raft. Read by code, never by the sentence; any other 403 is passed on as said.
      if (code === "agent_reminders_disabled") throw new ReminderServiceError("refused", "reminder-app has not switched on reminders for this deployment, so none can be set yet; whoever runs this deployment has to ask for them to be switched on");
      if (code === "raft_agent_uses_raft_channel") throw new ReminderServiceError("refused", "reminder-app refused this agent because it has a Raft identity; it sets reminders with Raft's own reminder tools instead");
      throw new ReminderServiceError("refused", `reminder-app refused the request (HTTP 403)${said ? `: ${said}` : ""}`);
    }
    // 400, 409 (a cap reached, a key reused), 413, 415: reminder-app's own sentence is about the request the model made.
    throw new ReminderServiceError("refused", `reminder-app refused the request (HTTP ${response.status})${said ? `: ${said}` : ""}`);
  }
  return {
    async listHooks(conn) {
      const { result } = await call(conn, "GET", ROUTES.hooks);
      return Array.isArray(result?.hooks)
        ? result.hooks.filter((h: any) => typeof h?.hookId === "string" && typeof h?.origin === "string").map((h: any) => ({ hookId: h.hookId, origin: h.origin }))
        : [];
    },
    async register(conn, hook) {
      const { result } = await call(conn, "POST", ROUTES.hooks, { url: hook.url, secret: hook.secret });
      if (typeof result?.hookId !== "string") throw new ReminderServiceError("unavailable", "reminder-app's registration answer had no hookId", { mayHaveLanded: true });
      return { hookId: result.hookId };
    },
    async create(conn, r) {
      const { status, result } = await call(conn, "POST", ROUTES.reminders, {
        requestId: r.requestId,
        reminder: { title: r.title, notes: r.notes, schedule: r.schedule, anchor: null, target: r.target },
      });
      const made = status === 404 ? null : reminderOf(result);
      if (!made) throw new ReminderServiceError("unavailable", "reminder-app's answer had no reminder", { mayHaveLanded: true });
      return made;
    },
    async list(conn) {
      const { result } = await call(conn, "GET", `${ROUTES.reminders}?status=active`);
      return Array.isArray(result?.reminders) ? result.reminders.map(reminderOf).filter((r: ServiceReminder | null): r is ServiceReminder => r !== null) : [];
    },
    async cancel(conn, id) {
      const { status, result } = await call(conn, "POST", ROUTES.cancel, { id });
      return status === 404 ? null : reminderOf(result);
    },
    async unregister(conn, hookId) {
      // With cascade, one transaction cancels what names the hook and deletes it; without, a hook still in use is
      // refused with 409 `hook_in_use` (webhook-delivery.md, reminder-app 0.1.0, PR #6, 311b1f5, "Unregister").
      const { status, result } = await call(conn, "POST", ROUTES.hooksDelete, { hookId, cascade: "cancel" });
      if (status === 404) throw new ReminderServiceError("unknown_hook", "reminder-app does not know this registration");
      return { cancelledReminders: Array.isArray(result?.cancelledReminders) ? result.cancelledReminders.length : 0 };
    },
  };
}

function reminderOf(r: any): ServiceReminder | null {
  if (!r || typeof r !== "object" || typeof r.id !== "string") return null;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    id: r.id,
    title: typeof r.title === "string" ? r.title : "",
    notes: typeof r.notes === "string" ? r.notes : "",
    target: r.target && typeof r.target === "object" && !Array.isArray(r.target) ? r.target : null,
    status: typeof r.status === "string" ? r.status : "unknown",
    nextAt: num(r.nextAt),
    createdAt: num(r.createdAt),
  };
}

// ---- who the calls are for

/**
 * The subject a call names: the agent, as this deployment identifies it — tenant and agent, the pair the codebase
 * addresses an agent by everywhere (`loadAgent`, `agentObjectName` in cf/src/object-name.ts). The subject is an
 * identifier handed to a third party that trusts it and keys every reminder and hook by it, so it carries the agent's
 * whole identity rather than depending on today's agent ids happening to be unique on their own. Neither id may
 * contain a colon, so no two pairs make one subject, and the result fits reminder-app's 1-200 of `[A-Za-z0-9_.:@-]`.
 * From the call's context only, never from a tool argument.
 */
export function subjectOf(ctx: Pick<PluginContext, "caller">): string {
  return `${ctx.caller.tenantId}:${ctx.caller.agentId}`;
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
/** reminder-app's `title` is 1-200 characters (reminder-app/docs/api.md, reminder-app 0.1.0, PR #6, 311b1f5); the note's first line, cut to fit. */
const TITLE_MAX = 200;
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
    // Keyed: reminder-app makes one reminder per requestId, which is derived from the gateway's operation id. Not
    // "native", because a re-run after a crash is a new operation with a new id (PluginContext.operationId), and the
    // first call may open the push hook.
    idempotency: "key",
  },
  {
    name: "list",
    summary: "List the reminders this mount has set that have not fired yet, soonest first.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: LIST_MAX, description: `At most this many (default ${LIST_DEFAULT}).` },
        offset: { type: "integer", minimum: 0, description: "Skip this many, for the next page: the nextOffset of a previous list." },
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
    // Where a reminder goes and whose it is are the plugin's to fill: refused, not ignored, so the model learns it.
    const fixed = extra.some((k) => /target|hook|subject|agent/i.test(k)) ? " Where a reminder is delivered and whose it is are fixed by this mount: it always wakes you here." : "";
    throw new Error(`${tool} does not take ${extra.map((k) => JSON.stringify(k)).join(", ")}; it takes ${allowed.join(", ")}.${fixed}`);
  }
  return a;
}

const ISO_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/** When a reminder is due, from exactly one of `at` and `delayMinutes`; refused when unreadable, past, or too far. */
export function dueTime(a: Record<string, unknown>, now: number): { due: number; schedule: ReminderSchedule } {
  const hasAt = a.at !== undefined, hasDelay = a.delayMinutes !== undefined;
  if (hasAt === hasDelay) throw new Error("give exactly one of `at` (an ISO 8601 time with a zone) or `delayMinutes`");
  let due: number, schedule: ReminderSchedule;
  if (hasDelay) {
    const m = a.delayMinutes;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > MAX_DELAY_MINUTES) {
      throw new Error(`delayMinutes must be a whole number from 1 to ${MAX_DELAY_MINUTES}`);
    }
    due = now + m * 60_000;
    schedule = { delaySeconds: m * 60 };
  } else {
    const s = a.at;
    const parts = typeof s === "string" ? ISO_WITH_ZONE.exec(s) : null;
    // Date.parse alone accepts 2026-02-30 (as 2 March) and a time with no zone (as local time, whichever that is);
    // reminder-app would read the second in its own default zone, which is no better.
    const [, y, mo, d, h, mi, sec] = parts ?? [];
    const valid = parts && +mo! >= 1 && +mo! <= 12 && +d! >= 1 && +d! <= new Date(Date.UTC(+y!, +mo!, 0)).getUTCDate() &&
      +h! <= 23 && +mi! <= 59 && +(sec ?? 0) <= 59;
    due = valid ? Date.parse(s as string) : NaN;
    if (!Number.isFinite(due)) {
      throw new Error(`at ${JSON.stringify(typeof s === "string" ? clip(s, 60) : s)} is not a time this reads: write ISO 8601 with a zone, such as 2026-10-05T09:00:00Z`);
    }
    if (due <= now) throw new Error(`at ${new Date(due).toISOString()} has already passed (it is now ${new Date(now).toISOString()}); choose a future time`);
    // Sent as the instant this read, in UTC: the same time, in the one spelling with nothing left to interpret.
    schedule = { fireAt: new Date(due).toISOString() };
  }
  if (due - now > MAX_AHEAD_MS) throw new Error("a reminder can be set at most a year ahead");
  return { due, schedule };
}

/**
 * What the deployment gives every mount: reminder-app's origin and this deployment's client credential, both from
 * the Worker's configuration (`REMINDER_APP_ORIGIN`, `REMINDER_APP_CREDENTIAL`), handed to the plugin when it is
 * built. Neither is a mount setting: a mount can be added from the console, and a credential sent wherever a
 * setting pointed would go wherever whoever typed the setting chose.
 */
export interface ReminderDeployment {
  serviceUrl: string | null;
  clientCredential: string | null;
}

export const NO_CREDENTIAL = "this deployment has no reminder-app credential configured; nothing was sent";
export const NO_ORIGIN = "this deployment has no reminder-app origin configured; nothing was sent";

function connection(ctx: PluginContext, deployment: ReminderDeployment): ReminderConnection {
  if (!deployment.clientCredential) throw new Error(NO_CREDENTIAL);
  // Checked as a mount's origin setting would be: https, no path, written as the origin. The deployment's own value,
  // but it is where the credential goes.
  if (!deployment.serviceUrl || originProblem(deployment.serviceUrl)) throw new Error(NO_ORIGIN);
  const t = ctx.publicConfig.timeoutMs;
  const timeoutMs = typeof t === "number" && Number.isFinite(t) ? Math.min(60_000, Math.max(1_000, t)) : DEFAULT_TIMEOUT_MS;
  return { baseUrl: deployment.serviceUrl, credential: deployment.clientCredential, subject: subjectOf(ctx), timeoutMs };
}

/** A failure from reminder-app as the model sees it: our client's message (which never carries a URL, a secret or the credential), or a plain line. */
function forModel(e: unknown): Error {
  return e instanceof ReminderServiceError ? e : new Error("reminder-app could not be reached");
}

/** `text` with every occurrence of each value cut out: for a message composed with a secret in reach. */
function without(text: string, values: string[]): string {
  return values.filter((v) => v.length > 0).reduce((t, v) => t.split(v).join("[withheld]"), text);
}

/**
 * This mount's registration with reminder-app, made on first use.
 *
 * Follows the inbound contract's rules for a hook a plugin makes itself (docs/plugins.md, "Hooks the plugin makes
 * itself"): leftovers of failed attempts are revoked before anything new is made, the new hook's id is written down
 * before it is relied on, and a registration that definitely failed (a refusal) takes its hook away again.
 *
 * An UNCERTAIN answer (no answer, a 5xx) may have registered the hook anyway, and reminder-app's advice is to list the
 * hooks before registering again (reminder-app/docs/webhook-delivery.md, reminder-app 0.1.0, PR #6, 311b1f5,
 * "Register"). Its list shows each hook's origin and never its URL, so ours cannot be found by URL: the subject's hooks
 * are read before registering, and after an uncertain answer read again, and a single hook that is new and on our
 * origin is the one this call made, adopted. None new: register again, once, with the same URL and secret. More than
 * one (another mount of the same agent registering at that moment): which is ours cannot be told, so the hook is
 * revoked and the call fails. The second register has to happen inside this call, while the secret is still in hand:
 * the plugin keeps no copy of it, so a later call could not register the same hook again.
 *
 * The secret is the one `ctx.inbound.create()` made — 64 hex characters, inside reminder-app's 32-256 printable
 * ASCII — used once, for `register`, and dropped: see {@link HOOK_STORE}.
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
    const url = new URL(created.url);
    // https on port 443 only, reminder-app's rule ("Hooks", URL rules): refused here rather than there, so nothing is
    // registered and the reason is ours. URL drops an explicit ":443", so any port left is another one.
    if (url.protocol !== "https:" || url.port !== "") {
      throw new ReminderServiceError("refused", "this deployment's push endpoints are not https on port 443, which reminder-app requires; nothing was set");
    }
    // Whatever a client put in its message was composed with the URL and the secret in reach, and a tool error lands
    // in the transcript: both are cut out of it, and anything that is not a service error is not repeated.
    const scrubbed = (e: unknown) => {
      const code: ReminderServiceErrorCode = e instanceof ReminderServiceError ? e.code : "unavailable";
      const said = e instanceof ReminderServiceError ? without(e.message, [created.secret, created.url, url.host]) : "";
      return new ReminderServiceError(code, `reminder-app could not register this mount's push endpoint${said ? ` (${said})` : ""}; nothing was set`);
    };
    const register = () => service.register(conn, { url: created.url, secret: created.secret });
    let before: Set<string> | null;
    try { before = new Set((await service.listHooks(conn)).map((h) => h.hookId)); } catch { before = null; }
    let registered: { hookId: string };
    try { registered = await register(); }
    catch (e) {
      const uncertain = !(e instanceof ReminderServiceError) || e.code === "unavailable";
      if (!uncertain || before === null) throw scrubbed(e);
      let after: Array<{ hookId: string; origin: string }>;
      try { after = await service.listHooks(conn); } catch { throw scrubbed(e); }
      const fresh = after.filter((h) => !before!.has(h.hookId) && h.origin === url.origin);
      if (fresh.length > 1) {
        throw new ReminderServiceError("unavailable", "reminder-app's answer was lost and which new registration is this mount's cannot be told; nothing was set, try again");
      }
      if (fresh.length === 1) registered = { hookId: fresh[0]!.hookId };
      else {
        try { registered = await register(); } catch (again) { throw scrubbed(again); }
      }
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

/** reminder-app's `requestId` (16-100 of `[A-Za-z0-9_-]`) for one operation: a digest, since an operation id may hold other characters. */
async function requestIdOf(operationId: string | undefined): Promise<string> {
  const basis = operationId ?? crypto.randomUUID();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`reminder.create:${basis}`)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const ownedBy = (r: ServiceReminder, serviceHookId: string) => r.target?.kind === "webhook" && r.target.hookId === serviceHookId;
const isoOf = (ms: number | null) => ms === null ? null : new Date(ms).toISOString();
const shown = (r: ServiceReminder) => ({ id: r.id, dueAt: isoOf(r.nextAt), createdAt: isoOf(r.createdAt), note: clip(r.notes || r.title, NOTE_MAX) ?? "" });

// ---- receiving

/**
 * How far a push's `X-Reminder-Timestamp` may be from this clock, in either direction: `MAX_CLOCK_SKEW_SECONDS` of
 * reminder-app/docs/webhook-delivery.md (reminder-app 0.1.0, PR #6, 311b1f5), "Verifying a push". It bounds a replay
 * of one captured request, not the retry schedule: every attempt is signed again with the time it was sent, so a
 * retry hours later is as fresh as the first, and a replay inside the window repeats a firingId the dedupe drops.
 */
export const MAX_CLOCK_SKEW_SECONDS = 300;
/**
 * Every attempt of a firing ends within this long of its first (webhook-delivery.md, reminder-app 0.1.0, PR #6, 311b1f5, "Responses and
 * retries", Horizon). The runtime remembers a dedupe key for INBOUND_DEDUPE_MS (src/runtime/inbound.ts), 24 hours,
 * which is the plugin's whole dedupe; the two are held together by test/reminder-plugin.ts, so neither changes alone.
 */
export const RETRY_HORIZON_MS = 12 * 60 * 60_000;

const PUSH_SCHEMA = "reminder.fired.v1";

/** HMAC-SHA256, keyed by the secret as UTF-8, over `<timestamp>.<raw body>`, checked by WebCrypto's `verify`, which is constant-time. */
async function signedWith(timestamp: string, body: Uint8Array, hex: string, secret: string): Promise<boolean> {
  if (!secret) return false;
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const message = new Uint8Array(prefix.length + body.length);
  message.set(prefix, 0);
  message.set(body, prefix.length);
  const sig = Uint8Array.from(hex.match(/../g)!, (h) => Number.parseInt(h, 16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, message);
}

const oneLine = (s: unknown, n: number) => clip(String(s ?? "").replace(/\s+/g, " ").trim(), n) ?? "";
function isoOrNull(s: unknown): string | null {
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * The text that wakes the agent. One line the plugin writes from checked fields (the id matched by {@link ID}, the
 * time re-printed from a parsed instant), then the note with every line quoted: the note is data — the agent wrote
 * it, and it came back through reminder-app — so no line of it can start where the plugin's own line or the runtime's
 * label would. The push carries no creation time, so the line says when it was due.
 */
export function reminderText(fired: { reminderId: string; scheduledAt: string | null; note: string }): string {
  const due = fired.scheduledAt ? `due ${fired.scheduledAt}` : "due earlier";
  const note = (clip(fired.note, NOTE_MAX) ?? "").split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/).map((l) => `> ${l}`).join("\n");
  return `Reminder (${due}; id ${fired.reminderId}). Your note:\n${note}`;
}

/** One signed push from reminder-app, checked as webhook-delivery.md (reminder-app 0.1.0, PR #6, 311b1f5) "Verifying a push" says. */
async function receiveFire(event: InboundEvent, secret: string, ctx: PluginContext, now: number): Promise<InboundResult> {
  const timestamp = event.headers["x-reminder-timestamp"] ?? "";
  const signature = event.headers["x-reminder-signature"] ?? "";
  if (!/^\d{1,15}$/.test(timestamp)) return { deliver: false, rejected: true, reason: "unsigned: X-Reminder-Timestamp is missing or not digits" };
  const hex = /^v1=([0-9a-f]{64})$/.exec(signature)?.[1];
  if (!hex) return { deliver: false, rejected: true, reason: "unsigned: X-Reminder-Signature is missing or not v1=<64 hex>" };
  if (Math.abs(now / 1000 - Number(timestamp)) > MAX_CLOCK_SKEW_SECONDS) {
    return { deliver: false, rejected: true, reason: `the signature's timestamp is more than ${MAX_CLOCK_SKEW_SECONDS} s from this clock` };
  }
  if (!(await signedWith(timestamp, event.body, hex, secret))) {
    return { deliver: false, rejected: true, reason: "the signature does not match this hook's secret" };
  }
  // Signed by reminder-app from here on: a body that does not fit is its bug to fix (400), not a stranger (401).
  // reminder-app reads 400 as final for the firing, so these are the shapes its document promises never to send.
  let p: Record<string, any>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(event.body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    p = parsed as Record<string, any>;
  } catch {
    return { deliver: false, malformed: true, reason: "signed, but the body is not a JSON object" };
  }
  if (p.schema !== PUSH_SCHEMA) {
    const schema = typeof p.schema === "string" ? p.schema.slice(0, 64) : typeof p.schema;
    return { deliver: false, malformed: true, reason: `signed, but the schema is ${JSON.stringify(schema)}, not ${PUSH_SCHEMA}` };
  }
  const r = p.reminder && typeof p.reminder === "object" && !Array.isArray(p.reminder) ? p.reminder : {};
  const bad = [
    typeof p.firingId === "string" && ID.test(p.firingId) ? null : "firingId",
    typeof p.hookId === "string" && ID.test(p.hookId) ? null : "hookId",
    typeof p.subject === "string" ? null : "subject",
    typeof r.id === "string" && ID.test(r.id) ? null : "reminder.id",
    typeof r.title === "string" ? null : "reminder.title",
    typeof r.notes === "string" ? null : "reminder.notes",
  ].filter((f): f is string => f !== null);
  // Field names only, never values: the record is read by an operator, and a value may be anything.
  if (bad.length) return { deliver: false, malformed: true, reason: `signed ${PUSH_SCHEMA}, but ${bad.join(", ")} missing or malformed` };
  if (event.headers["x-reminder-firing-id"] !== p.firingId) {
    return { deliver: false, malformed: true, reason: "X-Reminder-Firing-Id does not match the signed firingId" };
  }
  if (p.subject !== subjectOf(ctx)) return { deliver: false, reason: "signed, but for another agent" };
  const state = await loadHook(ctx);
  if (!state.known) {
    // No record, yet a push signed with this hook's secret: reminder-app still points here and names its
    // registration, which is everything `ensureRegistered` would have written (InboundEvent.hookId).
    if (ID.test(event.hookId)) {
      await saveHook(ctx, { inboundHookId: event.hookId, serviceHookId: p.hookId, staleInboundHookIds: [], registeredAt: null });
    }
  } else if (p.hookId !== state.serviceHookId) {
    return { deliver: false, reason: "signed, but for a registration this mount no longer uses" };
  }
  return {
    deliver: true,
    text: reminderText({ reminderId: r.id, scheduledAt: isoOrNull(p.scheduledAt), note: r.notes || r.title }),
    // The runtime drops a repeat of this key within INBOUND_DEDUPE_MS, which covers RETRY_HORIZON_MS: the plugin's whole dedupe.
    dedupeKey: p.firingId,
  };
}

// ---- the plugin

export function createReminderPlugin(deps: { service?: ReminderService; now?: () => number } & Partial<ReminderDeployment> = {}): Plugin {
  const service = deps.service ?? httpReminderService();
  const now = deps.now ?? Date.now;
  const deployment: ReminderDeployment = { serviceUrl: deps.serviceUrl || null, clientCredential: deps.clientCredential || null };
  return {
    id: "reminder",
    version: "1.0.0",
    // An owner may add and remove a mount from the console: its one setting is a timeout, and removing it runs
    // `unmount`, which deletes the registration and every reminder that names it.
    consoleMount: true,
    /** This mount's registration: whether it exists is listable, what it holds is not. */
    database: { version: 1, stores: { [HOOK_STORE]: { listed: [HOOK_KEY] } } },
    config: [
      { name: "timeoutMs", type: "number", default: DEFAULT_TIMEOUT_MS, min: 1_000, max: 60_000, summary: "How long one request to reminder-app may take, in milliseconds." },
    ],
    tools: TOOLS,

    async invoke(tool, raw, ctx): Promise<Json> {
      if (tool === "create") {
        const a = args(raw, ["at", "delayMinutes", "note"], tool);
        const note = typeof a.note === "string" ? a.note.trim() : "";
        if (!note) throw new Error("note is required: write what the reminder should tell you");
        if (note.length > NOTE_MAX) throw new Error(`note has ${note.length} characters; the limit is ${NOTE_MAX}`);
        const { due, schedule } = dueTime(a, now());
        const conn = connection(ctx, deployment);
        // One key for the whole call, retry included: a create refused with unknown_hook does not use up its key.
        const requestId = await requestIdOf(ctx.operationId);
        const title = oneLine(note.split(/\r?\n/)[0], TITLE_MAX) || "Reminder";
        const make = async (hookId: string) => service.create(conn, { requestId, title, notes: note, schedule, target: { kind: "webhook", hookId } });
        let made: ServiceReminder;
        try {
          try { made = await make(await ensureRegistered(ctx, service, conn)); }
          catch (e) {
            if (!(e instanceof ReminderServiceError) || e.code !== "unknown_hook") throw e;
            // reminder-app lost the registration: register again, once, and make the reminder against that.
            await forgetRegistration(ctx);
            made = await make(await ensureRegistered(ctx, service, conn));
          }
        } catch (e) { throw forModel(e); }
        return { id: made.id, dueAt: isoOf(made.nextAt) ?? new Date(due).toISOString(), note };
      }
      if (tool === "list") {
        const a = args(raw, ["limit", "offset"], tool);
        const limit = a.limit === undefined ? LIST_DEFAULT : a.limit;
        const offset = a.offset === undefined ? 0 : a.offset;
        if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIST_MAX) throw new Error(`limit must be a whole number from 1 to ${LIST_MAX}`);
        if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw new Error("offset must be a whole number, 0 or more");
        const state = await loadHook(ctx);
        if (!state.serviceHookId) return { reminders: [], total: 0, nextOffset: null };
        let all: ServiceReminder[];
        const conn = connection(ctx, deployment);
        try { all = await service.list(conn); } catch (e) { throw forModel(e); }
        // reminder-app answers with every hook's reminders of this agent; a mount shows those that target its own.
        const mine = all.filter((r) => ownedBy(r, state.serviceHookId!) && r.status === "active")
          .sort((x, y) => (x.nextAt ?? Infinity) - (y.nextAt ?? Infinity));
        const page = mine.slice(offset, offset + limit);
        return { reminders: page.map(shown), total: mine.length, nextOffset: offset + page.length < mine.length ? offset + page.length : null };
      }
      if (tool === "delete") {
        const a = args(raw, ["id"], tool);
        const id = a.id;
        if (typeof id !== "string" || !ID.test(id)) throw new Error("id must be a reminder id, as create or list gave it");
        const state = await loadHook(ctx);
        const notMine = new Error(`this mount has no pending reminder ${id}; list shows the ones it can cancel`);
        if (!state.serviceHookId) throw notMine;
        const conn = connection(ctx, deployment);
        // reminder-app has no read of one reminder for this caller; its list is what says which hook one targets.
        let found: ServiceReminder | undefined;
        try { found = (await service.list(conn)).find((r) => r.id === id); } catch (e) { throw forModel(e); }
        // Another mount's reminder reads the same as none: this mount cannot touch it.
        if (!found || !ownedBy(found, state.serviceHookId)) throw notMine;
        let cancelled: ServiceReminder | null;
        try { cancelled = await service.cancel(conn, id); } catch (e) { throw forModel(e); }
        return cancelled ? { deleted: id } : { deleted: null, note: `reminder ${id} had already fired or been cancelled` };
      }
      throw new Error(`unknown reminder tool: ${tool}`);
    },

    receive: (event, secret, ctx) => receiveFire(event, secret, ctx, now()),

    /**
     * The mount is being removed: delete its registration with `cascade: "cancel"`, so reminder-app cancels every
     * reminder and pending firing that names it in the same step and none is left that could only fail; then revoke
     * the mount's inbound hooks (the runtime revokes any left after this too). Safe to run twice: a registration
     * reminder-app no longer knows is one already deleted, and the record is cleared once it is. A failure throws,
     * and the runtime shows it to whoever removed the mount and removes it anyway. Cleanup only: nothing here
     * wakes the agent.
     */
    async unmount(ctx) {
      const state = await loadHook(ctx);
      if (state.serviceHookId) {
        const conn = connection(ctx, deployment);
        try { await service.unregister(conn, state.serviceHookId); }
        catch (e) {
          if (!(e instanceof ReminderServiceError) || e.code !== "unknown_hook") throw forModel(e);
        }
        await saveHook(ctx, { ...state, serviceHookId: null });
      }
      const ids = [...new Set([state.inboundHookId, ...state.staleInboundHookIds].filter((x): x is string => x !== null))];
      const left = await revokeAll(ctx, ids);
      await saveHook(ctx, { inboundHookId: null, serviceHookId: null, staleInboundHookIds: left, registeredAt: null });
      logEvent("reminder.unmount", { tenantId: ctx.caller.tenantId, agentId: ctx.caller.agentId, mount: ctx.alias, unregistered: !!state.serviceHookId, revokeFailed: left.length });
    },
  };
}

/**
 * The plugin with no deployment behind it: every call refuses with {@link NO_CREDENTIAL}. For readers that need the
 * declaration only (the settings checks, the contract page); the runtime builds its own with the Worker's values.
 */
export const reminderPlugin: Plugin = createReminderPlugin();
