/**
 * The usage and trace outboxes for an agent on the `pd` engine, derived from what pi-durable
 * committed.
 *
 * On pi 0.85 the rows are written by our `Storage.commit` (src/store/pi-storage.ts), inside the
 * transaction that commits the answer: a `model.tokens` usage row per kind of token a usage write
 * counts, and a `model.call` trace row for an assistant entry that carries the job id it answers
 * and ended. pi-durable's commits are its own, and nothing of ours may run inside them
 * (src/store/pi-durable-sqlite.ts), so here the same rows are derived afterwards from the committed
 * entries, past a watermark: pi-durable's `entries.commit_seq`, kept in `ap_outbox_marks` with the
 * entry id that bounds the read (`OUTBOX_ENTRY_MARK`).
 *
 * The rows are the same rows from the same facts, built by the same functions (`modelTokenRows`,
 * `modelCallRow`), so the flushers (cf/src/usage-d1.ts, cf/src/trace-r2.ts, cf/src/activity-raft.ts),
 * billing and the status derived from trace rows (src/runtime/status.ts) read a pd agent exactly as
 * they read a pi085 one. Which entries are counted mirrors which usage writes pi 0.85 makes:
 *
 * - every assistant entry, whatever it ended with. pi 0.85 writes a usage row for every response it
 *   settles, an error included (`drive/response.js`); pi-durable appends every response as an
 *   assistant entry, a failed attempt that it then retries included (`appendAssistant` in
 *   harness/generation.js, "every built-in writer of assistant entries goes through here").
 * - a tool result whose message carries usage, under the model `unknown`: what pi-storage's
 *   `#modelOf` makes of a usage row whose entry is not an assistant's. No tool on either engine sets
 *   one today; it is mirrored so that the two cannot drift when one does.
 *
 * One pass is one unit (`ApStore.unit`, i.e. `exclusive`): read the mark, read the entries committed
 * after it, append their rows, advance the mark. A crash anywhere in it leaves nothing; a pass run
 * twice derives nothing the second time. That the mark moves in the same unit as the rows is the
 * whole of the idempotency — two units would bill a pass twice after a crash between them.
 *
 * Each pass also compares what has been derived in total with pi-durable's own `pi.usage` documents,
 * read in the same unit and so at the same commit. Their expected relation is equality: `pi.usage`
 * counts each assistant entry's usage in the commit that appends it (failed attempts too, as above)
 * and each tool result's in the commit that appends that. Two things would make `pi.usage` the
 * larger, and both are reported rather than hidden: compaction, which records its model call's
 * usage with no entry (harness/compaction.js; off on pd, `compaction: { enabled: false }` in
 * src/runtime/durable-agent.ts), and a conversation whose document was retired. A mismatch is a
 * structured warning (`pd.outbox.usage_mismatch`), never a correction: the rows are what is billed,
 * and which side is wrong is a question for a person.
 *
 * What differs from pi085, deliberately: a row's `at` is the pass's clock, not the commit's. A
 * pi-durable entry has no time of its own, and the pass runs after every commit (`PdHost`), so the two
 * differ by the length of a commit. After a crash it is the time of the pass that recovered it, which
 * can put tokens in a later hour than they were spent: late, never lost and never twice.
 */
import { logEvent } from "../core/log.ts";
import { appendTrace, type TraceRow } from "../trace/outbox.ts";
import { answerEnded, modelCallRow } from "../trace/seams.ts";
import { appendUsage, modelTokenRows, type UsageRow } from "../usage/outbox.ts";
import type { ApUnit } from "../store/ap-store.ts";
import { PI_DURABLE_OBJECTS } from "../store/pi-durable-sqlite.ts";
import { SqlQualifier, type SqlNamespace } from "../store/sql-namespace.ts";

/** The `ap_outbox_marks` row: both outboxes are derived in one pass, so they share one mark. */
export const OUTBOX_MARK = "usage+trace";
/**
 * The same mark as an entry id, which is what bounds the read. `entries` has no index on `commit_seq`
 * and we may not add one (its tables are pi-durable's), so a read by sequence scans every entry the
 * object ever committed, on every pass. The id is the table's INTEGER PRIMARY KEY, so `id > ?` is a
 * range on the rowid, and it is monotonic with commit order: ids are minted from one counter only
 * inside a commit callback on the Session's mutation line, which runs one commit at a time
 * (session/session.js `#runCommit`, session/transaction.js), and a reopened storage resumes the
 * counter from `durable_metadata.next_id`, past every committed id. So every entry committed after
 * the last pass has a larger id than every entry it read. docs/pi-upstream.md lists this contract;
 * test/spec/pd-outbox-spec.ts checks it on every run and counts what a pass reads.
 */
export const OUTBOX_ENTRY_MARK = "usage+trace:entry-id";
/** The `ap_meta` row holding what every pass so far has derived, for the comparison with `pi.usage`. */
const TOTALS_KEY = "outbox.usage";

