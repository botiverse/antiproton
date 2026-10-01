/**
 * Mounts, as tools pi's harness can call.
 *
 * The gateway stays exactly where it was. A pi tool is a function, so the
 * function body is the gateway call — the harness gains no way out that the
 * previous one did not have, and every check that made the gateway the only
 * exit still runs on the same path. What changes is only who asks.
 *
 * Two things the old harness could not express come free here:
 *
 * `replay` is pi's answer to an effect whose durable intent exists but whose
 * outcome is unknown — an invocation the platform cancelled between the call
 * and its result. We already recorded enough to decide it and never used it: a
 * read is always safe to repeat, a write is safe only if the plugin can make it
 * idempotent itself, and everything else must not be repeated.
 *
 * `details` carries the operation id and status to the transcript without
 * putting them in front of the model.
 */
import type { AgentHarnessTool } from "@earendil-works/pi-agent-core";
import { pluginUnavailableMessage, switchedOffMessage } from "./gateway.ts";
import type { Json } from "../core/types.ts";
import type { Continuation, HeldCall, Paused } from "../core/execution.ts";
import type { ToolInterrupt } from "../core/tools.ts";
import {
  answerProblem, answerSpecOf, type AnswerSpec, type InterruptHost, type RunJsContinuations,
} from "./run-js-resume.ts";

/** What the model is offered, and the mount-qualified address behind it. */
export interface MountedTool {
  name: string;
  description: string;
  parameters: Json;
  /** `alias.tool` — what the gateway resolves. Never shown to the model. */
  address: string;
  /**
   * Required here, as it is on `ToolSchema`, because the whole runtime branches
   * on it and every branch is permissive on the read side: `replayPolicy` lets
   * a read repeat, `policyFor` applies the mount's read policy, and the
   * idempotency guard only protects a write from a duplicate operation id.
   *
   * It was optional, and `replayPolicy` filled the gap with `?? "read"` — so a
   * tool that did not say became a tool that repeats safely. Nothing reached
   * that default, since every mounted tool is built from a `ToolSchema` where
   * the field is required; it was waiting for a tool list that comes from
   * somewhere else, which is exactly what an MCP server is. Required is better
   * than a safe default: a default is a second place to state the rule, and the
   * adapter that fills this in is then made to decide rather than inherit.
   *
   * When the far end does not say, write `write`. Being required makes someone
   * choose; it does not say which way to choose, and the cost is not symmetric
   * — all three branches are the permissive ones on the read side. A write
   * taken for a read skips the mount's approval and is no longer stopped from
   * repeating; a read taken for a write costs one approval and the ability to
   * replay after a cancelled call (Piper, 2026-09-12).
   */
  sideEffects: "read" | "write";
  idempotency?: "native" | "key" | "none";
  /** Set when the plugin's mount owns a shared resource, so its calls must not
   *  overlap. pi executes a turn's tool calls in parallel by default. */
  exclusive?: boolean;
  /** Carried from {@link ToolSchema}: this tool can hand back a result the
   *  runtime parked. Carried rather than re-derived, because the runtime used
   *  to find the reader by rebuilding the string `artifacts` + `.read`, which
   *  a rename of either silently broke. */
  reads?: "parked-result";
}

export interface ToolResult {
  status: string;
  operationId?: string;
  result?: unknown;
  error?: { code?: string; message?: string } | string;
  /** With `status: "interrupted"`: the tool's question, `state` included — kept host-side, never shown. */
  interrupt?: ToolInterrupt;
}

export interface ToolHost {
  /** `callId` is the model's id for this tool call, passed to be RECORDED. It is
   *  not `opts.idempotencyKey`: one call can make several requests. */
  invoke(call: { tool: string; args: Json; opts?: unknown; callId?: string }): Promise<ToolResult>;
  /**
   * A checked answer to a question a tool asked, delivered to its plugin
   * (gateway `resumeInterrupt`); `callId` is the resume call's. Absent: no
   * tool's question can be answered through this host, so one is cancelled
   * at once and the model told so.
   */
  resumeInterrupt?(i: ToolInterrupt, answer: Json, callId: string): Promise<ToolResult>;
  /** The tool is told nobody will answer (gateway `cancelInterrupt`); why that failed, or null. */
  cancelInterrupt?(i: ToolInterrupt): Promise<string | null>;
}

/** Where a tool's question is kept for `resume`, and whose model may answer it. */
export interface InterruptKeeping {
  continuations: RunJsContinuations;
  scope: string;
}

/**
 * Providers restrict what a tool may be called: `^[a-zA-Z0-9_-]+$`, no dots.
 * Plugin authors do not know that, and two of ours name tools `repos.get` and
 * `issues.list`, which the provider rejects with a 400 for the whole request —
 * one badly named tool anywhere in the catalogue stops every call.
 */
const modelName = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, "_");

/** Providers cap a tool name; 64 is the smallest cap among the ones we target. */
const MAX_NAME = 64;

/**
 * Model-facing names must be unique, because that is all the model can say —
 * and they must be *stable*, because the model writes them down.
 *
 * Bare API names are unique inside one service and collide across several:
 * `show_profile` exists in ten of AppWorld's apps. This used to qualify only
 * what actually clashed, which made a bare name friendlier and made every name
 * a function of the whole mounted set: mounting `web`, which has a `get`,
 * renamed the memory plugin's `get` to `state__get`. So an operator attaching an
 * unrelated mount could invalidate an agent's own note about which tool to call,
 * and nothing anywhere would report it. A name that can change for a reason
 * outside the tool is not a name.
 *
 * So every tool is qualified, always. `<alias>__<tool>` is one deterministic
 * string that depends on this mount alone, and it is the same string discovery
 * hands back — `builtin.ts` reads this function rather than formatting its own.
 * The dotted `address` is untouched: that is the gateway's dispatch key and the
 * model never sees it.
 *
 * **Changing what this returns is a migration, not a relabel.** pi records the
 * tool names a session was opened with (`activeToolNames` on the generation's
 * configuration) and checks them against the registered tools before every run:
 *
 *     harness/runtime/drive/generation.js  prepareGeneration()
 *       missingTools = activeToolNames.filter((n) => !toolsByName.has(n))
 *       if (missingTools.length) → configuration_failure
 *                                  "configured_tools_unavailable"
 *
 * So a rename orphans every session opened before it: the message is accepted
 * and durable, the run fails at admission, and nothing calls the model. That is
 * what always-qualifying did on 11 September 2026 — every agent whose session
 * predated the deploy stopped answering, while agents created after it were
 * fine, which is also why two benchmark runs on fresh objects showed nothing.
 * A rename needs the stored names reconciled with the current ones when the
 * harness opens; benchmarks cannot see whether that reconciliation exists,
 * because they never carry a session older than the code.
 *
 * Sanitising happens first, because it can create a clash that did not exist in
 * the plugin's own names. Two names can still meet at the cap, so the last step
 * is a deterministic tie-break rather than a silent collapse — two tools sharing
 * one name is the one outcome the model cannot work around.
 *
 * **Applying this twice must equal applying it once.** Two call sites qualify
 * the same catalogue — the runtime builds it, and `bridgeTools` qualifies
 * whatever it is handed so a caller cannot pass a provider a name with a dot in
 * it. Under the old collision-only rule the second pass was a no-op on an
 * already-unique name; under this one it re-prefixed, and a τ² run went out
 * with `retail__retail__get_order_details` in front of the model. So a name
 * that already belongs to its own mount is left exactly as it is — and it still
 * takes its place in `used`, so it cannot be handed out twice.
 */
