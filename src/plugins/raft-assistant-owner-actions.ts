/**
 * A personal assistant acting as its owner (Raft `assistantOf.ownerActions`, SDK 0.33.0 `raft.assistant.ownerActions`):
 * one model tool per action Raft lists in the credential context, run through the SDK on the owner's own route.
 *
 * What code holds, whatever the model does:
 * - The tools are Raft's. Each tool's name, description and parameter descriptions are the entry's, as Raft wrote them
 *   (`toolOf`); nothing here describes an action. A parameter is required unless its entry says `optional: true`.
 * - Only a tier this file knows (`OWNER_ACTION_TIERS`) becomes a tool. An entry with any other tier, one the SDK left
 *   out (`list().skipped`, a tier it does not know) and one whose name another tool on the mount already has are left
 *   out, and the listing's trace row counts each (`listed`). Raft enforces every tier itself; leaving out what this
 *   build cannot name is so the model is never offered a tool whose kind of effect nobody here has read.
 * - Context with no `ownerActions`, or an empty list, is no tools and no extra request: a Server without the routes
 *   lists none.
 * - Only in the owner's chat. A check (a short `iso_` session) is woken by other people's messages, with no owner
 *   present, so an owner-power tool there would hand the owner's powers to whoever wrote what the check reads. Two
 *   layers, each enough alone: the runtime offers these tools only in the main session (cf/src/runtime.ts `#turnTools`,
 *   src/plugins/raft-assistant.ts `assistantTools`, which never adds them to a check's list), and a call from any other
 *   session, or from a program, is refused here before anything is sent (`runOwnerAction`).
 * - What the model reads is Raft's: the response's `assistant` block as Raft wrote it (a direct action's `done` and
 *   `undo`, a confirm action's `state` and `text`, a read's `text`), with any `omitted` / `omittedReason` beside it as
 *   Raft sent them; a failure is the SDK's `text` (the route's `error`) with the SDK's code and the HTTP status. Nothing
 *   is cut, summarised or reworded.
 * - Its trace rows (`raft.assistant_owner_actions`) carry counts, tiers and Raft's tool names, never an argument or a
 *   response text.
 *
 * Compiled by both typecheck programs.
 */
import { logEvent } from "../core/log.ts";
import type { Json } from "../core/types.ts";
import type { RaftOwnerAction, RaftOwnerActionList, RaftOwnerActionRunResult } from "@botiverse/raft-sdk";
import type { PluginContext, ToolSchema } from "./types.ts";

/** The tiers a tool is made for. Any other is left out (and counted), whatever the SDK lists. */
export const OWNER_ACTION_TIERS: readonly string[] = ["direct", "confirm", "read"];

/**
 * The key, inside an owner action tool's `parameters` as the mount's snapshot keeps it, that marks the tool as one and
 * holds its tier. The kernel keeps a snapshot tool's name, description and parameters and nothing else
 * (src/runtime/mount-tools.ts `admitTools`), so this is the one place the mark survives; `ownerActionsOf` strips it
 * before the tool is offered, so the model never sees it.
 */
export const OWNER_ACTION_MARK = "x-owner-action-tier";

/** The session an assistant's chat with its owner runs in (cf/src/runtime.ts `MAIN_SESSION`, as a call's `taskId`). */
export const CHAT_SESSION = "main";

/** Why an entry of the context made no tool. */
export type FilteredWhy = "unknown_tier" | "sdk_skipped" | "name_taken";

/** What a listing made of the context's entries. */
export interface OwnerActionListing {
  tools: ToolSchema[];
  /** The context's entries, as Raft listed them (`assistantOf.ownerActions`). */
  entries: number;
  filtered: Array<{ tool: string; tier: string; why: FilteredWhy }>;
}

type Param = RaftOwnerAction["params"][number] & { optional?: unknown };

/** One parameter's schema: its kind as a JSON type where the SDK's `run` checks one, and Raft's description verbatim. */
function paramSchema(p: Param): Record<string, Json> {
  const description = p.description;
  switch (p.kind) {
    case "boolean": return { type: "boolean", description };
    case "enum": return { type: "string", enum: [...(p.values ?? [])], description };
    case "channel": case "channel_or_server": case "conversation": case "agent": case "text":
      return { type: "string", description };
    // `position` is "top", "bottom" or `{ after }` (the SDK's `readPosition`), and a kind this build does not know is
    // whatever Raft says it is: neither has one JSON type, so neither is given one, and the SDK checks the value.
    default: return { description };
  }
}

