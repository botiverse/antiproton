/**
 * `/provision/*` — raft-agent-provider.v1 (agreed with Tenny, Raft, 2026-09-28 in #raft-antiproton).
 *
 * Raft creates an external agent, picks antiproton as its runtime, and calls here with the server's
 * provider token. What follows on our side is the five steps a person would do by hand — an agent
 * record, a model binding, a `raft` mount pointing at that Raft, the agent's `sk_agent` credential
 * sealed onto the mount, and push registration — run through the same RPCs and the plugin's own
 * `enable_push` tool, so there is one registration path and one audit trail. Once made, the agent
 * runs on the P1 protocol like any hand-connected one; provisioning only removes the manual setup.
 *
 * The rules that need no Worker live here, over `ProvisionDeps`, so each can go red in
 * test/provision.ts: the shape of a request, idempotency, the token's origin, what a replay is
 * allowed to do, and that the credential is sealed and never echoed. cf/src/index.ts wires the deps
 * to the token directory, the registry (both D1) and the agent's object.
 *
 * Idempotency is strict: `Idempotency-Key` is the Raft agent id, and a replay must carry the same
 * body. Same key with any field different is 409, never a quiet update — Raft edits through PATCH (and the
 * model through PUT …/model), and a delayed POST retry must not overwrite an edit that landed after it (Tenny's race).
 */
import { auditRead, auditRefused, type ReadAudit } from "../read-audit.ts";
import { RECONNECT_REASON, type OAuthStatus } from "../github-refresh.ts";
import type { ApprovalState, DecidedBy, Json } from "../../../src/core/types.ts";
import { APPROVAL_RETENTION_MS, AUDIT_RETENTION_MS, decodeCursor, encodeCursor, type ApprovalIndex, type ApprovalItem, type ProvisionDecideResult } from "../approvals.ts";
import { originProblem } from "../../../src/plugins/types.ts";
import { secretShape } from "../secret-shape.ts";
import {
  MAIN_SESSION_ID, redactCredentials, TRACE_LIMIT_DEFAULT, TRACE_LIMIT_MAX, TRACE_WINDOW_MAX_MS, TRANSCRIPT_LIMIT_DEFAULT, TRANSCRIPT_LIMIT_MAX,
  type EvalTranscript, type TraceQuery, type TraceWindow,
} from "../eval-read.ts";
import { AGENT_BUDGETS, LIVE_AGENT_STATUSES, SYSTEM_ACTOR, type AgentBudget, type ConnectionRegistry, type ConnectorRefresh, type ConnectorStore, type ProviderTokenIdentity, type ProvisionRegistry, type ProvisionedAgent } from "../control-plane.ts";
import { MAX_BUDGET_CENTS, PLANS, type BudgetWrite, type Plan, type TenantPlanStore } from "../spend-limit.ts";
import { CONNECTION_PROVIDERS, returnUrlProblem, scopesFor, type ConnectionProvider, type ReconnectTarget } from "./connect.ts";
import { surface, surfaceReadOf, type SurfaceDeps } from "../agent-surface/surface.ts";
import { logEvent } from "../../../src/core/log.ts";
import { logTurnStop, type StopTurnOutcome } from "../../../src/runtime/turn-stop.ts";
import { WORKING_SET } from "../../../src/plugins/state.ts";
import { SEED_MODES, seedPathProblem, seedText, sha256Hex as sha256Sync, type SeedFileMeta, type SeedMode, type SeedSeal, type SeedWriteResult } from "../../../src/store/seed-files.ts";
import {
  IMPORT_FILE_MAX_BYTES, IMPORT_FILES_MAX, IMPORT_TOTAL_MAX_BYTES, importDigest, type CommitResult, type ImportRecord,
} from "../../../src/store/workspace-import.ts";
import { STATE_KEY } from "../../../src/plugins/state-key.ts";
import type { FreshContextResult, RestartResult } from "../runtime.ts";
import { canonicalToolConfig, type ToolConfig } from "../../../src/core/tool-config.ts";
import type { ModelChoices, ModelLayers, TenantModelPicker } from "../control-plane.ts";
import { choiceOf, resolveModel } from "../model-request.ts";
import { optionFor, type UserModels } from "../../../src/model/user-models.ts";
import type { ModelChoice } from "../../../src/model/providers.ts";
import { onboardingPool, tenantUsage, type ProvisionUsage } from "./usage.ts";
import type { FirstTurn } from "../../../src/runtime/prewarm.ts";
import { AGENT_PROFILES, isAgentProfile, type AgentProfile } from "../../../src/runtime/agent-profile.ts";

export type ProvisionTool = "enable_push" | "disable_push";

/** What the mount says about its push registration, read from its state — not a tool call. */
export interface PushStatus { enabled: boolean; registration: "active" | "uncertain" | null; lastReached: { deliveryId: string; at: string } | null }

/** What the handler asks of the agent's own object. Each is one RPC in cf/src/index.ts. */
export interface ProvisionAgentOps {
  /**
   * Create or update the record (persona), bind the model, make sure the `raft` mount points at `raftOrigin`.
   * `toolConfig` is what a POST asked of the agent's tools (null: nothing, today's agent); absent on a PATCH, which
   * says nothing about them. A Fail is the agent's refusal of it (cf/src/provision/steps.ts): another one recorded
   * already (409), or one this deployment cannot give (400). Nothing is written when it refuses.
   */
  adopt(tenantId: string, agentId: string, spec: { name: string; instructions: string; raftOrigin: string; toolConfig?: ToolConfig | null; awaitImport?: boolean; firstTurn?: FirstTurn | null; profile?: AgentProfile | null }): Promise<void | Fail>;
  /** Seal the credential onto the `raft` mount; the plugin checks it against Raft. */
  attachCredential(tenantId: string, agentId: string, credential: string): Promise<{ ok: true; account: string | null } | { ok: false; error: string }>;
  removeCredential(tenantId: string, agentId: string): Promise<boolean>;
  /** Run one of the raft plugin's push tools through the gateway, as the model would. */
  tool(tenantId: string, agentId: string, name: ProvisionTool): Promise<{ ok: true; result: Json } | { ok: false; error: string }>;
  /**
   * The mount's push state, read directly. A GET used to run `push_status` through the gateway, and
   * every Raft poll became a tool.call trace row, a usage row and two Agent Activity events the model
   * never caused.
   */
  pushStatus(tenantId: string, agentId: string): Promise<PushStatus | null>;
  /**
   * End the agent's running turn (cf/src/runtime.ts `stopTurn`): `provider_stop` for the stop route, `delete` for a
   * delete, which also keeps the agent from taking another step. Never throws for a turn it could not end: that is
   * `failed`, with why. Optional: a deployment without it answers the stop route 404 and deletes without a stop.
   */
  stopTurn?(tenantId: string, agentId: string, trigger: "provider_stop" | "delete"): Promise<StopTurnResult>;
  /**
   * For a delete, after the stop: the agent's far-end registrations taken back (a sandbox's egress credentials) and
   * its held things let go (`AgentRuntime.releaseForDelete`).
   */
  releaseForDelete?(tenantId: string, agentId: string): Promise<{
    things: Array<{ alias: string; id: string; clean: boolean; via?: "withdrawn" | "deleted"; why?: string; review?: string }>;
    released: string[];
    failed: Array<{ alias: string; stage: "withdraw" | "release"; error: string }>;
  }>;
}

/** What ending an agent's turn did (src/runtime/turn-stop.ts). */
export type StopTurnResult = StopTurnOutcome;

/**
 * The tenant a request acts in. A tenant-scoped token is one tenant. A platform-scoped token (one key
 * for a whole Raft deployment, tygg 2026-09-28) derives it from the Raft server the request names —
 * the POST body's raftServerId, `?raftServerId=` on every other route — so isolation and billing
 * follow the server while Raft holds a single key. A tenant exists by being named: nothing to create.
 * `from` is where this route reads it, so the refusal names the one place that would have worked.
 */
export function tenantFor(who: ProviderTokenIdentity, raftServerId: string | null, from: "body" | "query" = "query"): string | Fail {
  if (who.scope === "tenant") return who.tenantId;
  if (!raftServerId || !RAFT_ID.test(raftServerId)) {
    const where = from === "body" ? "raftServerId in the body" : "?raftServerId= on the URL";
    return { status: 422, code: "missing", message: `a platform token needs the Raft server: ${where}`, param: "raftServerId" };
  }
  return derivedTenant(raftServerId);
}

/**
 * A server id as the tenant it names: `raft_<id>` where the id needs no help, and `raft_<readable>_<digest>`
 * where it does.
 *
 * The tenant is a per-server namespace — `provisioned_agents` is keyed on `(tenant_id, raft_agent_id)`, and
 * the routes reach a row by the tenant the request's server derives — so two servers that derive one tenant
 * share agents, quota and billing. Two spellings used to collide:
 *
 *  - ``:`` is legal in a Raft id (`RAFT_ID`) and not in an object name, and the substitution that made it legal
 *    sent `srv:prod` and `srv_prod` to one tenant;
 *  - `raft_` plus a 64-character id is 69 characters, and cutting it to an object name's 64 kept only the id's
 *    first 59, so every server with those 59 in common derived one tenant.
 *
 * So a substitution or a cut is never the whole name: an id that needs one carries a digest of its exact
 * spelling, which is what makes the tenant that server's alone. The readable part is for whoever reads a log or
 * a D1 row. An id that is already safe is spelled exactly as before, so rows written earlier read back
 * unchanged. (`providerAgentId` below has the same two spellings, and a clash there is refused as
 * `agent_id_taken` at create; here a clash is silent cross-tenant addressing, which is why only this one
 * changes.)
 */
export function derivedTenant(raftServerId: string): string {
  if (TENANT_SAFE.test(raftServerId) && !DIGEST_TAIL.test(raftServerId)) return `raft_${raftServerId}`;
  // 5 + 46 + 1 + 12 = an object name's 64. The digest is of the id as sent, before any substitution.
  const readable = raftServerId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 46);
  return `raft_${readable}_${sha256Sync(raftServerId).slice(0, 12)}`;
}

/** A server id a tenant can be named after as it is: `raft_` and an object name's 64 characters leave 59. */
const TENANT_SAFE = /^[A-Za-z0-9._-]{1,59}$/;

/**
 * How a derived-with-digest name ends. Such an id takes the digest branch, so the two shapes stay apart: a
 * plain `raft_<id>` never reads as another server's `raft_<readable>_<digest>`, whichever ids the two servers
 * were given.
 */
const DIGEST_TAIL = /_[0-9a-f]{12}$/;

/**
 * The model routes' sources (`/provision/models`, `…/model`): the deployment's options (USER_MODELS), its default
 * (HARNESS_MODEL), the stored choices and the admin's rows read through one `layers` (cf/src/control-plane.ts
 * d1ModelChoices), and the agent's object asked to bind what is chosen now (AgentDO.rebindModel). A pick made here is
 * the owner's pick — the same row the console's picker (cf/src/agent-model.ts) and the Agents API's `model` write — so
 * all three read one value, and resolveModel (cf/src/model-request.ts) decides it against the admin's rows for each.
 */
export interface ProvisionModels {
  userModels: UserModels;
  defaultModel: string;
  choices: ModelChoices;
  rebind(tenantId: string, agentId: string): Promise<void>;
  /**
   * Whether the tenant may pick a model other than the default here (`PUT /servers/:raftServerId/model-picker`). Off
   * unless Raft turned it on: a provider pick of another model is then refused (`pickerProblem`), and the default is
   * taken without storing a pick. Required, so a deployment wiring the model routes cannot leave the gate out.
   */
  picker: TenantModelPicker;
  /**
   * Whether the switch above is applied (MODEL_PICKER_ENFORCE "1"; cf/src/index.ts `modelPickerEnforced`). False: the
   * switch is still stored and read back, but no pick is refused or rewritten for it, so model choice is what it was
   * before the switch existed. Off until Raft sets every server's switch: until then a server with no row reads as
   * off, and enforcing would refuse picks Raft allows today.
   */
  enforcePicker: boolean;
}

export interface ProvisionDeps {
  now(): number;
  registry: ProvisionRegistry;
  agent: ProvisionAgentOps;
  /** Connecting the agent to other services (connect.ts). Absent: the routes answer 404, as before. */
  connections?: {
    registry: Pick<ConnectionRegistry, "get" | "put" | "remove" | "boundTo">;
    /** The tenant's connectors (0012): each connection is one, shared by the agents pointed at it. */
    connectors: ConnectorStore;
    newId(): string;
    /** Put a connector's sealed credential on the agent's one mount of the provider's plugin, with what renews it (0023). */
    attach(tenantId: string, agentId: string, provider: ConnectionProvider, sealed: { ciphertext: string; iv: string },
      refresh?: (ConnectorRefresh & { connectorId: string | null }) | null):
      Promise<{ ok: true; account: string | null } | { ok: false; error: string }>;
    /** The one-time link the browser opens; signed, ten minutes. `reconnect` is signed into it (connect.ts). */
    link(spec: { tenantId: string; agentId: string; raftAgentId: string; provider: ConnectionProvider; returnUrl: string; raftUserId: string; scopes: string[];
      reconnect?: ReconnectTarget }): Promise<{ url: string; expiresAt: string }>;
    /** A connector was reconnected in place: its new pair onto this agent's mount, if the mount is still the connector's (`was`: its previous token). */
    reconnect(tenantId: string, agentId: string, provider: ConnectionProvider, connectorId: string, was: { ciphertext: string; iv: string },
      sealed: { ciphertext: string; iv: string }, refresh: ConnectorRefresh | null): Promise<{ ok: true; updated: boolean } | { ok: false; error: string }>;
    /** Remove it only while the mount still holds this connector's credential, not a key put there since. */
    detachIfFrom(tenantId: string, agentId: string, provider: ConnectionProvider, sealed: { ciphertext: string; iv: string }, connectorId?: string | null):
      Promise<{ ok: true; removed: boolean; other?: true } | { ok: false; error: string; gone?: true }>;
    /** Remove the provider's credential from the agent's mount. */
    detach(tenantId: string, agentId: string, provider: ConnectionProvider): Promise<boolean>;
    /** The same, for an agent's delete, telling nothing to clear from a refusal (`AgentRuntime.clearConnection`). */
    clear(tenantId: string, agentId: string, provider: ConnectionProvider): Promise<{ ok: true; cleared: boolean } | { ok: false; error: string; gone?: true }>;
    /** Make a held connection the mount's credential, for the Raft user it was held for (connect.ts), as connector `connectorId`. */
    confirm(tenantId: string, agentId: string, provider: ConnectionProvider, pending: string, raftUserId: string, connectorId?: string):
      Promise<{ ok: true; account: string | null; accountId?: string | null; sealed: { ciphertext: string; iv: string }; refresh?: ConnectorRefresh | null;
        /** Present for a reconnect in place: the hold was not attached, and the handler decides (`reconnectInPlace`). */
        reconnect?: ReconnectTarget | null }
        | { ok: false; error: string; missing?: true }>;
  };
  /**
   * An agent's usage and workspace, read through the same core the public API uses
   * (cf/src/agent-surface/). Absent: those routes answer 404.
   */
  surface?: SurfaceDeps;
  /** The model routes (`modelRoute`). Absent: they answer 404, as on a deployment that never had them. */
  models?: ProvisionModels;
  /** The tenant's spend and daily limit (`GET /usage`, ./usage.ts). Absent: it answers 404. */
  usage?: ProvisionUsage;
  /**
   * An evaluation's setup, in the agent's own object (cf/src/index.ts, behind EVAL_SEED_ROUTES). Absent: every
   * route of it answers 404, as on a deployment that never had them.
   */
  seed?: SeedOps;
  /**
   * A migrating agent's workspace, written once in the agent's own object (`POST …/import`). Production: not behind
   * EVAL_SEED_ROUTES. Absent: the route answers 404, as on a deployment that never had it.
   */
  imports?: ImportOps;
  /**
   * The Raft server's plan and daily budgets (`plan`, `dailyBudgetCents`, `onboardingDailyBudgetCents` on POST and
   * `PUT /servers/:raftServerId/plan`), which set the tenant's daily limits (cf/src/spend-limit.ts). Absent: the route
   * answers 404, and a POST naming a plan is refused (503) rather than made without storing it.
   */
  plans?: Pick<TenantPlanStore, "set">;
  /** Where the eval exports' reads are audited (cf/src/read-audit.ts). Absent: not recorded, and an assistant's are refused anyway. */
  readAudit?: ReadAudit;
  /** Held calls (docs/raft-approvals.md): each agent's, from its object, and the provider-wide copy. Absent: the routes answer 404. */
  approvals?: ProvisionApprovals;
}

/** What the approval routes act through (cf/src/index.ts): the agent's object for its own holds, D1 for every agent's. */
export interface ProvisionApprovals {
  list(tenantId: string, agentId: string, ids: { raftAgentId: string; raftServerId: string }, status: ApprovalState | null): Promise<ApprovalItem[] | null>;
  decide(tenantId: string, agentId: string, ids: { raftAgentId: string; raftServerId: string }, operationId: string,
    decision: "approved" | "denied", decidedBy: Extract<DecidedBy, { via: "raft" }>): Promise<ProvisionDecideResult | null>;
  index: ApprovalIndex;
}

/** What the import route asks of the agent's object; each is one RPC (cf/src/index.ts AgentDO). */
export interface ImportOps {
  commit(tenantId: string, agentId: string, imp: { migrationId: string; digest: string; instructions: boolean; files: ImportFile[] }):
    Promise<CommitResult | { ok: false; code: "not_found"; message: string }>;
  instructionsApplied(tenantId: string, agentId: string, migrationId: string): Promise<void>;
}

