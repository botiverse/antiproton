/**
 * Raft's managed MCP for a hosted agent: the connectors a person set up for the agent's Raft Server (Notion and the
 * like), offered as tools of the agent's raft mount and called through Raft's gateway (`raft.mcp`, SDK 0.21.0). Raft
 * holds the connectors' credentials and attaches them to each call; this file never sees one, and the only credential
 * it sends is the mount's own Raft agent credential, to the mount's Raft origin, through the same client every other
 * Raft call here uses.
 *
 * Part of the raft mount rather than a mount of its own, because everything it needs is that mount's: the agent's Raft
 * identity and credential, the origin it may send them to, the capability list the listing already reads (the
 * catalogue is asked for only when the credential holds `mcp`), and the listing's re-take on a credential change. A
 * sibling mount would need its own copy of the credential, a seed on every hosted agent, and a way to follow the raft
 * mount's credential when it changes; as part of the mount, every agent with a raft mount has it, and none without one
 * does.
 *
 * - **Tools.** One per catalogue entry, named from its `runtimeName` (`mcpToolName`): `mcp_` and the name with every
 *   character outside `[A-Za-z0-9_]` made `_`, so no name can be one of the plugin's own and the model's name reads
 *   `<alias>__mcp_…`. The description and `inputSchema` are the catalogue's, passed through; the kernel's admission
 *   bounds apply to them as to any listed tool (src/runtime/mount-tools.ts), and a tool over one is left out with the
 *   reason rather than shortened. Every one is a write with no idempotency: a managed call is not idempotent, so it is
 *   never replayed after a crash, and a subagent is not offered it (`childMayCall`, src/runtime/subagents.ts).
 * - **Where the catalogue lives.** The tools are in the mount's snapshot, as every listed tool is: the catalogue and
 *   the gateway read the record and never wait on Raft. What a call needs beyond the schema (the server's id and the
 *   versions Raft checks) is kept in the mount's database (`MCP_KEY`), with each tool as listed, so a listing that
 *   cannot read the catalogue offers the last one again, and with the connectors that need reconnecting, which the
 *   mount's prompt paragraph names (`mcpLines`).
 * - **Freshness.** The listing asks for the catalogue each time it runs. Besides the runtime's own reasons to list
 *   (a credential change, a build whose tool set moved), a turn's start lists again when the catalogue is older than
 *   `MCP_CATALOG_TTL_MS`, or at once after a call was told it is stale (`mcpDue`, `Plugin.toolsDue`). The list a turn
 *   starts with is its list; a new one reaches the model on the next turn (`catalogueKey` moves with the snapshot).
 * - **Results.** A result is the tool's content as Raft returned it. A `tool_error` is an error with its text (capped
 *   by the SDK). A failure is an error whose message is the SDK's `error.nextAction`, exactly as it came; `stale` also
 *   marks the catalogue due. `outcome_unknown` is recorded as an operation whose outcome is unknown (`mayHaveLanded`).
 * - **No retries.** The SDK makes one attempt (`managedMcpCall` is a single-attempt route), this file calls once, and
 *   nothing above it calls again: the gateway runs a call once, refuses a second start of the same operation
 *   (`already_attempted`, which a run_js program re-run after a restart meets, since its calls are keyed), and neither
 *   engine re-runs a write with no idempotency after a crash (`replayPolicy`, src/runtime/pi-tools.ts; pi-durable's
 *   `unsafe`). Tool calls do not travel through a queue, so there is no redelivery to guard against.
 * - **Trace.** The gateway's `tool.call` row as for every call (tool, mount, task, call id; never arguments or a
 *   result), and one `raft.mcp_call` row on the same span with the connector's server name, the remote tool's name and
 *   how the call ended. Nothing else is recorded.
 */
