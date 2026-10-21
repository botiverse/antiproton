/**
 * A personal assistant's contact rules (src/plugins/raft-assistant.ts): what the owner said about when to be told, kept
 * as data and applied in code, so the model never promises a setting no code holds.
 *
 * A rule has one effect and one subject:
 * - `mute`: never tell them; `always`: tell them even where the defaults would not; `digest`: only in the morning brief.
 * - the subject is a channel or a thread (by Raft's channelId, never its name), a person (by their Raft id, never their
 *   name), a kind of item, or the owner's DMs as a whole. The names a rule keeps are for the owner's eyes only: the
 *   confirmation, the list, and the model's input. No trace row or log line carries one (`rulesAttrs`).
 *
 * Which rule applies (`winningRule`): the most specific subject that matches, thread > person > channel = DMs > kind,
 * and at equal specificity the newer rule (the owner's latest sentence). Facts beat every rule: what the owner was
 * already told or a check already looked at is dropped before any rule is asked (the callers do that first).
 *
 * A channel or thread rule is about its general chat: an @mention of the owner there still comes (`matches`), and a DM is
 * never in a channel. To silence a person's @mentions and DMs too, the owner mutes the person.
 *
 * Quiet hours (`ContactSettings.quiet`, owner-local, 22:00-08:00 unless they set others or turned them off) hold
 * everything for the brief, `always` included, unless the rule says `anytime` (the owner said "even at night").
 *
 * What code cannot apply yet, for want of a Raft field, is applied by the model from the rule list in its input:
 * a person rule, until inbox rows carry the sender's id (`SENDER_ID_FIELD`, `PEER_FIELD`), counted on each wake row as
 * `person_rule_unenforced`.
 */
import type { Json } from "../core/types.ts";
import type { PluginContext } from "./types.ts";

/** What an item is waiting on the owner for; `decided` is a decision others made, which only the brief carries. */
export const ITEM_KINDS = ["question", "review", "decision", "task", "mention", "decided"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const EFFECTS = ["mute", "always", "digest"] as const;
export type Effect = (typeof EFFECTS)[number];

/**
 * The inbox row fields a person rule is matched by, once Raft sends them (Raft's owner-inbox fields; not in SDK 0.25.0):
 * the latest message's sender id with `latestSenderType` (`user`, `agent` or `system`), and on a DM row or a DM's thread
 * row (`channelType` "dm") the other person as `peer: { id, type }`. Feature-detected per read: while no row carries
 * them, a person rule is the model's to apply. A `system` sender is no person: its id matches no rule.
 */
export const SENDER_ID_FIELD = "latestSenderId";
export const SENDER_TYPE_FIELD = "latestSenderType";
export const PEER_FIELD = "peer";

/** Raft's account type as a person subject's: `user` is a human; `system` (and anything else) is no person. */
export function personType(v: unknown): "human" | "agent" | null {
  return v === "user" || v === "human" ? "human" : v === "agent" ? "agent" : null;
}

export type Subject =
  /** `name` is the channel's name as the owner said it, lowercased without `#`: for display only. `id` null: a rule kept from before ids, bound at the next wake. */
  | { kind: "channel"; id: string | null; name: string }
  /** A thread by its own channelId; `ref` (`#channel:msgid` of its first message) for display only. */
  | { kind: "thread"; id: string; channelId: string | null; ref: string }
  /** A person by their Raft id; `name` for display only. `id` null until Raft gives an id to resolve the name to. */
  | { kind: "person"; id: string | null; type: "human" | "agent" | null; name: string }
  | { kind: "kind"; value: ItemKind }
  /** Every DM to the owner. */
  | { kind: "dms" }
  /** A rule kept from before subjects that named several things at once: all of them must match, by name, as it always did. */
  | { kind: "legacy"; channel: string | null; sender: string | null; itemKind: ItemKind | null };

export interface ContactRule {
  id: string;
  effect: Effect;
  subject: Subject;
  /** `always` only: also during quiet hours. */
  anytime: boolean;
  /** ISO: the rule ends then; an expired rule is ignored, and dropped at the next write. */
  until: string | null;
  note: string | null;
  /** ISO; null for a rule kept from before, which is older than any with a time. */
  createdAt: string | null;
}

export const RULES_MAX = 50;
const UNTIL_MAX_MS = 90 * 24 * 3_600_000;

/** How specific a subject is: the higher wins. */
const SPECIFICITY: Record<Subject["kind"], number> = { thread: 4, person: 3, channel: 2, dms: 2, legacy: 2, kind: 1 };

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const idNumber = (id: string) => Number(id.slice(1)) || 0;

function subjectOf(raw: unknown): Subject | null {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!s) return null;
  if (s.kind === "channel" && typeof s.name === "string") return { kind: "channel", id: str(s.id), name: s.name };
  if (s.kind === "thread" && typeof s.id === "string" && typeof s.ref === "string") return { kind: "thread", id: s.id, channelId: str(s.channelId), ref: s.ref };
  if (s.kind === "person" && typeof s.name === "string") {
    return { kind: "person", id: str(s.id), type: s.type === "human" || s.type === "agent" ? s.type : null, name: s.name };
  }
  if (s.kind === "kind") { const k = ITEM_KINDS.find((x) => x === s.value); return k ? { kind: "kind", value: k } : null; }
  if (s.kind === "dms") return { kind: "dms" };
  if (s.kind === "legacy") {
    const k = ITEM_KINDS.find((x) => x === s.itemKind) ?? null;
    return { kind: "legacy", channel: str(s.channel), sender: str(s.sender), itemKind: k };
  }
  return null;
}