/** The tool for one entry: Raft's name, description and parameters, the tier in the mark. */
export function toolOf(action: RaftOwnerAction): ToolSchema {
  const params = action.params as Param[];
  return {
    name: action.tool,
    summary: action.description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(params.map((p) => [p.name, paramSchema(p)])),
      required: params.filter((p) => p.optional !== true).map((p) => p.name),
      [OWNER_ACTION_MARK]: action.tier,
    },
    sideEffects: action.tier === "read" ? "read" : "write",
    idempotency: "none",
  };
}

/**
 * The tools a listing offers for the context's owner actions, and what it left out. `raw` is the context's own
 * `assistantOf.ownerActions` (null when absent), `listed` what the SDK's `list()` made of it, `taken` whether a name is
 * one the mount's other tools have or may have.
 */
export function ownerActionTools(raw: readonly unknown[] | null, listed: RaftOwnerActionList, taken: (name: string) => boolean): OwnerActionListing {
  const filtered: OwnerActionListing["filtered"] = listed.skipped.map((s) => ({ tool: s.tool, tier: s.tier, why: "sdk_skipped" as const }));
  const tools: ToolSchema[] = [];
  const names = new Set<string>();
  for (const action of listed.actions) {
    if (!OWNER_ACTION_TIERS.includes(action.tier)) { filtered.push({ tool: action.tool, tier: action.tier, why: "unknown_tier" }); continue; }
    if (taken(action.tool) || names.has(action.tool)) { filtered.push({ tool: action.tool, tier: action.tier, why: "name_taken" }); continue; }
    names.add(action.tool);
    tools.push(toolOf(action));
  }
  return { tools, entries: raw?.length ?? 0, filtered };
}

/** The context's `assistantOf.ownerActions` as Raft sent it, or null when there is none. */
export function rawOwnerActions(assistantOf: unknown): readonly unknown[] | null {
  const of = assistantOf && typeof assistantOf === "object" ? assistantOf as Record<string, unknown> : null;
  return of && Array.isArray(of.ownerActions) ? of.ownerActions : null;
}

/**
 * One listing's `raft.assistant_owner_actions` row, status `listed`: how many entries the context had (`entries`), how
 * many tools were made (`generated`), how many were left out (`filtered`) and why (`unknown_tier`, `sdk_skipped`,
 * `name_taken`), the tools made by tier, and the names left out with their tier. Written for every assistant's
 * listing, with zeros where the context lists none, so a day's rows count the chats scanned.
 */
export function traceListing(ctx: Pick<PluginContext, "trace" | "caller" | "alias">, l: OwnerActionListing): void {
  const count = (why: FilteredWhy) => l.filtered.filter((f) => f.why === why).length;
  const byTier = (tier: string) => l.tools.filter((t) => (t.parameters as Record<string, unknown>)[OWNER_ACTION_MARK] === tier).length;
  const attrs = {
    entries: l.entries, generated: l.tools.length, filtered: l.filtered.length,
    unknown_tier: count("unknown_tier"), sdk_skipped: count("sdk_skipped"), name_taken: count("name_taken"),
    direct: byTier("direct"), confirm: byTier("confirm"), read: byTier("read"),
    ...(l.filtered.length ? { left_out: l.filtered.map((f) => `${f.tool}:${f.tier}:${f.why}`).join(",") } : {}),
  };
  ctx.trace?.({ kind: "raft.assistant_owner_actions", status: "listed", verdict: "ok", attrs });
  if (l.filtered.length) logEvent("raft.assistant_owner_actions_filtered", { tenantId: ctx.caller.tenantId, agentId: ctx.caller.agentId, mount: ctx.alias, ...attrs });
}