/** The counters a usage row bills (`modelTokenRows`), and so the ones compared. */
const COUNTERS = ["input", "output", "cacheRead", "cacheWrite", "reasoning"] as const;
type Tokens = Record<(typeof COUNTERS)[number], number>;
/** Keyed as `pi.usage` keys them: `models` by `provider/model`, `tools` by tool name. */
export type UsageTotals = { models: Record<string, Tokens>; tools: Record<string, Tokens> };

export type UsageCheck =
  | { state: "match" }
  | { state: "mismatch"; derived: UsageTotals; counted: UsageTotals }
  /** The documents were not in the shape this reads; nothing was compared. */
  | { state: "unreadable"; reason: string };

export interface DerivePass {
  /** The mark before the pass, and after it: pi-durable's commit sequence. */
  from: number;
  through: number;
  /** Entries that produced rows, and the rows. */
  entries: number;
  usage: number;
  trace: number;
  /** Null when nothing was committed since the last pass: there was nothing new to compare. */
  check: UsageCheck | null;
}

type Raw = { exec(query: string, ...bindings: Array<string | number | null>): { toArray(): Array<Record<string, unknown>> } };
type UsageLike = Partial<Record<(typeof COUNTERS)[number] | "totalTokens", number>>;
type MessageLike = { role?: string; model?: string; provider?: string; jobId?: unknown; stopReason?: string; usage?: UsageLike; toolName?: string };

const emptyTotals = (): UsageTotals => ({ models: {}, tools: {} });

function add(bucket: Record<string, Tokens>, key: string, usage: UsageLike): void {
  // Own keys only, as pi-durable keeps them: a tool may be called `__proto__`.
  const have = Object.hasOwn(bucket, key) ? bucket[key]! : undefined;
  const into: Tokens = have ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
  for (const c of COUNTERS) into[c] += typeof usage[c] === "number" ? usage[c]! : 0;
  if (!have) Object.defineProperty(bucket, key, { value: into, enumerable: true, writable: true });
}

function sameTotals(a: UsageTotals, b: UsageTotals): boolean {
  for (const bucket of ["models", "tools"] as const) {
    const keys = new Set([...Object.keys(a[bucket]), ...Object.keys(b[bucket])]);
    for (const k of keys) {
      const x = Object.hasOwn(a[bucket], k) ? a[bucket][k] : undefined;
      const y = Object.hasOwn(b[bucket], k) ? b[bucket][k] : undefined;
      for (const c of COUNTERS) if ((x?.[c] ?? 0) !== (y?.[c] ?? 0)) return false;
    }
  }
  return true;
}

/** Every live `pi.usage` document summed, as `Harness.usage()` sums them, read from the tables in this unit. */
function countedUsage(raw: Raw, pd: SqlQualifier): UsageTotals | string {
  const out = emptyTotals();
  // pi-durable stores an indexed string as its JSON text (`encodeIndexedString` in storage/sqlite/storage.js).
  const docs = raw.exec(pd.rewrite("SELECT id FROM documents WHERE kind = ? AND scope_kind = 'conversation' AND retired_at IS NULL"), JSON.stringify("pi.usage")).toArray();
  for (const d of docs) {
    const [rev] = raw.exec(pd.rewrite("SELECT kind, content FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1"), Number(d.id)).toArray();
    // `pi.usage` checkpoints on every change (`checkpointWhen: () => true`, harness/usage.js), so its newest
    // revision is a whole value. A delta means that changed upstream, and reading it as a value would be wrong.
    if (!rev || rev.kind !== "base") return `pi.usage document ${String(d.id)} has no base as its newest revision`;
    const value = JSON.parse(String(rev.content)) as { models?: Record<string, UsageLike>; tools?: Record<string, UsageLike> };
    for (const bucket of ["models", "tools"] as const) {
      for (const [k, u] of Object.entries(value[bucket] ?? {})) add(out[bucket], k, u);
    }
  }
  return out;
}

export interface DeriveContext {
  owner: { tenantId: string; agentId: string };
  /** pi-durable's namespace (`pd`) and ours (`ap`) as the object places them. */
  pd: SqlNamespace;
  ap: SqlNamespace;
  now: number;
  /** A test seam: called after the rows are appended and before the mark moves. A throw rolls the pass back. */
  fault?: (stage: "appended") => void;
}

/**
 * One pass, synchronously. Must run inside `ApStore.unit` — the unit is what makes its writes one
 * commit, and what keeps them out of a pi-durable transaction.
 */