/** What the setup routes ask of the agent's object; each is one RPC (cf/src/index.ts AgentDO). */
export interface SeedOps {
  write(tenantId: string, agentId: string, file: { path: string; mode: SeedMode; text: string }):
    Promise<SeedWriteResult | { ok: false; code: "not_found"; message: string }>;
  seal(tenantId: string, agentId: string, credentialId: string | null): Promise<SeedSeal | null>;
  manifest(tenantId: string, agentId: string): Promise<{ manifest: SeedFileMeta[]; toolConfig: ToolConfig | null; manifestSha256: string; seal: SeedSeal | null } | null>;
  freshContext(tenantId: string, agentId: string): Promise<FreshContextResult>;
  restart(tenantId: string, agentId: string): Promise<RestartResult>;
  modelInput(tenantId: string, agentId: string, session: string | null, call: number | null): Promise<unknown | null>;
  /** The tools the agent's next turn offers the model, read without retaking or writing anything. */
  tools(tenantId: string, agentId: string): Promise<unknown | null>;
  /**
   * One page of a main conversation, as /admin/transcript reads it, redacted in the agent's object (cf/src/eval-read.ts
   * `evalTranscript`); null: no such agent or conversation; `unavailable`: its sealed values could not be opened to scrub.
   */
  transcript(tenantId: string, agentId: string, session: string | null, offset: number, limit: number): Promise<unknown | null>;
  /** The agent's trace rows in a window (cf/src/eval-read.ts `readTraceWindow`). */
  trace(tenantId: string, agentId: string, q: TraceQuery): Promise<TraceWindow>;
  /**
   * The catalogue aliases a provisioned agent may be given by name (`mounts` on POST): the deployment catalogue's
   * entries for an agent Raft hosts (`AgentRuntime.DEFAULT_MOUNTS`, cf/src/runtime.ts). Asked here so a name is refused
   * before anything is made; the agent's object asks again of its own plugins (whether each can run here).
   */
  mountable: readonly string[];
}

/** The alias provisioning always mounts (cf/src/provision/steps.ts `PROVISION_MOUNT_ALIAS`), so never one to name. */
const RAFT_ALIAS = "raft";

/**
 * `mounts` and `harness` of a POST: an evaluation's choice of the agent's tools (docs/agent-surface.md "Evaluation
 * setup (preview only)"). Null when neither is sent, which is today's agent exactly. Only where the setup routes are
 * served (`seed` present, EVAL_SEED_ROUTES): anywhere else either field is a 400 naming it, never ignored, because an
 * evaluation that asked for a minimal agent and was quietly given the default one would measure the wrong agent.
 */
export function toolConfigField(body: unknown, seed: Pick<SeedOps, "mountable"> | undefined): ToolConfig | null | Fail {
  const mounts = field(body, "mounts"), harness = field(body, "harness");
  if (mounts === undefined && harness === undefined) return null;
  if (!seed) {
    const named = mounts !== undefined ? "mounts" : "harness";
    return { status: 400, code: "eval_only", param: named,
      message: `${named} is accepted only where the evaluation setup routes are served (EVAL_SEED_ROUTES), and this deployment does not serve them` };
  }
  let list: string[] | null = null;
  if (mounts !== undefined) {
    if (!Array.isArray(mounts)) return { status: 400, code: "invalid", param: "mounts", message: "mounts is an array of the default catalogue's aliases" };
    const seen = new Set<string>();
    for (const m of mounts) {
      if (typeof m !== "string") return { status: 400, code: "invalid", param: "mounts", message: `mounts entry ${JSON.stringify(m)} is not a string` };
      if (m === RAFT_ALIAS) return { status: 400, code: "invalid", param: "mounts", message: `mounts entry "${RAFT_ALIAS}" is always added by provisioning; leave it out` };
      if (seen.has(m)) return { status: 400, code: "invalid", param: "mounts", message: `mounts entry "${m}" is named twice` };
      if (!seed.mountable.includes(m)) {
        return { status: 400, code: "unknown_mount", param: "mounts", message: `mounts entry "${m}" is not a default mount here; one of ${seed.mountable.join(", ")}` };
      }
      seen.add(m);
    }
    list = [...mounts] as string[];
  }
  if (harness !== undefined && harness !== "minimal") {
    return { status: 400, code: "invalid", param: "harness", message: `harness ${JSON.stringify(harness)} is not one this deployment offers; the one value is "minimal" (omit it for the default)` };
  }
  // Canonical from here on (sorted): the record, a replay's comparison and the manifest hash all see one form, so the
  // order a caller listed the mounts in can neither change a sealed agent's published toolConfig nor its hash.
  return canonicalToolConfig({ mounts: list, harness: harness === "minimal" ? "minimal" : "default" });
}

export const PROVIDER_AGENT_PREFIX = "raft_";
const NAME_MAX = 60;
/** `instructions` everywhere but an evaluation deployment: characters, as `String.length` counts them. */
const INSTRUCTIONS_MAX = 8_000;
/**
 * `instructions` where the evaluation setup routes are served (`seed` present, EVAL_SEED_ROUTES): 64 KiB, counted in
 * UTF-8 bytes rather than characters, so a persona in CJK or emoji meets the same bound as one in ASCII. Not a
 * `…Bytes` name on purpose: those count UTF-16 code units (AGENTS.md), and this one does not. Over it is refused,
 * never cut: an evaluation measuring an agent given part of its instructions would measure the wrong agent.
 */
export const EVAL_INSTRUCTIONS_MAX_UTF8 = 65_536;
type Limit = { max: number; unit: "characters" | "UTF-8 bytes" };
const instructionsLimit = (seed: SeedOps | undefined): Limit =>
  seed ? { max: EVAL_INSTRUCTIONS_MAX_UTF8, unit: "UTF-8 bytes" } : { max: INSTRUCTIONS_MAX, unit: "characters" };
const sizeIn = (v: string, unit: Limit["unit"]) => unit === "characters" ? v.length : new TextEncoder().encode(v).byteLength;
const RAFT_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** The plugin's own reading of its credential (src/plugins/raft.ts looksLike). */
const RAFT_CREDENTIAL = /^sk_agent_[A-Za-z0-9_-]{16,}$/;

/**
 * The antiproton agent a Raft agent is, from its id alone: deterministic, so a replay lands on the
 * same object without a lookup, and legal for an object name (cf/src/object-name.ts).
 */
export function providerAgentId(raftAgentId: string): string {
  return (PROVIDER_AGENT_PREFIX + raftAgentId.replace(/[^A-Za-z0-9._-]/g, "_")).slice(0, 64);
}

export type Fail = { status: number; code: string; message: string; param?: string };
const fail = (f: Fail & { rejected?: ImportRejection[]; more?: number }) => Response.json({ error: {
  code: f.code, message: f.message, ...(f.param ? { param: f.param } : {}),
  ...(f.rejected ? { rejected: f.rejected, more: f.more ?? 0 } : {}),
} }, { status: f.status, headers: { "cache-control": "no-store" } });
const ok = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

const field = (body: unknown, key: string): unknown => (typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined);

/** A text field within bounds, and not a credential someone pasted where a name goes. */
function textField(body: unknown, key: string, limit: number | Limit, required: boolean): string | undefined | Fail {
  const { max, unit } = typeof limit === "number" ? { max: limit, unit: "characters" as const } : limit;
  const v = field(body, key);
  if (v === undefined) return required ? { status: 422, code: "missing", message: `${key} is required`, param: key } : undefined;
  if (typeof v !== "string") return { status: 422, code: "invalid", message: `${key} must be a string`, param: key };
  if (required && !v.trim()) return { status: 422, code: "invalid", message: `${key} must not be empty`, param: key };
  const size = sizeIn(v, unit);
  if (size > max) return { status: 422, code: "invalid", message: `${key} is at most ${max} ${unit}; this one is ${size}`, param: key };
  const shape = secretShape(v);
  if (shape) return { status: 422, code: "credential_in_text", message: `${key} carries what looks like a ${shape}; credentials go in the credential field only`, param: key };
  return v;
}
const isFail = (v: unknown): v is Fail => typeof v === "object" && v !== null && "status" in v && "code" in v;

/** Hex SHA-256, the same function the API keys and tokens use for what is stored of a secret. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * `firstTurn` of a POST: absent or null is none; otherwise exactly `{ "reasoning": "off" }`, the one value there is.
 * Anything else is refused naming the field, never read as the nearest value, so a caller asking for something this
 * deployment does not do learns so.
 */
export function firstTurnField(body: unknown): FirstTurn | null | Fail {
  const v = field(body, "firstTurn");
  if (v === undefined || v === null) return null;
  const keys = typeof v === "object" && !Array.isArray(v) ? Object.keys(v as object) : null;
  if (!keys || keys.length !== 1 || (v as Record<string, unknown>).reasoning !== "off") {
    return { status: 422, code: "invalid", param: "firstTurn", message: 'firstTurn is { "reasoning": "off" } or absent' };
  }
  return { reasoning: "off" };
}

/**
 * `budget` of a POST: absent or null is the tenant's own; otherwise one of `AGENT_BUDGETS` ("onboarding": the
 * platform-paid onboarding pool, cf/src/spend-limit.ts). An identity for billing, fixed at creation, so anything
 * else is refused naming the field rather than read as the tenant's.
 */
export function budgetField(body: unknown): AgentBudget | null | Fail {
  const v = field(body, "budget");
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !(AGENT_BUDGETS as readonly string[]).includes(v)) {
    return { status: 422, code: "invalid", param: "budget", message: `budget is ${AGENT_BUDGETS.map((b) => `"${b}"`).join(" or ")}, or absent` };
  }
  return v as AgentBudget;
}

/**
 * `profile` of a POST (src/runtime/agent-profile.ts): absent or null is today's agent; any value but a profile this
 * deployment knows is refused. A profile decides the agent's tools, so it does not combine with an evaluation's
 * `mounts` or `harness`.
 */
export function profileField(body: unknown): AgentProfile | null | Fail {
  const v = field(body, "profile");
  if (v === undefined || v === null) return null;
  if (!isAgentProfile(v)) {
    return { status: 400, code: "invalid", param: "profile", message: `profile is ${Object.keys(AGENT_PROFILES).map((p) => `"${p}"`).join(" or ")}, or absent` };
  }
  for (const named of ["mounts", "harness"]) {
    if (field(body, named) !== undefined) {
      return { status: 400, code: "invalid", param: named, message: `profile ${JSON.stringify(v)} decides this agent's tools; leave ${named} out` };
    }
  }
  return v;
}

/** `plan` of a POST or a plan PUT: one of `PLANS`, exactly; absent (null on POST) is none said. */
export function planField(body: unknown, required: boolean): Plan | null | Fail {
  const v = field(body, "plan");
  if (!required && (v === undefined || v === null)) return null;
  if (typeof v !== "string" || !(PLANS as readonly string[]).includes(v)) {
    return { status: 422, code: v === undefined ? "missing" : "invalid", param: "plan", message: `plan is ${PLANS.map((p) => `"${p}"`).join(" or ")}` };
  }
  return v as Plan;
}

/** The budget fields Raft sends beside `plan`, in whole US cents a day. */
export const BUDGET_FIELDS = ["dailyBudgetCents", "onboardingDailyBudgetCents"] as const;

/**
 * `dailyBudgetCents` / `onboardingDailyBudgetCents` of a POST or a plan PUT: absent is "not sent" (undefined: what is
 * stored is kept), `null` clears a value sent before (the plan's mapping or the default applies again), otherwise a whole
 * number of cents from 0 to `MAX_BUDGET_CENTS`. Money is never read from a float or a string: `5.5`, `"500"` and `1e9`
 * are refused naming the field.
 */
export function budgetCentsFields(body: unknown): BudgetWrite | Fail {
  const out: BudgetWrite = {};
  for (const key of BUDGET_FIELDS) {
    const v = field(body, key);
    if (v === undefined) continue;
    if (v !== null && !(typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= MAX_BUDGET_CENTS)) {
      return { status: 422, code: "invalid", param: key, message: `${key} is a whole number of US cents a day from 0 to ${MAX_BUDGET_CENTS}, null to clear it, or absent to keep it` };
    }
    out[key] = v;
  }
  return out;
}
const budgetsSent = (b: BudgetWrite) => BUDGET_FIELDS.some((k) => b[k] !== undefined);

function credentialField(body: unknown): string | Fail {
  const v = field(body, "credential");
  if (typeof v !== "string" || !v) return { status: 422, code: "missing", message: "credential is required", param: "credential" };
  if (!RAFT_CREDENTIAL.test(v)) return { status: 422, code: "invalid", message: "credential is not a Raft agent credential", param: "credential" };
  return v;
}

/**
 * The tenant a route addressed by a Raft server acts in (`PUT /servers/:raftServerId/…`). A tenant-scoped token names
 * no server, so the path's is taken only when the tenant's own agents were made for it: a setting is said of one
 * server, and must not land on a tenant that is another server's (or answer as if it had).
 */
async function serverTenant(who: ProviderTokenIdentity, raftServerId: string, registry: ProvisionRegistry, what: string): Promise<string | Fail> {
  if (!RAFT_ID.test(raftServerId)) return { status: 422, code: "invalid", param: "raftServerId", message: `the Raft server id must match ${RAFT_ID}` };
  const tenant = tenantFor(who, raftServerId);
  if (isFail(tenant)) return tenant;
  if (who.scope === "tenant" && !(await registry.hasServer?.(tenant, raftServerId))) {
    return { status: 403, code: "server_mismatch", param: "raftServerId",
      message: `this token's tenant has no agent provisioned for Raft server ${raftServerId}; ${what} is set for the server the token belongs to` };
  }
  return tenant;
}

/** What Raft sees of a row. The credential has no field here to be in. */
function view(row: ProvisionedAgent, live?: Json) {
  return {
    providerAgentId: row.agentId,
    raftAgentId: row.raftAgentId,
    raftServerId: row.raftServerId,
    raftOrigin: row.raftOrigin,
    name: row.name,
    instructions: row.instructions,
    status: row.status,
    push: { registered: row.pushRegistered, ...(row.pushError ? { error: row.pushError } : {}), ...(live !== undefined ? { live } : {}) },
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
    deletedAt: row.deletedAt === null ? null : new Date(row.deletedAt).toISOString(),
    ...(row.budget ? { budget: row.budget } : {}),
    ...(row.profile ? { profile: row.profile } : {}),
    /** The services Raft may offer a Connect button for (connections/:provider). */
    connections: [...CONNECTION_PROVIDERS],
  };
}

/**
 * Register push again for an agent that already exists: the operator's repair for a mount whose push
 * record is gone while Raft still points at the old hook. The same tool as at creation, so there is
 * one registration path; the row's `registered` follows the result the same way. Raft need do
 * nothing — the plugin rebuilds the hook and re-registers it with the agent's own credential, and
 * Raft replaces the old URL and secret.
 */
export async function repairPush(
  deps: ProvisionDeps, tenantId: string, raftAgentId: string,
): Promise<{ ok: true; push: ProvisionedAgent["pushRegistered"]; error: string | null } | { ok: false; error: string }> {
  const row = await deps.registry.get(tenantId, raftAgentId);
  if (!row || row.deletedAt !== null) return { ok: false, error: `no live provisioned agent ${raftAgentId} in tenant ${tenantId}` };
  const after = await registerPush(deps, row);
  return { ok: true, push: after.pushRegistered, error: after.pushError };
}

/** Register push through the plugin's own tool and write what happened; the row says `registered` only when it is. */
async function registerPush(deps: ProvisionDeps, row: ProvisionedAgent): Promise<ProvisionedAgent> {
  const push = await deps.agent.tool(row.tenantId, row.agentId, "enable_push");
  const patch = { status: "active" as const, pushRegistered: push.ok, pushError: push.ok ? null : push.error };
  await deps.registry.update(row.tenantId, row.raftAgentId, patch);
  return { ...row, ...patch, updatedAt: deps.now() };
}

/**
 * A stop as the object answered it, or `failed` when the object could not be asked; either way it is logged here, as
 * well as by the object. The platform can drop all of a Durable Object invocation's logs when it overlaps another
 * invocation of the same object, which a stop does whenever it waits on a tool call in flight, so the object's own
 * `turn.stop` line is not enough: the stop is recorded here, where the request is answered.
 */
async function stopTurnOf(stop: NonNullable<ProvisionAgentOps["stopTurn"]>, tenantId: string, agentId: string, trigger: "provider_stop" | "delete"): Promise<StopTurnResult> {
  let out: StopTurnResult;
  try { out = await stop(tenantId, agentId, trigger); }
  catch (e) { out = { result: "failed", error: String((e as Error)?.message ?? e).slice(0, 200) }; }
  logTurnStop({ tenantId, agentId, trigger, side: "worker" }, out);
  return out;
}

const APPROVAL_STATES: readonly ApprovalState[] = ["pending", "approved", "executed", "failed", "denied", "expired"];
/** Who Raft let decide: the agent's owner, or, once the owner has left the server, its owner or an admin. */
const DECIDER_ROLES = ["agent_owner", "server_owner", "server_admin"] as const;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const APPROVALS_PAGE_DEFAULT = 50, APPROVALS_PAGE_MAX = 200;

/** `?status=`: one state, or absent (or `any`) for every state. */
function statusParam(query: URLSearchParams): ApprovalState | null | Fail {
  const v = query.get("status");
  if (v === null || v === "" || v === "any") return null;
  if (!(APPROVAL_STATES as readonly string[]).includes(v)) {
    return { status: 400, code: "invalid", param: "status", message: `status is one of ${APPROVAL_STATES.join(", ")}, or any` };
  }
  return v as ApprovalState;
}

/** `GET /agents/{id}/approvals`: the agent's held calls, newest last, read from its own object. */
async function agentApprovals(tenantId: string, row: ProvisionedAgent, query: URLSearchParams, a: ProvisionApprovals): Promise<Response> {
  const status = statusParam(query);
  if (isFail(status)) return fail(status);
  const items = await a.list(tenantId, row.agentId, { raftAgentId: row.raftAgentId, raftServerId: row.raftServerId }, status);
  if (items === null) return fail({ status: 404, code: "not_found", message: `no provisioned agent ${row.agentId}` });
  return ok({ providerAgentId: row.agentId, raftAgentId: row.raftAgentId, approvals: items });
}

/**
 * `POST /agents/{id}/approvals/{operationId}/decide`. Raft has checked, on its own server, that `decidedBy` may decide
 * for this agent; the provider token is what antiproton trusts, and `decidedBy` is recorded and logged as said.
 */