/**
 * The rules as kept, every one read as this version's: a rule from before effects and subjects (`{id, channel, sender,
 * kind, note}`, mute-only) becomes a mute of the one thing it named, with its id kept (a channel's id is unknown, and is
 * bound at the next wake: `bindChannels`); one that named several is kept as it was (`legacy`). Nothing is written here.
 */
export function rulesOf(raw: unknown): ContactRule[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r): ContactRule[] => {
    const o = r && typeof r === "object" && !Array.isArray(r) ? r as Record<string, unknown> : null;
    if (!o || typeof o.id !== "string" || !o.id) return [];
    const note = str(o.note);
    if (EFFECTS.includes(o.effect as Effect)) {
      const subject = subjectOf(o.subject);
      if (!subject) return [];
      return [{
        id: o.id, effect: o.effect as Effect, subject, anytime: o.anytime === true && o.effect === "always",
        until: str(o.until) && Number.isFinite(Date.parse(o.until as string)) ? o.until as string : null, note, createdAt: str(o.createdAt),
      }];
    }
    const channel = str(o.channel), sender = str(o.sender), kind = ITEM_KINDS.find((k) => k === o.kind) ?? null;
    const named = [channel, sender, kind].filter((x) => x !== null).length;
    if (!named) return [];
    const subject: Subject = named > 1 ? { kind: "legacy", channel, sender, itemKind: kind }
      : channel !== null ? { kind: "channel", id: null, name: channel }
      : sender !== null ? { kind: "person", id: null, type: null, name: sender }
      : { kind: "kind", value: kind! };
    return [{ id: o.id, effect: "mute", subject, anytime: false, until: null, note, createdAt: null }];
  });
}

export const isActive = (r: ContactRule, now: number) => r.until === null || Date.parse(r.until) > now;

/**
 * What a rule is held against: an inbox row, or an item with the row it came from. `senderId` is undefined when Raft sent
 * no sender id at all (then no person rule can match in code), null when it sent none for this row. `kind` and the names
 * are an item's, for kind and legacy rules; a row has none.
 */
export interface Target {
  channelId: string | null; parentChannelId: string | null; thread: boolean; dm: boolean; mention: boolean;
  senderId?: string | null; kind?: ItemKind; channelName?: string | null; senderName?: string | null;
}

export function matches(rule: ContactRule, t: Target): boolean {
  const s = rule.subject;
  // A channel's or a thread's rule is about its general chat: an @mention of the owner there is not covered, unless the
  // rule asks for more, not less.
  const chatOnly = rule.effect !== "always" && t.mention;
  switch (s.kind) {
    case "channel": return s.id !== null && !t.dm && !chatOnly && (t.channelId === s.id || t.parentChannelId === s.id);
    case "thread": return t.thread && !chatOnly && t.channelId === s.id;
    case "person": return s.id !== null && typeof t.senderId === "string" && t.senderId === s.id;
    case "kind": return t.kind !== undefined && t.kind === s.value;
    case "dms": return t.dm;
    case "legacy":
      return t.kind !== undefined && (s.channel === null || s.channel === t.channelName) && (s.sender === null || s.sender === t.senderName) &&
        (s.itemKind === null || s.itemKind === t.kind);
  }
}