import {
  formatMcpReconnectRequired, MCP_OUTCOME_UNKNOWN_TEXT, mcpFailureKind,
  type Raft, type RaftFailure, type RaftMcpTool,
} from "@botiverse/raft-sdk";
import type { Json, MountRecord } from "../core/types.ts";
import type { PluginContext, PluginErrorFields, SkippedTool, ToolSchema } from "./types.ts";

/** The prefix of every managed MCP tool's name: no tool of the plugin's own starts with it. */
export const MCP_PREFIX = "mcp_";
/** The Raft capability the catalogue and the call need. */
export const MCP_CAPABILITY = "mcp";
/** Where the catalogue's call details are kept, in the mount's `context` store. Listed: ids and names, no credential. */
export const MCP_KEY = "mcp";
/**
 * How old the catalogue may grow before a turn's start lists it again. A connector a person adds or reconnects in
 * Raft reaches the agent within this long of its next turn; the cost is one catalogue request (and the credential
 * context the listing reads anyway) per mount at most once per this long, under the runtime's re-take timeout.
 */
export const MCP_CATALOG_TTL_MS = 5 * 60_000;
/** The name a `skipped` entry gives the catalogue as a whole, when it could not be read. */
export const MCP_CATALOG = "(managed MCP catalogue)";

/** One catalogue entry as a call needs it, under the name the model was offered. */
export interface KeptMcpTool {
  name: string;
  mcpServerId: string;
  serverName: string;
  toolName: string;
  runtimeName: string;
  configVersion: number;
  assignmentVersion: number;
  /** The tool as it was listed, so a listing that cannot read the catalogue can offer it again. */
  schema: ToolSchema;
}

