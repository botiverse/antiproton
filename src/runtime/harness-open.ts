/**
 * Why a harness was opened: one `harness.open` trace row (src/trace/outbox.ts) each time `AgentRuntime.agent`
 * (cf/src/runtime.ts) builds one, so "did this agent's harness really reopen, and why" has an answer that is not
 * inferred from a moved prompt. A reuse writes nothing.
 *
 * The reasons:
 *   cold-start     the first harness for this conversation in this runtime: the object restarted (eviction or a
 *                  deploy; `cause` says which when it can) or the conversation is new (`cause: "first"`).
 *   key-change     a cached harness was refused because `harnessKey` moved; `changed` names what did.
 *   dropped        `dropHarnesses` (or an engine migration) closed it on purpose; `detail` says who asked.
 *   fresh-context  a fresh context ended the conversation the old harness was built on.
 *
 * Each conversation's last open is kept in `harness_opens`, next to the agent's own tables, because the two facts a
 * reason needs outlive the runtime that knew them: a restart drops its harnesses and then the runtime itself
 * (AgentDO.restart), so the drop's reason is read back by the next runtime from here; and the version the last harness
 * was built under is what tells a deploy from an eviction. Upserted in the same transaction as the trace row, so a row
 * says what the table then holds.
 */
import { createHash } from "node:crypto";
import { canonJson } from "../core/canon-json.ts";
import { logEvent } from "../core/log.ts";
import { appendTrace, type TraceRow } from "../trace/outbox.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

export type HarnessOpenReason = "cold-start" | "key-change" | "dropped" | "fresh-context";
/** For a cold start: `deploy` when the Worker version moved since the last open, `evicted` when it did not (any
 *  rebuild of the runtime inside one version reads so), `first` for a conversation never opened, `unknown` when either
 *  version is not known (no version metadata binding). */
export type ColdStartCause = "deploy" | "evicted" | "first" | "unknown";
/** The parts of a `harnessKey` a rebuild can name. `mounts` is the mount rows; `tools` is a mount's remote tool list
 *  alone (its snapshot hash) with the rows otherwise the same; `plugins` is the owner's enable/disable choices. */
export type HarnessKeyPart = "persona" | "model" | "mounts" | "tools" | "plugins";

const TABLE = "CREATE TABLE IF NOT EXISTS harness_opens(" +
  "conversation_key TEXT PRIMARY KEY, at INTEGER NOT NULL, built_from TEXT NOT NULL, version TEXT, " +
  "pending_reason TEXT, pending_detail TEXT)";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Which parts of two `harnessKey` values differ. A key that does not parse names nothing rather than everything: a
 * reading, never a reason to fail the open.
 */
export function harnessKeyChange(before: string, after: string): HarnessKeyPart[] {
  if (before === after) return [];
  try {
    const [catA, personaA, bindingA] = JSON.parse(before) as [string, unknown, unknown];
    const [catB, personaB, bindingB] = JSON.parse(after) as [string, unknown, unknown];
    const out: HarnessKeyPart[] = [];
    if (JSON.stringify(personaA) !== JSON.stringify(personaB)) out.push("persona");
    if (JSON.stringify(bindingA) !== JSON.stringify(bindingB)) out.push("model");
    if (catA !== catB) {
      // catalogueKey: [[alias, plugin, version, config, hasSecret, policy, snapshotHash]...], [[plugin, choice]...]
      const [mountsA, choicesA] = JSON.parse(catA) as [unknown[][], unknown];
      const [mountsB, choicesB] = JSON.parse(catB) as [unknown[][], unknown];
      const rows = (m: unknown[][]) => JSON.stringify(m.map((r) => r.slice(0, 6)));
      if (rows(mountsA) !== rows(mountsB)) out.push("mounts");
      else if (JSON.stringify(mountsA) !== JSON.stringify(mountsB)) out.push("tools");
      if (JSON.stringify(choicesA) !== JSON.stringify(choicesB)) out.push("plugins");
    }
    return out;
  } catch { return []; }
}

/**
 * Note on every conversation of `owner` (`<tenant>/<agent>`) that its next open is because of this drop. A
 * conversation never opened has no row and needs none: its next open is a first one.
 */
export function markHarnessDrop(sql: Sql, owner: string, reason: "dropped" | "fresh-context", detail: string | null) {
  sql.exec(TABLE);
  const prefix = `${owner}#`;
  sql.exec("UPDATE harness_opens SET pending_reason = ?, pending_detail = ? WHERE substr(conversation_key, 1, ?) = ?",
    reason, detail, prefix.length, prefix);
}

