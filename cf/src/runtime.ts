/**
 * The agent runtime, assembled inside a Durable Object.
 *
 * Nothing here is Cloudflare-specific except the wiring: the harness, gateway
 * and plugins are the same modules the Node build uses. What changes is that
 * storage is local, wakeup is an alarm instead of a poll, and the sandbox is a
 * Dynamic Worker instead of QuickJS.
 *
 * The loop is pi's. What this class still owns is everything pi has no opinion
 * about and never will: which tenant is asking, which mounts they have, which
 * credential each mount resolves to, and who is allowed to spend what.
 */
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import { DynamicWorkerExecutor } from "../../src/runtime/dynamic-worker-executor.ts";
import { PiAgent, ensureAgentTables, jobSession, sessionsWithWork, markSession } from "../../src/runtime/pi-agent.ts";
import { idleDecision, warningText } from "../../src/runtime/idle-lease.ts";
import {
  admitBackground, jobsTool, mountsWithRunningJobs, recordBackgroundJob, refuseOverCap, runBackgroundPass, runningBackgroundJobs, startedResult, stopSessionJobs,
} from "../../src/runtime/background-jobs.ts";
import {
  bridgeTools, offersPlugin, offersCapability, qualifyMountedTools, runJsTool, type MountedTool,
  withholdTools,
} from "../../src/runtime/pi-tools.ts";
import { systemPrompt } from "../../src/runtime/pi-prompt.ts";
import { ASSUMED_CONTEXT_WINDOW } from "../../src/model/context-windows.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { callTurns, CANCELLED_NOTE, TURN_CANCELLED } from "./agents-api/transcript.ts";
import { apiAgentSeeds, harnessExtras } from "./agents-api/provisioning.ts";
import {
  answerClientCall, clientTools, dropClientCalls, pendingClientCalls, resumeClientCalls,
} from "../../src/runtime/client-calls.ts";

export { ASSUMED_CONTEXT_WINDOW } from "../../src/model/context-windows.ts";

/**
 * pi has no task id: a run is an operation and the conversation is a lane.
 * The gateway, quotas and approvals still address a task, so one constant
 * stands where the identifier used to be until those follow.
 */
const LEGACY_TASK = "main";
import { ToolGateway } from "../../src/runtime/gateway.ts";
import { assertMountConfig, validateMount } from "../../src/runtime/mount-config.ts";
import { ModelResolver } from "../../src/runtime/model-resolver.ts";
import { envSecrets } from "../../src/runtime/gateway.ts";
import { agentSecrets, agentRef, importKek, isAgentRef, seal } from "../../src/runtime/secrets.ts";
import {
  ensureInboundTable, hookSecretName, inboundMessage, newHookId, newHookSecret, recentInbound, recordInbound, seenBefore, underRate,
  INBOUND_MAX_BYTES, INBOUND_PER_MINUTE, type InboundOutcome,
} from "../../src/runtime/inbound.ts";
import type { InboundEvent, InboundHooks } from "../../src/plugins/types.ts";
import { INBOUND_HOOKS_PER_MOUNT } from "../../src/plugins/types.ts";
import { MAIN_SESSION } from "../../src/store/pi-storage.ts";

/** The persona fields of an agent record, if it carries any. */
export function personaOf(config: unknown): { name?: string; description?: string } | null {
  const c = (config ?? {}) as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name : undefined;
  const description = typeof c.description === "string" ? c.description : undefined;
  return name || description ? { name, description } : null;
}
import type { MountPolicy, MountRecord } from "../../src/core/types.ts";
import type { HookDirectory } from "./control-plane.ts";
import { jsRunRows } from "../../src/usage/outbox.ts";

/** What an operator may call a mount: it becomes the `<alias>__` prefix of every tool name. */
export const MOUNT_ALIAS = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * What the console's reconcile does with one seed whose alias exists (the
 * third write path). Provision validates a seed as it adds it; attaching a
 * credential re-validates with the ref about to be set (#140); this is the
 * config changing under a credential that is already there, so the check runs
 * with the ref that stayed. A seed that would leave the mount in a state the
 * runtime forbids (a credential and no host allowlist) is not applied, and the
 * refusal is reported: otherwise "refused" and "nothing to do" would look the
 * same. A seed's settings belong to its plugin, so another plugin under the
 * alias (added or renamed while the seed was switched off) is refused too:
 * one plugin's settings on another would silently drop what it needs.
 */
export function reconcileSeed(
  have: Pick<MountRecord, "plugin" | "publicConfig" | "secretRef">,
  seed: SeedMount,
  plugin: Plugin | undefined,
): { update: Record<string, Json> | null } | { refused: string } {
  if (have.plugin !== seed.plugin) {
    return { refused: `${seed.alias} is a ${have.plugin} mount, not the ${seed.plugin} seed; left as it is` };
  }
  const config = (seed.config ?? { account: seed.account }) as Record<string, Json>;
  if (JSON.stringify(have.publicConfig) === JSON.stringify(config)) return { update: null };
  const problems = plugin ? validateMount(plugin, config, have.secretRef) : [];
  if (problems.length) return { refused: problems.map((x) => x.message).join("; ") };
  return { update: config };
}

/** A mount every agent starts with. `account` alone is the older shape the benchmarks still pass. */
export interface SeedMount {
  alias: string; plugin: string;
  account?: string; config?: Json;
  secretRef?: string | null; policy?: MountPolicy | null;
}
import { credentialForm, pluginEnabled, renameSafety, isExclusive, backgroundOf } from "../../src/plugins/types.ts";
import { githubPlugin } from "../../src/plugins/github.ts";
import { demoPlugin } from "../../src/plugins/demo.ts";
import { httpPlugin } from "../../src/plugins/http.ts";
import { exaPlugin } from "../../src/plugins/exa.ts";
import { statePlugin } from "../../src/plugins/state.ts";
import { sandboxPlugin } from "../../src/plugins/sandbox.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import { artifactsPlugin, PARK_BYTES, READ_WHOLE_MAX } from "../../src/plugins/artifacts.ts";
import { raftPlugin } from "../../src/plugins/raft.ts";
import { toAgentRef } from "../../src/store/refs.ts";
import type { Plugin, PluginChoice } from "../../src/plugins/types.ts";
import type { ToolResult } from "../../src/core/tools.ts";
import type { Json } from "../../src/core/types.ts";
import type { ModelResponse } from "../../src/model/types.ts";

/** A model call handed to a Worker. Carries the command id, because the reply
 *  has to land under the same dedup key the inline path would have used. */
/** Commands cheap enough to send elsewhere: pure request/response, no bridge
 *  back into this object. `js.execute` needs the sandbox host, `tool.call` is
 *  short, and neither answers under the `:response` dedup key. */
const OFFLOADABLE = ["model.request"];

export interface ModelJob {
  tenantId: string;
  agentId: string;
  taskId: string;
  commandId: string;
  payload: Json;
}

/**
 * How big a tool result may be before the model gets a preview instead.
 *
 * Two numbers, because the two branches lose different things. With a reader
 * mounted, a larger result is parked and nothing is lost, so the line is low
 * and the conversation stays small (tygg, 2026-09-13: 4K). Without one, the
 * rest is discarded, so lowering the line there would only throw more away;
 * it stays where it was.
 *
 * This is the line for mounted tool calls only. What a run_js script returns
 * with output() is never parked; it comes back as-is up to its own 64 KiB cap
 * (src/core/execution.ts), so a script can still bring a larger result into
 * the conversation. Whether that should park too has not been decided.
 */
export function offloadLimit(readBack: string | null): number {
  return readBack ? PARK_BYTES : READ_WHOLE_MAX;
}

/**
 * The line for one call. Reading a parked result back is itself a mounted
 * call, so at the parking line the page it returned was parked again and the
 * model never got past a preview (Vera, 2026-09-13). The reader's own answer
 * is held to the line where nothing parks instead; a page bigger than that is
 * still parked, and fewer fields or a smaller limit reads it.
 *
 * Compared by address, because that is what reaches the host: both the
 * bridge and run_js resolve the offered name before they invoke.
 */
export function limitForCall(tool: string, reader: { name: string; address: string } | null): number {
  return reader && tool === reader.address ? offloadLimit(null) : offloadLimit(reader?.name ?? null);
}

/**
 * What the model gets instead of a result too big to put in the conversation.
 *
 * A summary of the value (tygg, 2026-09-13: it clearly helps), and — from pi's
 * design (pi-coding-agent 0.83.0, dist/core/tools/read.js) — a note that is
 * the exact next call, not a direction. The note used to list the reader's
 * arguments, and only two tools' descriptions said a result could come back
 * this way, so a fresh agent took a GitHub read's summary for a tool that had
 * returned no data (Vera, 2026-09-13).
 *
 * The call depends on size, because a whole read is itself held to the
 * reader's line: under it, `{ ref }` returns everything; over it, a whole read
 * would be parked again, so the call is `{ ref, from: 0 }`, which pages the
 * text and says on each page where the next begins.
 *
 * Every cut result has this one shape, whichever tool produced it. Not parked:
 * no reference, and the loss stated, because a reference nobody can open reads
 * as though the content is still somewhere.
 */
export function tooLargeResult(
  value: unknown,
  body: string,
  parked: { ref: string; readBack: string } | null,
  /** A reader was there, and storage refused the result anyway. */
  storeFailed = false,
): Record<string, Json> {
  const preview = summarise(value);
  const what = `a summary of a ${body.length}-character result`;
  if (!parked && storeFailed) {
    // Not "not stored": a put that errors may still have landed (a 5xx, a dropped
    // connection), so what is known is only that no stored copy can be vouched for (Ada, #341).
    return { preview, bytes: body.length,
      note: `${what}; storing the rest could not be confirmed, so there is no reference to offer. ` +
        "The call itself succeeded; ask again for a smaller part of it (fields/offset/limit) rather than repeating it whole" };
  }
  if (!parked) {
    return { preview, bytes: body.length,
      note: `${what}; the rest was discarded, not stored, because nothing is mounted that could read a parked result back` };
  }
  const call = body.length <= offloadLimit(null)
    ? `${parked.readBack} { ref: "${parked.ref}" }`
    : `${parked.readBack} { ref: "${parked.ref}", from: 0 }, which returns it in pages`;
  return { preview, bytes: body.length, ref: parked.ref,
    note: `${what}; all of it is stored: read it with ${call} (or fields/offset/limit for part of a list)` };
}

/**
 * Store a result too large to hand back, and say how to read it; or say it was not kept.
 *
 * The call has already succeeded by the time its result is parked, so a storage
 * failure must not turn it into a failed call: R2 answered one put with an
 * internal error (10001) and the model was told the GitHub read itself had failed
 * (task #19, agent u-zty0826…, 2026-09-15). One retry, then the summary with the
 * loss stated. The storage error's own text stays out of the result: it can name
 * the key, which names where the agent lives. The operation row gets the
 * reference only once there is one; if recording it fails, the stored copy is
 * still offered and the failure goes to the Worker's log, since the call and the
 * copy both exist and only our bookkeeping is behind (Ada, #341).
 */
export async function parkResult(
  value: unknown,
  body: string,
  key: string,
  readBack: string,
  deps: {
    put: (key: string, body: string) => Promise<{ ref: string }>;
    complete: (ref: string) => Promise<unknown>;
    /** The reference as the model is shown it. */
    shownRef: (ref: string) => string;
  },
): Promise<Record<string, Json>> {
  let stored: { ref: string } | null = null;
  for (let attempt = 0; attempt < 2 && !stored; attempt++) {
    try { stored = await deps.put(key, body); } catch { /* retried once, then stated in the result */ }
  }
  if (!stored) return tooLargeResult(value, body, null, true);
  try {
    await deps.complete(stored.ref);
  } catch (e) {
    console.error("parked result stored but its operation reference was not recorded:", key, e);
  }
  return tooLargeResult(value, body, { ref: deps.shownRef(stored.ref), readBack });
}

/**
 * The limit, said in every tool's own description.
 *
 * pi states its limit in each tool's description, in the same sentence as
 * what to do when it is reached (read.js: "truncated to 2000 lines or 50KB …
 * continue with offset"). Here the cut happens for every mounted call, so a
 * sentence in two plugins' descriptions described a global behaviour locally,
 * and a model using any other tool was never told. Added here, where the
 * reader and the line are both known, so no plugin has to repeat a number it
 * does not own. The reader's own description is left alone: its pages are
 * held to a different line and its summary already says how to continue.
 */
export function withLimitNote<T extends { description: string; address: string }>(
  tools: T[],
  reader: { name: string; address: string } | null,
): T[] {
  const kb = offloadLimit(reader?.name ?? null) / 1024;
  const sentence = reader
    ? ` A result over ${kb} KB comes back as a summary (preview) and a note with the ${reader.name} call that reads all of it.`
    : ` A result over ${kb} KB comes back as a summary (preview); the rest is discarded.`;
  return tools.map((t) =>
    reader && t.address === reader.address ? t : { ...t, description: `${t.description ?? ""}${sentence}` });
}

/**
 * What the agent is told about a result too big to hand it whole.
 *
 * This used to project `{number, title}` from an array — the shape of a GitHub
 * issue list, and of nothing else. A fetched page is an object with a long
 * `body`, so it produced an empty preview: the agent received a reference, no
 * readable content, and no idea what it had. Offloading has to leave something
 * usable behind whatever the result looks like, or it is just a dead end with
 * extra steps.
 */
function summarise(value: unknown, budget = 1200): Json {
  const head = (s: string, n: number) =>
    s.length <= n ? s : `${s.slice(0, n)}… (+${s.length - n} chars)`;

  if (typeof value === "string") return head(value, budget);
  if (Array.isArray(value)) {
    return {
      count: value.length,
      sample: value.slice(0, 3).map((v) => summarise(v, Math.floor(budget / 3))),
    };
  }
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    const entries = Object.entries(value as Record<string, unknown>);
    const per = Math.max(120, Math.floor(budget / Math.max(entries.length, 1)));
    for (const [k, v] of entries.slice(0, 20)) {
      out[k] = typeof v === "string" ? head(v, per)
        : Array.isArray(v) ? { count: v.length }
        : v && typeof v === "object" ? "{…}"
        : (v as Json);
    }
    return out;
  }
  return value as Json;
}

