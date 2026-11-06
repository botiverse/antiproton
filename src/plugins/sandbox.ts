import type { Json, MountRecord } from "../core/types.ts";
import type { CredentialRefKind, DbOperations, HeldFiles, Plugin, PluginContext, MountActivity, MountUsage, Released, SandboxForm, ToolSchema, Withdrawal } from "./types.ts";
import { Backgrounded, backgrounded, identityNote, KeyRange, LEASE_KEY, markIdentity, markReleased, releaseRetryMs } from "./types.ts";
import type { R2Artifacts } from "../store/artifacts.ts";
import { AGENT_REF, keyForRef, toAgentRef } from "../store/refs.ts";
import { spanText } from "../runtime/idle-lease.ts";
import { ProviderError, TERMINAL_EXEC_STATES } from "./sandbox/provider.ts";
import type { BoxSpec, BoxState as ProviderBoxState, EgressSecret, ExecStatus, SandboxBackend, SandboxProvider } from "./sandbox/provider.ts";
import { run9 } from "./sandbox/providers/run9.ts";
import { instabox, INSTABOX_ENDPOINT, shapeOf } from "./sandbox/providers/instabox.ts";

export { PUT_SETTLE_MS } from "./sandbox/providers/run9.ts";

/**
 * A real Node runtime, as a mount.
 *
 * Deliberately not the JsExecutor. The sandbox the harness runs `run_js` in has
 * no network and no filesystem, and the only way out of it is the gateway —
 * three of the nine executor contract cases exist to hold that line. A run9 box
 * always has egress (both `normal` and `managed` reach the open internet, which
 * was measured, not assumed), so putting the tool bridge inside one would let
 * an injected agent post its tool results anywhere. It cannot today.
 *
 * As a mount it is strictly additive and the shape is in our favour: the box
 * runs on someone else's machine and holds none of our credentials, so it sits
 * outside the trust boundary exactly like GitHub or an outbound fetch. What it
 * buys is everything QuickJS cannot do — npm packages, a filesystem, minutes of
 * compute instead of five seconds.
 *
 * The box is per mount and kept in the mount's database, so a package installed by
 * one call is still there for the next.
 */
export interface SandboxConfig {
  /** Which provider runs the container: "run9" (the default) or "instabox". */
  provider?: string;
  /** InstaBox: the template a new machine starts from. A mount's `image` then runs as a container inside it. */
  template?: string;
  /**
   * InstaBox: hours after creation at which InstaBox deletes the machine whatever it is doing
   * (`deleteAfterSeconds`), so a machine nothing releases cannot outlive this. At most 24: InstaBox refuses more,
   * and the time cannot be moved once the machine exists.
   */
  maxLifetimeHours?: number;
  /** InstaBox: minutes a machine may run without a pause before InstaBox pauses it (`maxRunMinutes`). */
  maxRunMinutes?: number;
  endpoint?: string;
  /** Any image with node on the PATH. */
  image?: string;
  project?: string;
  timeoutMs?: number;
  graceMs?: number;
  maxOutputBytes?: number;
  /** Who verifies the credential: the provider's API, or the endpoint itself. */
  verifyWith?: "provider" | "endpoint";
  /** Ceiling on one `quiet` request, in minutes, while the container is running. */
  maxQuietMinutes?: number;
  /**
   * How long a container switched off for being idle is kept before it is
   * deleted, in days. Switched off it bills no compute and keeps its disk, so
   * an agent coming back finds its machine; deleted, the disk is gone too, so
   * the agent is told before that.
   */
  keepStoppedDays?: number;
  /**
   * How many machines (named containers) the mount may have at once, the
   * default one included. Switched-off ones count: each still keeps a disk.
   */
  maxMachines?: number;
  /** Where commands run. A prepared image usually has its own checkout. */
  workdir?: string;
  shape?: string;
  /** Shell binary. A prepared image often needs bash, not sh. */
  shell?: string;
  /**
   * Run before every command, to enter the image's environment.
   *
   * Prepared images frequently put their real toolchain behind an activation
   * step declared in `.bashrc` — which `sh -lc` never reads. Without this the
   * commands run against whatever the system happens to ship, which for a
   * SWE-bench image means a Python with no pytest, so neither the agent nor the
   * grader can run the test suite.
   */
  shellPrefix?: string;
  /**
   * Whether commands can reach the network. A run9 box always has egress —
   * its create call accepts `normal` or `managed` and nothing else, so there is
   * no isolated mode to ask for — and "none" is done in the box instead: every
   * command runs under `unshare -n`, in a
   * fresh network namespace with no interface, no route and no DNS. Measured
   * on a SWE-bench image: the box is root with the full capability set, GitHub
   * stops resolving, and the repository's own tests still pass. A benchmark
   * whose answer is a public commit must run this way, and an agent that has
   * no business on the internet may as well.
   */
  network?: "open" | "none";
  /**
   * Whether the container acts as this agent's other accounts: "all" wires in
   * every mount whose plugin declares a `SandboxForm` and holds a credential,
   * "none" wires in nothing.
   */
  accounts?: "all" | "none";
  /**
   * Replaced by `accounts`. Before it, this named the GitHub mount to wire in,
   * and an empty value turned wiring off; that one meaning is still honoured,
   * because a mount set that way was switched off on purpose and must not be
   * switched back on by an upgrade. Any other value does nothing.
   */
  github?: string;
}

/** A saved filesystem, under a name the agent chose rather than an id. */
interface Env {
  name: string;
  snapId: string;
  savedAt: number;
  note?: string;
  /** The image the kept container started from; absent for one kept before that was recorded. */
  image?: string;
}

interface Session {
  boxId: string;
  startedAt: number;
  endedAt: number;
  /**
   * When the box was last actually used, so idle time is computable after the
   * fact: `endedAt - lastUsedAt`. `endedAt - startedAt` is how long it lived,
   * which is the wrong segment for deciding a release policy — the two
   * policies differ only in how long a box sits unused, and without this the
   * record could not tell them apart.
   */
  lastUsedAt: number;
  execs: number;
  saved: string[];
  /** Which of the mount's machines it was, when not the default one ("main"). */
  machine?: string;
  /**
   * The kind of credential the box was created under, as on `BoxState`; absent for one recorded before. Read only
   * through `createdUnder`, since a stored record may carry a kind this build does not know (`isSession`).
   */
  credentialRef?: CredentialRefKind;
}

/**
 * Where the box record lives in this mount's database: one record under one
 * key. Exported for the bench meter, which reads the sessions of a finished
 * run from the rows without a call.
 */
export const BOX_STORE = "box";
export const BOX_KEY = "state";
/**
 * Beside the record, one key per box (`split:<box id>`, so "did this mount ever name box X" is one read): every box
 * this mount's record named that turned out to be another's, kept for good. Each is small, and without it a split
 * would leave no trace at all.
 *
 * Not in `sessions`, though that is where a box this mount used is remembered. If a split were written there: it
 * would be billed, since usage passes run after each step and bill every session up to its end (src/usage/container.ts
 * `heldRows`), so every split would bill this mount the tail since that box's last pass, days for an agent dormant
 * before its split; the window keeps only the newest `SESSIONS_KEPT`, so the evidence would be evicted; and a session
 * means "this box ended", where a split leaves the box alive. Not in machines or `stranded` either: those are what this mount holds, and usage bills what it
 * holds (src/usage/container.ts), which would bill the owner's machine to this mount.
 */
export const SPLIT_PREFIX = "split:";
const splitKey = (boxId: string) => `${SPLIT_PREFIX}${boxId}`;

/**
 * A box another agent owns that this mount's record named, after the record let go of it (`ownedProvider`): when,
 * why, and what became of this mount's account registrations on it. Names only, never a value.
 */
interface ForeignBox {
  box: string;
  /** The mount and machine whose record named it. */
  mount: string;
  machine: string | null;
  /** Why it is not this mount's: made for another agent. */
  reason: "foreign_owner";
  /**
   * Every account registration this mount had made there, by name, as found at the split and never changed: the most
   * that can have been exposed, for reports. Null where the record could not say (`Wired.names` null).
   */
  registeredNames: string[] | null;
  /** The ids of those it can prove its own (`Wired.pairs`), as found at the split and never changed. */
  secretIds: string[];
  detectedAt: number;
  /**
   * This mount's registrations on it, as a set: `pending` while any item is still to be removed, `residue` when what
   * is left is only given up on, `removed` when nothing is left (`outcomeOf`).
   */
  unwire: "removed" | "pending" | "residue";
  /** What of this mount is still on it, one item per registration (`Remaining`). */
  remaining: Remaining[];
  /** Removal rounds made over the pending items, as a set (`UNWIRE_ATTEMPTS`); why the last one failed. */
  attempts: number;
  lastError: string | null;
  /** The agent's note about this split is queued (`noteLetGo`): set once, so finding the split again says nothing new. */
  told?: true;
}

/**
 * One registration of this mount's on another agent's box: its id where the provider answered one, its name where
 * known. `pending` items have an id and are removed by it; `residue` items are given up on, with why:
 * `wiring_without_ids` (never had a provable id, so never tried), `names_unknown` (the wiring's names were not
 * known either), `unwire failed 3 times`, or `pending without details` (an older entry with nothing to retry).
 */
type Remaining = { id: string | null; name: string | null; state: "pending" | "residue"; reason?: string };

/**
 * How many removal rounds a pending removal gets. `attempts` counts the rounds actually sent, and is advanced in one
 * place (`applyRound`, run inside the write) for every round, wherever it runs: in the call that splits, on finding an
 * interrupted split again, or in a later call's retry (`retryForeign`). A split's first write has 0, and every round
 * adds one whatever came of it; once this many have been made, what is still pending is kept as residue. So at most
 * this many rounds in all, and a split found again goes on from the count it had. Calls at once each count the round
 * they really sent, so under concurrency a split can reach the limit sooner, which the count intends. Why a round
 * failed is in `lastError` and `reason`; `attempts` only counts.
 */
export const UNWIRE_ATTEMPTS = 3;

/**
 * The mount's box record. `sessions` is what makes the meter readable:
 * a container is the most expensive thing here and the only one billed for
 * simply existing, so how long each one lived is worth keeping even after it
 * is gone.
 */
interface BoxState {
  boxId: string;
  createdAt: number;
  lastUsedAt: number;
  /**
   * The image this container started from: the setting when it was created, or
   * the image of the kept environment it started from. Absent when that is not
   * known, which results say rather than falling back to the setting.
   */
  image?: string;
  /** The mounts wired into this container (see `SandboxForm`); never a credential. */
  wired?: Wired[];
  /**
   * What kind of credential created this box (`ctx.credentialRefKind` at creation): whose run9 account it is on,
   * so whose money it spends. The mount's reference can change while the box lives — a key of the tenant's own
   * may go over the operator's seeded one (cf/src/runtime.ts `attachCredential`) — and the reference read later
   * then names an account this box is not on. Usage reads this (src/usage/container.ts `countHeldTime`), so time
   * on our account is not booked as the tenant's own. The kind only, never the reference or the value.
   */
  credentialRef?: CredentialRefKind;
  /**
   * When run9 first refused to delete this box (`stopBox`). The box is still recorded, since it is still alive;
   * this says its error lease has been reported, so later attempts that fail the same way do not report another.
   */
  deleteFailedAt?: number;
  /**
   * The provider has shown this box was made for this agent (`ownedProvider`): set when this mount created or
   * adopted it, or once its owner was read. A box recorded without it is asked about before anything is sent to it.
   */
  ownerChecked?: true;
  /** Mounts that declare a container form and hold a credential but were left out, and why. */
  leftOut?: LeftOut[];
  execs?: number;
  saved?: string[];
  /**
   * The last few containers this mount finished with, most recent first.
   *
   * **Two limits, and anyone answering a question from this has to know both:**
   * it keeps the most recent `SESSIONS_KEPT` and drops the rest without saying
   * so, and a container only appears here if it was *released* — one that
   * leaked, or whose worker died mid-call, never reaches this line at all.
   *
   * So it is a meter for the console — "what has this agent been running
   * lately" — and it is not the record of what a tenant used. That record has
   * to be written where nothing can go around it, which is why it belongs to
   * whatever holds the provider's key rather than here (cody, 2026-09-12,
   * `85a5b0c7`).
   */
  sessions?: Session[];
  /**
   * Environments this agent has kept, by name.
   *
   * A container starts from a bare image, so every task that needs Python,
   * a toolchain or a cloned repository pays for that setup again. run9 can fork
   * a stopped box's filesystem into a snapshot and boot a new box from it, which
   * turns "install everything" into "start from what I had".
   */
  envs?: Env[];
  /** Set by restore: the next box starts from this snapshot rather than the image. */
  startFrom?: string;
  /**
   * Until when the agent has asked not to be reminded about this box.
   *
   * Written here and read by the framework's idle wake rather than by this
   * plugin: the plugin's part is to record the request and to refuse one longer
   * than the mount allows. A box is billed for existing, so the ceiling is not
   * a formality — it is the only thing standing between "remind me later" and
   * "never release it".
   */
  quietUntil?: number;
  /**
   * When the idle lease switched this container off, or absent while it runs.
   *
   * Switched off rather than deleted: run9 keeps a stopped box's disk, and the
   * next exec on the same id starts it again in about two seconds with its
   * files intact (measured 2026-10-01; processes do not survive). So the record
   * keeps naming the box, and this says which of the two schedules it is on —
   * the short idle one while it bills compute, the long one before deletion
   * while it only keeps a disk. Cleared by the next command that runs in it.
   */
  parkedAt?: number;
  /**
   * "paused" when the idle lease paused the box with its memory kept (a provider whose `caps.pause` is "memory",
   * InstaBox) rather than switching it off. Its next step is the same as a switched-off box's, deletion; only
   * what it keeps and what it costs differ. Absent: switched off, or running. Read only through `pausedOf`.
   */
  parkedAs?: string;
  /**
   * When the provider deletes this box on its own, whatever it is doing (InstaBox's `deleteAt`, set at creation
   * and not movable). The stopped schedule never runs past it.
   */
  deleteAt?: number;
  /**
   * The directory the last `shell` command ended in, so the next one starts
   * there. Each run9 exec is a fresh process: a `cd` does not carry over, and
   * agents were writing `cd /testbed && …` into every call.
   * Absent on a new box, where the first call starts in the working directory.
   */
  cwd?: string;
}

/**
 * One machine's part of the record: everything in `BoxState` but the two lists
 * the whole mount shares.
 */
type MachineState = Omit<BoxState, "sessions" | "envs">;

/**
 * The mount's record: several machines by name, and what they share.
 *
 * An agent may need two machines at once (a server in one, a client in the
 * other, or a build beside a clean checkout), so a mount holds several, each
 * created on first use and switched off, resumed and deleted on its own
 * schedule. What is shared is what was never about one container: the kept
 * environments (a snapshot outlives the box it came from) and the window of
 * finished sessions. A record written before machines existed has the one
 * box's fields at the top level, and reads as the machine "main" (`asMountState`).
 */
interface MountState {
  machines: Record<string, MachineState>;
  sessions?: Session[];
  envs?: Env[];
  /**
   * Boxes set aside, by box id (`holds.strand`): the credential that made each stopped working, so it is out of
   * every machine slot — the agent starts afresh under the new one — and kept only to be deleted later, by a key
   * that can, or dropped by an operator's `forget`. Reported as held, released on the idle schedule, never used.
   */
  stranded?: Record<string, StrandedBox>;
}

type StrandedBox = MachineState & {
  strandedAt: number; strandReason?: string;
  /** Failed attempts to delete it, when the next may be made (`releaseRetryMs`), and what the last one said. */
  tries?: number; nextTryAt?: number; lastError?: string;
};

/**
 * The alias every agent's container is mounted under: the catalogue's seed
 * (cf/src/runtime.ts `AgentRuntime.DEFAULT_MOUNTS`) and both SWE-bench runners (cf/src/index.ts
 * `benchSweStart`, bench/swebench/run.ts). A runner that addresses the box
 * itself (its grader's shell, the release it withholds from the agent) builds
 * the address from this, so a rename moves every caller at once instead of
 * leaving one answering `no mount named ...`.
 */
export const SANDBOX_ALIAS = "sandbox";

/** The machine a call uses when it names none: what the mount's one box always was. */
export const MAIN_MACHINE = "main";

/** A machine name: short, lowercase, and usable inside a box id. */
const MACHINE_RE = /^[a-z][a-z0-9-]{0,23}$/;

/** The machine a tool call names, or the default; a name that is not one is refused, not mapped. */
export function machineOf(args: unknown): string {
  const m = (args as { machine?: unknown } | null)?.machine;
  if (m === undefined || m === null || m === "") return MAIN_MACHINE;
  if (typeof m !== "string" || !MACHINE_RE.test(m)) {
    throw new Error(`machine must be a short name: a lowercase letter, then up to 23 lowercase letters, digits or dashes; got ${JSON.stringify(m)}`);
  }
  return m;
}

/** The `machine` parameter, the same on every tool that acts on a machine. */
const MACHINE_PARAM = {
  type: "string",
  description: "which of this mount's machines: omit for the default one (\"main\"); another short name " +
    "(lowercase letters, digits, dashes) uses that separate machine, creating it on first use",
} as const;

/** The setting, or the default when it is not a usable whole number. */
function maxMachinesOf(cfg: { maxMachines?: unknown }): number {
  const n = cfg.maxMachines;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : DEFAULTS.maxMachines;
}

const NO_BOX: MachineState = { boxId: "", createdAt: 0, lastUsedAt: 0 };

/** One machine as the code below has always handled a box: its own fields and the mount's shared lists. */
function viewOf(mount: MountState | null, machine: string): BoxState {
  return {
    ...(mount?.machines[machine] ?? NO_BOX),
    ...(mount?.sessions ? { sessions: mount.sessions } : {}),
    ...(mount?.envs ? { envs: mount.envs } : {}),
  };
}

/** The machines that have a box (running or switched off), main first, then by name. */
function boxedMachines(mount: MountState | null): string[] {
  return Object.keys(mount?.machines ?? {}).filter((n) => mount!.machines[n]!.boxId)
    .sort((a, b) => a === MAIN_MACHINE ? -1 : b === MAIN_MACHINE ? 1 : a < b ? -1 : a > b ? 1 : 0);
}

async function readMount(ctx: PluginContext): Promise<MountState | null> {
  return asMountState(await ctx.db.get(BOX_STORE, BOX_KEY));
}

/** One machine of this mount, read now; a machine with no box reads with an empty `boxId`. */
async function readView(ctx: PluginContext, machine: string): Promise<BoxState> {
  return viewOf(await readMount(ctx), machine);
}

/**
 * Write one machine back, in the record's current shape, leaving the others as
 * they are read now. The shared lists come from the view (the operation that
 * changed them handed them in) or, absent there, from the record.
 *
 * A machine with no box and nothing pending (`startFrom`) is dropped from the
 * map rather than kept as an empty entry, so the map is the list of machines
 * that exist or are about to.
 */
async function writeView(ctx: PluginContext, machine: string, view: BoxState): Promise<void> {
  const cur = (await readMount(ctx)) ?? { machines: {} };
  const { sessions, envs, ...box } = view;
  const machines = { ...cur.machines };
  if (box.boxId || box.startFrom) machines[machine] = box;
  else delete machines[machine];
  const keptSessions = sessions ?? cur.sessions;
  const keptEnvs = envs ?? cur.envs;
  await writeMount(ctx, { machines, ...(keptSessions ? { sessions: keptSessions } : {}), ...(keptEnvs ? { envs: keptEnvs } : {}), ...(cur.stranded ? { stranded: cur.stranded } : {}) });
}

/** The whole record, as `writeView` writes it: an empty list of environments or of stranded boxes is left out. */
async function writeMount(ctx: PluginContext, m: MountState): Promise<void> {
  await ctx.db.put(BOX_STORE, {
    machines: m.machines,
    ...(m.sessions ? { sessions: m.sessions } : {}),
    ...(m.envs?.length ? { envs: m.envs } : {}),
    ...(m.stranded && Object.keys(m.stranded).length ? { stranded: m.stranded } : {}),
  } as unknown as Json, BOX_KEY);
}

/** Printed after a `shell` command to report where it ended; stripped before the agent sees the output. */
const CWD_MARK = "__AP_CWD__";

/**
 * The command, then a line that reports its final directory and exits with the
 * command's own status. On its own line, so a trailing comment or an unfinished
 * `&&` in the command cannot swallow it. A command that exits itself, or leaves
 * a quote open, reports nothing, and the directory stays where it was.
 */
export function withCwdTrailer(command: string): string {
  return `${command}\n__ap_rc=$?; printf '\\n${CWD_MARK}%s\\n' "$PWD"; exit $__ap_rc`;
}

/**
 * The output without the directory report, and the directory. Only a report at
 * the very end counts: run9's summary of a long output keeps its head and tail
 * (measured, 2026-09-15: 400,000 lines, the report still last), and a marker a
 * command printed itself further up is output, not a report.
 */
export function splitCwd(out: string): { output: string; cwd: string | null } {
  const m = /\n?__AP_CWD__([^\n]*)\n?\s*$/.exec(out);
  if (!m || !m[1]) return { output: out, cwd: null };
  return { output: out.slice(0, m.index), cwd: m[1] };
}

/**
 * What every execution tells the model about the box it just used.
 *
 * Extracted so a test can hold it: the same fact is stated in three places the
 * model reads — this line and the `run` and `shell` summaries — and they have
 * to end the box the same way. A string built inline could drift from the other
 * two with nothing failing, which is how "persists between calls" outlived the
 * behaviour it described.
 *
 * **It says what is true of the deployment it is running in**, and for a long
 * while it did not. It read "this container persists between calls", on the
 * premise that with the idle lease off a box waits for its agent. The opposite
 * is what the runtime does: with no lease configured — which is production —
 * a settled turn hands its containers back, so the box lives for one turn and
 * the next call starts a new one. Both `cf/src/runtime.ts` (`idle`) and
 * `src/runtime/idle-lease.ts` say so in as many words; I read neither, and
 * wrote the sentence from the half of the lifetime I had in mind. Measured by
 * probe: nine containers for one agent, `uses: 1` each, 3.3–9.5 s
 * apiece, and the model quoted this line back while watching the box id change
 * under it.
 *
 * So the lifetime it states is the one the agent can actually use — every call
 * in this turn — and it names what outlives the turn instead, which is a kept
 * filesystem.
 *
 * With the lease on — a container is destroyed by the agent's own `release`,
 * not by the end of a turn; an idle one is switched off with its disk kept, and
 * deleted only after `keepStoppedDays`, with its agent told first and free to
 * postpone that — the runtime hands the plugin the lease and the sentence
 * names that lifetime instead. The idle minutes come from the lease, never
 * from here.
 */
export interface BoxLease {
  /**
   * How long before the release the agent is told, for holders that report no
   * schedule of their own. This plugin reports one for both of its steps
   * (`activityOf`), so it decides only that the lease is on.
   */
  warnMs: number;
  /** Idle this long and a running box is switched off, unless the agent postponed it. */
  maxMs: number;
}

const leaseMinutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * What `keep` and `save` say about release, in their summaries and in what they hand back.
 *
 * "It survives release" was true and read as permission: in blind-use round 4 (2026-09-15) an agent told
 * the user would come back kept the environment, saved an archive, and reasoned "since I've kept the environment
 * and saved the archive, I could release the container". The note it had just been handed was the last thing it
 * read before deciding, so the copy's survival is said together with what it is not.
 */
export function notAReasonToRelease(lease: BoxLease | null, terms?: IdleTerms): string {
  // "Leave it running" is only something an agent can do under a lease: without one the box is handed back
  // when the turn ends whatever it decides, so that half would be a promise nothing keeps (from the #327 review).
  // Under the lease, leaving it is cheap because idle only switches it off, which is why the sentence says so.
  if (lease && terms?.provider === "instabox") {
    return "A copy outliving the container is not a reason to release it: if you or the person you are working for " +
      "will come back to this machine, leave it running — idle, it is only paused, and the next call resumes it " +
      "with its files and running processes.";
  }
  return lease
    ? "A copy outliving the container is not a reason to release it: if you or the person you are working for " +
      "will come back to this machine, leave it running — idle, it is only switched off, and the next call " +
      "brings it back with its files."
    : "A copy outliving the container is not a reason to release it early: it is handed back when the turn " +
      "ends anyway, and until then it is still the machine you are working on.";
}
export const keptNote = (lease: BoxLease | null, terms?: IdleTerms) =>
  "independent of this container; start a fresh machine from it later with `start_from`. " + notAReasonToRelease(lease, terms);
export const savedNote = (lease: BoxLease | null, terms?: IdleTerms) => "kept outside the box, for later. " + notAReasonToRelease(lease, terms);

