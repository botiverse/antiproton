import type { HarnessAdapter, AdvanceOutput } from "../runtime/kernel.ts";
import type { Json, RuntimeEvent } from "../core/types.ts";
import type { ModelMessage, ToolDefinition } from "../model/types.ts";
import {
  keepFrom, summaryRequest, isContextOverflow, DEFAULT_COMPACTION, NO_COMPACTION,
  ASSUMED_CONTEXT_WINDOW, CHARS_PER_TOKEN, type CompactionConfig,
} from "./codegen.ts";

/**
 * Tools are called natively; JavaScript is one of the tools.
 *
 * Code-mode pays two model turns and a whole fenced block for what a single
 * lookup needs, and it cannot batch. Native tool calling pays one turn and can
 * issue several calls at once — but it has no way to filter, page or project, so
 * a chatty tool empties itself into the context.
 *
 * So `run_js` is offered alongside the domain tools: cheap calls stay cheap, and
 * the sandbox is spent only when composition or trimming actually earns it. The
 * invariant is unchanged and in fact stated better — the Gateway is the only way
 * out, whether the model arrives there directly or from inside a script.
 */
const SYSTEM = `You are a long-running agent working on the user's behalf.

You have tools. Call them directly when you need one thing.

You also have a special tool, run_js, which executes JavaScript in a sandbox where
the same tools are reachable as:

    const res = await tool\`TOOL_NAME \${ { ...arguments... } }\`;
    output(anything);            // what you want to see back

Reach for run_js only when it earns its cost — it is a whole extra round trip:
- several calls whose results feed each other, or a loop over pages
- filtering, sorting, aggregating, or projecting fields out of a large result
- anything that would otherwise dump a large payload into this conversation

For a single lookup, call the tool directly instead. Never wrap one plain call
in run_js.

Inside run_js: every call returns { status, ... }. "succeeded" carries .result,
"rejected" carries .error.code. There is no fetch, require, fs or process — the
tool tag is the only way out. Nothing persists between runs.

Large results may come back summarised with an artifact reference instead of the
full payload; read them back with the artifacts tool, projecting only the fields
you need.

When you have the answer, reply in plain text with no tool call.`;

const RUN_JS: ToolDefinition = {
  name: "run_js",
  description:
    "Execute JavaScript in a sandbox to compose several tool calls, loop, filter, " +
    "or project fields. Use it instead of many separate calls, or to avoid pulling " +
    "a large payload into the conversation. Not for a single simple call.",
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "JavaScript body. Use await tool`name ${args}` and output(value)." },
    },
    required: ["source"],
  },
};

/** Providers restrict tool names, so the model sees a plain name while the
 *  harness keeps the mount-qualified address it dispatches to. */
export interface MountedTool extends ToolDefinition {
  address: string;
}

/**
 * Model-facing names must be unique, because that is all the model can say.
 *
 * Bare API names are unique inside one service and collide across several:
 * `show_profile` exists in ten of AppWorld's apps. A bare name is friendlier, so
 * keep it where it is unambiguous and qualify only what actually clashes — the
 * same rule the gateway applies to mount resolution.
 */
export function qualifyMountedTools(tools: MountedTool[]): MountedTool[] {
  const counts = new Map<string, number>();
  for (const t of tools) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
  return tools.map((t) => {
    if ((counts.get(t.name) ?? 0) < 2) return t;
    const prefix = t.address.split(".")[0]!.replace(/[^A-Za-z0-9_-]/g, "_");
    return { ...t, name: `${prefix}__${t.name}`.slice(0, 64) };
  });
}

interface HybridState {
  harness?: "hybrid";
  /** @see CodegenHarness — a summarisation in flight; the next reply is it. */
  compacting?: { keptFrom: number };
  /** Asked for, rather than reached: a person pressed compact, or a model call
   *  came back saying the context is too long. Either way the next advance
   *  summarises before doing anything else. */
  forceCompact?: boolean;
  /** The rolling handover, so a second pass updates rather than restarts. */
  summary?: string;
  messages: ModelMessage[];
  /** Names currently offered to the model, not their schemas. The catalogue is
   *  static configuration; keeping it here rewrote 210 KB of unchanging text
   *  into the checkpoint on every single advance. */
  offered: string[];
  /** Tools the agent has actually called; never evicted from the offer. */
  used?: string[];
  turns: number;
  done: boolean;
  finalizing: boolean;
  promptTokens: number;
  /** Only ever set when the model call is dispatched somewhere that can drop it. */
  modelFailures?: number;
}

