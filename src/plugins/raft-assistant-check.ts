/**
 * The check as Raft runs it (RFC 077 step 2): what a doorbell or a morning brief carries when Raft has decided what of
 * the owner's inbox is worth a look (`check`), read and held to its contract here, before anything of it reaches a
 * model. The mode is Raft's to state (`assistantOf.raftCheck`, src/plugins/raft-assistant.ts `keepOwnerFromContext`);
 * whether a wake carries a check only decides what that one wake posts.
 *
 * - `instruction` is the check turn's input, verbatim, at most `CHECK_INSTRUCTION_MAX_UTF8` as posted; a longer one is refused,
 *   never cut, since a cut instruction is one Raft did not write. Tools are named in it by logical name only, as
 *   `{{tool:<name>}}`, and replaced here by the mount's model tool names (`substituteTools`): a placeholder for a tool
 *   the session is not offered is removed, so the text never names a tool the model cannot call (#1014), and one this
 *   build does not know is left as written and counted.
 * - `allowed_tools`, logical names too, can only narrow what a check is offered (`CHECK_TOOLS`): it is intersected with
 *   that list in code (`checkTools`), and a name outside it, a send-as-owner or a messages send included, is dropped and
 *   counted (`tools_dropped`). The runtime offers the short session the result and nothing more (`PluginNext.tools`).
 * - `id` goes with the session as its turn key (`checkTurnKey`), so the notify call that session makes names its check
 *   (`check_id`) without the model ever being given it, and so does its idempotency key (`notifyIdempotencyKey`).
 * - `items` (what Raft found, by channelId) is the instruction's business, not this file's: Raft confirms the notify
 *   call's items against its own record of the check.
 *
 * Compiled by both typecheck programs.
 */
import { createHash } from "node:crypto";
import { modelToolName } from "../runtime/pi-tools.ts";

/** The `check` contract version this build reads; any other is refused (`version`). */
export const CHECK_VERSION = 1;
/**
 * The longest turn input a check posts, in UTF-8 bytes, counted on the text as posted (after the tool names are put
 * in), since Raft's bound is 16 KB on the wire. Named `…Utf8`, not `…Bytes`: AGENTS.md keeps `…Bytes` for `String.length`.
 */
export const CHECK_INSTRUCTION_MAX_UTF8 = 16 * 1024;
/**
 * The longest `instruction` kept as it arrives, as `String.length`: far past the cap, so nothing the cap would take is
 * refused here, only what is plainly not a check's input, before it is stored.
 */
const INSTRUCTION_KEPT_MAX = 4 * CHECK_INSTRUCTION_MAX_UTF8;

/** `text`'s length in UTF-8 bytes. */
export function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** The logical tool names Raft uses, and the bare name of each on an assistant's raft mount. */
export const LOGICAL_TOOLS: Readonly<Record<string, string>> = {
  notify: "assistant_notify_owner",
  owner_inbox: "assistant_owner_inbox",
  owner_messages: "assistant_owner_messages",
};

/**
 * `check.counts`' keys, all numbers: the only ones put on a trace row, so the trace forwarder can list them. One list,
 * to be kept in step with Raft's (any other key Raft sends is left off the row, never an error).
 */
export const CHECK_COUNT_KEYS: readonly string[] = [
  "conversations", "items", "truncated", "told", "skipped", "muted", "digest", "always", "dm", "mention", "thread", "named", "default_out", "night_held", "behind",
];

export type CheckTrigger = "doorbell" | "brief";

/** A check this build will post. */
export interface RaftCheck {
  id: string;
  trigger: CheckTrigger;
  instruction: string;
  /** Logical names as Raft sent them, or null when it sent none (then the check's whole list, as before). */
  allowedTools: string[] | null;
  counts: Record<string, number>;
}

/** Why a check is not posted, and what of it could be read, for its trace row. Never its text. */
export interface RefusedCheck {
  refused: "malformed" | "version" | "instruction_too_large";
  id: string | null;
  trigger: CheckTrigger | null;
  /** `instruction`'s UTF-8 length, for `instruction_too_large`. */
  instructionBytes?: number;
}

const CHECK_ID = /^[0-9A-Za-z][0-9A-Za-z-]{0,63}$/;

/**
 * A payload's `check`: null when it carries none, a `RaftCheck` when this build can post it, else what refused it.
 * The id and trigger are kept on a refusal when they can be read, so its trace row still names the check.
 */