async function decideApproval(tenantId: string, row: ProvisionedAgent, operationId: string, body: unknown, credentialId: string | null,
  a: ProvisionApprovals): Promise<Response> {
  if (!OPERATION_ID.test(operationId)) return fail({ status: 404, code: "approval_not_found", message: `no held call ${operationId.slice(0, 128)}` });
  const shape = 'the body is { "decision": "approve" | "deny", "decidedBy": { "raftUserId": string, "role": "agent_owner" | "server_owner" | "server_admin" } }';
  const b = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (!b) return fail({ status: 422, code: "invalid", message: shape });
  const extra = Object.keys(b).find((k) => k !== "decision" && k !== "decidedBy");
  if (extra) return fail({ status: 422, code: "invalid", param: extra, message: `unknown field ${extra}; ${shape}` });
  if (b.decision !== "approve" && b.decision !== "deny") {
    return fail({ status: 422, code: b.decision === undefined ? "missing" : "invalid", param: "decision", message: shape });
  }
  const by = typeof b.decidedBy === "object" && b.decidedBy !== null && !Array.isArray(b.decidedBy) ? b.decidedBy as Record<string, unknown> : null;
  const byExtra = by ? Object.keys(by).find((k) => k !== "raftUserId" && k !== "role") : undefined;
  if (!by || byExtra || typeof by.raftUserId !== "string" || !RAFT_ID.test(by.raftUserId)) {
    return fail({ status: 422, code: b.decidedBy === undefined ? "missing" : "invalid", param: byExtra ? `decidedBy.${byExtra}` : "decidedBy", message: shape });
  }
  // A role this contract does not name is refused, never read as the nearest one: it is the grounds of the decision.
  if (typeof by.role !== "string" || !(DECIDER_ROLES as readonly string[]).includes(by.role)) {
    return fail({ status: 400, code: "invalid_role", param: "decidedBy.role", message: `decidedBy.role is one of ${DECIDER_ROLES.join(", ")}` });
  }
  const decision = b.decision === "approve" ? "approved" as const : "denied" as const;
  const decidedBy = { via: "raft" as const, raftUserId: by.raftUserId, role: by.role as (typeof DECIDER_ROLES)[number] };
  const r = await a.decide(tenantId, row.agentId, { raftAgentId: row.raftAgentId, raftServerId: row.raftServerId }, operationId, decision, decidedBy);
  // The audit line: who Raft said decided, on whose token, and what came of it.
  logEvent("provision.approval_decide", {
    tenantId, agentId: row.agentId, raftAgentId: row.raftAgentId, operationId, decision, raftUserId: decidedBy.raftUserId, role: decidedBy.role,
    credentialId, outcome: r === null ? "no_agent" : r.ok ? (r.replay ? "replay" : "decided") : r.code,
  });
  if (r === null) return fail({ status: 404, code: "not_found", message: `no provisioned agent ${row.agentId}` });
  // Answered before an approved call runs: `approval.status` is `approved` until the run ends it (`executed`/`failed`).
  if (r.ok) return ok({ approval: r.item, replay: r.replay });
  if (r.code === "approval_not_found") return fail({ status: 404, code: r.code, message: `no held call ${operationId} for ${row.agentId}` });
  const item = r.item;
  const message = r.code === "approval_expired"
    ? "nobody decided this held call before it expired; it was denied as expired and nothing was run"
    : `this held call was already decided: ${item?.status ?? "decided"}`;
  // `decision` is what was decided (an approval is "approved" whether its run is under way or ended), `status` where it is now.
  const decided = item ? (item.status === "executed" || item.status === "failed" ? "approved" : item.status) : null;
  return Response.json({ error: {
    code: r.code, message,
    ...(item ? { decision: decided, status: item.status, decidedBy: item.decidedBy, decidedAt: item.decidedAt } : {}),
  }, ...(item ? { approval: item } : {}) }, { status: 409, headers: { "cache-control": "no-store" } });
}

/**
 * `GET /approvals`: every held call of the provider's agents, oldest change first, from D1's copy (migration 0028).
 * A tenant token reads its tenant; a platform token every tenant made at its origin, or one server's with
 * `?raftServerId=`. `updatedSince` (ISO time or ms) and `status` narrow it; `cursor` continues a page.
 */
async function providerApprovals(who: ProviderTokenIdentity, raftServerId: string | null, query: URLSearchParams, index: ApprovalIndex): Promise<Response> {
  let tenantId: string | null;
  if (who.scope === "tenant") tenantId = who.tenantId;
  else if (raftServerId === null || raftServerId === "") tenantId = null;
  else {
    const t = tenantFor(who, raftServerId);
    if (isFail(t)) return fail(t);
    tenantId = t;
  }
  const status = statusParam(query);
  if (isFail(status)) return fail(status);
  const sinceRaw = query.get("updatedSince");
  let updatedSince: number | null = null;
  if (sinceRaw !== null && sinceRaw !== "") {
    updatedSince = /^\d{1,16}$/.test(sinceRaw) ? Number(sinceRaw) : Date.parse(sinceRaw);
    if (!Number.isFinite(updatedSince)) return fail({ status: 400, code: "invalid", param: "updatedSince", message: "updatedSince is an ISO 8601 time or milliseconds since the epoch" });
  }
  const limitRaw = query.get("limit");
  const limit = limitRaw === null || limitRaw === "" ? APPROVALS_PAGE_DEFAULT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > APPROVALS_PAGE_MAX) {
    return fail({ status: 400, code: "invalid", param: "limit", message: `limit is a whole number from 1 to ${APPROVALS_PAGE_MAX}` });
  }
  const cursorRaw = query.get("cursor");
  const after = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !after) return fail({ status: 400, code: "invalid", param: "cursor", message: "cursor is one a previous page answered, as it was answered" });
  // Dropped here, before the read: a live agent's ended holds APPROVAL_RETENTION_MS after their last change, a deleted
  // agent's kept holds AUDIT_RETENTION_MS after its delete.
  const now = Date.now();
  await index.prune({ ended: now - APPROVAL_RETENTION_MS, deleted: now - AUDIT_RETENTION_MS });
  const page = await index.list({ raftOrigin: who.raftOrigin, tenantId }, { status, updatedSince, after, limit });
  return ok({
    approvals: page.rows.map((r) => ({ ...r.item, status: r.status, updatedAt: new Date(r.updatedAt).toISOString() })),
    nextCursor: page.next ? encodeCursor(page.next) : null,
  });
}

/**
 * The agent a provider path names (`/agents/<providerAgentId>/…`, `/agents/by-raft-agent/<raftAgentId>/…`), or null
 * when there is none for this token, which every route answers 404. The token's Raft origin must be the agent's, as
 * well as its tenant: a platform token derives the tenant from `?raftServerId=` alone, so without this another Raft
 * deployment's token naming this server's id would reach this server's agents. A tenant token is held to it too.
 * test/provision-origin.ts checks that no route looks an agent up by its path id any other way.
 */
async function agentAt(registry: ProvisionRegistry, who: ProviderTokenIdentity, tenantId: string, byRaft: boolean, id: string): Promise<ProvisionedAgent | null> {
  const row = byRaft ? await registry.get(tenantId, id) : await registry.getByAgentId(tenantId, id);
  return row && row.raftOrigin === who.raftOrigin ? row : null;
}