/** The rule that decides for `t`, or null: the most specific active one that matches, the newer on a tie. */
export function winningRule(rules: readonly ContactRule[], t: Target, now: number): ContactRule | null {
  let best: ContactRule | null = null;
  for (const r of rules) {
    if (!isActive(r, now) || !matches(r, t)) continue;
    if (!best || newerOrMoreSpecific(r, best)) best = r;
  }
  return best;
}

function newerOrMoreSpecific(a: ContactRule, b: ContactRule): boolean {
  const d = SPECIFICITY[a.subject.kind] - SPECIFICITY[b.subject.kind];
  if (d !== 0) return d > 0;
  const ta = a.createdAt ? Date.parse(a.createdAt) : -Infinity, tb = b.createdAt ? Date.parse(b.createdAt) : -Infinity;
  if (ta !== tb) return ta > tb;
  return idNumber(a.id) > idNumber(b.id);
}

/** Whether code can apply a person rule on these rows: the rule has an id, and some row carries a sender id to hold it to. */
export function personRulesUnenforced(rules: readonly ContactRule[], rowsCarryIds: boolean, now: number): number {
  return rules.filter((r) => isActive(r, now) && r.subject.kind === "person" && (r.subject.id === null || !rowsCarryIds)).length;
}

// ---- quiet hours -----------------------------------------------------------------------------------------------------

export const CONTACT_KEY = "contact";
export interface QuietHours { from: string; to: string }
export interface ContactSettings { quiet: QuietHours | null }
export const DEFAULT_QUIET: QuietHours = { from: "22:00", to: "08:00" };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function contactOf(raw: unknown): ContactSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  if (!o || !("quiet" in o)) return { quiet: DEFAULT_QUIET };
  if (o.quiet === null) return { quiet: null };
  const q = o.quiet && typeof o.quiet === "object" ? o.quiet as Record<string, unknown> : {};
  return typeof q.from === "string" && typeof q.to === "string" && HHMM.test(q.from) && HHMM.test(q.to) && q.from !== q.to
    ? { quiet: { from: q.from, to: q.to } } : { quiet: DEFAULT_QUIET };
}