export function checkOf(raw: unknown): RaftCheck | RefusedCheck | null {
  if (raw === undefined || raw === null) return null;
  const o = typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const id = typeof o.id === "string" && CHECK_ID.test(o.id) ? o.id : null;
  const trigger = o.trigger === "doorbell" || o.trigger === "brief" ? o.trigger : null;
  if (o.version !== CHECK_VERSION) return { refused: o.version === undefined ? "malformed" : "version", id, trigger };
  if (!id || !trigger || typeof o.instruction !== "string" || !o.instruction.trim()) return { refused: "malformed", id, trigger };
  if (o.instruction.length > INSTRUCTION_KEPT_MAX) return { refused: "instruction_too_large", id, trigger, instructionBytes: utf8Length(o.instruction) };
  if (o.allowed_tools !== undefined && o.allowed_tools !== null && !Array.isArray(o.allowed_tools)) return { refused: "malformed", id, trigger };
  const allowedTools = Array.isArray(o.allowed_tools) ? o.allowed_tools.map((t) => (typeof t === "string" ? t : "")) : null;
  const c = o.counts && typeof o.counts === "object" && !Array.isArray(o.counts) ? o.counts as Record<string, unknown> : {};
  const counts: Record<string, number> = {};
  for (const k of CHECK_COUNT_KEYS) {
    const v = c[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) counts[k] = Math.floor(v);
  }
  return { id, trigger, instruction: o.instruction, allowedTools, counts };
}

/**
 * The bare tool names a check may be offered: Raft's `allowed_tools` mapped to the mount's names and intersected with
 * `ceiling` (`CHECK_TOOLS`), in the ceiling's order. A name that is not a logical one, or maps outside the ceiling, is
 * dropped and counted: Raft can narrow the list, never widen it. No list at all is the whole ceiling.
 */
export function checkTools(allowed: readonly string[] | null, ceiling: readonly string[]): { tools: string[]; dropped: number } {
  if (allowed === null) return { tools: [...ceiling], dropped: 0 };
  const asked = new Set<string>();
  let dropped = 0;
  for (const name of allowed) {
    const bare = Object.prototype.hasOwnProperty.call(LOGICAL_TOOLS, name) ? LOGICAL_TOOLS[name]! : null;
    if (bare === null || !ceiling.includes(bare)) { dropped++; continue; }
    asked.add(bare);
  }
  return { tools: ceiling.filter((t) => asked.has(t)), dropped };
}

const PLACEHOLDER = /\{\{tool:([^{}]*)\}\}/g;

/**
 * `instruction` with each `{{tool:<logical>}}` replaced by the model's name for that tool on `alias`, when the session
 * is offered it (`offered`, bare names); removed when it is a tool this build knows that the session is not offered
 * (`unoffered`); left as written, and counted, when this build knows no such logical name (`unknown`).
 */
export function substituteTools(instruction: string, alias: string, offered: readonly string[]): { text: string; unknown: number; unoffered: number } {
  let unknown = 0, unoffered = 0;
  const text = instruction.replace(PLACEHOLDER, (whole, name: string) => {
    const bare = Object.prototype.hasOwnProperty.call(LOGICAL_TOOLS, name.trim()) ? LOGICAL_TOOLS[name.trim()]! : null;
    if (bare === null) { unknown++; return whole; }
    if (!offered.includes(bare)) { unoffered++; return ""; }
    return modelToolName(alias, bare);
  });
  return { text, unknown, unoffered };
}

const TURN_KEY_PREFIX = "assistant.raft_check:";

/** The short session's key for a check: its trigger and id, handed back on every call the session makes (`caller.turnKey`). */
export function checkTurnKey(check: Pick<RaftCheck, "id" | "trigger">): string {
  return `${TURN_KEY_PREFIX}${check.trigger}:${check.id}`;
}

/** The check a short session's key names, or null for any other key (a check of this mount's own, the chat, none). */
export function checkOfTurnKey(key: unknown): { id: string; trigger: CheckTrigger } | null {
  if (typeof key !== "string" || !key.startsWith(TURN_KEY_PREFIX)) return null;
  const [trigger, id] = key.slice(TURN_KEY_PREFIX.length).split(":");
  return (trigger === "doorbell" || trigger === "brief") && id && CHECK_ID.test(id) ? { id, trigger } : null;
}

/**
 * The idempotency key of one forwarded notify: the check and its items, in an order that does not depend on the
 * model's, so the same call made again (a retry, a step run twice) is the same request and Raft sends one DM.
 */
export function notifyIdempotencyKey(checkId: string, items: ReadonlyArray<{ channelId: string; summary: string; kind?: string }>): string {
  const canon = items.map((i) => JSON.stringify([i.channelId, i.summary, i.kind ?? null])).sort();
  return `assistant-notify-${createHash("sha256").update(JSON.stringify([checkId, ...canon])).digest("hex").slice(0, 32)}`;
}
