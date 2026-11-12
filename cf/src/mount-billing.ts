/**
 * Asking every mount what it holds, for usage: the console's question with a billing answer's obligations.
 *
 * The console asks `#mountReports` (cf/src/index.ts) and is handed only the mounts that have something to say; a
 * mount whose call throws is left out so one bad mount cannot blank the panel. Usage used to read that same map,
 * and there the leaving-out was the bug: a mount that could not answer named no boxes, so after a week its live
 * box's watermark (src/usage/container.ts `usage_held`) was pruned, and the next answer billed it again from its
 * start (Ward, 2026-11-06). Here every mount whose plugin reports holdings is asked, a failure is named rather
 * than dropped, and the watermarks are pruned only when every mount answered AND said its record was complete.
 *
 * The per-mount call (`askMount`) is shared with the console's map, so the two cannot ask differently; the
 * console's map keeps its shape (`consoleMountReports`) because the page parses it (cf/src/ui.ts asMountReports).
 */
import type { MountActivity, MountUsage, UnreadableKinds } from "../../src/plugins/types.ts";
import { asActivity, worthReporting, type MountReports } from "./mount-reports.ts";
import { countHeldPass, heldReports } from "../../src/usage/container.ts";
import { logEvent, type LogFields } from "../../src/core/log.ts";
import type { SqlHost } from "../../src/store/pi-storage.ts";

type Sql = SqlHost["sql"];
type Ask = { tenantId: string; agentId: string; taskId: string };
type MountRow = { alias: string; plugin: string; secretRef: string | null };

/** What of the gateway (src/runtime/gateway.ts ToolGateway) is asked here. */
export interface ReportingGateway {
  mountActivity(ctx: Ask, alias: string): Promise<MountActivity>;
  mountActivities(ctx: Ask, alias: string): Promise<MountActivity[]>;
  mountUsage(ctx: Ask, alias: string): Promise<MountUsage[]>;
  declaresHolding(plugin: string): boolean;
}

/**
 * How many passes in a row one mount may block the prune before a person is asked to look. Five passes is a few
 * alarms on a busy agent and longer on a quiet one; it is a "this is not a blip" threshold, not a deadline (the
 * watermarks are kept, so nothing is lost while a mount waits — only the table grows). Agreed in #plugins (11-12).
 */
export const ESCALATE_AFTER_PASSES = 5;

/** One mount's own report, the call the console and usage share. */
export async function askMount(gw: Pick<ReportingGateway, "mountActivity" | "mountUsage">, ctx: Ask, alias: string) {
  const [activity, usage] = await Promise.all([gw.mountActivity(ctx, alias), gw.mountUsage(ctx, alias)]);
  return { activity, usage };
}

/** The console's map (`#mountReports`): mounts with something to say, and a mount that cannot answer left out. */
export async function consoleMountReports(
  gw: Pick<ReportingGateway, "mountActivity" | "mountUsage">, ctx: Ask, mounts: readonly MountRow[],
): Promise<MountReports> {
  const out: MountReports = {};
  for (const m of mounts) {
    try {
      const { activity, usage } = await askMount(gw, ctx, m.alias);
      // Kept only when the report says something (worthReporting, shared with
      // diagnose-read so the two surfaces cannot drift); an empty report
      // would defeat the page's own emptiness check.
      if (worthReporting(activity, usage)) out[m.alias] = { activity, usage };
    } catch {
      // One mount that cannot answer must not blank the panel for the rest.
    }
  }
  return out;
}

/**
 * What kinds of entry made a mount's record unreadable (`MountActivity.unreadableKinds`), as the log reads it. First
 * whether it was sent (the key absent is "not sent"), then whether it was sent well: a present value is either the
 * contract's `{unknown: boolean, machines: finite number, other: finite number}` or a violation — `null`, a string, a
 * number, an array, or an object with other keys or types — and a violation is never read as zero. Never throws.
 * Read for the log only: the prune is decided by `complete` and by answering, never by any of these counts (`other`
 * in particular is a bad session or environment row, which costs no container time).
 */
type SentKinds = { sent: false } | { sent: true; valid: UnreadableKinds | null; raw: unknown };
function readKinds(activity: unknown): SentKinds {
  const v = (activity as { unreadableKinds?: unknown }).unreadableKinds;
  if (v === undefined) return { sent: false };
  const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o.unknown === "boolean" && num(o.machines) && num(o.other)) {
      return { sent: true, valid: { unknown: o.unknown, machines: o.machines, other: o.other }, raw: v };
    }
  }
  return { sent: true, valid: null, raw: v };
}

export type KindsViolation = "unrecognised_shape" | "incomplete_without_kinds" | "kinds_without_count";