/**
 * Does this agent actually have a tool from this plugin?
 *
 * Asked by plugin and answered from the offered tool list, because the two
 * obvious shortcuts are each wrong in one direction. An alias is the person's
 * word for a mount — artifacts mounted as `files` would lose the prompt
 * paragraph that says results can be parked, and anything mounted as
 * `artifacts` would gain it — so the alias cannot be the question. And the
 * mount list alone would answer yes for a tool withheld from the model, which
 * is what that paragraph exists to avoid: telling an agent to use a tool it
 * was not given is a wrong instruction competing with the right ones (Piper,
 * 2026-09-12).
 *
 * It was written for the prompt, which asked whether an artifacts tool was
 * really mounted before telling the agent it could read results back. That
 * paragraph belongs to the artifacts plugin now, so the prompt no longer asks;
 * the caller today is the offload path, which parks a large result as a
 * reference only where something can open one and truncates honestly where
 * nothing can (cf/src/runtime.ts). "What was the model actually offered" is
 * the general form of a question three defects have turned on, which is why it
 * is a function rather than an expression.
 */
export function offersPlugin(
  records: Array<{ alias: string; plugin: string }>,
  tools: MountedTool[],
  plugin: string,
): boolean {
  const pluginOf = new Map(records.map((m) => [m.alias, m.plugin]));
  return tools.some((t) => pluginOf.get(t.address.split(".")[0]!) === plugin);
}

/**
 * What the model was told to call this mount's tool, or null if it was not offered.
 *
 * The third form of the same question. It is a function, and it lives beside
 * the qualifier that decides the name, because every caller that rebuilt the
 * string instead was wrong in a way nothing catches: qualification sanitises
 * the alias and a collision takes a numeric suffix, so `${alias}__release` can
 * be another mount's tool — which resolves, and calls it (Piper, Dora,
 * 2026-09-12). A withheld tool has no address in the catalogue at all, so null
 * here is the fact that the model cannot call it, and a message built from this
 * does not tell it to.
 *
 * `address` is the join, not `name`: the address is `alias.tool` and never
 * shown, and it is the only thing on a mounted tool that survives qualification
 * unchanged.
 */
export function offeredToolName(tools: readonly MountedTool[], alias: string, tool: string): string | null {
  return tools.find((t) => t.address === `${alias}.${tool}`)?.name ?? null;
}

/**
 * The same question as {@link offersPlugin}, asked of a capability instead of a name.
 *
 * A name answers "is this particular plugin here"; the kernel almost never
 * wants that — it wants "can anything here do X". Asking by name means the
 * answer stops being true the moment a second plugin can do the same thing,
 * and nothing fails when it does: the feature just silently is not offered.
 */
export function offersCapability(
  records: Array<{ alias: string; plugin: string }>,
  tools: MountedTool[],
  can: (plugin: string) => boolean,
): boolean {
  const pluginOf = new Map(records.map((m) => [m.alias, m.plugin]));
  return tools.some((t) => {
    const id = pluginOf.get(t.address.split(".")[0]!);
    return id !== undefined && can(id);
  });
}

export function qualifyMountedTools<T extends MountedTool>(tools: T[]): T[] {
  const used = new Set<string>();
  return tools.map((t) => {
    const alias = modelName(t.address.split(".")[0]!);
    // Recognised by the prefix rather than by re-deriving the whole string,
    // because a name that went through the tie-break no longer equals what a
    // second derivation would produce.
    if (t.name.startsWith(`${alias}__`)) {
      used.add(t.name);
      return t;
    }
    const bare = modelName(t.name);
    const room = Math.max(1, MAX_NAME - alias.length - 2);
    let name = `${alias}__${bare.slice(0, room)}`;
    for (let n = 2; used.has(name); n++) {
      const tag = String(n);
      name = `${name.slice(0, MAX_NAME - tag.length)}${tag}`;
    }
    used.add(name);
    return t.name === name ? t : { ...t, name };
  });
}

/** A read repeats safely; a write repeats only if the plugin makes it so. */
export function replayPolicy(t: MountedTool): "never" | "safe" {
  if (t.sideEffects === "read") return "safe";
  return t.idempotency === "native" ? "safe" : "never";
}

export function bridgeTools(
  tools: MountedTool[],
  host: ToolHost,
  /** Where a tool's question waits for `resume`. Absent: a question is cancelled and the model told why. */
  keeping?: InterruptKeeping,
): AgentHarnessTool<undefined>[] {
  return qualifyMountedTools(tools).map((t) => ({
    name: t.name,
    label: t.name,
    description: t.description,
    parameters: t.parameters as any,
    replay: replayPolicy(t),
    // pi runs a turn's tool calls in parallel unless a tool says otherwise, and
    // a plugin whose mount owns one container cannot survive that.
    ...(t.exclusive ? { executionMode: "sequential" as const } : {}),
    async execute(toolCallId: string, params: Json) {
      // A tool that declares `confirm` itself owns the word; only tools that
      // do not are eligible for the agent's hold. Today none declares it, so
      // this changes nothing — it keeps an appworld catalogue that grows a
      // `confirm` parameter tomorrow from losing it silently.
      const lifted = declaresConfirm(t.parameters) ? { args: params, confirm: false } : liftConfirm(params);
      // The model's id for this call travels with it, so the operation it starts can be lined up
      // with the `tool.result` the console already pairs by that same id (cf/src/ui.ts).
      const res = await host.invoke({ tool: t.address, args: lifted.args, callId: toolCallId, ...(lifted.confirm ? { opts: { confirm: true } } : {}) });
      return deliverToolResult(res, { name: t.name, address: t.address, callId: toolCallId, host, keeping });
    },
  })) as AgentHarnessTool<undefined>[];
}

