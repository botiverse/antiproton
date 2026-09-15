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
import type { Json, ModelBinding, MountRecord } from "../../src/core/types.ts";
import type { SqlHost } from "../../src/store/pi-storage.ts";
import { secretRefKind } from "../../src/runtime/secrets.ts";
import { recentBackgroundJobs } from "../../src/runtime/background-jobs.ts";
import { maskRawRefs } from "../../src/store/refs.ts";
import { hasTable, readEntries, readTranscript, sessionFor } from "./transcript-read.ts";
import { trajectory } from "./ui.ts";
import type { MountReports } from "./mount-reports.ts";

type Sql = SqlHost["sql"];

/** The store's readers the report uses. Each is a plain SELECT, so the store is never initialised for it. */
export interface DiagnosisStore {
  getModelBinding(tenantId: string, agentId: string): Promise<ModelBinding | null>;
  listMounts(tenantId: string, agentId: string): Promise<MountRecord[]>;
  getConnection(tenantId: string, agentId: string, alias: string): Promise<Json | null>;
  listState(tenantId: string, agentId: string, prefix?: string, limit?: number): Promise<Array<{ key: string }>>;
  getState(tenantId: string, agentId: string, key: string): Promise<{ value: unknown; ref: string | null } | null>;
  stateUsage(tenantId: string, agentId: string): Promise<{ keys: number; bytes: number }>;
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
  mounts: MountRecord[], plugins: Plugin[], owner: { tenantId: string; agentId: string }, taskId: string,
  store: DiagnosisStore,
): Promise<MountReports> {
  const out: MountReports = {};
  for (const m of mounts) {
    const plugin = plugins.find((p) => p.id === m.plugin);
    if (!plugin?.activity && !plugin?.usage) continue;
    const ctx: PluginContext = {
      caller: { ...owner, taskId },
      alias: m.alias,
      credential: null,
      publicConfig: m.publicConfig,
      connection: {
        get: () => store.getConnection(owner.tenantId, owner.agentId, m.alias),
        set: async () => { throw new Error("read-only: a diagnosis does not change a mount's state"); },
      },
      async sibling() { return null; },
    };
    try {
      const activity = plugin.activity ? await plugin.activity(ctx) : { live: null };
      const usage = plugin.usage ? await plugin.usage(ctx) : [];
      if (activity?.live || usage.length) out[m.alias] = { activity, usage };
    } catch {
      // One mount that cannot answer read-only must not blank the report for the rest.
    }
  }
  return out;
}

/** Null when the object holds no such agent, or the agent no such conversation. Writes nothing. */
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
  const mounts = await store.listMounts(tenantId, agentId);
  const stateKeys = await store.listState(tenantId, agentId, "", 20);
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
    modelBinding: await store.getModelBinding(tenantId, agentId),
    mounts: await Promise.all(mounts.map(async (m) => ({
      alias: m.alias, plugin: m.plugin, policy: m.policy ?? null,
      config: m.publicConfig,
      // Whose credential this is, never what it is.
      secret: secretRefKind(m.secretRef),
      connection: (await store.getConnection(tenantId, agentId, m.alias)) != null,
    }))),
    mountReports: await mountReports(mounts, deps.plugins, owner, taskId, store),
    eventKinds: kinds,
    lastEvents: transcript.events.slice(-6).map((e) => ({
      seq: e.sequence, kind: e.kind, detail: JSON.stringify(e.payload).slice(0, 220),
    })),
    backgroundJobs: hasTable(sql, "background_jobs") ? recentBackgroundJobs(sql, owner, 10) : [],
    alarm: await deps.alarm(),
    state: { ...(await store.stateUsage(tenantId, agentId)), docs },
    alarmFailures: Number(rows(sql, "counters2", "SELECT v FROM counters2 WHERE k='alarmFailures'")[0]?.v ?? 0),
    releaseErrors: rows(sql, "release_errors", "SELECT at, alias, message FROM release_errors ORDER BY at DESC LIMIT 5")
      .map((r) => ({ at: r.at, alias: r.alias, message: r.message })),
    alarmErrors: rows(sql, "alarm_errors", "SELECT at, message FROM alarm_errors ORDER BY at DESC LIMIT 3")
      .map((r) => r.message),
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