/** Same surface the SigV4 client exposes, backed by the R2 binding instead. */
class BoundArtifacts {
  #bucket: R2Bucket;
  #name: string;
  constructor(bucket: R2Bucket, name: string) {
    this.#bucket = bucket;
    this.#name = name;
  }
  async put(key: string, body: string | Uint8Array) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    await this.#bucket.put(key, bytes);
    return { ref: `r2://${this.#name}/${key}`, etag: "", bytes: bytes.byteLength };
  }
  async get(key: string): Promise<Uint8Array> {
    const obj = await this.#bucket.get(key);
    // Not the key: it names the bucket, the tenant and the agent, and this
    // message reaches the model through the reader's error.
    if (!obj) throw new Error("no such artifact");
    return new Uint8Array(await obj.arrayBuffer());
  }
}

/** The one reference that maps to the operator's configured key. A tenant that
 *  wants its own account uses its own reference instead. */
export const OPERATOR_SECRET_REF = "operator:model";
/** Same idea for the sandbox account. Kept distinct so a tenant can be moved
 *  onto its own run9 project without touching its model binding. */
export const OPERATOR_RUN9_REF = "operator:run9";

export interface RuntimeDeps {
  ctx: any;
  bucketName: string;
  bucket: R2Bucket;
  loader: any;
  makeToolBinding: (execId: string) => unknown;
  /**
   * The operator's own model account. Used only to seed a binding on request
   * (`bindOperatorModel`), never as a fallback: an agent whose tenant has no
   * binding is refused, because the alternative is every tenant silently
   * spending this key.
   */
  operatorModel?: { baseUrl: string; apiKey: string; model: string };
  /** The operator's sandbox account, behind OPERATOR_RUN9_REF. Absent means the
   *  `node` mount resolves to no credential and its tools refuse to run, which
   *  is the right failure: a deployment without keys should not start boxes. */
  operatorRun9?: { ak: string; sk: string };
  /** The key under which per-agent secrets are sealed at rest: 32 bytes,
   *  base64, a Worker secret. Absent means `agent:` references cannot be
   *  stored or resolved, and the credential form says so. */
  secretKek?: string;
  /**
   * Durable Objects bill wall clock, Workers bill CPU — and a model call is
   * ~94% waiting. Handing `model.request` to a Worker lets the object go idle
   * for the whole completion instead of being billed for it. Omitted = inline.
   */
  offloadModel?: (job: ModelJob) => Promise<void>;
  /** Domain plugins beyond the built-ins (the benchmark mounts `retail` here). */
  extraPlugins?: Plugin[];
  /**
   * Where hook URLs point and the index that resolves them. Absent: plugins
   * are offered no `inbound` and cannot make hooks themselves.
   */
  hooks?: { origin: string; directory: Pick<HookDirectory, "create" | "lookup" | "revoke" | "list"> };
  maxTurns?: number;
  /**
   * What the bound model can hold, in tokens.
   *
   * Configuration rather than a constant, because it is the one number here
   * that changes by an order of magnitude between models: a threshold that is
   * most of a small window is a rounding error in a large one. Unset means the
   * conservative assumption, which compacts early rather than discovering the
   * limit from a refused call.
   */
  contextWindow?: number;
  /** Domain policy handed to the harness at task initialisation. */
  policy?: string;
  /**
   * Whether this agent is offered `run_js`.
   *
   * On by default, because the deployed console has a sandbox. It is a switch
   * rather than a constant so the benchmark can hold it fixed: the Node τ²
   * runner never offered the sandbox, and running the object arm with it on
   * meant the two arms differed by a tool and two paragraphs of prompt while
   * being reported as the same measurement. It is also the only way to ask
   * whether a sandbox helps on a task whose every action is one domain call —
   * a question SWE-bench cannot answer, because there it obviously does.
   */
  sandbox?: boolean;
  /**
   * Mount-qualified addresses the model is never offered.
   *
   * For a benchmark whose grader runs after the agent in the same container:
   * `node.release` says it destroys the box and stops the meter, so an agent
   * tidying up calls it — rightly, in production — and the grader then scores
   * a fresh box from the base image. The runner owns that lifetime instead.
   */
  withholdTools?: string[];
  /**
   * Whether a settled run hands its containers back by itself.
   *
   * On by default: a finished task should not hold a metered machine. Off only
   * when something still has to happen in that machine after the agent is
   * done — grading — and whoever switched it off takes the release, and the
   * bill for forgetting it, on themselves.
   */
  autoRelease?: boolean;
  /**
   * Keep a metered container between passes, ask the agent about it when it
   * goes quiet, and take it back at a ceiling the agent cannot move.
   *
   * Absent means the behaviour this had before: release after every pass that
   * settles with nothing open, which never bills for an idle box and makes
   * "the container persists between calls" false wherever the tools say it.
   * Present means the lease: see src/runtime/idle-lease.ts for the schedule.
   * A deployment turns it on by setting both numbers, because both are prices
   * — a warning costs a model turn, a box costs seconds. `warnMs` is how long
   * before the release the agent is told; `maxMs` is idle time before release.
   */
  idle?: { warnMs: number; maxMs: number };
}

/**
 * The mounts this agent still has, once its own answers are applied.
 *
 * A switched-off mount is still a mount: the credential reference, the
 * connection state and the alias all survive, and switching the plugin back on
 * returns them. It is only kept out of the catalogue, so the model is not
 * offered tools it would be refused for using. Deleting instead would lose
 * things that cannot be recovered, which is why nothing in this codebase
 * unmounts.
 *
 * A mount naming a plugin nobody installed stays in, as it always has: it has
 * its own refusal at the gateway and its own line in the console, and dropping
 * it here would turn a mount that reports what is wrong into one that is
 * silently absent.
 *
 * Extracted from the catalogue because the catalogue cannot be called without
 * a model binding and a harness, and a rule nobody can exercise directly is a
 * rule that gets deleted by a refactor without anything going red.
 */