/**
 * One tool result as the model receives it: from a direct call, or from
 * `resume` taking a tool's question back to it. The two answer in one shape,
 * so a resumed tool reads exactly like a call — a result, a refusal, or
 * another question.
 */
async function deliverToolResult(res: ToolResult, o: {
  name: string; address?: string; callId: string; host: ToolHost; keeping?: InterruptKeeping; inProgram?: boolean;
}) {
  if (res.status === "interrupted" && res.interrupt) {
    return toolQuestion(res.interrupt, { ...o, operationId: res.operationId });
  }
  if (res.status !== "succeeded") {
    // pi asks tools to throw rather than encode failure in content, so the
    // harness can tell a refusal from an answer.
    const e = res.error;
    const message = typeof e === "string" ? e : (e?.message ?? e?.code ?? res.status);
    // The model reads this, so it is named the way the model can name it
    // back. The address is still in `details`, where the transcript and the
    // audit record want it.
    throw new Error(`${o.name}: ${message}`);
  }
  // A question asked inside a program ended it; the answer's result comes
  // back here, not into the program, and the model has to know that.
  const shown = o.inProgram
    ? { tool: o.name, result: res.result ?? null, note: AFTER_PROGRAM_NOTE }
    : res.result ?? null;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(shown) }],
    details: { ...(o.address ? { address: o.address } : {}), operationId: res.operationId },
  };
}

/**
 * A tool's question, put to the model: held for `resume` under a token, in
 * the same `yielded` shape a program's pause has. `state` stays in the
 * registry entry and is never in what this returns.
 *
 * With nowhere to keep it, or no way to deliver an answer, the question is
 * cancelled at once and the model is shown it with a note that nothing was
 * done: a token that nothing can redeem would be an invitation to wait.
 */
async function toolQuestion(i: ToolInterrupt, o: {
  name: string; callId: string; host: ToolHost; keeping?: InterruptKeeping; inProgram?: boolean;
  operationId?: string; extra?: Record<string, unknown>;
}) {
  const asked = answerSpecOf(i.answer);
  const resumeInterrupt = o.host.resumeInterrupt;
  if (!("spec" in asked) || !o.keeping || !resumeInterrupt) {
    const failed = await cancelQuietly(o.host, i);
    const answer = {
      state: "interrupted", tool: o.name, question: i.question,
      ...(i.context !== undefined ? { context: i.context } : {}),
      ...(o.extra ?? {}),
      note: "The tool asked you this before acting, but it cannot be answered here (no resume), so it was " +
        "dropped and the tool did nothing. Call it again if it still applies." + (failed ? ` Dropping it reported: ${failed}` : ""),
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(answer) }], details: { interrupted: true, resumable: false, operationId: o.operationId } };
  }
  const interruptHost: InterruptHost = {
    resumeInterrupt: (x, a, callId) => resumeInterrupt.call(o.host, x, a, callId),
    cancelInterrupt: (x) => cancelQuietly(o.host, x),
  };
  const h = o.keeping.continuations.hold({
    kind: "tool", scope: o.keeping.scope, callId: o.callId, tool: o.name, question: i.question, answer: asked.spec,
    interrupt: i, host: interruptHost, ...(o.inProgram ? { inProgram: true } : {}),
  });
  const answer = yielded({
    question: i.question, token: h.token, expiresAt: h.expiresAt, answer: asked.spec,
    extra: { tool: o.name, ...(i.context !== undefined ? { context: i.context } : {}), ...(o.extra ?? {}) },
    note: o.inProgram ? TOOL_IN_PROGRAM_NOTE : TOOL_QUESTION_NOTE,
  });
  return {
    content: [{ type: "text" as const, text: JSON.stringify(answer) }],
    details: { interrupted: true, resumable: true, operationId: o.operationId },
  };
}

/** A cancel is the end of something; its failure is a line for the model, never a throw. */
async function cancelQuietly(host: ToolHost, i: ToolInterrupt): Promise<string | null> {
  try { return (await host.cancelInterrupt?.(i)) ?? null; } catch (e) { return String((e as Error)?.message ?? e).slice(0, 300); }
}

/**
 * JavaScript in the sandbox, as one more tool.
 *
 * In the previous harness this was a command the loop emitted and the kernel
 * dispatched. As a pi tool it is just a function, and the interesting property
 * is unchanged and in fact easier to see: the script reaches the same gateway
 * the model reaches directly, through the same host, so the sandbox gains no
 * exit of its own.
 *
 * `replay: "never"` — a script is arbitrary, so an execution whose outcome was
 * lost must not be repeated on the agent's behalf.
 */
export interface Sandbox {
  execute(source: string, host: { invoke(call: any): Promise<any> }, limits?: unknown): Promise<{
    /** An execution's own vocabulary (`ExecutionResult`), which is not a tool
     *  call's. A `string` here let this tool test for a tool call's
     *  "succeeded" — a word no executor has ever returned — so every script
     *  that ran to completion was reported to the model as a failure. */
    status: "completed" | "failed" | "interrupted" | "paused";
    outputs?: unknown[];
    error?: unknown;
    hostCalls?: number;
    acceptedOperationIds?: string[];
    pause?: Paused;
    held?: HeldCall[];
    /** A program waiting at `await pause(...)`, resumable (core/execution.ts). */
    continuation?: Continuation;
  }>;
}

/**
 * The one word the model may add to any call: `confirm: true` asks for a
 * person's approval before the call runs. It is lifted out here, at the
 * boundary where the model's arguments become the gateway's call, and travels
 * as an option — so no plugin ever sees it, and no plugin's own parameter
 * named `confirm` is ever mistaken for it once it is past this point. Only a
 * literal `true` counts; anything else is an ordinary argument.
 */