/** Retries of a failed model call, before the task is failed rather than
 *  looping on a provider that is not going to answer. */
const MAX_MODEL_FAILURES = 2;

/**
 * Offer the whole catalogue by default, as conventional harnesses do.
 *
 * An isolated probe suggested narrowing should win: single-selection accuracy
 * fell from 100% at 8 candidates to 73.3% at 447. It did not transfer. On real
 * tasks the all-tools arm scored 4/4 against narrowing's 3/4 and spent a fifth
 * of the uncached tokens, because in a real loop the task instruction and prior
 * results already disambiguate the choice, and a static tool block caches while
 * a growing transcript does not.
 *
 * Narrowing stays available for a catalogue that genuinely will not fit, but it
 * is opt-in: the default behaviour is the ordinary one.
 */
export const DEFAULT_MAX_OFFERED = Number.MAX_SAFE_INTEGER;

export interface HybridOptions {
  maxTurns?: number;
  compaction?: CompactionConfig;
  /** @see CodegenHarness — what the bound model can hold. */
  contextWindow?: number;
  /** The agent's whole catalogue. Configuration, never checkpoint state. */
  catalogue?: MountedTool[];
  /** Offer everything at or below this size; narrow above it. */
  maxOffered?: number;
  /** Always offered, however large the catalogue: discovery and submission. */
  isPinned?: (t: MountedTool) => boolean;
}

const DEFAULT_PINNED = (t: MountedTool) =>
  t.name === "run_js" || t.address.startsWith("tools.");

export class HybridHarness implements HarnessAdapter {
  readonly kind = "hybrid";
  readonly stateVersion = 2;
  #maxTurns: number;
  #compaction: CompactionConfig;
  #contextWindow: number;
  #catalogue: MountedTool[] = [];
  #byName = new Map<string, MountedTool>();
  #byAddress = new Map<string, MountedTool>();
  #maxOffered: number;
  #isPinned: (t: MountedTool) => boolean;

  constructor(opts: HybridOptions = {}) {
    this.#maxTurns = opts.maxTurns ?? 20;
    this.#compaction = opts.compaction ?? NO_COMPACTION;
    this.#contextWindow = opts.contextWindow ?? ASSUMED_CONTEXT_WINDOW;
    this.#maxOffered = opts.maxOffered ?? DEFAULT_MAX_OFFERED;
    this.#isPinned = opts.isPinned ?? DEFAULT_PINNED;
    if (opts.catalogue) this.#setCatalogue(opts.catalogue);
  }

  /**
    * The catalogue is configuration, not state, so it has to be reinstated
    * whenever this object is rebuilt — after an eviction, on a fresh alarm —
    * and not only when a task is opened. Without that, a resumed task carries a
    * checkpoint naming tools the harness no longer knows, and `#offer` throws.
    * It refuses rather than degrades on purpose; the caller's job is to keep it
    * supplied.
    */
  setCatalogue(mounted: MountedTool[]) { this.#setCatalogue(mounted); }

  #setCatalogue(mounted: MountedTool[]) {
    for (const t of mounted) {
      // Silently overwriting would route ten apps' show_profile to whichever
      // mount happened to be last — a misdirected call with no error anywhere.
      const prior = this.#byName.get(t.name);
      if (prior && prior.address !== t.address) {
        throw new Error(
          `tool name "${t.name}" is claimed by two mounts (${prior.address}, ${t.address}); ` +
          `pass them through qualifyMountedTools()`,
        );
      }
      this.#byName.set(t.name, t);
      this.#byAddress.set(t.address, t);
    }
    this.#catalogue = mounted;
  }

  /** Promotions performed, for diagnosing a run rather than theorising about it. */
  promotions = 0;

  /** Whether narrowing is in force for this catalogue. */
  get narrowing(): boolean {
    return this.#catalogue.length > this.#maxOffered;
  }