/** What a violation's log line says about the value that arrived: its type ("null"/"array" spelled out), its keys, a fragment of a string. */
function describeReceived(v: unknown): LogFields {
  const receivedType = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  return {
    receivedType,
    ...(receivedType === "object" ? { keys: Object.keys(v as object).sort().join(",").slice(0, 200) } : {}),
    ...(typeof v === "string" ? { sampleFragment: v.slice(0, 60) } : {}),
  };
}

export interface BillingReports {
  /** Every mount that answered, in the console's shape (`activity` is the mount's one summary). */
  reports: MountReports;
  /** The aliases asked that did not answer: the call threw, or what came back does not read. */
  unanswered: string[];
  /** The aliases asked: every listed mount whose plugin reports holdings. */
  declared: string[];
  /** Each answered mount's things one by one (`Holding.activities`): what usage counts, not the summary. */
  machines: Record<string, MountActivity[]>;
  /** Each answered mount's `complete`, as it read (absent stays absent). */
  complete: Record<string, boolean | undefined>;
  /** Each answered mount's `unreadableKinds`, only where it sent a valid one with `unreadable > 0`. */
  unreadable: Record<string, UnreadableKinds>;
  /** Answered mounts with `unreadable > 0`: the denominator of `kindsMissing` (`kindsOf` on the pass line). */
  kindsOf: string[];
  /**
   * Answered mounts with `unreadable > 0` that sent no `unreadableKinds` (the key absent): an older producer, which
   * heals on its own. Nothing else is counted missing.
   */
  kindsMissing: string[];
  /** Answered mounts whose kinds break the producer's contract, each with why; never also in `kindsMissing`. */
  kindsViolation: Array<{ alias: string; reason: KindsViolation }>;
}

/**
 * Every mount usage has to hear from, each asked whatever it answered last time (no `worthReporting`: a mount
 * that holds nothing answering "nothing" is the answer that lets the prune run).
 */
export async function billingMountReports(gw: ReportingGateway, ctx: Ask, mounts: readonly MountRow[]): Promise<BillingReports> {
  const out: BillingReports = { reports: {}, unanswered: [], declared: [], machines: {}, complete: {}, unreadable: {}, kindsOf: [], kindsMissing: [], kindsViolation: [] };
  for (const m of mounts) {
    if (!gw.declaresHolding(m.plugin)) continue;
    out.declared.push(m.alias);
    try {
      const [{ activity, usage }, machines] = await Promise.all([askMount(gw, ctx, m.alias), gw.mountActivities(ctx, m.alias)]);
      const read = asActivity(activity);
      if (!read || !Array.isArray(usage) || !Array.isArray(machines) || machines.some((a) => asActivity(a) === null)) {
        out.unanswered.push(m.alias);
        logEvent("usage.mount_unanswered", { tenantId: ctx.tenantId, agentId: ctx.agentId, alias: m.alias, cause: "unreadable" });
        continue;
      }
      out.reports[m.alias] = { activity, usage };
      out.machines[m.alias] = machines;
      // The summary and the per-machine list are two reads (two gateway calls, each its own `get` of the record), not
      // one snapshot: if the record changes between them (a machine created or released), they can disagree. Of what
      // comes from the first read, only `complete` changes a decision (the prune); the kinds counts may lag a pass and
      // decide nothing. So the guard covers exactly one direction: an entry that says it did not read its record whole
      // makes the mount incomplete, whatever the summary said, because a prune on a wrong "complete" deletes a live
      // box's watermark (the 11-06 double bill) while one skipped waits a pass. The other directions need nothing:
      // a summary's false already blocks, and a box seen in only one read is still counted (`boxesOf` takes the union).
      // Why `some(=== false)` and not `every(=== true)`: an idle mount answers `activities: []`, which must let the
      // prune run, and a missing per-entry `complete` cannot occur in one read (the plugin computes it on every read).
      // Transitional: to be replaced by the single-read `Holding` change (Piper), which removes the window; that change
      // decides whether this guard stays as a second check.
      const entryIncomplete = machines.some((a) => asActivity(a)?.complete === false);
      if (entryIncomplete && read.complete !== false) {
        logEvent("usage.complete_disagree", { tenantId: ctx.tenantId, agentId: ctx.agentId, alias: m.alias, summary: String(read.complete) });
      }
      out.complete[m.alias] = entryIncomplete ? false : read.complete;
      const counted = (read.unreadable ?? 0) > 0;
      if (counted) out.kindsOf.push(m.alias);
      const kinds = readKinds(activity);
      // Exactly one bucket per mount: breakdown, missing, violation, or nothing (a clean report sends no kinds).
      let violation: KindsViolation | null = null;
      if (!kinds.sent) {
        if (counted) out.kindsMissing.push(m.alias);
        else if (read.complete === false) violation = "incomplete_without_kinds";
      } else if (!kinds.valid) violation = "unrecognised_shape";
      else if (!counted) violation = "kinds_without_count";
      else out.unreadable[m.alias] = kinds.valid;
      if (violation) {
        // kindsViolation is an alarm, not a metric: >0 means a producer broke the contract, not a trend.
        // receivedType string ⇒ usually serialisation/boundary; array ⇒ an extra wrapper.
        out.kindsViolation.push({ alias: m.alias, reason: violation });
        logEvent("usage.kinds_violation", {
          tenantId: ctx.tenantId, agentId: ctx.agentId, alias: m.alias, reason: violation,
          ...(kinds.sent ? describeReceived(kinds.raw) : { receivedType: "undefined" }),
        });
      }
    } catch (e) {
      // Named, never swallowed: this mount's boxes are simply not counted this pass (their watermarks stay, so the
      // next answer counts from where they stood), and the prune waits for it.
      out.unanswered.push(m.alias);
      logEvent("usage.mount_unanswered", {
        tenantId: ctx.tenantId, agentId: ctx.agentId, alias: m.alias, cause: "threw",
        errorName: String((e as Error)?.name ?? typeof e).slice(0, 200),
        error: String((e as Error)?.message ?? e).slice(0, 200),
      });
    }
  }
  return out;
}