export function declaresConfirm(parameters: unknown): boolean {
  const props = (parameters as { properties?: Record<string, unknown> } | null)?.properties;
  return !!props && Object.prototype.hasOwnProperty.call(props, "confirm");
}

export function liftConfirm(args: Json): { args: Json; confirm: boolean } {
  if (args && typeof args === "object" && !Array.isArray(args) && (args as Record<string, unknown>).confirm === true) {
    const { confirm: _c, ...rest } = args as Record<string, Json>;
    return { args: rest, confirm: true };
  }
  return { args, confirm: false };
}

export const RUN_JS_DESCRIPTION =
  "Execute JavaScript in a sandbox that calls your tools. The default whenever more than one " +
  "tool call is involved: chain calls, loop, filter or project fields in one program instead of " +
  "separate calls, and output() only what you need. Not for a single simple call. " +
  "Where the program needs your judgement, `const answer = await pause(question, data, expected?)`: " +
  "it stops there and asks you (state \"yielded\", with a token and what it did so far); call " +
  "resume(token, answer) within about a minute and the program continues from that line with your answer. " +
  "A tool the program calls may also ask you a question (\"yielded\" naming the tool): the program ends " +
  "at that call, and resume answers the tool.";

export const RESUME_DESCRIPTION =
  "Answer something waiting for you (a \"yielded\" result): a run_js program at `await pause(...)`, or " +
  "a tool that asked you a question before acting. Give the token and your answer. A program goes on from " +
  "its pause with your answer as pause()'s value, and you get its result as run_js would give it; a tool " +
  "goes on with your answer and you get its result. Either may yield again, with another token. " +
  "If the yielded result names an expected `answer` (choices, yes_no, text or a schema) your answer " +
  "must fit it; one that does not is refused with invalidAnswer and the same token stays valid. " +
  "cancel: true ends a program (returning its outputs) or drops a tool's question (the tool does nothing). " +
  "Several can be waiting at once, each with its own token. A token lasts about a minute; if it expired or " +
  "the agent restarted you are told so, and you call again (a new run_js program, or the tool). Only you " +
  "can call this: a program cannot resume another.";

/** What the model is told with a tool's question. */
export const TOOL_QUESTION_NOTE =
  "The tool asked you this before acting and has done nothing yet. Decide, then call resume with this token " +
  "and an answer that fits `answer`, within about a minute: the tool goes on with your answer and its result " +
  "comes back as resume's result. resume with cancel: true drops it and the tool does nothing. If the token " +
  "has expired you are told so; then call the tool again if it still applies.";

/**
 * What the model is told when a tool called inside run_js asks a question.
 *
 * The program does not wait at that call: the executors suspend a program
 * only at its own `await pause()`, and a tool call's await is not one. So the
 * program ends there, as it does at a held call, and the question is the
 * model's to answer directly; the tool's result comes back as resume's
 * result, and the rest of the program is a new one.
 */
export const TOOL_IN_PROGRAM_NOTE =
  "A tool your program called asked you this before acting; the tool has done nothing yet. Your program " +
  "ended at that call: nothing after it ran, and calls before it completed and are not undone. Call resume " +
  "with this token and an answer that fits `answer`, within about a minute: the tool goes on with your " +
  "answer and its result comes back as resume's result, not into the program. Then send a new run_js " +
  "program for the rest, carrying what you need from soFar. resume with cancel: true drops it and the tool " +
  "does nothing.";

/** With a resumed tool's result when the question was asked inside a program. */
export const AFTER_PROGRAM_NOTE =
  "This is that tool call's result. The program that made the call ended there; send a new run_js program " +
  "for whatever came after it.";

/** What `resume` answers for a token it cannot find: never an error, because a new program is always a way on. */
export const EXPIRED_NOTE =
  "this continuation is gone (expired, already answered, or the agent restarted); nothing more ran. For a " +
  "program, send a new run_js program carrying what you need from the earlier data/outputs; for a tool's " +
  "question, call the tool again";

/**
 * What the model is told when a run stops paused. Not an error: the program
 * did what it was asked, or a call is waiting on a person, and either way the
 * next move is the model's. `resumable` is the program waiting in memory for
 * `resume`; otherwise it has ended.
 */
export function pausedNote(p: Paused, held: readonly HeldCall[], resumable = false): string {
  const rest = "Calls made before that point completed and are not undone.";
  if (p.cause === "hold") {
    return "This call is waiting for the person's approval; if they approve it, it runs on its own exactly " +
      "as written. The rest of your program did not run, and there is nothing to resume: a held call " +
      "ends the program. " + rest + " Decide whether to continue without it, wait, or tell the person.";
  }
  if (resumable) {
    return "The program is waiting at your pause(); nothing after that line has run yet. " + rest +
      " Think (other calls in between are fine), then call resume with this token within about a minute: " +
      "your answer becomes pause()'s return value and the program continues from that line. Where the " +
      "result has `answer`, give one that fits it; one that does not is refused and the token stays valid. " +
      "resume with cancel: true ends it. If the continuation has expired you will be told so; then send a " +
      "new run_js program, carrying what you need from data and soFar.";
  }
  const also = held.length
    ? ` ${held.length === 1 ? "A call is" : `${held.length} calls are`} also waiting for the person's approval ` +
      "(see held); approved, each runs on its own exactly as written."
    : "";
  return "The program stopped where you called pause(); nothing after that line ran. " + rest +
    " Think, then send a new run_js program to continue — carry what you need from data and outputs, " +
    "because a new run starts from nothing." + also;
}

type RunResult = Awaited<ReturnType<Sandbox["execute"]>>;

/** A question one of a program's tool calls was asked, with where its answer goes. */
interface Asked {
  /** The tool as the program named it. */
  name: string;
  operationId: string;
  interrupt: ToolInterrupt;
  host: ToolHost;
}

/**
 * The questions one program's tool calls were asked, collected as they come
 * back and drained when a stretch of the program is reported (deliverRun).
 *
 * `closed` once a stretch has been reported and no program is left waiting:
 * a call can still come back after that (a Dynamic Worker's call outstanding
 * when the program ended, or one that outlived a run stopped for time), and
 * a question arriving then has nobody to put it to, so it is dropped at once
 * rather than collected where nothing will ever read it.
 */