export async function handleProvision(
  method: string, path: string,
  headers: { idempotencyKey: string | null; raftServerId: string | null; credentialId?: string | null; readReason?: string | null }, body: unknown,
  who: ProviderTokenIdentity, deps: ProvisionDeps, query: URLSearchParams = new URLSearchParams(),
  /** The body as sent, for the one route whose body is not JSON (`PUT …/seed`). */
  raw: Uint8Array | null = null,
): Promise<Response | null> {
  const seg = path.split("/").filter(Boolean);
  if (seg[0] === "connectors" && seg.length === 2 && method === "DELETE") {
    const tenant = tenantFor(who, headers.raftServerId);
    if (isFail(tenant)) return fail(tenant);
    return disconnect(tenant, seg[1]!, body, deps, who);
  }
  if (seg[0] === "models" && seg.length === 1 && method === "GET") {
    if (!deps.models) return null;
    const tenant = tenantFor(who, headers.raftServerId);
    if (isFail(tenant)) return fail(tenant);
    return ok(await modelList(tenant, deps.models));
  }
  if (seg[0] === "usage" && seg.length === 1 && method === "GET") {
    if (!deps.usage) return null;
    const tenant = tenantFor(who, headers.raftServerId);
    if (isFail(tenant)) return fail(tenant);
    const answer = await tenantUsage(tenant, query, deps.usage, deps.now());
    return typeof answer === "string" ? fail({ status: 400, code: "invalid", message: answer }) : ok(answer);
  }
  if (seg[0] === "budgets" && seg[1] === "onboarding" && seg.length === 2 && method === "GET") {
    const usage = deps.usage;
    if (!usage?.pool) return null;
    // Every tenant's onboarding spend summed: a platform figure, which a token that is one tenant does not read.
    if (who.scope !== "platform") {
      return fail({ status: 403, code: "platform_only", message: "the onboarding pool is every tenant's spend together; it is read with a platform-scoped token" });
    }
    const answer = await onboardingPool(query, { ...usage, pool: usage.pool }, deps.now());
    return typeof answer === "string" ? fail({ status: 400, code: "invalid", message: answer }) : ok(answer);
  }
  // Read by Raft's exporter, which refuses a workspace over them before sending it.
  if (seg[0] === "import-limits" && seg.length === 1 && method === "GET") {
    if (!deps.imports) return null;
    return ok(IMPORT_LIMITS);
  }
  // Read by Raft before a migration is confirmed, to show which files would not come over.
  if (seg[0] === "import-check" && seg.length === 1 && method === "POST") {
    if (!deps.imports) return null;
    const tenant = tenantFor(who, headers.raftServerId);
    if (isFail(tenant)) return fail(tenant);
    return importCheck(body, tenant, headers.credentialId ?? null, deps);
  }
  // The Raft server's plan and daily budgets, which Raft sends whenever they change: the tenant's daily limits follow.
  if (seg[0] === "servers" && seg.length === 3 && seg[2] === "plan" && method === "PUT") {
    if (!deps.plans) return null;
    const tenant = await serverTenant(who, seg[1]!, deps.registry, "a plan");
    if (isFail(tenant)) return fail(tenant);
    const b = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const extra = Object.keys(b).find((k) => k !== "plan" && !(BUDGET_FIELDS as readonly string[]).includes(k));
    if (extra) {
      return fail({ status: 422, code: "invalid", param: extra,
        message: `unknown field ${extra}; the body is { "plan": "free" | "pro", "dailyBudgetCents"?: integer | null, "onboardingDailyBudgetCents"?: integer | null }` });
    }
    const plan = planField(b, true);
    if (isFail(plan)) return fail(plan);
    const budgets = budgetCentsFields(b);
    if (isFail(budgets)) return fail(budgets);
    const at = deps.now();
    // A budget left out keeps what was stored: an older Raft that sends `{ plan }` alone changes the plan and nothing else.
    await deps.plans.set(tenant, plan!, headers.credentialId ?? "provider", at, budgets);
    logEvent("provision.plan", { tenantId: tenant, raftServerId: seg[1], plan, ...budgets, via: "put" });
    return ok({ raftServerId: seg[1], plan, ...budgets, updatedAt: new Date(at).toISOString() });
  }
  // Whether the server's agents may be given another model than the default (`pickerProblem`), which Raft sends whenever
  // its own switch for the server changes. The same tenant rules as the plan's.
  if (seg[0] === "servers" && seg.length === 3 && seg[2] === "model-picker" && method === "PUT") {
    if (!deps.models) return null;
    const tenant = await serverTenant(who, seg[1]!, deps.registry, "the model picker");
    if (isFail(tenant)) return fail(tenant);
    const b = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const extra = Object.keys(b).find((k) => k !== "enabled");
    if (extra) return fail({ status: 422, code: "invalid", param: extra, message: `unknown field ${extra}; the body is { "enabled": true | false }` });
    if (typeof b.enabled !== "boolean") {
      return fail({ status: 422, code: b.enabled === undefined ? "missing" : "invalid", param: "enabled", message: 'the body is { "enabled": true | false }' });
    }
    const at = deps.now();
    await deps.models.picker.set(tenant, b.enabled, headers.credentialId ?? "provider", at);
    logEvent("provision.model_picker", { tenantId: tenant, raftServerId: seg[1], enabled: b.enabled });
    return ok({ raftServerId: seg[1], modelPicker: b.enabled, updatedAt: new Date(at).toISOString() });
  }
  // Every held call of the provider's agents, from D1's copy: what Raft reconciles its cards against.
  if (seg[0] === "approvals" && seg.length === 1 && method === "GET") {
    if (!deps.approvals) return null;
    return providerApprovals(who, headers.raftServerId, query, deps.approvals.index);
  }
  if (seg[0] !== "agents") return null;
  // On POST the body names the server; elsewhere the URL does.
  const fromBody = method === "POST" && seg.length === 1;
  const serverForTenant = fromBody
    ? (typeof field(body, "raftServerId") === "string" ? field(body, "raftServerId") as string : null)
    : headers.raftServerId;
  const tenant = tenantFor(who, serverForTenant, fromBody ? "body" : "query");
  if (isFail(tenant)) return fail(tenant);
  const tenantId = tenant;

  if (seg.length === 1 && method === "POST") {
    const raftAgentId = field(body, "raftAgentId");
    if (typeof raftAgentId !== "string" || !RAFT_ID.test(raftAgentId)) {
      return fail({ status: 422, code: "invalid", message: `raftAgentId must match ${RAFT_ID}`, param: "raftAgentId" });
    }
    if (headers.idempotencyKey !== null && headers.idempotencyKey !== raftAgentId) {
      return fail({ status: 422, code: "invalid", message: "Idempotency-Key must be the raftAgentId", param: "Idempotency-Key" });
    }
    const raftServerId = textField(body, "raftServerId", 128, true);
    if (isFail(raftServerId)) return fail(raftServerId);
    const raftOrigin = field(body, "raftOrigin");
    if (typeof raftOrigin !== "string" || originProblem(raftOrigin)) {
      return fail({ status: 422, code: "invalid", message: `raftOrigin ${typeof raftOrigin === "string" ? originProblem(raftOrigin) : "is required"}`, param: "raftOrigin" });
    }
    // The token was minted for one Raft. A mount made under it points there and nowhere else, so a
    // leaked token cannot aim an agent's credential at another address.
    if (raftOrigin !== who.raftOrigin) {
      return fail({ status: 422, code: "origin_mismatch", message: "raftOrigin is not the origin this token was issued for", param: "raftOrigin" });
    }
    const name = textField(body, "name", NAME_MAX, true);
    if (isFail(name)) return fail(name);
    const instructions = textField(body, "instructions", instructionsLimit(deps.seed), false) ?? "";
    if (isFail(instructions)) return fail(instructions);
    const credential = credentialField(body);
    if (isFail(credential)) return fail(credential);
    // Before the tool choice: a profile decides the tools, and says so where `mounts` or `harness` is named beside it.
    const profile = profileField(body);
    if (isFail(profile)) return fail(profile);
    const toolConfig = toolConfigField(body, deps.seed);
    if (isFail(toolConfig)) return fail(toolConfig);
    // Only its type here: whether it is offered, and not locked, is a first create's question (`createPick`). A replay
    // is compared with the create it repeats, so an option withdrawn since does not refuse the agent that exists.
    const model = createModelField(body);
    if (isFail(model)) return fail(model);
    // The switch is the server's, set by its own route only: taken here, a create retried late could turn back a switch
    // flipped since, and ignored, a caller sending it would believe a pick allowed that is then refused.
    if (field(body, "modelPicker") !== undefined) {
      return fail({ status: 422, code: "invalid", param: "modelPicker",
        message: "modelPicker is the server's, not the agent's: set it with PUT /provision/servers/{raftServerId}/model-picker" });
    }
    // Hold the agent until its workspace import (`POST …/import`): no turn before it, pushes queued meanwhile.
    const awaitField = field(body, "awaitImport");
    if (awaitField !== undefined && typeof awaitField !== "boolean") {
      return fail({ status: 422, code: "invalid", param: "awaitImport", message: "awaitImport is true or false" });
    }
    const awaitImport = awaitField === true;
    // How the agent's first turn runs (src/runtime/prewarm.ts): `{ "reasoning": "off" }` answers its first message
    // without reasoning, for an agent whose first reply someone is waiting on. Absent: as every other turn.
    const firstTurn = firstTurnField(body);
    if (isFail(firstTurn)) return fail(firstTurn);
    // Which daily budget pays for the agent (cf/src/spend-limit.ts): "onboarding" is the platform's onboarding pool,
    // outside the tenant's limit. Fixed at creation like `model`, so a replay must repeat it.
    const budget = budgetField(body);
    if (isFail(budget)) return fail(budget);
    // The server's plan and budgets as Raft says them now. Not part of the agent, so not compared on a replay (below).
    const plan = planField(body, false);
    if (isFail(plan)) return fail(plan);
    const budgets = budgetCentsFields(body);
    if (isFail(budgets)) return fail(budgets);
    // The budgets are kept with the plan (one row per tenant), so they travel with it, as on the PUT.
    if (plan === null && budgetsSent(budgets)) {
      const named = BUDGET_FIELDS.find((k) => budgets[k] !== undefined)!;
      return fail({ status: 422, code: "invalid", param: named, message: `${named} is sent with plan` });
    }
    if (plan !== null && !deps.plans) return fail({ status: 503, code: "unavailable", param: "plan", message: "this deployment cannot record a plan" });

    const agentId = providerAgentId(raftAgentId);
    // `model` is part of the request a replay must repeat: absent and null are one value (null), as on a create.
    // `awaitImport` likewise: absent and false are one value.
    // `budget` likewise: absent and null are one value (the tenant's own).
    // `profile` likewise: absent and null are one value (today's agent).
    const asked = { raftServerId: raftServerId!, raftOrigin, name: name!, instructions, model, awaitImport, budget, profile };
    const credentialHash = await sha256Hex(credential);
    let row = await deps.registry.get(tenantId, raftAgentId);
    let created = false;
    // Another Raft origin's agent under this id (a platform token derives the tenant from the server id alone): the
    // id is taken, as the unique index would say, and nothing of the agent is compared, answered or run.
    if (row && row.raftOrigin !== who.raftOrigin) {
      return fail({ status: 409, code: "agent_id_taken", message: `${agentId} already belongs to another Raft agent in this tenant` });
    }
    if (row) {
      if (row.status === "deleted") {
        return fail({ status: 409, code: "deleted", message: "this Raft agent was deleted here; a new agent needs a new id" });
      }
      const differs = (Object.keys(asked) as Array<keyof typeof asked>).filter((k) =>
        (k === "model" ? row!.model ?? null : k === "awaitImport" ? row!.awaitImport ?? false : k === "budget" ? row!.budget ?? null
          : k === "profile" ? row!.profile ?? null : row![k]) !== asked[k]);
      // The credential is the one field that matters most: a delayed retry with an old one must not
      // overwrite a newer PUT /credential. Compared by hash; a row from
      // before the hash existed accepts the first replay and records it.
      if (row.credentialHash !== null && row.credentialHash !== credentialHash) differs.push("credential" as keyof typeof asked);
      // A create that named a model and died before storing its pick (`modelPending`, set only while `provisioning`)
      // has not chosen yet: its replay may name another model, or none — the way out of a lock or a withdrawn option
      // that refuses the first — and is checked as a first create. Any other difference is a conflict, as ever.
      const reopen = row.status === "provisioning" && row.modelPending === true;
      if (differs.length && !(reopen && differs.length === 1 && differs[0] === "model")) {
        return fail({ status: 409, code: "idempotency_conflict", message: `a different request was already made under this key (${differs.join(", ")}); edits go through PATCH${differs.includes("model") ? ", and the model through PUT …/model" : ""}` });
      }
      if (row.credentialHash === null) { await deps.registry.update(tenantId, raftAgentId, { credentialHash }); row = { ...row, credentialHash }; }
      // Once the pick is stored (`modelPending` cleared) a replay never writes it again, so a delayed retry cannot undo a
      // PUT …/model, null included, that landed after it.
      if (reopen) {
        // The model the interrupted create asked for was let through then: repeating it is not a new choice.
        const pick = model === null ? { pick: null } : await createPick(deps.models, tenantId, agentId, model, row.model ?? null);
        if (isFail(pick)) return fail(pick);
        if ((row.model ?? null) !== model) { await deps.registry.update(tenantId, raftAgentId, { model }); row = { ...row, model }; }
        row = await settlePick(deps, row, pick.pick, headers.credentialId ?? null);
        // The create completing, not a replay of one that completed: answered as the first create would have been.
        created = true;
      }
    } else {
      // Refused before the row exists, so an unoffered or locked model leaves nothing made and the id free — as a PUT
      // under the lock stores nothing.
      const pick = model === null ? { pick: null } : await createPick(deps.models, tenantId, agentId, model);
      if (isFail(pick)) return fail(pick);
      // The plan is written by a create and never by a replay of one: a POST retried late carries the plan of its
      // first send, and must not undo a `PUT /servers/:id/plan` that landed since. Before the row, so a create that
      // dies after this has still said it, and its replay (which writes no plan) loses nothing.
      if (plan !== null) {
        await deps.plans!.set(tenantId, plan, headers.credentialId ?? "provider", deps.now(), budgets);
        logEvent("provision.plan", { tenantId, raftServerId, plan, ...budgets, via: "create" });
      }
      const t = deps.now();
      // Pending only while there is a pick to store: the default taken with the picker off stores none.
      row = { tenantId, raftAgentId, agentId, ...asked, modelPending: pick.pick !== null, credentialHash, status: "provisioning", pushRegistered: false, pushError: null, createdAt: t, updatedAt: t, deletedAt: null };
      try { await deps.registry.create(row); }
      catch (e) {
        // Only the unique index says 409 (two Raft ids that sanitise alike). Anything else — D1 away, a
        // migration missing — is a 500 Raft retries, not a permanent conflict.
        const message = typeof e === "object" && e !== null && "message" in e ? String((e as { message?: unknown }).message) : String(e);
        if (!/UNIQUE constraint/i.test(message)) throw e;
        return fail({ status: 409, code: "agent_id_taken", message: `${agentId} already belongs to another Raft agent in this tenant` });
      }
      created = true;
      // Stored before `adopt`, which binds the model it resolves (steps.ts), so the agent's first turn already runs on
      // the pick. Not one statement with the row: if this fails the POST fails, and its replay stores it (above).
      row = await settlePick(deps, row, pick.pick, headers.credentialId ?? null);
    }
    // From here every step is idempotent, so a replay of a request that died half-way finishes it. The tool choice is
    // compared by the agent's object, where it is recorded: a replay asking for other tools is 409, as for any field.
    const adopted = await deps.agent.adopt(tenantId, agentId, { name: row.name, instructions: row.instructions, raftOrigin: row.raftOrigin, toolConfig,
      firstTurn, profile: row.profile ?? null, ...(row.awaitImport ? { awaitImport: true } : {}) });
    if (adopted) return fail(adopted);
    const attached = await deps.agent.attachCredential(tenantId, agentId, credential);
    if (!attached.ok) return fail({ status: 422, code: "credential_refused", message: attached.error, param: "credential" });
    row = await registerPush(deps, row);
    return ok(view(row), created ? 201 : 200);
  }

  // An agent is addressed by its providerAgentId, or by the Raft id it was made from
  // (`/agents/by-raft-agent/<raftAgentId>`): a POST whose answer was lost leaves Raft with no
  // providerAgentId, and a delete must still reach the agent it made (Tenny's orphan case).
  const byRaft = seg[1] === "by-raft-agent";
  const rest = byRaft ? seg.slice(2) : seg.slice(1);
  // Every route below reaches the agent its path names through this, and only this (`agentAt`).
  const pathAgent = () => agentAt(deps.registry, who, tenantId, byRaft, rest[0]!);
  if ((rest.length === 3 || (rest.length === 4 && rest[3] === "confirm")) && rest[1] === "connections") {
    return connection(method, rest, body, tenantId, byRaft, deps, pathAgent);
  }
  // `…/usage`, `…/workspace-files`, `…/workspace-files/read`: the agent's own surface, read through
  // the core the public API uses; only how the agent is found, and the envelope, are this binding's.
  if (rest.length === 2 && rest[1] === "import" && method === "POST") {
    if (!deps.imports) return null;
    const found = await pathAgent();
    if (!found || found.status === "deleted") {
      return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });
    }
    return workspaceImport(body, tenantId, found, headers.credentialId ?? null, deps, deps.imports);
  }
  if (EVAL_ROUTES.has(rest.slice(1).join("/"))) {
    if (!deps.seed) return null;
    const found = await pathAgent();
    if (!found || found.status === "deleted") {
      return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });
    }
    return evalSetup(method, rest.slice(1).join("/"), tenantId, found.agentId, query, raw, headers.credentialId ?? null, deps.seed,
      { audit: deps.readAudit ?? null, reason: headers.readReason ?? null });
  }
  // `…/approvals` and `…/approvals/{operationId}/decide`: this agent's held calls, from its own object.
  if (rest[1] === "approvals" && ((rest.length === 2 && method === "GET") || (rest.length === 4 && rest[3] === "decide" && method === "POST"))) {
    if (!deps.approvals) return null;
    const found = await pathAgent();
    if (!found || found.status === "deleted") {
      return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });
    }
    return rest.length === 2
      ? agentApprovals(tenantId, found, query, deps.approvals)
      : decideApproval(tenantId, found, rest[2]!, body, headers.credentialId ?? null, deps.approvals);
  }
  const read = method === "GET" && rest.length >= 2 ? surfaceReadOf(rest.slice(1), "provider") : null;
  if (read && deps.surface) {
    const found = await pathAgent();
    if (!found || found.status === "deleted") {
      return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });
    }
    const a = await surface(deps.surface, read, tenantId, found.agentId, query);
    if (!a.ok) return fail({ status: a.status, code: a.status === 404 ? "not_found" : a.status === 502 ? "unavailable" : "invalid", message: a.message, ...(a.param ? { param: a.param } : {}) });
    return ok(read === "usage" ? { raftAgentId: found.raftAgentId, providerAgentId: found.agentId, ...a.body } : a.body);
  }
  if (rest.length === 2 && rest[1] === "model") {
    if (!deps.models) return null;
    const found = await pathAgent();
    if (!found || found.status === "deleted") {
      return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });
    }
    return modelRoute(method, body, tenantId, found, headers.credentialId ?? null, deps.models, deps.registry, deps.now);
  }
  // `…/stop`: end the agent's running turn without deleting it (StopTurnResult). A deleted agent can still be stopped:
  // a turn that outlived its delete is exactly the one that needs it. Repeating it answers `not_running`.
  if (rest.length === 2 && rest[1] === "stop" && method === "POST") {
    if (!deps.agent.stopTurn) return null;
    const found = await pathAgent();
    if (!found) return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });
    const r = await stopTurnOf(deps.agent.stopTurn, tenantId, found.agentId, "provider_stop");
    if (r.result === "failed") return fail({ status: 503, code: "stop_failed", message: `the agent's turn could not be stopped; try again: ${r.error}` });
    return ok(r.result === "interrupted" ? { result: "interrupted", cancelledTurn: r.cancelledTurn } : { result: "not_running" });
  }
  if (rest.length < 1 || rest.length > 2 || (rest.length === 2 && rest[1] !== "credential")) return null;
  const row = await pathAgent();
  const gone = () => fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });

  if (rest.length === 1 && method === "GET") {
    if (!row) return gone();
    if (row.status === "deleted") return ok(view(row));
    const live = await deps.agent.pushStatus(tenantId, row.agentId);
    return ok(view(row, (live ?? { error: "no push state on the mount" }) as unknown as Json));
  }

  if (rest.length === 1 && method === "PATCH") {
    if (!row || row.status === "deleted") return gone();
    const name = textField(body, "name", NAME_MAX, false);
    if (isFail(name)) return fail(name);
    const instructions = textField(body, "instructions", instructionsLimit(deps.seed), false);
    if (isFail(instructions)) return fail(instructions);
    if (name === undefined && instructions === undefined) {
      return fail({ status: 422, code: "empty", message: "nothing to change: give name or instructions" });
    }
    const patch = { ...(name !== undefined ? { name } : {}), ...(instructions !== undefined ? { instructions } : {}) };
    await deps.registry.update(tenantId, row.raftAgentId, patch);
    const next = { ...row, ...patch, updatedAt: deps.now() };
    await deps.agent.adopt(tenantId, row.agentId, { name: next.name, instructions: next.instructions, raftOrigin: next.raftOrigin });
    return ok(view(next));
  }

  if (rest.length === 2 && method === "PUT") {
    if (!row || row.status === "deleted") return gone();
    const credential = credentialField(body);
    if (isFail(credential)) return fail(credential);
    const attached = await deps.agent.attachCredential(tenantId, row.agentId, credential);
    if (!attached.ok) return fail({ status: 422, code: "credential_refused", message: attached.error, param: "credential" });
    const credentialHash = await sha256Hex(credential);
    await deps.registry.update(tenantId, row.raftAgentId, { credentialHash });
    // A new credential means a new registration on Raft's side; the plugin replaces the hook and re-PUTs.
    return ok(view(await registerPush(deps, { ...row, credentialHash })));
  }

  if (rest.length === 1 && method === "DELETE") {
    if (!row) return gone();
    // First, and on a repeated delete too: a delete that does not end the running turn leaves the agent calling its
    // model with nobody able to see it (Raft stops taking a deleted agent's activity), which is what happened on
    // preview before deletes did this. A stop that fails does not fail the delete; it is logged (`turn.stop`).
    const stop = deps.agent.stopTurn ? await stopTurnOf(deps.agent.stopTurn, tenantId, row.agentId, "delete") : null;
    // Then what its mounts hold at the far end: first the credentials registered there taken back (a sandbox's egress
    // holds the agent's GitHub token and swaps it in with no call back here, so only this stops a box still running
    // from using it), then each held thing let go (a box deleted). Again on a repeated delete. A failure is not a
    // failed delete: it is in the answer (`sandboxes`), with what to do next.
    const releaseHeld = async () => {
      if (!deps.agent.releaseForDelete) return null;
      try { return await deps.agent.releaseForDelete(tenantId, row.agentId); }
      catch (e) { return { things: [], released: [], failed: [{ alias: "*", stage: "release" as const, error: `the agent's object did not answer: ${String((e as Error)?.message ?? e).slice(0, 160)}` }] }; }
    };
    // Right after the stop, before anything slower: a box still running acts with the agent's accounts until then.
    const held = await releaseHeld();
    // Its holds' copies are kept as the record of who decided what for it, no longer listed, without the arguments'
    // text, which is the agent's to keep (`markAgentDeleted`). Again on a repeated delete, and by the next prune, so one
    // whose marking failed is finished. A failure is logged, not a failed delete: the list leaves a deleted agent's rows
    // out by the registry anyway (`d1ApprovalIndex`).
    const keepHolds = async (at: number) => {
      if (!deps.approvals) return;
      try { await deps.approvals.index.markAgentDeleted(tenantId, row.agentId, at); }
      catch (e) { console.warn(`keeping the approval copies of ${tenantId}/${row.agentId} failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`); }
    };
    // Its connections go: the credential copy on the agent's mount, then each binding to a connector, recorded as the
    // connector's event with whether the mount was cleared. What became of each is in the answer (`connections`,
    // `connectionsClean`): still a 200, since the agent is deleted either way, but never a plain success when a copy
    // may be left, and each such entry names what to do next:
    //  - the clear was refused (something the key made is still held) or the object did not answer (usually
    //    passing): the binding is kept, so the next DELETE of the agent, or the connector's disconnect, still finds
    //    it, and `action: "retry_delete"`. Meanwhile the copy is not renewed: a deleted agent is never handed a pair,
    //    nor finds a connector to renew through (`d1ConnectorGrants`).
    //  - the object holds no such agent (wiped): nothing here can reach what it was handed, a retry cannot either, so
    //    the binding goes, and `action: "revoke_on_github"` (botiverse/antiproton#1128).
    type ConnectionEnd = { provider: ConnectionProvider; connectorId: string | null; binding: "removed" | "kept" | "none";
      mount: "cleared" | "not_cleared"; action?: "retry_delete" | "revoke_on_github"; message?: string; error?: string };
    const REVOKE = REVOKE_ON_GITHUB;
    const unbind = async (at: number): Promise<ConnectionEnd[] | null> => {
      const c = deps.connections;
      if (!c) return null;
      const ends: ConnectionEnd[] = [];
      for (const p of CONNECTION_PROVIDERS) {
        let error: string | null = null;
        let gone = false;
        let took = false;
        try {
          const r = await c.clear(tenantId, row.agentId, p);
          if (r.ok) took = r.cleared;
          else { error = r.error; gone = r.gone === true; }
        } catch (e) { error = `the agent's object did not answer: ${String((e as Error)?.message ?? e).slice(0, 160)}`; }
        const mountCleared = error === null;
        const action = mountCleared ? undefined : gone ? "revoke_on_github" as const : "retry_delete" as const;
        if (!mountCleared) logEvent("connect.agent_delete", { tenantId, agentId: row.agentId, provider: p, outcome: "mount-not-cleared", action: action!, reason: error!.slice(0, 200) });
        let connectorId: string | null = null;
        let binding: ConnectionEnd["binding"] = "none";
        try {
          const bound = await c.registry.get(tenantId, row.raftAgentId, p);
          if (bound) {
            connectorId = bound.connectorId ?? null;
            binding = "kept";
            if (action !== "retry_delete") {
              // Whether the mount copy went is recorded with the unbinding, so a later check reads it from data.
              if (connectorId) {
                await c.connectors.record({ tenantId, connectorId, raftAgentId: row.raftAgentId, action: "deleted_agent_unbound",
                  actingRaftUserId: SYSTEM_ACTOR, actingRole: "system", at, reason: JSON.stringify({ provider: p, mountCleared, ...(error ? { error } : {}) }) });
              }
              await c.registry.remove(tenantId, row.raftAgentId, p);
              binding = "removed";
            }
            logEvent("connect.agent_delete", { tenantId, agentId: row.agentId, provider: p, connectorId, outcome: binding === "removed" ? "unbound" : "binding-kept", mountCleared });
          }
        } catch (e) {
          error ??= String((e as Error)?.message ?? e).slice(0, 200);
          logEvent("connect.agent_delete", { tenantId, agentId: row.agentId, provider: p, outcome: "unbind-failed", reason: String((e as Error)?.message ?? e).slice(0, 200) });
        }
        // A provider the agent was never connected to, with nothing on its mount, is not worth an entry.
        if (binding !== "none" || took || error !== null) {
          ends.push({ provider: p, connectorId, binding, mount: mountCleared ? "cleared" : "not_cleared",
            ...(action ? { action, message: action === "revoke_on_github" ? REVOKE : "the mount still holds a copy; DELETE this agent again to clear it" } : {}),
            ...(error ? { error } : {}) });
        }
      }
      return ends;
    };
    // What the delete could not finish, each with what to do next. Still a 200: the agent is deleted either way.
    //  - a background job whose cancel failed goes on with whatever it holds: `turn.stillRunning`, retry_delete;
    //  - each held thing (a box) is clean only on positive evidence (`releaseForDelete`): `via: "withdrawn"` or
    //    `"deleted"`. Anything else (no key to reach it, a listing that could not be read, a stranded box, a "not
    //    found" that cannot be believed) is not clean, with why and retry_delete; it may still act with the agent's
    //    accounts. A step that failed outright is in `sandboxes.failed`.
    // `clean` is every part clean; `connectionsClean` is the connections' alone, as before.
    const answer = (agent: ReturnType<typeof view>, ends: ConnectionEnd[] | null) => {
      const stillRunning = stop && stop.result !== "failed" ? stop.stillRunning ?? [] : [];
      const turn = stop?.result === "failed" ? { stopped: false, error: stop.error, action: "retry_delete" as const }
        : stillRunning.length ? { stopped: true, stillRunning, action: "retry_delete" as const } : null;
      const sandboxes = held === null ? null : {
        released: held.released,
        boxes: held.things.map((t) => t.clean ? t : { ...t, action: "retry_delete" as const }),
        ...(held.failed.length ? { failed: held.failed } : {}),
      };
      const connectionsClean = ends === null ? true : ends.every((e) => e.mount === "cleared" && !e.error);
      const clean = connectionsClean && turn === null && (held === null || (held.things.every((t) => t.clean) && held.failed.length === 0));
      if (ends === null && held === null && turn === null) return ok(agent);
      return ok({ ...agent, ...(ends === null ? {} : { connections: ends, connectionsClean }), ...(turn ? { turn } : {}), ...(sandboxes ? { sandboxes } : {}), clean });
    };
    if (row.status === "deleted") {
      const ends = await unbind(deps.now());
      await keepHolds(row.deletedAt ?? row.updatedAt);
      return answer(view(row), ends);
    }
    // Raft revokes the credential itself, so pushes stop even if this fails half-way; what is
    // reported is what could not be undone here. The object and its transcript stay: data is
    // never destroyed by a delete, here as for every agent.
    const off = await deps.agent.tool(tenantId, row.agentId, "disable_push");
    await deps.agent.removeCredential(tenantId, row.agentId);
    const t = deps.now();
    const patch = { status: "deleted" as const, pushRegistered: false, pushError: off.ok ? null : off.error, deletedAt: t };
    // After the registry says deleted, so a publish racing this adds nothing the mark misses (`d1ApprovalIndex.upsert`).
    await deps.registry.update(tenantId, row.raftAgentId, patch);
    const ends = await unbind(t);
    await keepHolds(t);
    return answer(view({ ...row, ...patch, updatedAt: t }), ends);
  }

  return null;
}