/**
 * What a mount's provider makes true of an idle box, for the sentences the model reads about it: run9 switches an
 * idle box off; InstaBox pauses it with its memory kept, and deletes every box a fixed time after creation
 * whatever it is doing (`maxLifetimeHours`).
 */
export interface IdleTerms {
  provider: "run9" | "instabox";
  keepStoppedDays: number;
  maxLifetimeHours: number;
}

/**
 * What happens to an idle box under a lease, said once for the reminder, `run` and `shell`.
 *
 * "Files survive" is true of the box's root disk, not of /tmp. In a run9 box /tmp is a tmpfs; measured on
 * production on 2026-09-15, a marker in /tmp was gone after 18 idle minutes while one in /work (the default
 * working directory) was still there, in the same box, with no reboot in between. An agent that writes its
 * work to /tmp and comes back after a pause would find it missing, so the sentence says where to keep it.
 */
export function leaseTerms(lease: BoxLease, keepStoppedDays: number = DEFAULTS.keepStoppedDays): string {
  return `after ${leaseMinutes(lease.maxMs)} idle minutes it is switched off, and the next call switches it back on `
    + `with its files intact (running processes do not survive); it is deleted, with everything on its disk, only `
    + `after ${spanText(keepStoppedDays * DAY)} switched off and unused, and you are told ${spanText(stoppedWarnMs(keepStoppedDays))} `
    + `before that; \`quiet\` postpones either by as long as you choose, within the mount's limit; `
    + `files under /tmp do not survive while it sits idle, so keep your work in the working directory`;
}

const DAY = 86_400_000;

/**
 * `leaseTerms` for an InstaBox box: paused when idle, and from there deleted, with no step between. A paused box
 * keeps memory and processes (measured 2026-10-26: resume with the same PID still running, /tmp intact) and is
 * billed for storage only, as a stopped one would be, and InstaBox will not stop a paused box without resuming it
 * first, which is billed: so it stays paused. The creation-time deletion is said whenever it comes before the
 * paused schedule would end, since it then decides how long the machine lives.
 */
export function instaboxLeaseTerms(lease: BoxLease, t: IdleTerms): string {
  const lifetimeMs = t.maxLifetimeHours * 3_600_000;
  const deletion = lifetimeMs < t.keepStoppedDays * DAY
    ? `it is deleted, with everything on its disk, ${spanText(lifetimeMs)} after it was created whatever it is doing, `
      + "and nothing postpones that: `keep` the environment or `save` the files you will want after then; "
    : `it is deleted, with everything on its disk, after ${spanText(t.keepStoppedDays * DAY)} paused and unused, `
      + `and you are told ${spanText(stoppedWarnMs(t.keepStoppedDays))} before that, and in any case ${spanText(lifetimeMs)} `
      + "after it was created, which nothing postpones; ";
  return `after ${leaseMinutes(lease.maxMs)} idle minutes it is paused, keeping its memory, running processes and `
    + "files, and billed only for its storage until the next call resumes it where it was; "
    + `${deletion}\`quiet\` postpones the pause by as long as you choose, within the mount's limit`;
}

/**
 * How long before a switched-off container is deleted its agent is told: a
 * day, but never more than half the time it is kept, so a short setting still
 * leaves the agent half of it to come back in before the warning.
 */
export function stoppedWarnMs(keepStoppedDays: number): number {
  return Math.min(DAY, (keepStoppedDays * DAY) / 2);
}

/** The setting, or the default when it is not a usable number of days. */
function keepDaysOf(cfg: { keepStoppedDays?: unknown }): number {
  const d = cfg.keepStoppedDays;
  return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : DEFAULTS.keepStoppedDays;
}