interface AskedList { items: Asked[]; closed: boolean }

/** Usage callbacks shared by run_js and resume: one program's stretches are counted as they run. */
interface RunCounting {
  onCalls?: (n: number) => void | Promise<void>;
  /** Every stretch of a program, however it ended: for the usage count. `resumed` is a
   *  stretch after a resume, which is not a new run. A failure here does not fail the run. */
  onRun?: (run: { ok: boolean; ms: number; hostCalls: number; resumed?: boolean }) => void | Promise<void>;
}

/**
 * One stretch of a program, as the model receives it: from run_js, or from a
 * resume. The two answer in one shape, so a resumed program reads exactly like
 * a run — a pause, the outputs, or a failure.
 */
async function deliverRun(r: RunResult, o: {
  label: "run_js" | "resume";
  callId: string;
  started: number;
  /** Counts at the start of this stretch: a resumed program's results are cumulative. */
  before: { hostCalls: number; operations: number };
  counting: RunCounting;
  continuations?: RunJsContinuations;
  scope: string;
  cancelling?: boolean;
  /** Questions the program's tool calls were asked, as they came back (runJsTool). Drained here. */
  asked?: AskedList;
}) {
  const hostCalls = r.hostCalls ?? 0;
  const operations = r.acceptedOperationIds ?? [];
  const newCalls = Math.max(0, hostCalls - o.before.hostCalls);
  const resumed = o.label === "resume";
  try {
    // A paused or cancelled run did what it was asked, so it counts as one that went well.
    const ok = r.status === "completed" || r.status === "paused" || (o.cancelling === true && r.status === "interrupted");
    await o.counting.onRun?.({ ok, ms: Date.now() - o.started, hostCalls: newCalls, ...(resumed ? { resumed } : {}) });
  } catch { /* the count is lost, the run is not */ }
  await o.counting.onCalls?.(newCalls);
  const details = {
    hostCalls, operations: resumed ? operations.slice(o.before.operations) : operations,
    ...(resumed ? { callId: o.callId } : {}),
  };
  // A tool the program called asked a question. The executor saw that call
  // come back pending and ended the program there, as it ends one at a held
  // call; what it ended on is a question for the model, not a person, so it
  // is reported as one and kept out of `held`.
  // Closed from here unless a program is held below: anything that comes
  // back after this drain is past the point where it could be reported.
  if (o.asked) o.asked.closed = true;
  const asked = o.asked?.items.splice(0) ?? [];
  if (asked.length) {
    const ids = new Set(asked.map((a) => a.operationId));
    const held = (r.held ?? []).filter((h) => !ids.has(h.operationId));
    if (r.continuation) {
      // Not reachable today (a pending call means no continuation), but a
      // program left waiting while its question is answered elsewhere would
      // be one nobody resumes.
      try { await r.continuation.cancel(); } catch { /* ended already */ }
    }
    if (r.status !== "paused") {
      // Ended some other way (a limit, a failure) after the question came
      // back: nobody is asked, the tools are told so, and the run is
      // reported as what it was.
      for (const a of asked) await cancelQuietly(a.host, a.interrupt);
    } else {
      const [first, ...rest] = asked;
      // One question at a time: each token is one decision, and a model asked
      // two at once from one program would be answering them out of context.
      for (const a of rest) await cancelQuietly(a.host, a.interrupt);
      const out = await toolQuestion(first!.interrupt, {
        name: first!.name, callId: o.callId, host: first!.host, inProgram: true, operationId: first!.operationId,
        ...(o.continuations ? { keeping: { continuations: o.continuations, scope: o.scope } } : {}),
        extra: {
          soFar: { outputs: r.outputs ?? [], calls: hostCalls },
          held,
          ...(rest.length ? { alsoAsked: rest.map((a) => ({ tool: a.name, question: a.interrupt.question, dropped: true })) } : {}),
          ...(r.pause?.cause === "pause" ? { programPause: { question: r.pause.reason, data: r.pause.data, resumable: false } } : {}),
        },
      });
      return { content: out.content, details: { ...details, ...out.details, paused: true, held } };
    }
  }
  if (r.status === "paused" && r.pause) {
    const held = r.held ?? [];
    if (r.continuation && o.continuations) {
      // What the program said it expects back, understood once here and kept
      // with the continuation, so resume checks the answer against the same thing.
      const asked = r.pause.answer !== undefined ? answerSpecOf(r.pause.answer) : null;
      const spec = asked && "spec" in asked ? asked.spec : undefined;
      const specError = r.pause.answerError ?? (asked && "error" in asked ? asked.error : undefined);
      if (o.asked) o.asked.closed = false;
      const h = o.continuations.hold({
        continuation: r.continuation, scope: o.scope, callId: o.callId,
        hostCalls, operations: operations.length, question: r.pause.reason, ...(spec ? { answer: spec } : {}),
        ...(o.asked ? { asked: o.asked } : {}),
      });
      const answer = yielded({
        question: r.pause.reason, token: h.token, expiresAt: h.expiresAt, answer: spec,
        extra: {
          data: r.pause.data,
          ...(r.pause.dataError ? { dataError: r.pause.dataError } : {}),
          ...(specError ? { answerError: specError } : {}),
          // Under soFar only: the outputs are the bulk of a result, and once is enough.
          soFar: { outputs: r.outputs ?? [], calls: hostCalls },
          held,
        },
        note: pausedNote(r.pause, held, true),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(answer) }],
        details: { ...details, paused: true, held, resumable: true },
      };
    }
    if (r.continuation) {
      // Nowhere to keep it: end it now, so it ends the way a pause did before.
      try { await r.continuation.cancel(); } catch { /* ended already */ }
    }
    const answer = {
      paused: true,
      reason: r.pause.reason,
      data: r.pause.data,
      ...(r.pause.dataError ? { dataError: r.pause.dataError } : {}),
      outputs: r.outputs ?? [],
      calls: hostCalls,
      held,
      note: pausedNote(r.pause, held),
    };
    return {
      content: [{ type: "text" as const, text: JSON.stringify(answer) }],
      details: { ...details, paused: true, held },
    };
  }
  if (o.cancelling && r.status === "interrupted" && (r.error as { code?: string } | undefined)?.code === "cancelled") {
    const answer = {
      cancelled: true,
      outputs: r.outputs ?? [],
      calls: hostCalls,
      held: r.held ?? [],
      note: "The program was ended at its pause(); nothing after that line ran. Calls made before it completed and are not undone.",
    };
    return { content: [{ type: "text" as const, text: JSON.stringify(answer) }], details: { ...details, cancelled: true } };
  }
  // "completed" is the whole of success here. Both executors return it
  // (executor.ts, dynamic-worker-executor.ts); "failed" and "interrupted"
  // are the other two, and each carries its reason.
  if (r.status !== "completed") {
    throw new Error(`${o.label} ${r.status}: ${JSON.stringify(r.error ?? null).slice(0, 300)}`);
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(r.outputs ?? []) }],
    details,
  };
}

