/**
 * What the model reads when it calls a tool it was not offered.
 *
 * pi answers that call itself, before any hook of ours runs, with a fixed line: pi-agent-core's
 * `Tool "raft__send_message" is unavailable`, pi-durable's `Tool raft__send_message is not available`. Both
 * read as a passing fault, and an agent did read them that way: a tool renamed under it (`send_message`
 * became `messages_send` when raft's tools were generated) was called three times, each answered the same.
 * The line says nothing about why, and the reason is ours to know: the plugin retired the name
 * (`Plugin.retired`), the mount's credential does not reach it (`ToolSnapshot.skipped`), or no mount has
 * such a tool.
 *
 * So the runtime replaces that line with `explainUnavailableTool`'s answer in the request the model is sent
 * next. Each engine keeps pi's own result in its transcript as pi wrote it and rewrites only the request,
 * through the hook pi offers for that (pi-agent-core `transform_context`, pi-durable's generation
 * `beforeRequest`), which keeps the stored record pi's and computes the explanation from the mounts as they
 * are when the request goes out.
 *
 * Strict on what it rewrites. A result is pi's only when it has pi's exact text for the call's own name, is
 * an error with no `details`, and names a tool that is not among the tools offered now — a tool that exists
 * cannot have been answered by pi's unknown-tool path, and one that does not exist cannot have run.
 * pi-durable also records why it wrote the result (the entry's `tool_unavailable` diagnostic), and its
 * engine checks that too (`isPdUnavailableEntry`). A real tool whose result happens to be the same text is
 * left alone. The texts and the code are pi's and no type carries them; docs/pi-upstream.md §3 lists them,
 * and test/unavailable-tool.ts drives pi's own code with an unknown name and fails when they move.
 */
import type { Plugin, ToolSnapshot } from "../plugins/types.ts";
import { pluginUnavailableMessage, switchedOffMessage } from "./gateway.ts";
import { modelName, modelToolName } from "./pi-tools.ts";

/** One mount of the agent, as the explanation reads it. */
export interface ExplainedMount {
  alias: string;
  /** The mount's plugin: its `retired` table, and its `tools` for a skipped entry that stands for all of them. */
  plugin?: (Pick<Plugin, "retired"> & { tools?: ReadonlyArray<{ name: string }> }) | undefined;
  /** Only `skipped` is read: the tools this mount leaves out, with why. */
  toolSnapshot?: Pick<ToolSnapshot, "skipped"> | null | undefined;
}

export interface UnavailableToolContext {
  /** The mounts whose tools are offered. */
  mounts: readonly ExplainedMount[];
  /** The tools the model is offered, by the name it sees and the address behind it (`alias.tool`). */
  offered: ReadonlyArray<{ name: string; address: string }>;
  /** Mounts the agent has whose tools cannot be offered, with why (cf/src/runtime.ts `unofferedMounts`). */
  unoffered?: ReadonlyArray<{ alias: string; plugin: string; reason: "switched_off" | "plugin_unavailable" }>;
}