/**
 * The owner action tools a mount's snapshot keeps, as they are offered: marked ones only, the mark taken out, and none
 * whose name is `reserved` (this build's own tools and the managed MCP namespace, which win). Each is model-only, as
 * the send-as-owner tool is: what Raft answers is for the model to read and tell the owner, so a program's call is
 * refused and no call is held for an approval that would run it with nobody reading the answer (`ToolSchema.modelOnly`).
 * The kernel keeps no such flag on a snapshot tool, so it is set here, where the tool is offered.
 */
export function ownerActionsOf(tools: readonly ToolSchema[], reserved: (name: string) => boolean = () => false): ToolSchema[] {
  return tools.filter((t) => isMarked(t) && !reserved(t.name)).map((t) => {
    const { [OWNER_ACTION_MARK]: _tier, ...parameters } = t.parameters as Record<string, Json>;
    return { ...t, parameters, modelOnly: true };
  });
}

function isMarked(t: Pick<ToolSchema, "parameters">): boolean {
  const p = t.parameters;
  return !!p && typeof p === "object" && !Array.isArray(p) && OWNER_ACTION_TIERS.includes((p as Record<string, unknown>)[OWNER_ACTION_MARK] as string);
}

/** The names of the owner action tools a mount's snapshot keeps (for `assistantTools`, chat only). */
export function ownerActionNames(snapshot: { tools: readonly ToolSchema[] } | null | undefined): string[] {
  return (snapshot?.tools ?? []).filter(isMarked).map((t) => t.name);
}

/** The SDK call an owner action makes (`raft.assistant.ownerActions.run`). */
export type OwnerActionRun = (tool: string, args: Record<string, unknown>) => Promise<RaftOwnerActionRunResult>;

/**
 * One owner action, run: refused outside the owner's chat (any session but the main one, or a program), else the
 * SDK's `run` and its answer as the model reads it (`answerOf`). `stale` is called when the SDK no longer knows the tool,
 * so the next turn lists the mount again.
 */
export async function runOwnerAction(tool: string, args: unknown, ctx: PluginContext, run: OwnerActionRun, stale: () => void = () => {}): Promise<Json> {
  const trace = (result: string, extra: Record<string, unknown> = {}) => {
    const verdict = result === "ok" ? "ok" : result.startsWith("refused:") ? "blocked" : "failed";
    const attrs = { tool, result, ...extra };
    ctx.trace?.({ kind: "raft.assistant_owner_actions", status: "called", verdict, attrs });
    logEvent("raft.assistant_owner_action", { tenantId: ctx.caller.tenantId, agentId: ctx.caller.agentId, mount: ctx.alias, ...attrs });
  };
  if (ctx.caller.taskId !== CHAT_SESSION || ctx.caller.fromProgram) {
    trace("refused:not_chat");
    throw Object.assign(new Error(`${tool} is only for your chat with your owner`), { retryable: false, transient: false });
  }
  const a = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const out = await run(tool, a);
  if (!out.ok) {
    if (out.code === "UNKNOWN_TOOL") stale();
    trace(out.code, { ...(out.status !== undefined ? { status: out.status } : {}), ...(out.errorCode ? { error_code: out.errorCode } : {}) });
    return answerOf(out);
  }
  trace("ok", { status: out.status, ...(typeof out.assistant?.state === "string" ? { state: out.assistant.state } : {}) });
  return answerOf(out);
}

/**
 * What the model reads of one run: on success Raft's `assistant` block whole (the SDK's `text` when Raft sent none),
 * with `omitted` / `omittedReason` from the response beside it when Raft sent them and the block does not carry them;
 * on failure the SDK's `text` as `error`, its `code`, and the HTTP status and Raft's code when there are.
 */
export function answerOf(out: RaftOwnerActionRunResult): Json {
  if (!out.ok) {
    return {
      ok: false, error: out.text, code: out.code,
      ...(out.status !== undefined ? { status: out.status } : {}), ...(out.errorCode ? { errorCode: out.errorCode } : {}),
    };
  }
  const block: Record<string, unknown> = out.assistant ? { ...out.assistant } : { text: out.text };
  for (const k of ["omitted", "omittedReason"] as const) {
    if (!(k in block) && typeof out.data[k] === "string") block[k] = out.data[k];
  }
  return { ok: true, status: out.status, assistant: block as Json };
}