/**
 * A program waiting for the model, in one shape wherever it is reported: from
 * run_js, from resume when it pauses again, and from resume refusing an answer
 * that does not fit. `state: "yielded"` is the word; `paused: true` stays for
 * whatever reads #644's shape.
 */
function yielded(o: {
  question: string; token: string; expiresAt: number; answer?: AnswerSpec;
  extra?: Record<string, unknown>; note: string;
}) {
  return {
    state: "yielded" as const,
    paused: true,
    question: o.question,
    ...(o.answer ? { answer: o.answer } : {}),
    token: o.token,
    expiresAt: new Date(o.expiresAt).toISOString(),
    ...(o.extra ?? {}),
    note: o.note,
  };
}

/**
 * run_js and resume, built together so they share one registry and one scope:
 * built apart, a resume tool given another session's scope (or none) answers
 * every token from this one as expired, and nothing else would notice.
 */
export function runJsTools(
  sandbox: Sandbox,
  host: ToolHost,
  opts: Parameters<typeof runJsTool>[2] & { continuations: RunJsContinuations; scope: string },
): [AgentHarnessTool<undefined>, AgentHarnessTool<undefined>] {
  return [
    runJsTool(sandbox, host, opts),
    resumeTool(opts.continuations, { onRun: opts.onRun, onCalls: opts.onCalls, scope: opts.scope }),
  ];
}

/**
 * The model's way back into a program waiting at `await pause(...)`.
 *
 * Offered only beside run_js, and refused from inside a program (runJsTool's
 * invoke): a pause asks the MODEL, so only the model may answer it. The
 * program's later tool calls still go out through run_js's own host, under
 * the run_js call's id and its `${toolCallId}:${n}` numbering, so a resumed
 * program's idempotency keys go on from where it paused.
 */
export function resumeTool(
  continuations: RunJsContinuations,
  opts: RunCounting & { scope?: string } = {},
): AgentHarnessTool<undefined> {
  const scope = opts.scope ?? "";
  return {
    name: "resume",
    label: "resume",
    description: RESUME_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        token: { type: "string", description: "The resume.token from a paused run_js (or resume) result." },
        answer: { description: "Any JSON value: what the program's `await pause(...)` returns." },
        cancel: { type: "boolean", description: "true ends the program instead of continuing it." },
      },
      required: ["token"],
    } as any,
    // A program is arbitrary, so a stretch whose outcome was lost must not be repeated.
    replay: "never",
    async execute(toolCallId: string, params: { token?: unknown; answer?: Json; cancel?: unknown }) {
      const token = typeof params?.token === "string" ? params.token : null;
      const waiting = token === null ? null : continuations.peek(token, scope);
      if (!waiting) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ expired: true, note: EXPIRED_NOTE }) }],
          details: { expired: true },
        };
      }
      const cancelling = params.cancel === true;
      if (waiting.kind === "tool") return answerTool(toolCallId, token!, cancelling, params.answer);
      // Checked before the program sees it, and refused without spending the
      // token: the program is still waiting, so the model can answer again.
      const why = !cancelling && waiting.answer ? answerProblem(waiting.answer, params.answer) : null;
      if (why !== null) {
        const answer = yielded({
          question: waiting.question ?? "", token: token!, expiresAt: waiting.expiresAt, answer: waiting.answer,
          extra: { invalidAnswer: why },
          note: "That answer does not fit what the program asked for, so it was not delivered. The program is " +
            "still waiting at its pause(): call resume again with the same token and an answer that fits, or " +
            "with cancel: true to end it.",
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(answer) }],
          details: { callId: waiting.callId, invalidAnswer: true },
        };
      }
      const s = continuations.take(token!, scope);
      if (!s || s.kind === "tool") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ expired: true, note: EXPIRED_NOTE }) }],
          details: { expired: true },
        };
      }
      const started = Date.now();
      let r: RunResult;
      try {
        r = cancelling ? await s.continuation.cancel() : await s.continuation.resume(params.answer ?? null);
      } catch (e) {
        try { await opts.onRun?.({ ok: false, ms: Date.now() - started, hostCalls: 0, resumed: true }); } catch { /* lost count */ }
        throw e;
      }
      return deliverRun(r, {
        label: "resume", callId: s.callId, started, before: { hostCalls: s.hostCalls, operations: s.operations },
        counting: opts, continuations, scope, cancelling, ...(s.asked ? { asked: s.asked as AskedList } : {}),
      });
    },
  } as AgentHarnessTool<undefined>;

  /**
   * A tool's question, answered. The same three outcomes as a program's: an
   * answer that does not fit is refused and the token kept; cancel tells the
   * tool nobody will answer; a fitting answer goes to the plugin, whose next
   * result — or next question — is this call's result.
   */
  async function answerTool(callId: string, token: string, cancelling: boolean, given: Json | undefined) {
    const waiting = continuations.peek(token, scope);
    if (!waiting || waiting.kind !== "tool") {
      return { content: [{ type: "text" as const, text: JSON.stringify({ expired: true, note: EXPIRED_NOTE }) }], details: { expired: true } };
    }
    const why = !cancelling && waiting.answer ? answerProblem(waiting.answer, given) : null;
    if (why !== null) {
      const answer = yielded({
        question: waiting.question ?? "", token, expiresAt: waiting.expiresAt, answer: waiting.answer,
        extra: {
          tool: waiting.tool,
          ...(waiting.interrupt.context !== undefined ? { context: waiting.interrupt.context } : {}),
          invalidAnswer: why,
        },
        note: "That answer does not fit what the tool asked for, so it was not delivered and the tool has done " +
          "nothing. Call resume again with the same token and an answer that fits, or with cancel: true to drop it.",
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(answer) }], details: { callId: waiting.callId, invalidAnswer: true } };
    }
    const s = continuations.take(token, scope);
    if (!s || s.kind !== "tool") {
      return { content: [{ type: "text" as const, text: JSON.stringify({ expired: true, note: EXPIRED_NOTE }) }], details: { expired: true } };
    }
    if (cancelling) {
      const failed = await (s.host.cancelInterrupt?.(s.interrupt) ?? Promise.resolve(null)).catch((e) => String((e as Error)?.message ?? e));
      const answer = {
        cancelled: true, tool: s.tool,
        note: "Dropped: the tool did nothing." + (failed ? ` Dropping it reported: ${failed}` : ""),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(answer) }], details: { callId: s.callId, cancelled: true } };
    }
    const res = await s.host.resumeInterrupt(s.interrupt, given ?? null, callId) as ToolResult;
    // Its next question, if any, is held as the first was, and reads the same.
    const host: ToolHost = {
      invoke: () => Promise.reject(new Error("not a call")),
      resumeInterrupt: (i, a, c) => s.host.resumeInterrupt(i, a, c) as Promise<ToolResult>,
      ...(s.host.cancelInterrupt ? { cancelInterrupt: s.host.cancelInterrupt } : {}),
    };
    return deliverToolResult(res, {
      name: s.tool, callId, host, keeping: { continuations, scope }, ...(s.inProgram ? { inProgram: true } : {}),
    });
  }
}