export function derivePdOutbox(raw: Raw, ap: ApUnit, ctx: DeriveContext): DerivePass {
  const pd = new SqlQualifier(PI_DURABLE_OBJECTS, ctx.pd);
  const from = Number(ap.run("SELECT through_seq FROM outbox_marks WHERE outbox = ?", OUTBOX_MARK)[0]?.through_seq ?? 0);
  // A storage pi-durable never opened has no tables yet, and nothing to derive.
  const opened = raw.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", ctx.pd.qualify("durable_metadata", "table")).toArray().length > 0;
  if (!opened) return { from, through: from, entries: 0, usage: 0, trace: 0, check: null };
  // Every commit below `next_seq` is committed: this runs after any pi-durable transaction, never in one.
  // One row read, so a pass after a commit that changed nothing costs no scan.
  const through = Number(raw.exec(pd.rewrite("SELECT next_seq FROM durable_metadata WHERE singleton = 1")).toArray()[0]?.next_seq ?? 1) - 1;
  if (through <= from) return { from, through: from, entries: 0, usage: 0, trace: 0, check: null };

  const fromId = Number(ap.run("SELECT through_seq FROM outbox_marks WHERE outbox = ?", OUTBOX_ENTRY_MARK)[0]?.through_seq ?? 0);
  // `commit_seq` stays in the predicate as the statement of what is read; the id range is what bounds it.
  const fresh = raw.exec(pd.rewrite(
    "SELECT id, commit_seq, record FROM entries WHERE id > ? AND commit_seq <= ? ORDER BY id"), fromId, through).toArray();
  const throughId = fresh.reduce((max, r) => Math.max(max, Number(r.id)), fromId);
  const records = fresh.filter((r) => {
    const kind = (JSON.parse(String(r.record)) as { kind?: unknown }).kind;
    return kind === "pi.assistant" || kind === "pi.tool-result";
  });
  const usage: UsageRow[] = [];
  const trace: TraceRow[] = [];
  const totalsRow = ap.run("SELECT v FROM meta WHERE k = ?", TOTALS_KEY)[0];
  const totals: UsageTotals = totalsRow ? JSON.parse(String(totalsRow.v)) : emptyTotals();
  let entries = 0;
  const base = { at: ctx.now, ...ctx.owner };
  for (const r of records) {
    const record = JSON.parse(String(r.record)) as { kind: string; model?: MessageLike[] };
    let produced = false;
    for (const m of record.model ?? []) {
      if (record.kind === "pi.assistant" && m.role === "assistant") {
        const model = typeof m.model === "string" ? m.model : "unknown";
        if (m.usage) {
          usage.push(...modelTokenRows(base, model, m.usage));
          add(totals.models, `${m.provider}/${m.model}`, m.usage);
        }
        // pi-storage's rule exactly: an ended answer that names its job.
        if (typeof m.jobId === "string" && answerEnded(m.stopReason as Parameters<typeof answerEnded>[0])) {
          const job = ap.run("SELECT created_at, answered_at FROM model_jobs WHERE id = ?", m.jobId)[0];
          trace.push(modelCallRow({
            ...ctx.owner, jobId: m.jobId, stopReason: m.stopReason as Parameters<typeof modelCallRow>[0]["stopReason"],
            model, at: ctx.now,
            createdAt: job ? Number(job.created_at) : null,
            answeredAt: job && job.answered_at !== null ? Number(job.answered_at) : null,
          }));
        }
        produced = true;
      } else if (record.kind === "pi.tool-result" && m.role === "toolResult" && m.usage) {
        usage.push(...modelTokenRows(base, "unknown", m.usage));
        add(totals.tools, String(m.toolName), m.usage);
        produced = true;
      }
    }
    if (produced) entries++;
  }

  appendTrace(raw as Parameters<typeof appendTrace>[0], trace);
  appendUsage(raw as Parameters<typeof appendUsage>[0], usage);
  ctx.fault?.("appended");
  ap.run("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", TOTALS_KEY, JSON.stringify(totals));
  for (const [outbox, value] of [[OUTBOX_MARK, through], [OUTBOX_ENTRY_MARK, throughId]] as const) {
    ap.run("INSERT INTO outbox_marks (outbox, through_seq, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT (outbox) DO UPDATE SET through_seq = excluded.through_seq, updated_at = excluded.updated_at", outbox, value, ctx.now);
  }

  const counted = countedUsage(raw, pd);
  let check: UsageCheck;
  if (typeof counted === "string") {
    check = { state: "unreadable", reason: counted };
    logEvent("pd.outbox.usage_unreadable", { ...ctx.owner, through, reason: counted });
  } else if (!sameTotals(totals, counted)) {
    check = { state: "mismatch", derived: totals, counted };
    logEvent("pd.outbox.usage_mismatch", { ...ctx.owner, through, derived: JSON.stringify(totals), counted: JSON.stringify(counted) });
  } else {
    check = { state: "match" };
  }
  return { from, through, entries, usage: usage.filter((u) => Number.isFinite(u.quantity) && u.quantity !== 0).length, trace: trace.length, check };
}