/** What `GET /provision/import-limits` answers: the bounds `POST …/import` refuses past, for Raft's exporter to apply first. */
export const IMPORT_LIMITS = { maxTotalBytes: IMPORT_TOTAL_MAX_BYTES, maxFiles: IMPORT_FILES_MAX, maxFileBytes: IMPORT_FILE_MAX_BYTES } as const;
/**
 * The most an import's request may be, as sent: 10 MiB of files in base64 is 13.4 MiB, and paths, hashes and
 * instructions fit in what is left. Refused before the body is parsed (cf/src/index.ts `provision`).
 */
export const IMPORT_REQUEST_MAX_BYTES = 16 * 1024 * 1024;
/** The routes whose body is an import's, bounded by `IMPORT_REQUEST_MAX_BYTES`: the import, and its check. */
export const IMPORT_ROUTE = /^\/provision\/(?:agents\/(?:by-raft-agent\/)?[^/]+\/import|import-check)$/;
const MIGRATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const IMPORT_FIELDS = new Set(["migrationId", "instructions", "files", "totalBytes"]);
const IMPORT_FILE_FIELDS = new Set(["path", "contentBase64", "sha256"]);

/** One file of an import, checked and decoded: what its row will read back as. */
export interface ImportFile { path: string; text: string; bytes: number; sha256: string }

/** The bytes as text, or null when they are not UTF-8 or carry a NUL. A BOM is kept, so the text re-encodes to them. */
function utf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

/**
 * An imported file's path as the key it becomes, or why it cannot be one. Empty and `.` segments drop out
 * (`./notes//a.md` is `notes/a.md`); refused rather than resolved: a leading `/`, a `..` segment, a trailing `/`
 * (a directory), a backslash or a control character. Then the state plugin's key rule (src/plugins/state-key.ts),
 * since the file is a state key; and never a name the runtime owns: `kept:` (the agent's sealed secrets,
 * src/runtime/secrets.ts) or a working-set document (`memory`, `todo`, `journal`, src/plugins/state.ts
 * `WORKING_SET`), which the runtime puts in the system prompt as the agent's own running notes.
 */
export function importPath(raw: unknown): { path: string } | { problem: string; reserved?: true } {
  if (typeof raw !== "string" || !raw) return { problem: "path is required" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return { problem: "path may not contain a backslash or a control character" };
  if (raw.startsWith("/")) return { problem: "path must be relative, not absolute" };
  if (raw.endsWith("/")) return { problem: "path names a directory; give a file" };
  const segs = raw.split("/").filter((p) => p !== "" && p !== ".");
  if (segs.includes("..")) return { problem: "path must not have a `..` segment" };
  const path = segs.join("/");
  if (path.toLowerCase().startsWith("kept:")) return { problem: "kept: names a secret, not a file", reserved: true };
  if (!STATE_KEY.test(path)) return { problem: `path must match ${STATE_KEY} once normalised (a state key)` };
  if (WORKING_SET.some((d) => d.key === path)) {
    return { problem: `${path} is one of the agent's working-set documents (${WORKING_SET.map((d) => d.key).join(", ")}), which the runtime keeps; import under another path`, reserved: true };
  }
  return { path };
}

/** One file an import refuses, as the answer lists it: where it is in `files`, the path as sent, and why. Never its bytes. */
export interface ImportRejection { index: number; path: string | null; reason: string; param: string }
/** How many refused files one answer lists; past it they are counted (`more`), so a bad workspace cannot make the answer as large as the request. */
export const IMPORT_REJECTIONS_SHOWN = 200;
/** A sent path as a rejection names it: the caller's own string, cut short; one shaped like a credential is refused and named `null`. */
const PATH_ECHO_MAX = 256;

/** A refused import: the first problem as the envelope's code and message, and every refused file with it. */
export type ImportFail = Fail & { rejected?: ImportRejection[]; more?: number };

/** What `importChecked` found in a body whose shape and bounds hold: the files that pass, and every one that does not. */
interface ImportChecked {
  migrationId: string; instructions: string | undefined; files: ImportFile[]; totalBytes: number;
  rejected: Array<{ rejection: ImportRejection; fail: Fail }>;
}

/**
 * The body of `POST …/import` and `POST /provision/import-check`, checked whole: shape, bounds, paths, each file's
 * bytes against its `sha256`, and `totalBytes` against their sum. A problem with the body itself (a field, a bound
 * on the whole) ends the check, as a `Fail`. A problem with one file refuses that file and the check goes on to the
 * next, so one answer names every file that would be refused: a caller dropping them one round trip at a time
 * would need as many round trips as files. Each file gets its first problem only.
 */
function importChecked(body: unknown, instructionsMax: Limit): ImportChecked | ImportFail {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { status: 422, code: "invalid", message: "the body is a JSON object" };
  const unknownField = Object.keys(body).find((k) => !IMPORT_FIELDS.has(k));
  if (unknownField) return { status: 400, code: "unknown_field", param: unknownField, message: `unknown field ${unknownField}` };
  const migrationId = field(body, "migrationId");
  if (typeof migrationId !== "string" || !MIGRATION_ID.test(migrationId)) {
    return { status: 422, code: "invalid", param: "migrationId", message: `migrationId is required and must match ${MIGRATION_ID}` };
  }
  const instructions = textField(body, "instructions", instructionsMax, false);
  if (isFail(instructions)) return instructions;
  const totalBytes = field(body, "totalBytes");
  if (typeof totalBytes !== "number" || !Number.isSafeInteger(totalBytes) || totalBytes < 0) {
    return { status: 422, code: "invalid", param: "totalBytes", message: "totalBytes is required: the sum of the files' decoded sizes, in bytes" };
  }
  // Refused before a byte is decoded: the request says itself that it is too large.
  if (totalBytes > IMPORT_TOTAL_MAX_BYTES) {
    return { status: 413, code: "too_large", param: "totalBytes", message: `an import is at most ${IMPORT_TOTAL_MAX_BYTES} bytes together; this one says ${totalBytes}` };
  }
  const list = field(body, "files");
  if (!Array.isArray(list)) return { status: 422, code: "invalid", param: "files", message: "files is an array of { path, contentBase64, sha256 }" };
  if (list.length > IMPORT_FILES_MAX) {
    return { status: 413, code: "too_many_files", param: "files", message: `an import is at most ${IMPORT_FILES_MAX} files; this one has ${list.length}` };
  }
  const files: ImportFile[] = [];
  const rejected: ImportChecked["rejected"] = [];
  const seen = new Set<string>();
  let sum = 0;
  for (let i = 0; i < list.length; i++) {
    const at = `files[${i}]`, f = list[i] as unknown;
    const sent = typeof f === "object" && f !== null ? field(f, "path") : undefined;
    // A path is a state key, named in the prompt, in listings and in every answer about the import: one shaped like a
    // credential would put the credential in all of them, so it is refused, and never repeated, here or in a message.
    const credentialPath = typeof sent === "string" && secretShape(sent) !== null;
    const echo = typeof sent === "string" && !credentialPath ? sent.slice(0, PATH_ECHO_MAX) : null;
    const refuse = (x: Fail) => { rejected.push({ rejection: { index: i, path: echo, reason: x.code, param: x.param ?? at }, fail: x }); };
    if (typeof f !== "object" || f === null || Array.isArray(f)) { refuse({ status: 422, code: "invalid", param: at, message: `${at} is an object { path, contentBase64, sha256 }` }); continue; }
    const extra = Object.keys(f).find((k) => !IMPORT_FILE_FIELDS.has(k));
    if (extra) { refuse({ status: 400, code: "unknown_field", param: `${at}.${extra}`, message: `unknown field ${at}.${extra}${extra === "content" ? "; a file is sent as contentBase64" : ""}` }); continue; }
    if (credentialPath) {
      refuse({ status: 422, code: "credential_in_path", param: `${at}.path`, message: `${at}.path carries what looks like a ${secretShape(sent as string)}; credentials are never imported, not even as a name` }); continue;
    }
    const p = importPath(sent);
    if ("problem" in p) { refuse({ status: 422, code: p.reserved ? "reserved" : "invalid", param: `${at}.path`, message: `${at}.path: ${p.problem}` }); continue; }
    if (seen.has(p.path)) { refuse({ status: 422, code: "duplicate_path", param: `${at}.path`, message: `${at}.path is ${p.path}, which an earlier file already is` }); continue; }
    seen.add(p.path);
    const sha = field(f, "sha256");
    if (typeof sha !== "string" || !SHA256_HEX.test(sha.toLowerCase())) {
      refuse({ status: 422, code: "invalid", param: `${at}.sha256`, message: `${at}.sha256 is the hex SHA-256 of the file's bytes` }); continue;
    }
    const b64 = field(f, "contentBase64");
    if (typeof b64 !== "string" || !BASE64.test(b64)) {
      refuse({ status: 422, code: "invalid", param: `${at}.contentBase64`, message: `${at}.contentBase64 is the file's bytes in standard, padded base64` }); continue;
    }
    // The decoded size, known from the length: a file over the bound is refused without decoding it.
    const size = (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
    if (size > IMPORT_FILE_MAX_BYTES) {
      refuse({ status: 413, code: "file_too_large", param: `${at}.contentBase64`, message: `a file is at most ${IMPORT_FILE_MAX_BYTES} bytes; ${at} is ${size}` }); continue;
    }
    // Only a file decoded counts: what this bounds is the decoding one request costs, and a file refused above is
    // not decoded. Past it the check ends, a bound on the whole, carrying the files refused before it.
    sum += size;
    if (sum > IMPORT_TOTAL_MAX_BYTES) {
      return { status: 413, code: "too_large", param: "files", message: `an import is at most ${IMPORT_TOTAL_MAX_BYTES} bytes together; the files through ${at} are ${sum}`,
        ...(rejected.length ? rejectionList(rejected) : {}) };
    }
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const hash = sha256Sync(bytes);
    if (hash !== sha.toLowerCase()) { refuse({ status: 422, code: "sha256_mismatch", param: `${at}.sha256`, message: `${at}.sha256 is not the SHA-256 of its decoded bytes` }); continue; }
    // A state value is text: a file that is not UTF-8, or carries a NUL, could not read back as the bytes it was. The
    // size was bounded above, by this route's own bound (not `seedText`'s, which is a seeded file's).
    const text = utf8Text(bytes);
    if (text === null) { refuse({ status: 422, code: "not_text", param: `${at}.contentBase64`, message: `${at} is not UTF-8 text with no NUL byte; an imported file is a text document` }); continue; }
    const shape = secretShape(text);
    if (shape) { refuse({ status: 422, code: "credential_in_text", param: `${at}.contentBase64`, message: `${at} carries what looks like a ${shape}; credentials are never imported` }); continue; }
    files.push({ path: p.path, text, bytes: bytes.byteLength, sha256: hash });
  }
  // Only once every file passed: with one refused, the sum the caller should send is the one without it.
  if (!rejected.length && sum !== totalBytes) {
    return { status: 422, code: "total_mismatch", param: "totalBytes", message: `totalBytes is ${totalBytes}, and the files decode to ${sum}` };
  }
  return { migrationId, instructions, files, totalBytes: files.reduce((n, f) => n + f.bytes, 0), rejected };
}

/** The listed part of a refusal: the first `IMPORT_REJECTIONS_SHOWN`, and how many past them. */
function rejectionList(rejected: ImportChecked["rejected"]): { rejected: ImportRejection[]; more: number } {
  return { rejected: rejected.slice(0, IMPORT_REJECTIONS_SHOWN).map((r) => r.rejection), more: Math.max(0, rejected.length - IMPORT_REJECTIONS_SHOWN) };
}

/**
 * The body of `POST …/import`, as the import takes it: every file passing, or refused. A refusal with files in it
 * keeps the status, code, `param` and message of the first refused file, as when the check stopped there, and adds
 * `rejected` (every refused file, up to `IMPORT_REJECTIONS_SHOWN`) and `more`. Over a bound is 413, anything else
 * 422 (400 for a field this route does not know), each naming the field.
 */
export function importRequest(body: unknown, instructionsMax: Limit):
  { migrationId: string; instructions: string | undefined; files: ImportFile[]; totalBytes: number } | ImportFail {
  const c = importChecked(body, instructionsMax);
  if (isFail(c)) return c;
  if (c.rejected.length) {
    const first = c.rejected[0]!.fail;
    const also = c.rejected.length > 1 ? `; ${c.rejected.length} files are refused in all, each named in rejected` : "";
    return { ...first, message: first.message + also, ...rejectionList(c.rejected) };
  }
  return { migrationId: c.migrationId, instructions: c.instructions, files: c.files, totalBytes: c.totalBytes };
}

/**
 * `POST /provision/import-check` (docs/agent-surface.md "Checking an import first"): the import's own check, for Raft
 * to show which files would not come over before anyone confirms a migration. Validation only: it names no agent,
 * so it reads and writes no agent's object, takes no import's place and changes no import already made. A problem
 * with the body itself answers as the import would; a refused file is listed, in a 200.
 */
function importCheck(body: unknown, tenantId: string, credentialId: string | null, deps: ProvisionDeps): Response {
  const c = importChecked(body, instructionsLimit(deps.seed));
  if (isFail(c)) {
    logEvent("provision.import_check", { tenant: tenantId, credentialId, outcome: "refused", code: c.code, ...(c.param ? { param: c.param } : {}) });
    return fail(c);
  }
  logEvent("provision.import_check", { tenant: tenantId, credentialId, outcome: c.rejected.length ? "rejected" : "ok", files: c.files.length, bytes: c.totalBytes, rejected: c.rejected.length });
  return ok({ ok: !c.rejected.length, ...rejectionList(c.rejected), totals: { files: c.files.length, bytes: c.totalBytes }, limits: IMPORT_LIMITS });
}

/**
 * `POST …/import` (docs/agent-surface.md "Workspace import"): a migrating agent's workspace, written once, all or
 * nothing, in the agent's object (src/store/workspace-import.ts). `instructions`, when sent, are applied after the
 * files land, as a PATCH applies them; the object records whether they were, so a retry of an import whose
 * instructions did not reach the agent finishes it, and a retry after they did never applies them over a later
 * PATCH. One audit line per request that names a live agent: the token's hash, the counts, never a file's content.
 */
async function workspaceImport(
  body: unknown, tenantId: string, row: ProvisionedAgent, credentialId: string | null, deps: ProvisionDeps, imports: ImportOps,
): Promise<Response> {
  const audit = (outcome: string, extra: Record<string, unknown>) =>
    logEvent("provision.import", { tenant: tenantId, agent: row.agentId, raftAgentId: row.raftAgentId, credentialId, outcome, ...extra });
  const req = importRequest(body, instructionsLimit(deps.seed));
  if (isFail(req)) {
    audit("refused", { code: req.code, ...(req.param ? { param: req.param } : {}), ...(req.rejected ? { rejected: req.rejected.length + (req.more ?? 0) } : {}) });
    return fail(req);
  }
  const { migrationId, instructions, files } = req;
  const digest = importDigest(migrationId, instructions ?? null, files.map((f) => ({ path: f.path, bytes: f.bytes, sha256: f.sha256 })));
  let r: Awaited<ReturnType<ImportOps["commit"]>>;
  try { r = await imports.commit(tenantId, row.agentId, { migrationId, digest, instructions: instructions !== undefined, files }); }
  catch (e) {
    audit("failed", { files: files.length, bytes: req.totalBytes });
    throw e;
  }
  if (!r.ok) {
    audit("refused", { code: r.code, files: files.length, bytes: req.totalBytes });
    return fail({ status: r.code === "not_found" ? 404 : r.code === "reserved" ? 422 : 409, code: r.code, message: r.message });
  }
  if (r.record.instructions === "pending" && instructions !== undefined) {
    await deps.registry.update(tenantId, row.raftAgentId, { instructions });
    const adopted = await deps.agent.adopt(tenantId, row.agentId, { name: row.name, instructions, raftOrigin: row.raftOrigin });
    if (adopted) {
      audit("instructions_refused", { code: adopted.code, files: r.record.fileCount, bytes: r.record.bytes });
      return fail(adopted);
    }
    await imports.instructionsApplied(tenantId, row.agentId, migrationId);
  }
  audit(r.created ? "imported" : "replayed", { migrationId, files: r.record.fileCount, bytes: r.record.bytes });
  return ok(importView(r.record, row), r.created ? 201 : 200);
}

/** The same body the first time and on every identical retry: nothing in it changes after the import. */
function importView(rec: ImportRecord, row: ProvisionedAgent) {
  return {
    migrationId: rec.migrationId, providerAgentId: row.agentId, raftAgentId: row.raftAgentId,
    importedAt: new Date(rec.importedAt).toISOString(), fileCount: rec.fileCount, totalBytes: rec.bytes,
    instructions: rec.instructions !== "none", files: rec.files,
  };
}

/**
 * `…/connections/:provider` (raft-agent-provider.v1, optional): POST a one-time link the browser
 * opens to connect the agent to a provider; `/confirm` makes the finished flow a connector of the
 * tenant and points this agent at it; GET what Raft may show (this agent's connection and the
 * tenant's connectors); PUT to point this agent at another connector; DELETE to take it off this
 * agent only. A connector as a whole goes through `DELETE /connectors/:id`. No credential passes
 * here in the clear: the flow in connect.ts seals it, and the handlers carry it only sealed.
 */
/**
 * What a caller is told when a copy of a connection's credential was handed to an agent whose object holds nothing
 * now (its storage wiped), so nothing here can remove it. The operator's cleanup comes first; revoking on GitHub is
 * the last resort, and its reach is said in full: it is the GitHub account's authorization of this App that goes.
 */
export const REVOKE_ON_GITHUB = "a copy of this connection's credential was handed to an agent whose object holds nothing to clear, so it cannot be " +
  "removed here. First choice, once it exists: the operator cleanup of such copies (botiverse/antiproton#1128, planned). Until then, " +
  "the last resort: revoking this App's " +
  "authorization on GitHub invalidates ALL of this GitHub account's tokens for this App, possibly including other connectors and agents, " +
  "which will all need to re-authorise.";

/**
 * A connection route read the agent live, then the agent was deleted before its binding was written (the guarded
 * `put` wrote nothing): the credential just put on its mount is taken off again, and the route answers as for an agent
 * that is not there. A clear that fails is logged; the agent's delete clears its mounts again when repeated.
 */
async function deletedMeanwhile(c: NonNullable<ProvisionDeps["connections"]>, tenantId: string, row: ProvisionedAgent, p: ConnectionProvider,
  byRaft: boolean, id: string): Promise<Response> {
  const cleared = await c.clear(tenantId, row.agentId, p).catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e).slice(0, 200) }));
  logEvent("connect.deleted_meanwhile", { tenantId, agentId: row.agentId, provider: p, mountCleared: cleared.ok, ...(cleared.ok ? {} : { reason: cleared.error }) });
  return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${id}` });
}

/**
 * A connector of the tenant as a token of `raftOrigin` may see it: one that origin made, else null, which every route
 * answers exactly as a connector that does not exist. The only way a provider route reads a connector
 * (test/provision-origin.ts checks it).
 */
// This guards a credential boundary, not a convenience: a connector carries a GitHub credential, and a platform token
// of another Raft origin reaches this tenant by naming the server's id.
async function ownConnector(c: NonNullable<ProvisionDeps["connections"]>, tenantId: string, id: string, raftOrigin: string) {
  const k = await c.connectors.get(tenantId, id);
  return k && k.raftOrigin === raftOrigin ? k : null;
}
/** The tenant's connectors of `provider` that `raftOrigin` made (`ownConnector`). */
async function ownConnectors(c: NonNullable<ProvisionDeps["connections"]>, tenantId: string, provider: string, raftOrigin: string) {
  return (await c.connectors.list(tenantId, provider)).filter((k) => k.raftOrigin === raftOrigin);
}

async function connection(
  method: string, rest: string[], body: unknown, tenantId: string, byRaft: boolean, deps: ProvisionDeps,
  pathAgent: () => Promise<ProvisionedAgent | null>,
): Promise<Response | null> {
  const c = deps.connections;
  if (!c) return null;
  const provider = rest[2]!;
  if (!(CONNECTION_PROVIDERS as readonly string[]).includes(provider)) {
    return fail({ status: 404, code: "unknown_provider", message: `no provider ${provider}; this deployment connects ${CONNECTION_PROVIDERS.join(", ")}` });
  }
  const p = provider as ConnectionProvider;
  const row = await pathAgent();
  if (!row || row.status === "deleted") return fail({ status: 404, code: "not_found", message: `no provisioned agent ${byRaft ? "made from Raft agent " : ""}${rest[0]}` });

  if (rest.length === 4) {
    // Raft calls this server to server after checking that its session is the user the flow was started for,
    // and sends that session's user; the hold is released only for the user it was held for.
    if (method !== "POST") return null;
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const unknown = Object.keys(b).find((k) => k !== "pending" && k !== "raftUserId");
    if (unknown) return fail({ status: 400, code: "unknown_field", message: `unknown field ${unknown}`, param: unknown });
    if (typeof b.pending !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(b.pending)) return fail({ status: 422, code: "invalid", message: "pending is the id Raft was given", param: "pending" });
    if (typeof b.raftUserId !== "string" || !RAFT_ID.test(b.raftUserId)) {
      return fail({ status: 422, code: "invalid", message: "raftUserId is required: the user of Raft's current session", param: "raftUserId" });
    }
    // The id first: the agent's mount records which connector renews it (cf/src/github-refresh.ts).
    const connectorId = c.newId();
    const r = await c.confirm(tenantId, row.agentId, p, b.pending, b.raftUserId, connectorId);
    if (!r.ok) {
      return r.missing
        ? fail({ status: 404, code: "not_found", message: "no pending connection with that id for this agent and user; it may have expired or been used" })
        : fail({ status: 422, code: "connect_failed", message: r.error });
    }
    // The connector to mend came from the hold, sealed in from the signed link, never from this body.
    if (r.reconnect) return reconnectInPlace(tenantId, row, p, b.raftUserId, r.reconnect, { ...r, accountId: r.accountId ?? null, refresh: r.refresh ?? null }, deps);
    // A finished authorization is a new connector of the tenant, created by whoever confirmed it.
    // A plain connect again mends only this agent: a new connector, and this agent's row written afresh, which clears
    // its broken state. A reconnect in place (above) mends the connector for every agent on it.
    const connectedAt = deps.now();
    await c.connectors.create({ id: connectorId, tenantId, provider: p, account: r.account, accountId: r.accountId ?? null, creatorRaftUserId: b.raftUserId,
      raftOrigin: row.raftOrigin, sealed: r.sealed, refresh: r.refresh ?? null, createdAt: connectedAt });
    if (!(await c.registry.put({ tenantId, raftAgentId: row.raftAgentId, provider: p, account: r.account, connectedBy: b.raftUserId, connectedAt, connectorId }))) {
      // Deleted while its connection was confirmed: the connector made for it alone goes with the copy on its mount.
      await c.connectors.remove(tenantId, connectorId);
      return deletedMeanwhile(c, tenantId, row, p, byRaft, rest[0]!);
    }
    await c.connectors.record({ tenantId, connectorId, raftAgentId: row.raftAgentId, action: "create", actingRaftUserId: b.raftUserId, actingRole: "creator", at: connectedAt });
    return ok({ connected: true, connectorId, account: r.account, connectedAt: new Date(connectedAt).toISOString(), connectedBy: b.raftUserId });
  }

  if (method === "POST") {
    const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const allowed = new Set(["returnUrl", "initiatedBy", "access", "connectorId", "actingRole"]);
    const unknown = Object.keys(b).find((k) => !allowed.has(k));
    if (unknown) return fail({ status: 400, code: "unknown_field", message: `unknown field ${unknown}`, param: unknown });
    if (typeof b.returnUrl !== "string") return fail({ status: 422, code: "invalid", message: "returnUrl is required", param: "returnUrl" });
    const where = returnUrlProblem(b.returnUrl, row.raftOrigin);
    if (where) return fail({ status: 422, code: "invalid", message: where, param: "returnUrl" });
    const by = b.initiatedBy && typeof b.initiatedBy === "object" ? (b.initiatedBy as Record<string, unknown>).raftUserId : undefined;
    if (typeof by !== "string" || !RAFT_ID.test(by)) {
      return fail({ status: 422, code: "invalid", message: "initiatedBy.raftUserId is required: the Raft user the connection is for", param: "initiatedBy" });
    }
    if (b.access !== undefined && b.access !== "public" && b.access !== "private") {
      return fail({ status: 422, code: "invalid", message: "access is public or private", param: "access" });
    }
    // A reconnect in place names its connector here, where it is signed into the link: checked now, so a link is
    // never issued for a connector the initiator may not mend, and again at confirm, which may come ten minutes later.
    let reconnect: ReconnectTarget | undefined;
    if (b.connectorId !== undefined) {
      if (typeof b.connectorId !== "string" || !b.connectorId) return fail({ status: 422, code: "invalid", message: "connectorId is the connector to reconnect in place", param: "connectorId" });
      // Raft's claim, unverified: `admin` is taken as said, relying on the caller being Raft (`creatorRefused`,
      // botiverse/antiproton#1122). The connector read below is origin-checked; the role never stands in for that.
      if (b.actingRole !== "creator" && b.actingRole !== "admin") {
        return fail({ status: 422, code: "invalid", message: "actingRole is creator or admin: the capacity Raft checked the initiator reconnects this connector in", param: "actingRole" });
      }
      const k = await ownConnector(c, tenantId, b.connectorId, row.raftOrigin);
      if (!k || k.provider !== p) return fail({ status: 404, code: "not_found", message: `no ${p} connector ${b.connectorId} in this tenant` });
      const refused = creatorRefused(k, { actingRaftUserId: by, actingRole: b.actingRole });
      if (refused) return fail(refused);
      reconnect = { connectorId: k.id, actingRole: b.actingRole };
    } else if (b.actingRole !== undefined) {
      return fail({ status: 422, code: "invalid", message: "actingRole goes with connectorId, for a reconnect in place", param: "actingRole" });
    }
    const scopes = scopesFor(b.access === "private" ? "private" : "public");
    const link = await c.link({ tenantId, agentId: row.agentId, raftAgentId: row.raftAgentId, provider: p, returnUrl: b.returnUrl, raftUserId: by, scopes, ...(reconnect ? { reconnect } : {}) });
    return ok({ ...link, scopes, ...(reconnect ? { reconnect: reconnect.connectorId } : {}) });
  }
  if (method === "GET") {
    const got = await c.registry.get(tenantId, row.raftAgentId, p);
    const current = got?.connectorId ?? null;
    const all = await ownConnectors(c, tenantId, p, row.raftOrigin);
    const connectors = all.map((k) => ({
      id: k.id, account: k.account, creatorRaftUserId: k.creatorRaftUserId, createdAt: new Date(k.createdAt).toISOString(), current: k.id === current,
      ...oauthState(k.brokenAt ?? null, k.lastCheckedAt ?? k.brokenAt ?? k.createdAt),
    }));
    // A connection GitHub refused to renew is not connected, though its row stays: which account it was, and that
    // only connecting again mends it, in the words Raft's own OAuth connectors use (`oauthStatus`).
    const k = current === null ? undefined : all.find((x) => x.id === current);
    // A row with no connector has no checks of its own recorded: its connect, or the refusal that broke it.
    const brokenAt = (k ? k.brokenAt : got?.brokenAt) ?? null;
    const checkedAt = k ? (k.lastCheckedAt ?? k.brokenAt ?? k.createdAt) : (got?.brokenAt ?? got?.connectedAt ?? null);
    return ok({
      ...(got
        ? { connected: brokenAt === null, connectorId: current, account: got.account, connectedAt: new Date(got.connectedAt).toISOString(), connectedBy: got.connectedBy, ...oauthState(brokenAt, checkedAt) }
        : { connected: false, connectorId: null, account: null, connectedAt: null, connectedBy: null, oauthStatus: "disconnected" as OAuthStatus, lastCheckError: null, lastCheckedAt: null }),
      connectors,
    });
  }
  if (method === "PUT") {
    const acting = actingField(body, ["connectorId"]);
    if (isFail(acting)) return fail(acting);
    const connectorId = (body as Record<string, unknown>).connectorId;
    if (typeof connectorId !== "string" || !connectorId) return fail({ status: 422, code: "invalid", message: "connectorId is required", param: "connectorId" });
    const k = await ownConnector(c, tenantId, connectorId, row.raftOrigin);
    if (!k || k.provider !== p) return fail({ status: 404, code: "not_found", message: `no ${p} connector ${connectorId} in this tenant` });
    const refused = creatorRefused(k, acting);
    if (refused) return fail(refused);
    // Its token can no longer be renewed: pointing an agent at it would hand over a connection that cannot work.
    if (k.brokenAt) return fail({ status: 422, code: "connect_failed", message: `${RECONNECT_REASON}: this connector has to be connected again before an agent is pointed at it` });
    const r = await c.attach(tenantId, row.agentId, p, k.sealed, k.refresh ? { ...k.refresh, connectorId: k.id } : null);
    if (!r.ok) return fail({ status: 422, code: "connect_failed", message: r.error });
    const at = deps.now();
    // The attach checked the credential with GitHub and it was taken.
    await c.connectors.checked?.(tenantId, k.id, at);
    if (!(await c.registry.put({ tenantId, raftAgentId: row.raftAgentId, provider: p, account: k.account, connectedBy: acting.actingRaftUserId, connectedAt: at, connectorId: k.id }))) {
      return deletedMeanwhile(c, tenantId, row, p, byRaft, rest[0]!);
    }
    await c.connectors.record({ tenantId, connectorId: k.id, raftAgentId: row.raftAgentId, action: "bind", ...acting, at });
    return ok({ connected: true, connectorId: k.id, account: k.account, connectedAt: new Date(at).toISOString(), connectedBy: acting.actingRaftUserId });
  }
  if (method === "DELETE") {
    const got = await c.registry.get(tenantId, row.raftAgentId, p);
    // The mount cleared first, then the binding, as an agent's delete does it (`clearConnection`): cleared, nothing
    // there, refused (something the key made is still held), the object not answering, or the object holding no such
    // agent. Refused or not answering: the binding is kept, so the next DELETE finds it, and the answer is 409 with
    // `action: "retry_delete"`, not a 204 that says the connection is gone while the mount still holds its credential.
    // Gone: nothing here can reach the copy; the binding goes, and the answer says to revoke on GitHub.
    let error: string | null = null, gone = false, took = false;
    try {
      const r = await c.clear(tenantId, row.agentId, p);
      if (r.ok) took = r.cleared; else { error = r.error; gone = r.gone === true; }
    } catch (e) { error = `the agent's object did not answer: ${String((e as Error)?.message ?? e).slice(0, 160)}`; }
    // With no binding, an object that holds no such agent has nothing on the mount either: a plain clean result.
    if (gone && !got) { error = null; gone = false; }
    const outcome = error === null ? (took ? "cleared" : "none") : "not_cleared";
    const keep = error !== null && !gone;
    if (!keep) await c.registry.remove(tenantId, row.raftAgentId, p);
    // Who asked is optional here: removing a connection from an agent gives nobody an identity. The event is recorded
    // all the same (with the deployment as the actor when none was named), with what became of the mount, and for a
    // connection with no connector too (0032), named by its provider.
    const acting = body === undefined || body === null ? null : actingField(body, []);
    const named = acting && !isFail(acting) ? acting : null;
    await c.connectors.record({ tenantId, connectorId: got?.connectorId ?? null, raftAgentId: row.raftAgentId, provider: p, action: "unbind",
      ...(named ?? { actingRaftUserId: SYSTEM_ACTOR, actingRole: "system" as const }), at: deps.now(),
      reason: JSON.stringify({ outcome, bindingKept: keep, bound: got !== null, actorNamed: named !== null, ...(error ? { error } : {}) }) });
    logEvent("connect.disconnect_agent", { tenantId, agentId: row.agentId, provider: p, outcome, bindingKept: keep });
    if (keep) {
      return Response.json({
        error: { code: "mount_not_cleared", message: got
          ? `the agent's mount still holds the connection's credential (${error}); the connection was kept, DELETE it again`
          : `the agent's mount still holds a credential (${error}), with no connection left to keep; DELETE it again` },
        // The one shape a removal that did not take answers with, here and for a connector's disconnect: 409 (a 502 is
        // retried by many clients on their own), outcome, retry, and the agents it is about.
        outcome: "not_cleared", retry: true, agents: [row.raftAgentId],
        binding: got ? "kept" : "none", mount: "not_cleared", action: "retry_delete" }, { status: 409, headers: { "cache-control": "no-store" } });
    }
    if (gone) {
      return ok({ binding: "removed", mount: "not_cleared", action: "revoke_on_github",
        message: REVOKE_ON_GITHUB });
    }
    return new Response(null, { status: 204 });
  }
  return null;
}