export function enabledMounts<T extends { plugin: string }>(
  mounts: T[],
  installed: Map<string, Pick<Plugin, "defaultForAllAgents">>,
  choices: Record<string, PluginChoice>,
): T[] {
  return mounts.filter((m) => {
    const plugin = installed.get(m.plugin);
    return !plugin || pluginEnabled(plugin, choices[m.plugin]);
  });
}

/**
 * The mounts this agent has whose tools it cannot be offered, and why: the
 * plugin is installed but switched off for this agent, or no plugin by that id
 * is installed at all. The two need different sentences — a person can switch
 * one back on; the other needs an operator — so the reason travels with them.
 *
 * run_js needs these by alias: a session older than the change still holds the
 * mount's tool names, and without them its refusal read as a typo with
 * unrelated neighbours (Piper, Dora, Rex, 2026-09-13).
 */
export function unofferedMounts<T extends { plugin: string }>(
  mounts: T[],
  installed: Map<string, Pick<Plugin, "defaultForAllAgents">>,
  choices: Record<string, PluginChoice>,
): Array<{ mount: T; reason: "switched_off" | "plugin_unavailable" }> {
  const out: Array<{ mount: T; reason: "switched_off" | "plugin_unavailable" }> = [];
  for (const m of mounts) {
    const plugin = installed.get(m.plugin);
    if (!plugin) out.push({ mount: m, reason: "plugin_unavailable" });
    else if (!pluginEnabled(plugin, choices[m.plugin])) out.push({ mount: m, reason: "switched_off" });
  }
  return out;
}

/**
 * What an agent's harness was built from: its mounts as the catalogue reads
 * them, and its plugin switches. A cached harness whose key no longer matches
 * offers a tool list that is not true any more — switching a plugin back on
 * did not reach a conversation opened while it was off, and its run_js still
 * answered plugin_disabled (found on preview, 2026-09-17). The credential
 * itself never enters the key, only whether there is one.
 */
export function catalogueKey(
  mounts: Array<Pick<MountRecord, "alias" | "plugin" | "toolVersion" | "publicConfig" | "secretRef" | "policy">>,
  choices: Record<string, PluginChoice>,
): string {
  const m = [...mounts].sort((a, b) => a.alias.localeCompare(b.alias)).map((x) =>
    [x.alias, x.plugin, x.toolVersion, x.publicConfig, !!x.secretRef, x.policy ?? null]);
  const c = Object.keys(choices).sort().map((k) => [k, choices[k]]);
  return JSON.stringify([m, c]);
}

/**
 * Whether a cached harness may be handed out again. A changed catalogue
 * rebuilds it, but never under a turn that is running: that turn keeps the
 * tools it started with, and the next call after it ends gets the new list.
 * Rebuilding an idle one is what an eviction does anyway.
 */
export function reuseHarness(builtFrom: string, now: string, running: boolean): boolean {
  return builtFrom === now || running;
}

/**
 * One of the three words, or nothing.
 *
 * The console posts a form, so what arrives is a string of the user's shape
 * rather than a `PluginChoice`, and the cast that would make it compile is the
 * cast that would let `"disabled"` — a plausible typo for a real one — through
 * as neither enable nor disable, to be stored and then read back as a value
 * nothing resolves. Refusing at the edge keeps the store holding only words the
 * resolver knows.
 */
export function parsePluginChoice(value: unknown): PluginChoice | null {
  return value === "enable" || value === "disable" || value === "inherit" ? value : null;
}

export class AgentRuntime {
  readonly store: DurableObjectStore;
  #deps: RuntimeDeps;
  #plugins: Plugin[];
  /**
   * What the registry says a plugin's version is. A mount pins a version and
   * the gateway refuses a call when the pin and the registry disagree, so a
   * seed that writes a literal is a seed that breaks the day the plugin moves:
   * github went to 2.0.0 and every mount written as "1.0.0" was refused.
   */
  pluginVersion(id: string): string | undefined {
    return this.#plugins.find((p) => p.id === id)?.version;
  }

  /**
   * Re-pin every stored mount to the registry's version.
   *
   * A mount written before a plugin moved keeps the old pin, and nothing else
   * repairs it: seeding runs once, and the gateway's answer to a stale pin is
   * to refuse the call. github went to 2.0.0 and every mount seeded before
   * that day was refused on every call after it, silently, because the one
   * test that would have noticed died the same day. Every mount today is
   * seeded by the operator (a person cannot add one from the console), so
   * there is no person's pin to protect and following the registry is right;
   * if a person ever pins a version on purpose, this is where that stops.
   */
  async repinMounts(tenantId: string, agentId: string): Promise<string[]> {
    const repinned: string[] = [];
    for (const m of await this.store.listMounts(tenantId, agentId)) {
      const v = this.pluginVersion(m.plugin);
      if (v && v !== m.toolVersion) {
        await this.store.updateMountToolVersion(tenantId, agentId, m.alias, v);
        repinned.push(`${m.alias}: ${m.toolVersion} -> ${v}`);
      }
    }
    return repinned;
  }

  #gateway: ToolGateway;
  #secrets!: import("../../src/runtime/gateway.ts").SecretResolver;
  #kek: Promise<CryptoKey | null> = Promise.resolve(null);
  #unchecked = new Map<string, string>();
  // One harness per (agent, session): a conversation is a session inside the
  // agent's object, with its own transcript and the agent's shared mounts,
  // credentials and memory. Keyed so a second conversation never reads the
  // first one's transcript, and cached so a wake does not rebuild them all.
  #agents = new Map<string, { agent: PiAgent; builtFrom: string }>();
  #executor: DynamicWorkerExecutor;
  #models: ModelResolver;
  #artifacts: BoundArtifacts;
  #ready = false;

