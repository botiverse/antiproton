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
import { contextWindowFor } from "../../src/model/context-windows.ts";
import { operatorRefFor, providerOfRef, type OperatorModel } from "../../src/model/operator-request.ts";
import { DEFAULT_PROVIDER, providerFor, type ModelChoice, type ModelProviders } from "../../src/model/providers.ts";
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import { DynamicWorkerExecutor } from "../../src/runtime/dynamic-worker-executor.ts";
import type { AgentEngine } from "../../src/runtime/engine.ts";
import { PiAgent, ensureAgentTables, jobSession, sessionsWithWork, markSession } from "../../src/runtime/pi-agent.ts";
import { DurableAgent, PdHost, recordedEngine } from "../../src/runtime/durable-agent.ts";
import { migrateToPd, revertToPi085, type MigrationResult, type RevertResult } from "../../src/runtime/pd-migrate.ts";
import { heldDecision, warningText } from "../../src/runtime/idle-lease.ts";
import { heldLines, heldPrompt, heldResources, withHeldNote } from "../../src/runtime/held.ts";
import {
  admitBackground, jobsTool, mountsWithRunningJobs, recordBackgroundJob, refuseOverCap, runBackgroundPass, runningBackgroundJobs, startedResult, stopSessionJobs,
} from "../../src/runtime/background-jobs.ts";
import {
  bridgeTools, offeredToolName, offersPlugin, offersCapability, qualifyMountedTools, resumeTool, runJsTools, type MountedTool,
  withholdTools,
  refuseWithheld,
} from "../../src/runtime/pi-tools.ts";
import { explainUnavailableTool } from "../../src/runtime/unavailable-tool.ts";
import { systemPrompt } from "../../src/runtime/pi-prompt.ts";
import { ASSUMED_CONTEXT_WINDOW } from "../../src/model/context-windows.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core/harness/context";
import { callTurns, CANCELLED_NOTE, TURN_CANCELLED } from "./agents-api/transcript.ts";
import { apiAgentSeeds, harnessExtras } from "./agents-api/provisioning.ts";
import {
  answerClientCall, clientTools, pendingClientCalls,
} from "../../src/runtime/client-calls.ts";

export { ASSUMED_CONTEXT_WINDOW } from "../../src/model/context-windows.ts";

/**
 * pi has no task id: a run is an operation and the conversation is a lane.
 * The gateway, quotas and approvals still address a task, so one constant
 * stands where the identifier used to be until those follow.
 */
const LEGACY_TASK = "main";

/** The answer to a call made after the agent's task was ended (`RuntimeDeps.ended`). */
function taskEndedRefusal(address: string): { status: "rejected"; error: { code: string; message: string } } {
  return {
    status: "rejected",
    error: { code: "task_ended", message: `${address} was not run: this task has ended and its machine has been handed back` },
  };
}
import { ToolGateway, type InvokeOpts } from "../../src/runtime/gateway.ts";
import { assertMountConfig, configFromForm, validateMount } from "../../src/runtime/mount-config.ts";
import { envSecrets } from "../../src/runtime/gateway.ts";
import { agentSecrets, agentRef, importKek, isAgentRef, open, OWNER_PREFIX, seal, secretRefKind, type Sealed } from "../../src/runtime/secrets.ts";
import {
  acceptInbound, claimPendingInbound, ensureInboundTable, hookSecretName, inboundMessage, markPostingInbound, newHookId, newHookSecret,
  nextPendingInbound, pendingInboundCount, recentInbound, recordInbound, requeueInbound, seenBefore, settleInbound, underRate,
  expiredPendingInbound, pendingInboundRow, queueFull, queueRetryAfterS, rateRetryAfterS, INBOUND_QUEUE_RETRY_AFTER_S,
  INBOUND_MAX_AGE_MS, INBOUND_MAX_BYTES, INBOUND_PER_MINUTE, INBOUND_POST_ATTEMPTS, INBOUND_QUEUE_MAX, type InboundOutcome, type PendingInbound,
} from "../../src/runtime/inbound.ts";
import type { InboundEvent, InboundHooks } from "../../src/plugins/types.ts";
import { INBOUND_HOOKS_PER_MOUNT } from "../../src/plugins/types.ts";
import { MAIN_SESSION } from "../../src/store/pi-storage.ts";
import { contextIdOf } from "../../src/runtime/context-id.ts";
import { UnknownJob } from "./model-queue.ts";

/** The persona fields of an agent record, if it carries any. */
export function personaOf(config: unknown): { name?: string; description?: string } | null {
  const c = (config ?? {}) as Record<string, unknown>;
  const name = typeof c.name === "string" ? c.name : undefined;
  const description = typeof c.description === "string" ? c.description : undefined;
  return name || description ? { name, description } : null;
}

/**
 * The gateway options a call through the agent's tool host may carry: `confirm`
 * (only ever true) and `idempotencyKey` from the call, `callId` beside it.
 * Nothing else is forwarded, because the host's callers include `run_js`,
 * which hands a program's own options in, and the gateway reads `approved` as
 * "a person already said yes" and `operationId` as "this is that operation".
 * Both are set by the gateway's own approval path (`applyApproval`), which does
 * not come through here. `fromProgram` (only ever true) is forwarded too: run_js
 * sets it on every call it makes, after the program's options, and the gateway
 * refuses a `modelOnly` tool on it — dropped here, that refusal never fires.
 */
export function hostCallOpts(call: { opts?: unknown; callId?: string }): InvokeOpts {
  const o = (call.opts ?? {}) as { confirm?: unknown; idempotencyKey?: unknown; fromProgram?: unknown };
  return {
    ...(o.confirm === true ? { confirm: true } : {}),
    ...(o.fromProgram === true ? { fromProgram: true } : {}),
    ...(typeof o.idempotencyKey === "string" ? { idempotencyKey: o.idempotencyKey } : {}),
    ...(call.callId === undefined ? {} : { callId: call.callId }),
  };
}
import type { MountPolicy, MountRecord } from "../../src/core/types.ts";
import type { HookDirectory, HookRow } from "./control-plane.ts";
import { jsRunRows } from "../../src/usage/outbox.ts";
import { RunJsContinuations } from "../../src/runtime/run-js-resume.ts";

/** What an operator may call a mount: it becomes the `<alias>__` prefix of every tool name. */
export const MOUNT_ALIAS = /^[a-z][a-z0-9-]{0,23}$/;

/**
 * How a mount added from the console is told apart: its `installationId`
 * starts with this (`console:<alias>:<uuid>`, fresh on every add). That field is
 * stored on every mount and kept by a rename, and otherwise read only as the
 * mount's identity when a tool listing is written back, so marking it needs no
 * new column in either store and no migration, and the mark survives the mount
 * being renamed. Every other path
 * writes `inst-<alias>` (or a fixed id), so no mount predating the console
 * route reads as console-added.
 */
export const CONSOLE_INSTALLATION = "console:";
/** Whether a person added this mount from the console. */
/** Why a removal stopped part-way: the alias no longer names the mount it set out to remove. */
const changedWhileRemoving = (alias: string) =>
  `${alias} was removed or added again while this removal was running; it stopped, and the mount now named ${alias} was not touched`;

export function consoleAdded(m: Pick<MountRecord, "installationId">): boolean {
  return m.installationId.startsWith(CONSOLE_INSTALLATION);
}

/**
 * The installation id `provision` gives a seed's mount, and `/admin/mounts` an operator's: the one a catalogue
 * row's reconcile (`uiEnsure`) may update. Anything else under the alias — a mount a person added from the
 * console — has settings that are its owner's, not the catalogue's.
 */
export function seedInstallation(alias: string): string {
  return `inst-${alias}`;
}
/**
 * How many mounts one agent may have added from the console. Each is a server
 * asked for its tools at add time and a block of tools in every prompt, and a
 * form is cheaper to submit than either is to carry.
 */
export const CONSOLE_MOUNTS_MAX = 8;

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
  /** Which kinds of agent the seed is for; absent means every kind. Judged by `seedApplies`. */
  for?: readonly AgentKind[];
  /** The catalogue revision that added this entry; with the alias, the entry's identity in an agent's record
   *  (src/store/seed-record.ts). Absent reads as 1. */
  since?: number;
}

/**
 * What kind of agent this is, for a seed's `for`, read from its record: "raft" when Raft made it
 * (`provisionedBy`), "api" when the Agents API did (the `openai` config its adopt writes, cf/src/index.ts
 * `#apiPersona`, which the harness also reads), else "console". The record is the fact because both write it
 * before anything is seeded (cf/src/provision/steps.ts; `#adopt` before `apiAgentSeeds`), and every agent either
 * made carries it. An API agent still reaches the catalogue: a console open (`uiEnsure`) provisions every agent
 * it opens, so the rows' `for` is what keeps the console's defaults off one.
 */
export type AgentKind = "console" | "raft" | "api";
export function agentKind(config: unknown): AgentKind {
  const c = config as { provisionedBy?: unknown; openai?: unknown } | null | undefined;
  if (c?.provisionedBy === PROVISIONED_BY) return "raft";
  if (c?.openai !== undefined && c?.openai !== null) return "api";
  return "console";
}

/** A row of the catalogue: a seed that says which agents it is for and when it was added. */
export type CatalogueMount = SeedMount & { for: readonly AgentKind[]; since: number };

/**
 * Whether `provision` adds this seed to this agent: it is for the agent's kind (null: the caller's own list,
 * where `for` is not asked), and its plugin (when installed) does not report the deployment unable to run it.
 * Asked on every pass, not only at creation; like a switched-off plugin, it governs only the adding (and
 * `uiEnsure`'s reconcile), never a mount already there.
 */
export function seedApplies(seed: SeedMount, kind: AgentKind | null, plugin: Plugin | undefined): boolean {
  if (kind !== null && seed.for && !seed.for.includes(kind)) return false;
  return !plugin?.unavailable?.();
}

/**
 * What a catalogue pass on one agent is judged from, as one string: the catalogue (its revision, the highest
 * `since`, and the entries themselves), the agent's kind, its answers about the catalogue's plugins, and which of
 * those plugins the deployment cannot run. A pass whose key equals the one stored on the agent does nothing
 * (src/store/seed-record.ts). Each part is here because a change in it can change an outcome: an owner switching a
 * plugin back on, a deployment gaining the configuration a plugin lacked, an agent Raft adopts. So `declined` and
 * `unavailable` are not final; `added` is, and that is the record's rule, not the key's.
 */
export function seedKey(
  catalogue: readonly SeedMount[], kind: AgentKind, choices: Record<string, PluginChoice>, unavailable: readonly string[],
): { key: string; revision: number } {
  const revision = Math.max(0, ...catalogue.map((m) => m.since ?? 1));
  const ids = [...new Set(catalogue.map((m) => m.plugin))].sort();
  return {
    revision,
    key: JSON.stringify({
      revision, kind,
      entries: catalogue.map((m) => `${m.alias}@${m.since ?? 1}:${m.plugin}`),
      choices: ids.filter((p) => choices[p] !== undefined).map((p) => `${p}:${choices[p]}`),
      unavailable: [...unavailable].sort(),
    }),
  };
}
import { credentialForm, pluginEnabled, renameSafety, isExclusive, backgroundOf, interruptsOf, toolsOf } from "../../src/plugins/types.ts";
import { githubPlugin } from "../../src/plugins/github.ts";
import { demoPlugin } from "../../src/plugins/demo.ts";
import { httpPlugin } from "../../src/plugins/http.ts";
import { exaPlugin } from "../../src/plugins/exa.ts";
import { keptDelete, keptList, keptNameProblem, keptPut, keptValueProblem, statePlugin } from "../../src/plugins/state.ts";
import { sandboxPlugin, SANDBOX_ALIAS } from "../../src/plugins/sandbox.ts";
import { builtinToolsPlugin } from "../../src/plugins/builtin.ts";
import { artifactsPlugin, PARK_BYTES, READ_WHOLE_MAX } from "../../src/plugins/artifacts.ts";
import { createRaftPlugin } from "../../src/plugins/raft.ts";
import { mcpPlugin } from "../../src/plugins/mcp.ts";
import { createReminderPlugin } from "../../src/plugins/reminder.ts";
import { PROVISION_MOUNT_ALIAS, PROVISIONED_BY } from "./provision/steps.ts";
import { toAgentRef } from "../../src/store/refs.ts";
import type { Plugin, PluginChoice } from "../../src/plugins/types.ts";
import type { SeedPassResult, SeedPlan } from "../../src/store/seed-record.ts";
import type { ToolInterrupt, ToolResult } from "../../src/core/tools.ts";
import type { Json } from "../../src/core/types.ts";
import type { ModelResponse } from "../../src/model/types.ts";

/** A model call handed to a Worker. Carries the command id, because the reply
 *  has to land under the same dedup key the inline path would have used. */
/** Commands cheap enough to send elsewhere: pure request/response, no bridge
 *  back into this object. `js.execute` needs the sandbox host, `tool.call` is
 *  short, and neither answers under the `:response` dedup key. */
const OFFLOADABLE = ["model.request"];

/** What one pass over the queued pushes did (`AgentRuntime.deliverPendingInbound`). */
export interface InboundPass {
  posted: number;
  /** Rows settled as failed: given up after `INBOUND_POST_ATTEMPTS`, or found interrupted mid-post. */
  failed: number;
  /** Rows settled as ignored, unposted: accepted by a mount that has since been removed. */
  ignored: number;
  /** Rows still queued when the pass ended. */
  left: number;
  /** When to come back for a row that could not be posted yet; null when none is waiting on a retry. */
  retryInMs: number | null;
  /** The longest any posted row waited between its answer and its post. */
  waitedMs: number | null;
  error: string | null;
}

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
/**
 * Which offered tool, if any, can hand a parked result back.
 *
 * A function rather than an expression inside the builder, because the builder
 * needs a live object to run and a rule that can only be exercised through one
 * is a rule nothing tests. It asks the tool what it does; the previous form
 * rebuilt the string `artifacts` + `.read`, which made the reader that plugin
 * under that name — rename either and the runtime silently had no reader, and
 * every parked result became a dead end.
 */
export function parkedReader(tools: MountedTool[]): { name: string; address: string } | null {
  const t = tools.find((x) => x.reads === "parked-result");
  return t ? { name: t.name, address: t.address } : null;
}

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

/** Whether a binding spends the operator's model account, through any provider. */
export const isOperatorModelRef = (ref: string) => providerOfRef(ref) !== null;
/** The operator's sandbox account. Kept distinct from the model's reference so a
 *  tenant can be moved onto its own run9 project without touching its model binding. */