export interface HarnessOpen {
  tenantId: string; agentId: string;
  /** `<tenant>/<agent>#<session>`: the runtime's cache key, one per conversation slot. */
  conversationKey: string;
  session: string;
  /** The conversation the harness serves (a fresh context moves it under the same session). */
  conversation: string;
  engine: string;
  builtFrom: string;
  /** The `builtFrom` of the harness this runtime held for the key and refused, when it held one. */
  replaced: string | null;
  systemPrompt: string;
  /** The tool definitions the harness offers, as name, description and parameters: hashed so, the list reads the same
   *  as the `toolsSha256` on its calls' `model.call` rows (src/runtime/request-prefix.ts), as `systemSha256` does. */
  tools: ReadonlyArray<{ name: string; description?: string; parameters?: unknown }>;
  /** The Worker version this runtime runs, when the version metadata binding is there. */
  version: string | null;
  at: number;
  /** How long the build took. */
  ms: number;
}

/** The facts the row carries, decided from the stored last open and what the runtime knew. */
export function harnessOpenAttrs(prev: { at: number; built_from: string; version: string | null; pending_reason: string | null; pending_detail: string | null } | undefined, o: HarnessOpen) {
  const changed = prev ? harnessKeyChange(String(prev.built_from), o.builtFrom) : [];
  let reason: HarnessOpenReason;
  let cause: ColdStartCause | undefined;
  if (prev?.pending_reason === "dropped" || prev?.pending_reason === "fresh-context") reason = prev.pending_reason;
  else if (o.replaced !== null) reason = "key-change";
  else {
    reason = "cold-start";
    cause = !prev ? "first" : !prev.version || !o.version ? "unknown" : prev.version !== o.version ? "deploy" : "evicted";
  }
  return {
    reason,
    ...(cause ? { cause } : {}),
    // On key-change, what the refused harness was built from against this one; otherwise against the last open's.
    changed: o.replaced !== null ? harnessKeyChange(o.replaced, o.builtFrom) : changed,
    ...(prev?.pending_detail ? { detail: String(prev.pending_detail) } : {}),
    engine: o.engine,
    session: o.session,
    conversation: o.conversation,
    systemSha256: sha(o.systemPrompt),
    toolsSha256: sha(canonJson(o.tools.map((t) => ({ name: t.name, description: t.description ?? null, parameters: t.parameters ?? null })))),
    tools: o.tools.length,
    prevAgeMs: prev ? Math.max(0, o.at - Number(prev.at)) : null,
    version: o.version,
  };
}

/**
 * Write the open: the trace row, its log line, and the conversation's stored last open (clearing a drop's pending
 * reason), in one transaction. Returns the row's attrs.
 */
export function recordHarnessOpen(
  sql: Sql, transact: <T>(fn: () => T) => T, o: HarnessOpen,
): ReturnType<typeof harnessOpenAttrs> {
  return transact(() => {
    sql.exec(TABLE);
    const prev = sql.exec("SELECT at, built_from, version, pending_reason, pending_detail FROM harness_opens WHERE conversation_key = ?",
      o.conversationKey).toArray()[0];
    const attrs = harnessOpenAttrs(prev, o);
    const row: TraceRow = {
      at: o.at, tenantId: o.tenantId, agentId: o.agentId, kind: "harness.open",
      spanId: `ho_${o.conversationKey}@${o.at}`,
      status: attrs.reason, verdict: "ok", ms: o.ms, attrs,
    };
    appendTrace(sql as Parameters<typeof appendTrace>[0], [row]);
    sql.exec("INSERT INTO harness_opens(conversation_key, at, built_from, version, pending_reason, pending_detail) VALUES (?,?,?,?,NULL,NULL) " +
      "ON CONFLICT(conversation_key) DO UPDATE SET at = excluded.at, built_from = excluded.built_from, version = excluded.version, " +
      "pending_reason = NULL, pending_detail = NULL",
      o.conversationKey, o.at, o.builtFrom, o.version);
    // The trace line appendTrace writes carries the reason as its status; this one carries the rest, for a query by
    // agent and reason in Workers observability without waiting for the export.
    logEvent("harness.open", { tenantId: o.tenantId, agentId: o.agentId, ...attrs, changed: attrs.changed.join(","), ms: Math.round(o.ms) });
    return attrs;
  });
}