/**
 * `POST …/confirm` for a link made with `connectorId`: the connector is mended in place rather than replaced. The
 * authorization must be the connector's own GitHub account — by GitHub's numeric user id, which a rename does not
 * change; by login for a connector made before the id was kept (0024) — or nothing changes (`409 account_mismatch`),
 * so the agents on it can never start acting as someone else. Who may: the connector's creator, or an admin by Raft's
 * word, as for `DELETE /connectors/:id`.
 *
 * Then, in order: the new pair over the connector's in one D1 write, which also clears its broken state and any
 * renewal's lease (`ConnectorStore.reconnect`); the pair onto every agent pointed at it, and onto this one, which is
 * pointed at it if it was not. An agent the pair does not reach here is named in `failed`: its mount still says
 * broken, and its next GitHub call asks the connector, finds it healthy and takes the pair (github-refresh.ts).
 */
async function reconnectInPlace(
  tenantId: string, row: ProvisionedAgent, p: ConnectionProvider, raftUserId: string, target: ReconnectTarget,
  r: { account: string | null; accountId: string | null; sealed: { ciphertext: string; iv: string }; refresh: ConnectorRefresh | null },
  deps: ProvisionDeps,
): Promise<Response> {
  const c = deps.connections!;
  const acting: Acting = { actingRaftUserId: raftUserId, actingRole: target.actingRole };
  const k = await ownConnector(c, tenantId, target.connectorId, row.raftOrigin);
  if (!k || k.provider !== p) return fail({ status: 404, code: "not_found", message: `no ${p} connector ${target.connectorId} in this tenant; it may have been disconnected since the link was made` });
  const refused = creatorRefused(k, acting);
  if (refused) return fail(refused);
  if (!r.accountId) return fail({ status: 422, code: "connect_failed", message: "GitHub did not say which account was authorized, so the connector was not changed" });
  const same = k.accountId ? k.accountId === r.accountId : !!k.account && !!r.account && k.account.toLowerCase() === r.account.toLowerCase();
  const mismatch = () => fail({ status: 409, code: "account_mismatch",
    message: `this connector is GitHub account ${k.account ?? "(unknown)"}, and the authorization was for ${r.account ?? "another account"}; nothing was changed. Sign in to GitHub as ${k.account ?? "the connector's account"} and reconnect, or connect without connectorId to make a new connector` });
  if (!same) return mismatch();
  const at = deps.now();
  if (!(await c.connectors.reconnect(tenantId, k.id, { sealed: r.sealed, refresh: r.refresh, account: r.account, accountId: r.accountId, at }))) {
    // Gone, or given another account's id, between the read and the write.
    const now = await ownConnector(c, tenantId, k.id, row.raftOrigin);
    return now ? mismatch() : fail({ status: 404, code: "not_found", message: `no ${p} connector ${k.id} in this tenant; it was disconnected meanwhile` });
  }
  await c.connectors.record({ tenantId, connectorId: k.id, raftAgentId: row.raftAgentId, action: "reconnect", ...acting, at });
  const updated: string[] = [];
  const failed: Array<{ raftAgentId: string; error: string }> = [];
  const bound = await c.registry.boundTo(tenantId, k.id);
  for (const raftAgentId of bound) {
    try {
      const a = raftAgentId === row.raftAgentId ? row : await deps.registry.get(tenantId, raftAgentId);
      // Another Raft origin's agent on the same connector is not this origin's to change, and an agent no longer live
      // (deleted, its binding kept for a retried delete to find) is handed no new credential.
      if (!a || a.raftOrigin !== row.raftOrigin || !(LIVE_AGENT_STATUSES as readonly string[]).includes(a.status)) continue;
      const got = await c.reconnect(tenantId, a.agentId, p, k.id, k.sealed, r.sealed, r.refresh);
      if (!got.ok) { failed.push({ raftAgentId, error: got.error }); continue; }
      if (got.updated) updated.push(raftAgentId);
    } catch (e) {
      failed.push({ raftAgentId, error: String((e as { message?: unknown })?.message ?? e).slice(0, 200) });
    }
  }
  // This agent ends on the connector: pointed at it if it was not, and given the pair if its mount held something else
  // (a key put there since) — the person reconnected from this agent's page. The same attach a PUT makes.
  let connected = updated.includes(row.raftAgentId);
  if (!connected && !failed.some((f) => f.raftAgentId === row.raftAgentId)) {
    const got = await c.attach(tenantId, row.agentId, p, r.sealed, r.refresh ? { ...r.refresh, connectorId: k.id } : null)
      .catch((e: unknown) => ({ ok: false as const, error: String((e as { message?: unknown })?.message ?? e).slice(0, 200) }));
    if (got.ok) { connected = true; updated.push(row.raftAgentId); }
    else failed.push({ raftAgentId: row.raftAgentId, error: got.error });
  }
  if (connected) {
    // Written afresh, which clears a broken state kept on this agent's own row. Deleted meanwhile: the pair just put on
    // its mount is taken off again, and it is not connected.
    if (!(await c.registry.put({ tenantId, raftAgentId: row.raftAgentId, provider: p, account: r.account, connectedBy: raftUserId, connectedAt: at, connectorId: k.id }))) {
      const cleared = await c.clear(tenantId, row.agentId, p).catch((e: unknown) => ({ ok: false as const, error: String((e as Error)?.message ?? e).slice(0, 200) }));
      logEvent("connect.deleted_meanwhile", { tenantId, agentId: row.agentId, provider: p, mountCleared: cleared.ok });
      connected = false;
      if (updated.includes(row.raftAgentId)) updated.splice(updated.indexOf(row.raftAgentId), 1);
      failed.push({ raftAgentId: row.raftAgentId, error: "the agent was deleted while it was being connected" });
    } else if (!bound.includes(row.raftAgentId)) await c.connectors.record({ tenantId, connectorId: k.id, raftAgentId: row.raftAgentId, action: "bind", ...acting, at });
  }
  logEvent("connect.reconnect", { tenantId, connectorId: k.id, raftAgentId: row.raftAgentId, actingRole: acting.actingRole, updated: updated.length, failed: failed.length });
  return ok({
    connected, reconnected: true, connectorId: k.id, account: r.account, connectedAt: new Date(at).toISOString(), connectedBy: raftUserId,
    updated: updated.sort(), failed,
  });
}