export const OPERATOR_RUN9_REF = "operator:run9";
/** The operator's Exa key, for the web search every agent is seeded with. */
export const OPERATOR_EXA_REF = "operator:exa";

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
  operatorModel?: OperatorModel;
  /** The operator's sandbox account, behind OPERATOR_RUN9_REF. Absent means the
   *  `node` mount resolves to no credential and its tools refuse to run, which
   *  is the right failure: a deployment without keys should not start boxes. */
  operatorRun9?: { ak: string; sk: string };
  /** The operator's Exa key, behind OPERATOR_EXA_REF. Absent means the `search`
   *  mount resolves to no credential and says it cannot search. */
  operatorExa?: string;
  /** reminder-app's origin and this deployment's client credential there, handed to the `reminder` plugin when it is
   *  built: deployment configuration, not a mount's credential. Either absent means its tools refuse and send nothing. */
  reminderApp?: { origin?: string; credential?: string };
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
  /** How long `removeMount` waits on a plugin's `unmount`; {@link UNMOUNT_TIMEOUT_MS} when unset. A test's knob. */
  unmountTimeoutMs?: number;
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
   * `sandbox.release` says it destroys the box and stops the meter, so an agent
   * tidying up calls it — rightly, in production — and the grader then scores
   * a fresh box from the base image. The runner owns that lifetime instead.
   *
   * Withheld twice: left out of the catalogue both engines are offered, and
   * refused where both engines dispatch (`#host`), because run_js passes a
   * dotted address straight through and so could still name it.
   */
  withholdTools?: readonly string[];
  /**
   * Whether this agent's task is over and owned by someone else from here on: a benchmark task the runner has
   * finished (it answered, or the budget ran out) while the agent may still be mid-turn or have background work out.
   *
   * When it answers true, every call the agent or one of its programs makes is refused at dispatch, so a
   * stalled agent's next shell command cannot provision a fresh machine after its own was handed back; and a
   * background job that ends afterwards is recorded on its row but not delivered, so it cannot wake an idle
   * agent into a turn. Both happened on a production SWE-bench run: every stalled task re-provisioned a box
   * after release, and jobs left on a released box failed about forty minutes later and woke their agents.
   * Asked on every call and every pass, because the answer changes while the agent is running.
   */
  ended?: (owner: { tenantId: string; agentId: string }) => boolean;
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
  /**
   * How long a run_js program waiting at `await pause(...)` is kept for the
   * model's `resume` (src/runtime/run-js-resume.ts). Unset: RUN_JS_RESUME_MS.
   */
  runJsResumeMs?: number;
  /**
   * Asked to wake the object by `at`, because a run_js program is suspended in
   * its memory and the object must not be evicted under it. Never later than
   * a wake already set: it only ever brings the alarm forward.
   */
  keepAlive?: (at: number) => void | Promise<void>;
}

/**
 * The mounts this agent still has, once its own answers are applied.
 *
 * A switched-off mount is still a mount: the credential reference, the
 * database and the alias all survive, and switching the plugin back on
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
  installed: ReadonlySet<string>,
  seeded: ReadonlySet<string>,
  choices: Record<string, PluginChoice>,
): T[] {
  return mounts.filter((m) =>
    !installed.has(m.plugin) || pluginEnabled(seeded.has(m.plugin), choices[m.plugin]));
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
  installed: ReadonlySet<string>,
  seeded: ReadonlySet<string>,
  choices: Record<string, PluginChoice>,
): Array<{ mount: T; reason: "switched_off" | "plugin_unavailable" }> {
  const out: Array<{ mount: T; reason: "switched_off" | "plugin_unavailable" }> = [];
  for (const m of mounts) {
    if (!installed.has(m.plugin)) out.push({ mount: m, reason: "plugin_unavailable" });
    else if (!pluginEnabled(seeded.has(m.plugin), choices[m.plugin])) out.push({ mount: m, reason: "switched_off" });
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
  mounts: Array<Pick<MountRecord, "alias" | "plugin" | "toolVersion" | "publicConfig" | "secretRef" | "policy" | "toolSnapshot">>,
  choices: Record<string, PluginChoice>,
): string {
  // The snapshot by its hash: a refresh that changed a mount's remote tool list
  // changes what the catalogue offers while the version pin stays put, so
  // without it a cached harness would go on offering the old list.
  const m = [...mounts].sort((a, b) => a.alias.localeCompare(b.alias)).map((x) =>
    [x.alias, x.plugin, x.toolVersion, x.publicConfig, !!x.secretRef, x.policy ?? null, x.toolSnapshot?.hash ?? null]);
  const c = Object.keys(choices).sort().map((k) => [k, choices[k]]);
  return JSON.stringify([m, c]);
}

/**
 * The tools a set of mounts offers the model, before qualification: each
 * mount's own list (`toolsOf`), addressed `<alias>.<tool>`. Pure, so the one
 * question "does a mount's snapshot reach the catalogue" is answerable without
 * building a harness.
 */