export type Completeness = "complete" | "incomplete" | "complete_missing";

/**
 * A mount's `complete`, as one of three answers. Only `true` lets the prune run. Absent is its own case rather
 * than folded into either side: today no producer sends it, and a reader that took absence for `true` would prune
 * on a report that never claimed anything (`!== false`), while one that took it for `false` would hide which of
 * the two is happening from the log.
 */
export function completenessOf(c: boolean | undefined): Completeness {
  switch (c) {
    case true: return "complete";
    case false: return "incomplete";
    case undefined: return "complete_missing";
    default: {
      const unreachable: never = c;
      throw new Error(`complete is neither true, false nor absent: ${String(unreachable)}`);
    }
  }
}

export type Block = "unanswered" | Exclude<Completeness, "complete">;

/** Prune iff every declared mount answered and called itself complete; otherwise what each blocking mount said. */
export function pruneDecision(b: BillingReports): { prune: boolean; blocked: Record<string, Block> } {
  const blocked: Record<string, Block> = {};
  const unanswered = new Set(b.unanswered);
  for (const alias of b.declared) {
    if (unanswered.has(alias)) { blocked[alias] = "unanswered"; continue; }
    const c = completenessOf(b.complete[alias]);
    if (c !== "complete") blocked[alias] = c;
  }
  return { prune: Object.keys(blocked).length === 0, blocked };
}

const SKIPS = "CREATE TABLE IF NOT EXISTS usage_prune_skips(alias TEXT PRIMARY KEY, passes INTEGER NOT NULL)";

/**
 * Passes in a row each mount has blocked the prune, kept with the watermarks so a restarted object keeps counting.
 * A mount that answers complete starts again from nothing, and a mount no longer listed is forgotten.
 */
export function recordSkips(sql: Sql, declared: readonly string[], blocked: Record<string, Block>): Record<string, number> {
  sql.exec(SKIPS);
  const had = new Map<string, number>(sql.exec("SELECT alias, passes FROM usage_prune_skips").toArray()
    .map((r: any) => [String(r.alias), Number(r.passes)]));
  const passes: Record<string, number> = {};
  for (const alias of declared) {
    if (blocked[alias]) {
      passes[alias] = (had.get(alias) ?? 0) + 1;
      sql.exec("INSERT INTO usage_prune_skips(alias, passes) VALUES (?, ?) ON CONFLICT(alias) DO UPDATE SET passes = excluded.passes",
        alias, passes[alias]);
    } else if (had.has(alias)) sql.exec("DELETE FROM usage_prune_skips WHERE alias = ?", alias);
  }
  for (const alias of had.keys()) if (!declared.includes(alias)) sql.exec("DELETE FROM usage_prune_skips WHERE alias = ?", alias);
  return passes;
}

/** A log field's cap on a list of aliases; past it the line says how many were left out. */
const ALIASES_MAX = 200;
export function aliasList(aliases: readonly string[]): string {
  let out = "";
  for (let i = 0; i < aliases.length; i++) {
    const next = out ? `${out},${aliases[i]}` : aliases[i]!;
    if (next.length > ALIASES_MAX) return `${out}…(+${aliases.length - i} more)`;
    out = next;
  }
  return out;
}