/** When the box was switched off for being idle, or null while it is running. */
function parkedAt(state: { parkedAt?: unknown } | null | undefined): number | null {
  const p = state?.parkedAt;
  return typeof p === "number" && Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * The stored state, or null when what came back is not it.
 *
 * `ctx.db` hands back `unknown` — so `as BoxState`
 * was never a narrowing, it was an assertion the compiler cannot check, on
 * data that outlives the code that wrote it. The risk is not a mistyped call
 * site; it is this call site reading a row written by an older version, which
 * is exactly what a generic parameter would hide.
 *
 * **Unrecognised is "nothing is running", not an error.** Every path here
 * starts by asking `state?.boxId`, so a shape we cannot read degrades to the
 * answer that is both true and self-healing: the mount starts a new container
 * and writes a shape this version does know. Throwing instead would turn one
 * bad row into a mount nobody can use.
 *
 * It checks what every path depends on and not one field more: the id, and
 * that the two clocks are numbers. A checker that insisted on the whole record
 * would reject rows this code can in fact use. The session and environment
 * lists are filtered instead, entry by entry, because a bad line of history is
 * not a reason to forget a container that is running.
 */
/**
 * A box path as path segments, resolved: empty and `.` segments drop out and
 * `..` climbs, never past the root. The result is what the file's own machine
 * would call it, which is the only name under which finding it again makes
 * sense — and it carries no segment that would make the reference unreadable.
 */
export function segmentsOf(path: string): string[] {
  const out: string[] = [];
  for (const seg of String(path).split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { out.pop(); continue; }
    out.push(seg);
  }
  return out;
}

/** The states of an execution that will not change again (`TERMINAL_EXEC_STATES`). */
const TERMINAL = TERMINAL_EXEC_STATES;

/** This mount's settings, defaults filled in. */
function cfgOf(ctx: PluginContext) {
  return cfgFrom(ctx.publicConfig as SandboxConfig);
}

/**
 * Settings, defaults filled in: the plugin's, then the provider's own where they differ, then the mount's. Never
 * throws, for a provider it does not know either: the readers of the record (activity, usage) must still answer
 * for such a mount, and every path that talks to a provider refuses it there (`backendFor`).
 */
function cfgFrom(config: SandboxConfig | null | undefined) {
  // No written return type: the spread of a partial over the defaults is the
  // truth here, and an annotation beside it would be a second statement of the
  // same thing, free to disagree with it.
  return { ...DEFAULTS, ...(config?.provider === "instabox" ? INSTABOX_DEFAULTS : {}), ...(config ?? {}) };
}

/** The idle terms a mount's provider makes true (`IdleTerms`). */
function idleTermsOf(cfg: ReturnType<typeof cfgOf>): IdleTerms {
  const hours = Number(cfg.maxLifetimeHours);
  return {
    provider: cfg.provider === "instabox" ? "instabox" : "run9",
    keepStoppedDays: keepDaysOf(cfg),
    maxLifetimeHours: Number.isFinite(hours) && hours > 0 ? Math.min(24, hours) : DEFAULTS.maxLifetimeHours,
  };
}

/** The provider's name as a reader is shown it, for one this plugin does not know too. */
function providerName(cfg: { provider?: string }): string {
  return cfg.provider === "instabox" ? instabox.name : run9.name;
}

/**
 * This mount's provider under its credential, for a call that needs one: a tool call, or polling and cancelling
 * a job outside one. One door, with the same credential resolution, so a call with no account is refused the
 * same way wherever it comes from.
 */
function openProvider(cfg: ReturnType<typeof cfgOf>, ctx: PluginContext, opts?: { wake?: boolean; look?: boolean }): OwnedProvider {
  const backend = backendFor(cfg);
  if (!ctx.credential) throw markIdentity(new Error(`the ${backend.name} API needs an account, and this call had none — ${identityNote(ctx)}`), ctx);
  return ownedProvider(backend.open(cfg, ctx.credential, opts?.wake === false ? { wake: false } : undefined), ctx, opts?.look === true);
}

/** What every box this plugin creates says it is for, at the provider (`BoxSpec.description`). */
export function boxDescriptionOf(caller: { tenantId: string; agentId: string }): string {
  return `antiproton ${caller.tenantId}/${caller.agentId}`;
}

/**
 * The descriptions a box made for this agent may carry: today's, and the one the very first build sent before the
 * project was renamed (`agent-harness`, 2026-09-08). A box of that build still recorded is this agent's, and judging
 * it another's would leave it alive and billed with nothing naming it.
 */
function ownDescriptions(caller: { tenantId: string; agentId: string }): string[] {
  return [boxDescriptionOf(caller), `agent-harness ${caller.tenantId}/${caller.agentId}`];
}

/** A box the record named turned out to be another agent's: the record no longer names it, and nothing was sent. */
export class BoxNotOurs extends Error {
  readonly boxId: string;
  readonly machine: string | null;
  constructor(boxId: string, machine: string | null) {
    super(`box ${boxId} was made for another agent, so this mount no longer uses it; nothing was sent to it`);
    this.boxId = boxId;
    this.machine = machine;
  }
}

/**
 * The boxes this mount let go of as another agent's that its agent has not been told about yet, for the sentence the
 * next tool result carries (`notOursNote` in `sandboxPlugin`).
 */
export const NOTICES_KEY = "notices";
/** What was done about a foreign box: let go of it, with how its account registrations ended, or gave up on them. */
type LetGo = {
  /** The row's own id: rows are delivered and cleared by it, never by box. */
  id?: string;
  boxId: string; machine: string | null;
  /** `split` when the record let go of it, with which item states its set holds; or a later turn of its removal. */
  outcome: "split" | "given_up" | "remains";
  pending?: boolean; residue?: boolean;
};
/**
 * Kept in the mount's own storage until a tool's result has carried it: a split is often found outside any tool call
 * (the idle lease's switch-off, an operator's release, a withdrawal), and the agent's next call is then the first
 * place it can be told why its machine is gone.
 */
// One row per event, never merged by box: the same box can give two events at different times (let go of with a
// removal pending, then that removal given up on), and the second is the only place the agent hears it could not be
// removed. The same note is not repeated, but different outcomes for the same box are different notes.
// One machine's one outcome appears at most once in the queue; that is the only reason dedupe looks harmless today.
// Do not add dedupe, and if a path ever re-enqueues, the test with two identical rows is the guard.
function enqueueIn(tx: DbOperations, g: LetGo): void {
  const v = tx.get(BOX_STORE, NOTICES_KEY);
  const owed = Array.isArray(v) ? (v as LetGo[]) : [];
  const id = `${Date.now().toString(36)}-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  tx.put(BOX_STORE, [...owed, { ...g, id }] as unknown as Json, NOTICES_KEY);
}
const noteLetGo = async (ctx: PluginContext, g: LetGo) => {
  await ctx.db.transaction([BOX_STORE], "readwrite", (tx) => enqueueIn(tx, g));
};

/** Every split this mount recorded, by box id. An entry that does not read is left out. */
async function readForeign(ctx: PluginContext): Promise<Record<string, ForeignBox>> {
  const rows = await ctx.db.getAll(BOX_STORE, KeyRange.bound(SPLIT_PREFIX, `${SPLIT_PREFIX}\uffff`));
  const out: Record<string, ForeignBox> = {};
  for (const e of rows) {
    if (e && typeof e === "object" && typeof (e as ForeignBox).box === "string" && typeof (e as ForeignBox).detectedAt === "number") {
      out[(e as ForeignBox).box] = e as ForeignBox;
    }
  }
  return out;
}

/**
 * The one writer of a split entry: `fn` is given the entry as stored and returns what to store, and the note the
 * change owes the agent, if any. `unwire` is derived here from `remaining`, never taken from the caller, so the two
 * cannot drift. The note is queued in the same transaction as the entry that records the change: never two writes
 * with a gap where the entry says the change happened and the note was lost, after which nothing would see a change.
 *
 * Inside the callback only the transaction's own synchronous get and put are used; any await there would be refused
 * and roll the whole transaction back. What is written is computed only from what is read inside it and from values
 * passed in (`fn`'s inputs, never an entry read earlier): two calls working on one split each apply their change to
 * what the other left, so neither's is lost.
 */
async function updateSplit(
  ctx: PluginContext, box: string, fn: (stored: ForeignBox | undefined) => { next: ForeignBox; note?: LetGo },
): Promise<{ next: ForeignBox; note?: LetGo }> {
  return ctx.db.transaction([BOX_STORE], "readwrite", (tx) => {
    const raw = tx.get(BOX_STORE, splitKey(box));
    const stored = raw && typeof raw === "object" ? raw as ForeignBox : undefined;
    const out = fn(stored);
    const next = { ...out.next, unwire: outcomeOf(out.next.remaining) };
    tx.put(BOX_STORE, next as unknown as Json, splitKey(box));
    if (out.note) enqueueIn(tx, out.note);
    return { next, ...(out.note ? { note: out.note } : {}) };
  });
}

/** A well-formed entry as stored: one with its items. */
const settledEntry = (e: ForeignBox | undefined): ForeignBox | undefined => (e && Array.isArray(e.remaining) ? e : undefined);

/** The note owed when a round turns a told split's pending items into residue: a new event, told on its own. */
const gaveUpNote = (stored: ForeignBox | undefined, next: ForeignBox, machine: string | null): LetGo | undefined =>
  stored?.told && outcomeOf(stored.remaining) === "pending" && outcomeOf(next.remaining) === "residue"
    ? { boxId: next.box, machine, outcome: "given_up" } : undefined;

/**
 * A wiring's registrations as name and id pairs. One recorded with its pairs reads as them; one recorded before them
 * (names alone, which is every wiring made before ids were kept, or names with an `ids` list from the build between)
 * reads its ids only from a list as long as its names, and otherwise has none: never matched up by position from a
 * shorter one. Null where not even the names are known. Applied where the record is read (`withPairs`), so the next
 * write of the record stores the wiring as pairs: an old wiring is converted on its next ordinary write, never by a
 * write made only to convert it.
 */
function pairsOf(w: Wired): Array<{ name: string; id: string | null }> | null {
  if (Array.isArray(w.pairs)) return w.pairs;
  if (w.names === null) return null;
  const ids = (w as { ids?: unknown }).ids;
  const full = Array.isArray(ids) && ids.length === w.names.length && ids.every((x) => typeof x === "string");
  return w.names.map((name, i) => ({ name, id: full ? (ids as string[])[i]! : null }));
}

/** A wiring as read: with its pairs (`pairsOf`), the one place an older shape is converted. */
function withPairs(w: Wired): Wired {
  const pairs = pairsOf(w);
  const { ids: _ids, ...rest } = w as Wired & { ids?: unknown };
  return pairs ? { ...rest, pairs } : rest;
}

/** The set's state: pending while any item is, residue when only given-up items are left, removed when none is. */
const outcomeOf = (remaining: readonly Remaining[]): ForeignBox["unwire"] =>
  remaining.some((r) => r.state === "pending") ? "pending" : remaining.length ? "residue" : "removed";

/** One removal round as sent: the ids sent, those still there after it, and why the last refusal was. */
type Round = { sent: string[]; left: string[]; error: string };

/** Sends one removal round for the pending items of `e`. Only items with an id are ever pending, so only ids are sent. */
async function sendRound(inner: SandboxProvider, e: ForeignBox): Promise<Round> {
  const sent = e.remaining.filter((r) => r.state === "pending" && typeof r.id === "string").map((r) => r.id!);
  return { sent, ...(await unwireForeign(inner, e.box, sent)) };
}

/**
 * A round applied to an entry: what it removed is taken out, the round is counted, and once `UNWIRE_ATTEMPTS` rounds
 * have been made what is still pending becomes residue. Applied to the entry as stored when the round is written
 * (`updateSplit`), so two rounds made at once both count and what remains is what neither removed.
 */
function applyRound(base: ForeignBox, r: Round): ForeignBox {
  const removed = r.sent.filter((sid) => !r.left.includes(sid));
  const attempts = base.attempts + 1;
  const kept = base.remaining.filter((x) => !(x.state === "pending" && x.id !== null && removed.includes(x.id)));
  const exhausted = attempts >= UNWIRE_ATTEMPTS && kept.some((x) => x.state === "pending");
  // Residue is terminal: no path retries or removes it; it goes away only when the owner removes those
  // registrations or the box is released.
  const remaining = exhausted ? kept.map((x): Remaining => (x.state === "pending" ? { ...x, state: "residue", reason: `unwire failed ${UNWIRE_ATTEMPTS} times` } : x)) : kept;
  return { ...base, remaining, unwire: outcomeOf(remaining), attempts, lastError: r.left.length ? r.error : base.lastError };
}

async function unwireForeign(inner: SandboxProvider, boxId: string, secretIds: string[]): Promise<{ left: string[]; error: string }> {
  const left: string[] = [];
  let error = "";
  for (const sid of secretIds) {
    try {
      await inner.removeSecret(boxId, sid);
    } catch (e) {
      if (e instanceof ProviderError && e.code === "not_found") continue;
      left.push(sid);
      error = e instanceof ProviderError ? `${e.code}${e.status ? ` ${e.status}` : ""}` : "unreachable";
    }
  }
  return { left, error };
}

/** Two texts as sentences: the second's first letter raised, so "…a new one." and "nothing was running" read as two. */
export function joinSentences(first: string, second: string): string {
  if (!second) return first;
  return `${first} ${second.charAt(0).toUpperCase()}${second.slice(1)}`;
}

/** A tool's result with that sentence in front of its `note`, or of a handed-over job's. */
function withNotOursNote(result: Json, note: string | null): Json {
  if (!note) return result;
  if (result instanceof Backgrounded) {
    return new Backgrounded(result.handle, result.note ? joinSentences(note, result.note) : note) as unknown as Json;
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const r = result as Record<string, Json>;
  return { ...r, note: typeof r.note === "string" && r.note ? joinSentences(note, r.note) : note };
}

/** The provider's methods whose first argument is a box id: every request that reaches a box. */
const BOX_ID_METHODS = ["status", "execBackground", "upload", "download", "stop", "pause", "wake", "delete", "snapshot",
  "usage", "addSecret", "listSecrets", "removeSecret"] as const;

type OwnedProvider = SandboxProvider & {
  /** Whether the box may be used, asked before any request reaches it: throws `BoxNotOurs` when it is another's. */
  owns(id: string): Promise<void>;
  /** Retries the removals still pending from boxes let go of as another's (`ForeignBox.pending`). */
  retryForeign(): Promise<void>;
};

/**
 * The provider as every path of this plugin gets it: no request naming a box goes out until the box is shown to be
 * this agent's. One door, because the paths that reach a box are many (the tools, a release, the idle lease's
 * switch-off and deletion, a look at its files, a withdrawal) and a check made in each is one a new path forgets.
 *
 * Why it is needed at all: run9's ids are the whole project's, which is every tenant's, and ids minted before
 * `boxIdFor` could be the same for two agents (two agents of one Raft server in one millisecond). Such a pair's
 * records both name one box, and every request either sends acts on the other's machine: its files and processes,
 * and a release or an idle deletion destroys it. A record keeps its id for as long as the box lives, so the pairs
 * made before the fix stay shared until they are found here.
 *
 * A box is this agent's when this provider just created or adopted it, when its record already says it was shown to
 * be (`ownerChecked`), or when the provider says so now (`SandboxProvider.ownerOf`), which is then written to the
 * record so it is asked once per box. A box the provider lists with no description is kept and said once
 * (`owner_unknown`): every create has sent one, so none is expected, and dropping the machine of an agent that may
 * well own it is the worse mistake. One made for another agent is never sent anything, not even a stop or a
 * delete: the record stops naming it (its sessions and kept environments stay), the fact is written as a
 * `sandbox.box_owner` trace row and a log line with `code: "box_not_ours"`, and `BoxNotOurs` is thrown for the
 * caller to carry on without it. An answer that cannot be read is thrown as it came: nothing is sent to a box that
 * has not been shown to be ours. An id the record does not name at all is refused the same way.
 *
 * A `look` (a person viewing the machine's files) writes nothing, as a look never does: it neither records what it
 * learnt nor lets go of the box, and the agent's next call does both.
 */
function ownedProvider(inner: SandboxProvider, ctx: PluginContext, look = false): OwnedProvider {
  const shown = new Set<string>();
  const say = (code: "box_not_ours" | "owner_unknown" | "unwire_given_up", boxId: string, machine: string | null, more: Record<string, string> = {}) => {
    const attrs = { code, tenant: ctx.caller.tenantId, agent: ctx.caller.agentId, mount: ctx.alias, machine, box: boxId, ...more };
    console.log(JSON.stringify({ event: "sandbox.box_owner", ...attrs }));
    ctx.trace?.({ kind: "sandbox.box_owner", status: code, verdict: code === "owner_unknown" ? "ok" : "blocked", attrs });
  };
  const owns = async (id: string): Promise<void> => {
    if (shown.has(id) || !inner.ownerOf) return;
    const mount = await readMount(ctx);
    const machine = Object.keys(mount?.machines ?? {}).find((n) => mount!.machines[n]!.boxId === id) ?? null;
    const stranded = machine === null ? mount?.stranded?.[id] : undefined;
    if (machine === null && !stranded) throw new BoxNotOurs(id, null);
    if ((machine !== null ? mount!.machines[machine]! : stranded!).ownerChecked) { shown.add(id); return; }
    const owner = await inner.ownerOf(id, ownDescriptions(ctx.caller));
    // Not there: nothing can be sent to another's box under this id, and the request fails as it always has.
    if (owner === "gone") return;
    if (owner === "ours" || owner === "unknown") {
      if (owner === "unknown" && !look) say("owner_unknown", id, machine);
      shown.add(id);
      if (machine !== null && !look) {
        const now = await readView(ctx, machine);
        if (now.boxId === id) await writeView(ctx, machine, { ...now, ownerChecked: true });
      }
      return;
    }
    // Another agent's. The box is theirs: it is never stopped, deleted or changed, and its session is not recorded as
    // one of this mount's. The one thing taken off it is this mount's own account registrations, by the ids they were
    // made under (`unwireForeign`), since the owner's commands would otherwise go on acting as this mount's accounts
    // and nothing else would ever remove them. The mount is never held up by that: the record lets go of the box
    // whatever came of it, and what may remain is kept beside the record (`ForeignBox`), retried while it can be
    // (`retryForeign`) and otherwise kept as residue for a person, and said in the call's result.
    if (look) {
      // Nothing written and nothing removed: the agent's next call does both, and tells the agent why.
      throw new BoxNotOurs(id, machine);
    }
    // A machine's record or a stranded box's: the same split either way, and only if the record still names it.
    const held: (MachineState & { wired?: Wired[] }) | undefined = machine !== null
      ? await readView(ctx, machine).then((v) => (v.boxId === id ? v : undefined))
      : (await readMount(ctx))?.stranded?.[id];
    if (held) {
      // Proven item by item (`Wired.pairs`, converted on read): one with an id is removed by that id; one without (an
      // older wiring, or a registration the provider answered no id for) cannot be told from the owner's own, so it
      // is residue and never tried. A wiring whose names are not known at all is one residue item with neither.
      const wired = held.wired ?? [];
      const registeredNames = wired.some((w) => !w.pairs) ? null : wired.flatMap((w) => w.pairs!.map((x) => x.name));
      const items: Remaining[] = wired.flatMap((w): Remaining[] => !w.pairs
        ? [{ id: null, name: null, state: "residue", reason: "names_unknown" }]
        : w.pairs.map((x): Remaining => typeof x.id === "string"
          ? { id: x.id, name: x.name, state: "pending" }
          : { id: null, name: x.name, state: "residue", reason: "wiring_without_ids" }));
      // Written as soon as the split is decided, before anything is sent, with everything that describes it: what
      // is to be removed is in it, so an interruption from here leaves an entry `retryForeign` finishes and this path
      // goes on from. Every later write updates its outcome (`unwire`, `remaining`, `attempts`, `lastError`) and
      // nothing else.
      //
      // Found again (an earlier call wrote this split and was interrupted before the record let go of the box), the
      // stored entry is what goes on, never the wiring: its items, its rounds counted and its outcome stand, so the
      // rounds stay at `UNWIRE_ATTEMPTS` in all and residue never returns to pending. A field an earlier shape lacks
      // is filled (`registeredNames`), which changes nothing it said; one without items is begun again from the
      // wiring, keeping the moment it was first found.
      const { next: begun } = await updateSplit(ctx, id, (stored) => {
        const had = settledEntry(stored);
        if (had) return { next: had.registeredNames === undefined ? { ...had, registeredNames } : had };
        return { next: {
          box: id, mount: ctx.alias, machine, reason: "foreign_owner", registeredNames,
          secretIds: items.flatMap((r) => (r.id ? [r.id] : [])), detectedAt: stored?.detectedAt ?? Date.now(),
          unwire: outcomeOf(items), remaining: items, attempts: typeof stored?.attempts === "number" ? stored.attempts : 0, lastError: null,
        } };
      });
      let entry = begun;
      if (entry.unwire === "pending") {
        const round = await sendRound(inner, entry);
        // A round that gives up on a split already told is a new event, told as one with the entry that records it;
        // one not told yet is told below with what it now holds.
        const done = await updateSplit(ctx, id, (stored) => {
          const base = settledEntry(stored) ?? entry;
          const next = applyRound(base, round);
          return { next, note: gaveUpNote(base, next, machine) };
        });
        entry = done.next;
        if (done.note) say("unwire_given_up", id, machine, { accounts: entry.remaining.map((r) => r.name).filter(Boolean).join(","), lastError: entry.lastError ?? "" });
      }
      // The split is told once, before the record lets go (so an interruption after this does not lose it), and never
      // again when it is found again: `told` on its entry says it was, written with the note in one transaction.
      const tell = await updateSplit(ctx, id, (stored) => {
        const base = settledEntry(stored) ?? entry;
        if (base.told) return { next: base };
        const states = { pending: base.remaining.some((r) => r.state === "pending"), residue: base.remaining.some((r) => r.state === "residue") };
        return { next: { ...base, told: true }, note: { boxId: id, machine, outcome: "split", ...states } };
      });
      if (tell.note) {
        // Said once per box, where the record lets go of it, so the rows count the pairs as they come apart.
        say("box_not_ours", id, machine, { unwire: tell.note.pending ? "pending" : tell.note.residue ? "residue" : "removed" });
      }
      if (machine !== null) {
        const now = await readView(ctx, machine);
        await writeView(ctx, machine, {
          boxId: "", createdAt: 0, lastUsedAt: 0,
          ...(now.sessions ? { sessions: now.sessions } : {}), ...(now.envs ? { envs: now.envs } : {}),
          ...(now.startFrom ? { startFrom: now.startFrom } : {}),
        });
      } else {
        const now = await readMount(ctx);
        if (now?.stranded?.[id]) {
          const { [id]: _gone, ...rest } = now.stranded;
          await writeMount(ctx, { ...now, stranded: rest });
        }
      }
    }
    throw new BoxNotOurs(id, machine);
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inner)) if (typeof v === "function") out[k] = v.bind(inner);
  for (const k of BOX_ID_METHODS) {
    const f = (inner as unknown as Record<string, unknown>)[k];
    if (typeof f !== "function") continue;
    out[k] = async (id: string, ...rest: unknown[]) => { await owns(id); return f.call(inner, id, ...rest); };
  }
  out.create = async (spec: BoxSpec) => { const made = await inner.create(spec); shown.add(made.id); return made; };
  out.adopt = async (spec: BoxSpec) => { const id = await inner.adopt(spec); if (id !== null) shown.add(id); return id; };
  out.owns = owns;
  /**
   * Another try at removing this mount's registrations from the foreign boxes still pending (`ForeignBox.pending`):
   * cleared when they are gone, given up on and kept as residue after `UNWIRE_ATTEMPTS` failures in a row.
   */
  out.retryForeign = async (): Promise<void> => {
    for (const [boxId, e] of Object.entries(await readForeign(ctx))) {
      if (e.unwire !== "pending") continue;
      let entry = e;
      // Marked pending with no items written (an interrupted write of an earlier build). With the ids the split
      // recorded, the items are rebuilt from them and go on from the rounds already counted; without them there is
      // nothing to try, and it is residue.
      if (!Array.isArray(e.remaining)) {
        const old = e as unknown as { secretIds?: unknown; names?: unknown; registeredNames?: unknown };
        // An entry of the earlier shape has its names as `names` and no `registeredNames`: taking them over fills a
        // field that was missing, it does not change what was registered.
        const names = Array.isArray(old.registeredNames) ? old.registeredNames as string[] : Array.isArray(old.names) ? old.names as string[] : null;
        const ids = Array.isArray(old.secretIds) ? old.secretIds as string[] : null;
        const named = names !== null && ids !== null && names.length === ids.length;
        const remaining: Remaining[] = ids && ids.length
          ? ids.map((sid, i) => ({ id: sid, name: named ? names![i]! : null, state: "pending" as const }))
          : (names ?? [null]).map((n) => ({ id: null, name: n, state: "residue" as const, reason: "pending without details" }));
        const rebuilt: ForeignBox = { ...e, registeredNames: names, secretIds: ids ?? [], remaining, unwire: outcomeOf(remaining),
          attempts: typeof e.attempts === "number" ? e.attempts : 0, lastError: e.lastError ?? null };
        const done = await updateSplit(ctx, boxId, (stored) => {
          const had = settledEntry(stored);
          if (had) return { next: had };
          return { next: rebuilt, note: rebuilt.unwire !== "pending" ? { boxId, machine: e.machine, outcome: "remains" } : undefined };
        });
        if (done.note) say("unwire_given_up", boxId, e.machine, { lastError: "pending without details" });
        entry = done.next;
        if (entry.unwire !== "pending") continue;
      }
      const round = await sendRound(inner, entry);
      const done = await updateSplit(ctx, boxId, (stored) => {
        const base = settledEntry(stored) ?? entry;
        const next = applyRound(base, round);
        return { next, note: gaveUpNote(base, next, e.machine) };
      });
      if (done.note) say("unwire_given_up", boxId, e.machine, { accounts: done.next.remaining.map((r) => r.name).filter(Boolean).join(","), lastError: done.next.lastError ?? "" });
    }
  };
  return out as unknown as OwnedProvider;
}

/**
 * What an execution looks like once it will not change again.
 *
 * One function, because the call may finish the work itself or hand it over
 * and have it finished elsewhere, and the two must produce the same thing.
 * Built in both places instead, they would be two rules about one shape, and
 * the pair would drift the first time either was edited (#291).
 */
export function finished(
  rec: ExecStatus,
  cfg: ReturnType<typeof cfgOf>,
  state: BoxState | null,
  machine: string = MAIN_MACHINE,
): Record<string, unknown> {
  // A `shell` command reports where it ended; the report is ours, not the command's output.
  const { output: out, cwd } = splitCwd(String(rec.output ?? ""));
  return {
    state: rec.state,
    exitCode: rec.exitCode ?? null,
    ...(cwd ? { cwd } : {}),
    // Allowed, not refused: an agent may need to look in /tmp. But work left there is gone after an idle
    // spell (tmpfs, measured 2026-09-15), so the result says so while the agent is still standing in it.
    // Not on InstaBox, whose idle box is paused with /tmp intact (measured 2026-10-26).
    ...(cwd && cfg.provider !== "instabox" && (cwd === "/tmp" || cwd.startsWith("/tmp/"))
      ? { cwdNote: "files under /tmp do not survive while the container sits idle; keep work in the working directory" }
      : {}),
    ...(rec.state === "error" && rec.reason ? { error: String(rec.reason) } : {}),
    // No `reminder` here. This plugin used to write one into every result —
    // "same container as your earlier calls; it stays until you release it or
    // it sits 30 idle minutes" — and that sentence is true of anything holding
    // a metered resource, so one plugin was the author of a general fact and a
    // second such plugin said nothing at all. The framework writes it now
    // (src/runtime/held.ts, attached as `holding`), from what `holds` declares.
    // What is genuinely this plugin's — that the container is NOT the
    // per-execution JavaScript sandbox (see the naming note on `sandboxPlugin`),
    // what /tmp does, the lease's terms, what `keep` saves — stays in the run and
    // shell descriptions, where the model is told every turn rather than once.
    ...execOutput(out, cfg.maxOutputBytes),
    box: state?.boxId ?? null,
    // Which machine, when it is not the default: the agent named it, and a
    // result that does not say so reads like one from the default machine.
    ...(machine !== MAIN_MACHINE ? { machine } : {}),
    // So the agent learns the environment from a result it already has,
    // instead of spending turns probing for an interpreter. The container's
    // own image, not the setting: a box from before the default changed, or one
    // started from an environment kept then, is still the old image.
    image: state?.image ?? null,
    ...(state?.image ? {} : {
      imageNote: "not recorded for this container (it predates recording, or started from an environment " +
        "kept before then); read /etc/os-release",
    }),
    ...(state?.envs?.length ? { kept: state.envs.map((e) => e.name) } : {}),
    ...accountsNote(state),
  };
}

/**
 * The default machine's view of the record (see `viewOf`), or null when the
 * record does not read. What every reader of one box asked before machines,
 * and what it still means: a record written by any version reads here, an old
 * single box as "main".
 */
export function asBoxState(v: Json): BoxState | null {
  const mount = asMountState(v);
  return mount ? viewOf(mount, MAIN_MACHINE) : null;
}

/**
 * The record, as machines by name and what they share, or null when it does
 * not read — under the rules `readBox` states for one box.
 *
 * **An old record is the machine "main", never an error.** A record from before
 * machines has one box at the top level; it reads as that box under the
 * default name, and the next write stores it in the new shape. That is the
 * whole migration: no step runs ahead of it, so a row nobody touches again is
 * still read correctly.
 *
 * In the new shape, an entry under a name that is not a machine name, or one
 * that does not read as a box, is dropped and counted (`unreadableEntries`) —
 * the same leniency as a bad line of history, for the same reason: one damaged
 * entry must not lose the other machines, which exist and are billed.
 */
export function asMountState(v: Json): MountState | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.machines === undefined) {
    const old = readBox(v);
    if (!old) return null;
    const { sessions, envs, ...box } = old;
    return {
      machines: box.boxId || box.startFrom ? { [MAIN_MACHINE]: box } : {},
      ...(sessions ? { sessions } : {}),
      ...(envs ? { envs } : {}),
    };
  }
  const listed = o.machines;
  if (!listed || typeof listed !== "object" || Array.isArray(listed)) return null;
  const machines: Record<string, MachineState> = {};
  for (const [name, entry] of Object.entries(listed as Record<string, unknown>)) {
    if (!MACHINE_RE.test(name)) continue;
    const read = readBox(entry as Json);
    if (!read) continue;
    const { sessions: _s, envs: _e, ...box } = read;
    machines[name] = box;
  }
  // Read like a machine, entry by entry: an entry that does not read is dropped, the others kept.
  const stranded: Record<string, StrandedBox> = {};
  if (o.stranded && typeof o.stranded === "object" && !Array.isArray(o.stranded)) {
    for (const [id, entry] of Object.entries(o.stranded as Record<string, unknown>)) {
      const read = readBox(entry as Json);
      if (!read || read.boxId !== id || typeof (entry as any).strandedAt !== "number") continue;
      const { sessions: _s, envs: _e, ...box } = read;
      stranded[id] = box as StrandedBox;
    }
  }
  return {
    machines,
    ...(Array.isArray(o.sessions) ? { sessions: o.sessions.filter(isSession) } : {}),
    ...(Array.isArray(o.envs) ? { envs: o.envs.filter(isEnv) } : {}),
    ...(Object.keys(stranded).length ? { stranded } : {}),
  };
}

/** One box's record: a whole record before machines, or one machine's entry since. */
function readBox(v: Json): BoxState | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.boxId !== "string") return null;
  if (typeof o.createdAt !== "number" || typeof o.lastUsedAt !== "number") return null;
  // Only the id and the clocks decide whether this is a container record. The
  // two lists are read element by element, and what cannot be read is dropped
  // rather than taking the row with it: a row whose id reads names a box that
  // exists and is billed, so answering "nothing is running" would start a
  // second one and leave this one for nobody to release. Dropped, not
  // repaired — a guessed `lastUsedAt` is a reading nobody took, and the window
  // already forgets entries without saying so. The cost is chosen, not missed:
  // a corrupt `envs` reads as "nothing kept", so the agent rebuilds instead of
  // being told, and the snapshots it named stay in run9 with nothing here
  // naming them. That is one wasted setup against a second container nobody
  // releases, for a shape no version of this code writes. Unread, an element is worse
  // than a miss: `null` throws at `s.boxId` or `e.name`, and one missing a
  // field ships `undefined` into the console's usage report (2026-09-12 for
  // the lists, 2026-09-15 for what is in them).
  //
  // `wired` is the exception: an entry dropped there would leave its
  // registrations on the box, a credential still usable from inside with
  // nothing here naming it to take away. So a list that does not read whole is
  // read as "unknown", which the next command answers by deleting every
  // registration on the box and wiring again. A record from before `wired`
  // (`githubPlaceholder`) names the two GitHub registrations but no mount, so
  // it matches none and is redone the same way.
  const { sessions, envs, wired, leftOut, githubPlaceholder, githubTokenDigest: _d, githubWithheld: _w, ...rest } = o;
  const wiring = Array.isArray(wired)
    ? (wired.every(isWired) ? (wired as Wired[]).map(withPairs) : [UNKNOWN_WIRING])
    : wired !== undefined ? [UNKNOWN_WIRING]
    : typeof githubPlaceholder === "string"
      ? [{ alias: "", plugin: "github", placeholder: githubPlaceholder, digest: "", names: ["GH_TOKEN", "GH_TOKEN_GIT"] }]
      : null;
  return {
    ...(rest as unknown as BoxState),
    ...(Array.isArray(sessions) ? { sessions: sessions.filter(isSession) } : {}),
    ...(Array.isArray(envs) ? { envs: envs.filter(isEnv) } : {}),
    ...(wiring ? { wired: wiring } : {}),
    ...(Array.isArray(leftOut) ? { leftOut: leftOut.filter(isLeftOut) } : {}),
  };
}

function isWired(v: unknown): v is Wired {
  if (!v || typeof v !== "object") return false;
  const w = v as Record<string, unknown>;
  return typeof w.alias === "string" && typeof w.plugin === "string" && typeof w.placeholder === "string"
    && typeof w.digest === "string"
    && (w.names === null || (Array.isArray(w.names) && w.names.every((x) => typeof x === "string")))
    && (w.pairs === undefined || (Array.isArray(w.pairs) && w.pairs.every((x) => !!x && typeof x === "object"
      && typeof (x as { name?: unknown }).name === "string" && ((x as { id?: unknown }).id === null || typeof (x as { id?: unknown }).id === "string"))))
    && (w.summary === undefined || typeof w.summary === "string")
    && (w.env === undefined || (typeof w.env === "object" && w.env !== null && !Array.isArray(w.env)
      && Object.values(w.env).every((x) => typeof x === "string")));
}

function isLeftOut(v: unknown): v is LeftOut {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return typeof l.alias === "string" && typeof l.why === "string";
}

function isSession(v: unknown): v is Session {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.boxId === "string" && typeof s.startedAt === "number"
    && typeof s.endedAt === "number" && typeof s.lastUsedAt === "number"
    && typeof s.execs === "number"
    && Array.isArray(s.saved) && s.saved.every((x) => typeof x === "string")
    && (s.machine === undefined || typeof s.machine === "string");
  // `credentialRef` is not judged here: a kind this build does not know (one a later build added) costs the session
  // nothing but that field, which every reader takes through `createdUnder` and reads as absent — a session from
  // before the field existed. Refusing the whole session over it would drop time that was really spent.
}

const REF_KINDS: readonly CredentialRefKind[] = ["none", "agent", "operator", "env", "other"];
/** A stored credential kind, or undefined when it is not one: read leniently, like the rest of the record. */
function refKindOf(v: unknown): CredentialRefKind | undefined {
  return REF_KINDS.includes(v as CredentialRefKind) ? v as CredentialRefKind : undefined;
}

function isEnv(v: unknown): v is Env {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.name === "string" && typeof e.snapId === "string"
    && typeof e.savedAt === "number" && (e.note === undefined || typeof e.note === "string")
    && (e.image === undefined || typeof e.image === "string");
}

/**
 * How many entries `asBoxState` will drop from this record: unreadable elements,
 * a list that is not a list counts as one, and a record that is present but does
 * not read at all counts as one. Reported through `activity` so leniency that
 * keeps a billed container does not also hide a corrupt record.
 *
 * The row was the case that leniency missed. Reading its fields without ever
 * asking whether the row is a row cannot report a broken row,
 * and the three ways `asBoxState` answers `null` are told apart by what is
 * present rather than by what parses: never written is clean, the record
 * `release` leaves behind is clean because `{boxId: ""}` reads, and present but
 * unreadable is damage. That last one is why this matters more than the
 * elements do — `asBoxState` answers "no container", the sweep skips a mount
 * with no `boxId` (cf/src/runtime.ts), and the console draws an idle mount, so
 * a real id scrambled in that row names a container nobody releases and nobody
 * sees. Counting the absent ones instead would put "corrupt" on every idle
 * mount, which is how an alarm stops being read.
 */
export function unreadableEntries(v: Json): number {
  if (v === null || v === undefined) return 0;
  if (typeof v !== "object") return 1;
  const o = v as Record<string, unknown>;
  const count = (list: unknown, readable: (x: unknown) => boolean) =>
    list === undefined ? 0 : Array.isArray(list) ? list.filter((x) => !readable(x)).length : 1;
  const shared = count(o.sessions, isSession) + count(o.envs, isEnv);
  if (o.machines === undefined) {
    return (asBoxState(v) === null ? 1 : 0) + shared + count(o.wired, isWired) + count(o.leftOut, isLeftOut);
  }
  // The new shape: the map itself, then each entry as a box record of its own.
  const listed = o.machines;
  if (!listed || typeof listed !== "object" || Array.isArray(listed)) return 1 + shared;
  let bad = 0;
  for (const [name, entry] of Object.entries(listed as Record<string, unknown>)) {
    const e = entry as Record<string, unknown> | null;
    if (!MACHINE_RE.test(name) || readBox(entry as Json) === null) { bad += 1; continue; }
    bad += count(e?.wired, isWired) + count(e?.leftOut, isLeftOut);
  }
  return bad + shared;
}

const SESSIONS_KEPT = 20;

/**
 * The provider this mount asked for, refused if we do not have it.
 *
 * The setting's `choices` stop a bad value at the page and at mount time, but a
 * mount written before a provider was removed — or by anything that did not go
 * through the validator — reaches here. Refusing is the same call as the
 * network gate: a value we do not recognise must not fall through to the one we
 * happen to implement, because "it ran on run9" would then be the answer to
 * "run it on something else".
 */
export function providerOf(cfg: { provider?: string }): SandboxBackend["id"] {
  const asked = cfg.provider ?? "run9";
  if (!Object.hasOwn(BACKENDS, asked)) {
    throw new Error(`this sandbox mount asks for the "${asked}" provider, and only ${Object.keys(BACKENDS).join(" and ")} are implemented`);
  }
  return asked as SandboxBackend["id"];
}

/** Every provider implemented, by the name a mount's `provider` setting uses. */
const BACKENDS: Record<SandboxBackend["id"], SandboxBackend> = { run9, instabox };
/** The names the `provider` setting may take. */
export const PROVIDERS = Object.keys(BACKENDS) as Array<SandboxBackend["id"]>;

/**
 * The adapter that runs this mount's containers, by its `provider` setting, on every path: a mount naming one we
 * do not have is refused by each (`providerOf`), never run on another.
 */
function backendFor(cfg: { provider?: string }): SandboxBackend {
  return BACKENDS[providerOf(cfg)];
}

/**
 * Settings one provider cannot use (`Plugin.configProblem`): asked when the mount is made, and by `invoke` before a
 * machine is made or used, so a mount saved before a rule existed is refused too.
 */
function configProblemOf(c: SandboxConfig): string | undefined {
  if (c.provider !== "instabox") return undefined;
  if (c.shape !== undefined && !shapeOf(c.shape)) return `shape must read like 2c4g (vCPUs, then GiB of memory) on InstaBox; got ${JSON.stringify(c.shape)}`;
  if (typeof c.endpoint === "string" && /run\.sys9\.ai/.test(c.endpoint)) return "endpoint names run9, and this mount asks for InstaBox; leave it out for api.instabox.sh";
  if (c.maxLifetimeHours !== undefined && !(typeof c.maxLifetimeHours === "number" && c.maxLifetimeHours >= 1 && c.maxLifetimeHours <= 24)) {
    return "maxLifetimeHours must be between 1 and 24: InstaBox deletes a machine at most a day after it is created";
  }
  // Without an image, commands run on the machine as its user, who holds the Docker socket. The empty network
  // namespace `network: none` puts a command in does not cut off Unix sockets, and through that one a container
  // started on the host's network reaches the internet (measured 2026-10-26). With an image, the command is in a
  // container Docker made without a network, with no Docker socket in it.
  if (c.network !== undefined && c.network !== "open" && !c.image) {
    return "on InstaBox, network none needs an image: without one, commands run on the machine itself, where Docker " +
      "can start a container on the host's network; set image, or leave network open";
  }
  return undefined;
}

/** Where an InstaBox mount's defaults differ from the plugin's. */
const INSTABOX_DEFAULTS = {
  endpoint: INSTABOX_ENDPOINT,
  // Commands run as the box's user, whose HOME is /data/home: a directory at the root needs sudo to make.
  workdir: "/data/home/work",
  // The smallest size InstaBox sells (Pro and up): 2 vCPUs, 4 GiB.
  shape: "2c4g",
  // No container: commands run on the machine, from its template. A mount's `image` runs as a container in it.
  image: "",
};

const DEFAULTS = {
  provider: "run9",
  verifyWith: "provider" as const,
  /** Installs and scripts share one directory, or Node resolves modules from
   *  wherever the script sits and cannot find what npm just installed. */
  workdir: "/work",
  shell: "/bin/sh",
  shellPrefix: "",
  network: "open" as const,
  accounts: "all" as const,
  endpoint: "https://api.run.sys9.ai",
  image: "public.ecr.aws/docker/library/node:24-bookworm",
  project: "default",
  timeoutMs: 120_000,
  graceMs: 5_000,
  maxOutputBytes: 24_000,
  maxQuietMinutes: 60,
  keepStoppedDays: 7,
  maxMachines: 3,
  template: "universal",
  maxLifetimeHours: 24,
  maxRunMinutes: 480,
};

/**
 * Delete one box at its provider with the mount's credential (`SandboxProvider.delete`). `error` when it is not
 * gone; `definitive` when the provider's refusal is one a retry will not change — the only refusal an operator's
 * `forget` acts on.
 *
 * Failures are reported rather than swallowed. An earlier version buried them
 * on the theory that "the box stops itself eventually"; the result was thirteen
 * live boxes and a release path that had been announcing success the whole time.
 *
 * Already gone is what a delete is for, and is believed only when `believeGone`: the caller knows whether this
 * key could be shown the box at all.
 */
async function deleteBox(ctx: PluginContext, boxId: string, believeGone: boolean): Promise<{ error?: string; definitive: boolean }> {
  const provider = openProvider(cfgOf(ctx), ctx);
  try {
    await provider.delete(boxId);
    return { definitive: false };
  } catch (e) {
    // Another agent's box is not this mount's to delete, and the caller lets go of it without a release.
    if (e instanceof BoxNotOurs) throw e;
    if (e instanceof ProviderError) {
      if (believeGone && e.code === "not_found") return { definitive: false };
      return { error: e.message, definitive: e.definitive };
    }
    return { error: String((e as Error)?.message ?? e).slice(0, 160), definitive: false };
  }
}

async function stopBox(
  ctx: PluginContext, machine: string, opts?: { forget?: boolean },
): Promise<{ boxId: string; freed: boolean; error?: string; forgotten?: true; liveMs: number; lease: Released | null } | null> {
  const state = await readView(ctx, machine);
  if (!state.boxId || !ctx.credential) return null;
  // Already gone is believed only when the mount's credential is the same KIND as the one the box records it
  // was made under (`credentialRef`) — a kind check, not an account check: a key of another account is not shown
  // the box, so its "not found" says nothing, and a kind that differs is certainly another key; two keys of one
  // kind may still be two accounts, which the kind cannot tell apart.
  const maker = state.credentialRef === undefined || state.credentialRef === ctx.credentialRefKind;
  let deleted: { error?: string; definitive: boolean };
  try {
    deleted = await deleteBox(ctx, state.boxId, maker);
  } catch (e) {
    // Another agent's box: the record already let go of it (`ownedProvider`), and nothing was held here to release.
    if (e instanceof BoxNotOurs) return null;
    throw e;
  }
  const { error, definitive } = deleted;
  const endedAt = Date.now();
  const stoppedAt = parkedAt(state);
  const session = sessionOf(state, stoppedAt ?? endedAt, machine);
  // A box run9 would not delete is still there, still billed, and still reachable by the key that made it — so
  // the record keeps naming it, and every later release (the agent's, the idle pass's, an operator's, the one a
  // change of key makes first) tries again until the delete succeeds. Forgetting it here made a refusal hold
  // once: the next attempt found nothing held and let the key change, and the box was never reachable again
  // (#818). Its session is not recorded either: it has not ended.
  //
  // The exception is an operator's explicit `forget`, after run9 refused the delete outright (a 4xx, not an
  // outage): the way out when the key that made the box is gone for good. The record goes as on success, and the
  // lease is reported as an error naming what was forgotten, so the box is on the record as possibly still alive.
  if (error && !(opts?.forget && definitive)) {
    // One error lease per box, not one per attempt: a box that keeps refusing is retried by every release, and
    // its first failure already put it on the record as alive and billed (`deleteFailedAt`).
    const now = await readView(ctx, machine);
    const first = !now.deleteFailedAt;
    if (first && now.boxId === state.boxId) await writeView(ctx, machine, { ...now, deleteFailedAt: endedAt });
    return {
      boxId: state.boxId, freed: false, error, liveMs: session.endedAt - session.startedAt,
      lease: first ? { id: state.boxId, startedAt: stoppedAt ?? session.startedAt, endedAt, status: "error", error } : null,
    };
  }
  const forgotten = error ? `forgotten on an operator's request; ${providerName(cfgOf(ctx))} refused the delete (${error}), so it may still be alive` : undefined;
  // The record goes once the box has, but the session survives it. A container is the one thing here
  // billed for merely existing, so how long it lived outlives the box.
  //
  // Built from the state this call read, not from whatever the record says now:
  // the two differ exactly when something else has already recorded another
  // container, and a session describing *that* box would report a container
  // that is still running as finished.
  //
  // A box switched off for being idle already recorded its compute session
  // when it was switched off (parkBox), so deleting it adds none: a second
  // one from `createdAt` would count the days it sat stopped as compute.
  // Read again before overwriting. `releaseTask` does not take the per-mount
  // lock that `invoke` takes, so an operator release or the idle sweep can
  // interleave with a command on this mount: the command finds no container,
  // creates one and records it, and clearing the record on top would leave that
  // container alive and billed with nothing naming it — the orphan `asBoxState`
  // refuses to create. A lock in the gateway closes the
  // window inside one object; this half does not depend on the caller.
  //
  // The shared lists are taken from this second read, not the first: another
  // machine of the mount may have added a session or kept an environment since.
  const now = await readView(ctx, machine);
  const mine = !now.boxId || now.boxId === state.boxId;
  await writeView(ctx, machine, mine
    ? {
      boxId: "", createdAt: 0, lastUsedAt: 0,
      sessions: stoppedAt ? (now.sessions ?? []) : keepSessions(now.sessions, session),
      // Kept environments outlive the container by construction — a forked
      // snapshot is independent of the box it came from — so losing the record of
      // them here would strand real storage under ids nobody can name any more.
      ...(now.envs?.length ? { envs: now.envs } : {}),
    }
    // Somebody else's container is in the record. Leave it named, and add only
    // what this release knows: the session the released box just finished.
    : { ...now, ...(stoppedAt ? {} : { sessions: keepSessions(now.sessions, session) }) });
  // Both instants travel, not just their difference: the recorder checks that
  // the duration it stores is this fact's own `endedAt - startedAt`, and they
  // all come from `session`, which was built from the state THIS call read.
  //
  // For a switched-off box the span is the time it sat stopped: its compute
  // span was reported when it was switched off, and this release ended the
  // rest of its life, the disk.
  return {
    boxId: state.boxId, freed: true, liveMs: session.endedAt - session.startedAt,
    ...(forgotten ? { forgotten: true as const, error: forgotten } : {}),
    lease: forgotten
      ? { id: state.boxId, startedAt: stoppedAt ?? session.startedAt, endedAt, status: "error", error: forgotten }
      : { id: state.boxId, startedAt: stoppedAt ?? session.startedAt, endedAt, status: "freed" },
  };
}

/**
 * Switch an idle box off and keep it: the idle lease's step for a running box.
 *
 * `SandboxProvider.stop` keeps the box and its disk, and the next exec on the
 * same id starts it again with its files. So an idle machine stops billing
 * compute without its agent losing anything, which is why no warning comes
 * before this step and one does come before the deletion that follows much
 * later (`activityOf`).
 *
 * The compute session ends here and is recorded the way `stopBox` records one,
 * because the next use starts a new one (`createdAt` moves then). A stop the
 * provider refused is thrown with its fact, as `stopBox` does: a box still
 * running must not read as switched off.
 */
async function parkBox(ctx: PluginContext, machine: string, state: BoxState): Promise<Released | false | "gone"> {
  if (!ctx.credential) return false;
  const cfg = cfgOf(ctx);
  const backend = backendFor(cfg);
  const provider = openProvider(cfg, ctx);
  // A provider that keeps memory across a pause (InstaBox) pauses an idle box, and the box stays paused until it
  // is used or deleted. Everything else is switched off.
  const pausing = backend.caps.pause === "memory" && typeof provider.pause === "function";
  let error: string | undefined;
  try {
    if (pausing) await provider.pause!(state.boxId);
    else await provider.stop(state.boxId);
  } catch (e) {
    // Another agent's box: not switched off, and the record no longer names it, so there is nothing to release.
    if (e instanceof BoxNotOurs) return false;
    // Deleted by InstaBox already: nothing to pause, and the caller lets it go as gone (`releaseMachine`).
    if (await goneAfter(backend, provider, state, e)) return "gone";
    error = e instanceof ProviderError ? e.message : String((e as Error)?.message ?? e).slice(0, 160);
  }
  const endedAt = Date.now();
  const session = sessionOf(state, endedAt, machine);
  const fact: Released = {
    id: state.boxId, startedAt: session.startedAt, endedAt,
    status: error ? "error" : "freed", ...(error ? { error } : {}),
  };
  if (error) throw markReleased(new Error(`${backend.name} box ${state.boxId} not ${pausing ? "paused" : "switched off"}: ${error}`), fact);
  // Read again before writing, for the reason `stopBox` does: a command may
  // have recorded another box meanwhile, and that one is running.
  const now = await readView(ctx, machine);
  if (now.boxId === state.boxId) {
    // A postponement is spent by the time this runs (the pass waits for the later of the two), and one left
    // in the record would hold off the deletion schedule by its old instant.
    const { quietUntil: _q, ...rest } = now;
    await writeView(ctx, machine, { ...rest, parkedAt: endedAt, ...(pausing ? { parkedAs: "paused" } : {}), sessions: keepSessions(now.sessions, session) });
  }
  return fact;
}

/** Whether the idle lease paused this box with its memory kept, rather than switching it off (`parkedAs`). */
function pausedOf(state: { parkedAt?: unknown; parkedAs?: unknown } | null | undefined): boolean {
  return parkedAt(state) !== null && state?.parkedAs === "paused";
}

/** Whether the provider's own deletion time (`BoxState.deleteAt`) has come: the box is gone then, whatever it was doing. */
function pastDeleteAt(state: { deleteAt?: unknown }, now = Date.now()): boolean {
  return typeof state.deleteAt === "number" && Number.isFinite(state.deleteAt) && state.deleteAt <= now;
}

/**
 * Whether an InstaBox box that a request just failed on has been deleted by InstaBox: its `deleteAt` has come, or
 * the request was answered `not_found` and InstaBox, asked about the machine, does not have it. The second look is
 * needed because a `not_found` may be about something else (a file a download named). Only InstaBox deletes a box
 * on its own, so a run9 box is never judged here, and no request is added on run9's paths.
 */
async function goneAfter(backend: SandboxBackend, provider: SandboxProvider, state: BoxState, e: unknown): Promise<boolean> {
  if (backend.id !== "instabox" || !state.boxId) return false;
  if (pastDeleteAt(state)) return true;
  if (!(e instanceof ProviderError && e.code === "not_found")) return false;
  return (await provider.status(state.boxId).catch(() => null)) === "gone";
}

/**
 * Deletes, where the provider can, the snapshots among these that nothing of the mount refers to any more: no kept
 * environment names it, and no machine is waiting to start from it (`startFrom`, which `start_from` set). Its
 * storage is billed and counted against a limit (InstaBox). One a machine is waiting on is left, and deleted when
 * that machine has been made from it or has chosen another (`invoke`, `start_from`). The ones it could not delete.
 */
async function dropSnapshots(ctx: PluginContext, provider: SandboxProvider, snapIds: Array<string | undefined>): Promise<string[]> {
  if (!provider.deleteSnapshot) return [];
  const mount = await readMount(ctx);
  const used = new Set([
    ...(mount?.envs ?? []).map((e) => e.snapId),
    ...Object.values(mount?.machines ?? {}).map((b) => b.startFrom),
  ]);
  let notDeleted: string[] = [];
  for (const snapId of new Set(snapIds)) {
    if (!snapId || used.has(snapId)) continue;
    try { await provider.deleteSnapshot(snapId); } catch { notDeleted = [...notDeleted, snapId]; }
  }
  return notDeleted;
}

/**
 * The argv one command becomes. With `network: "none"` the shell itself is
 * started inside an empty network namespace, so nothing the command spawns can
 * inherit a route out.
 *
 * **Closed unless the value says open.** This used to isolate only on the exact
 * word "none", so every other string — `"None"`, `"nome"`, `""` — got a network
 * silently, and the one place that reads the setting from outside is
 * `bench/swebench/cf.ts`, which passes `process.env.NETWORK` through unchecked
 * to a benchmark whose own default is `"none"`. A gate that a typo opens is not
 * a gate. An absent value is still open, because that is the declared default
 * and mounts rely on it; a *present* value that is not `"open"` isolates, which
 * is the direction a mistake should fail in.
 */
/**
 * What a finished container leaves behind, as one readable thing.
 *
 * Extracted so the record's contents can be asserted without a live box —
 * `stopBox` needs a credential and a network, so nothing in the suite reaches
 * the object literal this used to be. The field that makes that worth doing is
 * `lastUsedAt`: it is carried *from* the live state while the line just below
 * its old home resets every other field of that state to zero. That line is
 * correct and looks correct, which is the danger — extending it by one token
 * would be consistent with its neighbours and would quietly empty this record.
 */
/**
 * This mount's activity, in the shape everyone else asks in.
 *
 * The console, the idle sweep and the rename operation all want one fact — is
 * something running here — and until now each read `boxId` and `lastUsedAt` out
 * of this plugin's own state. That is the coupling the audit found in two
 * places and the reason a mount could only be found by the alias `node`. The
 * adapter is four lines and it is the whole fix: callers ask, this answers.
 */
export function activityOf(
  state: BoxState | null | undefined,
  unreadable = 0,
  keepStoppedDays: number = DEFAULTS.keepStoppedDays,
  /** How the agent names this machine, when the mount has several or it is not the default one. */
  label: { name?: string; args?: Record<string, Json> } = {},
): MountActivity {
  const billing = "billed for every second it exists, not per call";
  if (!state?.boxId) return { live: null, billing, ...(unreadable ? { unreadable } : {}) };
  // An unused box is idle from when it started, not from zero: the same
  // rule the release record follows, so the two agree about its age.
  const used = state.lastUsedAt || state.createdAt;
  const stopped = parkedAt(state);
  if (stopped !== null) {
    // Switched off, or paused (InstaBox): the next step deletes the disk, which loses files, so this
    // one waits days and is announced. Idle from when it was switched off, or
    // from a later touch (`keep` stamps one without starting it).
    const days = keepDaysOf({ keepStoppedDays });
    const idleFrom = Math.max(stopped, used);
    // A provider that deletes the box on its own at a set time (`deleteAt`) does it then whatever this says, so
    // the schedule ends there, and the warning comes before it.
    const until = typeof state.deleteAt === "number" && Number.isFinite(state.deleteAt) ? state.deleteAt - idleFrom : Infinity;
    const maxMs = until === Infinity ? days * DAY : Math.max(60_000, Math.min(days * DAY, until));
    const warnMs = Math.min(stoppedWarnMs(days), maxMs / 2);
    return {
      live: {
        id: state.boxId,
        startedAt: state.createdAt,
        lastUsedAt: idleFrom,
        ...createdUnder(state),
        lease: {
          maxMs,
          warnMs,
          consequence: pausedOf(state)
            ? "the paused machine and everything on its disk will be deleted"
            : "the stopped machine and everything on its disk will be deleted",
          advice: "Before then, `save` the files you need or `keep` the environment, or run anything in it to "
            + (pausedOf(state) ? "resume it." : "switch it back on."),
          maxPostponeMinutes: Math.floor(maxMs / 60_000),
        },
        ...label,
      },
      quietUntil: state.quietUntil ?? null,
      ...(unreadable ? { unreadable } : {}),
      billing: pausedOf(state)
        ? "paused: no compute is billed; its memory and disk are kept, and billed as storage, until it is deleted"
        : "stopped: no compute is billed; only its disk is kept until it is deleted",
    };
  }
  return {
    live: {
      id: state.boxId,
      startedAt: state.createdAt,
      lastUsedAt: used,
      ...createdUnder(state),
      // Running: the idle step only switches it off and loses nothing on its
      // disk, so it is taken at the deployment's limit without a warning — a
      // warning is a model turn, and there is nothing to answer it with.
      lease: { warnMs: 0 },
      ...label,
    },
    quietUntil: state.quietUntil ?? null,
    ...(unreadable ? { unreadable } : {}),
    billing,
  };
}

/**
 * How a machine is named to the agent in what the framework says about it: by
 * name whenever the mount has several or it is not the default, and with the
 * argument the tools need whenever it is not the default (they act on "main"
 * without one).
 */
function labelOf(machine: string, several: boolean): { name?: string; args?: Record<string, Json> } {
  if (machine !== MAIN_MACHINE) return { name: machine, args: { machine } };
  return several ? { name: machine } : {};
}

/**
 * One activity per machine that has a box, each on its own schedule; one empty
 * activity when none has. What `holds.activities` answers.
 */
export function activitiesOf(
  mount: MountState | null, unreadable = 0, keepStoppedDays: number = DEFAULTS.keepStoppedDays,
): MountActivity[] {
  const names = boxedMachines(mount);
  const aside = Object.values(mount?.stranded ?? {}).map(strandedActivity);
  if (!names.length) return aside.length ? aside : [activityOf(null, unreadable, keepStoppedDays)];
  return [...names.map((n) => activityOf(viewOf(mount, n), unreadable, keepStoppedDays, labelOf(n, names.length > 1))), ...aside];
}

/**
 * A stranded box as held: no machine of the agent's, nothing to warn it about (it can neither use nor save from
 * it), so it is released at the deployment's limit without a warning, counted from when it was set aside.
 *
 * A trade-off, chosen: if the new key is on the same account as the dead one, that release succeeds — the box is
 * deleted about `maxMs` (30 minutes by default) after it was set aside, with no warning to the agent, and any file
 * in it that was not saved or kept is lost. Warning would mean a turn about a machine the agent cannot reach, and
 * keeping it would leave it billed for nobody; the console showed the deletion would happen when the key changed.
 */
function strandedActivity(b: StrandedBox): MountActivity {
  return {
    live: {
      id: b.boxId, startedAt: b.createdAt, lastUsedAt: b.strandedAt, ...createdUnder(b),
      lease: { warnMs: 0 }, name: `stranded box ${b.boxId}`,
    },
    quietUntil: null,
    billing: "set aside: made with a credential that no longer works; still billed until it is deleted",
  };
}

/**
 * The one answer for "is anything running here" (`holds.activity`): a running
 * machine before a switched-off one, then the most recently used. A running one
 * is what bills by the second and what makes a rename unsafe, so it is the one
 * a single answer must not hide.
 */
export function summaryActivity(
  mount: MountState | null, unreadable = 0, keepStoppedDays: number = DEFAULTS.keepStoppedDays,
): MountActivity {
  const names = boxedMachines(mount);
  const used = (n: string) => { const b = mount!.machines[n]!; return b.lastUsedAt || b.createdAt; };
  const off = (n: string) => parkedAt(mount!.machines[n]) === null ? 0 : 1;
  const pick = [...names].sort((a, b) => off(a) - off(b) || used(b) - used(a))[0];
  const one = pick === undefined
    ? activityOf(null, unreadable, keepStoppedDays)
    : activityOf(viewOf(mount, pick), unreadable, keepStoppedDays, labelOf(pick, names.length > 1));
  // Set-aside boxes beside it: still held and billed, so the console lists them and usage counts them.
  const aside = Object.values(mount?.stranded ?? {}).map((b) => ({ id: b.boxId, startedAt: b.createdAt, since: b.strandedAt, ...createdUnder(b) }));
  return aside.length ? { ...one, aside } : one;
}

/** The kind of credential a box or session records it was created under, when it records one that reads. */
function createdUnder(v: { credentialRef?: unknown }): { credentialRef?: CredentialRefKind } {
  const kind = refKindOf(v.credentialRef);
  return kind ? { credentialRef: kind } : {};
}

/** What this mount has finished with, newest first, from its own window. */
export function usageOf(state: BoxState | null | undefined): MountUsage[] {
  return (state?.sessions ?? []).map((s) => ({
    id: s.boxId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    lastUsedAt: s.lastUsedAt,
    uses: s.execs,
    kept: s.saved,
    ...createdUnder(s),
  }));
}

/**
 * The window after one more container finishes: newest first, oldest dropped.
 *
 * A function rather than a slice at the call site so the cap is a rule that can
 * fail a test. The number itself is a choice about how much state to carry in a
 * box record, not about how much history matters — the history lives
 * where the key does.
 */
export function keepSessions(prior: Session[] | undefined, next: Session): Session[] {
  return [next, ...(prior ?? [])].slice(0, SESSIONS_KEPT);
}

export function sessionOf(
  state: { boxId: string; createdAt: number; lastUsedAt?: number; execs?: number; saved?: string[]; credentialRef?: CredentialRefKind },
  endedAt: number,
  machine: string = MAIN_MACHINE,
): Session {
  return {
    ...(machine !== MAIN_MACHINE ? { machine } : {}),
    boxId: state.boxId,
    startedAt: state.createdAt,
    endedAt,
    // Held-while-working versus held-while-idle is the only term that separates
    // the two release policies, and it is computable only from here.
    lastUsedAt: state.lastUsedAt || state.createdAt,
    execs: state.execs ?? 0,
    saved: state.saved ?? [],
    ...createdUnder(state),
  };
}

/**
 * What of a command's output the agent gets, and what it is told about the rest.
 *
 * The setting said the overflow was "parked as an artifact". Nothing parked it:
 * the output was sliced and the remainder dropped, and the agent was left a
 * bare `truncated: true` it could do nothing with — it cannot ask for the rest,
 * and nothing told it the rest was gone rather than waiting somewhere.
 *
 * So the result now says how much went and what to do instead. The box has a
 * real filesystem and a save tool, so a command whose output matters can
 * redirect it to a file and keep that; the one thing the agent must not do is
 * assume the tail is retrievable.
 *
 * Exported because no benchmark has ever crossed this threshold — the path
 * exists and has never run — and a unit test is the only thing that will
 * exercise it before a person does.
 */
export function execOutput(out: string, maxOutputBytes: number): {
  output: string;
  truncated: boolean;
  dropped?: number;
  note?: string;
} {
  if (out.length <= maxOutputBytes) return { output: out, truncated: false };
  return {
    output: out.slice(0, maxOutputBytes),
    truncated: true,
    dropped: out.length - maxOutputBytes,
    note: "the rest was discarded, not stored: re-run sending output to a file and `save` it",
  };
}

export function execArgv(
  cfg: { shell: string; shellPrefix?: string; network?: "open" | "none"; isolate?: readonly string[] },
  command: string,
  env: Record<string, string> = {},
): string[] {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'; `).join("");
  const line = exports + (cfg.shellPrefix ? `${cfg.shellPrefix}${command}` : command);
  const argv = [cfg.shell, "-lc", line];
  const open = cfg.network === undefined || cfg.network === "open";
  // The prefix is the provider's (`SandboxBackend.isolateNetwork`); run9's when none is given.
  return open ? argv : [...(cfg.isolate ?? ["unshare", "-n", "--"]), ...argv];
}

/**
 * What a default image was measured to contain, on a fresh box, by image.
 *
 * The shell description tells the agent what is there, because finding out costs
 * a billed call and a model turn. That is a claim about a registry tag nothing in
 * this repo can see, so it is kept as a dated measurement, and the suite fails
 * when the default image has no entry: changing the default stays red until
 * someone measures the new one. It cannot prove the measurement was honest; it
 * removes the case where nobody took one.
 */
export const MEASURED_IMAGES: Record<string, {
  measured: string; os: string; present: string[]; missing: string[]; install: string;
  /** What was run on the fresh box, so the next person can run it again and compare. */
  command: string;
}> = {
  // Measured twice, separately, on fresh run9 boxes: Node v24.21.0, npm 11.19.0.
  "public.ecr.aws/docker/library/node:24-bookworm": {
    measured: "2026-09-15", os: "Debian",
    present: ["Node", "npm", "git", "curl", "make", "gcc/g++", "Python 3", "bash", "ssh", "apt-get"],
    missing: ["pip", "jq", "rg", "gh"],
    install: "apt-get update && apt-get install -y <pkg>",
    command: "for t in node npm git curl make gcc g++ python3 bash ssh apt-get pip3 jq rg gh; do " +
      "command -v $t >/dev/null && echo \"present $t\" || echo \"missing $t\"; done",
  },
  // InstaBox's `universal` template (version 2026-10-25.23, the one marked latest), measured on a fresh 2c4g
  // machine; commands run as the user `user`, with passwordless sudo.
  "instabox:universal": {
    measured: "2026-10-26", os: "Debian 13",
    present: ["Node", "npm", "git", "curl", "make", "gcc/g++", "Python 3", "pip", "jq", "gh", "Go", "Docker", "bash", "ssh", "apt-get", "sudo"],
    missing: ["rg"],
    install: "sudo apt-get update && sudo apt-get install -y <pkg>",
    command: "for t in node npm git curl make gcc g++ python3 pip3 bash ssh apt-get jq rg gh go docker sudo; do " +
      "command -v $t >/dev/null && echo \"present $t\" || echo \"missing $t\"; done",
  },
};

const listed = (xs: string[]) => xs.length > 1 ? `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}` : (xs[0] ?? "");

/** The description's sentence about the default image, from its measurement, or saying there is none. */
export function defaultImageSentence(image: string): string {
  const tag = image.split("/").pop();
  const m = MEASURED_IMAGES[image];
  if (!m) return `The default image is ${tag}; what it contains has not been measured, so check for a tool before relying on it.`;
  return `The default image is ${tag} (${m.os}): ${listed(m.present)} are present; ${listed(m.missing)} are NOT, ` +
    `and \`${m.install}\` installs more.`;
}

/** The shell description's sentence about an InstaBox template, from its measurement (`instabox:<template>`). */
export function templateSentence(template: string): string {
  const m = MEASURED_IMAGES[`instabox:${template}`];
  if (!m) return `The default template is ${template}; what it contains has not been measured, so check for a tool before relying on it.`;
  return `The default template is ${template} (${m.os}): ${listed(m.present)} are present; ${listed(m.missing)} are NOT, ` +
    `and \`${m.install}\` installs more.`;
}

/** One mount wired into a container: what stands for its credential, never the credential. */
interface Wired {
  alias: string;
  plugin: string;
  /** What the container holds in the credential's place. */
  placeholder: string;
  /** SHA-256 of the credential wired in, so a replaced one is noticed without keeping it. */
  digest: string;
  /** The registrations made for it on the box, by name; `null` means unknown, so every one on the box. */
  names: string[] | null;
  /**
   * Each registration made for it, its name with the id the provider answered for it (null where it answered none),
   * from the same call. Only an id proves a registration on a box is this mount's: a box another agent also used may
   * hold its own under the same names (`unwireForeign`). Absent on wirings recorded before it (`pairsOf`).
   */
  pairs?: Array<{ name: string; id: string | null }>;
  /** The environment its commands run with; holds the placeholder, never the credential. */
  env?: Record<string, string>;
  /** The plugin's own sentence for the model (`SandboxForm.summary`). */
  summary?: string;
}

interface LeftOut { alias: string; why: string }

/**
 * Placeholder put in on read when a wired entry cannot be read; no code path writes it deliberately. The record read
 * is written back as-is, so a failed read leaves it stored — conversions must happen before this layer (`pairsOf`).
 */
const UNKNOWN_WIRING: Wired = { alias: "", plugin: "", placeholder: "", digest: "", names: null };

/**
 * What stands for a mount's credential in one container. Qualified by box,
 * because run9 requires a placeholder to be unique across the project, and
 * fresh on every registration, because a placeholder that belonged to a deleted
 * secret is accepted again and then not substituted (measured on run9,
 * 2026-09-15: re-registered after a policy change, GitHub answered 401).
 */
/**
 * Whether `value` carries a placeholder made for this box (`placeholderFor`), as itself or in the base64 form a git
 * registration wraps it in: the mark is the box id's tail, which every placeholder for the box carries.
 */
export function carriesBoxPlaceholder(value: string, boxId: string): boolean {
  const mark = `_${boxId.slice(-8).replace(/[^A-Za-z0-9]/g, "_")}_`;
  const forms = [value];
  try { forms.push(atob(value)); } catch { /* not base64 */ }
  return forms.some((v) => v.includes("__AP_") && v.includes(mark));
}

export function placeholderFor(
  alias: string, boxId: string,
  fresh = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join(""),
): string {
  const tag = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
  return `__AP_${tag(alias).toUpperCase()}_${tag(boxId.slice(-8))}_${fresh}__`;
}

/** A form's registrations for one credential and placeholder: the value goes to the provider's egress, never into the box. */
export function registrationsFor(form: SandboxForm, credential: string, placeholder: string): EgressSecret[] {
  return form.egress.map((e) => ({
    name: e.name, value: e.value(credential), placeholder: e.placeholder(placeholder), header: e.header, hosts: [...e.hosts],
  }));
}

/**
 * git's config slots. A container has one set of them and they carry an
 * unbounded list, so this is not a name a form can claim: every plugin that
 * wants a git setting would ask for `GIT_CONFIG_COUNT` and `_0` and they would
 * all be left out of the container. `envFor` collects each form's entries and
 * numbers them again across the container instead.
 */
const GIT_CONFIG_SLOT = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/;

/**
 * Every name a form takes in a container: its registrations and its environment
 * variables, except git's config slots (above). What is left is a name two
 * forms cannot both have — a container has one `GH_TOKEN` — so a clash on one
 * of those still leaves both out and says why.
 */
export function claimedNames(form: SandboxForm): string[] {
  return [...new Set([...form.egress.map((e) => e.name), ...Object.keys(form.env(""))])]
    .filter((n) => !GIT_CONFIG_SLOT.test(n));
}

/**
 * The environment a command runs with: every wired mount's, which names
 * placeholders only, plus git's config list numbered across all of them.
 *
 * Each form declares its git settings the way git itself takes them from the
 * environment — `GIT_CONFIG_KEY_i` with `GIT_CONFIG_VALUE_i` — and the index a
 * form writes is ignored: entries are collected in the order the mounts were
 * wired and numbered 0..n-1, so GitHub's credential helper and a second
 * service's own header coexist instead of colliding on `_0`.
 *
 * One limit worth knowing: two forms setting the same config key both apply,
 * in this order. For a multi-valued key (`credential.helper`) that is what git
 * does anyway; for a single-valued one (`user.name`) the mount wired last wins.
 * `http.<url>.extraHeader` is multi-valued, so two mounts of one origin send
 * both headers, and a server that takes one `Authorization` refuses the request
 * (stamp.build answers 400): measured on git 2.39.5 and 2.53.0.
 */
export function envFor(state: BoxState | null): Record<string, string> {
  const env: Record<string, string> = {};
  const entries: Array<{ key: string; value: string }> = [];
  for (const w of state?.wired ?? []) {
    const wenv = w.env ?? {};
    for (const [name, value] of Object.entries(wenv)) {
      const m = /^GIT_CONFIG_KEY_(\d+)$/.exec(name);
      if (m) {
        const v = wenv[`GIT_CONFIG_VALUE_${m[1]}`];
        if (v !== undefined) entries.push({ key: value, value: v });
        continue;
      }
      if (GIT_CONFIG_SLOT.test(name)) continue;
      env[name] = value;
    }
  }
  if (entries.length) {
    env.GIT_CONFIG_COUNT = String(entries.length);
    entries.forEach((e, i) => {
      env[`GIT_CONFIG_KEY_${i}`] = e.key;
      env[`GIT_CONFIG_VALUE_${i}`] = e.value;
    });
  }
  return env;
}

/** What the model is told about the accounts this container acts as, and the ones it does not. */
function accountsNote(state: BoxState | null): Record<string, Json> {
  const wired = (state?.wired ?? []).filter((w) => w.alias && w.summary);
  const left = state?.leftOut ?? [];
  if (!wired.length && !left.length) return {};
  const accounts: Record<string, string> = {};
  for (const w of wired) {
    accounts[w.alias] = `${w.summary} The credential here is a placeholder swapped in on the way out, so nothing in ` +
      "this container, you included, can read it.";
  }
  for (const l of left) accounts[l.alias] = `Not wired in: ${l.why}. Use that mount's own tools.`;
  return { accounts };
}

/** A credential's identity, to notice it changed without keeping it: SHA-256, hex. */
async function tokenDigest(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Candidate = Awaited<ReturnType<PluginContext["sandboxForms"]>>[number];

/**
 * The accounts a container of this mount may act as right now: every mount
 * whose plugin declares a container form and holds a credential, except where
 * two claim one name — a container has one `GH_TOKEN` — which leaves both out
 * and says so rather than picking one. None with no network (the credential
 * could not be used) or with `accounts: "none"`.
 */
async function accountsWanted(ctx: PluginContext, cfg: ReturnType<typeof cfgOf>) {
  const open = cfg.network === undefined || cfg.network === "open";
  const off = cfg.accounts === "none" || cfg.github === "";
  const found = open && !off ? (await ctx.sandboxForms()).filter((f) => f.credential) : [];
  // A provider that cannot hold a credential for one box only (InstaBox's are org-wide secrets, which every
  // machine of the org could be given) wires nothing in, and says so for each mount that would have been.
  const backend = backendFor(cfg);
  if (!backend.caps.boxSecrets) {
    return {
      wire: [] as Array<Candidate & { credential: string; digest: string }>,
      leftOut: found.map((f) => ({ alias: f.alias, why: `${backend.name} cannot hold a credential for one container only` })),
    };
  }
  const claims = new Map<string, string[]>();
  for (const f of found) for (const n of claimedNames(f.form)) claims.set(n, [...(claims.get(n) ?? []), f.alias]);
  const wire: Array<Candidate & { credential: string; digest: string }> = [];
  const leftOut: LeftOut[] = [];
  for (const f of found) {
    const clash = claimedNames(f.form).find((n) => claims.get(n)!.length > 1);
    if (clash) {
      leftOut.push({ alias: f.alias, why: `${clash} is also wanted by ${claims.get(clash)!.filter((a) => a !== f.alias).join(", ")}, and a container has one` });
    } else {
      wire.push({ ...f, credential: f.credential!, digest: await tokenDigest(f.credential!) });
    }
  }
  return { wire, leftOut };
}

async function register(provider: SandboxProvider, boxId: string, c: Candidate & { credential: string; digest: string }): Promise<Wired> {
  const placeholder = placeholderFor(c.alias, boxId);
  const regs = registrationsFor(c.form, c.credential, placeholder);
  const pairs: Array<{ name: string; id: string | null }> = [];
  for (const g of regs) pairs.push({ name: g.name, id: await provider.addSecret(boxId, g) });
  await c.used();
  return {
    alias: c.alias, plugin: c.plugin, placeholder, digest: c.digest, names: regs.map((g) => g.name), pairs,
    env: c.form.env(placeholder), summary: c.form.summary,
  };
}

/**
 * Bring a container's accounts in line with the agent's mounts, at creation and
 * before every later command.
 *
 * Checked only at creation, a credential removed or replaced kept working in
 * the box until release, hours under a lease (the #339 review). So the mounts
 * are read again here. A wiring whose mount is gone, whose credential changed,
 * or which now clashes is deleted from the box, which run9 honours on the very
 * next request (measured 2026-09-15), and registered again only if still
 * wanted. Deleted by the names recorded for it, or every registration on the
 * box when the record cannot say. A deletion that fails stops the command:
 * running it would use access the mounts no longer grant.
 */
async function reconcileAccounts(
  ctx: PluginContext, state: BoxState, provider: SandboxProvider,
  want: Awaited<ReturnType<typeof accountsWanted>>, machine: string,
): Promise<BoxState> {
  // A deleted agent's container acts as nobody: what was wired is taken off, and nothing is wired again, whatever the
  // mounts still hold (its delete withdraws first, and a command racing that must not put the accounts back).
  if (ctx.agentDeleted) want = { wire: [], leftOut: [] };
  const had = state.wired ?? [];
  const same = (w: Wired, c: { alias: string; plugin: string; digest: string }) =>
    w.alias === c.alias && w.plugin === c.plugin && w.digest === c.digest && w.names !== null;
  const keep = had.filter((w) => want.wire.some((c) => same(w, c)));
  const drop = had.filter((w) => !keep.includes(w));
  const add = want.wire.filter((c) => !had.some((w) => same(w, c)));
  const leftSame = JSON.stringify(state.leftOut ?? []) === JSON.stringify(want.leftOut);
  if (!drop.length && !add.length && leftSame) return state;
  const next: BoxState = { ...state, wired: keep, leftOut: want.leftOut };
  if (drop.length) {
    const everything = drop.some((w) => w.names === null);
    const names = new Set<unknown>(drop.flatMap((w) => w.names ?? []));
    for (const s of await provider.listSecrets(state.boxId)) {
      if (everything || names.has(s.name)) await provider.removeSecret(state.boxId, s.id);
    }
  }
  // Recorded as gone before registering again, so a registration that fails
  // does not leave the record promising access the box no longer has.
  if (!next.wired!.length) delete next.wired;
  if (!next.leftOut!.length) delete next.leftOut;
  await writeView(ctx, machine, next);
  for (const c of add) {
    next.wired = [...(next.wired ?? []), await register(provider, state.boxId, c)];
    await writeView(ctx, machine, next);
  }
  return next;
}

/**
 * Let one machine go, as `holds.release` does for each it targets.
 *
 * Under a lease it is a step, not an end: a running box is switched off and
 * kept (parkBox), and only one already switched off is deleted. Which step
 * comes when, and the warning before the deletion, follow from what `activity`
 * reports for each state. Without a lease the box is handed back for good,
 * because nothing would ever come back to delete it. Only the idle pass
 * switches a running box off; an operator's or a benchmark's release means delete.
 */
async function releaseMachine(
  ctx: PluginContext, machine: string, reason: "idle" | undefined, lease: BoxLease | null, forget = false,
): Promise<Released | false> {
  if (lease && reason === "idle") {
    const state = await readView(ctx, machine);
    // A box past its provider's own deletion time is not there to pause: it is let go as a deleted one is.
    if (state.boxId && parkedAt(state) === null && !pastDeleteAt(state)) {
      const parked = await parkBox(ctx, machine, state);
      if (parked !== "gone") return parked;
    }
  }
  const r = await stopBox(ctx, machine, { forget });
  if (r === null) return false;
  if (!r.freed) {
    const e = new Error(`${providerName(cfgOf(ctx))} box ${r.boxId} not released: ${r.error ?? "unknown"}`);
    throw r.lease ? markReleased(e, r.lease) : e;
  }
  return r.lease ?? false;
}

/**
 * Let a stranded box go (`MountState.stranded`), as `releaseMachine` does a machine: deleted with the mount's key
 * now, which is not the key that made it — so run9's "not found" is never believed, and only a delete that
 * succeeded, or an operator's `forget` after a definitive refusal, takes it off the record. Its error lease is
 * reported once (`deleteFailedAt`). False when no credential is there to try with.
 */
async function releaseStranded(ctx: PluginContext, id: string, forget: boolean): Promise<Released | false> {
  const b = (await readMount(ctx))?.stranded?.[id];
  if (!b) return false;
  const now = Date.now();
  let error: string | undefined;
  let definitive = false;
  if (!ctx.credential) {
    // Nothing to try with. Not "released": the box is still there, so it stays held and is retried once a
    // credential is back — and an operator's forget, the only way out without one, drops it.
    error = "the mount has no credential to delete it with";
    definitive = true;
  } else if (!forget && (b.nextTryAt ?? 0) > now) {
    // Retried on the shared schedule (`releaseRetryMs`) whichever path asks — the idle pass, or a release after
    // every settled turn where the deployment has no idle lease — not on every ask. Its error lease is reported.
    throw new Error(`${providerName(cfgOf(ctx))} box ${id} (stranded) not released: not retried before ${new Date(b.nextTryAt!).toISOString()}; last: ${b.lastError ?? "unknown"}`);
  } else {
    try {
      ({ error, definitive } = await deleteBox(ctx, id, false));
    } catch (e) {
      if (e instanceof BoxNotOurs) return false;
      throw e;
    }
  }
  const endedAt = Date.now();
  const after = (await readMount(ctx)) ?? { machines: {} };
  const rest = { ...(after.stranded ?? {}) };
  if (error && !(forget && definitive)) {
    const cur = rest[id];
    const first = !cur?.deleteFailedAt;
    if (cur) {
      const tries = (cur.tries ?? 0) + 1;
      rest[id] = { ...cur, deleteFailedAt: cur.deleteFailedAt ?? endedAt, tries, nextTryAt: endedAt + releaseRetryMs(tries), lastError: error.slice(0, 200) };
      await writeMount(ctx, { ...after, stranded: rest });
    }
    const e = new Error(`${providerName(cfgOf(ctx))} box ${id} (stranded) not released: ${error}`);
    throw first ? markReleased(e, { id, startedAt: b.createdAt, endedAt, status: "error", error } as Released) : e;
  }
  delete rest[id];
  // Its time to the end goes on the record as a finished session, as `stopBox` does for a machine: usage counted
  // it as held while it was set aside (`activity.aside`), and this closes it. A switched-off one already recorded
  // its compute session when it was switched off.
  const sessions = parkedAt(b) === null ? keepSessions(after.sessions, sessionOf(b, endedAt, `stranded`)) : after.sessions;
  await writeMount(ctx, { ...after, stranded: rest, ...(sessions ? { sessions } : {}) });
  const forgotten = error ? `forgotten on an operator's request; ${error.startsWith("the mount has no") ? error : `${providerName(cfgOf(ctx))} refused the delete (${error})`}, so it may still be alive` : undefined;
  return forgotten
    ? { id, startedAt: b.createdAt, endedAt, status: "error", error: forgotten }
    : { id, startedAt: b.createdAt, endedAt, status: "freed" };
}

/**
 * What the `machines` tool answers: every machine of the mount, the default
 * one always (as "none" when it has no box), from the record alone.
 *
 * The times are the idle schedule's own (`activityOf` and idle-lease.ts
 * `releaseAt`), so what this says is when the idle pass would act if nothing
 * used the machine before then — not a promise, since any use moves it. Without
 * a lease there is no schedule: a box is handed back when the turn ends.
 */
export function machinesList(
  mount: MountState | null, cfg: { keepStoppedDays?: unknown; maxMachines?: unknown; provider?: unknown }, lease: BoxLease | null,
): Json {
  const iso = (t: number | null | undefined) => typeof t === "number" && t > 0 ? new Date(t).toISOString() : null;
  const names = [...new Set([MAIN_MACHINE, ...Object.keys(mount?.machines ?? {})])]
    .sort((a, b) => a === MAIN_MACHINE ? -1 : b === MAIN_MACHINE ? 1 : a < b ? -1 : a > b ? 1 : 0);
  const days = keepDaysOf(cfg);
  const rows = names.map((name) => {
    const box = mount?.machines[name];
    if (!box?.boxId) {
      const from = box?.startFrom ? mount?.envs?.find((e) => e.snapId === box.startFrom)?.name ?? null : null;
      return { machine: name, state: "none", ...(from ? { startsFrom: from } : {}) };
    }
    const pauses = cfg.provider === "instabox";
    const live = activityOf(viewOf(mount, name), 0, days).live!;
    const stopped = parkedAt(box) !== null;
    const paused = pausedOf(box);
    const at = lease
      ? new Date(Math.max(
          live.lastUsedAt + (stopped ? live.lease!.maxMs! : lease.maxMs),
          box.quietUntil ?? 0,
        )).toISOString()
      : null;
    // What the idle schedule does next: a running box on a provider that pauses (InstaBox) is paused, a paused or
    // switched-off one deleted. The keys of a run9 box are what they always were.
    const next = !at ? {} : stopped ? { deletedAfter: at } : pauses ? { pausedAfter: at } : { switchedOffAfter: at };
    return {
      machine: name,
      state: paused ? "paused" : stopped ? "switched off" : "running",
      box: box.boxId,
      image: box.image ?? null,
      created: iso(box.createdAt),
      lastUsed: iso(box.lastUsedAt || box.createdAt),
      ...(paused ? { paused: iso(box.parkedAt) } : stopped ? { switchedOff: iso(box.parkedAt) } : {}),
      ...(box.cwd ? { cwd: box.cwd } : {}),
      ...next,
      // The provider's own deletion, which nothing here postpones.
      ...(typeof box.deleteAt === "number" ? { deletedBy: iso(box.deleteAt) } : {}),
    };
  });
  const exist = rows.filter((r) => r.state !== "none").length;
  const max = maxMachinesOf(cfg);
  return {
    machines: rows,
    limit: max,
    note: (lease
      ? "times are when it happens if nothing uses the machine before then; any use moves them. "
      : "a running machine is handed back when the turn ends. ")
      + `${exist} of at most ${max} exist; a switched-off one counts until it is released.`,
  } as unknown as Json;
}

/** The longest a look may take, end to end: a person is waiting, and a look is never worth more. */
export const LOOK_LIST_MS = 10_000;
export const LOOK_READ_MS = 20_000;

/** A box a look is reading, and the deadline every request of the look shares. */
type Box = { boxId: string; cfg: ReturnType<typeof cfgOf>; provider: SandboxProvider; deadline: number };

/**
 * The main machine's box, only if it is running by both records: this mount's own (a box, not
 * switched off by the idle lease) and the provider's, read without starting anything. Null for
 * anything less, without a call to the provider when our own record already says no.
 */
async function awakeBox(ctx: PluginContext, deadline: number): Promise<Box | null> {
  const box = (await readMount(ctx))?.machines[MAIN_MACHINE];
  if (!box?.boxId || parkedAt(box) !== null || !ctx.credential) return null;
  const cfg = cfgOf(ctx);
  // Never woken from here: a look at a box that is not running answers "not running".
  const b: Box = { boxId: box.boxId, cfg, provider: openProvider(cfg, ctx, { wake: false, look: true }), deadline };
  let state: ProviderBoxState;
  try {
    state = await b.provider.status(box.boxId, { deadline });
  } catch (e) {
    // Another agent's box: this mount has no machine running, so there is nothing to look at.
    if (e instanceof BoxNotOurs) return null;
    throw e;
  }
  return state === "running" ? b : null;
}

/**
 * The scripts a look runs: `$1` is the path, `$2` the working directory. Both are resolved with
 * `realpath`, and a path whose real location is not inside the working directory is refused (exit 4)
 * — a link inside it may point anywhere on the machine. Exit 3: no such path; exit 5: not a directory.
 * Nothing is followed after that: `find` without `-L` lists a link as the link.
 */
const RESOLVE = 'root=$(realpath -e -- "$2") || exit 3; r=$(realpath -e -- "$1") || exit 3; ' +
  'case "$r" in "$root"|"$root"/*) ;; *) exit 4;; esac; ';
export const LIST_SCRIPT = RESOLVE + 'test -d "$r" || exit 5; ' +
  'n=$(find "$r" -mindepth 1 -maxdepth 1 -printf . | wc -c); ' +
  "find \"$r\" -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' | head -n 1000; printf '#total\\t%s\\n' \"$n\"";
export const STAT_SCRIPT = RESOLVE + "find \"$r\" -maxdepth 0 -printf '%y\\t%s\\t%T@\\t'; printf '%s\\n' \"$r\"";

/** Start a script on an awake box; its exec id. */
async function startLook(box: Box, script: string, path: string): Promise<string> {
  const root = "/" + segmentsOf(box.cfg.workdir).join("/");
  return String(await box.provider.execBackground(box.boxId, { argv: ["sh", "-c", script, "sh", path, root] }, { deadline: box.deadline }));
}

/** Wait for a look's command; its exit code and output. */
async function finishLook(box: Box, execId: string): Promise<{ exit: number; out: string }> {
  for (;;) {
    const rec = await box.provider.poll(execId, { deadline: box.deadline });
    if (TERMINAL.includes(rec.state)) {
      const exit = Number(rec.exitCode);
      if (rec.state !== "succeeded" && ![3, 4, 5].includes(exit)) throw new Error(`a look in ${box.boxId}: ${rec.state} ${String(rec.reason ?? "").slice(0, 120)}`);
      return { exit, out: String(rec.output ?? "") };
    }
    if (Date.now() + 200 > box.deadline) throw new Error(`a look in ${box.boxId} did not finish in time`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const FIND_LINE = /^([a-zA-Z])\t(\d+)\t(\d+(?:\.\d+)?)\t(.+)$/;

/**
 * The listing script's output as entries, and whether any were left out: past the 1000 the script
 * prints, or lost to run9 cutting a long output (its total line is then missing, or more than the
 * lines that arrived whole).
 */
export function parseListing(out: string): { entries: Array<{ name: string; isDirectory: boolean; size: number; modifiedAt: number }>; truncated: boolean; omitted?: number } {
  const entries: Array<{ name: string; isDirectory: boolean; size: number; modifiedAt: number }> = [];
  let total: number | null = null;
  for (const line of out.split("\n")) {
    const t = /^#total\t(\d+)$/.exec(line);
    if (t) { total = Number(t[1]); continue; }
    const m = FIND_LINE.exec(line);
    if (!m || m[4] === "." || m[4] === "..") continue;
    entries.push({ name: m[4]!, isDirectory: m[1] === "d", size: Number(m[2]), modifiedAt: Math.round(Number(m[3]) * 1000) });
  }
  if (total === null) return { entries, truncated: true };
  const omitted = Math.max(0, total - entries.length);
  return omitted ? { entries, truncated: true, omitted } : { entries, truncated: false };
}

/** A body read up to `max` bytes and no further; null when it is longer. */
async function readCapped(res: Response, max: number): Promise<{ bytes: Uint8Array | null; seen: number }> {
  if (!res.body) return { bytes: new Uint8Array(0), seen: 0 };
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let seen = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += value.byteLength;
    if (seen > max) { await reader.cancel().catch(() => {}); return { bytes: null, seen }; }
    parts.push(value);
  }
  const bytes = new Uint8Array(seen);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  return { bytes, seen };
}

/** The working directory of the main machine, read only while it is awake (see `Holding.files`). */
const sandboxFiles: HeldFiles = {
  async list(ctx, path, locked) {
    const deadline = Date.now() + LOOK_LIST_MS;
    // Behind the lock: deciding the box is awake, and starting the command on it. The wait is not.
    const started = await locked(async () => {
      const box = await awakeBox(ctx, deadline);
      return box ? { box, execId: await startLook(box, LIST_SCRIPT, boxPathOf(box.cfg, path)) } : null;
    });
    if (!started) return { running: false };
    const got = await finishLook(started.box, started.execId);
    if (got.exit === 3 || got.exit === 4) return { running: true, found: false };
    if (got.exit === 5) return { running: true, found: false, notDirectory: true };
    return { running: true, found: true, ...parseListing(got.out) };
  },
  async read(ctx, path, maxBytes, locked) {
    const deadline = Date.now() + LOOK_READ_MS;
    const started = await locked(async () => {
      const box = await awakeBox(ctx, deadline);
      return box ? { box, execId: await startLook(box, STAT_SCRIPT, boxPathOf(box.cfg, path)) } : null;
    });
    if (!started) return { running: false };
    const got = await finishLook(started.box, started.execId);
    if (got.exit !== 0) return { running: true, found: false };
    const m = FIND_LINE.exec(got.out.split("\n")[0] ?? "");
    if (!m) throw new Error("a look could not read what the path is");
    const kind = m[1] === "f" ? "file" as const : m[1] === "d" ? "directory" as const : "other" as const;
    const size = Number(m[2]);
    const modifiedAt = Math.round(Number(m[3]) * 1000);
    const real = m[4]!;
    if (kind !== "file" || size > maxBytes) return { running: true, found: true, kind, size, modifiedAt, bytes: null };
    // Behind the lock again: the box is asked again whether it is awake, since a download from one
    // that went to sleep in between may wake it, and the body is read no further than the cap.
    const body = await locked(async () => {
      const box = await awakeBox(ctx, deadline);
      if (!box) return null;
      const res = await box.provider.download(box.boxId, real, { timeoutMs: Math.max(1, deadline - Date.now()) });
      return readCapped(res, maxBytes);
    });
    if (!body) return { running: false };
    return { running: true, found: true, kind, size: body.bytes ? body.seen : Math.max(size, body.seen), modifiedAt, bytes: body.bytes };
  },
};

/** Where a workspace path is inside the box: under the working directory, never above it. */
function boxPathOf(cfg: ReturnType<typeof cfgOf>, path: string): string {
  const root = "/" + segmentsOf(cfg.workdir).join("/");
  const rest = segmentsOf(path).join("/");
  return rest ? `${root === "/" ? "" : root}/${rest}` : root;
}

/**
 * The largest file `put` copies into a box. The same 25 MiB as a Raft attachment download
 * (`ATTACHMENT_MAX_BYTES` in src/plugins/raft.ts), so anything that arrives that way fits; and the whole file
 * is held in the agent's isolate while it goes out, which a larger one would crowd.
 */
export const PUT_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Where `put` writes: `path` resolved like a filesystem would (`.` and `..` applied), relative ones from the
 * working directory, and refused unless the result is inside the working directory. Refused rather than moved
 * there, because a file silently written somewhere other than where the agent asked is one it then looks for
 * in the wrong place. Not a security boundary (the agent has root in its own box): it keeps work where `save`,
 * the workspace view and the next command expect it.
 */
export function putPathOf(workdir: string, path: string): string {
  const root = "/" + segmentsOf(workdir).join("/");
  const asked = String(path ?? "").trim();
  if (!asked) throw new Error("path is required: where in the container the file goes, e.g. \"in/photo.jpg\"");
  const resolved = "/" + segmentsOf(asked.startsWith("/") ? asked : `${root}/${asked}`).join("/");
  const inside = root === "/" ? resolved !== "/" : resolved.startsWith(root + "/");
  if (!inside) {
    throw new Error(`path must name a file inside the working directory ${root}; ${JSON.stringify(asked)} is ${resolved}`);
  }
  return resolved;
}

/** Make the file's directory, and refuse a path that is a directory (exit 6) or under a file (exit 5). */
export const PUT_PREPARE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" 2>/dev/null || exit 5; test -d "$1" && exit 6; exit 0';
/** The file as the box has it: its size, then its sha256 when the image has `sha256sum`. Exit 3: not a file. */
export const PUT_CHECK_SCRIPT = 'test -f "$1" || exit 3; stat -c %s -- "$1"; sha256sum -- "$1" 2>/dev/null | cut -d " " -f 1';

const hexOf = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * The name a new box is created under: `h-`, twelve hex digits of SHA-256 over who and what it is for (tenant,
 * agent, mount, machine), a named machine's name, and the creation time in base 36: `h-<12 hex>-mywpiww0` for the
 * main machine and `h-<12 hex>-build-mywpiww0` for one called `build`, both made at 1_800_000_000_000.
 *
 * run9's ids are the whole project's, which under the operator's account is every tenant's, and a create of an id
 * it already has is answered "already exists" and then adopted (`SandboxProvider.adopt`). So two owners must never
 * mint the same id. The identity used to be spelled out and cut at 40 characters, and a Raft tenant id is
 * `raft_<uuid>`, so `h-raft_<uuid>` alone is 43: the cut removed the agent entirely, and two agents of one server
 * creating their first box in the same millisecond got one id, and so one box. A digest keeps every part of the
 * identity in a fixed length; JSON keeps a separator inside an id from making two identities spell the same input.
 *
 * The longest id is 48 characters today (a 24-character machine name, `MACHINE_RE`, and eight base-36 digits of
 * time), and one more for each digit the time gains: nine from 36^8 ms (2_821_109_907_456, in 2059). run9 states no
 * limit (its swagger, https://api.run.sys9.ai/swagger.yaml read 2026-11-05, gives `box_id` as a plain string with no
 * length or pattern), so the bound kept is the one it has accepted: the old ids, 40 characters, a dash and eight of
 * time, 49. The time stays because each box one machine is given over its life (after a release, say) needs a name of
 * its own, and the name stays in a named machine's id so a person reading a listing can tell them apart; the
 * digest's 48 bits stand only against an accident between owners, which `adopt` checks again.
 */
export async function boxIdFor(owner: { tenantId: string; agentId: string; mount: string; machine: string }, at: number): Promise<string> {
  const who = JSON.stringify([owner.tenantId, owner.agentId, owner.mount, owner.machine]);
  const digest = hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(who))).slice(0, 12);
  return `h-${digest}${owner.machine === MAIN_MACHINE ? "" : `-${owner.machine}`}-${at.toString(36)}`;
}

const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

export function sandboxPlugin(artifacts: R2Artifacts | null, bucket: string, lease: BoxLease | null = null): Plugin {
  // **"container", never "sandbox"**, in every sentence below that the model
  // reads. The harness already calls the per-execution JavaScript isolate a
  // sandbox, and an agent told that "the sandbox keeps nothing between
  // executions" concluded this box was volatile too — which would have it
  // reinstalling packages on every call.
  //
  // It sits where the convention is applied rather than beside one of its
  // instances, so that a change about something else cannot delete it — which
  // is how it was lost once already.
  //
  // `run` and `shell` state the same lifetime: with a lease, the box stays until
  // the agent releases it, is switched off when idle and deleted only after days
  // switched off; without one, a settled turn hands it back.
  // The tools, with the sentences about an idle box's life taken from its provider: `t` null is run9's text.
  const toolsFor = (t: IdleTerms | null): ToolSchema[] => {
  const termsOf = (l: BoxLease) => t?.provider === "instabox" ? instaboxLeaseTerms(l, t) : leaseTerms(l);
  /** How a container is billed, from its provider's caps (`ProviderCaps.billing`); run9's when `t` is null. */
  const billedSentence = (x: IdleTerms | null) => BACKENDS[x?.provider ?? "run9"].caps.billing === "running"
    ? "billed by the second while it runs and only for its storage while it is paused"
    : "billed for every second it exists";
  const runLifetime = lease
    ? "The container is NOT the per-execution sandbox: every call uses the same one, in this turn and later " +
      "ones, so installs and files survive from one call to the next — do not reinstall. It stays until you " +
      `release it; ${termsOf(lease)}. Work in as few calls as you can, save what matters with \`save\`, and ` +
      "release it once the machine will not be needed again. Releasing deletes it and everything on its disk."
    : "The container is NOT the per-execution sandbox: every call in this " +
      "turn uses the same one, so installs and files survive from one call to the next — do not " +
      "reinstall. It is handed back when the turn ends, so a later turn starts a new container " +
      "unless you saved this one's filesystem with `keep`. Work in as few calls as you can, save " +
      "what matters with `save`, and release it. Everything inside is destroyed when it is released.";
  const shellLifetime = lease
    ? "Shell in the same container as `run`, billed by the second while it runs, and the same one for every call, in this " +
      "turn and later ones — state, installed packages and files carry over — until you release it; " +
      `${termsOf(lease)}.`
    : "Shell in the same billed-by-the-second container as `run`, and the same one for every call " +
      "in this turn — state, installed packages and files carry over from one call to the next, and " +
      "the container is handed back when the turn ends.";
  // Said in `run` and `shell`, where a second machine is asked for. "Only when you need two at once"
  // because each one is billed on its own, and an agent told it may name machines would otherwise name
  // one per task.
  const machinesSentence =
    "Every call uses the mount's one machine unless you pass `machine`: another short name is a separate " +
    "container with its own files, directory and idle schedule, created on first use and released on its " +
    "own. Use one unless you need two at once; at most a few (3 unless the operator set `maxMachines`) may " +
    "exist at once, switched-off ones included, and `machines` lists them.";
  return [
    {
      name: "run",
      summary:
        "LAST RESORT for JavaScript. Prefer an ordinary code block, which is instant and free; this " +
        `starts a container that is ${billedSentence(t)}, and it cannot call your other ` +
        "tools. Use it only when you genuinely need npm packages, a real filesystem, or more than a " +
        "few seconds of compute. " + runLifetime + " " + machinesSentence,
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript, run with `node -e`" },
          machine: MACHINE_PARAM,
          install: {
            type: "array", items: { type: "string" },
            description: "npm packages to install first, e.g. ['zod']",
          },
        },
        required: ["code"],
      },
      // Arbitrary code with network and a filesystem: whether that needs a
      // person is the operator's call, and this is where they make it.
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "shell",
      summary:
        shellLifetime + " Each call starts in the directory the previous call ended in, like one terminal " +
        "session, and its result says where that is (`cwd`); the first starts in the working directory. " +
        "Pass `workdir` to run one command in another directory instead of starting it with `cd`. " +
        "Exported variables and aliases do not carry over, so set them in the command that needs them, " +
        "and a command handed over as a job does not move the directory. Only for what needs a real " +
        "machine (builds, tests, git). " + (t ? templateSentence(DEFAULTS.template) : defaultImageSentence(DEFAULTS.image)) + " An operator may have configured a " +
        "different image; every result reports which one this container started from, so read that " +
        "instead of probing for it. Save anything worth keeping, then release. " + machinesSentence,
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          machine: MACHINE_PARAM,
          workdir: {
            type: "string",
            description: "directory to run this command in; relative paths start from the current one. Omit it to start where the previous command ended",
          },
        },
        required: ["command"],
      },
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "save",
      summary:
        "Copy a file out of the container into durable storage before it is destroyed. Returns an " +
        "r2:// reference the artifacts mount can read back, and that outlives the box. Set " +
        "archive for a directory. Do this for anything worth keeping — a build output, a report, a " +
        "diff — the moment it exists, not at the end. " + notAReasonToRelease(lease, t ?? undefined),
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "absolute path inside the box" },
          archive: { type: "boolean", description: "true to take a directory as a tar" },
          machine: MACHINE_PARAM,
        },
        required: ["path"],
      },
      // It reads from the box and writes to object storage, and the write is
      // the part with consequences: a durable object that is billed and
      // outlives the container. An operator who wants it free of approval says
      // so per tool; the declaration's job is to be true.
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "put",
      summary:
        "Copy a stored file into the container, so a command there can work on it. `ref` is an artifact:// " +
        "reference of yours: what an attachment download or `save` returned. The usual way to process an " +
        "attachment is: download it (attachments_download_url), `put` it here, work on it with `shell` or `run`, " +
        "`save` the result, then view or upload what `save` returned. No URLs: anything from outside arrives " +
        `through a download first. At most ${PUT_MAX_BYTES / 1024 / 1024} MiB. Returns the path, size and sha256 ` +
        "as the container has it. An existing file at the path is replaced.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: "string", description: "artifact:// reference to copy in" },
          path: {
            type: "string",
            description: "where the file goes, inside the working directory; relative paths start there, e.g. \"in/photo.jpg\"",
          },
          machine: MACHINE_PARAM,
        },
        required: ["ref", "path"],
      },
      // It writes into the container, replacing whatever was at the path.
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "keep",
      summary:
        "Save this container's filesystem under a name, so a later task can start from it instead " +
        "of installing everything again. Use it once the environment is set up — interpreter, " +
        "packages, a cloned repository — not for the results, which belong in `save`. The " +
        "container keeps running; the snapshot is independent of it. " + notAReasonToRelease(lease, t ?? undefined),
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "short name you will recognise later, e.g. 'py-scipy'" },
          note: { type: "string", description: "one line on what is in it" },
          machine: MACHINE_PARAM,
        },
        required: ["name"],
      },
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "start_from",
      summary:
        "Begin from an environment kept earlier instead of a bare image. Naming one releases the " +
        "current container if there is one; the next run or shell starts from the snapshot. Call " +
        "with no name to see what has been kept, which releases nothing. Setting up a machine is usually the slowest and most " +
        "expensive part of using one, and this is how you stop paying for it twice. Pass `machine` to start that " +
        "machine from it instead of the default one; kept environments are shared by all of the mount's machines.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "the kept environment to start from; omit to list them" },
          machine: MACHINE_PARAM,
        },
      },
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "release",
      // Which advice is true depends on the lease, as it does for `run` and
      // `shell`: without one a box is handed back when the turn ends, so
      // "leave it running" and "`quiet` keeps it longer" would be promises
      // nothing keeps (the SWE-bench runner, or a Worker without the two
      // settings). No number here: the minutes are said where they are read.
      summary: lease && t?.provider === "instabox"
        ? "Delete the container now: the machine and everything on its disk are destroyed, and the meter " +
          "stops. Pass save to copy files out first, in the same call. If you or the person you are working for " +
          "will come back to it, leave it running, even after keeping or saving what is in it. Release it only " +
          "when this machine will not be needed again. Leaving it costs little: an idle container is only " +
          "paused on its own, and the next call resumes it where it was; it is deleted on its own " +
          `${spanText(t.maxLifetimeHours * 3_600_000)} after it was created at the latest, which nothing postpones — while ` +
          "releasing it early saves little and makes the next visit start over. A kept environment or a saved " +
          "file is for starting a fresh machine later, not a reason to destroy one someone will use again."
        : lease
        ? "Delete the container now: the machine and everything on its disk are destroyed, and the meter " +
          "stops. Pass save to copy files out first, in the same call. If you or the person you are working for " +
          "will come back to it, leave it running, even after keeping or saving what is in it. Release it only " +
          "when this machine will not be needed again. Leaving it costs little: an idle container is only " +
          "switched off on its own, and the next call brings it back with its files intact; it is deleted on " +
          "its own only after days switched off, you are told before that, and `quiet` keeps it longer — while " +
          "releasing it early saves little and makes the next visit start over. A kept environment or a saved " +
          "file is for starting a fresh machine later, not a reason to destroy one someone will use again."
        : "Destroy the container and everything in it, stopping the meter. Pass save to copy files out " +
          "first, in the same call. It is handed back when the turn ends anyway, so release it sooner once " +
          "this machine will not be needed again in this turn. A later turn starts a fresh machine: what it " +
          "needs has to be kept or saved before this turn ends.",
      parameters: {
        type: "object",
        properties: {
          save: {
            type: "array", items: { type: "string" },
            description: "absolute paths to keep before destroying the box",
          },
          machine: MACHINE_PARAM,
        },
      },
      // Irreversible, and declared as what it is. `sideEffects` is what the
      // gateway maps to a mount's policy: read falls to `policy.read`, so
      // declaring this a read meant an operator who gated writes had every
      // ordinary command held for approval and the one call that destroys
      // everything let straight through. Releasing twice is still safe, which
      // is what `idempotency` says and is a different question.
      sideEffects: "write",
      idempotency: "native",
    },
    {
      name: "quiet",
      summary: lease && t?.provider === "instabox"
        ? "Postpone what happens next to this container while it sits unused: pausing it, while it is running; " +
          "deleting it, once it is paused. It is kept as it is for at " +
          "least `minutes` more from now, and you are not told about it again until shortly before then. It does " +
          `not postpone the deletion ${spanText(t.maxLifetimeHours * 3_600_000)} after the container was created. Use it ` +
          "when you are coming back to the machine — a build you are waiting on, work you return to after reading " +
          "something. The limit is the mount's while it runs and much longer once it is paused. Running, it " +
          "is billed for every second either way; if you are done with it, `release` is the cheaper answer, and it " +
          "can save files out in the same call."
        : lease
        ? "Postpone what happens next to this container while it sits unused: switching it off, while it is " +
          "running; deleting it, once it is switched off. It is kept as it is for at least `minutes` more from " +
          "now, and you are not told about it again until shortly before then. Use it when you are coming back " +
          "to the machine — a build you are waiting on, work you return to after reading something. The limit " +
          "is the mount's while it runs and much longer once it is switched off. Running, it is billed for " +
          "every second either way; if you are done with it, `release` is the cheaper answer, and it can save " +
          "files out in the same call."
        : "Has no effect here: this mount has no idle release to put off, and the container is handed " +
          "back when the turn ends whatever you ask. To carry work into a later turn, keep or save it.",
      parameters: {
        type: "object",
        properties: {
          minutes: {
            type: "number",
            description: "how many more minutes to keep the container, from now; a request over the mount's limit is refused, not shortened",
          },
          machine: MACHINE_PARAM,
        },
        required: ["minutes"],
      },
      // A write: it changes when the box is released, which changes what the
      // box costs. Not idempotent, because each call moves the instant.
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "machines",
      summary: t?.provider === "instabox"
        ? "List this mount's machines: each one's name, whether it is running or paused, its template, when it " +
          "was created and last used, when it will be paused or deleted if nothing uses it, and when it is deleted " +
          "regardless. Reads the record only; starts, wakes and bills nothing."
        : "List this mount's machines: each one's name, whether it is running or switched off, its image, " +
          "when it was created and last used, and when it will be switched off or deleted if nothing uses it. " +
          "Reads the record only; starts, wakes and bills nothing.",
      parameters: { type: "object", properties: {} },
      sideEffects: "read",
      idempotency: "native",
    },
  ];
  };

  /**
   * What the agent is told in the result of the call that found a machine's recorded box to be another agent's
   * (`ownedProvider`): it cannot see the trace, and without this the files and installs it expected would be gone
   * with no reason given. Said once, on that call: by the next one the record no longer names the box.
   */
  // Notes describe an event and are said once. A queued note may contain only facts already true when it was queued,
  // and the one fixed instruction "there is nothing for you to do": nothing about what will happen next (a retry, a
  // new machine, a release) and no count that changes (how many were removed or remain), which belong to the holds
  // list (`withdraw`) and result fields. So a row reads the same whenever it is delivered, whatever came after it. A later change for the same box (a removal pending, then given up on) is a new event
  // with a note of its own; the sequence only goes one way (residue never returns to pending). Not one note per box.
  async function notOursNote(ctx: PluginContext): Promise<{ text: string; ids: string[] } | null> {
    const v = await ctx.db.get(BOX_STORE, NOTICES_KEY);
    const found = Array.isArray(v) ? (v as LetGo[]) : [];
    if (!found.length) return null;
    const text = found.map((f) => {
      if (f.outcome === "given_up") {
        return "Taking this mount's accounts off a machine that belonged to another agent failed three times, so some of " +
          "its account registrations may remain there; there is nothing for you to do about them.";
      }
      if (f.outcome === "remains") {
        return "Some of this mount's account registrations may remain on a machine that belonged to another agent; there is nothing for you to do about them.";
      }
      // A box set aside earlier (`stranded`), not the agent's machine: only what of its accounts was left is said.
      if (f.machine === null) {
        return [
          f.pending ? "Some of this mount's account registrations on a machine that belonged to another agent were not removed at the time; there is nothing for you to do." : "",
          f.residue ? "Some of this mount's account registrations may remain on a machine that belonged to another agent; there is nothing for you to do about them." : "",
        ].filter(Boolean).join(" ");
      }
      const which = f.machine === MAIN_MACHINE ? "The machine" : `Machine "${f.machine}"`;
      // Each state the set held at the split, said once: a set with items of both kinds says both.
      return `${which} you were using belonged to another agent, so it was left to them; nothing you had on it is here.`
        + (f.pending ? " Some of this mount's account registrations on that machine were not removed at the time; there is nothing for you to do." : "")
        + (f.residue ? " Some of this mount's account registrations may remain on that machine; there is nothing for you to do about them." : "");
    }).filter(Boolean).join(" ");
    return { text, ids: found.map((f) => String(f.id)) };
  }
  /** Drops the notices a result has just carried, by their ids and only those: one owed meanwhile stays for the next. */
  async function delivered(ctx: PluginContext, ids: string[]): Promise<void> {
    const v = await ctx.db.get(BOX_STORE, NOTICES_KEY);
    const left = (Array.isArray(v) ? (v as LetGo[]) : []).filter((f) => !ids.includes(String(f.id)));
    if (left.length) await ctx.db.put(BOX_STORE, left as unknown as Json, NOTICES_KEY);
    else await ctx.db.delete(BOX_STORE, NOTICES_KEY);
  }

  const plugin: Plugin = {
  id: "sandbox",
  /** The box record: that a mount has one is listable; the box id, the kept environments and the sessions are not. */
  database: { version: 1, stores: { [BOX_STORE]: { listed: [BOX_KEY] } } },
  /** This mount holds a container: something real, billed while it exists.
   *  The three below are one decision, not three — see `Holding`. */
  // What this plugin can give a session. Declared so the agents API can pick
  // the mount that provides a container by asking what a plugin offers
  // rather than by matching the alias `sandbox` — an alias is the operator's
  // to choose, so matching on it makes a rename a silent behaviour change.
  provides: ["container"],
  holds: {
    // Which tool lets the container go, and which buys it more time. The
    // runtime names these to the agent; before this they were the literals
    // "release" and "quiet" in the idle scan, so renaming either would have
    // left it telling the agent to call something that does not exist.
    tools: { release: "release", postpone: "quiet" },
    /** The main machine's working directory, only while it is awake; never starts it. */
    files: sandboxFiles,
    /** What this mount is keeping alive, read from its own state and nothing
     *  else: no credential, no call to run9. */
    async activity(ctx: PluginContext): Promise<MountActivity> {
      const raw = await ctx.db.get(BOX_STORE, BOX_KEY);
      const cfg = cfgOf(ctx);
      return summaryActivity(asMountState(raw), unreadableEntries(raw), keepDaysOf(cfg));
    },
    /** Each machine on its own: its own schedule, postponement and cost (see `Holding.activities`). */
    async activities(ctx: PluginContext): Promise<MountActivity[]> {
      const raw = await ctx.db.get(BOX_STORE, BOX_KEY);
      const cfg = cfgOf(ctx);
      return activitiesOf(asMountState(raw), unreadableEntries(raw), keepDaysOf(cfg));
    },
    /** The window this mount still holds. Bounded on purpose, which is why it is
     *  the console's history and not anybody's ledger. */
    async usage(ctx: PluginContext): Promise<MountUsage[]> {
      // The shared window: every machine's sessions, each naming its machine when not the default.
      return usageOf(asBoxState(await ctx.db.get(BOX_STORE, BOX_KEY)));
    },
    /**
     * Every egress registration on every box this mount holds, removed, and the record of what was wired cleared:
     * for an agent's delete (`Holding.withdraw`). run9 holds the registered value and swaps it in on the box's way
     * out with no call back here, so this is the only way to stop a box still running from using it.
     *
     * A box is `clean` only on positive evidence: its registrations listed again after the removal, under this
     * mount's key, as a complete and readable list (run9's is a bare array with no pages; anything else throws),
     * showing none; and no project-scope registration carrying one of its placeholders (run9 injects those into the
     * boxes they label without listing them on the box). A project registration that only shares a name is `review`:
     * a person should look, but it is not proof. That match is a heuristic: no match does not mean none exists.
     * Anything else is not clean: no key to reach the box with, a listing that cannot be read, a box made under a
     * key since replaced (stranded: neither listable nor deletable with this one, so every delete reports it again).
     */
    async withdraw(ctx: PluginContext): Promise<Withdrawal> {
      const mount = await readMount(ctx);
      const cfg = cfgOf(ctx);
      const backend = backendFor(cfg);
      const things: Withdrawal["things"] = [];
      // What run9 answered is never repeated, only its status or shape: this text reaches Raft in a DELETE's answer.
      const failure = (e: unknown) => e instanceof ProviderError ? `run9 refused (${e.status ? `HTTP ${e.status}` : e.code})` : String((e as Error)?.message ?? e).slice(0, 200);
      const provider = ctx.credential && backend.caps.boxSecrets ? openProvider(cfg, ctx) : null;
      // Project scope, listed once per withdrawal and never written: one run9 project is shared with production, and
      // a project-scope secret removed here could stop another deployment's boxes from working. What it shows is
      // handed up whole (`project`): the caller keeps residue where it outlives this mount (D1, cf/src/egress-residue.ts)
      // and resolves it only on a listing that is `complete`.
      const project: Withdrawal["project"] = { state: "no_credential", ids: [], findings: [] };
      let listed: Array<{ name: unknown; id: unknown; placeholder: unknown }> = [];
      if (!backend.caps.boxSecrets) project.state = "none";
      else if (provider?.listProjectSecrets) {
        try { listed = await provider.listProjectSecrets(); project.state = "complete"; project.ids = listed.map((p) => String(p.id)); }
        catch (e) { project.state = "failed"; project.error = `the project-scope listing failed: ${failure(e)}`; }
      } else if (provider) project.state = "none";
      // Removals still pending from boxes let go of as another agent's get their try here too: a deleted agent makes
      // no later call to retry them on.
      if (provider) await provider.retryForeign().catch(() => {});
      for (const machine of boxedMachines(mount)) {
        const state = await readView(ctx, machine);
        if (!state.boxId) continue;
        // A provider that cannot hold a credential for one box has none registered on it (accountsWanted).
        if (!backend.caps.boxSecrets) { things.push({ id: state.boxId, clean: true, ownKey: false, why: `${backend.name} wires no account into a box` }); continue; }
        // A deletion by this mount's release is believed only for a box recorded as made under this kind of key.
        const ownKey = !!ctx.credential && state.credentialRef !== undefined && state.credentialRef === ctx.credentialRefKind;
        if (!provider) { things.push({ id: state.boxId, clean: false, ownKey: false, code: "no_credential", why: "no credential to reach the box with" }); continue; }
        try {
          const before = await provider.listSecrets(state.boxId);
          const placeholders = new Set([...before.map((x) => String(x.placeholder ?? "")), ...(state.wired ?? []).map((w) => w.placeholder)].filter(Boolean));
          const names = new Set([...before.map((x) => String(x.name ?? "")), ...(state.wired ?? []).flatMap((w) => w.names ?? [])].filter(Boolean));
          for (const sec of before) await provider.removeSecret(state.boxId, sec.id);
          const left = await provider.listSecrets(state.boxId);
          // One carrying this box's placeholder is residue run9 will inject: handed up as a finding, every time.
          let named = 0;
          for (const p of listed) {
            const ph = String(p.placeholder ?? "");
            if (ph && ([...placeholders].some((x) => ph === x || ph.includes(x)) || carriesBoxPlaceholder(ph, state.boxId))) {
              project.findings.push({ boxId: state.boxId, secretId: String(p.id), name: String(p.name ?? "").slice(0, 120) });
            } else if (names.has(String(p.name ?? ""))) named++;
          }
          const view = await readView(ctx, machine);
          if (view.boxId === state.boxId && (view.wired || view.leftOut)) {
            const next = { ...view };
            delete next.wired; delete next.leftOut;
            await writeView(ctx, machine, next);
          }
          // `clean` is the box's own registrations. A project listing that failed is not clean: residue was never checked.
          const failed = project.state === "failed";
          const code = left.length ? "not_withdrawn" as const : failed ? "project_listing_failed" as const : undefined;
          const why = left.length ? `${left.length} registration(s) still on the box after removal` : failed ? project.error : undefined;
          things.push({ id: state.boxId, clean: !left.length && !failed, ownKey, ...(code ? { code } : {}), ...(why ? { why } : {}),
            ...(named ? { review: `${named} project-scope registration(s) share a name with this box's accounts; a person should look` } : {}) });
        } catch (e) {
          // Another agent's box: the record let go of it, taking this mount's registrations off it by id where it could
          // (`ownedProvider`). What it could not is reported below with the other splits.
          if (e instanceof BoxNotOurs) continue;
          things.push({ id: state.boxId, clean: false, ownKey, code: "listing_failed", why: failure(e) });
        }
      }
      // Boxes of other agents this mount's registrations may still be on: pending ones a later delete tries again,
      // given-up ones a person has to look at. Removed ones are not this mount's to report.
      for (const e of Object.values(await readForeign(ctx))) {
        // One line per item, each by its own state: a set with items of both kinds lists both.
        for (const r of Array.isArray(e.remaining) ? e.remaining : []) {
          const name = r.name ?? "unnamed";
          if (r.state === "pending") {
            things.push({ id: e.box, clean: false, ownKey: false, code: "listing_failed",
              why: `another agent's box: this mount's registration ${name} is not removed yet (${e.lastError ?? "not tried yet"})` });
          } else {
            things.push({ id: e.box, clean: false, ownKey: false, code: "foreign_residue",
              why: `another agent's box: this mount's registration ${name} may remain on it (${r.reason ?? "unknown"})` });
          }
        }
      }
      for (const id of Object.keys(mount?.stranded ?? {})) {
        things.push({ id, clean: false, ownKey: false, code: "stranded", why: "stranded: made under a key since replaced, so with this one its registrations can be neither listed nor removed, nor the box deleted" });
      }
      return { things, project };
    },
    /** Hands this mount's box back, so an idle one is not left running on the
     *  tenant's quota because nobody thought to stop it. Safe to call when there
     *  is no box: it reports that nothing was released rather than failing.
     *
     *  **When** it is called is the framework's decision and deliberately not
     *  described here. It was, twice: the comment said "when the task ends" while
     *  the body twenty lines down was already mount-scoped, and then it said "when
     *  the agent has nothing open", which was true only while the gateway released
     *  at exactly that step. Both sentences were correct when written, went stale
     *  in a file nobody had reason to reread, and cost nothing until someone
     *  relied on them. The trigger lives at the call site — today
     *  `cf/src/runtime.ts` — so that is where it is stated and where it changes.
     *
     *  Not per task, despite what the gateway's `releaseTask` is called: the body
     *  below reads the mount's box record and never looks at the caller's
     *  task.
     *
     *  What happens to each machine is `releaseMachine`'s. */
    async release(ctx: PluginContext, opts?: { reason?: "idle"; id?: string; forget?: boolean }): Promise<Released | Released[] | false> {
      // Which machines: the one whose box the framework named (the idle pass acts on one thing at a
      // time, each on its own clock), or every one the mount has (an operator releasing the mount, a
      // benchmark, a settled turn without a lease). An id that names no machine now names nothing to
      // release: the box it meant is already gone or was replaced.
      const mount = await readMount(ctx);
      const targets = boxedMachines(mount).filter((n) => !opts?.id || mount!.machines[n]!.boxId === opts.id);
      const aside = Object.keys(mount?.stranded ?? {}).filter((id) => !opts?.id || id === opts.id);
      const facts: Released[] = [];
      const errors: string[] = [];
      for (const id of aside) {
        try {
          const fact = await releaseStranded(ctx, id, opts?.forget === true);
          if (fact) facts.push(fact);
        } catch (e) {
          const fact = (e as { released?: Released })?.released;
          if (fact) facts.push(fact);
          errors.push(String((e as Error)?.message ?? e));
        }
      }
      // One after another, each to the end: a machine that would not go must not keep the next from going.
      for (const machine of targets) {
        try {
          const fact = await releaseMachine(ctx, machine, opts?.reason, lease, opts?.forget === true);
          if (fact) facts.push(fact);
        } catch (e) {
          const fact = (e as { released?: Released })?.released;
          if (fact) facts.push(fact);
          errors.push(String((e as Error)?.message ?? e));
        }
      }
      // A container is the one thing here billed for merely existing, so a
      // release that did not release has to say so. stopBox has reported this
      // since the day thirteen boxes were found alive; nothing was listening.
      //
      // The throw stays — a survivor must not read as a success — but the facts
      // ride on it, every one of them, so the case that matters most (still
      // alive, still charging) is the one case that does not go unrecorded.
      if (errors.length) throw markReleased(new Error(errors.join("; ")), facts.length === 1 ? facts[0]! : facts);
      if (!facts.length) return false;
      return facts.length === 1 ? facts[0]! : facts;
    },
    /** Moves the machine holding `id` out of its slot into `stranded` (`Holding.strand`). Calls nothing at run9. */
    async strand(ctx: PluginContext, id: string, reason: string): Promise<boolean> {
      const mount = await readMount(ctx);
      const name = mount ? Object.keys(mount.machines).find((n) => mount.machines[n]!.boxId === id) : undefined;
      if (!mount || name === undefined) return false;
      const { [name]: box, ...machines } = mount.machines;
      // The slot keeps what is not about this box: an environment chosen to start from next.
      if (box!.startFrom) machines[name] = { ...NO_BOX, startFrom: box!.startFrom };
      await writeMount(ctx, {
        ...mount, machines,
        stranded: { ...(mount.stranded ?? {}), [id]: { ...box!, strandedAt: Date.now(), strandReason: reason.slice(0, 300) } },
      });
      return true;
    },
  },
  /** `run_js` and `shell` may only have STARTED the work; see `Backgrounding`. */
  background: {
    /** One look at the execution, with no waiting and nothing written. */
    async poll(handle, ctx) {
      const cfg = cfgOf(ctx);
      const h = handle as { boxId?: string; execId?: string; machine?: string };
      if (!h?.execId) throw new Error("not an execution handle");
      const provider = openProvider(cfg, ctx);
      const rec = await provider.poll(h.execId);
      if (!TERMINAL.includes(rec.state)) return { done: false, progress: { state: rec.state } };
      // The box as it was when the work started: this runs outside the call, and
      // writing the box record from here would race a second job finishing at
      // the same moment — the read-modify-write `exclusive` exists to prevent,
      // in a new place (Piper, 2026-09-14, `83f0658d`).
      // The machine the work was started on; a handle from before machines names none, which was "main".
      const machine = typeof h.machine === "string" && MACHINE_RE.test(h.machine) ? h.machine : MAIN_MACHINE;
      const state = await readView(ctx, machine);
      return { done: true, result: finished(rec, cfg, state, machine) as Json };
    },
    /**
     * Stop it and stop paying for it — and say so when it did not stop.
     *
     * The `.catch(() => {})` that used to be here decided, inside the plugin,
     * that a failed kill did not matter. It did: with three jobs running, a
     * refused fourth was cancelled through this path, the kill did not take, and
     * the command ran to completion in the container — with no job id, so
     * nothing could list it or cancel it. Both layers
     * swallowed the failure, so our ledger and the container were free to differ
     * with nobody able to notice.
     *
     * So: kill, then *confirm*. "I sent a kill" is our record; "the process is
     * gone" is the fact, and the bill follows the fact. Returning means the
     * execution is in a state that will not change again; anything else throws,
     * and the caller — which owns the ledger — decides what to record and
     * whether to ask again (no retry loop here, because the
     * runtime is what keeps a refused job tracked and calls back at its ceiling).
     *
     * **A terminal state is run9's record, not the process.** That the two agree
     * — that `cancelled` means the shell is gone — is something we measured (a
     * `sleep && echo … > file` whose file never appeared: four runs, by two of
     * us separately) and not something the API defines, so it can change without telling
     * us. Whoever edits this path or the one that starts an execution owes that
     * reading again; every cheaper check in the suites reads a record, and a
     * record is what was wrong the first time.
     */
    async cancel(handle, ctx) {
      const cfg = cfgOf(ctx);
      const h = handle as { execId?: string };
      if (!h?.execId) return;
      const provider = openProvider(cfg, ctx);
      let why: string;
      try {
        await provider.kill(h.execId);
        why = "kill accepted";
      } catch (e) {
        why = e instanceof Error ? e.message : String(e);
      }
      // The kill's own answer is not the evidence either way: a refusal may mean
      // only that the execution had already ended, and an acceptance does not
      // make it stop. Its state is the single authority, so it is asked whether
      // the kill succeeded or failed.
      let state: string | null = null;
      try {
        state = String((await provider.poll(h.execId)).state);
      } catch (e) {
        why += `; state unreadable: ${e instanceof Error ? e.message : String(e)}`;
      }
      if (state !== null && TERMINAL.includes(state)) return;
      if (state !== null) why += `; state ${state}`;
      // "Could not confirm", not "did not stop". Only one of the two ways to get
      // here is a statement about the process: a refused kill leaves it running,
      // while an accepted kill with a state that has not settled says nothing
      // about it either way — and the caller, which reports this to the agent,
      // would be passing on a claim we did not make. The two
      // are told apart by what follows the colon: run9's own answer, or `kill
      // accepted`.
      throw new Error(`could not confirm exec ${h.execId} stopped: ${why}`);
    },
  },

  credential: {
    required: true,
    // One declaration for every mount of the plugin, whichever provider it names, so it lists both forms and
    // none of the fields is required by the form itself: each provider's `checkCredential` refuses a credential
    // missing what that provider needs, by name, before it is kept.
    summary: "For run9: the access and secret keys (ak, sk). For InstaBox: the API key (apiKey). As JSON.",
    // A `secrets` setting once let a mount name further secrets to wire into
    // the container, and the credential carried a value per name. Both are
    // gone (#360): no mount could configure it — the validator's `typeOf`
    // (src/runtime/mount-config.ts) reads an object array as "unknown", so the
    // only shape that passed was not the shape the consumer wanted — and no
    // gate watched it. Recorded because the shape of the replacement is
    // decided: the one route that puts a credential in a container is
    // GitHub's, which checks the sibling's plugin and its policy before
    // registering anything, so a future injected secret starts there.
    shape: { keys: [
      { name: "ak", summary: "run9 access key, from the run9 console. run9 mounts only.", required: false },
      { name: "sk", summary: "run9 secret key, issued with the access key. run9 mounts only.", required: false },
      { name: "apiKey", summary: "InstaBox API key (ibk_...), from the InstaBox dashboard. InstaBox mounts only.", required: false },
    ] },
    grants: "starting and destroying containers, which are billed by the second.",
    docs: "https://run.sys9.ai",
  },
  config: [
    // The capability is "a sandbox"; run9 is who provides it today. Declared as
    // a choice rather than left implicit so that "the provider is run9" is a
    // statement the mount validator can check, and so a mount asking for a
    // provider we do not have is refused at the page rather than at the first
    // call. Every setting below this line belongs to the run9 provider.
    { name: "provider", type: "string", choices: PROVIDERS, default: "run9",
      summary: "Which sandbox provider runs the container: run9 or instabox. On InstaBox the working directory " +
        "defaults to /data/home/work, the size to 2c4g, and `project` and `verifyWith` do not apply. On InstaBox an `image` " +
        "runs as a Docker container inside the machine, and every command and file goes into it; without one, commands run on the machine." },
    { name: "template", type: "string", default: DEFAULTS.template,
      summary: "InstaBox only: the template a new machine starts from (GET /v1/templates lists them)." },
    { name: "maxLifetimeHours", type: "number", default: DEFAULTS.maxLifetimeHours,
      summary: "InstaBox only: hours after creation at which InstaBox deletes a machine whatever it is doing, a backstop against one nothing releases. At most 24, InstaBox's limit; it cannot be moved once the machine exists." },
    { name: "maxRunMinutes", type: "number", default: DEFAULTS.maxRunMinutes,
      summary: "InstaBox only: minutes a machine may run without a break before InstaBox pauses it." },
    { name: "image", type: "string", summary: "Container image to start from.",
      default: DEFAULTS.image },
    { name: "workdir", type: "string", summary: "Where scripts run and npm installs land. They must match, or Node resolves modules from somewhere npm did not install to.", default: "/work" },
    { name: "shape", type: "string", summary: "Machine size, e.g. 2c4g. Larger costs more per second." },
    { name: "shell", type: "string", summary: "Shell the shell tool runs commands in.", default: "/bin/sh" },
    { name: "shellPrefix", type: "string", summary: "Prepended to every shell command — for images whose toolchain lives in an environment a plain shell never enters." },
    { name: "network", type: "string", choices: ["open", "none"], default: "open",
      summary: "\"open\" or \"none\". With none every command runs in an empty network namespace: no route out, not even DNS. Only the network is taken away: without an image, commands still run on the machine itself, with its files. On InstaBox, network none needs an image." },
    { name: "timeoutMs", type: "number", summary: "How long one request to the provider may take.", default: 120000 },
    { name: "graceMs", type: "number", default: 5000,
      summary: "How long a command may run before it is handed over as a background job. Short commands still answer in the call; longer ones return a job and the agent carries on." },
    { name: "maxOutputBytes", type: "number", summary: "Output longer than this is cut and the rest discarded, not kept anywhere. A command whose output matters should write it to a file and save that.", default: 24000 },
    { name: "accounts", type: "string", choices: ["all", "none"], default: DEFAULTS.accounts,
      summary: "\"all\" lets tools in the container act as this agent's other accounts: every mount whose plugin can (GitHub: gh and git) and that holds a credential. The container holds a placeholder that the provider swaps for the credential only on requests to that service's hosts, so nothing in it can read the credential. A provider that cannot hold a credential for one container only (InstaBox) wires in none, and says so. \"none\" turns this off." },
    { name: "github", type: "string",
      summary: "Replaced by accounts. An empty value still turns wiring off, as it did; any other value does nothing." },
    { name: "maxQuietMinutes", type: "number", default: 60,
      summary: "Longest a single postponement of the release may be. The quiet tool refuses a larger one rather than shortening it: an agent that asks for a day and is silently given an hour believes it has a day." },
    { name: "keepStoppedDays", type: "number", default: DEFAULTS.keepStoppedDays,
      summary: "Days a container switched off for being idle keeps its disk before it is deleted; the agent is told a day before (at most half of this)." },
    { name: "maxMachines", type: "number", default: DEFAULTS.maxMachines,
      summary: "How many machines (separate named containers) an agent may have on this mount at once, the default one included. Switched-off ones count, since each keeps a disk; one more is refused until one is released." },
    { name: "project", type: "string", summary: "run9 project the boxes belong to.", default: "default" },
    { name: "endpoint", type: "string", summary: "API endpoint.", default: "https://api.run.sys9.ai" },
    // Who can say whether this mount's credential works, which stops being run9
    // the moment the endpoint is our own service in front of it: the mount then
    // holds a token we issued, and "is my key good" is a question for whoever
    // issued it rather than something to infer by bouncing off the provider.
    // Declared, not guessed from the endpoint's hostname — the same reason the
    // provider is a setting instead of something read out of a URL.
    { name: "verifyWith", type: "string", choices: ["provider", "endpoint"], default: "provider",
      summary: "Who answers whether the credential works: the provider's own API, or the endpoint's `/credential`." },
  ],
  version: "1.0.0",
  tools: toolsFor(null),
  /**
   * An InstaBox mount's tools: the same tools, with the sentences about what happens to an idle box true of
   * InstaBox (`instaboxLeaseTerms`). Every other mount gets `tools`, whose text is run9's.
   */
  mountTools(mount: MountRecord): ToolSchema[] {
    const config = (mount.publicConfig ?? {}) as SandboxConfig;
    return config.provider === "instabox" ? toolsFor(idleTermsOf(cfgFrom(config))) : toolsFor(null);
  },


  /** Does this key work, asked when a person pastes it (the provider's `checkCredential`). */
  async checkCredential(ctx) {
    if (!ctx.credential) return { ok: false as const, kind: "rejected" as const, reason: "no keys: this mount cannot start a container" };
    const cfg = cfgOf(ctx);
    return backendFor(cfg).checkCredential(cfg, ctx.credential);
  },

  /** Settings one provider cannot use, refused when the mount is made, and again before a call uses a machine. */
  configProblem(config) {
    return configProblemOf(config as SandboxConfig);
  },

  /** The account these keys act on (the provider's `account`), so a replaced key on the same one keeps the boxes. */
  async credentialAccount(ctx) {
    if (!ctx.credential) return null;
    const cfg = cfgOf(ctx);
    return backendFor(cfg).account(cfg, ctx.credential);
  },


  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    if (tool === "machines") return machinesList(await readMount(ctx), cfgOf(ctx), lease);
    // Which machine this call is about; refused before anything is read or started.
    const machine = machineOf(args);
    const named = machine !== MAIN_MACHINE ? { machine } : {};
    // Checked before anything else: neither releasing nor choosing an
    // environment should be the thing that starts a container.
    const prior = await readView(ctx, machine);
    if (tool === "release" && !prior.boxId) {
      return { released: false, note: machine === MAIN_MACHINE ? "nothing was running" : `nothing was running on machine "${machine}"`, ...named };
    }
    // Saving out of, or keeping, a named machine that does not exist would start one only to copy its
    // empty disk; "main" keeps its old behaviour.
    if ((tool === "save" || tool === "keep") && machine !== MAIN_MACHINE && !prior.boxId) {
      throw new Error(`there is no machine "${machine}" to ${tool} from; \`machines\` lists the ones that exist`);
    }

    if (tool === "start_from") {
      const envs = prior?.envs ?? [];
      const want = String((args as any)?.name ?? "");
      if (!want) {
        // `released: false` because the summary promised a release and this
        // call is the one that does not perform it — a model reading
        // `{kept: [], note}` alone cannot tell whether its container was just
        // taken away. Every ending of this tool now says so
        // outright rather than leaving it to be inferred from what is missing.
        return {
          kept: envs.map((e) => ({ name: e.name, note: e.note, savedAt: e.savedAt })),
          released: false,
          note: envs.length
            ? "this only lists; pass one of these as name to start from it"
            : "this only lists; nothing kept yet, and `keep` saves one",
        };
      }
      const env = envs.find((e) => e.name === want);
      if (!env) throw new Error(`no environment named ${want}; kept: ${envs.map((e) => e.name).join(", ") || "none"}`);
      // Releasing first, because the choice applies to the next container and
      // silently leaving the old one running is how a machine gets forgotten.
      const released = prior.boxId ? await stopBox(ctx, machine) : null;
      // Not deleted, the old container is still the machine (`stopBox` keeps naming it), so the choice would not
      // apply to anything: refused, with the release fact the recorder needs for a box still billing.
      if (released && !released.freed) {
        const e = new Error(`${providerName(cfgOf(ctx))} box ${released.boxId} not released, so ${env.name} was not chosen: ${released.error ?? "unknown"}`);
        throw released.lease ? markReleased(e, released.lease) : e;
      }
      const after = await readView(ctx, machine);
      await writeView(ctx, machine, { ...after, startFrom: env.snapId });
      // What it was waiting to start from before, if no environment names it any more (`dropSnapshots`).
      if (after.startFrom && after.startFrom !== env.snapId && ctx.credential) {
        const c = cfgOf(ctx);
        await dropSnapshots(ctx, openProvider(c, ctx), [after.startFrom]);
      }
      return {
        startingFrom: env.name, ...named,
        note: machine === MAIN_MACHINE
          ? "the next run or shell starts from this environment"
          : `the next run or shell on machine "${machine}" starts from this environment`,
        released: !!released,
        // The kernel reads this by name; `released` above is the model's
        // boolean and stays what it was.
        ...(released?.lease ? { [LEASE_KEY]: released.lease } : {}),
        ...(released ? { releasedPrevious: released.boxId } : {}),
      };
    }
    const cfg = cfgOf(ctx);

    // Before the credential check on purpose: postponing a release calls
    // nothing at run9, so a mount whose key was removed can still answer it.
    if (tool === "quiet") {
      // Switched off, what is postponed is the deletion, and it may be put off by as long as the box is kept
      // switched off at all; a running box bills compute, so its ceiling is the mount's own, much shorter one.
      const cap = parkedAt(prior) !== null
        ? Math.floor(keepDaysOf(cfg) * DAY / 60_000)
        : cfg.maxQuietMinutes ?? DEFAULTS.maxQuietMinutes;
      const asked = (args as any)?.minutes;
      // Refused rather than clamped, for the reason the config field states: an
      // agent given less than it asked for, silently, plans against the number
      // it asked for. The same reason the network gate fails closed.
      if (typeof asked !== "number" || !Number.isFinite(asked) || asked <= 0) {
        throw new Error(`minutes must be a positive number of minutes; the \`quiet\` tool on \`${ctx.alias}\` got ${JSON.stringify(asked)}`);
      }
      if (asked > cap) {
        throw new Error(
          `\`${ctx.alias}\` allows a quiet request of at most ${cap} minutes and ${asked} was asked for. ` +
          `Ask for ${cap} or fewer, or release the container` +
          (parkedAt(prior) !== null ? "." : " — it is billed for every second either way."),
        );
      }
      // After the refusals, so a malformed request is refused the same everywhere; before the write, so a
      // mount with no lease does not record a postponement nothing will read and answer as if it had one.
      if (!lease) {
        return {
          quiet: false,
          note: "this mount has no idle release to postpone: the container is handed back when the turn ends",
        };
      }
      if (!prior.boxId) return { quiet: false, note: "nothing is running, so there is no release to postpone", ...named };
      const quietUntil = Date.now() + asked * 60_000;
      // The postponement is its own instant, and `lastUsedAt` is deliberately
      // NOT touched, unlike every other handler here: the idle pass keeps the box
      // until the later of the two (idle-lease.ts `releaseAt`), and the page can
      // still tell "used" from "kept by request". Postponing is not using the
      // machine. There is no total cap: each postponement is a call the agent
      // chose to make, within this mount's limit.
      await writeView(ctx, machine, { ...prior, quietUntil });
      return {
        quiet: true, box: prior.boxId, ...named, minutes: asked, until: new Date(quietUntil).toISOString(),
        ...(parkedAt(prior) !== null ? { note: pausedOf(prior) ? "it stays paused; this postpones its deletion" : "it stays switched off; this postpones its deletion" } : {}),
      };
    }

    // A mount this plugin would not have accepted makes and uses no machine; a release still lets one go.
    if (tool !== "release") {
      const problem = configProblemOf(ctx.publicConfig as SandboxConfig);
      if (problem) throw new Error(`\`${ctx.alias}\` cannot run commands as it is set up: ${problem}`);
    }
    const provider = openProvider(cfg, ctx);
    const backend = backendFor(cfg);
    const terms = idleTermsOf(cfg);

    /**
     * A machine its provider deleted on its own (InstaBox, at `deleteAt` or otherwise): let go of here as a release
     * would (`stopBox`, which records its session and keeps the kept environments), and the call refused with what
     * happened, so the agent knows its files and processes are gone before it plans on them. The next call finds
     * no machine and starts a fresh one.
     */
    const expired = async (box: BoxState): Promise<never> => {
      const r = await stopBox(ctx, machine);
      const at = pastDeleteAt(box)
        ? `${backend.name} deleted it at ${new Date(box.deleteAt!).toISOString()}, as it deletes every machine at most ` +
          `${terms.maxLifetimeHours} hour${terms.maxLifetimeHours === 1 ? "" : "s"} after creating it, whatever it is doing`
        : `${backend.name} no longer has it`;
      const said = `machine "${machine}" (${box.boxId}) no longer exists: ${at}. Its files and running processes went with it, ` +
        "and nothing was done in it. The next call starts a fresh machine" +
        ((box.envs ?? []).length ? ", or `start_from` an environment you kept." : ".");
      if (r && !r.freed) {
        const e = new Error(`${said} Letting it go here failed too: ${r.error ?? "unknown"}`);
        throw r.lease ? markReleased(e, r.lease) : e;
      }
      const e = new Error(said);
      throw r?.lease ? markReleased(e, r.lease) : e;
    };
    /** A request about the machine in use; one that fails because the provider deleted the machine is `expired`. */
    const onBox = async <T>(fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); } catch (e) {
        if (state?.boxId && await goneAfter(backend, provider, state, e)) await expired(state);
        throw e;
      }
    };

    // Everything about the file is settled before a container is asked for, so a reference that is not this
    // agent's, a path outside the working directory, or a file too large starts and wakes nothing.
    let putting: { ref: string; path: string; bytes: Uint8Array; sha256: string } | null = null;
    if (tool === "put") {
      if (!artifacts) throw new Error("no object storage is mounted, so there is nothing to put");
      const ref = String((args as any)?.ref ?? "");
      // Only the shown form: it is the only one any tool hands out (src/store/refs.ts), and this tool is newer
      // than every transcript that holds a raw `r2://` one, so it has none to stay compatible with.
      if (!ref.startsWith(AGENT_REF)) {
        throw new Error(`ref must be an ${AGENT_REF} reference, as an attachment download or \`save\` returns; ` +
          `a URL or a storage address is not accepted: ${ref.slice(0, 80)}`);
      }
      // The same question every reader of a reference asks: does it name something of the agent holding it.
      const key = keyForRef(ref, ctx.caller);
      if (key === null) throw new Error(`reference is not readable by this agent: ${ref.slice(0, 80)}`);
      const path = putPathOf(cfg.workdir, String((args as any)?.path ?? ""));
      const tooLarge = (n: number) => new Error(
        `${ref.slice(0, 80)} is ${mib(n)}, over the ${mib(PUT_MAX_BYTES)} \`put\` copies into a container`);
      // Asked before the body is read, so an oversized object is never pulled into the isolate.
      const size = await artifacts.size(key);
      if (size === null) throw new Error(`no such artifact: ${ref.slice(0, 80)}`);
      if (size > PUT_MAX_BYTES) throw tooLarge(size);
      const bytes = await artifacts.get(key);
      if (bytes.byteLength > PUT_MAX_BYTES) throw tooLarge(bytes.byteLength);
      putting = { ref, path, bytes, sha256: hexOf(await crypto.subtle.digest("SHA-256", bytes)) };
    }

    // One box per machine, remembered, so an install survives to the next call.
    let state: BoxState | null = await readView(ctx, machine);
    // An emptied record keeps the session history and what was kept, but has no box.
    let history = state.sessions ?? [];
    let kept = state.envs ?? [];
    if (!state.boxId) state = null;
    // Whose the recorded box is, asked before anything below sends it a request (`ownedProvider`, which every
    // request passes through anyway: this is where a call learns it has no machine and goes on to make one).
    if (state && !state.ownerChecked) {
      try {
        await provider.owns(state.boxId);
        const now = await readView(ctx, machine);
        if (now.boxId === state.boxId && now.ownerChecked) state = { ...state, ownerChecked: true };
      } catch (e) {
        if (!(e instanceof BoxNotOurs)) throw e;
        state = null;
        // The lists as the split left them, which the new machine's record carries on.
        const after = await readView(ctx, machine);
        history = after.sessions ?? [];
        kept = after.envs ?? [];
        // Nothing of this agent's is there to release, keep or save; the call says so rather than making a
        // machine only to find it empty. The sentence about why comes in front (`notOursNote`).
        if (tool === "release") return { released: false, note: "nothing was running", ...named };
        if (tool === "keep" || tool === "save") throw new Error(`nothing was ${tool === "keep" ? "kept" : "saved"}`);
      }
    }
    // Past its provider's own deletion time the machine is gone: said before anything is asked of it. A release
    // goes on to let it go as it is.
    if (state && tool !== "release" && backend.id === "instabox" && pastDeleteAt(state)) await expired(state);
    let created = false;
    if (!state) {
      // The limit counts boxes that exist, switched-off ones included: each keeps a disk. Checked before
      // anything is asked of run9, so a refused machine costs nothing.
      const mount = await readMount(ctx);
      const others = boxedMachines(mount).filter((n) => n !== machine);
      const max = maxMachinesOf(cfg);
      if (others.length >= max) {
        const listed = others.map((n) => `${n} (${parkedAt(mount!.machines[n]) === null ? "running" : "switched off"})`).join(", ");
        throw new Error(
          `\`${ctx.alias}\` already has ${others.length} machine${others.length === 1 ? "" : "s"}, the most it may have at once ` +
          `(maxMachines ${max}), so machine "${machine}" was not created: ${listed}. Use one of these by passing its ` +
          `name as \`machine\`, or \`release\` one (with its \`machine\`) that you no longer need.`,
        );
      }
      created = true;
      // Unique to this tenant, agent, mount and machine, and to the millisecond (`boxIdFor`).
      const boxId = await boxIdFor({ tenantId: ctx.caller.tenantId, agentId: ctx.caller.agentId, mount: ctx.alias, machine }, Date.now());
      // `state` is null in this branch by construction — the line above nulls an
      // emptied record, and `start_from` writes exactly that — so the value can
      // only come from the record read at the top of this call. `BoxState`
      // declares the field, so there is nothing here to cast around either.
      const from = prior.startFrom;
      // What every result will report this container as: the setting (on InstaBox the template when no image is
      // set), or the image the kept environment itself started from. Unknown stays unknown.
      const image = from ? kept.find((e) => e.snapId === from)?.image : backend.id === "instabox" && !cfg.image ? cfg.template : cfg.image;
      // The agent's other accounts this container acts as (`SandboxForm`). Asked
      // at creation because the provider registers credentials per box, and read
      // again before every later command (reconcileAccounts).
      const want = await accountsWanted(ctx, cfg);
      const spec = {
        id: boxId,
        // Who and what the box is for, carried at the provider, so it can be found again without listing
        // everything the account holds.
        labels: { tenant: ctx.caller.tenantId, agent: ctx.caller.agentId, mount: ctx.alias, machine },
        // An environment kept earlier, or the bare image. Starting from a
        // snapshot is the whole point of having kept one.
        ...(from ? { fromSnapshot: from } : {}),
        image: cfg.image,
        egressSecrets: want.wire.length > 0,
        ...(cfg.shape ? { shape: cfg.shape } : {}),
        description: boxDescriptionOf(ctx.caller),
      };
      // The provider's id for the box, which is what the record names: the minted one where the provider takes
      // ours (run9), its own where it mints them (InstaBox).
      let made: { id: string; deleteAt?: number };
      try {
        made = await provider.create(spec);
      } catch (e) {
        // A create answered "already exists" for a name this call had just minted: the box existed and only the
        // answer was lost. Throwing here failed the agent's first command and leaked the box, since no record of
        // it was ever written. If the box is there and carries this spec's owner, it is ours (`SandboxProvider.adopt`).
        if (!(e instanceof ProviderError && e.code === "conflict")) throw e;
        const adopted = await provider.adopt(spec);
        if (adopted === null) throw e;
        made = { id: adopted };
      }
      // Recorded before anything else can fail: the box exists and is billed, so
      // a registration that throws must not leave it with no record naming it.
      // The record gains each placeholder only once the provider has accepted it.
      state = {
        boxId: made.id, createdAt: Date.now(), lastUsedAt: Date.now(), execs: 0, saved: [], ownerChecked: true,
        ...(made.deleteAt !== undefined ? { deleteAt: made.deleteAt } : {}),
        // Whose account this box is on, for as long as it lives (`BoxState.credentialRef`).
        ...(ctx.credentialRefKind ? { credentialRef: ctx.credentialRefKind } : {}),
        sessions: history,
        ...(image ? { image } : {}),
        ...(kept.length ? { envs: kept } : {}),
      };
      await writeView(ctx, machine, state);
      // The snapshot it was made from, if it was kept only for this machine to start from (`dropSnapshots`).
      if (from) await dropSnapshots(ctx, provider, [from]);
      // The value never enters the box and never reaches the model: only the
      // placeholder does, and run9 swaps it in on the way out.
      // `envs` above: release carries them over because a snapshot outlives its
      // box, and a new record written without them erased the list on the next
      // container's first command, stranding the snapshots in run9.
      state = await reconcileAccounts(ctx, state, provider, want, machine);
      await writeView(ctx, machine, state);
    }

    // A box the idle lease switched off starts again on the next exec on its id, disk intact, so it is reused
    // rather than replaced. Recorded as running before the command goes out: from here it bills compute again,
    // so it has to be back on the short idle schedule even if this call fails. A new compute session starts
    // (the last one was recorded when it was switched off), and a postponement of its deletion does not carry
    // over to hold off switching it off. `save` included: reading a file out of a stopped box may start it.
    // `keep` too where the provider snapshots a running box (InstaBox), which it wakes to do so.
    // A provider that does not wake a box on use (InstaBox) is asked to first, and the record says running only
    // once it is: a wake that fails leaves the box on its parked schedule, and one that finds it deleted lets it go.
    const wakes = tool === "run" || tool === "shell" || tool === "save" || tool === "put"
      || (tool === "keep" && backend.caps.snapshot === "live");
    if (!created && parkedAt(state) !== null && wakes) {
      // Its compute session starts when it is asked to wake, which is when it starts to bill.
      const t = Date.now();
      if (provider.wake) await onBox(() => provider.wake!(state!.boxId));
      const { parkedAt: _p, quietUntil: _q, parkedAs: _a, ...running } = state;
      state = { ...running, createdAt: t, lastUsedAt: t, execs: 0, saved: [] };
      await writeView(ctx, machine, state);
    }

    /**
     * Take something out of the box. Everything in a container dies with it,
     * and the file it produced is usually the reason the container existed.
     */
    const saveOut = async (path: string, archive: boolean) => {
      if (!path.startsWith("/")) throw new Error(`path must be absolute inside the box: ${path}`);
      if (!artifacts) throw new Error("no object storage is mounted, so nothing can be saved out");
      let res: Response;
      try {
        res = await onBox(() => provider.download(state!.boxId, path, { archive, timeoutMs: cfg.timeoutMs }));
      } catch (e) {
        if (e instanceof ProviderError && e.status !== undefined) {
          throw new Error(`could not read ${path}: ${e.status} ${e.detail.slice(0, 160)}`);
        }
        throw e;
      }
      const body = new Uint8Array(await res.arrayBuffer());
      // The name is where the file was, resolved the way the box itself
      // resolved it: `/work/../etc/x` is `/etc/x` on that machine, and the
      // artifact should be named for the file it is. Sanitising the characters
      // and stopping there kept `.`, `..` and empty segments in the key, which
      // the reader now refuses (#289) — so the box could save a file out and
      // then never open it again. `..` at the root stays at
      // the root, as it does in a filesystem.
      const name = segmentsOf(path).map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, "_")).join("/")
        + (archive ? ".tar" : "");
      const stored = await artifacts.put(
        `t/${ctx.caller.tenantId}/${ctx.caller.agentId}/sandbox/${state!.boxId}/${name}`,
        body, archive ? "application/x-tar" : "application/octet-stream");
      // Kept in the form the agent may be shown, because that is the only form
      // it leaves here in: `release` hands this list back, and `sessionOf`
      // reports it without a caller to convert it with. Storing the raw key
      // would put a conversion somewhere that has no owner to convert for
      // (tygg, 2026-09-14, `64c275ab`).
      const shown = toAgentRef(stored.ref, ctx.caller) ?? stored.ref;
      state = { ...state!, saved: [...(state!.saved ?? []), shown], lastUsedAt: Date.now() };
      await writeView(ctx, machine, state);
      return { path, ref: shown, bytes: body.length };
    };

    if (tool === "keep") {
      const name = String((args as any)?.name ?? "").trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
        throw new Error("name must be short, and letters, digits, dot, dash or underscore");
      }
      // The provider may stop the box to fork it (`caps.snapshot`); the next call then wakes it with its files.
      const snapId = await onBox(() => provider.snapshot(state!.boxId, `antiproton ${ctx.caller.tenantId}/${ctx.caller.agentId} ${name}`));
      const env: Env = {
        name, snapId, savedAt: Date.now(),
        ...(state!.image ? { image: state!.image } : {}),
        ...(typeof (args as any)?.note === "string" ? { note: String((args as any).note).slice(0, 200) } : {}),
      };
      const before = state!.envs ?? [];
      const envs = [env, ...before.filter((e) => e.name !== name)].slice(0, 20);
      state = { ...state!, envs, lastUsedAt: Date.now() };
      await writeView(ctx, machine, state);
      // A snapshot no name refers to any more (replaced under its name, or past the 20 kept) is deleted where the
      // provider can, unless a machine is waiting to start from it (`dropSnapshots`). Best effort: the
      // environment is kept either way, and one left behind is said.
      const notDeleted = await dropSnapshots(ctx, provider, before.filter((e) => !envs.includes(e)).map((e) => e.snapId));
      return {
        kept: name, snapshot: snapId, ...named,
        note: keptNote(lease, terms),
        ...(notDeleted.length ? { notDeleted } : {}),
      };
    }

    if (tool === "save") {
      const r = await saveOut(String((args as any)?.path ?? ""), (args as any)?.archive === true);
      return { ...r, note: savedNote(lease, terms) };
    }

    if (tool === "put") {
      const p = putting!;
      // A short script on the box, waited for: its exit code and output. Not the agent's shell, so its
      // directory and the agent's command count are left alone.
      const script = async (body: string, what: string): Promise<{ exit: number; out: string }> => {
        const execId = await onBox(() => provider.execBackground(state!.boxId, { argv: ["sh", "-c", body, "sh", p.path] }));
        const until = Date.now() + cfg.timeoutMs;
        for (;;) {
          const rec = await provider.poll(execId);
          if (rec.state === "succeeded" || rec.state === "failed") return { exit: Number(rec.exitCode ?? -1), out: String(rec.output ?? "") };
          if (TERMINAL.includes(rec.state)) throw new Error(`could not ${what} for ${p.path}: ${rec.state} ${String(rec.reason ?? "").slice(0, 120)}`);
          if (Date.now() > until) throw new Error(`could not ${what} for ${p.path}: the command did not finish in time`);
          await new Promise((r) => setTimeout(r, 300));
        }
      };
      const ready = await script(PUT_PREPARE_SCRIPT, "make the directory");
      if (ready.exit === 6) throw new Error(`${p.path} is a directory in the container; name a file inside it instead`);
      if (ready.exit === 5) throw new Error(`could not make the directory for ${p.path}: something on the way there is a file`);
      if (ready.exit !== 0) throw new Error(`could not make the directory for ${p.path}: exit ${ready.exit} ${ready.out.slice(0, 120)}`);

      await onBox(() => provider.upload(state!.boxId, p.path, p.bytes));

      // Read back from the box itself: the provider's answer says a transfer ended, this says the file is the one sent.
      const got = await script(PUT_CHECK_SCRIPT, "read the file back");
      if (got.exit === 3) throw new Error(`${backend.name} accepted the upload, but ${p.path} is not a file in the container`);
      if (got.exit !== 0) throw new Error(`could not read ${p.path} back: exit ${got.exit} ${got.out.slice(0, 120)}`);
      const [sizeLine, hashLine] = got.out.trim().split("\n").map((l) => l.trim());
      const boxSize = Number(sizeLine);
      const boxHash = /^[0-9a-f]{64}$/.test(hashLine ?? "") ? hashLine! : null;
      if (boxSize !== p.bytes.byteLength || (boxHash !== null && boxHash !== p.sha256)) {
        throw new Error(`${p.path} in the container is not the file sent: ${sizeLine} bytes` +
          `${boxHash ? `, sha256 ${boxHash}` : ""}, where ${p.bytes.byteLength} bytes, sha256 ${p.sha256} were sent`);
      }
      state = { ...state!, lastUsedAt: Date.now() };
      await writeView(ctx, machine, state);
      return {
        path: p.path, bytes: p.bytes.byteLength, sha256: p.sha256, ref: p.ref, ...named,
        // Whether the box's own sha256 was compared, or only its size (an image without `sha256sum`).
        checked: boxHash ? "sha256" : "size",
        note: "in the container now; work on it with `shell` or `run`, and `save` what you make from it",
      };
    }

    if (tool === "release") {
      // Saving first, in the same call, so "keep this and hand the machine
      // back" does not depend on the agent remembering to do it in two.
      const kept: unknown[] = [];
      for (const path of ((args as any)?.save ?? []) as string[]) {
        kept.push(await saveOut(path, false));
      }
      const r = await stopBox(ctx, machine);
      if (!r) return { released: false, note: "nothing was running", saved: kept, ...named };
      // Both outcomes report the lease: a release that failed is the case the
      // recorder most needs, because that box is still alive and still billing.
      return r.freed
        ? { released: true, box: r.boxId, ...named, liveMs: r.liveMs, saved: kept, [LEASE_KEY]: r.lease,
            note: "the container and its files are gone; anything saved above is not" }
        : { released: false, box: r.boxId, ...named, error: r.error, saved: kept, ...(r.lease ? { [LEASE_KEY]: r.lease } : {}) };
    }

    const wd = cfg.workdir;
    const a = (args ?? {}) as { code?: string; install?: string[]; command?: string; workdir?: string };
    const askedDir = tool === "shell" && typeof a.workdir === "string" && a.workdir.trim()
      ? (a.workdir.trim().startsWith("/")
          ? a.workdir.trim()
          : "/" + segmentsOf(`${state.cwd ?? wd}/${a.workdir.trim()}`).join("/"))
      : null;
    let command: string;
    if (tool === "run") {
      if (!a.code) throw new Error("code is required");
      // Install and run in the same directory, or Node resolves modules from
      // wherever the script happens to sit and cannot find what was installed.
      const install = a.install?.length
        ? `npm install --prefix ${wd} --no-audit --no-fund --silent ` +
          `${a.install.map((p) => `'${p.replace(/'/g, "")}'`).join(" ")} >/dev/null 2>&1; `
        : "";
      // The extension picks the module system, and picking it wrongly is not a
      // detail: .mjs makes `require` undefined, and a model writing Node by hand
      // reaches for `require` first. CommonJS is the forgiving default because
      // dynamic `import()` still works inside it; only static `import`/`export`
      // syntax needs ESM, and that is what this looks for.
      const esm = /^\s*(import\s[\s\S]*?from\s|import\s*[{("']|export\s)/m.test(a.code);
      const file = esm ? `${wd}/run.mjs` : `${wd}/run.cjs`;
      // Written to a file rather than passed inline, so quoting cannot mangle it.
      const b64 = btoa(unescape(encodeURIComponent(a.code)));
      command = `mkdir -p ${wd} && cd ${wd} && ${install}` +
        `echo '${b64}' | base64 -d > ${file} && node ${file}`;
    } else if (tool === "shell") {
      if (!a.command) throw new Error("command is required");
      // Like one terminal session: the command starts where the previous one
      // ended, passed as run9's `workdir` rather than a `cd` glued in front (run9's
      // own advice for "run this from that directory"). A new box has no such
      // directory yet, so its first command makes and enters the working one.
      // An explicit `workdir` runs this one command there; a
      // relative one is taken from where the shell is now.
      command = (askedDir ?? state.cwd) ? withCwdTrailer(a.command) : withCwdTrailer(`mkdir -p ${wd} && cd ${wd} || exit 1\n${a.command}`);
    } else {
      throw new Error(`unknown tool: ${tool}`);
    }

    // Started on run9's *background* route, not the plain one, because that is
    // the only kind of execution run9 will kill: `POST /execs/{id}/kill` on an
    // execution created here answers 400 `exec is not background mode`, and the
    // command runs to completion regardless. Measured on a box of our own,
    // 2026-09-14: a foreground `sleep 45 && echo … > /tmp/fg-probe`
    // was killed, answered 400, finished `succeeded` and wrote its file; the
    // same command started here was killed with 200, went to `cancelled
    // (explicit_cancel)`, and its file never appeared. That is the whole of the
    // defect as reproduced — a job refused by the cap kept running, unlisted
    // and uncancellable — and it also means the pre-#16 "exceeded timeoutMs and
    // was killed" path never killed anything.
    //
    // `background` here is run9's word for "the caller is not attached", not
    // ours: the mount hands *every* command to this route, and whether the
    // agent waits for it is decided below by the grace window. The record comes
    // back in the same shape either way — state, exit_code, output_summary —
    // which is what lets `finished` stay one function (checked live: exit 3 and
    // both streams came back identically).
    const startIn = tool === "shell" ? (askedDir ?? state.cwd ?? null) : null;
    const start = (argv: string[], workdir: string | null) => onBox(() => provider.execBackground(state!.boxId, { argv, workdir }));
    // The box just created was wired from the mount a moment ago; any other is checked again.
    if (!created) state = await reconcileAccounts(ctx, state!, provider, await accountsWanted(ctx, cfg), machine);
    const argvCfg = { ...cfg, isolate: backend.isolateNetworkFor?.(cfg) ?? backend.isolateNetwork };
    let execId = await start(execArgv(argvCfg, command, envFor(state)), startIn);
    let movedFrom: string | null = null;

    // The work has begun. From here the call may finish it or hand it over,
    // and both have to produce the same thing — `finished` is that thing, in
    // one place, because a result built twice is two rules about one shape
    // and they drift (the lesson of #291).
    // A box that runs a command after run9 refused to delete it is in use again: its earlier failure was reported
    // (`deleteFailedAt`), and a later one is news of its own, worth its own error lease.
    const { deleteFailedAt: _failed, ...usable } = state;
    const afterStart: BoxState = { ...usable, lastUsedAt: Date.now(), execs: (state.execs ?? 0) + 1 };
    await writeView(ctx, machine, afterStart);

    const grace = Date.now() + cfg.graceMs;
    for (;;) {
      const rec = await provider.poll(execId);
      // The provider does not start an exec in a directory that is gone (it may have been
      // removed, or lived under /tmp, which does not survive an idle box).
      // A directory the agent named is its own answer: say it does not exist
      // rather than run the command somewhere it did not ask for.
      if (rec.couldNotStart && askedDir) {
        return {
          ...finished(rec, cfg, state, machine),
          note: `${askedDir} does not exist in the container; create it first, or leave workdir out`,
        };
      }
      // A remembered one that vanished: once, start again in the working directory, and say so.
      if (rec.couldNotStart && startIn && !askedDir && !movedFrom) {
        movedFrom = startIn;
        execId = await start(execArgv(argvCfg, withCwdTrailer(`mkdir -p ${wd} && cd ${wd} || exit 1\n${a.command}`), envFor(state)), null);
        continue;
      }
      if (TERMINAL.includes(rec.state)) {
        const result = finished(rec, cfg, state, machine);
        // Only the call that ran the command writes the directory: a job finished
        // later through the poll must not write the box record (see pollBackground),
        // so a command handed over does not move the shell, as `&` would not.
        const cwd = tool === "shell" ? splitCwd(String(rec.output ?? "")).cwd : null;
        const moved = movedFrom !== null && (state.cwd ?? null) !== null;
        if (tool === "shell" && (cwd ?? null) !== (state.cwd ?? null)) {
          await writeView(ctx, machine, { ...afterStart, cwd: cwd ?? undefined });
        }
        return moved
          ? { ...result, note: `${movedFrom} no longer exists, so this command started in ${wd}` }
          : result;
      }
      if (Date.now() > grace) {
        // Handed over rather than waited on: the turn is serialised while this
        // call is open (`exclusive`), so waiting here costs the agent every
        // other tool it might have run and every thought it might have had
        // (cody measured three quarters of billed Worker time on SWE-bench;
        // `83f0658d`).
        // The ceiling that used to live here is the runtime's now, and so is
        // the cancelling — `timeoutMs` no longer means "how long the Worker
        // holds".
        return backgrounded(
          { boxId: state.boxId, execId, ...named },
          `running in the container; its result arrives on its own, and \`jobs\` lists what is running`,
        );
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  },



  };
  // Every call, whichever tool and however it ends, carries the sentence `notOursNote` says when it let go of a box.
  const invokeTool = plugin.invoke.bind(plugin);
  plugin.invoke = async (tool, args, ctx) => {
    // Removals left pending on another agent's box get another try on each call, whichever tool it is; one that
    // cannot be made now is no reason to fail the call (`retryForeign`).
    if (ctx.credential && tool !== "machines") {
      try { await openProvider(cfgOf(ctx), ctx).retryForeign(); } catch { /* counted on its own entry, or tried again next call */ }
    }
    let result: Json;
    try {
      result = await invokeTool(tool, args, ctx);
    } catch (e) {
      const note = await notOursNote(ctx);
      if (note?.text && e instanceof Error) { e.message = joinSentences(note.text, e.message); await delivered(ctx, note.ids); }
      throw e;
    }
    const note = await notOursNote(ctx);
    if (!note) return result;
    const told = withNotOursNote(result, note.text || null);
    // Cleared once a result carries it, and kept while none could (a result with no `note` to put it in).
    if (!note.text || told !== result) await delivered(ctx, note.ids);
    return told;
  };
  return plugin;
}