/**
 * A connection's state in the words Raft's managed-MCP OAuth connectors use (0023): `error` once GitHub refused to
 * renew it, with the reason Raft shows; `lastCheckedAt` the last check whatever came of it.
 */
function oauthState(brokenAt: number | null, checkedAt: number | null):
  { oauthStatus: OAuthStatus; lastCheckError: string | null; lastCheckedAt: string | null } {
  return {
    oauthStatus: brokenAt === null ? "connected" : "error",
    lastCheckError: brokenAt === null ? null : RECONNECT_REASON,
    lastCheckedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
  };
}

type Acting = { actingRaftUserId: string; actingRole: "creator" | "admin" };

/** `{ actingRaftUserId, actingRole }` plus the named fields and nothing else: the session user Raft checked, and in what capacity. */
function actingField(body: unknown, also: string[]): Acting | Fail {
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const allowed = new Set(["actingRaftUserId", "actingRole", ...also]);
  const unknown = Object.keys(b).find((k) => !allowed.has(k));
  if (unknown) return { status: 400, code: "unknown_field", message: `unknown field ${unknown}`, param: unknown };
  if (typeof b.actingRaftUserId !== "string" || !RAFT_ID.test(b.actingRaftUserId)) {
    return { status: 422, code: "invalid", message: "actingRaftUserId is required: the user of Raft's current session", param: "actingRaftUserId" };
  }
  if (b.actingRole !== "creator" && b.actingRole !== "admin") {
    return { status: 422, code: "invalid", message: "actingRole is creator or admin", param: "actingRole" };
  }
  return { actingRaftUserId: b.actingRaftUserId, actingRole: b.actingRole };
}

/**
 * Pointing an agent at a connector hands it that account's identity, so only its creator or a server
 * admin may. Raft checks both before calling, and only Raft knows who is an admin; a claim to be the
 * creator can be checked here as well, and is.
 *
 * `actingRole` is the capacity Raft claims for its session's user, and is not verified here: `admin` passes
 * unchecked, relying on the caller being Raft, the same trust as `decidedBy.role` on an approval, with the provider
 * token as the anchor. It is never what keeps another Raft origin out; that is the origin check (`agentAt`,
 * `ownConnector`). What rests on one platform token per deployment: botiverse/antiproton#1122.
 */
function creatorRefused(k: { creatorRaftUserId: string }, acting: Acting): Fail | null {
  if (acting.actingRole === "creator" && acting.actingRaftUserId !== k.creatorRaftUserId) {
    return { status: 403, code: "not_creator", message: "actingRole is creator, but this connector was created by someone else" };
  }
  return null;
}

/**
 * `DELETE /connectors/:id`: the connector goes, and with it the credential on every agent pointed at it.
 * The connector is removed only once every agent has been detached: a partial failure answers 502 with
 * the agents still holding it, and the same call finishes the job.
 */
async function disconnect(tenantId: string, connectorId: string, body: unknown, deps: ProvisionDeps, who: ProviderTokenIdentity): Promise<Response> {
  const c = deps.connections;
  if (!c) return fail({ status: 404, code: "not_found", message: "this deployment has no connectors" });
  const acting = actingField(body, []);
  if (isFail(acting)) return fail(acting);
  const k = await ownConnector(c, tenantId, connectorId, who.raftOrigin);
  if (!k) return fail({ status: 404, code: "not_found", message: `no connector ${connectorId} in this tenant` });
  const refused = creatorRefused(k, acting);
  if (refused) return fail(refused);
  const provider = k.provider as ConnectionProvider;
  // Not atomic with a PUT that lands between `boundTo` and the delete below: that agent keeps a copy of
  // the credential and a connectorId that no longer exists, until it is pointed elsewhere or disconnected.
  //
  // Every agent bound to it gives the credential up, another origin's too: one bound before connectors had an origin
  // (0030) holds this origin's credential, which is this origin's to take back. First by the connector's own
  // credential, by value or by what renews it (`detachIfFrom`). When the mount holds nothing of the connector's:
  //  - another origin's agent is cleared by the agent (`clear`): it may hold an older copy, a non-expiring token from
  //    before a reconnect in place, which skips another origin's agents;
  //  - this origin's agent keeps what it holds, which is not the connector's: a key put on the mount since, in the
  //    console, clears what renewed it, and is the person's, not the connector's to take.
  // Each agent ends one of these ways, as a single connection's removal does (`DELETE …/connections/{provider}`):
  //  - detached: this origin's agent, the connector's credential removed, or none there;
  //  - kept: this origin's agent holding another credential, left as it is and said so;
  //  - cleared elsewhere: another origin's agent, its copy removed, but that origin has held a working token;
  //  - failed: refused (something the key made is still held) or not answered (usually passing): its binding is kept,
  //    and so is the connector, the only handles a retry has; the answer is 502 with `action: "retry_delete"`;
  //  - revoke: the object holds no such agent (wiped), so nothing here can reach what it was handed: the binding goes,
  //    and the answer says what to do (`REVOKE_ON_GITHUB`).
  // Each is recorded as an `unbind` event with its outcome. Another origin's agents are counted in the answer and
  // named only in the log: their ids are that origin's.
  const detached: string[] = [];
  const kept: string[] = [];
  const failed: Array<{ raftAgentId: string; error: string; action: "retry_delete" }> = [];
  const revoke: string[] = [];
  const elsewhere: string[] = [];
  const elsewhereFailed: Array<{ raftAgentId: string; error: string }> = [];
  const elsewhereRevoke: string[] = [];
  const asText = (e: unknown) => String((e as { message?: unknown })?.message ?? e).slice(0, 200);
  for (const raftAgentId of await c.registry.boundTo(tenantId, k.id)) {
    const row = await deps.registry.get(tenantId, raftAgentId).catch(() => undefined);
    const ours = !row || row.raftOrigin === who.raftOrigin;
    // What became of this agent's copy: cleared, none of the connector's there, held another, not cleared, or gone.
    let end: { outcome: "cleared" | "none" | "other" | "not_cleared" | "gone"; error?: string };
    if (row === undefined) end = { outcome: "not_cleared", error: "the agent could not be read" };
    else if (row === null) end = { outcome: "none" };
    else {
      try {
        const r = await c.detachIfFrom(tenantId, row.agentId, provider, k.sealed, k.id);
        if (!r.ok) end = r.gone ? { outcome: "gone", error: r.error } : { outcome: "not_cleared", error: r.error };
        else if (r.removed) end = { outcome: "cleared" };
        else if (ours) end = { outcome: r.other ? "other" : "none" };
        else {
          const by = await c.clear(tenantId, row.agentId, provider);
          end = by.ok ? { outcome: by.cleared ? "cleared" : "none" } : by.gone ? { outcome: "gone", error: by.error } : { outcome: "not_cleared", error: by.error };
        }
      } catch (e) { end = { outcome: "not_cleared", error: `the agent's object did not answer: ${asText(e)}` }; }
    }
    const keepBinding = end.outcome === "not_cleared";
    try {
      if (!keepBinding) await c.registry.remove(tenantId, raftAgentId, provider);
    } catch (e) { end = { outcome: "not_cleared", error: asText(e) }; }
    const bindingKept = end.outcome === "not_cleared";
    await c.connectors.record({ tenantId, connectorId: k.id, raftAgentId, provider, action: "unbind", ...acting, at: deps.now(),
      reason: JSON.stringify({ via: "disconnect", outcome: end.outcome === "other" ? "none" : end.outcome === "gone" ? "not_cleared" : end.outcome,
        bindingKept, ...(end.outcome === "other" ? { heldAnother: true } : {}), ...(end.error ? { error: end.error } : {}) }) });
    if (bindingKept) {
      if (ours) failed.push({ raftAgentId, error: end.error ?? "not cleared", action: "retry_delete" });
      else elsewhereFailed.push({ raftAgentId, error: end.error ?? "not cleared" });
    } else if (end.outcome === "gone") (ours ? revoke : elsewhereRevoke).push(raftAgentId);
    else if (end.outcome === "other") kept.push(raftAgentId);
    else (ours ? detached : elsewhere).push(raftAgentId);
  }
  const otherOrigins = elsewhere.length || elsewhereFailed.length || elsewhereRevoke.length ? {
    otherOrigins: {
      cleared: elsewhere.length, failed: elsewhereFailed.length, ...(elsewhereRevoke.length ? { revoke: elsewhereRevoke.length } : {}),
      // The revoke hint only when something needs a person: another origin's object was wiped, so its copy could not be
      // reached. A copy removed here (the common case) needs nobody.
      message: "agents of another Raft origin held this connector's credential: their copies are removed here, but that origin has had a working token" +
        (elsewhereRevoke.length ? `. ${REVOKE_ON_GITHUB}` : ""),
    },
  } : {};
  const revokeOnGithub = revoke.length ? { revokeOnGithub: { agents: revoke, action: "revoke_on_github" as const, message: REVOKE_ON_GITHUB } } : {};
  logEvent("connect.disconnect", { tenantId, connectorId: k.id, detached: detached.join(" "), kept: kept.join(" "), failed: failed.map((f) => f.raftAgentId).join(" "),
    revoke: revoke.join(" "), clearedElsewhere: elsewhere.join(" "), failedElsewhere: elsewhereFailed.map((f) => f.raftAgentId).join(" "),
    revokeElsewhere: elsewhereRevoke.join(" "), errors: [...failed, ...elsewhereFailed].map((f) => f.error).join(" | ").slice(0, 500) });
  if (failed.length || elsewhereFailed.length) {
    return Response.json({
      error: { code: "partially_disconnected", message: "some agents still hold this connector's credential; their bindings and the connector were kept, and the same call finishes the job" },
      // As a single connection's removal answers it (409, outcome, retry, agents): this origin's agents by id, another
      // origin's counted under `otherOrigins`.
      outcome: "not_cleared", retry: true, agents: failed.map((f) => f.raftAgentId),
      detached, ...(kept.length ? { kept } : {}), failed, ...revokeOnGithub, ...otherOrigins,
    }, { status: 409, headers: { "cache-control": "no-store" } });
  }
  await c.connectors.remove(tenantId, k.id);
  await c.connectors.record({ tenantId, connectorId: k.id, raftAgentId: null, action: "disconnect", ...acting, at: deps.now() });
  return ok({ disconnected: true, connectorId: k.id, detached, ...(kept.length ? { kept } : {}), ...revokeOnGithub, ...otherOrigins });
}

/**
 * The name these routes give what runs: the offered option's id when one names it, else `<provider>/<model>` — the
 * Agents API's name (cf/src/agents-api/model.ts `modelName`), so an admin's model no option names still reads as itself.
 */
function modelView(choice: ModelChoice, um: UserModels): { model: string; label: string } {
  const o = optionFor(um, choice);
  return o ? { model: o.id, label: o.label } : { model: `${choice.provider}/${choice.model}`, label: choice.model };
}

/**
 * `GET /provision/models`: what Raft's model picker may offer. Each option's id, label and provider id — fields named
 * one by one, so a field added to UserModel later does not reach Raft by default — and never a model's address, a
 * gateway or a secret. `default` is what an agent that follows the default runs on in this tenant (the admin's tenant
 * or deployment row, else HARNESS_MODEL), named as `modelView` names it; `locked` says a tenant row decides every agent
 * of the tenant, so no pick would run. `pickerEnabled` is the server's switch as stored: where the deployment enforces it
 * (`enforcePicker`), whether a pick other than the deployment's default is taken (`pickerProblem`); elsewhere every
 * offered pick is taken whatever it says. The options are listed either way, so a reader written before the switch
 * keeps working.
 */
async function modelList(tenantId: string, m: ProvisionModels) {
  // `layers` with no agent reads the tenant's and the deployment's rows: the agent clause names agent_id '', which is
  // the tenant row itself.
  const r = resolveModel({ ...(await m.choices.layers(tenantId, "")), agent: null, owner: null }, m.userModels, m.defaultModel);
  const d = modelView(r.choice, m.userModels);
  return {
    models: m.userModels.offered.map((o) => ({ id: o.id, label: o.label, provider: o.provider })),
    default: d.model, defaultLabel: d.label, locked: r.locked, pickerEnabled: await m.picker.enabled(tenantId),
  };
}

/**
 * `GET|PUT …/model`: one agent's model as Raft's Agent Panel shows and sets it. PUT `{ model: "<id>" }` picks an
 * offered option; `{ model: null }` follows the default again. Stored as the owner's pick (model_choices), with the
 * provider token's hash as who set it, and bound at once (AgentDO.rebindModel), so the agent's next model call runs on
 * it; a harness already open is rebuilt for its next turn because the binding is in its key (cf/src/runtime.ts
 * `harnessKey`).
 *
 * Precedence is resolveModel's: an admin's agent or tenant row outranks the pick, and while one applies (`locked`) a
 * PUT is refused with 409 rather than stored to no effect — as the console's picker and the Agents API refuse it. An
 * admin's deployment row is below the pick, so it reads as source "admin" without locking.
 */
async function modelRoute(
  method: string, body: unknown, tenantId: string, found: ProvisionedAgent, credentialId: string | null, m: ProvisionModels,
  registry: Pick<ProvisionRegistry, "update">, now: () => number,
): Promise<Response | null> {
  const agentId = found.agentId;
  const state = async () => {
    const r = resolveModel(await m.choices.layers(tenantId, agentId), m.userModels, m.defaultModel);
    return { ...modelView(r.choice, m.userModels), source: r.source === "owner" ? "chosen" : r.source, locked: r.locked };
  };
  if (method === "GET") return ok(await state());
  if (method !== "PUT") return null;
  const b = (body && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => k !== "model");
  if (unknown) return fail({ status: 400, code: "unknown_field", message: `unknown field ${unknown}`, param: unknown });
  if (!("model" in b)) return fail({ status: 422, code: "missing", message: "model is required: an offered option's id, or null for the default", param: "model" });
  const asked = b.model;
  if (asked !== null && typeof asked !== "string") {
    return fail({ status: 422, code: "invalid", message: "model is an offered option's id, or null for the default", param: "model" });
  }
  const locked = await lockedProblem(m, tenantId, agentId);
  if (locked) return fail(locked);
  let pick = asked;
  if (asked !== null && await pickerOff(m, tenantId)) {
    const layers = await m.choices.layers(tenantId, agentId);
    // The pick the agent already has is asked first, and taken as it is: an agent that chose while the picker was on
    // keeps its model, a retried PUT of it is not a new choice, and — even when that pick is the default's id — a
    // repeat must not turn a stored choice into none, which would hand the agent to an operator's deployment row.
    if (asked !== layers.owner) {
      // Otherwise the default is taken, as following the default (null): a stored pick of it would outrank an operator's
      // deployment row. Anything else is refused.
      const ids = defaultIds(m, layers);
      if (ids.includes(asked)) pick = null;
      else return fail(notOffered(m.userModels, asked) ?? pickerProblem(asked, ids));
    }
  }
  if (pick !== null) {
    const unknownModel = notOffered(m.userModels, pick);
    if (unknownModel) return fail(unknownModel);
  }
  // The owner has chosen, so an interrupted create's pick is settled: its delayed replay must not store the create's
  // model over this one (`settlePick`). Cleared first: a PUT that fails after it is retried, and the replay then stores
  // nothing rather than the older value.
  if (found.modelPending) await registry.update(tenantId, found.raftAgentId, { modelPending: false });
  await storePick(m, tenantId, agentId, pick, credentialId, now);
  // Not the request's failure: the pick is stored, and the next path that binds (a message, a page open) binds it anyway.
  await m.rebind(tenantId, agentId).catch((e: unknown) => console.warn(`rebinding ${agentId} after a provider pick failed: ${String((e as Error)?.message ?? e).slice(0, 200)}`));
  return ok(await state());
}

