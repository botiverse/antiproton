/**
 * `/admin/diagnose`'s report, read the way `/admin/transcript` reads (transcript-read.ts): from the object's
 * own SQL and the store's plain readers, never by opening the agent.
 *
 * The report it replaces opened the agent (the store's init runs migrations, `agent()` re-pins mounts, the
 * harness reconciles the session), rendered through uiTranscript (which creates the default conversation),
 * and created tables while explaining a failure (Ada and Vera, #336). What only the open harness knows, the
 * lane's current operation, is said to be unreadable rather than guessed; what is stored about work in
 * flight is reported instead: model calls with no answer yet, and background jobs.
 */
import type { Plugin, PluginContext } from "../../src/plugins/types.ts";
import { holdingOf } from "../../src/plugins/types.ts";
import type { Json, ModelBinding, MountRecord } from "../../src/core/types.ts";
import type { SqlHost } from "../../src/store/pi-storage.ts";
import { secretRefKind } from "../../src/runtime/secrets.ts";
import { recentBackgroundJobs } from "../../src/runtime/background-jobs.ts";
import { maskRawRefs } from "../../src/store/refs.ts";
import { hasTable, readEntries, readTranscript, sessionFor } from "./transcript-read.ts";
import { trajectory } from "./ui.ts";
import type { MountReports } from "./mount-reports.ts";
import { worthReporting } from "./mount-reports.ts";

type Sql = SqlHost["sql"];

/** The store's readers the report uses. Each is a plain SELECT, so the store is never initialised for it. */
export interface DiagnosisStore {
  getModelBinding(tenantId: string, agentId: string): Promise<ModelBinding | null>;
  listMounts(tenantId: string, agentId: string): Promise<MountRecord[]>;
  getConnection(tenantId: string, agentId: string, alias: string): Promise<Json | null>;
  listState(tenantId: string, agentId: string, prefix?: string, limit?: number): Promise<Array<{ key: string }>>;
  getState(tenantId: string, agentId: string, key: string): Promise<{ value: unknown; ref: string | null } | null>;
  stateUsage(tenantId: string, agentId: string): Promise<{ keys: number; bytes: number }>;
  /** Times and state of one stored secret, never its value (src/core/store.ts). */
  secretMeta(tenantId: string, agentId: string, name: string): Promise<
    { account: string | null; verified: boolean; createdAt: number; updatedAt: number; lastUsedAt: number | null } | null>;
}

export interface DiagnosisDeps {
  store: DiagnosisStore;
  /** The plugins the agent's mounts name, for what each says it is holding. */
  plugins: Plugin[];
  /** When the object's alarm is set for, read from the platform. */
  alarm: () => Promise<number | null>;
  now?: () => number;
}

const rows = (sql: Sql, table: string, query: string, ...bindings: unknown[]): any[] =>
  hasTable(sql, table) ? (sql.exec(query, ...bindings).toArray() as any[]) : [];

/**
 * What each mount says it is holding and has held: the sandbox panel's data. The plugin is handed a
 * connection it can read and not write, so a plugin whose report would change its state is refused here
 * rather than trusted; one that cannot answer that way is left out, as one failing mount always was.
 */
async function mountReports(
  sql: Sql, mounts: MountRecord[], plugins: Plugin[], owner: { tenantId: string; agentId: string }, taskId: string,
  store: DiagnosisStore,
): Promise<MountReports> {
  const out: MountReports = {};
  for (const m of mounts) {
    const plugin = plugins.find((p) => p.id === m.plugin);
    if (!plugin || !holdingOf(plugin)) continue;
    const ctx: PluginContext = {
      caller: { ...owner, taskId },
      alias: m.alias,
      credential: null,
      publicConfig: m.publicConfig,
      connection: {
        get: async () => hasTable(sql, "connections") ? store.getConnection(owner.tenantId, owner.agentId, m.alias) : null,
        set: async () => { throw new Error("read-only: a diagnosis does not change a mount's state"); },
      },
      async sibling() { return null; },
    };
    try {
      const holding = holdingOf(plugin);
      const activity = holding ? await holding.activity(ctx) : { live: null };
      const usage = holding?.usage ? await holding.usage(ctx) : [];
      if (worthReporting(activity, usage)) out[m.alias] = { activity, usage };
    } catch {
      // One mount that cannot answer read-only must not blank the report for the rest.
    }
  }
  return out;
}

/** Null when the object holds no such agent, or the agent no such conversation. Writes nothing. */
/**
 * A mount's credential in time: first attached, last replaced, last used, and whether the check that runs
 * at attach said it worked. Nothing that identifies the credential or its holder.
 */
async function secretTimes(
  sql: Sql, store: DiagnosisStore, tenantId: string, agentId: string, ref: string | null, alias: string,
): Promise<{ createdAt: number; updatedAt: number; lastUsedAt: number | null; verified: boolean } | null> {
  if (!ref || secretRefKind(ref) !== "agent" || !hasTable(sql, "secrets")) return null;
  const meta = await store.secretMeta(tenantId, agentId, alias);
  if (!meta) return null;
  return {
    createdAt: meta.createdAt, updatedAt: meta.updatedAt, lastUsedAt: meta.lastUsedAt, verified: meta.verified,
  };
}