export function runJsTool(
  sandbox: Sandbox,
  host: ToolHost,
  opts: {
    limits?: unknown;
    onCalls?: RunCounting["onCalls"];
    /** Every run, however it ended: for the usage count. A failure here does not fail the run. */
    onRun?: RunCounting["onRun"];
    /** Where a program waiting at `await pause(...)` is kept for `resume`. Absent: a
     *  pause ends the program, as it did before pauses could be resumed. */
    continuations?: RunJsContinuations;
    /** The session this tool serves: a token is answered only in the session given it. */
    scope?: string;
    /** The tools the model was offered, so a script may name them the way the
     *  model's own tool list names them. Without this the prompt asks for two
     *  different strings for one tool: `web__get` outside the sandbox, and the
     *  gateway's `web.get` inside it, with nothing saying which is which. */
    tools?: MountedTool[];
    /** Mounts this agent has but cannot be offered, with why. A script may still
     *  name their tools (a session older than the change), and the truthful
     *  answer is the reason, not "no such tool, try a neighbour". */
    unoffered?: Array<{ alias: string; plugin: string; reason: "switched_off" | "plugin_unavailable" }>;
  } = {},
): AgentHarnessTool<undefined> {
  let seq = 0;
  // Unknown strings pass through untouched: an address still works, so a model
  // that learned one from an older transcript is not punished for it, and a
  // genuinely wrong name is refused by the gateway with its own message rather
  // than by a lookup here.
  const byName = new Map((opts.tools ?? []).map((t) => [t.name, t.address]));
  const byAddress = new Map((opts.tools ?? []).map((t) => [t.address, t]));
  const address = (name: unknown) =>
    typeof name === "string" ? (byName.get(name) ?? name) : name;
  const offered = [...byName.keys()];
  // By the alias as it appears in a model-facing name (`gh` in gh__issues_list).
  const unoffered = new Map((opts.unoffered ?? []).map((u) => [modelName(u.alias), u]));
  // Every alias as it appears in a model-facing name, offered or not: a name is
  // attributed to the LONGEST alias it starts with. Not by splitting at the
  // first "__" — an alias may itself contain "__", which is the same inversion
  // #255 refused for truncated names (Piper). The reason changed under this
  // code and the code did not: `renameMount` used to forbid nothing, and since
  // #444 it applies `MOUNT_ALIAS`, which has no `_` at all — but only to names
  // set FROM THEN ON. Nothing rewrote the aliases already stored, so one of
  // them can still contain "__" and this has to keep reading them.
  // Offered aliases take part so a typo on an offered mount (gh__eu) is not
  // mistaken for a switched-off mount whose alias is a shorter prefix (gh).
  const offeredAliases = new Set((opts.tools ?? []).map((t) => modelName(t.address.split(".")[0]!)));
  const aliasOf = (typed: string): string | null => {
    let best: string | null = null;
    for (const a of [...offeredAliases, ...unoffered.keys()]) {
      if (typed.startsWith(`${a}__`) && (best === null || a.length > best.length)) best = a;
    }
    return best;
  };
  return {
    name: "run_js",
    label: "run_js",
    description: RUN_JS_DESCRIPTION,
    parameters: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "JavaScript body. Use await tool`name ${args}` and output(value), " +
            "where `name` is the tool's name as it appears in your tool list. " +
            "`const answer = await pause(question, data, expected?)` stops there and hands you the question, " +
            "data, what ran so far and a token; resume(token, answer) continues the program from that line. " +
            "`expected` is optional: { choices: [...] }, { kind: \"yes_no\" }, { kind: \"text\" } or " +
            "{ schema: {...} } (type, enum, required, properties, items are checked).",
        },
      },
      required: ["source"],
    } as any,
    replay: "never",
    async execute(toolCallId: string, params: { source: string }) {
      let n = 0;
      const asked: AskedList = { items: [], closed: false };
      const started = Date.now();
      // Counting is never the run's problem: a failure here is dropped.
      const countRun = async (run: { ok: boolean; ms: number; hostCalls: number }) => {
        try { await opts.onRun?.(run); } catch { /* the count is lost, the run is not */ }
      };
      let r: Awaited<ReturnType<Sandbox["execute"]>>;
      try {
        r = await sandbox.execute(String(params.source), {
        // A stable key per call inside one execution, so a repeat reaches the
        // same operation rather than minting a new one.
        invoke: (call: any) => {
          // A name in the model's own form (no dot) that is not in its list is
          // answered here, where that list is known. Passed on, the gateway —
          // which only speaks addresses — called it "not a tool name", though
          // the shape is exactly the one the model was told to use; so a one-
          // character slip in a long, truncated name read as a rule it had
          // broken (Piper, 2026-09-13). Dotted names still go on: the gateway
          // answers those as unknown_tool / not_mounted already.
          // A pause asks the model, so only the model answers it: a program that
          // could call resume could take the decision it was stopping to ask for.
          if (call.tool === "resume") {
            return Promise.resolve({
              status: "rejected" as const,
              error: { code: "not_from_a_program", message: "resume is yours to call, not a program's: a program cannot resume or cancel a paused run" },
            });
          }
          if (typeof call.tool === "string" && !call.tool.includes(".") && !byName.has(call.tool)) {
            // A mount that exists but cannot be offered: say why, in the gateway's
            // own words, rather than offer neighbours — the next move is a person
            // or an operator, not another tool (Piper, Dora, Rex, 2026-09-13).
            const owner = aliasOf(call.tool);
            const u = owner === null || offeredAliases.has(owner) ? undefined : unoffered.get(owner);
            if (u !== undefined) {
              return Promise.resolve({
                status: "rejected" as const,
                error: u.reason === "switched_off"
                  ? { code: "plugin_disabled", message: switchedOffMessage(u.alias) }
                  : { code: "plugin_unavailable", message: pluginUnavailableMessage(u.alias, u.plugin) },
              });
            }
            // With nothing offered at all (every plugin switched off), "no tool
            // named X" reads as a typo and invites another name, which fails the
            // same way turn after turn. Say the list is empty, so the next move
            // is to do the work in the script (Piper, Dora, 2026-09-13).
            if (offered.length === 0) {
              return Promise.resolve({
                status: "rejected" as const,
                error: {
                  code: "no_tools",
                  message: "your tool list is empty, so no tool can be called from run_js; do the work in the script itself",
                },
              });
            }
            // The likely names go into the message as well as `candidates`: the
            // message is what reaches the model on every path, while the field
            // is only seen if the script prints it (Dora).
            const candidates = closestNames(call.tool, offered);
            return Promise.resolve({
              status: "rejected" as const,
              error: {
                code: "unknown_tool",
                message: `no tool named ${JSON.stringify(call.tool)} in your tool list` +
                  (candidates.length ? `; closest: ${candidates.slice(0, 5).join(", ")}` : ""),
                candidates,
              },
            });
          }
          const addr = address(call.tool);
          const target = typeof addr === "string" ? byAddress.get(addr) : undefined;
          const lifted = target && declaresConfirm(target.parameters) ? { args: call.args, confirm: false } : liftConfirm(call.args);
          return host.invoke({
            ...call,
            tool: address(call.tool),
            args: lifted.args,
            // Every host call a script makes serves this ONE model call, so they all name it --
            // which is exactly why the id is not the idempotency key below: that one has to differ
            // per request, and this one has to be the same for all of them.
            callId: toolCallId,
            opts: { ...(call.opts ?? {}), ...(lifted.confirm ? { confirm: true } : {}), idempotencyKey: `${toolCallId}:${n++}` },
          }).then((res) => {
            // A tool asking the model a question. The program never sees it —
            // the interrupt carries the plugin's `state`, which is not the
            // program's to read — and it cannot wait at this call (only its own
            // `await pause()` suspends), so the call answers as pending and the
            // executor ends the program here, as it would at a held call.
            // deliverRun then reports the question for the model to resume.
            if (res.status !== "interrupted" || !res.interrupt) return res;
            const a = { name: String(call.tool), operationId: res.operationId ?? "", interrupt: res.interrupt, host };
            if (asked.closed) void cancelQuietly(host, a.interrupt);
            else asked.items.push(a);
            return {
              status: "pending", operationId: res.operationId,
              error: { code: "tool_interrupted", message: `${String(call.tool)} asked you a question; the program ends at this call` },
            };
          });
        },
      }, opts.limits);
      } catch (e) {
        await countRun({ ok: false, ms: Date.now() - started, hostCalls: n });
        throw e;
      }
      return deliverRun(r, {
        label: "run_js", callId: toolCallId, started, before: { hostCalls: 0, operations: 0 },
        counting: opts, continuations: opts.continuations, scope: opts.scope ?? "", asked,
      });
    },
  } as AgentHarnessTool<undefined>;
}