export function mountedToolEntries(records: MountRecord[], byId: ReadonlyMap<string, Plugin>) {
  return records.flatMap((m) => {
    const pl = byId.get(m.plugin);
    return (pl ? toolsOf(pl, m) : []).map((t) => ({
      name: t.name, description: t.summary, parameters: t.parameters,
      address: `${m.alias}.${t.name}`,
      // Carried through so replay policy and exclusivity are decided by the
      // plugin that knows, not guessed at the point of use.
      sideEffects: t.sideEffects, idempotency: t.idempotency,
      reads: t.reads,
      ...(t.replay ? { replay: t.replay } : {}),
      ...(t.modelOnly ? { modelOnly: t.modelOnly } : {}),
      exclusive: pl ? isExclusive(pl) : undefined,
    }));
  });
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

/**
 * What actually happened to a message, rather than what was asked for: a run
 * admitted carries an operation id, a queued message carries an entry id.
 *
 * And a lane can refuse — an empty prompt, a closed harness — which used to be
 * reported here as `steer, queued`, because anything without an operation id
 * read as queued. On 2026-09-22 the τ² user simulator twice answered with an
 * empty string (a reasoning model that spent its budget before the reply), the
 * runner posted it, the lane refused it as `InvalidMessage: empty`, /bench/say
 * answered 200 "queued", and the runner waited five minutes for a reply to a
 * message that had never landed — recorded as `agent_stalled`. A refusal is
 * the caller's to hear, so it is thrown, not filed under a mode it never was.
 */
/** The first words of a refusal thrown by `messageLanded`: an error crossing a Durable Object stub keeps
 *  its message and loses its class, so a route that wants to answer 409 rather than 500 matches on these. */
export const MESSAGE_REFUSED = "message refused by the lane";

/**
 * How long a turn waits for a mount's tool list to be re-taken when its snapshot's basis is not the plugin's
 * (`AgentRuntime.retakeStaleSnapshots`). Raft answers with one small `identity.whoami` GET, well under a second when
 * it is up; three seconds is room for a slow answer while keeping a down Raft from holding the turn for the 15 s its
 * calls may take (raft.ts `DEFAULT_TIMEOUT_MS`). Running out keeps the old list, which still works, minus the new tools.
 */
export const RETAKE_TIMEOUT_MS = 3_000;
/**
 * How long after a re-take that failed the same mount is not tried again for the same basis. Without it a Raft that
 * stays down would cost every turn the timeout above; with it the cost is one timeout per mount per ten minutes, and
 * a recovered Raft is asked again within ten minutes. Kept in the isolate's memory: an evicted object asks again on its
 * next wake, which is at most one more attempt, and nothing about it needs to survive a deploy (a deploy that moves
 * the basis should try at once).
 */
export const RETAKE_BACKOFF_MS = 10 * 60_000;
/**
 * How long a removal waits on the plugin's `unmount` (`Plugin.unmount`, `AgentRuntime.removeMount`). A person is
 * waiting on the console's answer, and the call is a few requests to the plugin's service to cancel what it
 * registered — a webhook delete is one. Ten seconds is room for a slow service and a couple of those, and the
 * same order as the ten seconds GitHub gives a webhook delivery, past which nobody reads a service as merely slow.
 * Running out does not block the removal; it is reported like a failure.
 */
export const UNMOUNT_TIMEOUT_MS = 10_000;
/**
 * How soon the inbound pass comes back for a queued push whose mount is being removed
 * (`AgentRuntime.deliverPendingInbound`). A removal takes up to `UNMOUNT_TIMEOUT_MS` plus a few index writes;
 * two seconds keeps the pushes behind it from waiting much past its end without spinning the alarm.
 */
export const INBOUND_REMOVING_RETRY_MS = 2_000;
/** Why a push accepted for a mount that is gone, or was replaced under its alias, is never handed to the agent. */
export const MOUNT_REMOVED_REASON = "the mount that received it was removed";

/** The refusal's text when `e` is one, or null. `e` is whatever a catch holds, so it is asked before it is
 *  read: an object with a `message` is read there, anything else is read as itself. */
export function messageRefusal(e: unknown): string | null {
  const message = typeof e === "object" && e !== null && "message" in e ? (e as { message?: unknown }).message : e;
  const text = String(message ?? e);
  return text.startsWith(MESSAGE_REFUSED) ? text : null;
}

export function messageLanded(
  res: {
    ok?: boolean;
    error?: { _tag?: string; message?: string };
    // A run admitted carries an operation id; a message queued carries an entry id.
    value?: { operationId?: unknown; entryId?: unknown };
  } | null | undefined,
  mode: "prompt" | "steer" | "followUp",
): { mode: "prompt" | "steer" | "followUp"; queued: boolean } {
  if (res && res.ok === false) {
    const why = res.error?._tag ?? "refused";
    throw new Error(`${MESSAGE_REFUSED} (${why}): ${res.error?.message ?? "no reason given"}`);
  }
  const landed = res?.value?.operationId ? "prompt" : mode === "followUp" ? "followUp" : "steer";
  return { mode: landed, queued: landed !== "prompt" };
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
  /** The last failed re-take per mount (`tenant/agent/alias`), under which basis and when; see `RETAKE_BACKOFF_MS`. */
  #retakeFailed = new Map<string, { basis: string; at: number }>();
  /** The re-take pass running for an agent (`tenant/agent`), which a second turn start joins rather than repeats. */
  #retaking = new Map<string, Promise<void>>();
  #secrets!: import("../../src/runtime/gateway.ts").SecretResolver;
  #kek: Promise<CryptoKey | null> = Promise.resolve(null);
  #unchecked = new Map<string, string>();
  // One harness per (agent, session): a conversation is a session inside the
  // agent's object, with its own transcript and the agent's shared mounts,
  // credentials and memory. Keyed so a second conversation never reads the
  // first one's transcript, and cached so a wake does not rebuild them all.
  #agents = new Map<string, { agent: AgentEngine; builtFrom: string }>();
  /** The object's one pi-durable harness, made when a `pd` agent is first opened (src/runtime/durable-agent.ts). */
  #pd: PdHost | null = null;
  #executor: DynamicWorkerExecutor;
  /** Programs suspended at a pause, for every session of this agent; memory only (run-js-resume.ts). */
  #continuations: RunJsContinuations;
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
      exaPlugin,
      // The lease reaches the plugin so its tools state the lifetime this deployment gives a box.
      sandboxPlugin(this.#artifacts as any, deps.bucketName, deps.idle ?? null),
      // The key is read when a secret tool runs, not now: `#kek` is set a few lines below.
      statePlugin(this.store, this.#artifacts as any, deps.bucketName, () => this.#kek),
      artifactsPlugin(this.#artifacts as any, deps.bucketName),
      createRaftPlugin({ artifacts: this.#artifacts }),
      mcpPlugin,
      createReminderPlugin({ serviceUrl: deps.reminderApp?.origin, clientCredential: deps.reminderApp?.credential }),
      ...(deps.extraPlugins ?? []),
      // Discovery agrees with dispatch: a withheld tool is not found by searching for it either.
      builtinToolsPlugin(this.store, () => plugins, deps.withholdTools ?? []),
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
          : ref === OPERATOR_EXA_REF
            ? (deps.operatorExa || null)
            : envSecrets.resolve(ref),
    };
    this.#kek = kekPromise;
    this.#secrets = {
      resolve: async (ref, scope, opts) => agentSecrets(this.store, await kekPromise, operator).resolve(ref, scope, opts),
    };
    // The operator's catalogue, told to the kernel rather than read by it.
    this.#gateway = new ToolGateway(this.store, plugins, SEEDED_PLUGINS, this.#secrets,
      deps.hooks ? (tenantId, agentId, alias) => this.#inboundFor(tenantId, agentId, alias) : undefined);
    this.#executor = new DynamicWorkerExecutor({
      loader: deps.loader,
      makeToolBinding: deps.makeToolBinding,
    });
    this.#continuations = new RunJsContinuations({
      ttlMs: deps.runJsResumeMs,
      onHold: (at) => { void Promise.resolve(deps.keepAlive?.(at)).catch(() => {}); },
    });
  }

  /** The run_js programs suspended in this object's memory: what keeps it awake (step). */
  get runJsContinuations(): RunJsContinuations { return this.#continuations; }

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
        // Asked again here, right before the row that makes the URL live: a call that began before its mount's
        // removal was decided passed every earlier check, and the removal's revoke pass may already be behind it.
        // A row written after this check is the removal's second pass to find (`#removeDecided`).
        if (this.#gateway.isRemoving(tenantId, agentId, alias)) {
          await this.dropHookSecret(tenantId, agentId, hookId);
          throw new Error(`${alias} is being removed; no hook was made`);
        }
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
   * One pushed event. Answered as soon as it is verified, deduplicated,
   * rate-checked and queued (`inbound_pending`): the message is posted by the
   * next alarm pass (`deliverPendingInbound`), because opening the harness and
   * posting cost the waiting service most of a second, and the service wants
   * its answer promptly (GitHub: 10 s). Every event leaves a row, delivered or
   * not, so an operator can see what arrived and why it went nowhere.
   *
   * `routed: "cache"` says the worker found this hook in its route cache rather
   * than the index. A hook with no secret is then answered `unrouted`, with
   * nothing recorded, so the worker asks the index before answering: a revoked
   * hook (whose secret revoke drops) still reads as unknown, as it did before
   * the cache, and a live one with no secret is delivered again and recorded.
   */
  async receiveHook(tenantId: string, agentId: string, alias: string, hookId: string,
    event: Omit<InboundEvent, "hookId"> | null, routed: "cache" | "index" = "index"): Promise<{ outcome: InboundOutcome; unrouted?: true; retryAfterS?: number }> {
    await this.ready();
    const sql = this.#deps.ctx.storage.sql;
    ensureInboundTable(sql);
    const now = Date.now();
    const done = (outcome: InboundOutcome, reason?: string | null, dedupeKey?: string | null) => {
      recordInbound(sql, { tenantId, agentId, hookId, alias, outcome, reason, dedupeKey, now });
      return { outcome };
    };
    const secret = await this.#secrets.resolve(agentRef(hookSecretName(hookId)), { tenantId, agentId });
    // Before the size: a cache-routed push to a hook revoked since must read as unknown (404) whatever its
    // body, as it did when every push asked the index first.
    if (!secret && routed === "cache") return { outcome: "failed", unrouted: true };
    if (!event) return done("too_large", `the body passed ${INBOUND_MAX_BYTES} bytes`);
    if (!secret) return done("failed", "this hook has no secret in the agent's store");
    // The installation the push is for, read before the plugin is asked: if the mount is removed, or removed and
    // added again, while `receive` runs, the push is not this alias's any more (checked again below).
    const receiving = (await this.store.getMountByAlias(tenantId, agentId, alias))?.installationId ?? null;
    let answer;
    try {
      // The hook travels with the event: verified against this hook's secret, the delivery is the
      // plugin's evidence about which hook the service still points at.
      answer = await this.#gateway.receive(tenantId, agentId, alias, { ...event, hookId }, secret);
    } catch (e: any) {
      // The plugin's own words stay in the record; the service only hears 503.
      return done("failed", String(e?.message ?? e));
    }
    // Switched off, gone, or pinned elsewhere: the request was fine and the
    // mount is not taking events, which the service should not report as broken.
    if ("skipped" in answer) return done("ignored", answer.skipped);
    const result = answer.result;
    if (!result.deliver) return done(result.rejected ? "rejected" : result.malformed ? "malformed" : "ignored", result.reason);
    // Which installation accepted it, read before the synchronous run below (which must not await): the pass
    // that posts it gives it up if the alias names another by then (`#deliverInbound`). A mount gone, or replaced,
    // since `receive` began is refused here rather than stamped, so every row this writes carries an installation
    // and a null in `inbound_pending` can only be a row queued before the column existed.
    const accepting = await this.store.getMountByAlias(tenantId, agentId, alias);
    // A mount that only appeared while `receive` ran (none before) is not the one the push was checked for either.
    if (!accepting || accepting.installationId !== receiving) {
      return done("ignored", MOUNT_REMOVED_REASON);
    }
    const installationId = accepting.installationId;
    const key = result.dedupeKey ?? null;
    if (key && seenBefore(sql, hookId, key, now)) return done("duplicate", null, key);
    // Each 429 says when to come back (`Retry-After`): the rate's from the rows it counts, the queue's from its
    // head's next try, so a sender that honours it is not refused, and recorded, every few seconds meanwhile.
    if (!underRate(sql, hookId, now)) {
      const retryAfterS = rateRetryAfterS(sql, hookId, now) ?? INBOUND_QUEUE_RETRY_AFTER_S;
      return { ...done("rate_limited", `more than ${INBOUND_PER_MINUTE} a minute`, key), retryAfterS };
    }
    if (queueFull(sql, hookId)) {
      const retryAfterS = queueRetryAfterS(nextPendingInbound(sql), now, this.#inboundPass !== null);
      return { ...done("rate_limited", `${INBOUND_QUEUE_MAX} pushes from this hook are already waiting to be posted`, key), retryAfterS };
    }
    // The claim on the key: in the same synchronous run as the two checks above, with no await between,
    // so a second push with this key that is already past its own await finds this row (`acceptInbound`).
    acceptInbound(sql, { hookId, alias, dedupeKey: key, message: inboundMessage(alias, String(result.text)), now, installationId });
    // The answer the service has always had for a push the agent will be given.
    return { outcome: "delivered" };
  }

  #inboundPass: Promise<InboundPass> | null = null;

  /**
   * Hand queued pushes to the agent, oldest first, each as `postMessage(..., "prompt")`, which joins a running
   * turn as a steer and starts one otherwise. One pass at a time: a second caller joins the running one, so
   * two passes never post the same row.
   *
   * Never twice. A row is marked `posting` synchronously before the engine's write, with the harness already
   * open, and settled as `delivered` once the post returns. A pass that dies before the mark leaves the row
   * queued, claimed, and it is tried again after its wait; one that dies after it cannot tell whether the
   * message landed, so the row is settled as `failed`, saying so, rather than posted a second time. A post
   * that throws wrote nothing and is retried on its own row (`INBOUND_RETRY_MS`); its last failure settles it
   * as `failed` with the reason. A row waiting for its retry holds back the rows behind it, keeping the order,
   * and the pass says when to come back. A row queued longer than `INBOUND_MAX_AGE_MS` is given up wherever it
   * stands. `beforeFirstPost` runs once, and only in a pass that is about to post a row.
   */
  deliverPendingInbound(tenantId: string, agentId: string, opts: { beforeFirstPost?: () => Promise<void> } = {}): Promise<InboundPass> {
    if (this.#inboundPass) return this.#inboundPass;
    const pass = this.#deliverInbound(tenantId, agentId, opts).finally(() => { this.#inboundPass = null; });
    this.#inboundPass = pass;
    return pass;
  }

  async #deliverInbound(tenantId: string, agentId: string, opts: { beforeFirstPost?: () => Promise<void> }): Promise<InboundPass> {
    await this.ready();
    const sql = this.#deps.ctx.storage.sql;
    ensureInboundTable(sql);
    const storage = this.#deps.ctx.storage;
    const transact = <T>(fn: () => T): T => storage.transactionSync ? storage.transactionSync(fn) : fn();
    const settle = (row: PendingInbound, outcome: "delivered" | "failed" | "ignored", reason?: string) =>
      settleInbound(sql, transact, { ...row, tenantId, agentId, outcome, reason });
    const out: InboundPass = { posted: 0, failed: 0, ignored: 0, left: 0, retryInMs: null, waitedMs: null, error: null };
    // Too old to be worth reading, wherever they stand: a long outage must not end in notices hours late.
    for (const seq of expiredPendingInbound(sql, Date.now())) {
      const row = pendingInboundRow(sql, seq);
      if (!row) continue;
      settle(row, "failed", `queued for more than ${INBOUND_MAX_AGE_MS / 60_000} minutes without being posted` +
        (row.lastError ? `: ${row.lastError}` : ""));
      out.failed++;
    }
    let prepared = false;
    for (;;) {
      const head = nextPendingInbound(sql);
      if (!head) break;
      if (head.state === "posting") {
        settle(head, "failed", "the pass handing it to the agent ended mid-way, so it may or may not have arrived; not posted again, so it cannot arrive twice");
        out.failed++;
        continue;
      }
      const now = Date.now();
      // Its mount is being removed right now: neither posted nor settled yet. Once the removal is done the check
      // below gives it up; if the removal is called off, it is posted as usual. Order is strict, so the rows
      // behind it wait too, for the few seconds a removal takes (`UNMOUNT_TIMEOUT_MS` bounds the longest part),
      // and `retryInMs` brings the pass back, so the row is never left without an alarm.
      if (this.#gateway.isRemoving(tenantId, agentId, head.alias)) {
        out.retryInMs = INBOUND_REMOVING_RETRY_MS;
        break;
      }
      // Accepted by a mount that is gone — removed, or removed and added again under the alias — since the
      // service was answered: not the agent's to read, and never worth a retry. Null can only be a row queued
      // before the column existed: `acceptInbound` is the one INSERT, and `receiveHook` checks the mount is still
      // there (and still the one `receive` ran for) before it, so it always stamps it. A null is never read as
      // "mount removed": it is posted as it would have been, and pushes accepted across the deploy are not dropped.
      if (head.installationId !== null) {
        const mount = await this.store.getMountByAlias(tenantId, agentId, head.alias);
        if (!mount || mount.installationId !== head.installationId) {
          settle(head, "ignored", MOUNT_REMOVED_REASON);
          out.ignored++;
          continue;
        }
      }
      // The head is the oldest row, so its expiry is the queue's first.
      if (head.nextAt > now) { out.retryInMs = Math.min(head.nextAt, head.receivedAt + INBOUND_MAX_AGE_MS) - now; break; }
      // Only a pass that is about to post prepares for it (the caller's provisioning), and only once.
      if (!prepared) {
        prepared = true;
        await opts.beforeFirstPost?.();
      }
      const row = claimPendingInbound(sql, head, Date.now());
      try {
        await this.postMessage(tenantId, agentId, row.message, "prompt", MAIN_SESSION,
          { retake: "background", beforeSay: () => markPostingInbound(sql, row.seq) });
      } catch (e: any) {
        const error = String(e?.message ?? e).slice(0, 300);
        out.error = error;
        if (row.attempts >= INBOUND_POST_ATTEMPTS) {
          settle(row, "failed", `accepted, then not posted after ${row.attempts} attempts: ${error}`);
          out.failed++;
          continue;
        }
        requeueInbound(sql, row.seq, error);
        out.retryInMs = Math.max(0, row.nextAt - Date.now());
        break;
      }
      settle(row, "delivered");
      out.posted++;
      out.waitedMs = Math.max(out.waitedMs ?? 0, Date.now() - row.receivedAt);
    }
    out.left = pendingInboundCount(sql);
    return out;
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
    // A reference this agent did not attach is not this agent's to overwrite —
    // unless it can be given back. The failure branch below already keeps a
    // non-agent `previous`; this is the same judgement on the success branch,
    // made before anything is written, and by the same test — not "is it the
    // operator's" but "is it not ours" — so a kind of reference that does not
    // exist on a mount today is covered the day one does. The rule used to
    // live only in the page that hid the control (#531).
    //
    // The exception is the catalogue's, never the kind's: what lets an
    // overwrite through is that `removeCredential` can put this exact
    // reference back, and the catalogue is what knows. Reading the kind would
    // be asking the name again, which is what the seeded/`operator:` spelling
    // was moved away from.
    //
    // Equality, not presence: the catalogue must name the reference that is on
    // the mount right now. A mount carrying some other non-agent reference is
    // still refused, because "revert" would then hand back an account that was
    // never there — a different far end, silently.
    if (mount.secretRef && !isAgentRef(mount.secretRef)
        && mount.secretRef !== AgentRuntime.seededSecretRef(mount)) {
      return {
        ok: false,
        error: `the ${alias} mount uses an account this agent did not attach (${secretRefKind(mount.secretRef)}), ` +
          `which cannot be given back once replaced; a key of your own goes on a mount of your own`,
      };
    }
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
    // A refused key above changed nothing the tool list was taken under; a kept one did.
    await this.#toolsAfterCredentialChange(tenantId, agentId, alias);
    return { ok: true, verified: !!check?.ok, account: check?.ok ? (check.account ?? null) : null, error: unreachable };
  }

  /**
   * A mount's credential was attached, replaced or removed, so a tool list that depends on it may no longer hold:
   * raft lists only the operations its credential's capabilities allow (`Plugin.snapshotTools`). The list is asked
   * for again now, for a plugin that both lists its tools and takes a credential, and replaced when the answer
   * moved, so a credential that lost a scope stops offering what the scope allowed. When the listing fails, the
   * stored list is left as it was if a credential was behind it; one taken with no credential is cleared, and a
   * mount with no list is offered every tool for raft, as at deploy — and Raft refuses what the credential may not
   * do; why it failed is on the mount's page
   * (`snapshotError`), and an operator's refresh asks again.
   */
  async #toolsAfterCredentialChange(tenantId: string, agentId: string, alias: string) {
    const mount = await this.store.getMountByAlias(tenantId, agentId, alias);
    const plugin = mount ? this.#plugins.find((p) => p.id === mount.plugin) : undefined;
    if (!plugin?.snapshotTools || !plugin.credential) return null;
    const r = await this.#snapshot(tenantId, agentId, alias);
    // A list taken while the mount had no credential is not a previous list: it says what no credential may do.
    // Failing to list for the credential that just arrived leaves the mount as one with no list, which is offered
    // everything, as at deploy — the provisioning order (mount added, then its account attached) meets exactly this.
    if (!r.ok && !("stale" in r) && mount!.toolSnapshot?.withoutCredential) {
      try { await this.store.updateMountToolSnapshot(tenantId, agentId, alias, null); }
      catch (e) { console.error(`could not clear ${alias}'s credential-less tool list:`, e); }
    }
    return r;
  }

  /**
   * A connection waiting for its initiator to be confirmed (provision/connect.ts): the token from a
   * finished OAuth flow, sealed in this agent's own secret table under `pending:<plugin>:<exp>:<id>`,
   * with the Raft user who started the flow kept beside it. It becomes the mount's credential only in
   * `confirmConnection`, after Raft has checked that the person who finished the flow is the one who
   * started it — so a link sent to someone else cannot put their account on this agent. Expired rows
   * are cleared each time a new one is held. On these rows the `account` column holds the Raft user
   * the flow was started for, not an account the credential grants: they are never a mount's credential.
   */
  async holdConnection(tenantId: string, agentId: string, plugin: string, token: string, id: string, exp: number, raftUserId: string):
    Promise<{ ok: true } | { ok: false; error: string }> {
    await this.ready();
    const kek = await this.#kek;
    if (!kek) return { ok: false, error: "this deployment has no SECRET_KEK, so it cannot keep a credential" };
    const now = Date.now();
    for (const r of await this.store.listSecretNames(tenantId, agentId, "pending:")) {
      if (Number(r.name.split(":")[2]) <= now) await this.store.removeSecret(tenantId, agentId, r.name);
    }
    const sealed = await seal(kek, token);
    await this.store.putSecret(tenantId, agentId, `pending:${plugin}:${exp}:${id}`, { ciphertext: sealed.ciphertext, iv: sealed.iv, account: raftUserId });
    return { ok: true };
  }

  /**
   * Make a held connection the credential of this agent's mount of that plugin: once, before it expires,
   * and only for the Raft user it was held for. The held row goes whatever the outcome.
   */
  async confirmConnection(tenantId: string, agentId: string, plugin: string, id: string, raftUserId: string):
    Promise<{ ok: true; account: string | null; sealed: Sealed } | { ok: false; error: string; missing?: true }> {
    await this.ready();
    const kek = await this.#kek;
    if (!kek) return { ok: false, error: "this deployment has no SECRET_KEK, so it cannot keep a credential" };
    const row = (await this.store.listSecretNames(tenantId, agentId, `pending:${plugin}:`)).find((r) => r.name.endsWith(`:${id}`));
    if (!row) return { ok: false, error: "no such pending connection", missing: true };
    const meta = await this.store.secretMeta(tenantId, agentId, row.name);
    const sealed = await this.store.getSecret(tenantId, agentId, row.name);
    await this.store.removeSecret(tenantId, agentId, row.name);
    if (!meta || !sealed || Number(row.name.split(":")[2]) <= Date.now() || meta.account !== raftUserId) {
      return { ok: false, error: "no such pending connection", missing: true };
    }
    // Handed back sealed: the connection it becomes is the tenant's (cf/migrations/0012_connectors.sql).
    const r = await this.attachSealedConnection(tenantId, agentId, plugin, sealed);
    return r.ok ? { ...r, sealed: { ciphertext: sealed.ciphertext, iv: sealed.iv } } : r;
  }

  /** A connection's credential, sealed under this deployment's key, onto this agent's one mount of that plugin. */
  async attachSealedConnection(tenantId: string, agentId: string, plugin: string, sealed: Sealed):
    Promise<{ ok: true; account: string | null } | { ok: false; error: string }> {
    await this.ready();
    const kek = await this.#kek;
    if (!kek) return { ok: false, error: "this deployment has no SECRET_KEK, so it cannot keep a credential" };
    const mounts = await this.store.findMountsByPlugin(tenantId, agentId, plugin);
    if (mounts.length === 0) return { ok: false, error: `this agent has no ${plugin} mount to connect` };
    // More than one and the choice would be arbitrary; say so rather than attach to one of them.
    if (mounts.length > 1) return { ok: false, error: `this agent has ${mounts.length} ${plugin} mounts (${mounts.map((m) => m.alias).join(", ")}); connect one in the console` };
    const mount = mounts[0]!;
    const r = await this.attachCredential(tenantId, agentId, mount.alias, { token: await open(kek, sealed) });
    return r.ok ? { ok: true, account: r.account } : { ok: false, error: r.error };
  }

  /** Remove the credential from this agent's mount of that plugin; false when there was none. */
  async detachConnection(tenantId: string, agentId: string, plugin: string): Promise<boolean> {
    await this.ready();
    const mount = (await this.store.findMountsByPlugin(tenantId, agentId, plugin))[0];
    return mount ? this.removeCredential(tenantId, agentId, mount.alias) : false;
  }

  /**
   * Remove the credential only while it is still the connector's (`sealed`): a key put on the mount
   * since, in the console, is not the connector's to take when the connector goes. Compared by value,
   * because each attach seals afresh and the ciphertexts never match.
   */
  async detachConnectionIfFrom(tenantId: string, agentId: string, plugin: string, sealed: Sealed): Promise<boolean> {
    await this.ready();
    const kek = await this.#kek;
    const mount = (await this.store.findMountsByPlugin(tenantId, agentId, plugin))[0];
    if (!kek || !mount || !isAgentRef(mount.secretRef)) return false;
    const held = await this.store.getSecret(tenantId, agentId, mount.secretRef!.slice(agentRef("").length));
    if (!held || await open(kek, held) !== await open(kek, sealed)) return false;
    return this.removeCredential(tenantId, agentId, mount.alias);
  }

  /**
   * Take back the key this agent attached, and give the mount whatever the
   * catalogue says it had — the shared account for a seeded mount, nothing for
   * one that was never seeded with a reference.
   *
   * Only an agent's own reference is removable, so this cannot be a way to
   * clear the shared account: on a mount already using it, there is nothing of
   * this agent's to take back and the answer is `false`.
   */
  async removeCredential(tenantId: string, agentId: string, alias: string): Promise<boolean> {
    await this.ready();
    const mount = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!mount || !isAgentRef(mount.secretRef)) return false;
    await this.store.removeSecret(tenantId, agentId, alias);
    await this.store.setMountSecretRef(tenantId, agentId, alias, AgentRuntime.seededSecretRef(mount));
    await this.#toolsAfterCredentialChange(tenantId, agentId, alias);
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

    // Read before the release, because after it there is nothing to ask: the id
    // is what the warning row is keyed by. Through `activity` rather than the
    // stored state, which is the plugin's own and named `boxId` in exactly
    // one plugin.
    // Every thing the mount holds: this release has no id, so it lets go of all of them.
    const live = (await this.#gateway.mountActivities({ tenantId, agentId, taskId: LEGACY_TASK }, alias))
      .flatMap((a) => a.live ? [a.live] : []);
    const r = await this.#gateway.releaseTask({ tenantId, agentId, taskId: LEGACY_TASK }, { alias });
    const failed = r.failed.find((f) => f.alias === alias);
    if (failed) return { ok: false, error: `${alias} was not released: ${failed.error}` };

    // The warning row is keyed by the thing that is now gone. Left behind, the
    // next one under this alias inherits a release time it was never told.
    for (const l of live) sql.exec("DELETE FROM held_warnings WHERE alias = ? AND live_id = ?", alias, l.id);
    return { ok: true, released: r.released.includes(alias) };
  }

  /**
   * Rename a mount, with the one thing a rename must not do to a container.
   *
   * The alias is the operator's word for a mount, and until now it was the one
   * thing about a mount that could not be changed — not by design, but because
   * nothing implemented it. What made it look dangerous is that the alias keys
   * two live things: the mount row and the database, and the second is
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
    // Not while the mount is being removed (`removeMount`). A removal keys its mark and its hook revokes by
    // alias, and renaming frees the alias: the one way those alias-keyed parts could meet a different mount.
    // The old mount would also live on under the new name with its cleanup already done, while its hooks,
    // still filed under the old alias, would point at whatever mount takes that alias next. Asked here and
    // again right before the store's rename, since the activity read between them awaits.
    const removing = `${from} is being removed; it cannot be renamed`;
    if (this.#gateway.isRemoving(tenantId, agentId, from)) return { ok: false, error: removing };
    // Not the mount Raft provisioned: its alias is the address Raft uses to attach and remove credentials, build tool
    // addresses and keep push state (cf/src/provision/steps.ts; uiAttachCredential and uiRemoveCredential in
    // cf/src/index.ts), and the reminder plugin reads it to tell an agent on Raft (src/plugins/reminder.ts). Alias AND
    // plugin, since the alias alone may name anything an operator put there. Identity by installationId, so a rename
    // would not matter, is #756.
    if (from === PROVISION_MOUNT_ALIAS && mount.plugin === "raft") {
      return { ok: false, error: `${from} is the mount Raft provisioned; it cannot be renamed` };
    }
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
    if (this.#gateway.isRemoving(tenantId, agentId, from)) return { ok: false, error: removing };
    const r = await this.store.renameMount(tenantId, agentId, from, to, own ? { newRef: agentRef(to) } : null);
    // The last snapshot error is keyed by the alias too, and is about the same mount under its new name.
    if (r.ok) this.#snapshotErrors()?.exec("UPDATE mount_snapshot_errors SET alias = ? WHERE alias = ?", to, from);
    return r;
  }

  /**
   * What a page may show for a mount's credential. Never the value, and
   * nothing derived from it: an account name is the far end's label.
   *
   * Two of these answer different kinds of question, and a page reading one
   * for the other would offer "use your own key" and "go back to the shared
   * one" at the same time. `attached`, `operator`, `verified`, `account` and
   * the dates are **state**: what is on this mount now, and each changes when
   * a key is attached or taken back. `revertsTo` is a **property**: what this
   * mount would fall back to, which is the same answer before and after an
   * attach because it is the catalogue's and not the mount's.
   */
  async credentialMeta(
    tenantId: string, agentId: string, mount: { alias: string; plugin: string; secretRef: string | null },
  ) {
    const attached = !!mount.secretRef;
    const meta = isAgentRef(mount.secretRef) ? await this.store.secretMeta(tenantId, agentId, mount.alias) : null;
    return {
      attached,
      // A reference the operator configured at deploy time, not one entered
      // on the page. State: true only while the shared account is the one in use.
      operator: attached && !isAgentRef(mount.secretRef),
      // What taking the agent's own key back would leave the mount using: the
      // shared account, or nothing. A property of the mount rather than of its
      // current state, so it is the same answer before and after an attach —
      // which is what lets a page offer "use your own key" and "go back to the
      // shared one" as two views of one fact. Derived from the catalogue at
      // read time and not stored, for the reason `seededSecretRef` gives.
      revertsTo: AgentRuntime.seededSecretRef(mount) ? "operator" as const : "none" as const,
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
    /**
     * The "you are still holding this" line for a mount, or null when it is
     * holding nothing (held.ts). A ready-made line rather than the plugins and
     * the mount rows, so this stays the place that dispatches a call and not a
     * second place that knows what holding means.
     */
    heldOn: (alias: string) => Promise<string | null> = async () => null,
    /**
     * The session's context id now (`contextIdOf`, src/runtime/context-id.ts), asked on each call rather than once:
     * a compaction in the middle of a run moves it, and a call after one belongs to the new context.
     */
    contextId: () => string | undefined = () => undefined,
  ) {
    const readBack = reader?.name ?? null;
    const withheld = new Set(this.#deps.withholdTools ?? []);
    const ended = this.#deps.ended;
    const gw = this.#gateway;
    const store = this.store;
    const artifacts = this.#artifacts;
    const sql = this.#deps.ctx.storage.sql;
    // Every call through this host is made in the session's turn: the model's own, a program's inside one, the
    // model's answer to a tool's question. So each carries the context id; nothing a call carries can set it.
    const inTurn = (): typeof ctx & { contextId?: string } => {
      const id = contextId();
      return id === undefined ? ctx : { ...ctx, contextId: id };
    };
    // `send` is the gateway step behind this result: a call by default, or the
    // answer to a question a tool asked, whose result is the tool's own and is
    // finished exactly as a call's is (a job, a parked result, the held line).
    const dispatch = async (
      call: { tool: string; args: any; opts?: any; callId?: string },
      send: () => Promise<ToolResult> = () => gw.invoke(inTurn(), call.tool, call.args, hostCallOpts(call)),
    ): Promise<ToolResult> => {
        const res = await send();
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
              cancel: () => gw.cancelBackground(ctx, bg.alias, bg.handle, res.operationId),
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
    };
    const held = async (address: string, out: ToolResult): Promise<ToolResult> => {
      if (out.status !== "succeeded") return out;
      const line = await heldOn(address.split(".")[0] ?? "");
      if (!line) return out;
      return { ...out, result: withHeldNote(out.result, line) as Json };
    };
    return {
      /**
       * A mounted call, plus the one sentence a call on a holding mount has to
       * carry: that the thing is still held, and what lets it go.
       *
       * Appended here, after the size decision, and not by the plugin. The
       * sandbox used to write it into its own results (`reminder`), which made
       * one plugin the author of a sentence that is true of anything holding a
       * metered resource — and meant a second such plugin said nothing. What is
       * genuinely the plugin's (what survives a release, what /tmp does, the
       * lease's terms) stays in its tool descriptions, where the model is told
       * every turn rather than once.
       *
       * After the size decision because both large-result paths replace the
       * result with a wrapper of their own: attached before, the line would be
       * parked into storage along with the body the model cannot see.
       */
      async invoke(call: { tool: string; args: any; opts?: any; callId?: string }): Promise<ToolResult> {
        const refused = refuseWithheld(call.tool, withheld);
        if (refused) return refused;
        if (ended?.({ tenantId: ctx.tenantId, agentId: ctx.agentId })) return taskEndedRefusal(call.tool);
        return held(call.tool, await dispatch(call));
      },
      /** The model's answer to a tool's question (pi-tools.ts `resume`), finished as a call's result is. */
      async resumeInterrupt(i: ToolInterrupt, answer: Json, callId: string): Promise<ToolResult> {
        const call = { tool: `${i.alias}.${i.tool}`, args: null, callId };
        if (ended?.({ tenantId: ctx.tenantId, agentId: ctx.agentId })) return taskEndedRefusal(call.tool);
        return held(call.tool, await dispatch(call, () => gw.resumeInterrupt(inTurn(), i, answer, { callId })));
      },
      async cancelInterrupt(i: ToolInterrupt): Promise<string | null> {
        return gw.cancelInterrupt(inTurn(), i);
      },
    };
  }

  /**
   * What every agent is mounted with, whichever path makes it first: the
   * console on first open, or the API on first run. There was a shorter list
   * for the API path once, and an agent run before it was opened had no
   * memory; one list, read by both, is the only way that stays fixed.
   */
  static readonly DEFAULT_MOUNTS: CatalogueMount[] = [
    { alias: "tools", plugin: "tools", config: { account: "builtin" },
      secretRef: null, policy: null, for: ["console", "raft"], since: 1 },
    // Without this a parked result is a reference the agent cannot open.
    { alias: "artifacts", plugin: "artifacts", config: { account: "builtin" },
      secretRef: null, policy: null, for: ["console", "raft"], since: 1 },
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
      secretRef: null, policy: null, for: ["console", "raft"], since: 1 },
    // Search with the operator's Exa key. Its host is fixed by the plugin, so the key can only ever
    // reach Exa.
    { alias: "search", plugin: "exa", config: { account: "Exa" },
      secretRef: OPERATOR_EXA_REF, policy: null, for: ["console", "raft"], since: 1 },
    // GitHub, the first real user of the credential page. Seeded with no
    // token, so it reads public repositories; the person attaches their
    // own token there and the mount acts as that account. Writes are open:
    // the person's decision (task #10) is that the default allows every
    // operation a tool offers, and the agent decides which of its own calls
    // to hold for a person, by sending `confirm: true` with the call.
    { alias: "gh", plugin: "github", config: { account: "GitHub" },
      secretRef: null, policy: null, for: ["console", "raft"], since: 1 },
    // A real container, for tasks that need one. Its tools describe
    // themselves as a last resort so the agent reaches for free in-process
    // JS first, and the framework releases the box once the agent has no
    // conversation with work open (the scope is the agent, not a task).
    { alias: SANDBOX_ALIAS, plugin: "sandbox", config: { account: "container" },
      secretRef: OPERATOR_RUN9_REF, policy: null, for: ["console", "raft"], since: 1 },
    // The agent's own store. Deliberately not behind approval: an agent
    // that must ask a person before writing a note will not keep notes, and
    // the blast radius is its own memory, scoped to this (tenant, agent).
    { alias: "state", plugin: "state", config: { account: "agent memory" },
      secretRef: null, policy: null, for: ["console", "raft"], since: 1 },
    // Reminders that wake the agent later, through reminder-app. Not for an agent Raft hosts: Raft wakes it
    // through its own channel, and the plugin's `create` refuses there (`onRaft` in src/plugins/reminder.ts).
    // Nor seeded on a deployment without REMINDER_APP_ORIGIN and REMINDER_APP_CREDENTIAL: the plugin reports
    // itself `unavailable` there, since every call would refuse.
    { alias: "reminder", plugin: "reminder", config: { account: "reminder-app" },
      secretRef: null, policy: null, for: ["console"], since: 2 },

  ];

  /**
   * The reference the catalogue seeds this mount with, or null when it seeds
   * none — which is also the answer to "what would this mount go back to".
   *
   * Derived rather than stored. The catalogue is already the one place that
   * says which mounts an agent gets and what each is seeded with, and a copy
   * kept beside the mount would be a second answer that can disagree with it
   * (#531). An entry reaches an agent once (`reconcileSeeds`) and its settings
   * are not re-applied by that, so this says what the deployed catalogue holds
   * now, not what this agent was seeded from; where
   * those differ, the revert points at today's answer, which is the same rule
   * a new agent gets.
   *
   * Matched on alias AND plugin. `addMount` already refuses to put a different
   * plugin on a seeded alias, so the two agree wherever a mount was made
   * through the runtime; asking for both means this does not depend on that
   * being true somewhere else.
   */
  static seededSecretRef(mount: { alias: string; plugin: string }): string | null {
    return AgentRuntime.DEFAULT_MOUNTS
      .find((d) => d.alias === mount.alias && d.plugin === mount.plugin)?.secretRef ?? null;
  }

  /** What is installed, for a console that wants to show settings rather than
   *  guess them from whichever mounts happen to exist. */
  plugins(): Plugin[] {
    return this.#plugins;
  }

  /** The gateway, so an approval decided outside a task can act on it. */
  gateway() {
    return this.#gateway;
  }

  /**
   * The agent's record, then its mounts. With the catalogue (no `chosen`), the mounts are the turn-start reconcile's
   * (`reconcileSeeds`), so a new agent and an existing one are seeded by the same pass and the same record. With
   * `chosen`, the list is the caller's own and is added as given, and the agent is marked so that no reconcile ever
   * touches it: a bench arm measures exactly the tools it mounted, and an Agents API agent has what its caller
   * declared.
   */
  async provision(
    tenantId: string,
    agentId: string,
    mounts: SeedMount[] = AgentRuntime.DEFAULT_MOUNTS,
    opts: { chosen?: boolean } = {},
  ) {
    await this.ready();
    // The record and the mounts are separate questions. An agent the console
    // created has a record (name, description) and no mounts yet; the old
    // guard read "record exists" as "already provisioned" and gave such an
    // agent its first run with no tools and no memory.
    let created = false;
    const record = await this.store.loadAgent(tenantId, agentId);
    if (!record) {
      await this.store.createAgent(tenantId, agentId, {});
      created = true;
    }
    // A caller's own list is its choice of mounts for this agent (a bench arm, the Agents API's container), so
    // a row's `for` is not asked of it; whether the deployment can run the plugin still is.
    // Said, not inferred: array identity told a fresh copy of the defaults apart from the defaults, which is not the question.
    const explicit = opts.chosen === true;
    const kind = explicit ? null : agentKind(record?.config);
    const applies = mounts.filter((m) => seedApplies(m, kind, this.#plugins.find((p) => p.id === m.plugin)));
    if (!explicit) {
      await this.reconcileSeeds(tenantId, agentId, mounts);
      // The seeds that apply to this agent, so a caller that reconciles their settings (`uiEnsure`) judges the same set.
      return { agentId, created, seeds: applies };
    }
    // Before anything is added: a pass between the adds and the mark would read this agent as the catalogue's.
    await this.store.markSeedsChosen(tenantId, agentId);
    const choices = await this.store.pluginChoices(tenantId, agentId);
    for (const m of mounts) {
      // The skip comes first on purpose: the assert below runs only for a
      // mount being added, so a repeat costs one read per seed, and no validation.
      if (await this.store.getMountByAlias(tenantId, agentId, m.alias)) continue;
      // Before the choice below is recorded: a seed the deployment cannot run is not one the agent has chosen either.
      // No rule against a plugin already held under another alias: the list may name one plugin twice on purpose
      // (two accounts).
      if (!applies.includes(m)) continue;
      // A caller that hands over its own seed list has chosen those plugins: a
      // benchmark arm seeding `retail`, a demo seeding `ops`. #491 made the
      // catalogue the only source of "on by default", and this path was never
      // told — so a non-default plugin in an explicit list was skipped below
      // without a word, and the retail tools vanished from every bench agent the
      // first time #491 reached production: the 2026-09-28 12:53Z τ² round (build c26ebd4) went
      // 0/24 with no retail tool in the histogram.
      // The choice is recorded, not bypassed, so the catalogue and the gateway
      // agree with what was mounted; an explicit "disable" still wins.
      const declared = this.#plugins.find((p) => p.id === m.plugin);
      if (declared && !SEEDED_PLUGINS.has(m.plugin) && choices[m.plugin] !== "disable" && choices[m.plugin] !== "enable") {
        await this.store.setPluginChoice(tenantId, agentId, m.plugin, "enable");
        choices[m.plugin] = "enable";
      }
      // Only the adding is governed here: a mount that already exists is left
      // alone, because switching a plugin off must not destroy the credential and
      // the database behind it.
      if (declared && !pluginEnabled(SEEDED_PLUGINS.has(m.plugin), choices[m.plugin])) continue;
      // A misspelt setting is refused here, at the first agent it would have
      // reached, rather than becoming the plugin's silent default everywhere.
      if (declared) assertMountConfig(declared, (m.config ?? { account: m.account }) as Record<string, Json>, m.secretRef ?? null);
      await this.store.addMount({
        tenantId, agentId, alias: m.alias, plugin: m.plugin,
        installationId: seedInstallation(m.alias), connectionId: null,
        toolVersion: this.pluginVersion(m.plugin) ?? "1.0.0",
        publicConfig: m.config ?? { account: m.account }, secretRef: m.secretRef ?? null, policy: m.policy ?? null,
      });
    }
    return { agentId, created, seeds: applies };
  }

  /**
   * Bring an agent up to the deployment catalogue: add the entries it is missing, and record what became of each
   * (src/store/seed-record.ts). Called where a turn starts — `postMessage`, which every prompt, steer, follow-up,
   * hook or Raft push, background completion and lease warning goes through — and where an agent is made or its
   * console page opened (`provision`). Never from `agent()`, which status, transcript and queue reads also open,
   * nor from any read path: reading an agent must not change it.
   *
   * Before the turn reads its tools: `postMessage` opens the harness after this, and a harness whose catalogue key
   * (`catalogueKey`) moved is rebuilt unless a turn is running, so what is added here is offered in this same turn.
   *
   * Never an Agents API agent (its kind), nor one whose mounts a caller chose (a bench arm; `provision` with
   * `chosen` marks it). An agent with no record is not made here; `provision` makes agents.
   *
   * An unchanged key is three reads (the record, the plugin choices, the agent's catalogue row) and no write. A
   * changed one is a single store transaction, so two turn starts racing add each mount once.
   *
   * `added` is what this pass mounted: what the agent should be told it now has.
   */
  async reconcileSeeds(
    tenantId: string, agentId: string, catalogue: readonly SeedMount[] = AgentRuntime.DEFAULT_MOUNTS,
  ): Promise<SeedPassResult | { ran: false; why: "no agent" | "api" }> {
    await this.ready();
    const record = await this.store.loadAgent(tenantId, agentId);
    if (!record) return { ran: false, why: "no agent" };
    const kind = agentKind(record.config);
    if (kind === "api") return { ran: false, why: "api" };
    const choices = await this.store.pluginChoices(tenantId, agentId);
    const byId = new Map(this.#plugins.map((p) => [p.id, p]));
    const unavailable = new Map<string, string>();
    for (const m of catalogue) {
      const why = byId.get(m.plugin)?.unavailable?.();
      if (why) unavailable.set(m.plugin, why);
    }
    const { key, revision } = seedKey(catalogue, kind, choices, [...unavailable.keys()]);
    const plan: SeedPlan[] = catalogue.map((m) => {
      const entry = { alias: m.alias, plugin: m.plugin, since: m.since ?? 1 };
      if (m.for && !m.for.includes(kind)) return { ...entry, withheld: "not-for", reason: `for ${m.for.join(", ")} agents; this one is ${kind}` };
      const missing = unavailable.get(m.plugin);
      if (missing) return { ...entry, withheld: "unavailable", reason: missing };
      const plugin = byId.get(m.plugin);
      if (plugin && !pluginEnabled(SEEDED_PLUGINS.has(m.plugin), choices[m.plugin])) {
        return { ...entry, withheld: "declined", reason: `${m.plugin} is switched off for this agent` };
      }
      const config = (m.config ?? { account: m.account }) as Record<string, Json>;
      // The seed is hand-written and reaches every agent: a misspelt setting is refused at the first agent it
      // would have reached, and said in the record, rather than becoming the plugin's silent default everywhere.
      const problems = plugin ? validateMount(plugin, config, m.secretRef ?? null) : [];
      if (problems.length) return { ...entry, withheld: "refused", reason: problems.map((x) => x.message).join("; ") };
      return {
        ...entry,
        mount: {
          tenantId, agentId, alias: m.alias, plugin: m.plugin,
          installationId: seedInstallation(m.alias), connectionId: null,
          toolVersion: this.pluginVersion(m.plugin) ?? "1.0.0",
          publicConfig: config, secretRef: m.secretRef ?? null, policy: m.policy ?? null,
        },
      };
    });
    const out = await this.store.reconcileSeeds(tenantId, agentId, { key, revision, plan });
    if (out.ran) {
      for (const r of out.changed) if (r.outcome === "refused") console.warn(`seed ${r.alias}@${r.since} refused for ${agentId}: ${r.reason}`);
    }
    return out;
  }

  /**
   * One mount the defaults do not give, added by an operator (`/admin/mounts`).
   * Where `provision` skips quietly (plugin switched off, alias present), this
   * answers. An alias that is already there is left alone: the same plugin and
   * settings is a repeat, anything else is refused rather than overwritten,
   * because a mount carries a credential and a database that a replace
   * would orphan. It is always added without a credential.
   */
  async addMount(
    tenantId: string, agentId: string, seed: { alias: string; plugin: string; config: Record<string, Json> },
    /**
     * `console`: a signed-in owner asked (`/ui/mount/add`), not the operator.
     * Only a plugin that declares `consoleMount`, at most CONSOLE_MOUNTS_MAX
     * such mounts, and a plugin the agent never spoke about is switched on as
     * part of the add (the way provisioning's explicit seed list does) rather
     * than refused. The mount is marked (`CONSOLE_INSTALLATION`).
     */
    opts: { console?: boolean } = {},
  ): Promise<{ ok: true; added: boolean; tools?: Awaited<ReturnType<ToolGateway["refreshMountTools"]>> } | { ok: false; error: string }> {
    await this.ready();
    if (!MOUNT_ALIAS.test(seed.alias)) return { ok: false, error: `an alias is ${MOUNT_ALIAS}` };
    const plugin = this.#plugins.find((p) => p.id === seed.plugin);
    if (!plugin) return { ok: false, error: `no plugin named ${seed.plugin}` };
    if (opts.console && plugin.consoleMount !== true) return { ok: false, error: `${plugin.id} cannot be added from the console` };
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
    if (opts.console) {
      const mine = (await this.store.listMounts(tenantId, agentId)).filter(consoleAdded).length;
      if (mine >= CONSOLE_MOUNTS_MAX) {
        return { ok: false, error: `this agent already has ${mine} mounts added from the console, the most it may have; remove one first` };
      }
    }
    const choices = await this.store.pluginChoices(tenantId, agentId);
    // The console switches on a plugin the agent never spoke about, after every
    // check below has passed; an explicit "disable" is the owner's and still wins.
    const switchOn = !!opts.console && choices[plugin.id] === undefined && !SEEDED_PLUGINS.has(plugin.id);
    if (!switchOn && !pluginEnabled(SEEDED_PLUGINS.has(plugin.id), choices[plugin.id])) {
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
    if (switchOn) await this.store.setPluginChoice(tenantId, agentId, plugin.id, "enable");
    await this.store.addMount({
      tenantId, agentId, alias: seed.alias, plugin: plugin.id,
      // A console mount's id is new on every add, so a listing still in flight for a removed one
      // cannot be written onto its successor under the same alias (gateway `refreshMountTools`).
      installationId: opts.console ? `${CONSOLE_INSTALLATION}${seed.alias}:${crypto.randomUUID()}` : seedInstallation(seed.alias), connectionId: null,
      toolVersion: this.pluginVersion(plugin.id) ?? "1.0.0",
      publicConfig: seed.config, secretRef: null, policy: null,
    });
    // A mount whose tools come from a server is asked for them now, while the
    // operator who added it is reading the answer. A failure does not undo the
    // mount: the server may want a secret the agent has not kept yet, and the
    // mount offers nothing until a refresh succeeds.
    if (plugin.snapshotTools) {
      return { ok: true, added: true, tools: await this.#snapshot(tenantId, agentId, seed.alias) };
    }
    return { ok: true, added: true };
  }

  /**
   * `addMount` from the console's form: the settings arrive as one string per
   * declared field and are coerced to the declared types (`configFromForm`)
   * before the add judges them; `addMount` refuses a plugin that is not offered
   * to the console.
   */
  async addConsoleMount(tenantId: string, agentId: string, pluginId: string, alias: string, form: Record<string, string>) {
    await this.ready();
    const plugin = this.#plugins.find((p) => p.id === pluginId);
    if (!plugin) return { ok: false as const, error: `no plugin named ${pluginId}` };
    const parsed = configFromForm(plugin.config ?? [], form);
    if (!parsed.ok) return { ok: false as const, error: `cannot mount ${plugin.id}: ${parsed.error}` };
    return this.addMount(tenantId, agentId, { alias, plugin: plugin.id, config: parsed.config }, { console: true });
  }

  /**
   * Ask a mount's server for its tool list again (`/admin/mounts` with
   * `refreshTools`). Operator-only, like adding the mount: an agent cannot
   * change what it is offered, and a remote server cannot either until a person
   * asks. The stored list is replaced only when it changed.
   */
  async refreshMountTools(tenantId: string, agentId: string, alias: string) {
    await this.ready();
    return this.#snapshot(tenantId, agentId, alias);
  }

  /**
   * The console's refresh (`/ui/mount/refresh`): only a mount the console added.
   * A mount the operator added offers what the operator chose, and its refresh
   * stays theirs (`/admin/mounts`).
   */
  async refreshConsoleMount(tenantId: string, agentId: string, alias: string) {
    await this.ready();
    const mount = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!mount) return { ok: false as const, error: `no mount named ${alias}` };
    if (!consoleAdded(mount)) return { ok: false as const, error: `${alias} was not added from the console; its tools are the operator's to refresh` };
    return this.#snapshot(tenantId, agentId, alias);
  }

  /**
   * Ask for a mount's tools, and keep why it failed when it did
   * (`snapshotError`): the person who added a mount whose server could not be
   * listed reads the reason on the mount's page later, not only in the answer
   * to the click. A table of the object's own, keyed by alias like
   * `held_warnings` (one object is one agent), so neither store's schema moves;
   * a success, a rename and a remove each update it.
   */
  async #snapshot(tenantId: string, agentId: string, alias: string, opts?: { keepCredentialed?: true }) {
    const r = await this.#gateway.refreshMountTools(tenantId, agentId, alias, opts);
    if (r.ok) this.#snapshotErrors()?.exec("DELETE FROM mount_snapshot_errors WHERE alias = ?", alias);
    // A stale answer is about a mount that is gone; the one now under the alias has its own.
    else if (!("stale" in r)) await this.#snapshotFailed(tenantId, agentId, alias, r.error);
    return r;
  }

  /** Keep why a mount's listing failed, for its page (`snapshotError`), while the mount is still there. */
  async #snapshotFailed(tenantId: string, agentId: string, alias: string, error: string) {
    const sql = this.#snapshotErrors();
    if (!sql || !await this.store.getMountByAlias(tenantId, agentId, alias)) return;
    sql.exec("INSERT INTO mount_snapshot_errors(alias, error, at) VALUES (?,?,?) ON CONFLICT(alias) DO UPDATE SET error = excluded.error, at = excluded.at",
      alias, error, Date.now());
  }

  /**
   * Re-take, at the start of a turn, every tool list taken under a basis that is not its plugin's now
   * (`Plugin.toolsBasis`, `ToolSnapshot.basis`). A snapshot is otherwise taken only when a mount is added, its
   * credential changes or an operator refreshes it, so a deploy that adds a tool would never reach a mount whose list
   * already existed: the model was not offered the tool, and a plugin that hinted at it named a tool the mount lacked.
   *
   * Asked of a mount only when its plugin lists its own tools and declares a basis, the mount has a snapshot whose
   * basis differs (one with none differs: it was taken before bases existed), and its plugin is switched on. A mount
   * with no snapshot is left alone: it is offered every tool already. Each re-take goes through `#snapshot`, so it is
   * written only when the list or its marks moved, with `RETAKE_TIMEOUT_MS` as its bound; a failure or a timeout keeps
   * the old list, which `mountTools` still reads against this build's tools (a removed tool is not offered), records
   * why (`snapshotError`), and is not tried again for that basis for `RETAKE_BACKOFF_MS`. Under `keepCredentialed`
   * the gateway also treats as a failure a credentialed list that would be replaced because the credential did not
   * resolve, was refused (`ListedTools.refused`) or listed nothing, and writes nothing (`stale`, no back-off) when the
   * mount's list was replaced by someone else while the listing ran — the listing can outlive the timeout here.
   *
   * Asked only where a turn starts (`postMessage` with `prompt`, which every new turn goes through: a person's message,
   * an Agents API input, an inbound event, a finished background job), never in `agent`: that also opens the harness
   * behind a steer, a job's take and delivery, a status read and a transcript read, none of which may wait on a far
   * end's listing. Two turn starts at once share one pass (`#retaking`), so a mount is listed once, not once per caller.
   * An inbound event's turn starts the pass without waiting for it (`postMessage`'s `retake: "background"`). The pass
   * is forgotten when it settles either way (`finally`), so one that threw does not stand in for every later one.
   *
   * Public so a test can ask for exactly this step.
   */
  retakeStaleSnapshots(tenantId: string, agentId: string): Promise<void> {
    const key = `${tenantId}/${agentId}`;
    const running = this.#retaking.get(key);
    if (running) return running;
    const pass = this.#retakeStale(tenantId, agentId).finally(() => this.#retaking.delete(key));
    this.#retaking.set(key, pass);
    return pass;
  }

  async #retakeStale(tenantId: string, agentId: string): Promise<void> {
    const byId = new Map(this.#plugins.map((p) => [p.id, p]));
    const stale = (await this.store.listMounts(tenantId, agentId)).filter((m) => {
      const p = byId.get(m.plugin);
      return !!p?.snapshotTools && p.toolsBasis !== undefined && !!m.toolSnapshot && m.toolSnapshot.basis !== p.toolsBasis;
    });
    if (!stale.length) return;
    const choices = await this.store.pluginChoices(tenantId, agentId);
    const now = Date.now();
    const due = stale.filter((m) => {
      if (!pluginEnabled(SEEDED_PLUGINS.has(m.plugin), choices[m.plugin])) return false;
      const failed = this.#retakeFailed.get(`${tenantId}/${agentId}/${m.alias}`);
      return !failed || failed.basis !== byId.get(m.plugin)!.toolsBasis || now - failed.at >= RETAKE_BACKOFF_MS;
    });
    if (!due.length) return;
    // The gateway refuses to list for a mount whose pin is not the registry's, and the build that moved the basis
    // usually moved the version too; `agent` would repin anyway, when the turn opens the harness.
    if (due.some((m) => this.pluginVersion(m.plugin) !== m.toolVersion)) await this.repinMounts(tenantId, agentId);
    for (const m of due) {
      const key = `${tenantId}/${agentId}/${m.alias}`;
      const basis = byId.get(m.plugin)!.toolsBasis!;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), RETAKE_TIMEOUT_MS); });
      let r: Awaited<ReturnType<AgentRuntime["refreshMountTools"]>> | "timeout";
      try {
        r = await Promise.race([this.#snapshot(tenantId, agentId, m.alias, { keepCredentialed: true }), timedOut]);
      } catch (e) {
        r = { ok: false, error: `could not list ${m.alias}'s tools: ${String((e as Error)?.message ?? e).slice(0, 300)}` };
        await this.#snapshotFailed(tenantId, agentId, m.alias, r.error);
      } finally {
        clearTimeout(timer);
      }
      // Timed out: the listing goes on, and lands (or records its own failure) if it ever answers.
      if (r === "timeout") {
        await this.#snapshotFailed(tenantId, agentId, m.alias,
          `could not list ${m.alias}'s tools: no answer within ${RETAKE_TIMEOUT_MS} ms at the start of a turn; the previous list is kept`);
      }
      // Stale: someone else's newer list stood, which is no failure of this mount's listing and needs no back-off.
      if (r === "timeout" || (!r.ok && !("stale" in r))) this.#retakeFailed.set(key, { basis, at: Date.now() });
      else this.#retakeFailed.delete(key);
    }
  }

  #snapshotErrors() {
    const sql = this.#deps.ctx.storage?.sql;
    if (!sql) return null;
    sql.exec("CREATE TABLE IF NOT EXISTS mount_snapshot_errors(alias TEXT PRIMARY KEY, error TEXT NOT NULL, at INTEGER NOT NULL)");
    return sql;
  }

  /** Why this mount's last tool listing failed, or null when it succeeded or was never asked. */
  snapshotError(alias: string): string | null {
    const row = this.#snapshotErrors()?.exec("SELECT error FROM mount_snapshot_errors WHERE alias = ?", alias).toArray()[0] as any;
    return row ? String(row.error) : null;
  }

  /**
   * Delete one mount a person added from the console (`/ui/mount/remove`), and
   * everything filed under its alias.
   *
   * Only a mount the console added (`consoleAdded`), of a plugin that still
   * declares `consoleMount`, and only one nothing else depends on, because a delete cannot be switched back on the way turning a
   * plugin off can. Each refusal names what is in the way:
   *  - a credential reference: an account on it is the owner's to take back
   *    first (or the operator's, for one this agent did not attach);
   *  - a held call waiting for a person: deciding it would run against a mount
   *    that is gone;
   *  - something running under it, or a background job: the same guard a
   *    rename and a release use (`renameSafety`, `mountsWithRunningJobs`);
   *  - a removal of the same mount already under way (a double click): two
   *    would each run `unmount`, and the second could delete a mount added
   *    under the alias after the first had finished.
   *
   * The mount is identified by its installation id, which a console add makes
   * fresh: if the alias names another installation by the time `unmount` is
   * done, or by the delete (which is conditional on it, in the store's own
   * transaction), the removal stops and leaves that mount alone.
   *
   * Past those, the removal is going to happen, and in this order:
   *  1. the plugin's `unmount`, if it declares one, bounded by
   *     `UNMOUNT_TIMEOUT_MS`. A throw or a timeout does not stop the removal —
   *     a service that is down must not make a mount undeletable — and comes
   *     back as `unmountError`, for the person who removed it to read. It runs
   *     after every refusal so a plugin never cancels its registrations for a
   *     mount that then stays, and before the hooks go so it can still use
   *     `ctx.inbound` and find its hooks live.
   *  2. every hook of the alias still live is revoked, the way
   *     `ctx.inbound.revoke` does it: the index row first, so the URL stops
   *     resolving, then the secret — in two passes, the second just before
   *     the delete, for a `ctx.inbound.create()` already past its last check
   *     of the mark when the first list was read. A live hook is not a refusal: only the
   *     plugin's own tools or the operator can revoke one, so "revoke it
   *     first" would leave the owner with a mount they cannot delete; the hook
   *     is the runtime's resource, so the runtime closes it. If the index
   *     cannot be read (it is read once before step 1 too, so an index that is
   *     down refuses before the plugin has cancelled anything) or a revoke
   *     fails, the removal is REFUSED with that
   *     reason, even though `unmount` has already run: a public URL left live
   *     for an alias that a later mount may take is worse than a mount that
   *     stays until the index answers, and trying again is safe — an `unmount`
   *     that finds nothing left to cancel has nothing to do.
   *  3. the store's delete, as before.
   *
   * `hooks` is the hook index, passed in by the caller that holds it: the
   * runtime's own handle exists only where plugins may make hooks, while the
   * operator's route can make one anywhere. Null means there is no index, so
   * no hook to revoke.
   *
   * After the store's delete, the caches keyed by the alias go too: a
   * credential check's held error, the held-thing warnings and the last
   * snapshot error. A cached
   * harness is rebuilt because its key (`catalogueKey`) names the mounts.
   */
  async removeMount(
    tenantId: string, agentId: string, alias: string,
    hooks: Pick<HookDirectory, "list" | "revoke"> | null,
  ): Promise<{ ok: true; unmountError?: string } | { ok: false; error: string; conflict?: true }> {
    await this.ready();
    const mount = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!mount) return { ok: false, error: `no mount named ${alias}` };
    const plugin = this.#plugins.find((p) => p.id === mount.plugin);
    const refuse = (error: string) => ({ ok: false as const, error, conflict: true as const });
    // Early, so a second click costs nothing; the check that decides is the one beside the mark, below.
    if (this.#gateway.isRemoving(tenantId, agentId, alias)) return refuse(`${alias} is already being removed`);
    if (plugin?.consoleMount !== true) return refuse(`${mount.plugin} mounts cannot be removed from the console`);
    if (!consoleAdded(mount)) return refuse(`${alias} was not added from the console; only the operator can remove it`);
    if (mount.secretRef) return refuse(`${alias} has an account attached; remove it first`);
    const held = (await this.store.listApprovals(tenantId, "pending")).filter((a) => a.agentId === agentId && a.mountAlias === alias).length;
    if (held) return refuse(`${alias} has ${held} call${held === 1 ? "" : "s"} waiting for a decision; decide ${held === 1 ? "it" : "them"} first`);
    const sql = this.#deps.ctx.storage.sql;
    if (mountsWithRunningJobs(sql, { tenantId, agentId }).has(alias)) {
      return refuse(`${alias} is running a background job; wait for it or cancel it first`);
    }
    const safety = renameSafety(await this.#gateway.mountActivity({ tenantId, agentId, taskId: LEGACY_TASK }, alias), Date.now());
    if (!safety.safe) return refuse(`${safety.reason} (${safety.live.id}, idle ${Math.round(safety.live.idleMs / 60_000)}m)`);
    // Read before `unmount` as well as after: an index that cannot be read refuses before the plugin has cancelled
    // anything, which is the common way step 2 fails. The second read is what the plugin left live.
    const liveHooks = async (): Promise<HookRow[] | { error: string }> => {
      try {
        return hooks ? (await hooks.list(tenantId, agentId)).filter((h) => h.alias === alias && h.revokedAt === null) : [];
      } catch (e) {
        return { error: `could not check ${alias}'s inbound hooks, so it was not removed: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
      }
    };
    const readable = await liveHooks();
    if ("error" in readable) return refuse(readable.error);
    // The refusals above awaited; the mount they judged is read again, and the identity check, the check for a
    // removal already under way and the mark are one synchronous run, so two removals (a double click) cannot
    // both pass it. A console mount's installation id is made fresh on every add (`addMount`), so a mount
    // removed and added again under the same alias is told apart from the one these refusals judged.
    const current = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!current || current.installationId !== mount.installationId) return refuse(changedWhileRemoving(alias));
    if (this.#gateway.isRemoving(tenantId, agentId, alias)) return refuse(`${alias} is already being removed`);
    // From here the removal is decided: no call or pushed event reaches the mount until it is gone, or until a
    // refusal below calls it off (`ToolGateway.markRemoving`).
    const unmark = this.#gateway.markRemoving(tenantId, agentId, alias);
    try {
      return await this.#removeDecided(current, plugin, hooks, liveHooks, refuse);
    } finally {
      unmark();
    }
  }

  /** `removeMount` past its refusals: `unmount`, the hooks, the delete. */
  async #removeDecided(
    mount: MountRecord, plugin: Plugin,
    hooks: Pick<HookDirectory, "list" | "revoke"> | null,
    liveHooks: () => Promise<HookRow[] | { error: string }>,
    refuse: (error: string) => { ok: false; error: string; conflict: true },
  ): Promise<{ ok: true; unmountError?: string } | { ok: false; error: string; conflict?: true }> {
    const { tenantId, agentId, alias } = mount;
    const sql = this.#deps.ctx.storage.sql;
    const unmountError = plugin.unmount ? await this.#unmount(mount) : null;
    // Still the same mount? Only another path that deletes rows (the store, an operator) could have taken it away
    // while this one was marked; if one did and a new mount took the alias, its hooks are not this removal's.
    const still = await this.store.getMountByAlias(tenantId, agentId, alias);
    if (!still || still.installationId !== mount.installationId) return refuse(changedWhileRemoving(alias));
    const revokeLive = async (): Promise<string | null> => {
      const live = await liveHooks();
      if ("error" in live) return live.error;
      for (const h of live) {
        try {
          // Null is a hook revoked since the list was read; its secret goes all the same.
          await hooks!.revoke(h.hookId);
          await this.dropHookSecret(tenantId, agentId, h.hookId);
        } catch (e) {
          return `could not revoke ${alias}'s inbound hook, so it was not removed: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
        }
      }
      return null;
    };
    // Twice. A `ctx.inbound.create()` that began before the removal was decided can be past its last check of the
    // mark (`#inboundFor`) and still write its row after the first list was read; the second pass, right before the
    // delete, revokes what such a call left. Either pass failing refuses, by the same rule.
    for (let pass = 0; pass < 2; pass++) {
      const failed = await revokeLive();
      if (failed) return refuse(failed);
    }
    // The row a credential attached here would have been kept under. This mount
    // does not reference it (refused above), but another may: a reference is a
    // name, and `agent:<alias>` can sit on any mount. Only an unreferenced row
    // is a leftover; a referenced one is someone's credential and stays.
    const row = agentRef(alias);
    const shared = (await this.store.listMounts(tenantId, agentId)).some((m) => m.alias !== alias && m.secretRef === row);
    // Conditional on the installation, in the store's own transaction: there is no await between that check and
    // the delete, so a mount that took the alias since the check above is never the one deleted.
    if (!(await this.store.removeMount(tenantId, agentId, alias, shared ? null : alias, mount.installationId))) {
      return refuse(changedWhileRemoving(alias));
    }
    this.#unchecked.delete(`${tenantId}/${agentId}/${alias}`);
    const warned = sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='held_warnings'").toArray().length > 0;
    if (warned) sql.exec("DELETE FROM held_warnings WHERE alias = ?", alias);
    this.#snapshotErrors()?.exec("DELETE FROM mount_snapshot_errors WHERE alias = ?", alias);
    return unmountError ? { ok: true, unmountError } : { ok: true };
  }

  /**
   * The plugin's `unmount`, under its timeout: null when it returned, else why not, in words for the person who
   * removed the mount. The context is closed on every way out, before the caller deletes anything: a call past the
   * deadline is not stopped (nothing can stop a promise), but from then on every `ctx.db`, `ctx.inbound` and other
   * context call it makes refuses, so it cannot write under an alias that is being deleted — or that a new mount
   * has taken by the time it gets there (`ToolGateway.unmount`).
   */
  async #unmount(mount: MountRecord): Promise<string | null> {
    const alias = mount.alias;
    const ms = this.#deps.unmountTimeoutMs ?? UNMOUNT_TIMEOUT_MS;
    const failed = (e: unknown) => `${alias}'s plugin could not clean up: ${String((e as Error)?.message ?? e).slice(0, 300)}`;
    let started: Awaited<ReturnType<ToolGateway["unmount"]>> = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Building the context can throw too (a plugin's `mountTools`, say): that is a failed cleanup like any
      // other, recorded, and the removal goes on.
      try { started = await this.#gateway.unmount(mount); } catch (e) { return failed(e); }
      if (!started) return null;
      const call = started.done.then(() => null, failed);
      const timedOut = new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve(`${alias}'s plugin did not finish cleaning up within ${ms} ms`), ms);
      });
      return await Promise.race([call, timedOut]);
    } finally {
      clearTimeout(timer);
      started?.close();
    }
  }

  /**
   * The owner keeps a secret from the console (`/ui/secret`), for a mount's
   * `{{name}}` header slots. Under `owner:`, not the agent's `kept:`: the same
   * name and value rules and the same sealing as `state.secret_put`, but the
   * agent's `secret_*` tools cannot read, list, overwrite or delete it, and
   * only `ctx.ownerSecret` resolves it (src/runtime/secrets.ts). The value is
   * never returned.
   */
  async putOwnerSecret(tenantId: string, agentId: string, name: string, value: string): Promise<{ ok: true } | { ok: false; error: string }> {
    await this.ready();
    const bad = keptNameProblem(name) ?? keptValueProblem(value);
    if (bad) return { ok: false, error: bad };
    const kek = await this.#kek;
    if (!kek) return { ok: false, error: "this deployment has no SECRET_KEK, so it cannot keep a secret" };
    await keptPut(this.store, kek, tenantId, agentId, name, value, OWNER_PREFIX);
    return { ok: true };
  }

  async removeOwnerSecret(tenantId: string, agentId: string, name: string): Promise<{ ok: true; removed: boolean } | { ok: false; error: string }> {
    await this.ready();
    const bad = keptNameProblem(name);
    if (bad) return { ok: false, error: bad };
    return { ok: true, removed: await keptDelete(this.store, tenantId, agentId, name, OWNER_PREFIX) };
  }

  /** The owner's secrets, in `secret_list`'s shape: names and times, never a value. */
  async ownerSecrets(tenantId: string, agentId: string) {
    await this.ready();
    return keptList(this.store, tenantId, agentId, OWNER_PREFIX);
  }

  /**
   * Point a tenant at the operator's model account, explicitly.
   *
   * This exists so a demo or a benchmark can be set up in one call. It is a
   * deliberate act with a visible binding row behind it, not a default that
   * quietly applies to everyone who forgot to configure one.
   */
  /**
   * `choice`: the provider and model this agent is served by when not the deployment's default
   * (model_overrides). The provider must be one the deployment declares; the binding records its URL for
   * whoever reads the row, and names the provider in its reference (operatorRefFor).
   */
  /** The providers the operator's account reaches, to decide whether a choice can be bound (planBinding); null without one. */
  operatorProviders(): ModelProviders | null {
    return this.#deps.operatorModel?.providers ?? null;
  }

  async bindOperatorModel(tenantId: string, agentId: string | null = null, choice?: ModelChoice | null) {
    await this.ready();
    const m = this.#deps.operatorModel;
    if (!m) throw new Error("no operator model configured on this deployment");
    const provider = choice?.provider || DEFAULT_PROVIDER;
    const chosen = choice?.model || m.model;
    // Checked against the declaration, so a binding is never written for a provider or a model name a
    // call would refuse. A provider whose secret is unset is still bound: the call says what is missing.
    const { baseUrl } = providerFor(m.providers, { provider, model: chosen });
    await this.store.setModelBinding({
      tenantId, agentId, provider: "openai-compatible",
      model: chosen, baseUrl, secretRef: operatorRefFor(provider),
    });
    return { tenantId, agentId, provider, model: chosen };
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
    const records = enabledMounts(all, new Set(byId.keys()), SEEDED_PLUGINS, choices);
    return {
      records,
      unoffered: unofferedMounts(all, new Set(byId.keys()), SEEDED_PLUGINS, choices)
        .map(({ mount, reason }) => ({ alias: mount.alias, plugin: mount.plugin, reason })),
      mounts: records.map((m) => ({
        alias: m.alias, plugin: m.plugin, version: m.toolVersion, config: m.publicConfig,
      })),
      tools: qualifyMountedTools(withholdTools(mountedToolEntries(records, byId), this.#deps.withholdTools ?? [])),
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
  async agent(tenantId: string, agentId: string, session: string = MAIN_SESSION): Promise<AgentEngine> {
    await this.ready();
    const key = `${tenantId}/${agentId}`;
    const cacheKey = `${key}#${session}`;
    const cached = this.#agents.get(cacheKey);
    if (cached) {
      const now = await this.#catalogueKeyFor(tenantId, agentId);
      const running = cached.builtFrom !== now && await cached.agent.running();
      if (reuseHarness(cached.builtFrom, now, running)) return cached.agent;
      this.#agents.delete(cacheKey);
    }

    const binding = await this.store.getModelBinding(tenantId, agentId);
    if (!binding) throw new Error(`no model binding for ${key}`);
    // Which kernel runs this agent: `pd` (src/runtime/durable-agent.ts) only where the object's `ap_meta`
    // says so. Every creation path still leaves that row absent, so an agent is opened as `PiAgent` unless
    // the operator migrated it (`migrateEngine` below, src/runtime/pd-migrate.ts). An object with no
    // `ap_meta` table is read without creating one.
    const engine = this.#engine();
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
    // Which tool, if any, can read a parked result back — asked of the tool's
    // own declaration, and named the way the model was offered it. It used to
    // be found by taking the plugin id `artifacts` and appending `.read`,
    // which made the reader that plugin under that tool name: renaming either
    // left the runtime with no reader and nothing saying so.
    const reader = parkedReader(tools as MountedTool[]);
    const offered = withLimitNote(tools as MountedTool[], reader);
    // Asked per call, and only of a mount whose plugin declares `holds`: a
    // mount that holds nothing is filtered out before any state is read, so
    // the common call pays nothing for this.
    const activityOf = (alias: string) =>
      this.#gateway.mountActivities({ tenantId, agentId, taskId: LEGACY_TASK }, alias);
    const nameOf = (alias: string, tool: string) => offeredToolName(offered as MountedTool[], alias, tool);
    // Every thing the mount holds, one line each: a mount holding two machines names both.
    const heldOn = async (alias: string) =>
      heldLines(await heldResources(records.filter((m) => m.alias === alias), this.#plugins, activityOf), nameOf, Date.now());
    const host = this.#host(
      { tenantId, agentId, taskId: session === MAIN_SESSION ? LEGACY_TASK : session }, reader, offered, heldOn,
      () => contextIdOf(this.#deps.ctx.storage.sql, { tenantId, agentId, session, engine: engine === "pd" ? "pd" : "pi085" }));
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
        job.mount, job.handle as Json, job.id),
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
    const taken = new Set([...offered.map((t) => t.name), "run_js", "resume", "jobs"]);
    const callerDefs = Array.isArray(apiTools)
      ? apiTools.filter((t: any) => typeof t?.name === "string" && !taken.has(t.name)).map((t: any) => ({
          name: String(t.name), description: String(t.description ?? ""), parameters: t.parameters ?? { type: "object", properties: {} },
        }))
      : [];
    const callerTools = Array.isArray(apiTools) && engine !== "pd"
      ? clientTools(callerDefs,
          { sql: this.#deps.ctx.storage.sql, session, lane: () => agentRef.current!.lane,
            branch: (tip) => agentRef.current!.storage.scanBranch({ start: tip, order: "oldestFirst" }, BACKGROUND_CONTEXT) as any })
      : [];
    const counting = {
      onCalls: (n: number) => { void store.consumeQuota(tenantId, "tool_calls", n); },
      onRun: (run: { ok: boolean; ms: number; hostCalls: number; resumed?: boolean }) => store.recordUsage?.(jsRunRows(
        { at: Date.now() - run.ms, tenantId, agentId }, run.ok ? "ok" : "failed", run.ms, run.hostCalls, run.resumed === true,
      )),
    };
    // A tool that can ask the model a question needs `resume` to be answered,
    // with run_js or without it (an Agents API agent has no run_js). Asked as
    // a capability, like `jobs`, so a plugin that declares `interrupts` is
    // answerable without anyone coming back here.
    const asks = offersCapability(
      records, offered as MountedTool[],
      (id) => !!interruptsOf(this.#plugins.find((pl) => pl.id === id) ?? {}),
    );
    const keeping = extras.runJs || asks ? { continuations: this.#continuations, scope: session } : undefined;
    const extraTools = [
      ...(extras.runJs
        // resume beside run_js answers its programs and every tool's question.
        ? runJsTools(this.#executor as any, host, {
            ...counting,
            // So a script names a tool the way the model's own list names it.
            tools: offered,
            // So a stale name for a mount that cannot be offered is answered with
            // the reason, not as a typo.
            unoffered,
            continuations: this.#continuations,
            scope: session,
          })
        : asks ? [resumeTool(this.#continuations, { ...counting, scope: session })] : []),
      ...(extras.jobs ? [jobs] : []),
      ...callerTools,
    ];

    // Read here rather than inside the harness, so the harness keeps holding
    // no I/O of its own.
    const prompt = systemPrompt({
      // The agent's own record: a person named and described it at creation,
      // and that is the first thing the prompt says after the core.
      persona: personaOf((await this.store.loadAgent(tenantId, agentId))?.config),
      // Whatever the mounted plugins have to say, in registry order. The
      // framework no longer reaches into any one plugin for this (Piper,
      // tygg, 2026-09-12).
      contributions: await this.#gateway.promptContributions({ tenantId, agentId, taskId: LEGACY_TASK }),
      // `release` is scoped to the agent, not to a task, so a new session
      // inherits whatever the last one left alive — and until now nothing
      // told it, which is how a container billed overnight for a
      // conversation that had ended (tygg, 2026-09-22). Session-stable facts
      // only; the durations are in the two message-side sentences.
      held: heldPrompt(await heldResources(records, this.#plugins, activityOf), nameOf),
      policy: this.#deps.policy,
      // Each paragraph appears only where the thing it describes is really
      // there — telling an agent to read a result back with a tool it has not
      // got is a wrong instruction competing with the right ones. That used
      // to be a question this file asked about one plugin; the artifacts
      // paragraph is now the artifacts mount's own contribution, so the
      // condition is "the mount is there" and nobody has to check it.
      // `sandbox` stays: run_js is the harness's, not a mount's. Both engines offer it.
      sandbox: extras.runJs,
    });
    const model = this.#modelOf(binding);
    const dispatch = this.#dispatchFor(tenantId, agentId);
    // A call to a tool the model was not offered is answered by pi with its own line; each engine sends this
    // instead (src/runtime/unavailable-tool.ts), read from the same mounts the catalogue was built from.
    const explainUnavailable = (name: string) => explainUnavailableTool(name, {
      mounts: records.map((m) => ({ alias: m.alias, plugin: this.#plugins.find((pl) => pl.id === m.plugin), toolSnapshot: m.toolSnapshot })),
      offered: offered as MountedTool[], unoffered,
    });

    if (engine === "pd") {
      // The same catalogue PiAgent gets, through the same host and the same continuations
      // (src/runtime/durable-tools.ts). The caller's functions are pd's own tools there (`clientTool`), which record
      // their call in pi-durable state and wait for the caller, so they are handed over as definitions.
      const pdHost = this.#pd ??= new PdHost({ storage: this.#deps.ctx.storage });
      const pd = DurableAgent.open({
        host: pdHost, tenantId, agentId, session, systemPrompt: prompt, model, dispatch,
        unknownJob: (id) => new UnknownJob(id),
        openSession: (other) => this.agent(tenantId, agentId, other),
        tools: offered as MountedTool[], toolHost: host, ...(keeping ? { interrupts: keeping } : {}),
        extraTools: extraTools as never, clientTools: callerDefs,
        // The cancel marker's model message, as PiAgent's entry projector below makes it.
        cancelNote: CANCELLED_NOTE,
        explainUnavailable,
      });
      this.#agents.set(cacheKey, { agent: pd, builtFrom });
      return pd;
    }

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
      systemPrompt: prompt,
      model,
      tools: offered,
      extraTools: extraTools as any,
      toolHost: host,
      ...(keeping ? { interrupts: keeping } : {}),
      dispatch,
      explainUnavailable,
    });
    agentRef.current = agent;
    this.#agents.set(cacheKey, { agent, builtFrom });
    return agent;
  }

  /** The model an engine registers for a binding. */
  #modelOf(binding: { provider: string; model: string }) {
    return {
      provider: binding.provider,
      id: binding.model,
      // The bound model's own window when the table knows it: an agent can be on another model than
      // the deployment's (model_overrides).
      contextWindow: contextWindowFor(binding.model, this.#deps.contextWindow ?? ASSUMED_CONTEXT_WINDOW),
    };
  }

  /** How an engine hands a written model job to the queue. */
  #dispatchFor(tenantId: string, agentId: string) {
    return async (jobId: string) => {
      const send = this.#deps.offloadModel;
      if (!send) throw new Error("no dispatcher configured");
      await send({ tenantId, agentId, taskId: LEGACY_TASK, commandId: jobId, payload: null });
    };
  }

  /**
   * Move this agent between engines (src/runtime/pd-migrate.ts): `migrate` takes an idle pi085 agent to pd, importing
   * each session's active branch; `revert` takes a migrated one back, leaving pi085's tables as they were. `dryRun`
   * reports and writes nothing. Null when the object holds no such agent. What either drops from memory — the
   * engines built so far, the run_js programs and tool questions held for `resume` — is dropped only once it goes
   * ahead, so a refusal leaves the agent exactly as it was. A turn waiting for the API caller's functions is imported
   * cancelled, with the marker `cancelSession` writes.
   */
  async migrateEngine(tenantId: string, agentId: string, op: "migrate" | "revert", opts: { dryRun?: boolean } = {}):
    Promise<MigrationResult | RevertResult | null> {
    // The recorded engine is what this moves: read it again afterwards, whatever the outcome.
    try { return await this.#migrateEngine(tenantId, agentId, op, opts); }
    finally { this.#recorded = undefined; }
  }

  async #migrateEngine(tenantId: string, agentId: string, op: "migrate" | "revert", opts: { dryRun?: boolean }):
    Promise<MigrationResult | RevertResult | null> {
    await this.ready();
    if (!(await this.store.loadAgent(tenantId, agentId))) return null;
    const binding = await this.store.getModelBinding(tenantId, agentId);
    if (!binding) return { ok: false, refused: `no model binding for ${tenantId}/${agentId}` };
    const storage = this.#deps.ctx.storage;
    const host = this.#pd ?? new PdHost({ storage });
    host.bind({ tenantId, agentId, model: this.#modelOf(binding), dispatch: this.#dispatchFor(tenantId, agentId), unknownJob: (id) => new UnknownJob(id) });
    /** The engines built so far were opened on the engine that is about to stop being this agent's. */
    const forget = async () => {
      const built = [...this.#agents.values()];
      this.#agents.clear();
      for (const { agent } of built) await agent.close().catch(() => {});
    };
    if (op === "revert") {
      const out = await revertToPi085({ storage, host, ...(opts.dryRun ? { dryRun: true } : {}) });
      if (out.ok && out.action === "reverted") {
        await forget();
        // Its conversation ids name tables that are gone; the next pd agent, if any, opens a fresh host.
        this.#pd = null;
      }
      return out;
    }
    const out = await migrateToPd({
      storage, host, cancel: { marker: TURN_CANCELLED, note: CANCELLED_NOTE },
      ...(opts.dryRun ? { dryRun: true } : {}),
      cancelTransient: async () => {
        await forget();
        return { heldForResume: this.#continuations.discardAll() };
      },
    });
    if (out.ok && out.action === "migrated") this.#pd = host;
    return out;
  }

  /** Compact on demand. pi085 refuses with `CompactionUnavailable`
   *  (src/runtime/engine.ts), writing nothing; the object turns that into a
   *  value its routes answer 409 with (cf/src/compact-refusal.ts). pd starts a
   *  compaction and returns its operation id (`DurableAgent.compact`); the wake
   *  the object sets after it carries it. */
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
    opts: { retake?: "await" | "background"; beforeSay?: () => void } = {},
  ) {
    // Every turn starts here, in every mode — a steer is how a console message arrives, and pushes, background
    // completions and lease warnings are prompts — so the catalogue is reconciled here, before the harness is
    // opened below, and what it adds is offered in this turn (`reconcileSeeds`). A failure is logged and never
    // fails the message: the next turn tries again, since nothing was stored.
    // The pass's `added` rows are the seam for telling the agent, in this turn, what it now has.
    await this.reconcileSeeds(tenantId, agentId)
      .catch((e) => console.error(`reconciling ${tenantId}/${agentId} with the catalogue failed:`, e));
    // A new turn, so a tool list taken under another basis is taken again first (`retakeStaleSnapshots`), before the
    // harness is judged: a re-taken list changes the snapshot's hash, which is in `catalogueKey`, so the turn is built
    // with the new tools (or, if one is still running and this lands as a steer, the next one is). Not for a steer or
    // a follow-up, which add to a turn rather than start one.
    //
    // `retake: "background"` starts it without waiting, for a caller that must answer someone promptly — a service's
    // push at an inbound hook (`receiveHook`), whose request would otherwise wait out the listing's timeout. That turn
    // runs on the list as it stands; the re-take shares the same pass (`#retaking`), and when it writes, the moved hash
    // rebuilds the harness for the turn after. Either way a re-take that throws is logged and never fails the turn.
    if (mode === "prompt") {
      await this.ready();
      const retake = this.retakeStaleSnapshots(tenantId, agentId)
        .catch((e) => console.error(`re-taking ${tenantId}/${agentId}'s tool lists failed:`, e));
      if (opts.retake === "background") this.#deps.ctx.waitUntil?.(retake);
      else await retake;
    }
    const agent = await this.agent(tenantId, agentId, session);
    // A conversation that has just been spoken to has work until a step says
    // otherwise, so the next wake steps it. pd keeps no such list: its harness
    // holds the input, and a step drives every conversation (`step` below).
    if (!this.#isPd()) markSession(this.#deps.ctx.storage.sql, session, true);
    // Synchronously before the engine's write, with the harness already open: what a caller retires here
    // (`deliverPendingInbound`'s queued row) is gone exactly when the message is about to be written.
    opts.beforeSay?.();
    const res: any = await agent.say(text, mode);
    return { ...messageLanded(res, mode), result: res };
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
    if (!this.#isPd()) ensureAgentTables(sql);
    // A turn waiting for the caller has no run to abort on pi085; it still ends, and says so. On pd the waiting
    // tool is the run, so `cancel` already wrote the marker and forgot the calls.
    if ((await agent.dropClientCalls()) > 0 && !cancelledTurn) {
      await agent.markCancelled(TURN_CANCELLED);
    }
    const jobs = await stopSessionJobs({
      sql, owner: { tenantId, agentId }, session,
      cancel: (job) => this.#gateway.cancelBackground(
        { tenantId, agentId, taskId: session === MAIN_SESSION ? LEGACY_TASK : session }, job.mount, job.handle as Json, job.id),
      completeOperation: async (id, status) => { await this.store.completeOperation(tenantId, id, status, null); },
    });
    return { cancelledTurn, stoppedJobs: jobs.stopped, stillRunning: jobs.stillRunning };
  }

  /** The session's branch, oldest first: what the model's context is built from. */
  async branchEntries(tenantId: string, agentId: string, session: string) {
    return (await this.agent(tenantId, agentId, session)).branch();
  }

  /** Function calls this session waits on its API caller for, with the turn each belongs to. */
  async waitingClientCalls(tenantId: string, agentId: string, session: string) {
    // pi085 reads its table directly, building no agent (a catalogue read on every status poll). A pd object
    // keeps its calls in the engine's own state, so the recorded engine decides, not whether this isolate has
    // opened a pd agent yet.
    const rows = this.#isPd()
      ? await (await this.agent(tenantId, agentId, session)).waitingClientCalls()
      : pendingClientCalls(this.#deps.ctx.storage.sql, session);
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
    // As `waitingClientCalls`: pi085 writes its table directly, building no agent; pd hands them to its engine,
    // which resumes the harness, so there is no session to mark.
    if (this.#isPd()) {
      await (await this.agent(tenantId, agentId, session)).answerClientCalls(results);
      return { unknown: [] };
    }
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
    const pd = this.#isPd();
    if (!pd) ensureAgentTables(sql);
    // Background work first (task #16). A job that ended is delivered as a
    // message, which marks its session as having work, so the loop below steps
    // it in this same pass; the rest say when they want checking again.
    const owner = { tenantId, agentId };
    const jobCtx = (job: { session: string }) =>
      ({ tenantId, agentId, taskId: job.session === MAIN_SESSION ? LEGACY_TASK : job.session });
    const pass = (deliver: (session: string, text: string) => Promise<void>) => runBackgroundPass({
      sql, owner,
      // A job is kept under the id of the operation that started it, so the plugin is told that operation.
      poll: (job) => this.#gateway.pollBackground(jobCtx(job), job.mount, job.handle as Json, job.id),
      cancel: (job) => this.#gateway.cancelBackground(jobCtx(job), job.mount, job.handle as Json, job.id),
      completeOperation: async (id, status) => { await this.store.completeOperation(tenantId, id, status, null); },
      deliver,
    });
    // A task that is over (`ended`) keeps its jobs polled — the row records how each one ended, and a job
    // past its ceiling is still asked to stop — but no ending is delivered: a late result must not start a
    // turn whose next call would provision a machine nobody is watching. Asked at each delivery, not once
    // before the pass: the pass awaits the plugin's poll, and the task can end during that await.
    const bg = await pass(async (session, text) => {
      if (this.#deps.ended?.(owner) === true) return;
      await this.postMessage(tenantId, agentId, text, "prompt", session);
    });
    // pd: one harness runs every conversation of the object, and one step drives it whole
    // (`DurableAgent.step`), so there is nothing to choose. pi085: the sessions its list says have work.
    const sessions = pd ? [MAIN_SESSION] : sessionsWithWork(sql);
    if (!sessions.length) sessions.push(MAIN_SESSION);
    let open = 0, wakeInMs: number | null = bg.wakeInMs;
    const settled: Array<{ operationId: string; status: string }> = [];
    for (const session of sessions) {
      const agent = await this.agent(tenantId, agentId, session);
      let out = await agent.step();
      // A turn paused for an API caller's function results continues once they
      // have all arrived, and this pass drives the run that starts: a second
      // step, so the next model call is sent now rather than by an alarm armed
      // for 0 ms that would do only that (#778). Bounded at one: a resume needs
      // every paused call answered, and the run it starts cannot pause on a
      // client call again before a model answer, which only a later delivery
      // brings. pd never resumes here (its engine resumes when answered), so it
      // takes one step as before. That step's outcome is this session's, like
      // any step's — its open run, its wake — and if it throws the pass fails
      // as a first step's throw does: the alarm's fallback is already armed and
      // the session is still marked, by the results that woke this pass.
      if (out.open === 0 && await agent.resumeClientCalls()) {
        const before = out.settled;
        out = await agent.step();
        out = { ...out, settled: [...before, ...out.settled] };
      }
      open += out.open;
      settled.push(...out.settled);
      if (out.wakeInMs !== null) wakeInMs = wakeInMs === null ? out.wakeInMs : Math.min(wakeInMs, out.wakeInMs);
      if (!pd) markSession(sql, session, out.open > 0 || out.wakeInMs !== null);
    }
    // A finished run should not still be holding a metered container — either
    // by handing it back at once, or, where the deployment leases them, by
    // asking the agent first and taking it at the ceiling.
    let releaseFailed: Array<{ alias: string; error: string }> = [];
    // A turn that settled while background work runs has not finished using
    // its containers: releasing now would take the machine out from under the
    // job, which is the normal case, since the model keeps working (task #16).
    const backgroundRunning = runningBackgroundJobs(sql, owner).length > 0;
    // A program suspended at a pause keeps the object awake (and is discarded
    // here once past its time), and, like background work, has not finished
    // with the containers it was using.
    const keep = this.#continuations.wakeInMs();
    if (keep !== null) wakeInMs = wakeInMs === null ? keep : Math.min(wakeInMs, keep);
    if (this.#deps.autoRelease !== false && open === 0 && !backgroundRunning && keep === null) {
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
   * One look at every mount that is holding something: remind, take, or come
   * back later.
   *
   * What is held is the plugin's (`holds.activity` reports it); the schedule is
   * the framework's, which is why this reads that report rather than the plugin
   * reading a clock. Until 2026-09-22 this loop read `boxId`, `lastUsedAt` and
   * `quietUntil` out of one plugin's stored state and named its tools with
   * the literals `release` and `quiet` — so it was the sandbox's idle pass
   * wearing the framework's name, and a second plugin that held something got
   * no warning and no reclaim. Now every mount whose plugin declares `holds`
   * gets both, and this file names nothing of theirs.
   *
   * A mount holding nothing says nothing and costs nothing.
   */
  async #idlePass(tenantId: string, agentId: string): Promise<{
    wakeInMs: number | null; releaseFailed: Array<{ alias: string; error: string }>;
  }> {
    const { warnMs, maxMs } = this.#deps.idle!;
    const now = Date.now();
    const sql = this.#deps.ctx.storage.sql;
    // Which release time each held thing's agent was already told about
    // (idle-lease.ts): one warning per release time. Keyed by the live id from
    // `activity`, so a second thing under the same alias cannot inherit a
    // release time it was never told. The old `box_warnings` was the same table
    // under a name only a container fits, and `box_reminders` before it counted
    // escalating reminders and is no longer read.
    sql.exec(`CREATE TABLE IF NOT EXISTS held_warnings(
      alias TEXT NOT NULL, live_id TEXT NOT NULL, release_at INTEGER NOT NULL,
      PRIMARY KEY (alias, live_id))`);
    // Not carried over. Its rows say "this agent was already warned about a
    // release time", so the whole cost of dropping them is that an agent
    // holding something at the moment this deploys is told once more than it
    // needed to be — and the alternative, a copy step, keeps a table nothing
    // reads for the sake of one duplicate message.
    sql.exec("DROP TABLE IF EXISTS box_warnings");
    let wakeInMs: number | null = null;
    let releaseFailed: Array<{ alias: string; error: string }> = [];
    const soon = (ms: number) => { wakeInMs = wakeInMs === null ? ms : Math.min(wakeInMs, ms); };
    // The names the model was actually offered, read from the same list it was
    // offered them from: qualification sanitises the alias and breaks ties, so
    // a name rebuilt here would be a copy that is right only until it is not.
    const { tools } = await this.#catalogueFor(tenantId, agentId);
    const nameOf = (alias: string, tool: string) => offeredToolName(tools as MountedTool[], alias, tool);

    // A background exec does not touch lastUsedAt, so a mount running one looks
    // idle for as long as the command runs; reclaim would take the machine out
    // from under it (Piper, 2026-09-14). The job table knows; the plugin does not.
    const busy = mountsWithRunningJobs(sql, { tenantId, agentId });
    const mounts = (await this.store.listMounts(tenantId, agentId)).filter((m) => !busy.has(m.alias));
    // One entry per held thing, not per mount: a mount may hold several, each on its own schedule and
    // released on its own (`Holding.activities`), and `held_warnings` is already keyed by the thing's id.
    const held = await heldResources(mounts, this.#plugins,
      (alias) => this.#gateway.mountActivities({ tenantId, agentId, taskId: LEGACY_TASK }, alias));
    for (const h of held) {
      const row = sql.exec("SELECT release_at FROM held_warnings WHERE alias = ? AND live_id = ?", h.alias, h.live.id)
        .toArray()[0] as any;
      const warnedFor = Number(row?.release_at) || 0;
      // The thing's own schedule where it reports one: a step that loses nothing is taken without a warning,
      // and a final one can wait longer and say what it will cost (idle-lease.ts `scheduleOf`).
      const d = heldDecision(h.live, { postponedUntil: h.quietUntil ?? 0, warnedFor, now }, { warnMs, maxMs });
      if (d.do === "wait") { soon(d.wakeInMs); continue; }
      if (d.do === "warn") {
        // The warning is a turn the agent takes, so it is a message rather
        // than a signal: the model has to be able to answer it with a call.
        const mount = mounts.find((m) => m.alias === h.alias);
        const limit = Number(h.live.lease?.maxPostponeMinutes) || Number((mount?.publicConfig as any)?.maxQuietMinutes) || null;
        await this.postMessage(tenantId, agentId,
          warningText(h.alias,
            { release: nameOf(h.alias, h.tools.release), postpone: h.tools.postpone ? nameOf(h.alias, h.tools.postpone) : null },
            h.billing, d.idleMs, d.untilReleaseMs, limit,
            { consequence: h.live.lease?.consequence, advice: h.live.lease?.advice, name: h.live.name, args: h.live.args }), "prompt");
        sql.exec("INSERT INTO held_warnings(alias, live_id, release_at) VALUES (?,?,?) " +
          "ON CONFLICT(alias, live_id) DO UPDATE SET release_at = excluded.release_at", h.alias, h.live.id, d.releaseAt);
        // 0: postMessage only marks the session, so this wake is what runs the warning's turn (idle-lease.ts).
        soon(d.wakeInMs);
        continue;
      }
      // Past its release time. This mount only: each has its own idle clock,
      // so one reaching its time says nothing about another's.
      //
      // Nothing is saved first, and that is the decision rather than the gap it
      // looks like. The agent was told before this point and had two calls in
      // hand — release and postpone — so reaching here without either is a
      // choice it made on a turn it was given, not something the pass did
      // behind it. Or it was not told, because the thing reported this step as
      // one that loses nothing (`warnMs: 0`) — and then there is nothing to save. Saving on its behalf would need someone to say what: a
      // container's filesystem does not mark which files are the work, so
      // keeping something would be guessing, and a guess nobody comes back to
      // read still costs what the machine costs. Asked and answered as the
      // whole of an older task (#12); reopening it means first deciding what is
      // worth keeping, not adding a step here.
      // This thing only, by its id: another thing the same mount holds has its own clock.
      const r = await this.#gateway.releaseTask({ tenantId, agentId, taskId: LEGACY_TASK }, { alias: h.alias, reason: "idle", id: h.live.id });
      releaseFailed = [...releaseFailed, ...r.failed];
      sql.exec("DELETE FROM held_warnings WHERE alias = ? AND live_id = ?", h.alias, h.live.id);
      // A release may leave the thing held in another state with a schedule of its own (switched off, and
      // deleted much later), and nothing else would wake this object for that one. Asked again rather than
      // assumed: whether anything is still held is the plugin's answer. Not after a failure, which would
      // only come straight back here; that is reported instead, as it always was.
      if (r.failed.some((f) => f.alias === h.alias)) continue;
      const after = (await this.#gateway.mountActivities({ tenantId, agentId, taskId: LEGACY_TASK }, h.alias))
        .find((a) => a.live?.id === h.live.id)?.live;
      if (!after) continue;
      const d2 = heldDecision(after, { warnedFor: 0, now: Date.now() }, { warnMs, maxMs });
      if ("wakeInMs" in d2) soon(d2.wakeInMs);
    }
    return { wakeInMs, releaseFailed };
  }

  /**
   * This object's recorded engine (`recordedEngine`, which reads `ap_meta` and creates nothing). A recorded engine is
   * kept for this runtime: only `migrateEngine` moves it, and it forgets it. None recorded is asked again every time,
   * because a pd bench object records its engine after the object exists (cf/src/bench.ts `chooseBenchEngine`).
   */
  #engine(): "pi085" | "pd" | null {
    if (this.#recorded !== undefined) return this.#recorded;
    const engine = recordedEngine(this.#deps.ctx.storage.sql);
    if (engine !== null) this.#recorded = engine;
    return engine;
  }
  #recorded: "pi085" | "pd" | undefined;

  /** Whether this object's recorded engine is pd. */
  #isPd(): boolean {
    return this.#engine() === "pd";
  }

  /** What the worker asks for, and what it hands back. The job row says which
   *  session asked, so the answer lands in the transcript that is waiting. */
  async takeJob(tenantId: string, agentId: string, jobId: string, taker?: string) {
    await this.ready();
    const session = this.#jobSessionFor(jobId);
    const job = await (await this.agent(tenantId, agentId, session)).takeJob(jobId, taker);
    if (!job) return job;
    // The provider and model the queued call asks for, when it spends the operator's account; null leaves it
    // at the deployment's default, which is also what an agent with its own credential got before.
    const b = await this.store.getModelBinding(tenantId, agentId);
    const provider = b ? providerOfRef(b.secretRef) : null;
    return { ...job, operatorModel: provider ? b!.model : null, operatorProvider: provider };
  }

  /** A taker's failed call gives its take back (`AgentEngine.releaseJob`); false where nothing was held. */
  async releaseJob(tenantId: string, agentId: string, jobId: string, taker: string) {
    await this.ready();
    const agent = await this.agent(tenantId, agentId, this.#jobSessionFor(jobId));
    return agent.releaseJob ? await agent.releaseJob(jobId, taker) : false;
  }

  /**
   * `taker`: the attempt that called the model (`takeJob`), so a replayed delivery is metered once (`PdHost.deliver`).
   * Required, though it may be undefined, so that a caller cannot drop it by omission.
   */
  async deliverAnswer(tenantId: string, agentId: string, jobId: string, answer: unknown, taker: string | undefined) {
    await this.ready();
    const session = this.#jobSessionFor(jobId);
    return (await this.agent(tenantId, agentId, session)).deliver(jobId, answer as any, taker);
  }

  /**
   * On a `pd` object every session's jobs are in one table the shared harness answers from
   * (src/runtime/durable-agent.ts), so any session's agent takes and delivers them, and that agent
   * throws `UnknownJob` for an id with no row. Elsewhere, the `pi_model_jobs` row says which session.
   */
  #jobSessionFor(jobId: string): string {
    return this.#isPd() ? MAIN_SESSION : this.#jobSession(jobId);
  }

  /** The session whose job this is. No row means no session holds it, so the main
   *  session is not a fallback: it would find no row either and drop the call silently.
   *  An object with no jobs table holds no job either, and is asked without creating
   *  one (ensureAgentTables would also register the main session). */
  #jobSession(jobId: string): string {
    const sql = this.#deps.ctx.storage.sql;
    const hasJobs = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_model_jobs'").toArray().length > 0;
    const session = hasJobs ? jobSession(sql, jobId) : null;
    if (session === null) throw new UnknownJob(jobId);
    return session;
  }
}

/**
 * Which plugins the operator seeds for every agent, by id.
 *
 * Derived from the catalogue rather than written twice: the rows ARE the
 * decision, and a second list is a second thing to forget. This replaces
 * `defaultForAllAgents` on the plugin objects — "who should have me" was a
 * product decision living inside the plugin, kept in step with the catalogue by
 * a test. There is one source now, so there is nothing to keep in step.
 *
 * Declared after the class because it reads a static of it; exported because
 * the gateway is given it at construction (the kernel does not own the
 * operator's catalogue) and because the console renders the same answer.
 */
export const SEEDED_PLUGINS: ReadonlySet<string> = new Set(
  AgentRuntime.DEFAULT_MOUNTS.map((m) => m.plugin),
);

/**
 * The console's plugin rows, as a function of what is installed, what this
 * agent has answered, and the operator's catalogue.
 *
 * Extracted from `uiPlugins` because that method needs a live object and a
 * transcript to run, and nothing could reach this part of it: `uiPlugins`
 * appears in one file and no test mentions it, so the whole producer of the
 * catalogue payload was untested while two suites fed hand-written `installed`
 * arrays to the page. The rule from `SEEDED_PLUGINS` to the words "default for
 * all agents" had no test between its ends (@cody and @Rex traced it,
 * 2026-09-22).
 *
 * Pure on purpose: the same inputs, no I/O, so one case can compute rows from
 * the real registry and the real catalogue and hand them to the page.
 */
export function installedRows(
  installed: readonly Plugin[],
  choices: Record<string, PluginChoice>,
  seeded: ReadonlySet<string>,
) {
  return installed.map((p) => ({
    id: p.id,
    version: p.version,
    // The operator's catalogue, not a flag on the plugin: one source.
    defaultForAllAgents: seeded.has(p.id),
    choice: choices[p.id] ?? "inherit",
    // Resolved here rather than in the page, so the rule stays in the one
    // function that states it. A page that recomputes it is a second copy that
    // can disagree with what the gateway does.
    enabled: pluginEnabled(seeded.has(p.id), choices[p.id]),
    credential: p.credential ?? null,
    config: p.config ?? [],
    tools: p.tools.map((t) => ({
      name: t.name, summary: t.summary,
      sideEffects: t.sideEffects, idempotency: t.idempotency,
    })),
    // There is no mount on this page, so a plugin whose tools are each mount's
    // own has no list to show; the page says where they come from instead of
    // reporting the empty static list as "0 tools".
    toolsPerMount: !!p.mountTools,
    // A person may add a mount of it from the console (`Plugin.consoleMount`).
    addable: p.consoleMount === true,
  }));
}