export interface HeldPass {
  billing: BillingReports;
  prune: boolean;
  blocked: Record<string, Block>;
  passes: Record<string, number>;
  /** Watermarks old enough to prune and named by no report: deleted when `prune`, kept otherwise. */
  wouldDelete: number;
  deleted: number;
  lines: Array<{ key: string; rows: number }>;
  /** The one line this pass logged (`usage.held_pass`). */
  log: LogFields;
}

/**
 * One accounting pass over held time, as the agent object makes it (cf/src/index.ts `#countHeldTime`): ask every
 * mount, count what each answered mount holds machine by machine, prune only on a full and complete answer, and
 * log one line saying so. The caller of the billing function, so the "agents evaluated" count is taken here,
 * before anything that can throw, and a pass that fails still says it was evaluated.
 */
export async function runHeldPass(deps: {
  gw: ReportingGateway; sql: Sql; transaction: <T>(fn: () => T) => T;
  ctx: Ask; mounts: readonly MountRow[]; now?: number;
}): Promise<HeldPass> {
  const { tenantId, agentId } = deps.ctx;
  const log: LogFields = { tenantId, agentId, agentsEvaluated: 1, mounts: deps.mounts.length };
  try {
    const billing = await billingMountReports(deps.gw, deps.ctx, deps.mounts);
    // On the line as soon as known, so a pass that throws below says how far it got in the same shape.
    Object.assign(log, {
      declared: billing.declared.length,
      answered: billing.declared.length - billing.unanswered.length,
      unanswered: billing.unanswered.length,
    });
    const { prune, blocked } = pruneDecision(billing);
    // What `countHeldTime` reads: the console's report plus each thing on its own (`activities`).
    const reports: Record<string, unknown> = {};
    for (const [alias, r] of Object.entries(billing.reports)) reports[alias] = { ...r, activities: billing.machines[alias] };
    const counted = countHeldPass(deps.sql, heldReports(deps.mounts, reports), { tenantId, agentId },
      { now: deps.now, prune, transaction: deps.transaction });
    const passes = recordSkips(deps.sql, billing.declared, blocked);
    const by = (k: Block) => Object.keys(blocked).filter((a) => blocked[a] === k);
    // Past the threshold, what a person is asked to do depends on why the mount blocks. Only `incomplete` (the
    // mount's own record is unreadable: `unreadableKinds.unknown` or `machines > 0`) gets the menu of fixes, the last of
    // which gives up pruning. `complete_missing` (the plugin does not send the field yet: a rollout gap) and
    // `unanswered` (the call failed) are `stalled`: wait, or look at the mount. Never offer giving up the prune for a
    // cause it cannot fix.
    const over = (a: string) => passes[a]! >= ESCALATE_AFTER_PASSES;
    const escalate = Object.keys(passes).filter((a) => over(a) && blocked[a] === "incomplete");
    const stalled = Object.keys(passes).filter((a) => over(a) && blocked[a] !== "incomplete");
    const breakdowns = Object.values(billing.unreadable);
    Object.assign(log, {
      // The daily report's breakdown of the answered mounts' unreadable record. `other` is informational only: it
      // is in neither the prune decision nor the escalation.
      unknownBlocking: breakdowns.filter((u) => u.unknown).length,
      machinesBlocking: breakdowns.filter((u) => u.machines > 0).length,
      otherUnreadable: breakdowns.filter((u) => u.other > 0).length,
      kindsMissing: billing.kindsMissing.length,
      kindsOf: billing.kindsOf.length,
      kindsViolation: billing.kindsViolation.length,
      pruned: prune,
      wouldDelete: counted.stale.length,
      deleted: counted.deleted,
      ...(prune ? {} : {
        reasons: (["unanswered", "incomplete", "complete_missing"] as const).filter((k) => by(k).length).join(","),
        unansweredAliases: aliasList(by("unanswered")),
        incompleteAliases: aliasList(by("incomplete")),
        completeMissingAliases: aliasList(by("complete_missing")),
        skipPasses: JSON.stringify(passes),
        escalate: escalate.length > 0,
        escalateAliases: aliasList(escalate),
        stalled: stalled.length > 0,
        stalledAliases: aliasList(stalled),
      }),
    });
    logEvent("usage.held_pass", log);
    return { billing, prune, blocked, passes, wouldDelete: counted.stale.length, deleted: counted.deleted, lines: counted.lines, log };
  } catch (e) {
    logEvent("usage.held_pass", { ...log, failed: true, error: String((e as Error)?.message ?? e).slice(0, 200) });
    throw e;
  }
}