/** What the listing keeps under `MCP_KEY`. */
export interface KeptMcp {
  at: number;
  tools: KeptMcpTool[];
  /** Connectors set up for this agent that need reconnecting, by server name. */
  reconnect: string[];
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** The kept catalogue, read leniently: an entry that does not read is left out, a record that does not read is none. */
export function keptMcpOf(raw: unknown): KeptMcp | null {
  const r = obj(raw);
  if (typeof r.at !== "number" || !Array.isArray(r.tools)) return null;
  const tools = r.tools.map(obj).filter((t) =>
    typeof t.name === "string" && typeof t.mcpServerId === "string" && typeof t.serverName === "string" &&
    typeof t.toolName === "string" && typeof t.runtimeName === "string" &&
    typeof t.configVersion === "number" && typeof t.assignmentVersion === "number" &&
    typeof obj(t.schema).name === "string" && obj(t.schema).name === t.name) as unknown as KeptMcpTool[];
  const reconnect = Array.isArray(r.reconnect) ? r.reconnect.filter((s): s is string => typeof s === "string") : [];
  return { at: r.at, tools, reconnect };
}

/**
 * The tool name for a catalogue entry's `runtimeName`: `mcp_` and the name with every character a tool name may not
 * hold made `_` (a leading `mcp_`/`mcp__` is not doubled), and `_2`, `_3`, … after a name already given. Deterministic
 * in the catalogue's order, so the same catalogue names its tools the same way every time.
 */
export function mcpToolName(runtimeName: string, used: Set<string>): string {
  const clean = runtimeName.replace(/[^A-Za-z0-9_]/g, "_").replace(/^mcp_+/i, "");
  const base = `${MCP_PREFIX}${clean || "tool"}`;
  let name = base;
  for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
  used.add(name);
  return name;
}

export function isMcpTool(name: string): boolean {
  return name.startsWith(MCP_PREFIX);
}

/** A catalogue entry as a tool: its own description and schema, a write with no idempotency. */
function schemaOf(name: string, t: RaftMcpTool): ToolSchema {
  return {
    name,
    summary: t.description ?? t.title ?? "",
    parameters: t.inputSchema as unknown as Json,
    // A managed call is not idempotent, whatever the remote tool's annotations claim: never replayed, never a child's.
    sideEffects: "write",
    idempotency: "none",
  };
}

const key = (tenantId: string, agentId: string, alias: string) => `${tenantId}/${agentId}/${alias}`;

/**
 * The catalogue's clock, per mount, in this isolate: when this isolate last listed it, and the mounts a call was told
 * are stale. An isolate that has not listed a mount reads the snapshot's own `takenAt` instead, so a fresh object lists
 * a catalogue older than the TTL once, at its first turn.
 */
export function mcpClock() {
  const listedAt = new Map<string, number>();
  const stale = new Set<string>();
  return {
    listed(ctx: Pick<PluginContext, "caller" | "alias">, at: number): void {
      const k = key(ctx.caller.tenantId, ctx.caller.agentId, ctx.alias);
      listedAt.set(k, at);
      stale.delete(k);
    },
    markStale(ctx: Pick<PluginContext, "caller" | "alias">): void {
      stale.add(key(ctx.caller.tenantId, ctx.caller.agentId, ctx.alias));
    },
    /**
     * Whether a turn's start should list this mount again (`Plugin.toolsDue`). Only a mount whose list was taken under a
     * credential: one with none has no catalogue to ask for, and a re-take would only be refused.
     */
    due(m: MountRecord, now: number): boolean {
      const snap = m.toolSnapshot;
      if (!snap || !m.secretRef || snap.withoutCredential) return false;
      const k = key(m.tenantId, m.agentId, m.alias);
      if (stale.has(k)) return true;
      return now - (listedAt.get(k) ?? snap.takenAt) >= MCP_CATALOG_TTL_MS;
    },
  };
}
export type McpClock = ReturnType<typeof mcpClock>;

/** Keep the catalogue; a write that fails costs the calls their details until the next listing, never the listing. */
async function keep(ctx: PluginContext, store: string, value: KeptMcp): Promise<void> {
  try { await ctx.db.put(store, value as unknown as Json, MCP_KEY); }
  catch (e) { console.warn(`raft managed MCP catalogue could not be kept for mount ${ctx.alias}: ${String((e as Error)?.message ?? e)}`); }
}

/**
 * The catalogue as tools, for the listing (`snapshotTools`), and kept for the calls. Asked only of a credential that
 * holds `mcp`; for one that does not, the kept catalogue is emptied and nothing is listed. A catalogue that cannot be
 * read does not fail the listing, which lists Raft's own operations too: the catalogue kept last time is offered
 * again, and the entry in `skipped` says why it was not read.
 */
export async function listMcp(raft: Raft, ctx: PluginContext, store: string, holdsMcp: boolean): Promise<{ tools: ToolSchema[]; skipped: SkippedTool[] }> {
  const now = Date.now();
  if (!holdsMcp) {
    await keep(ctx, store, { at: now, tools: [], reconnect: [] });
    return { tools: [], skipped: [] };
  }
  const out = await raft.mcp.tools();
  if (!out.ok) {
    let kept: KeptMcp | null = null;
    try { kept = keptMcpOf(await ctx.db.get(store, MCP_KEY)); } catch { /* none to offer again */ }
    const why = out.error.code === "TRANSPORT_ERROR" ? "no answer from Raft"
      : out.error.status !== undefined ? `Raft answered HTTP ${out.error.status}` : "Raft's answer did not match the Raft SDK's contract";
    const tools = kept?.tools.map((t) => t.schema) ?? [];
    return {
      tools,
      skipped: [{ name: MCP_CATALOG, reason: `the managed MCP catalogue could not be read (${why}); ${tools.length ? "the tools listed before are offered until it can" : "none is offered until it can"}` }],
    };
  }
  const used = new Set<string>();
  const tools: ToolSchema[] = [];
  const kept: KeptMcpTool[] = [];
  for (const t of out.data.tools) {
    const name = mcpToolName(t.runtimeName, used);
    const schema = schemaOf(name, t);
    tools.push(schema);
    kept.push({
      name, mcpServerId: t.mcpServerId, serverName: t.serverName, toolName: t.toolName, runtimeName: t.runtimeName,
      configVersion: t.configVersion, assignmentVersion: t.assignmentVersion, schema,
    });
  }
  const reconnect = [...new Set(out.data.reconnectRequired.map((r) => r.serverName))];
  await keep(ctx, store, { at: now, tools: kept, reconnect });
  return { tools, skipped: [] };
}

/** One line per connector that needs reconnecting, in the SDK's words (`formatMcpReconnectRequired`). */
export function mcpLines(kept: KeptMcp | null): string[] {
  return (kept?.reconnect ?? []).map((serverName) => formatMcpReconnectRequired(serverName));
}

function failed(message: string, marks: { mayHaveLanded?: boolean; transient?: boolean } = {}): Error {
  const e = new Error(message) as Error & PluginErrorFields;
  if (marks.transient !== undefined) e.transient = marks.transient;
  // `retryable` is what the gateway reads as "may have landed" (it records the operation as unknown); never a retry.
  if (marks.mayHaveLanded) { e.mayHaveLanded = true; e.retryable = true; } else e.retryable = false;
  return e;
}

/**
 * One managed call: once, through the SDK, with the catalogue entry the listing kept for this name. What comes back is
 * handed on as it is (`listMcp`'s file comment says how each outcome reads); nothing here calls again.
 */
export async function callMcp(
  name: string, args: unknown, ctx: PluginContext, raft: () => Raft, store: string, clock: McpClock,
): Promise<Json> {
  if (args !== undefined && args !== null && (typeof args !== "object" || Array.isArray(args))) {
    throw failed(`${name} takes an object of arguments`);
  }
  const kept = keptMcpOf(await ctx.db.get(store, MCP_KEY));
  const tool = kept?.tools.find((t) => t.name === name);
  if (!tool) {
    // Offered by a snapshot the kept catalogue no longer matches: nothing was sent, and the next turn lists it again.
    clock.markStale(ctx);
    throw failed(`${name} is no longer in this agent's managed MCP catalogue, so nothing was sent; its tools are listed again before your next turn`);
  }
  const trace = (status: string, verdict: "ok" | "failed") =>
    ctx.trace?.({ kind: "raft.mcp_call", status, verdict, attrs: { server: tool.serverName, tool: tool.toolName } });
  const out = await raft().mcp.call({ tool, arguments: (args ?? {}) as Record<string, unknown> });
  if (out.ok && out.state === "result") {
    trace("result", "ok");
    return { content: out.data.content, ...(out.data.structuredContent ? { structuredContent: out.data.structuredContent } : {}) } as unknown as Json;
  }
  if (out.ok) {
    // The remote tool answered with an error: it ran, and what it said is the model's to read.
    trace("tool_error", "failed");
    throw failed(out.text);
  }
  const failure = out as RaftFailure;
  const kind = mcpFailureKind(failure);
  const nextAction = failure.error.nextAction;
  trace(kind ?? "error", "failed");
  switch (kind) {
    case "stale":
      clock.markStale(ctx);
      throw failed(nextAction);
    case "reconnect_required":
      throw failed(nextAction);
    case "unavailable":
      // Raft confirmed the tool was not called; it may work later, on the model's own decision.
      throw failed(nextAction, { transient: true });
    case "outcome_unknown":
      // The SDK's own words for it (`MCP_OUTCOME_UNKNOWN_TEXT`), and an operation recorded as unknown.
      throw failed(nextAction || MCP_OUTCOME_UNKNOWN_TEXT, { mayHaveLanded: true });
    default: {
      // Raft answered with something the SDK does not class as a managed MCP failure. A 5xx may have reached the tool.
      const status = failure.error.status;
      throw failed(nextAction, status !== undefined && status >= 500 ? { mayHaveLanded: true } : {});
    }
  }
}