const AGAIN = "Retrying the same call will not help.";
const LIST = "The tools you can call are the ones in your tool list.";
const quoted = (s: string) => JSON.stringify(s);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Why there is no tool named `name`, in words the model can act on. In order: a name the mount's plugin
 * retired (renamed: what to call instead; removed: that nothing replaced it), a name the mount's tool list
 * left out (its recorded reason), and otherwise that the mount — or no mount — has a tool by that name.
 *
 * The mount is the one whose alias, as it appears in a model-facing name, is the longest prefix of `name`
 * followed by `__` — never a split at the first `__`, since an alias stored before `MOUNT_ALIAS` may contain
 * one (`runJsTool`'s `aliasOf` reads names the same way).
 */
export function explainUnavailableTool(name: string, ctx: UnavailableToolContext): string {
  const mounts = ctx.mounts.map((m) => ({ m, a: modelName(m.alias) }));
  const unoffered = (ctx.unoffered ?? []).map((u) => ({ u, a: modelName(u.alias) }));
  let best: { a: string; m?: ExplainedMount; u?: (typeof unoffered)[number]["u"] } | null = null;
  for (const { m, a } of mounts) if (name.startsWith(`${a}__`) && (!best || a.length > best.a.length)) best = { a, m };
  for (const { u, a } of unoffered) if (name.startsWith(`${a}__`) && (!best || a.length > best.a.length)) best = { a, u };

  if (best?.u) {
    const why = best.u.reason === "switched_off" ? switchedOffMessage(best.u.alias) : pluginUnavailableMessage(best.u.alias, best.u.plugin);
    return `${sentence(why)}, so ${quoted(name)} cannot be called. ${AGAIN}`;
  }
  if (!best?.m) {
    const cut = name.indexOf("__");
    return cut > 0
      ? `No mount has the alias ${quoted(name.slice(0, cut))}, so there is no tool named ${quoted(name)}. ${AGAIN} ${LIST}`
      : `There is no tool named ${quoted(name)}. ${AGAIN} ${LIST}`;
  }
  const mount = best.m;
  const alias = mount.alias;
  // Why the mount's list leaves out the tool the model calls `shown`: an entry naming it, else one that stands
  // for every tool of the plugin (`SkippedTool.every`) when `shown` is one of the plugin's tools.
  const skipFor = (shown: string) => {
    const skipped = mount.toolSnapshot?.skipped ?? [];
    return skipped.find((s) => !s.every && modelToolName(alias, s.name) === shown)?.reason ??
      (mount.plugin?.tools?.some((t) => modelToolName(alias, t.name) === shown) ? skipped.find((s) => s.every)?.reason : undefined);
  };

  const retired = Object.entries(mount.plugin?.retired ?? {}).find(([old]) => modelToolName(alias, old) === name);
  if (retired) {
    const [, next] = retired;
    if (next === null) {
      return `There is no tool named ${quoted(name)} any more: the \`${alias}\` mount no longer offers it, and no other tool replaced it. ${AGAIN} ${LIST}`;
    }
    const shown = ctx.offered.find((t) => t.address === `${alias}.${next}`)?.name;
    if (shown) {
      return `There is no tool named ${quoted(name)} any more: the \`${alias}\` mount renamed it to ${shown}. Call ${shown} instead. ${AGAIN}`;
    }
    const why = skipFor(modelToolName(alias, next));
    return `There is no tool named ${quoted(name)} any more: the \`${alias}\` mount renamed it to ${modelToolName(alias, next)}, ` +
      `which this mount does not offer you${why ? ` (${why})` : ""}. ${AGAIN} ${LIST}`;
  }
  const skipped = skipFor(name);
  if (skipped) return `The \`${alias}\` mount does not offer ${quoted(name)} to you: ${skipped}. ${AGAIN} ${LIST}`;
  return `The \`${alias}\` mount has no tool named ${quoted(name)}. ${AGAIN} ${LIST}`;
}

// ---- recognising pi's own result ------------------------------------------------------------------

/** pi-agent-core 0.85.1's text for a call to a tool it does not have (dist/harness/execution/tools.js `prepareToolCall`). */
export const piUnavailableText = (name: string) => `Tool ${JSON.stringify(name)} is unavailable`;

/** The message pi-durable 1.0.0 puts on its `tool_unavailable` result (dist/harness/tool.js and generation.js). */
export const pdUnavailableMessage = (name: string) => `Tool ${name} is not available`;
/** pi-durable's code for that result (dist/harness/tool.js `harnessError`). */
export const PD_UNAVAILABLE_CODE = "tool_unavailable";
/** That result's text as the model reads it: pi-durable renders its diagnostics in a block (tool.js `renderDiagnostics`). */
export const pdUnavailableText = (name: string) => `<harness>\n[error] ${pdUnavailableMessage(name)}\n</harness>`;

type ResultLike = { role?: unknown; toolName?: unknown; toolCallId?: unknown; isError?: unknown; details?: unknown; content?: unknown };

/** A tool result whose whole content is `text(its own tool name)`, an error with no details, for a tool not offered now. */
function shapedLike(m: ResultLike, current: ReadonlySet<string>, text: (name: string) => string): m is ResultLike & { toolName: string } {
  if (m?.role !== "toolResult" || m.isError !== true || m.details !== undefined) return false;
  if (typeof m.toolName !== "string" || current.has(m.toolName)) return false;
  const c = m.content as Array<{ type?: unknown; text?: unknown }> | undefined;
  return Array.isArray(c) && c.length === 1 && c[0]?.type === "text" && c[0].text === text(m.toolName);
}

/** pi-agent-core's unknown-tool result: see the header for why the shape is enough there. */
export const isPiUnavailableResult = (m: unknown, current: ReadonlySet<string>) => shapedLike(m as ResultLike, current, piUnavailableText);

/**
 * A pi-durable result that looks like its unknown-tool result. Not enough alone: a tool's thrown message is
 * an error result with no details too, so the engine also asks the entry (`isPdUnavailableEntry`).
 */
export const looksPdUnavailable = (m: unknown, current: ReadonlySet<string>) => shapedLike(m as ResultLike, current, pdUnavailableText);

/**
 * A pi-durable entry is its unknown-tool result: a `pi.tool-result` whose only diagnostic is `tool_unavailable`
 * with pi-durable's message, and whose model message carries that text. A tool of ours records no diagnostic
 * (src/runtime/durable-tools.ts), so a real tool's result is never this.
 */
export function isPdUnavailableEntry(record: unknown): boolean {
  const r = record as { kind?: unknown; model?: unknown; data?: { diagnostics?: unknown } } | null;
  if (r?.kind !== "pi.tool-result" || !Array.isArray(r.model) || r.model.length !== 1) return false;
  const m = r.model[0] as ResultLike;
  const d = r.data?.diagnostics as Array<{ severity?: unknown; code?: unknown; message?: unknown }> | undefined;
  return typeof m?.toolName === "string" && Array.isArray(d) && d.length === 1 &&
    d[0]?.severity === "error" && d[0].code === PD_UNAVAILABLE_CODE && d[0].message === pdUnavailableMessage(m.toolName) &&
    shapedLike(m, new Set(), pdUnavailableText);
}

/**
 * `messages` with the content of each result `isPi` accepts replaced by `explain(its tool name)`; the same
 * array when there is none, so a request with nothing to explain is untouched. Nothing else of a message moves.
 */
export function explainUnavailableResults<M>(messages: readonly M[], isPi: (m: M) => boolean, explain: (name: string) => string): readonly M[] {
  let out: M[] | null = null;
  messages.forEach((m, i) => {
    if (!isPi(m)) return;
    out ??= messages.slice();
    out[i] = { ...m, content: [{ type: "text", text: explain(String((m as ResultLike).toolName)) }] };
  });
  return out ?? messages;
}