/** Only an id offered now: one listed once, or whose provider has no secret, would be stored and passed over at every run. */
function notOffered(um: UserModels, asked: string): Fail | null {
  if (um.offered.some((o) => o.id === asked)) return null;
  const ids = um.offered.map((o) => JSON.stringify(o.id)).join(", ");
  return { status: 422, code: "unknown_model", param: "model",
    message: `no model option ${JSON.stringify(asked.slice(0, 64))} is offered here; ${ids ? `one of ${ids}, ` : ""}or null for the default` };
}

/**
 * Whether a provider pick other than the default is held to the tenant's switch: only where the deployment enforces it
 * (`enforcePicker`), and the switch is off. Not enforced, the switch is not even read, and every pick is judged as it
 * was before the switch existed.
 */
async function pickerOff(m: ProvisionModels, tenantId: string): Promise<boolean> {
  return m.enforcePicker && !(await m.picker.enabled(tenantId));
}

/** The offered option that names the deployment's default (HARNESS_MODEL under DEFAULT_PROVIDER); null when none does. */
function defaultOption(m: ProvisionModels): string | null {
  return optionFor(m.userModels, choiceOf(null, m.defaultModel))?.id ?? null;
}

/**
 * A provider pick of another model than the default while the tenant's picker is off. 403, not 409: no change of state
 * here makes it acceptable, only the server's switch (`PUT /servers/:raftServerId/model-picker`). An operator's rows
 * (model_overrides, /admin/models) are not provider picks and are never refused by it.
 */
function pickerProblem(asked: string, accepted: string[]): Fail {
  const ids = accepted.map((id) => JSON.stringify(id)).join(" or ");
  return { status: 403, code: "model_picker_disabled", param: "model",
    message: `choosing a model is not enabled for this Raft server, so ${JSON.stringify(asked.slice(0, 64))} cannot be picked; omit model, or send null${ids ? ` or ${ids}` : ""}, and the default runs` };
}

/**
 * The ids taken as "follow the default" while the picker is off: the option naming HARNESS_MODEL, and the id the routes
 * report as what the default is for this agent now (`default` of GET /provision/models, `model` of GET …/model before a
 * pick) — which an operator's deployment, tenant or agent row may make another model, so a client echoing it back is
 * not refused. Taken as no pick, so the operator's rows go on deciding.
 */
function defaultIds(m: ProvisionModels, layers: ModelLayers): string[] {
  const now = modelView(resolveModel({ ...layers, owner: null }, m.userModels, m.defaultModel).choice, m.userModels).model;
  return [...new Set([defaultOption(m), now].filter((id): id is string => id !== null))];
}

/** An admin's agent or tenant row decides this agent's model, so a pick would be stored and never run. */
async function lockedProblem(m: ProvisionModels, tenantId: string, agentId: string): Promise<Fail | null> {
  const current = resolveModel(await m.choices.layers(tenantId, agentId), m.userModels, m.defaultModel);
  if (!current.locked) return null;
  return { status: 409, code: "model_locked", param: "model",
    message: `an administrator has set this agent's model to ${JSON.stringify(modelView(current.choice, m.userModels).model)}, so it cannot be chosen here` };
}

/**
 * The one way a provider's pick is written, by `PUT …/model` and by `POST /agents` with `model`: the owner's row with
 * the provider token's hash as who set it, and one `provision.model` line naming the token by that hash.
 */
async function storePick(m: ProvisionModels, tenantId: string, agentId: string, asked: string | null, credentialId: string | null, now: () => number) {
  if (asked === null) await m.choices.remove(tenantId, agentId);
  else await m.choices.put({ tenantId, agentId, choiceId: asked, setBy: `provider:${credentialId ?? "unknown"}`, setAt: now() });
  logEvent("provision.model", { tenant: tenantId, agent: agentId, model: asked, credentialId });
}

/**
 * `model` of a POST, by type only: an id, or null when it is null or absent, which is today's create exactly (nothing to
 * store). Whether the id may be taken is `createPick`'s, asked of a first create only.
 */
function createModelField(body: unknown): string | null | Fail {
  const v = field(body, "model");
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return { status: 422, code: "invalid", message: "model is an offered option's id, or null for the default", param: "model" };
  return v;
}

/**
 * Whether a first create may be made on `model`, and the pick it stores: offered here now; while the tenant's picker is
 * off, only a default's id (`defaultIds`), stored as no pick at all (so an admin's rows decide, and no lock refuses it —
 * hosted agents send the default by name); otherwise no admin's agent or tenant row deciding the agent's model. A deployment without
 * the model routes offers nothing, so any id is unknown there — refused, never ignored, since an agent quietly made on
 * the default would run on a model nobody chose.
 */
async function createPick(
  m: ProvisionModels | undefined, tenantId: string, agentId: string, model: string, kept: string | null = null,
): Promise<{ pick: string | null } | Fail> {
  if (!m) return { status: 422, code: "unknown_model", param: "model", message: "this deployment offers no choice of model; omit model, or send null, for the default" };
  // `kept`: the model a create already asked for and was let through on (a reopened create, below). Its replay repeats a
  // choice made while it was allowed, as a grandfathered agent's PUT of its own pick does, so the switch does not apply.
  if (model !== kept && await pickerOff(m, tenantId)) {
    const ids = defaultIds(m, await m.choices.layers(tenantId, agentId));
    if (ids.includes(model)) return { pick: null };
    return notOffered(m.userModels, model) ?? pickerProblem(model, ids);
  }
  return notOffered(m.userModels, model) ?? await lockedProblem(m, tenantId, agentId) ?? { pick: model };
}

/**
 * Make the stored pick the create's (`pick`, from `createPick`), while it is not settled yet, then mark it settled.
 * Unconditional on the value: a create that stored one model and died before settling, reopened with none, must not
 * leave the first one stored to run once a lock lifts — null removes it.
 */
async function settlePick(deps: ProvisionDeps, row: ProvisionedAgent, pick: string | null, credentialId: string | null): Promise<ProvisionedAgent> {
  if (!row.modelPending) return row;
  await storePick(deps.models!, row.tenantId, row.agentId, pick, credentialId, deps.now);
  await deps.registry.update(row.tenantId, row.raftAgentId, { modelPending: false });
  return { ...row, modelPending: false };
}

/** The setup routes, after the agent's id. */
const EVAL_ROUTES = new Set(["seed", "seed/seal", "seed/manifest", "fresh-context", "restart", "model-input", "tools", "transcript", "trace"]);

/**
 * An evaluation's setup (EVAL_SEED_ROUTES): files put in the agent's workspace before it first runs, the seal that
 * ends that window, a fresh main conversation or an ordinary restart of the same one, what the model was sent, and the
 * tools its next turn is offered. The rules of a file are src/store/seed-files.ts's; the one checked only here is the credential
 * shape, which lives with the Worker (cf/src/secret-shape.ts). Each change leaves one log line naming the token it
 * came by (its hash, the name the operator's listing gives it), never the token or a file's text.
 */
async function evalSetup(
  method: string, route: string, tenantId: string, agentId: string, query: URLSearchParams, raw: Uint8Array | null,
  credentialId: string | null, seed: SeedOps,
  reads: { audit: ReadAudit | null; reason: string | null } = { audit: null, reason: null },
): Promise<Response | null> {
  // The two exports of what the model was told are audited (cf/src/read-audit.ts), and refused for a personal
  // assistant, whose conversation holds what it read of its owner's Raft: theirs alone, not an evaluation's.
  const readRow = (route: string, session: string | null) => ({
    route: `provision:${route}`, tenantId, agentId, session, tokenKind: "provider", tokenLabel: credentialId, reason: reads.reason, assistant: false,
  });
  const assistantPrivate = async (route: string, session: string | null) => {
    await auditRefused(reads.audit, { ...readRow(route, session), assistant: true });
    return fail({ status: 403, code: "assistant_private", message: `agent ${agentId} is a personal assistant: what it read of its owner's Raft is theirs alone, so its ${route} is not exported` });
  };
  const isPrivate = (r: unknown) => !!r && typeof r === "object" && "assistantPrivate" in r;
  const audit = (op: string, fields: Record<string, string | number | boolean | null>) =>
    logEvent("eval.seed", { tenant: tenantId, agent: agentId, op, ...fields, credentialId });
  const gone = () => fail({ status: 404, code: "not_found", message: `no agent ${agentId} in this object` });
  if (route === "seed" && method === "PUT") {
    const path = query.get("path");
    const problem = seedPathProblem(path);
    if (problem) return fail({ status: 422, code: "invalid", message: problem, param: "path" });
    // The working set's documents are shown to the agent as written by it (src/plugins/state.ts `workingSet`); a
    // seeded file under one of their keys would reach its prompt as its own notes.
    if (WORKING_SET.some((d) => d.key === path)) {
      return fail({ status: 400, code: "reserved", param: "path",
        message: `${path} is one of the agent's own working-set documents (${WORKING_SET.map((d) => d.key).join(", ")}), shown to it as written by it; seed under another path` });
    }
    const mode = query.get("mode") ?? "writable";
    if (!(SEED_MODES as readonly string[]).includes(mode)) return fail({ status: 422, code: "invalid", message: `mode is ${SEED_MODES.join(" or ")}`, param: "mode" });
    const body = seedText(raw ?? new Uint8Array());
    if ("problem" in body) return fail({ status: body.status, code: body.status === 413 ? "too_large" : "invalid", message: body.problem });
    const shape = secretShape(body.text);
    if (shape) return fail({ status: 422, code: "credential_in_text", message: `the file carries what looks like a ${shape}; credentials are never seeded` });
    const r = await seed.write(tenantId, agentId, { path: path!, mode: mode as SeedMode, text: body.text });
    if (!r.ok) {
      audit("write", { path: path!, outcome: r.code });
      if (r.code === "not_found") return gone();
      return fail(r.code === "sealed"
        ? { status: 409, code: "sealed", message: r.message }
        : { status: 413, code: "too_large", message: r.message });
    }
    audit("write", { path: r.file.path, mode: r.file.mode, sha256: r.file.sha256, bytes: r.file.bytes, changed: r.changed, outcome: "ok" });
    return ok({ ...r.file, changed: r.changed });
  }
  const sealView = (s: SeedSeal) => ({
    manifest: s.manifest, toolConfig: s.toolConfig, manifestSha256: s.manifestSha256, sealedAt: new Date(s.sealedAt).toISOString(), how: s.how,
  });
  if (route === "seed/seal" && method === "POST") {
    const s = await seed.seal(tenantId, agentId, credentialId);
    return s ? ok(sealView(s)) : gone();
  }
  if (route === "seed/manifest" && method === "GET") {
    const m = await seed.manifest(tenantId, agentId);
    if (!m) return gone();
    // Once sealed, the manifest is the one the seal closed on, which is also what the files still are.
    return ok(m.seal ? { sealed: true, ...sealView(m.seal) } : { sealed: false, manifest: m.manifest, toolConfig: m.toolConfig, manifestSha256: m.manifestSha256, sealedAt: null, how: null });
  }
  if (route === "fresh-context" && method === "POST") {
    const r = await seed.freshContext(tenantId, agentId);
    if (!r.ok) return fail({ status: r.status, code: r.status === 404 ? "not_found" : "busy", message: r.error });
    audit("fresh-context", { oldSessionId: r.oldSessionId, newSessionId: r.newSessionId });
    return ok({ oldSessionId: r.oldSessionId, newSessionId: r.newSessionId });
  }
  // Not a fresh context: the same conversation, rebuilt from storage as after an eviction.
  if (route === "restart" && method === "POST") {
    const r = await seed.restart(tenantId, agentId);
    if (!r.ok) return fail({ status: r.status, code: r.status === 404 ? "not_found" : "busy", message: r.error });
    audit("restart", { sessionId: r.sessionId });
    return ok({ sessionId: r.sessionId, restartedAt: new Date(r.restartedAt).toISOString() });
  }
  if (route === "model-input" && method === "GET") {
    const session = query.get("session");
    const callText = query.get("call");
    const call = callText === null ? null : Number(callText);
    if (call !== null && !(Number.isInteger(call) && call >= 1)) return fail({ status: 422, code: "invalid", message: "call is a whole number from 1", param: "call" });
    const r = await seed.modelInput(tenantId, agentId, session, call);
    if (isPrivate(r)) return assistantPrivate(route, session);
    if (!r) return fail({ status: 404, code: "not_found", message: session === null ? `no agent ${agentId}` : `no recorded call ${call ?? 1} of session ${session}` });
    const refused = await auditRead(reads.audit, readRow(route, session));
    if (refused) return refused;
    return ok(r);
  }
  // What the next turn offers the model, as its harness would be built now (cf/src/runtime.ts `offeredTools`).
  if (route === "tools" && method === "GET") {
    const r = await seed.tools(tenantId, agentId);
    return r ? ok(r) : gone();
  }
  // The two exports: read-only, and walked whole for credentials before they leave (cf/src/eval-read.ts): in the
  // agent's object, with its own sealed values, and once more here. Each read logs one line, never its content.
  const read = (fields: Record<string, string | number | null>) =>
    logEvent("eval.read", { tenant: tenantId, agent: agentId, ...fields, credentialId });
  if (route === "transcript" && method === "GET") {
    const limit = wholeParam(query, "limit", TRANSCRIPT_LIMIT_DEFAULT, 1, TRANSCRIPT_LIMIT_MAX);
    if (isFail(limit)) return fail(limit);
    const offset = wholeParam(query, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
    if (isFail(offset)) return fail(offset);
    const session = query.get("session") || null;
    if (session !== null && !MAIN_SESSION_ID.test(session)) {
      return fail({ status: 422, code: "invalid", message: "session is a main conversation's id: main or main.<n>", param: "session" });
    }
    const got = await seed.transcript(tenantId, agentId, session, offset, limit);
    if (isPrivate(got)) return assistantPrivate(route, session);
    const r = got as EvalTranscript | { unavailable: string } | null;
    if (!r) return fail({ status: 404, code: "not_found", message: session === null ? `no agent ${agentId}` : `no conversation ${session} of agent ${agentId}` });
    if ("unavailable" in r) return fail({ status: 503, code: "unavailable", message: r.unavailable });
    const body = redacted(r);
    const refused = await auditRead(reads.audit, readRow(route, r.sessionId));
    if (refused) return refused;
    read({ route, session: r.sessionId, cursor: offset, count: r.shown, redactions: body.redactions });
    return ok(body);
  }
  if (route === "trace" && method === "GET") {
    const now = Date.now();
    const fromText = query.get("from"), toText = query.get("to");
    // Exclusive at its end, so the default reaches a row that ended this millisecond.
    const to = toText === null ? (fromText === null ? now + 1 : null) : instant(toText);
    const from = fromText === null ? null : instant(fromText);
    if (Number.isNaN(from)) return fail({ status: 422, code: "invalid", message: `from is an ISO 8601 time or milliseconds since the epoch, at most ${MAX_INSTANT}`, param: "from" });
    if (Number.isNaN(to)) return fail({ status: 422, code: "invalid", message: `to is an ISO 8601 time or milliseconds since the epoch, at most ${MAX_INSTANT}`, param: "to" });
    const window = { from: from ?? to! - TRACE_WINDOW_MAX_MS, to: to ?? from! + TRACE_WINDOW_MAX_MS };
    // The one bound alone puts the other 24 hours away, which may pass the last time a Date can hold.
    if (!(Math.abs(window.from) <= MAX_INSTANT && Math.abs(window.to) <= MAX_INSTANT)) {
      return fail({ status: 422, code: "invalid", message: `the window must lie within ${MAX_INSTANT} milliseconds of the epoch`, param: fromText === null ? "to" : "from" });
    }
    if (!(window.from < window.to)) return fail({ status: 422, code: "invalid", message: "from is before to", param: "from" });
    if (window.to - window.from > TRACE_WINDOW_MAX_MS) {
      return fail({ status: 422, code: "invalid", message: `the window is at most ${TRACE_WINDOW_MAX_MS / 3_600_000} hours; page through a longer one`, param: "to" });
    }
    const limit = wholeParam(query, "limit", TRACE_LIMIT_DEFAULT, 1, TRACE_LIMIT_MAX);
    if (isFail(limit)) return fail(limit);
    const afterSeq = wholeParam(query, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);
    if (isFail(afterSeq)) return fail(afterSeq);
    const r = await seed.trace(tenantId, agentId, { ...window, afterSeq, limit });
    if (!r.ok) return fail({ status: r.status, code: r.status === 404 ? "not_found" : "unavailable", message: r.message });
    const body = redacted({
      agentId, from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString(),
      cursor: String(afterSeq), nextCursor: r.nextCursor, rows: r.rows, scanned: r.scanned, redactions: r.redactions ?? 0,
    });
    read({ route, from: body.from as string, to: body.to as string, cursor: afterSeq, count: r.rows.length, redactions: body.redactions });
    return ok(body);
  }
  return null;
}

/** The latest time a Date holds, either side of the epoch (ECMA-262 21.4.1.1). */
const MAX_INSTANT = 8.64e15;

/**
 * The body walked once more for credential shapes (cf/src/eval-read.ts), its `redactions` (the object's own walk's,
 * when it made one) plus this walk's.
 */
function redacted(body: object): Record<string, unknown> & { redactions: number } {
  const r = redactCredentials(body);
  const before = (body as { redactions?: unknown }).redactions;
  return { ...(r.value as Record<string, unknown>), redactions: (typeof before === "number" ? before : 0) + r.redactions };
}

/** A whole-number query parameter in [min, max], `fallback` when absent. */
function wholeParam(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number | Fail {
  const text = query.get(name);
  if (text === null) return fallback;
  const n = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(Number.isSafeInteger(n) && n >= min && n <= max)) {
    return { status: 422, code: "invalid", message: `${name} is a whole number from ${min}${max === Number.MAX_SAFE_INTEGER ? "" : ` to ${max}`}`, param: name };
  }
  return n;
}

/** Milliseconds since the epoch, from digits or an ISO 8601 time; NaN for anything else, and past what a Date holds. */
function instant(text: string): number {
  const n = /^\d+$/.test(text) ? Number(text) : /^\d{4}-\d{2}-\d{2}T/.test(text) ? Date.parse(text) : NaN;
  return Math.abs(n) <= MAX_INSTANT ? n : NaN;
}