  #offer(state: HybridState): { tools: ToolDefinition[]; addresses: Record<string, string> } {
    const tools: ToolDefinition[] = [];
    const addresses: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of state.offered) {
      const t = this.#byName.get(name);
      // A checkpoint naming tools this runtime cannot provide is a real
      // inconsistency — the mounts changed under a running task. Skipping it
      // quietly hands the agent a smaller toolset with no signal anywhere,
      // which is the silent-degradation shape this codebase keeps being bitten
      // by. Reconciling a deliberate catalogue change is what migrate() is for.
      if (!t) { missing.push(name); continue; }
      tools.push({ name: t.name, description: t.description, parameters: t.parameters });
      addresses[t.name] = t.address;
    }
    if (missing.length) {
      throw new Error(
        `checkpoint offers ${missing.length} tool(s) this runtime does not have ` +
        `(${missing.slice(0, 5).join(", ")}${missing.length > 5 ? ", …" : ""}); ` +
        `reconcile the catalogue change in migrate()`,
      );
    }
    tools.push(RUN_JS);
    return { tools, addresses };
  }

  /**
   * Names mentioned by a discovery result.
   *
   * Discovery answers in mount-qualified addresses (`spotify.show_song`), while
   * the offer is keyed by model-facing name — and those differ for exactly the
   * tools whose bare names collide. Matching on bare names therefore silently
   * failed to promote every collided tool, and the agent searched again and
   * again for something it could never be given. Match on the address.
   */
  #mentioned(content: string): string[] {
    const out: string[] = [];
    for (const m of content.matchAll(/[A-Za-z0-9_]{1,64}\.[A-Za-z0-9_]{1,64}/g)) {
      const t = this.#byAddress.get(m[0]);
      if (t) out.push(t.name);
    }
    for (const m of content.matchAll(/[A-Za-z0-9_]{3,64}/g)) {
      const t = this.#byName.get(m[0]);
      if (t) out.push(t.name);
    }
    return out;
  }

  /** Widen the offer, evicting only tools the agent has never actually used —
   *  dropping a tool mid-task forces it to rediscover what it already had. */
  #promote(state: HybridState, names: string[]) {
    for (const n of names) {
      if (!this.#byName.has(n) || state.offered.includes(n)) continue;
      state.offered.push(n);
      this.promotions++;
    }
    if (state.offered.length <= this.#maxOffered) return;
    const keep = (n: string) => {
      const t = this.#byName.get(n);
      return (t ? this.#isPinned(t) : false) || (state.used ?? []).includes(n);
    };
    const protectedNames = state.offered.filter(keep);
    const rest = state.offered.filter((n) => !keep(n));
    const room = Math.max(0, this.#maxOffered - protectedNames.length);
    state.offered = [...protectedNames, ...rest.slice(-room)];
  }

  async initialize(config: Json): Promise<Json> {
    const mounted = ((config as any)?.tools ?? []) as MountedTool[];
    if (mounted.length) this.#setCatalogue(mounted);
    const policy = (config as any)?.policy as string | undefined;
    // Below the threshold the whole catalogue is cheaper than one discovery
    // round trip; above it, offer only what is pinned and let search widen it.
    const offered = this.narrowing
      ? this.#catalogue.filter(this.#isPinned).map((t) => t.name)
      : this.#catalogue.map((t) => t.name);
    return {
      /** @see CodegenHarness.initialize — a task keeps the harness it began with. */
      harness: "hybrid",
      messages: [{ role: "system", content: SYSTEM + (policy ? `\n\n# Domain policy you must follow\n${policy}` : "") }],
      offered,
      turns: 0, done: false, finalizing: false, promptTokens: 0,
    } satisfies HybridState;
  }

  /** @see CodegenHarness.shrink — the same knife, for the same deadlock. */
  async shrink(state: Json, targetBytes: number): Promise<Json | null> {
    const s = structuredClone(state) as HybridState;
    if (!Array.isArray(s.messages) || s.messages.length < 4) return null;
    const size = () => JSON.stringify(s).length;
    let dropped = 0;
    while (size() > targetBytes && s.messages.length > 4) {
      s.messages.splice(1, 1);
      dropped++;
    }
    if (!dropped) return null;
    s.messages.splice(1, 0, {
      role: "user",
      content: `[${dropped} earlier step(s) dropped to fit the checkpoint budget. ` +
        `Anything you still need from them, read back with state.get or re-derive.]`,
    });
    return size() > targetBytes ? null : (s as unknown as Json);
  }

  async migrate(state: Json, _from = 0): Promise<Json> {
    const s = state as any;
    // Deliberate reconciliation: names the current catalogue no longer has are
    // dropped here, where it is an explicit decision rather than a silent one.
    if (Array.isArray(s?.offered) && this.#byName.size) {
      const kept = s.offered.filter((n: string) => this.#byName.has(n));
      if (kept.length !== s.offered.length) return { ...s, offered: kept };
    }
    // v1 kept the catalogue in the checkpoint; v2 keeps only the names.
    if (Array.isArray(s?.tools) && !Array.isArray(s?.offered)) {
      return { ...s, offered: s.tools.map((t: any) => t.name).filter((n: string) => n !== "run_js"),
               tools: undefined, addresses: undefined };
    }
    return state;
  }

  async advance(input: { state: Json; events: RuntimeEvent[] }): Promise<AdvanceOutput> {
    const state = structuredClone(input.state) as HybridState;
    const msgs = state.messages;
    state.offered ??= this.#catalogue.map((t) => t.name);
    const commands: Array<{ kind: string; payload: Json }> = [];
    let sawReply: { text: string; toolCalls?: any[] } | null = null;
    let lastFailure: string | null = null;
    const held: string[] = [];

    for (const e of input.events) {
      const p = e.payload as any;
      switch (e.kind) {
        case "message":
          msgs.push({ role: "user", content: String(p.text) });
          // A new request from the person gets a fresh execution budget. The
          // budget bounds one request, not the conversation: without this a
          // chat task that has spent its turns can never act again, and every
          // later message is answered "you are out of execution turns" — which
          // is what left a real session unable to do anything but apologise.
          state.turns = 0;
          state.finalizing = false;
          break;
        case "model.response": {
          state.turns++;
          if (p.usage?.promptTokens) state.promptTokens = Number(p.usage.promptTokens);
          const calls = (p.toolCalls ?? []) as any[];
          msgs.push({
            role: "assistant",
            content: String(p.text ?? ""),
            ...(calls.length
              ? {
                  tool_calls: calls.map((c) => ({
                    id: c.id, type: "function",
                    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
                  })),
                }
              : {}),
          });
          sawReply = { text: String(p.text ?? ""), toolCalls: calls };
          break;
        }
        // Offloading the model call introduced a failure the inline path never
        // had: a reply that never arrives. Falling through to the tail below
        // retries it, which is right — but unbounded retry of a call that costs
        // money is not, so it is counted and eventually given up on.
        case "model.failed": {
          const err = String(p.error ?? "model call failed");
          // @see CodegenHarness — the provider saying the prompt does not fit
          // is a compaction trigger, not something to retry.
          if (isContextOverflow(err)) {
            state.forceCompact = true;
            state.compacting = undefined;
            break;
          }
          state.modelFailures = (state.modelFailures ?? 0) + 1;
          lastFailure = err;
          break;
        }
        case "compact.requested":
          state.forceCompact = true;
          break;
        case "tool.result": {
          for (const id of (p.heldOperationIds ?? []) as string[]) held.push(id);
          const content = String(p.content);
          msgs.push({ role: "tool", tool_call_id: String(p.callId), content });
          // Discovery is what widens the offer. Any catalogue name the result
          // mentions becomes natively callable on the next turn, so the choice
          // happens against a handful of candidates instead of hundreds.
          if (this.narrowing && String(p.tool ?? "").startsWith("tools.")) {
            // A search result naming fifty candidates must not promote fifty:
            // rewriting the offer every turn churns it and, worse, changes the
            // tool block on every request, which throws away the prompt cache.
            this.#promote(state, this.#mentioned(content).slice(0, Math.ceil(this.#maxOffered / 2)));
          }
          break;
        }
        case "js.result":
          for (const id of (p.heldOperationIds ?? []) as string[]) held.push(id);
          msgs.push({
            role: "tool",
            tool_call_id: String(p.callId),
            content: JSON.stringify({
              status: p.status,
              outputs: p.outputs,
              ...(p.error ? { error: p.error } : {}),
            }).slice(0, 12_000),
          });
          break;
      }
    }

    // A reply arriving while a summarisation is out is the handover, not a
    // turn. Without this branch it would have no tool calls, and a reply with
    // no tool calls is how this harness recognises a finished answer — so
    // compacting would end the task.
    if (state.compacting && sawReply) {
      const { keptFrom } = state.compacting;
      const summary = sawReply.text.trim();
      state.messages = [
        msgs[0]!,
        { role: "user",
          content: `[compacted] Everything before this point has been summarised.\n\n${summary}` },
        ...msgs.slice(1).filter((m) => !String(m.content ?? "").startsWith("[compacted")),
      ];
      state.summary = summary;
      state.compacting = undefined;
      return {
        state, status: "waiting",
        commands: [{ kind: "model.request",
                     payload: { messages: state.messages, tools: this.#offer(state).tools } }],
        waits: [],
      };
    }

    if (sawReply) {
      const calls = sawReply.toolCalls ?? [];
      if (calls.length && !state.finalizing) {
        if (state.turns >= this.#maxTurns) {
          msgs.push({
            role: "tool", tool_call_id: String(calls[0].id),
            content: JSON.stringify({ status: "rejected", error: { code: "turn_budget_exhausted" } }),
          });
          msgs.push({
            role: "user",
            content: "You are out of tool turns. Answer now from what you already have, and say plainly what is missing.",
          });
          return { state: { ...state, finalizing: true }, status: "waiting",
            commands: [{ kind: "model.request", payload: { messages: msgs, tools: this.#offer(state).tools } }], waits: [] };
        }
        // Native calls fan out; run_js goes to the sandbox. Both land on the Gateway.
        for (const c of calls) {
          if (c.name !== "run_js") {
            state.used ??= [];
            if (!state.used.includes(c.name)) state.used.push(c.name);
          }
          if (c.name === "run_js") {
            commands.push({ kind: "js.execute", payload: { callId: c.id, source: String(c.arguments?.source ?? "") } });
          } else {
            commands.push({
              kind: "tool.call",
              payload: { callId: c.id, tool: this.#offer(state).addresses[c.name] ?? c.name, args: c.arguments ?? {} },
            });
          }
        }
        return { state, status: "waiting", commands, waits: [] };
      }
      // No tool calls: this is the answer.
      return {
        state: { ...state, done: true },
        status: "completed",
        commands: [{ kind: "message.out", payload: { text: sawReply.text } }],
        waits: [],
      };
    }

    // A held call is a wait, not a failure. See the note in codegen.ts.
    if (held.length && !sawReply) {
      msgs.push({
        role: "user",
        content:
          `Held for approval: ${held.length} call(s) require a person to sign off. ` +
          `Nothing failed — the task is paused and resumes on its own once decided. ` +
          `Do not retry them or route around them.`,
      });
      return {
        state, status: "waiting", commands: [],
        waits: held.map((operationId) => ({ kind: "operation" as const, operationId })),
      };
    }

    if (lastFailure && (state.modelFailures ?? 0) > MAX_MODEL_FAILURES) {
      return {
        state: { ...state, done: true },
        status: "failed",
        commands: [{ kind: "message.out", payload: { text: `The model call failed repeatedly: ${lastFailure}` } }],
        waits: [],
      };
    }
    if (this.#shouldSummarise(state)) {
      const keptFrom = keepFrom(
        state.messages,
        this.#contextWindow * this.#compaction.keepRecentFraction * CHARS_PER_TOKEN,
      );
      if (keptFrom > 1) {
        const request = summaryRequest(
          state.messages.slice(1, keptFrom)
            .map((m) => ({ role: m.role, content: String(m.content ?? "") })),
          state.summary,
        );
        // @see CodegenHarness — trimmed now, so the checkpoint is small enough
        // to commit the compaction itself.
        state.messages = [state.messages[0]!, ...state.messages.slice(keptFrom)];
        state.compacting = { keptFrom };
        state.forceCompact = undefined;
        return {
          state, status: "waiting",
          commands: [{
            kind: "model.request",
            payload: {
              messages: request,
              purpose: "compaction",
              keptFrom,
              summarised: keptFrom - 1,
            },
          }],
          waits: [],
        };
      }
    }

    return {
      state, status: "waiting",
      commands: [{ kind: "model.request", payload: { messages: msgs, tools: this.#offer(state).tools } }],
      waits: [],
    };
  }

  /** @see CodegenHarness — the cost wall and the checkpoint wall. */
  #shouldSummarise(state: HybridState): boolean {
    if (this.#compaction.mode !== "summarise" || state.compacting) return false;
    if (state.forceCompact) return true;
    if (state.finalizing) return false;
    if (state.promptTokens >= this.#contextWindow * this.#compaction.triggerFraction) return true;
    return JSON.stringify(state).length >= this.#compaction.maxCheckpointBytes / 2;
  }
}