export async function loadContact(ctx: PluginContext, store: string): Promise<ContactSettings> {
  return contactOf(await ctx.db.get(store, CONTACT_KEY));
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether an owner-local wall time (hours, minutes) is within quiet hours; `from` included, `to` excluded. */
export function inQuiet(h: number, min: number, quiet: QuietHours | null): boolean {
  if (!quiet) return false;
  const t = h * 60 + min, from = minutes(quiet.from), to = minutes(quiet.to);
  return from < to ? t >= from && t < to : t >= from || t < to;
}

export const quietLine = (quiet: QuietHours | null, zone: string) => quiet ? `quiet ${quiet.from}-${quiet.to} ${zone}` : `no quiet hours (${zone})`;

// ---- what the owner reads ----------------------------------------------------------------------------------------------

const KIND_WORDS: Record<ItemKind, string> = {
  question: "questions", review: "review requests", decision: "decisions asked of you", task: "tasks assigned to you",
  mention: "@mentions", decided: "decisions others made",
};

/** A subject as the owner reads it. */
export function subjectWords(s: Subject): string {
  switch (s.kind) {
    case "channel": return `#${s.name}`;
    case "thread": return `the thread ${s.ref}`;
    case "person": return `@${s.name}`;
    case "kind": return KIND_WORDS[s.value];
    case "dms": return "your DMs";
    case "legacy": return [s.channel && `#${s.channel}`, s.sender && `@${s.sender}`, s.itemKind && KIND_WORDS[s.itemKind]].filter(Boolean).join(" + ");
  }
}

function untilWords(until: string | null, zone: string): string {
  if (!until) return "";
  const d = new Date(Date.parse(until));
  const at = new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  return ` until ${at}`;
}

/** One rule as a plain line for `list`: `r2 · always @ana (not at night)`. */
export function ruleLine(r: ContactRule, zone: string): string {
  const s = r.subject;
  const what = s.kind === "kind" ? `kind ${s.value}` : subjectWords(s);
  const notes = [
    (s.kind === "channel" || s.kind === "thread") && r.effect !== "always" ? "chat only; @mentions still come" : null,
    r.effect === "always" ? (r.anytime ? "any time" : "not at night") : null,
    s.kind === "legacy" ? "an older rule; say it again to replace it" : null,
  ].filter(Boolean);
  return `${r.id} · ${r.effect} ${what}${notes.length ? ` (${notes.join("; ")})` : ""}${untilWords(r.until, zone)}`;
}

/** The one line confirming a stored rule, written from the rule itself, so it is always true of what was stored. */
export function confirmLine(r: ContactRule, o: { zone: string; quiet: QuietHours | null }): string {
  const s = r.subject;
  const until = r.until ? `,${untilWords(r.until, o.zone)}` : "";
  const night = o.quiet ? ` except during your quiet hours (${o.quiet.from}-${o.quiet.to}); say "even at night" to change that` : "";
  if (r.effect === "mute") {
    if (s.kind === "channel" || s.kind === "thread") return `General chat in ${subjectWords(s)} won't notify you anymore${until}; @mentions of you still will.`;
    if (s.kind === "person") return `Nothing from @${s.name} will notify you anymore${until}, @mentions and DMs included.`;
    return `I won't tell you about ${subjectWords(s)} anymore${until}.`;
  }
  if (r.effect === "digest") {
    if (s.kind === "channel" || s.kind === "thread") return `General chat in ${subjectWords(s)} goes in your morning brief only${until}; @mentions of you still come right away.`;
    return `${capital(subjectWords(s))} go${s.kind === "person" ? "es" : ""} in your morning brief only${until}.`;
  }
  return r.anytime ? `I'll tell you right away about ${subjectWords(s)}${until}, nights included.`
    : `I'll tell you right away about ${subjectWords(s)}${until},${night || " any time of day"}.`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const DEFAULTS_LINE = "By default you hear about @mentions of you, your DMs, a question or decision waiting on you, a task assigned to you, " +
  "and someone asking you in a thread you are in; not general channel chat, talk between others, or what you already dealt with.";

/**
 * The rules code cannot apply on these rows, said to the model in the check's input so it applies them: person rules
 * (no sender id yet). Empty when there are none.
 */
export function modelRulesLine(rules: readonly ContactRule[], rowsCarryIds: boolean, now: number): string {
  const left = rules.filter((r) => isActive(r, now) && r.subject.kind === "person" && (r.subject.id === null || !rowsCarryIds));
  if (!left.length) return "";
  const said = left.map((r) => {
    const who = subjectWords(r.subject);
    return r.effect === "mute" ? `leave out anything from ${who}` : r.effect === "digest" ? `${who}'s items only in the morning brief: leave them out of this check unless it is the brief`
      : `include anything from ${who} that asks something of your owner`;
  });
  return `Your owner's rules about people, which code cannot apply yet, so you do: ${said.join("; ")}.`;
}

// ---- the trace -----------------------------------------------------------------------------------------------------------

/** The rules as the trace counts them: per effect and subject kind, never a name, an id or a note. */
export function rulesAttrs(rules: readonly ContactRule[], now: number): Record<string, number> {
  const out: Record<string, number> = { rules_total: 0 };
  for (const r of rules) {
    if (!isActive(r, now)) continue;
    out.rules_total++;
    const k = `${r.effect}_${r.subject.kind}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** The rules written back, with expired ones dropped. */
export function keptRules(rules: readonly ContactRule[], now: number): Json {
  return rules.filter((r) => isActive(r, now)) as unknown as Json;
}

/** `until` as the tool takes it: an ISO time in the future, at most 90 days out; null when absent; a string when refused. */
export function untilOf(v: unknown, now: number): string | null | { refused: string } {
  if (v === undefined || v === null || v === "") return null;
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) return { refused: "until must be an ISO time" };
  if (t <= now) return { refused: "until is not in the future" };
  if (t - now > UNTIL_MAX_MS) return { refused: "until is more than 90 days away: omit it for a lasting rule" };
  return new Date(t).toISOString();
}

export const QUIET_FORMAT = HHMM;