  constructor(deps: RuntimeDeps) {
    this.#deps = deps;
    this.store = new DurableObjectStore(deps.ctx);
    this.#artifacts = new BoundArtifacts(deps.bucket, deps.bucketName);
    const plugins: Plugin[] = [];
    plugins.push(
      githubPlugin,
      demoPlugin,
      httpPlugin,
      // Mounted only where an operator attaches a key; `http.search`'s keyless
      // path stays for everyone else.
      exaPlugin,
      // The lease reaches the plugin so its tools state the lifetime this deployment gives a box.
      sandboxPlugin(this.#artifacts as any, deps.bucketName, deps.idle ?? null),
      statePlugin(this.store, this.#artifacts as any, deps.bucketName),
      artifactsPlugin(this.#artifacts as any, deps.bucketName),
      raftPlugin,
      ...(deps.extraPlugins ?? []),
      builtinToolsPlugin(this.store, () => plugins),
    );
    this.#plugins = plugins;
    // Three reference forms, one resolver: the operator's sandbox account,
    // the agent's own sealed store, and the Worker environment. The gateway
    // passes the mount's owner as scope, so an `agent:` reference only ever
    // reaches the store of the agent whose mount names it.
    const kekPromise = deps.secretKek ? importKek(deps.secretKek) : Promise.resolve(null);
    const operator = {
      resolve: async (ref: string) =>
        ref === OPERATOR_RUN9_REF
          ? (deps.operatorRun9 ? JSON.stringify(deps.operatorRun9) : null)
          : envSecrets.resolve(ref),
    };
    this.#kek = kekPromise;
    this.#secrets = {
      resolve: async (ref, scope) => agentSecrets(this.store, await kekPromise, operator).resolve(ref, scope),
    };
    this.#gateway = new ToolGateway(this.store, plugins, this.#secrets,
      deps.hooks ? (tenantId, agentId, alias) => this.#inboundFor(tenantId, agentId, alias) : undefined);
    this.#executor = new DynamicWorkerExecutor({
      loader: deps.loader,
      makeToolBinding: deps.makeToolBinding,
    });
    // Credentials come from the same resolver mounts use, so a model key is
    // dereferenced server-side and never travels with the binding.
    this.#models = new ModelResolver(this.store, {
      resolve: async (ref) =>
        ref === OPERATOR_SECRET_REF
          ? (deps.operatorModel?.apiKey ?? null)
          : envSecrets.resolve(ref),
    });
  }

  // ---- inbound events: a service pushes at a mount's hook (src/runtime/inbound.ts).

  /**
   * Give a mount a hook secret, sealed in this agent's own store under the
   * hook's id, and return it once. The caller writes the public index only
   * after this succeeds, so a live URL always has a secret behind it.
   */
  async createHookSecret(tenantId: string, agentId: string, alias: string, hookId: string):
    Promise<{ ok: true; secret: string } | { ok: false; error: string }> {
    await this.ready();
    const kek = await this.#kek;
    if (!kek) return { ok: false, error: "this deployment has no SECRET_KEK, so it cannot keep a hook secret" };
    if (!(await this.store.getMountByAlias(tenantId, agentId, alias))) return { ok: false, error: `no mount named ${alias}` };
    const blocked = await this.#gateway.receiveBlocked(tenantId, agentId, alias);
    if (blocked) return { ok: false, error: blocked };
    const secret = newHookSecret();
    const sealed = await seal(kek, secret);
    await this.store.putSecret(tenantId, agentId, hookSecretName(hookId), { ciphertext: sealed.ciphertext, iv: sealed.iv });
    return { ok: true, secret };
  }

  /**
   * One mount's hooks, for its plugin (`PluginContext.inbound`). The secret
   * first, then the index, as the operator's route does: a URL that resolves
   * always has a secret. Revoke is the reverse, and only for this mount.
   */
  #inboundFor(tenantId: string, agentId: string, alias: string): InboundHooks {
    const hooks = this.#deps.hooks!;
    return {
      create: async () => {
        // Checked, then created: two creates at once can both pass and leave
        // one more than the cap. It bounds a leak; it is not an exact limit.
        const live = (await hooks.directory.list(tenantId, agentId)).filter((h) => h.alias === alias && h.revokedAt === null);
        if (live.length >= INBOUND_HOOKS_PER_MOUNT) {
          throw new Error(`${alias} already has ${live.length} live hooks; revoke one first`);
        }
        const hookId = newHookId();
        const made = await this.createHookSecret(tenantId, agentId, alias, hookId);
        if (!made.ok) throw new Error(made.error);
        await hooks.directory.create({ hookId, tenantId, agentId, alias });
        return { hookId, url: `${hooks.origin}/hooks/${hookId}`, secret: made.secret };
      },
      revoke: async (hookId) => {
        const row = await hooks.directory.lookup(hookId);
        if (!row || row.tenantId !== tenantId || row.agentId !== agentId || row.alias !== alias) return false;
        if (!(await hooks.directory.revoke(hookId))) return false;
        await this.dropHookSecret(tenantId, agentId, hookId);
        return true;
      },
    };
  }

  /** Forget a hook's secret. Whether there was one. */
  async dropHookSecret(tenantId: string, agentId: string, hookId: string): Promise<boolean> {
    await this.ready();
    return this.store.removeSecret(tenantId, agentId, hookSecretName(hookId));
  }

  /**
   * One pushed event. Answered as soon as the message is posted: the model
   * runs afterwards, on the object's own time, because the service wants its
   * answer within seconds (GitHub: 10 s). Every event leaves a row, delivered
   * or not, so an operator can see what arrived and why it went nowhere.
   */
  async receiveHook(tenantId: string, agentId: string, alias: string, hookId: string,
    event: InboundEvent | null): Promise<{ outcome: InboundOutcome }> {
    await this.ready();
    const sql = this.#deps.ctx.storage.sql;
    ensureInboundTable(sql);
    const now = Date.now();
    const done = (outcome: InboundOutcome, reason?: string | null, dedupeKey?: string | null) => {
      recordInbound(sql, { hookId, alias, outcome, reason, dedupeKey, now });
      return { outcome };
    };
    if (!event) return done("too_large", `the body passed ${INBOUND_MAX_BYTES} bytes`);
    const secret = await this.#secrets.resolve(agentRef(hookSecretName(hookId)), { tenantId, agentId });
    if (!secret) return done("failed", "this hook has no secret in the agent's store");
    let answer;
    try {
      answer = await this.#gateway.receive(tenantId, agentId, alias, event, secret);
    } catch (e: any) {
      // The plugin's own words stay in the record; the service only hears 503.
      return done("failed", String(e?.message ?? e));
    }
    // Switched off, gone, or pinned elsewhere: the request was fine and the
    // mount is not taking events, which the service should not report as broken.
    if ("skipped" in answer) return done("ignored", answer.skipped);
    const result = answer.result;
    if (!result.deliver) return done(result.rejected ? "rejected" : "ignored", result.reason);
    const key = result.dedupeKey ?? null;
    if (key && seenBefore(sql, hookId, key, now)) return done("duplicate", null, key);
    if (!underRate(sql, hookId, now)) return done("rate_limited", `more than ${INBOUND_PER_MINUTE} a minute`, key);
    await this.postMessage(tenantId, agentId, inboundMessage(alias, String(result.text)), "prompt", MAIN_SESSION);
    return done("delivered", null, key);
  }

  /** What arrived at this agent's hooks lately, newest first. No bodies are kept. */
  async inboundLog(limit = 50) {
    await this.ready();
    const sql = this.#deps.ctx.storage.sql;
    ensureInboundTable(sql);
    return recentInbound(sql, limit);
  }

  // ---- per-agent credentials, from the console. Value in, metadata out.

  /**
   * Store a credential for one of this agent's mounts and point the mount at
   * it. `fields` is what the form posted, keyed by the plugin's declared field
   * names; a bare token comes as `{ token }`. The value is sealed before it
   * touches storage, and if the plugin can check it and says no, nothing is
   * stored and the reason comes back instead.
   */
  async attachCredential(tenantId: string, agentId: string, alias: string, fields: Record<string, string>):
    Promise<{ ok: true; verified: boolean; account: string | null; error: string | null } | { ok: false; error: string }> {
    await this.ready();
    const kek = await this.#kek;
    if (!kek) return { ok: false, error: "this deployment has no SECRET_KEK, so it cannot keep a credential" };
    const mount = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!mount) return { ok: false, error: `no mount named ${alias}` };
    const plugin = this.#plugins.find((p) => p.id === mount.plugin);
    if (!plugin?.credential) return { ok: false, error: `${mount.plugin} takes no credential` };
    const form = credentialForm(plugin.credential);
    if (form.kind !== "fields") return { ok: false, error: "this credential is a sign-in, not something to paste" };
    const missing = form.fields.filter((f) => f.required && !String(fields[f.name] ?? "").trim());
    if (missing.length) return { ok: false, error: `missing: ${missing.map((f) => f.name).join(", ")}` };
    // The mount's settings are judged again with the reference this attach
    // would set, because a rule can depend on a credential being present
    // (http's allowlist is advice on an anonymous mount and a boundary on one
    // holding a key). Mount-time validation saw a mount with no key; this is
    // the moment it gains one, and "mount first, attach later" must not be a
    // way around a refusal the seed path would have made.
    const problems = validateMount(plugin, mount.publicConfig as any, agentRef(alias));
    if (problems.length) return { ok: false, error: problems.map((x) => x.message).join("; ") };
    // The value a plugin reads: a bare token, or one JSON object of the fields.
    const value = plugin.credential.shape === "token"
      ? String(fields.token ?? "").trim()
      : JSON.stringify(Object.fromEntries(form.fields.map((f) => [f.name, String(fields[f.name] ?? "").trim()])));
    const sealed = await seal(kek, value);
    const name = alias;
    // Check before keeping, with the candidate in place: the check reads the
    // credential through the same resolver a call would, so the mount points
    // at the sealed candidate first and is pointed back if the plugin says no.
    const previous = mount.secretRef;
    await this.store.putSecret(tenantId, agentId, name, { ciphertext: sealed.ciphertext, iv: sealed.iv });
    await this.store.setMountSecretRef(tenantId, agentId, alias, agentRef(name));
    const check = await this.#gateway.checkMount(tenantId, agentId, alias);
    // A refused key and an unanswered one are different news. Refused: the
    // provider looked and said no, so nothing is kept and the reason is shown.
    // Unreachable: nobody looked, so the key is kept unverified with the
    // reason beside it, rather than lost and blamed for an outage.
    if (check && !check.ok && check.kind === "rejected") {
      await this.store.removeSecret(tenantId, agentId, name);
      await this.store.setMountSecretRef(tenantId, agentId, alias, previous && !isAgentRef(previous) ? previous : null);
      return { ok: false, error: check.reason };
    }
    if (check?.ok) {
      await this.store.putSecret(tenantId, agentId, name, {
        ciphertext: sealed.ciphertext, iv: sealed.iv, account: check.account ?? null, verified: true,
      });
    }
    const unreachable = check && !check.ok ? `kept, could not be checked: ${check.reason}` : null;
    if (unreachable) this.#unchecked.set(`${tenantId}/${agentId}/${alias}`, unreachable);
    else this.#unchecked.delete(`${tenantId}/${agentId}/${alias}`);
    return { ok: true, verified: !!check?.ok, account: check?.ok ? (check.account ?? null) : null, error: unreachable };
  }

  async removeCredential(tenantId: string, agentId: string, alias: string): Promise<boolean> {
    await this.ready();
    const mount = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!mount || !isAgentRef(mount.secretRef)) return false;
    await this.store.removeSecret(tenantId, agentId, alias);
    await this.store.setMountSecretRef(tenantId, agentId, alias, null);
    return true;
  }

  /**
   * Hand a mount's container back now, on an operator's say-so.
   *
   * The agent has `release`, and an idle box is reclaimed on its own after the
   * lease runs out. Neither helps a person looking at a box that is billing
   * for an agent that has stopped asking: the console could see it and not act
   * on it (Nova, 2026-09-16).
   *
   * Refused while a background job is running on that mount, which is the same
   * reason #idlePass skips it: a background exec does not touch `lastUsedAt`,
   * so the box looks idle while a command is still inside it, and taking the
   * machine away discards that work. The operator cannot see that from the
   * panel, which is exactly why this asks instead of trusting the click.
   *
   * `releaseTask` reports what it could not release, and that is passed back
   * rather than folded into a success: a box that stayed up is still costing
   * money, and the page must not say it is gone.
   */
  async releaseMount(
    tenantId: string, agentId: string, alias: string,
  ): Promise<{ ok: true; released: boolean } | { ok: false; error: string }> {
    await this.ready();
    const mount = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!mount) return { ok: false, error: `no mount named ${alias}` };

    const sql = this.#deps.ctx.storage.sql;
    if (mountsWithRunningJobs(sql, { tenantId, agentId }).has(alias)) {
      return { ok: false, error: `${alias} is running a background job; releasing it now would discard that work` };
    }

    const state = (await this.store.getConnection(tenantId, agentId, alias)) as any;
    const boxId = typeof state?.boxId === "string" ? state.boxId : "";
    const r = await this.#gateway.releaseTask({ tenantId, agentId, taskId: LEGACY_TASK }, { alias });
    const failed = r.failed.find((f) => f.alias === alias);
    if (failed) return { ok: false, error: `${alias} was not released: ${failed.error}` };

    // The warning row is keyed by the box that is now gone. Left behind, the
    // next box under this alias inherits a release time it was never told.
    if (boxId) sql.exec("DELETE FROM box_warnings WHERE alias = ? AND box_id = ?", alias, boxId);
    return { ok: true, released: r.released.includes(alias) };
  }

  /**
   * Rename a mount, with the one thing a rename must not do to a container.
   *
   * The alias is the operator's word for a mount, and until now it was the one
   * thing about a mount that could not be changed — not by design, but because
   * nothing implemented it. What made it look dangerous is that the alias keys
   * two live things: the mount row and the connection state, and the second is
   * where a running box's id sits. The store does both in one transaction, so
   * "half a rename" is not a state this can reach.
   *
   * A third thing moves with them, and it is the one that is easy to miss:
   * `attachCredential` stores a mount's own credential under the mount's
   * alias, so `credentialMeta` and `removeCredential` look it up by whatever
   * the mount is called now. Rename without it and the console shows a
   * verified account as unverified with no name and no dates, while
   * `removeCredential` clears the pointer and leaves the ciphertext row with
   * nothing referring to it, for ever. An operator-configured reference is not
   * ours to move: it names something outside this agent.
   *
   * Refused while the mount is holding something. Not because the transaction
   * could not survive it — it could — but because the thing being renamed is
   * not only rows: a container goes on running while its state is re-keyed,
   * and a person renaming a machine mid-run has lost track of which one it is.
   * "Wait, or release it" is the better answer, and the refusal carries how
   * long it has been idle, because that is the next thing they will ask.
   *
   * The question goes through the gateway rather than into the mount's state,
   * so this stays ignorant of which plugin has containers and what it calls
   * them. A plugin that keeps nothing answers "nothing", and that is correct
   * rather than a special case.
   */
  async renameMount(
    tenantId: string, agentId: string, from: string, to: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    await this.ready();
    // The same rule `addMount` applies, which this path was quietly exempt from (#439). It is not
    // cosmetic: `:` is the character keeping a mount's credential row (named after the alias) apart
    // from an inbound hook's `hook:<id>` in the ONE per-agent secrets namespace. A rename that
    // skipped the charset could park a credential-less mount on a live hook's name, and the next
    // `attachCredential` — an upsert with no existence check — would overwrite that hook's signing
    // secret. The service keeps posting, the signature stops matching, and nothing says why.
    // Checked before anything else the rename does: a refusal should not depend on a container poll.
    if (!MOUNT_ALIAS.test(to)) return { ok: false, error: `an alias is ${MOUNT_ALIAS}` };
    const mount = await this.store.getMountByAlias(tenantId, agentId, from);
    if (!mount) return { ok: false, error: `no mount named ${from}` };
    const safety = renameSafety(
      await this.#gateway.mountActivity({ tenantId, agentId, taskId: LEGACY_TASK }, from),
      Date.now(),
    );
    if (!safety.safe) {
      // The contract's sentence, plus the two facts a person needs to choose
      // between waiting and releasing: which one, and how long it has sat.
      const idle = Math.round(safety.live.idleMs / 60_000);
      return { ok: false, error: `${safety.reason} (${safety.live.id}, idle ${idle}m)` };
    }
    // Only a credential this agent supplied moves. `operator:` references name
    // something the deployment owns, under a name that has nothing to do with
    // this mount's alias.
    const own = isAgentRef(mount.secretRef);
    return this.store.renameMount(tenantId, agentId, from, to, own ? { newRef: agentRef(to) } : null);
  }

  /** What a page may show for a mount's credential. Never the value, and
   *  nothing derived from it: an account name is the far end's label. */
  async credentialMeta(tenantId: string, agentId: string, mount: { alias: string; secretRef: string | null }) {
    const attached = !!mount.secretRef;
    const meta = isAgentRef(mount.secretRef) ? await this.store.secretMeta(tenantId, agentId, mount.alias) : null;
    return {
      attached,
      // A reference the operator configured at deploy time, not one entered
      // on the page: attached, and not something the page can replace.
      operator: attached && !isAgentRef(mount.secretRef),
      verified: meta?.verified ?? false,
      account: meta?.account ?? null,
      setAt: meta?.updatedAt ?? null,
      lastUsedAt: meta?.lastUsedAt ?? null,
      storable: !!this.#deps.secretKek,
      // Why an attached key is still unverified, when the store knows: the
      // provider could not be reached at attach time. Held in memory only, so
      // it clears on the next successful check or the next object start.
      error: this.#unchecked.get(`${tenantId}/${agentId}/${mount.alias}`) ?? null,
    };
  }

  async ready() {
    if (!this.#ready) {
      await this.store.init();
      this.#ready = true;
    }
  }

  /**
   * §5.4 lives here: the sandbox never receives a large result, only a
   * reference — but only where the agent can read one back.
   *
   * Parking assumed a reader. Where no artifacts tool is mounted (the SWE
   * benchmark mounts `tools` and a container and nothing else) a large result
   * became a reference the agent had no tool to open, with a note telling it
   * to call one that was not in its list: the content was simply gone, and
   * nothing said so. So the question "is there something that can read this
   * back" is asked here, where the answer is known, and the two branches say
   * different true things (Piper, 2026-09-12).
   */
  #host(
    ctx: { tenantId: string; agentId: string; taskId: string },
    /** The reader — offered name and address — or null when it has none. */
    reader: { name: string; address: string } | null,
    /** What the model was offered, so a job is named the way the model can name it back. */
    offered: MountedTool[] = [],
  ) {
    const readBack = reader?.name ?? null;
    const gw = this.#gateway;
    const store = this.store;
    const artifacts = this.#artifacts;
    const sql = this.#deps.ctx.storage.sql;
    return {
      async invoke(call: { tool: string; args: any; opts?: any; callId?: string }): Promise<ToolResult> {
        const res = await gw.invoke(ctx, call.tool, call.args,
          { ...(call.opts ?? {}), ...(call.callId === undefined ? {} : { callId: call.callId }) });
        // Work that has started and outlives this call (task #16). The model is
        // told at once that it may keep going; the job is checked on the alarm
        // and its result comes back as a message.
        if (res.status === "running" && res.background) {
          const owner = { tenantId: ctx.tenantId, agentId: ctx.agentId };
          const bg = res.background;
          const shown = offered.find((t) => t.address === call.tool)?.name ?? call.tool;
          const session = ctx.taskId === LEGACY_TASK ? MAIN_SESSION : ctx.taskId;
          const running = runningBackgroundJobs(sql, owner);
          if (!admitBackground(running).ok) {
            // Only the plugin knows which calls go to the background, and it
            // knows when it returns, so the cap is applied then. The work has
            // already started: it is recorded, asked to stop, and tracked until a
            // poll shows it ended — never dropped on a request whose failure went
            // unseen (refuseOverCap). The operation stays running until then.
            const refused = await refuseOverCap({
              sql, owner, running,
              job: { id: res.operationId, session, mount: bg.alias, tool: shown, handle: bg.handle },
              cancel: () => gw.cancelBackground(ctx, bg.alias, bg.handle),
            });
            return { status: "rejected", error: { code: "background_limit", message: refused.message } };
          }
          recordBackgroundJob(sql, owner, { id: res.operationId, session, mount: bg.alias, tool: shown, handle: bg.handle });
          return {
            status: "succeeded", operationId: res.operationId,
            result: startedResult({ id: res.operationId, mount: bg.alias, tool: shown }, bg.note) as unknown as Json,
          };
        }
        if (res.status !== "succeeded") return res;
        const body = JSON.stringify(res.result);
        const limit = limitForCall(call.tool, reader);
        if (body.length <= limit) return res;
        if (!readBack) {
          return {
            status: "succeeded",
            operationId: res.operationId,
            result: tooLargeResult(res.result, body, null),
          };
        }
        const key = `t/${ctx.tenantId}/${ctx.agentId}/${res.operationId}.json`;
        return {
          status: "succeeded",
          operationId: res.operationId,
          result: await parkResult(res.result, body, key, readBack, {
            put: (k, b) => artifacts.put(k, b),
            complete: (ref) => store.completeOperation(ctx.tenantId, res.operationId, "succeeded", ref),
            // The operations row keeps the raw reference; the model is shown the
            // agent's own path and nothing about where that agent lives (tygg,
            // 2026-09-14). The key is built from ctx above, so it is always under
            // this agent's scope.
            shownRef: (ref) => toAgentRef(ref, ctx)!,
          }),
        };
      },
    };
  }

  /**
   * What every agent is mounted with, whichever path makes it first: the
   * console on first open, or the API on first run. There was a shorter list
   * for the API path once, and an agent run before it was opened had no
   * memory; one list, read by both, is the only way that stays fixed.
   */
  static readonly DEFAULT_MOUNTS: SeedMount[] = [
    { alias: "tools", plugin: "tools", config: { account: "builtin" },
      secretRef: null, policy: null },
    // Without this a parked result is a reference the agent cannot open.
    { alias: "artifacts", plugin: "artifacts", config: { account: "builtin" },
      secretRef: null, policy: null },
    // `ops` (the demo plugin) used to be seeded here, and stopped being
    // defensible the day sign-up opened: it is a fake fleet — `list_servers`,
    // `deploy`, `restart`, with summaries that say "Changes production" — and
    // it was on the first screen a stranger saw. A demonstration is something
    // an operator chooses to show, not something every new account is given.
    // The plugin stays installed and mountable, so a demo is one mount away;
    // and because provisioning only adds what is missing, every agent that
    // already has `ops` keeps it. Nothing disappears from under anyone.
    // Open on purpose: the agent holds no credential and writes need a
    // human. maxBytes stays under the offload threshold so an ordinary page
    // reaches the model directly rather than via a round trip to storage.
    // Open, including writes, because the gate was on the wrong axis. It
    // was meant to stop data leaving, but an agent can put anything it
    // wants into a query string on a GET — so gating POST made the same
    // exfiltration one step less convenient and nothing more, at the cost
    // of stopping every ordinary API call for a signature. What actually
    // bounds where data can go is `allowedHosts`, which covers both.
    //
    // The gate still exists and still works; a mount that reaches
    // something that matters should use it, and use an allowlist too.
    { alias: "web", plugin: "http", config: { account: "open web", maxBytes: 24_000 },
      secretRef: null, policy: null },
    // GitHub, the first real user of the credential page. Seeded with no
    // token, so it reads public repositories; the person attaches their
    // own token there and the mount acts as that account. Writes are open:
    // the person's decision (task #10) is that the default allows every
    // operation a tool offers, and the agent decides which of its own calls
    // to hold for a person, by sending `confirm: true` with the call.
    { alias: "gh", plugin: "github", config: { account: "GitHub" },
      secretRef: null, policy: null },
    // A real container, for tasks that need one. Its tools describe
    // themselves as a last resort so the agent reaches for free in-process
    // JS first, and the framework releases the box once the agent has no
    // conversation with work open (the scope is the agent, not a task).
    { alias: "sandbox", plugin: "sandbox", config: { account: "container" },
      secretRef: OPERATOR_RUN9_REF, policy: null },
    // The agent's own store. Deliberately not behind approval: an agent
    // that must ask a person before writing a note will not keep notes, and
    // the blast radius is its own memory, scoped to this (tenant, agent).
    { alias: "state", plugin: "state", config: { account: "agent memory" },
      secretRef: null, policy: null },

  ];

  /** What is installed, for a console that wants to show settings rather than
   *  guess them from whichever mounts happen to exist. */
  plugins(): Plugin[] {
    return this.#plugins;
  }

  /** The gateway, so an approval decided outside a task can act on it. */
  gateway() {
    return this.#gateway;
  }

  async provision(
    tenantId: string,
    agentId: string,
    mounts: SeedMount[] = AgentRuntime.DEFAULT_MOUNTS,
  ) {
    await this.ready();
    if (await this.store.loadTask(tenantId, `${agentId}:probe`)) return { agentId, created: false };
    // The record and the mounts are separate questions. An agent the console
    // created has a record (name, description) and no mounts yet; the old
    // guard read "record exists" as "already provisioned" and gave such an
    // agent its first run with no tools and no memory. Each seed mount is
    // added only if absent, so this is safe to call on every first run.
    let created = false;
    if (!(await this.store.loadAgent(tenantId, agentId))) {
      await this.store.createAgent(tenantId, agentId, {});
      created = true;
    }
    // Asked before anything is added, because this runs on every console open
    // and not only at creation: without it, turning a plugin off would last
    // until the next page load and then be undone by the reconcile, which
    // would look like the switch not working rather than like a rule being
    // applied twice.
    const choices = await this.store.pluginChoices(tenantId, agentId);
    for (const m of mounts) {
      // The skip comes first on purpose: the assert below runs only for a
      // mount being added, so an open of an agent that already has its seven
      // costs one read per seed and no validation. Moving the assert above
      // this line would run it on every open of every agent.
      if (await this.store.getMountByAlias(tenantId, agentId, m.alias)) continue;
      // A seed the agent has turned off is not added. Only the adding is
      // governed here: a mount that already exists is left alone, because
      // switching a plugin off must not destroy the credential and the
      // connection state behind it — the gateway and the catalogue withhold
      // it instead, and switching it back on returns what was there.
      const declared = this.#plugins.find((p) => p.id === m.plugin);
      if (declared && !pluginEnabled(declared, choices[m.plugin])) continue;
      // The seed is hand-written and reaches every agent, and the console's
      // validator only shows problems to whoever opens the plugins page. The
      // throwing one had no caller at all. A misspelt setting is refused here,
      // at the first agent it would have reached, rather than becoming the
      // plugin's silent default everywhere.
      const plugin = this.#plugins.find((p) => p.id === m.plugin);
      if (plugin) assertMountConfig(plugin, (m.config ?? { account: m.account }) as Record<string, Json>, m.secretRef ?? null);
      await this.store.addMount({
        tenantId, agentId, alias: m.alias, plugin: m.plugin,
        installationId: `inst-${m.alias}`, connectionId: null,
        toolVersion: this.pluginVersion(m.plugin) ?? "1.0.0",
        publicConfig: m.config ?? { account: m.account }, secretRef: m.secretRef ?? null, policy: m.policy ?? null,
      });
    }
    return { agentId, created };
  }

  /**
   * One mount the defaults do not give, added by an operator (`/admin/mounts`).
   * Where `provision` skips quietly (plugin switched off, alias present), this
   * answers. An alias that is already there is left alone: the same plugin and
   * settings is a repeat, anything else is refused rather than overwritten,
   * because a mount carries a credential and connection state that a replace
   * would orphan. It is always added without a credential.
   */
  async addMount(tenantId: string, agentId: string, seed: { alias: string; plugin: string; config: Record<string, Json> }):
    Promise<{ ok: true; added: boolean } | { ok: false; error: string }> {
    await this.ready();
    if (!MOUNT_ALIAS.test(seed.alias)) return { ok: false, error: `an alias is ${MOUNT_ALIAS}` };
    const plugin = this.#plugins.find((p) => p.id === seed.plugin);
    if (!plugin) return { ok: false, error: `no plugin named ${seed.plugin}` };
    // A default alias stays its seed's, even while that plugin is switched
    // off and the alias is free: the seed would come back to find it taken.
    const seeded = AgentRuntime.DEFAULT_MOUNTS.find((d) => d.alias === seed.alias);
    if (seeded && seeded.plugin !== plugin.id) {
      return { ok: false, error: `${seed.alias} is the default ${seeded.plugin} mount's alias` };
    }
    const have = await this.store.getMountByAlias(tenantId, agentId, seed.alias);
    if (have) {
      if (have.plugin === seed.plugin && JSON.stringify(have.publicConfig) === JSON.stringify(seed.config)) {
        return { ok: true, added: false };
      }
      return { ok: false, error: `${seed.alias} is already a different mount` };
    }
    const choices = await this.store.pluginChoices(tenantId, agentId);
    if (!pluginEnabled(plugin, choices[plugin.id])) {
      return { ok: false, error: `${plugin.id} is switched off for this agent; switch it on first` };
    }
    // Judged as a mount with no account yet, minus the one rule that says it
    // must have one: the credential form needs the mount to exist, so a plugin
    // whose account is required (raft) could not be mounted otherwise. Until
    // the account is attached its calls fail on the missing credential, and
    // attaching re-judges the settings with the account in place.
    const accountLater = plugin.credential ? { ...plugin, credential: { ...plugin.credential, required: false } } : plugin;
    const problems = validateMount(accountLater, seed.config, null);
    if (problems.length) return { ok: false, error: `cannot mount ${plugin.id}: ${problems.map((p) => p.message).join("; ")}` };
    await this.store.addMount({
      tenantId, agentId, alias: seed.alias, plugin: plugin.id,
      installationId: `inst-${seed.alias}`, connectionId: null,
      toolVersion: this.pluginVersion(plugin.id) ?? "1.0.0",
      publicConfig: seed.config, secretRef: null, policy: null,
    });
    return { ok: true, added: true };
  }

  /**
   * Point a tenant at the operator's model account, explicitly.
   *
   * This exists so a demo or a benchmark can be set up in one call. It is a
   * deliberate act with a visible binding row behind it, not a default that
   * quietly applies to everyone who forgot to configure one.
   */
  async bindOperatorModel(tenantId: string, agentId: string | null = null) {
    await this.ready();
    const m = this.#deps.operatorModel;
    if (!m) throw new Error("no operator model configured on this deployment");
    await this.store.setModelBinding({
      tenantId, agentId, provider: "openai-compatible",
      model: m.model, baseUrl: m.baseUrl, secretRef: OPERATOR_SECRET_REF,
    });
    return { tenantId, agentId, model: m.model };
  }

  /** Mounts as the model sees them: a plain name, plus the mount-qualified
   *  address the harness dispatches to, because providers restrict name
   *  charsets. */
  async #catalogueKeyFor(tenantId: string, agentId: string): Promise<string> {
    return catalogueKey(await this.store.listMounts(tenantId, agentId), await this.store.pluginChoices(tenantId, agentId));
  }

  async #catalogueFor(tenantId: string, agentId: string) {
    const byId = new Map(this.#plugins.map((pl) => [pl.id, pl]));
    const all = await this.store.listMounts(tenantId, agentId);
    const choices = await this.store.pluginChoices(tenantId, agentId);
    const records = enabledMounts(all, byId, choices);
    return {
      records,
      unoffered: unofferedMounts(all, byId, choices)
        .map(({ mount, reason }) => ({ alias: mount.alias, plugin: mount.plugin, reason })),
      mounts: records.map((m) => ({
        alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
      })),
      tools: qualifyMountedTools(withholdTools(records.flatMap((m) =>
        (byId.get(m.plugin)?.tools ?? []).map((t) => ({
          name: t.name, description: t.summary, parameters: t.parameters,
          address: `${m.alias}.${t.name}`,
          // Carried through so replay policy and exclusivity are decided by the
          // plugin that knows, not guessed at the point of use.
          sideEffects: t.sideEffects, idempotency: t.idempotency,
          exclusive: (() => { const pl = byId.get(m.plugin); return pl ? isExclusive(pl) : undefined; })(),
        })),
      ), this.#deps.withholdTools ?? [])),
    };
  }

  /**
   * The agent, built from storage.
   *
   * Rebuilt whenever the object is asked about a different agent, and on every
   * wake, because the object may have been evicted since the last one. Building
   * it starts no timers and no provider work — it reads the transcript and
   * reports what was left open.
   */
  async agent(tenantId: string, agentId: string, session: string = MAIN_SESSION): Promise<PiAgent> {
    await this.ready();
    const key = `${tenantId}/${agentId}`;
    const cacheKey = `${key}#${session}`;
    const cached = this.#agents.get(cacheKey);
    if (cached) {
      const now = await this.#catalogueKeyFor(tenantId, agentId);
      const running = cached.builtFrom !== now &&
        (await cached.agent.lane.inspectExecution(BACKGROUND_CONTEXT)).current !== null;
      if (reuseHarness(cached.builtFrom, now, running)) return cached.agent;
      this.#agents.delete(cacheKey);
    }

    const binding = await this.store.getModelBinding(tenantId, agentId);
    if (!binding) throw new Error(`no model binding for ${key}`);
    // Before the catalogue is read: a stale pin is a mount whose every call
    // the gateway refuses, and the harness opening is the one moment every
    // agent passes through, console-made or API-made.
    await this.repinMounts(tenantId, agentId);
    const builtFrom = await this.#catalogueKeyFor(tenantId, agentId);
    const { tools, records, unoffered } = await this.#catalogueFor(tenantId, agentId);
    const sandbox = this.#deps.sandbox ?? true;
    // The call context's task is the conversation, so held calls and audit
    // rows say which conversation asked. The first session's id is the same
    // string the single-conversation object always used.
    // Which tool, if any, can read a parked result back — by plugin, and named
    // the way the model was offered it.
    const readTool = (tools as MountedTool[]).find((t) =>
      offersPlugin(records, [t], "artifacts") && t.address.endsWith(".read"));
    const reader = readTool ? { name: readTool.name, address: readTool.address } : null;
    const offered = withLimitNote(tools as MountedTool[], reader);
    const host = this.#host(
      { tenantId, agentId, taskId: session === MAIN_SESSION ? LEGACY_TASK : session }, reader, offered);
    const store = this.store;
    // The tools the model is offered are the mounts plus the sandbox. run_js is
    // not a mount — it is the one tool whose body is this object rather than a
    // plugin — so it is built here and handed to open beside the mounts. It
    // has to be in that list: open reconciles the names a session remembers
    // against it, and a tool added afterwards was removed on every reopen.
    // An agent's background work is its own to see and to stop (task #16), and
    // like run_js this tool's body is this object, not a plugin.
    const jobs = jobsTool({
      sql: this.#deps.ctx.storage.sql,
      owner: { tenantId, agentId },
      cancel: (job) => this.#gateway.cancelBackground(
        { tenantId, agentId, taskId: job.session === MAIN_SESSION ? LEGACY_TASK : job.session },
        job.mount, job.handle as Json),
      completeOperation: async (id, status) => { await this.store.completeOperation(tenantId, id, status, null); },
    });
    // Function tools an API caller runs itself (Agents API, task #17): offered to
    // the model like any tool; calling one pauses the turn for the caller's
    // result (client-calls.ts). A name the model is already offered is skipped.
    const agentRef: { current: PiAgent | null } = { current: null };
    const apiConfig = ((await store.loadAgent(tenantId, agentId))?.config as any)?.openai;
    const apiTools = apiConfig?.tools;
    // An agent made through the Agents API is offered only what its caller declared, plus a container when a
    // session asked for one: no run_js, and jobs only where a sandbox can start background work
    // (agents-api/provisioning.ts).
    const extras = harnessExtras({
      apiAgent: !!apiConfig, sandbox,
      hasBackgroundMount: offersCapability(
        records, offered as MountedTool[],
        (id) => !!backgroundOf(this.#plugins.find((pl) => pl.id === id) ?? {}),
      ),
    });
    const taken = new Set([...offered.map((t) => t.name), "run_js", "jobs"]);
    const callerTools = Array.isArray(apiTools)
      ? clientTools(
          apiTools.filter((t: any) => typeof t?.name === "string" && !taken.has(t.name)).map((t: any) => ({
            name: String(t.name), description: String(t.description ?? ""), parameters: t.parameters ?? { type: "object", properties: {} },
          })),
          { sql: this.#deps.ctx.storage.sql, session, lane: () => agentRef.current!.lane,
            branch: (tip) => agentRef.current!.storage.scanBranch({ start: tip, order: "oldestFirst" }, BACKGROUND_CONTEXT) as any })
      : [];
    const extraTools = [
      ...(extras.runJs
        ? [runJsTool(this.#executor as any, host, {
            onCalls: (n) => { void store.consumeQuota(tenantId, "tool_calls", n); },
            onRun: (run) => store.recordUsage?.(jsRunRows(
              { at: Date.now() - run.ms, tenantId, agentId }, run.ok ? "ok" : "failed", run.ms, run.hostCalls,
            )),
            // So a script names a tool the way the model's own list names it.
            tools: offered,
            // So a stale name for a mount that cannot be offered is answered with
            // the reason, not as a typo.
            unoffered,
          })]
        : []),
      ...(extras.jobs ? [jobs] : []),
      ...callerTools,
    ];

    const agent = await PiAgent.open({
      // A cancelled turn's request stays in the history, so the model is told it was cancelled; otherwise the
      // next turn finishes it (QA, 2026-09-15).
      entryProjectors: {
        [TURN_CANCELLED]: (entry) => [{ role: "user", content: [{ type: "text", text: CANCELLED_NOTE }], timestamp: entry.timestamp }],
      },
      host: this.#deps.ctx.storage,
      usageOwner: { tenantId, agentId },
      sessionId: session === MAIN_SESSION ? key : `${key}#${session}`,
      session,
      // Read here rather than inside the harness, so the harness keeps holding
      // no I/O of its own.
      systemPrompt: systemPrompt({
        // The agent's own record: a person named and described it at creation,
        // and that is the first thing the prompt says after the core.
        persona: personaOf((await this.store.loadAgent(tenantId, agentId))?.config),
        // Whatever the mounted plugins have to say, in registry order. The
        // framework no longer reaches into any one plugin for this (Piper,
        // tygg, 2026-09-12).
        contributions: await this.#gateway.promptContributions({ tenantId, agentId, taskId: LEGACY_TASK }),
        policy: this.#deps.policy,
        // Each paragraph appears only where the thing it describes is really
        // there — telling an agent to read a result back with a tool it has not
        // got is a wrong instruction competing with the right ones. That used
        // to be a question this file asked about one plugin; the artifacts
        // paragraph is now the artifacts mount's own contribution, so the
        // condition is "the mount is there" and nobody has to check it.
        // `sandbox` stays: run_js is the harness's, not a mount's.
        sandbox: extras.runJs,
      }),
      model: {
        provider: binding.provider,
        id: binding.model,
        contextWindow: this.#deps.contextWindow ?? ASSUMED_CONTEXT_WINDOW,
      },
      tools: offered,
      extraTools: extraTools as any,
      toolHost: host,
      dispatch: async (jobId) => {
        const send = this.#deps.offloadModel;
        if (!send) throw new Error("no dispatcher configured");
        await send({ tenantId, agentId, taskId: LEGACY_TASK, commandId: jobId, payload: null });
      },
    });
    agentRef.current = agent;
    this.#agents.set(cacheKey, { agent, builtFrom });
    return agent;
  }

  /** Compact on demand, the way pi's /compact does: an operation like any
   *  other, so it is admitted, durable, and drives on the same pass. */
  async requestCompaction(tenantId: string, agentId: string, session: string = MAIN_SESSION) {
    return (await this.agent(tenantId, agentId, session)).compact();
  }

  /**
   * The two gestures pi distinguishes, and the reason they are different.
   *
   * `steer` is the default and the one that matters: a message typed while the
   * agent is working reaches the model before its next call, without stopping
   * the tool call in flight. Nothing is aborted; the current turn finishes and
   * the new instruction is simply there when the next one is composed.
   *
   * `followUp` waits until the agent has finished everything.
   */
  async postMessage(
    tenantId: string, agentId: string, text: string,
    mode: "prompt" | "steer" | "followUp" = "prompt",
    session: string = MAIN_SESSION,
  ) {
    const agent = await this.agent(tenantId, agentId, session);
    // A conversation that has just been spoken to has work until a step says
    // otherwise, so the next wake steps it.
    markSession(this.#deps.ctx.storage.sql, session, true);
    const res: any = await agent.say(text, mode);
    // What actually happened rather than what was asked for: a run admitted
    // carries an operation id, a queued message carries an entry id.
    const landed = res?.value?.operationId ? "prompt" : mode === "followUp" ? "followUp" : "steer";
    return { mode: landed, queued: landed !== "prompt", result: res };
  }

  /**
   * Stop a session's turn and the background work it started (Agents API
   * input.cancel, task #17). pi's abort ends the run and drops its model call
   * but records nothing (measured 2026-09-14), so a marker entry says the turn
   * was cancelled. A background job whose stop cannot be confirmed stays
   * tracked, and the ceiling asks again. Nothing running is not an error.
   */
  async cancelSession(tenantId: string, agentId: string, session: string = MAIN_SESSION) {
    const agent = await this.agent(tenantId, agentId, session);
    const cancelledTurn = await agent.cancel(TURN_CANCELLED);
    const sql = this.#deps.ctx.storage.sql;
    ensureAgentTables(sql);
    // A turn waiting for the caller has no run to abort; it still ends, and says so.
    if (dropClientCalls(sql, session) > 0 && !cancelledTurn) {
      await agent.lane.appendCustomEntry(TURN_CANCELLED, { operationId: null }, BACKGROUND_CONTEXT);
    }
    const jobs = await stopSessionJobs({
      sql, owner: { tenantId, agentId }, session,
      cancel: (job) => this.#gateway.cancelBackground(
        { tenantId, agentId, taskId: session === MAIN_SESSION ? LEGACY_TASK : session }, job.mount, job.handle as Json),
      completeOperation: async (id, status) => { await this.store.completeOperation(tenantId, id, status, null); },
    });
    return { cancelledTurn, stoppedJobs: jobs.stopped, stillRunning: jobs.stillRunning };
  }

  /** The session's branch, oldest first: what the model's context is built from. */
  async branchEntries(tenantId: string, agentId: string, session: string) {
    const agent = await this.agent(tenantId, agentId, session);
    const tip = (await agent.lane.inspectExecution(BACKGROUND_CONTEXT)).tipId;
    return tip ? agent.storage.scanBranch({ start: tip, order: "oldestFirst" }, BACKGROUND_CONTEXT) : [];
  }

  /** Function calls this session waits on its API caller for, with the turn each belongs to. */
  async waitingClientCalls(tenantId: string, agentId: string, session: string) {
    const rows = pendingClientCalls(this.#deps.ctx.storage.sql, session);
    if (!rows.length) return [];
    const turns = callTurns(await this.branchEntries(tenantId, agentId, session));
    return rows.map((r) => ({ ...r, turn_id: turns.get(r.call_id) ?? "" }));
  }

  /**
   * An API caller's function results (task #17). Each must name a call the
   * model made in that turn of this session; if any does not, none is kept.
   * The turn continues on the next pass once every paused call has its result.
   */
  async submitToolResults(
    tenantId: string, agentId: string, session: string,
    results: Array<{ turnId: string; callId: string; output: string; isError: boolean }>,
  ): Promise<{ unknown: string[] }> {
    const turns = callTurns(await this.branchEntries(tenantId, agentId, session));
    const unknown = results.filter((r) => turns.get(r.callId) !== r.turnId).map((r) => r.callId);
    if (unknown.length) return { unknown };
    const sql = this.#deps.ctx.storage.sql;
    ensureAgentTables(sql);
    for (const r of results) answerClientCall(sql, session, r.callId, { output: r.output, isError: r.isError });
    markSession(sql, session, true);
    return { unknown: [] };
  }

  /**
   * One pass over every session with work, which is all an alarm should ever
   * do. A session is stepped when its last step left something open or a
   * model call of its is still out; the rest stay closed and cost nothing.
   * The wake is the soonest any session asked for.
   */
  async step(tenantId: string, agentId: string) {
    await this.ready();
    const sql = this.#deps.ctx.storage.sql;
    ensureAgentTables(sql);
    // Background work first (task #16). A job that ended is delivered as a
    // message, which marks its session as having work, so the loop below steps
    // it in this same pass; the rest say when they want checking again.
    const owner = { tenantId, agentId };
    const jobCtx = (job: { session: string }) =>
      ({ tenantId, agentId, taskId: job.session === MAIN_SESSION ? LEGACY_TASK : job.session });
    const bg = await runBackgroundPass({
      sql, owner,
      poll: (job) => this.#gateway.pollBackground(jobCtx(job), job.mount, job.handle as Json),
      cancel: (job) => this.#gateway.cancelBackground(jobCtx(job), job.mount, job.handle as Json),
      completeOperation: async (id, status) => { await this.store.completeOperation(tenantId, id, status, null); },
      deliver: async (session, text) => { await this.postMessage(tenantId, agentId, text, "prompt", session); },
    });
    const sessions = sessionsWithWork(sql);
    if (!sessions.length) sessions.push(MAIN_SESSION);
    let open = 0, wakeInMs: number | null = bg.wakeInMs;
    const settled: Array<{ operationId: string; status: string }> = [];
    for (const session of sessions) {
      const agent = await this.agent(tenantId, agentId, session);
      const out = await agent.step();
      // A turn paused for an API caller's function results continues once they
      // have all arrived; the next pass drives the run this starts.
      const resumed = out.open === 0 && await resumeClientCalls({
        sql, session, lane: agent.lane as any,
        branch: (tip) => agent.storage.scanBranch({ start: tip, order: "oldestFirst" }, BACKGROUND_CONTEXT) as any,
      });
      open += out.open + (resumed ? 1 : 0);
      settled.push(...out.settled);
      const wake = resumed ? 0 : out.wakeInMs;
      if (wake !== null) wakeInMs = wakeInMs === null ? wake : Math.min(wakeInMs, wake);
      markSession(sql, session, resumed || out.open > 0 || out.wakeInMs !== null);
    }
    // A finished run should not still be holding a metered container — either
    // by handing it back at once, or, where the deployment leases them, by
    // asking the agent first and taking it at the ceiling.
    let releaseFailed: Array<{ alias: string; error: string }> = [];
    // A turn that settled while background work runs has not finished using
    // its containers: releasing now would take the machine out from under the
    // job, which is the normal case, since the model keeps working (task #16).
    const backgroundRunning = runningBackgroundJobs(sql, owner).length > 0;
    if (this.#deps.autoRelease !== false && open === 0 && !backgroundRunning) {
      if (!this.#deps.idle) {
        if (settled.length) {
          const r = await this.#gateway.releaseTask({ tenantId, agentId, taskId: LEGACY_TASK });
          releaseFailed = r.failed;
        }
      } else {
        // Runs on every idle pass, not only after work settles: the reminder
        // that matters is the one nothing else would have woken us for.
        const idle = await this.#idlePass(tenantId, agentId);
        releaseFailed = idle.releaseFailed;
        if (idle.wakeInMs !== null) wakeInMs = wakeInMs === null ? idle.wakeInMs : Math.min(wakeInMs, idle.wakeInMs);
      }
    }
    return { open, wakeInMs, settled, releaseFailed };
  }

  /**
   * One look at every metered mount: remind, take, or come back later.
   *
   * The state is the plugin's (run9 writes `boxId`, `lastUsedAt`, and the
   * agent's `quietUntil`); the schedule is the framework's, which is why this
   * reads that state rather than the plugin reading a clock. A mount with no
   * live box says nothing and costs nothing.
   */
  async #idlePass(tenantId: string, agentId: string): Promise<{
    wakeInMs: number | null; releaseFailed: Array<{ alias: string; error: string }>;
  }> {
    const { warnMs, maxMs } = this.#deps.idle!;
    const now = Date.now();
    const sql = this.#deps.ctx.storage.sql;
    // Which release time each box's agent was already told about (idle-lease.ts): one warning per release
    // time. The old `box_reminders` counted escalating reminders and is no longer read.
    sql.exec(`CREATE TABLE IF NOT EXISTS box_warnings(
      alias TEXT NOT NULL, box_id TEXT NOT NULL, release_at INTEGER NOT NULL,
      PRIMARY KEY (alias, box_id))`);
    let wakeInMs: number | null = null;
    let releaseFailed: Array<{ alias: string; error: string }> = [];
    const soon = (ms: number) => { wakeInMs = wakeInMs === null ? ms : Math.min(wakeInMs, ms); };
    // The names the model was actually offered, read from the same list it was
    // offered them from: qualification sanitises the alias and breaks ties, so
    // a name rebuilt here would be a copy that is right only until it is not.
    const { tools } = await this.#catalogueFor(tenantId, agentId);
    const offeredName = (alias: string, tool: string) =>
      (tools as MountedTool[]).find((t) => t.address === `${alias}.${tool}`)?.name ?? null;

    // A background exec does not touch lastUsedAt, so a box running one looks
    // idle for as long as the command runs; reclaim would take the machine out
    // from under it (Piper, 2026-09-14). The job table knows; the box does not.
    const busy = mountsWithRunningJobs(sql, { tenantId, agentId });
    for (const mount of await this.store.listMounts(tenantId, agentId)) {
      if (busy.has(mount.alias)) continue;
      const state = (await this.store.getConnection(tenantId, agentId, mount.alias)) as any;
      const boxId = typeof state?.boxId === "string" ? state.boxId : "";
      const lastUsedAt = Number(state?.lastUsedAt) || 0;
      // No box, or a state that cannot say when it was last used: nothing to
      // schedule from, and inventing a clock here is how a box in use gets
      // taken mid-task.
      if (!boxId || !lastUsedAt) continue;
      const row = sql.exec("SELECT release_at FROM box_warnings WHERE alias = ? AND box_id = ?", mount.alias, boxId)
        .toArray()[0] as any;
      const warnedFor = Number(row?.release_at) || 0;
      // `quietUntil` is the agent's postponement, written by the plugin's `quiet` and capped there.
      const d = idleDecision({ lastUsedAt, postponedUntil: Number(state?.quietUntil) || 0, warnedFor, now, warnMs, maxMs });
      if (d.do === "wait") { soon(d.wakeInMs); continue; }
      if (d.do === "warn") {
        // The warning is a turn the agent takes, so it is a message rather
        // than a signal: the model has to be able to answer it with a call.
        const limit = Number((mount.publicConfig as any)?.maxQuietMinutes) || null;
        await this.postMessage(tenantId, agentId,
          warningText(mount.alias,
            { release: offeredName(mount.alias, "release"), quiet: offeredName(mount.alias, "quiet") },
            d.idleMs, d.untilReleaseMs, limit), "prompt");
        sql.exec("INSERT INTO box_warnings(alias, box_id, release_at) VALUES (?,?,?) " +
          "ON CONFLICT(alias, box_id) DO UPDATE SET release_at = excluded.release_at", mount.alias, boxId, d.releaseAt);
        // 0: postMessage only marks the session, so this wake is what runs the warning's turn (idle-lease.ts).
        soon(d.wakeInMs);
        continue;
      }
      // Past its release time. This box only: each mount has its own idle clock,
      // so one reaching its time says nothing about another's.
      const r = await this.#gateway.releaseTask({ tenantId, agentId, taskId: LEGACY_TASK }, { alias: mount.alias });
      releaseFailed = [...releaseFailed, ...r.failed];
      sql.exec("DELETE FROM box_warnings WHERE alias = ? AND box_id = ?", mount.alias, boxId);
    }
    return { wakeInMs, releaseFailed };
  }

  /** What the worker asks for, and what it hands back. The job row says which
   *  session asked, so the answer lands in the transcript that is waiting. */
  async takeJob(tenantId: string, agentId: string, jobId: string) {
    await this.ready();
    const session = jobSession(this.#deps.ctx.storage.sql, jobId) ?? MAIN_SESSION;
    return (await this.agent(tenantId, agentId, session)).takeJob(jobId);
  }

  async deliverAnswer(tenantId: string, agentId: string, jobId: string, answer: unknown) {
    await this.ready();
    const session = jobSession(this.#deps.ctx.storage.sql, jobId) ?? MAIN_SESSION;
    return (await this.agent(tenantId, agentId, session)).deliver(jobId, answer as any);
  }
}