export async function readDiagnosis(
  sql: Sql, tenantId: string, agentId: string, taskId: string, deps: DiagnosisDeps,
): Promise<Record<string, unknown> | null> {
  const session = sessionFor(sql, tenantId, agentId, taskId);
  if (session === null) return null;
  const now = deps.now?.() ?? Date.now();
  const owner = { tenantId, agentId };
  const { store } = deps;
  const entries = readEntries(sql, session);
  const transcript = readTranscript(sql, tenantId, agentId, taskId)!;
  const kinds: Record<string, number> = {};
  for (const e of transcript.events) kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
  const compactions = entries.filter((e) => e.type === "compaction");
  const lastSummary = (compactions.at(-1) as { summary?: unknown } | undefined)?.summary;
  // A claimed object whose store was never initialised (an agent the API only named) has none of the store's
  // tables; each read is guarded instead of letting "no such table" become a 500 (Ada, #347).
  const mounts = hasTable(sql, "mounts") ? await store.listMounts(tenantId, agentId) : [];
  const hasState = hasTable(sql, "agent_state");
  const stateKeys = hasState ? await store.listState(tenantId, agentId, "", 20) : [];
  const docs: Record<string, unknown> = {};
  for (const k of stateKeys.slice(0, 5)) {
    const got = await store.getState(tenantId, agentId, k.key);
    docs[k.key] = got?.ref ?? (typeof got?.value === "string" ? got.value.slice(0, 600) : got?.value);
  }
  return {
    owner,
    entries: entries.length,
    compaction: {
      compactions: compactions.length,
      messages: entries.filter((e) => e.type === "message").length,
      summary: typeof lastSummary === "string" ? maskRawRefs(lastSummary.slice(0, 1200), owner) : null,
    },
    execution: {
      readable: false,
      why: "the lane's current operation lives in the open harness, and opening the agent to ask would change it; " +
        "modelJobs and backgroundJobs are what is stored about work in flight",
    },
    modelBinding: hasTable(sql, "model_bindings") ? await store.getModelBinding(tenantId, agentId) : null,
    mounts: await Promise.all(mounts.map(async (m) => ({
      alias: m.alias, plugin: m.plugin, policy: m.policy ?? null,
      config: m.publicConfig,
      // Whose credential this is, never what it is.
      secret: secretRefKind(m.secretRef),
      // WHEN it was attached, replaced and last dereferenced — because the question that costs an
      // afternoon is "did this mount have a credential at the time of that call?", and until now the only
      // way to ask it was to read the source of whatever build was live that day and reason backwards
      // (2026-09-20: the whole of #plugins:770a1824). Times only: not the value, and not the account it
      // names, which would put a person's login in an operator's report for no question anyone is asking.
      // `createdAt` survives a replacement (the upsert leaves it alone), so it dates the FIRST attach while
      // `updatedAt` dates the last one. Null for an operator ref: that secret is not in this agent's store.
      secretTimes: await secretTimes(sql, store, tenantId, agentId, m.secretRef, m.alias),
      connection: hasTable(sql, "connections") && (await store.getConnection(tenantId, agentId, m.alias)) != null,
    }))),
    mountReports: await mountReports(sql, mounts, deps.plugins, owner, taskId, store),
    eventKinds: kinds,
    lastEvents: transcript.events.slice(-6).map((e) => ({
      seq: e.sequence, kind: e.kind, detail: JSON.stringify(e.payload).slice(0, 220),
    })),
    backgroundJobs: hasTable(sql, "background_jobs") ? recentBackgroundJobs(sql, owner, 10) : [],
    alarm: await deps.alarm(),
    state: { ...(hasState ? await store.stateUsage(tenantId, agentId) : { keys: 0, bytes: 0 }), docs },
    alarmFailures: Number(rows(sql, "counters2", "SELECT v FROM counters2 WHERE k='alarmFailures'")[0]?.v ?? 0),
    releaseErrors: rows(sql, "release_errors", "SELECT at, alias, message FROM release_errors ORDER BY at DESC LIMIT 5")
      .map((r) => ({ at: r.at, alias: r.alias, message: r.message })),
    alarmErrors: rows(sql, "alarm_errors", "SELECT at, message FROM alarm_errors ORDER BY at DESC LIMIT 3")
      .map((r) => r.message),
    // Trace rows the drain refused (cf/src/trace-r2.ts): the number's place to
    // be seen, beside what else this object has had go wrong.
    traceDrops: rows(sql, "trace_drops", "SELECT at, dropped FROM trace_drops ORDER BY at DESC LIMIT 3")
      .map((r) => ({ at: Number(r.at), dropped: Number(r.dropped) })),
    modelJobs: rows(sql, "pi_model_jobs", "SELECT id, created_at FROM pi_model_jobs WHERE answer IS NULL ORDER BY created_at DESC LIMIT 10")
      .map((r) => ({ id: r.id, ageMs: now - Number(r.created_at) })),
    // What the console's trajectory tab would draw, from the same read, with no busy state to show.
    rendered: (() => {
      try {
        const out = trajectory(transcript.events, transcript.byOp, null);
        return { ok: true, bytes: out.length, steps: (out.match(/class="step /g) ?? []).length, tail: out.slice(-400) };
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
      }
    })(),
  };
}