/**
 * The offered names a mistyped one most likely meant, best first, at most ten.
 *
 * The names sharing the longest prefix with the typed name that ends in `__`
 * come first, since a slip in the tool part is the usual one; failing that,
 * every name is a candidate. Within the group, names rank by how much of the
 * typed name they share from the start. The group is found by comparison, never
 * by splitting the typed name at its first `__`: an alias may itself contain
 * `__` (my__gh). It approximates "the same alias" without knowing the aliases,
 * so a sibling mount can fall in it: for `a__fo`, `a__b__run` shares `a__` just
 * as `a__foo` does, and only the ranking puts it last. Exported so the ranking
 * can be tested without an executor.
 */
export function closestNames(typed: string, names: string[], limit = 10): string[] {
  const shared = (a: string, b: string) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  // The end of the longest common prefix that closes on "__", or 0 when the two
  // share no whole alias segment.
  const boundary = (a: string, b: string) => {
    const cut = a.slice(0, shared(a, b)).lastIndexOf("__");
    return cut < 0 ? 0 : cut + 2;
  };
  const best = names.reduce((m, n) => Math.max(m, boundary(typed, n)), 0);
  const pool = best > 0 ? names.filter((n) => boundary(typed, n) === best) : names;
  return [...pool].sort((a, b) => shared(typed, b) - shared(typed, a) || a.localeCompare(b)).slice(0, limit);
}

/**
 * Tools the model is never offered, by mount-qualified address.
 *
 * This is for the case where something the runner owns must not be the
 * agent's to call. The one instance so far: a benchmark whose grader runs
 * *after* the agent in the same container. `node.release` says it destroys
 * the box and stops the meter, so an agent tidying up calls it — rightly, in
 * production — and the grader then scores a fresh box from the base image:
 * no diff, every test still failing, a zero that looks exactly like the model
 * being wrong. Withholding the tool is the fix; the runner releases instead.
 *
 * Applied before the names are qualified, so the address is the mount's own
 * (`node.release`), not whatever the provider-safe name became.
 */
export function withholdTools<T extends { address: string }>(
  tools: T[],
  addresses: Iterable<string>,
): T[] {
  const held = new Set(addresses);
  return tools.filter((t) => !held.has(t.address));
}
