import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext, MountActivity, MountUsage, Released, SandboxForm } from "./types.ts";
import { backgrounded, LEASE_KEY, markReleased } from "./types.ts";
import type { R2Artifacts } from "../store/artifacts.ts";
import { toAgentRef } from "../store/refs.ts";
import { spanText } from "../runtime/idle-lease.ts";

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
  /** Which provider runs the container. Only "run9" is implemented. */
  provider?: string;
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

interface Run9Credential {
  ak: string;
  sk: string;
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
}

/**
 * Where the box record lives in this mount's database: one record under one
 * key. Exported for the bench meter, which reads the sessions of a finished
 * run from the rows without a call.
 */
export const BOX_STORE = "box";
export const BOX_KEY = "state";

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
}

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
  await ctx.db.put(BOX_STORE, {
    machines,
    ...(keptSessions ? { sessions: keptSessions } : {}),
    ...(keptEnvs?.length ? { envs: keptEnvs } : {}),
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
export function notAReasonToRelease(lease: BoxLease | null): string {
  // "Leave it running" is only something an agent can do under a lease: without one the box is handed back
  // when the turn ends whatever it decides, so that half would be a promise nothing keeps (from the #327 review).
  // Under the lease, leaving it is cheap because idle only switches it off, which is why the sentence says so.
  return lease
    ? "A copy outliving the container is not a reason to release it: if you or the person you are working for " +
      "will come back to this machine, leave it running — idle, it is only switched off, and the next call " +
      "brings it back with its files."
    : "A copy outliving the container is not a reason to release it early: it is handed back when the turn " +
      "ends anyway, and until then it is still the machine you are working on.";
}
export const keptNote = (lease: BoxLease | null) =>
  "independent of this container; start a fresh machine from it later with `start_from`. " + notAReasonToRelease(lease);
export const savedNote = (lease: BoxLease | null) => "kept outside the box, for later. " + notAReasonToRelease(lease);

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

/**
 * The states run9 reports for an execution that will not change again.
 *
 * `error` included: run9 documents it as platform trouble rather than an app
 * exit, and an exec that could not start (a working directory that does not
 * exist, measured 2026-09-15) sits in it for good. Left out, such an exec was
 * never finished: the call handed it over as a job and every poll said "not yet".
 */
const TERMINAL = ["succeeded", "failed", "killed", "cancelled", "timeout", "error"];

/** This mount's settings, defaults filled in. */
function cfgOf(ctx: PluginContext) {
  // No written return type: the spread of a partial over the defaults is the
  // truth here, and an annotation beside it would be a second statement of the
  // same thing, free to disagree with it.
  return { ...DEFAULTS, ...(ctx.publicConfig as SandboxConfig) };
}

/**
 * A caller for run9's API under this mount's credential.
 *
 * Lifted out of `invoke` because polling and cancelling happen outside a call
 * and need the same door — with the same credential resolution, so there is
 * one place that knows how to talk to run9 rather than three that agree.
 */
function apiFor(cfg: ReturnType<typeof cfgOf>, ctx: PluginContext) {
  if (!ctx.credential) throw new Error("run9 mount has no credential");
  const cred = JSON.parse(ctx.credential) as Run9Credential;
  const auth = "Basic " + btoa(`${cred.ak}:${cred.sk}`);
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(cfg.endpoint + path, {
      method,
      headers: { authorization: auth, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* plain text error */ }
    if (!res.ok) throw new Error(`run9 ${method} ${path} -> ${res.status}: ${String(text).slice(0, 200)}`);
    return parsed;
  };
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
  rec: any,
  cfg: ReturnType<typeof cfgOf>,
  state: BoxState | null,
  machine: string = MAIN_MACHINE,
): Record<string, unknown> {
  // A `shell` command reports where it ended; the report is ours, not the command's output.
  const { output: out, cwd } = splitCwd(String(rec.output_summary ?? ""));
  return {
    state: rec.state,
    exitCode: rec.exit_code ?? null,
    ...(cwd ? { cwd } : {}),
    // Allowed, not refused: an agent may need to look in /tmp. But work left there is gone after an idle
    // spell (tmpfs, measured 2026-09-15), so the result says so while the agent is still standing in it.
    ...(cwd && (cwd === "/tmp" || cwd.startsWith("/tmp/"))
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
  return {
    machines,
    ...(Array.isArray(o.sessions) ? { sessions: o.sessions.filter(isSession) } : {}),
    ...(Array.isArray(o.envs) ? { envs: o.envs.filter(isEnv) } : {}),
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
    ? (wired.every(isWired) ? wired : [UNKNOWN_WIRING])
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
export function providerOf(cfg: { provider?: string }): "run9" {
  const asked = cfg.provider ?? "run9";
  if (asked !== "run9") {
    throw new Error(`this sandbox mount asks for the "${asked}" provider, and run9 is the only one implemented`);
  }
  return "run9";
}

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
};

/**
 * Hand the box back for real.
 *
 * `stop` is not release: it returns 200, halts the runtime, and leaves the box
 * and its storage in place — the state stays `ready` and storage keeps being
 * billed, which is the largest component of the quota. Only `DELETE` actually
 * frees it. Stopping first is a courtesy so nothing is killed mid-write.
 *
 * Failures are reported rather than swallowed. An earlier version buried them
 * on the theory that "the box stops itself eventually"; the result was thirteen
 * live boxes and a release path that had been announcing success the whole time.
 */
async function stopBox(
  ctx: PluginContext, machine: string,
): Promise<{ boxId: string; freed: boolean; error?: string; liveMs: number; lease: Released } | null> {
  const state = await readView(ctx, machine);
  if (!state.boxId || !ctx.credential) return null;
  const cfg = { ...DEFAULTS, ...(ctx.publicConfig as SandboxConfig) };
  providerOf(cfg);
  const cred = JSON.parse(ctx.credential) as Run9Credential;
  const auth = "Basic " + btoa(`${cred.ak}:${cred.sk}`);
  const base = `${cfg.endpoint}/projects/${cfg.project}/workspace/boxes/${state.boxId}`;
  let error: string | undefined;
  try {
    await fetch(`${base}/stop`, { method: "POST", headers: { authorization: auth },
      signal: AbortSignal.timeout(20_000) }).catch(() => {});
    const res = await fetch(base, { method: "DELETE", headers: { authorization: auth },
      signal: AbortSignal.timeout(30_000) });
    if (!res.ok) error = `delete returned ${res.status}: ${(await res.text()).slice(0, 120)}`;
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 160);
  }
  // The box record goes either way — keeping a pointer to one we failed to
  // delete only means the next call tries to reuse something that may not be
  // there — but the session survives it. A container is the one thing here
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
  const endedAt = Date.now();
  const stoppedAt = parkedAt(state);
  const session = sessionOf(state, stoppedAt ?? endedAt, machine);
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
    boxId: state.boxId, freed: !error, error, liveMs: session.endedAt - session.startedAt,
    lease: {
      id: state.boxId, startedAt: stoppedAt ?? session.startedAt, endedAt,
      status: error ? "error" : "freed", ...(error ? { error } : {}),
    },
  };
}

/**
 * Switch an idle box off and keep it: the idle lease's step for a running box.
 *
 * `stop` halts the runtime and keeps the box and its disk; the next exec on the
 * same id starts it again with its files (measured 2026-10-01: about two
 * seconds, /work intact, processes gone). So an idle machine stops billing
 * compute without its agent losing anything, which is why no warning comes
 * before this step and one does come before the deletion that follows much
 * later (`activityOf`).
 *
 * The compute session ends here and is recorded the way `stopBox` records one,
 * because the next use starts a new one (`createdAt` moves then). A stop run9
 * refused is thrown with its fact, as `stopBox` does: a box still running must
 * not read as switched off.
 */
async function parkBox(ctx: PluginContext, machine: string, state: BoxState): Promise<Released | false> {
  if (!ctx.credential) return false;
  const cfg = cfgOf(ctx);
  providerOf(cfg);
  const cred = JSON.parse(ctx.credential) as Run9Credential;
  const auth = "Basic " + btoa(`${cred.ak}:${cred.sk}`);
  let error: string | undefined;
  try {
    const res = await fetch(`${cfg.endpoint}/projects/${cfg.project}/workspace/boxes/${state.boxId}/stop`, {
      method: "POST", headers: { authorization: auth }, signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) error = `stop returned ${res.status}: ${(await res.text()).slice(0, 120)}`;
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 160);
  }
  const endedAt = Date.now();
  const session = sessionOf(state, endedAt, machine);
  const fact: Released = {
    id: state.boxId, startedAt: session.startedAt, endedAt,
    status: error ? "error" : "freed", ...(error ? { error } : {}),
  };
  if (error) throw markReleased(new Error(`run9 box ${state.boxId} not switched off: ${error}`), fact);
  // Read again before writing, for the reason `stopBox` does: a command may
  // have recorded another box meanwhile, and that one is running.
  const now = await readView(ctx, machine);
  if (now.boxId === state.boxId) {
    // A postponement is spent by the time this runs (the pass waits for the later of the two), and one left
    // in the record would hold off the deletion schedule by its old instant.
    const { quietUntil: _q, ...rest } = now;
    await writeView(ctx, machine, { ...rest, parkedAt: endedAt, sessions: keepSessions(now.sessions, session) });
  }
  return fact;
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
    // Switched off: the next step deletes the disk, which loses files, so this
    // one waits days and is announced. Idle from when it was switched off, or
    // from a later touch (`keep` stamps one without starting it).
    const days = keepDaysOf({ keepStoppedDays });
    const maxMs = days * DAY;
    return {
      live: {
        id: state.boxId,
        startedAt: state.createdAt,
        lastUsedAt: Math.max(stopped, used),
        lease: {
          maxMs,
          warnMs: stoppedWarnMs(days),
          consequence: "the stopped machine and everything on its disk will be deleted",
          advice: "Before then, `save` the files you need or `keep` the environment, or run anything in it to "
            + "switch it back on.",
          maxPostponeMinutes: Math.floor(maxMs / 60_000),
        },
        ...label,
      },
      quietUntil: state.quietUntil ?? null,
      ...(unreadable ? { unreadable } : {}),
      billing: "stopped: no compute is billed; only its disk is kept until it is deleted",
    };
  }
  return {
    live: {
      id: state.boxId,
      startedAt: state.createdAt,
      lastUsedAt: used,
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
  if (!names.length) return [activityOf(null, unreadable, keepStoppedDays)];
  return names.map((n) => activityOf(viewOf(mount, n), unreadable, keepStoppedDays, labelOf(n, names.length > 1)));
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
  return pick === undefined
    ? activityOf(null, unreadable, keepStoppedDays)
    : activityOf(viewOf(mount, pick), unreadable, keepStoppedDays, labelOf(pick, names.length > 1));
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
  state: { boxId: string; createdAt: number; lastUsedAt?: number; execs?: number; saved?: string[] },
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
  cfg: { shell: string; shellPrefix?: string; network?: "open" | "none" },
  command: string,
  env: Record<string, string> = {},
): string[] {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}='${v.replace(/'/g, `'\\''`)}'; `).join("");
  const line = exports + (cfg.shellPrefix ? `${cfg.shellPrefix}${command}` : command);
  const argv = [cfg.shell, "-lc", line];
  const open = cfg.network === undefined || cfg.network === "open";
  return open ? argv : ["unshare", "-n", "--", ...argv];
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
  /** The environment its commands run with; holds the placeholder, never the credential. */
  env?: Record<string, string>;
  /** The plugin's own sentence for the model (`SandboxForm.summary`). */
  summary?: string;
}

interface LeftOut { alias: string; why: string }

/** A wiring this record cannot account for; the next command clears the box and wires again. */
const UNKNOWN_WIRING: Wired = { alias: "", plugin: "", placeholder: "", digest: "", names: null };

/** One credential registered with run9's egress for one box. */
interface Registration { name: string; value: string; placeholder: string; header: string; hosts: string[] }

/**
 * What stands for a mount's credential in one container. Qualified by box,
 * because run9 requires a placeholder to be unique across the project, and
 * fresh on every registration, because a placeholder that belonged to a deleted
 * secret is accepted again and then not substituted (measured on run9,
 * 2026-09-15: re-registered after a policy change, GitHub answered 401).
 */
export function placeholderFor(
  alias: string, boxId: string,
  fresh = [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, "0")).join(""),
): string {
  const tag = (s: string) => s.replace(/[^A-Za-z0-9]/g, "_");
  return `__AP_${tag(alias).toUpperCase()}_${tag(boxId.slice(-8))}_${fresh}__`;
}

/** A form's registrations for one credential and placeholder: the value goes to run9's egress, never into the box. */
export function registrationsFor(form: SandboxForm, credential: string, placeholder: string): Registration[] {
  return form.egress.map((e) => ({
    name: e.name, value: e.value(credential), placeholder: e.placeholder(placeholder), header: e.header, hosts: [...e.hosts],
  }));
}

/**
 * Every name a form takes in a container: its registrations and its environment
 * variables. git's helper is configured through `GIT_CONFIG_COUNT` and
 * `GIT_CONFIG_KEY_0`, so a second plugin with a git helper would clash with
 * github and both would be left out, though git takes several helpers. When
 * that plugin arrives, number the helpers across forms instead of claiming
 * index 0.
 */
function claimedNames(form: SandboxForm): string[] {
  return [...new Set([...form.egress.map((e) => e.name), ...Object.keys(form.env(""))])];
}

/** The environment a command runs with: every wired mount's, which names placeholders only. */
function envFor(state: BoxState | null): Record<string, string> {
  return Object.assign({}, ...(state?.wired ?? []).map((w) => w.env ?? {}));
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

type Run9Api = (method: string, path: string, body?: unknown) => Promise<any>;

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

async function register(api: Run9Api, project: string, boxId: string, c: Candidate & { credential: string; digest: string }): Promise<Wired> {
  const placeholder = placeholderFor(c.alias, boxId);
  const regs = registrationsFor(c.form, c.credential, placeholder);
  for (const g of regs) {
    await api("POST", `/projects/${project}/workspace/boxes/${boxId}/secrets`, {
      name: g.name, value: g.value, placeholder: g.placeholder,
      inject_header_name: g.header, allowed_hosts: g.hosts,
    });
  }
  await c.used();
  return {
    alias: c.alias, plugin: c.plugin, placeholder, digest: c.digest, names: regs.map((g) => g.name),
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
  ctx: PluginContext, cfg: ReturnType<typeof cfgOf>, state: BoxState, api: Run9Api,
  want: Awaited<ReturnType<typeof accountsWanted>>, machine: string,
): Promise<BoxState> {
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
    const base = `/projects/${cfg.project}/workspace/boxes/${state.boxId}/secrets`;
    const everything = drop.some((w) => w.names === null);
    const names = new Set(drop.flatMap((w) => w.names ?? []));
    const listed = await api("GET", base);
    for (const s of Array.isArray(listed) ? listed : []) {
      if (everything || names.has(s?.name)) await api("DELETE", `${base}/${s.secret_id}`);
    }
  }
  // Recorded as gone before registering again, so a registration that fails
  // does not leave the record promising access the box no longer has.
  if (!next.wired!.length) delete next.wired;
  if (!next.leftOut!.length) delete next.leftOut;
  await writeView(ctx, machine, next);
  for (const c of add) {
    next.wired = [...(next.wired ?? []), await register(api, cfg.project, state.boxId, c)];
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
  ctx: PluginContext, machine: string, reason: "idle" | undefined, lease: BoxLease | null,
): Promise<Released | false> {
  if (lease && reason === "idle") {
    const state = await readView(ctx, machine);
    if (state.boxId && parkedAt(state) === null) return parkBox(ctx, machine, state);
  }
  const r = await stopBox(ctx, machine);
  if (r === null) return false;
  if (!r.freed) {
    throw markReleased(new Error(`run9 box ${r.boxId} not released: ${r.error ?? "unknown"}`), r.lease);
  }
  return r.lease;
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
  mount: MountState | null, cfg: { keepStoppedDays?: unknown; maxMachines?: unknown }, lease: BoxLease | null,
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
    const live = activityOf(viewOf(mount, name), 0, days).live!;
    const stopped = parkedAt(box) !== null;
    const at = lease
      ? new Date(Math.max(
          live.lastUsedAt + (stopped ? live.lease!.maxMs! : lease.maxMs),
          box.quietUntil ?? 0,
        )).toISOString()
      : null;
    return {
      machine: name,
      state: stopped ? "switched off" : "running",
      box: box.boxId,
      image: box.image ?? null,
      created: iso(box.createdAt),
      lastUsed: iso(box.lastUsedAt || box.createdAt),
      ...(stopped ? { switchedOff: iso(box.parkedAt) } : {}),
      ...(box.cwd ? { cwd: box.cwd } : {}),
      ...(at ? (stopped ? { deletedAfter: at } : { switchedOffAfter: at }) : {}),
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
  const runLifetime = lease
    ? "The container is NOT the per-execution sandbox: every call uses the same one, in this turn and later " +
      "ones, so installs and files survive from one call to the next — do not reinstall. It stays until you " +
      `release it; ${leaseTerms(lease)}. Work in as few calls as you can, save what matters with \`save\`, and ` +
      "release it once the machine will not be needed again. Releasing deletes it and everything on its disk."
    : "The container is NOT the per-execution sandbox: every call in this " +
      "turn uses the same one, so installs and files survive from one call to the next — do not " +
      "reinstall. It is handed back when the turn ends, so a later turn starts a new container " +
      "unless you saved this one's filesystem with `keep`. Work in as few calls as you can, save " +
      "what matters with `save`, and release it. Everything inside is destroyed when it is released.";
  const shellLifetime = lease
    ? "Shell in the same container as `run`, billed by the second while it runs, and the same one for every call, in this " +
      "turn and later ones — state, installed packages and files carry over — until you release it; " +
      `${leaseTerms(lease)}.`
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
  return {
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
    /** What this mount is keeping alive, read from its own state and nothing
     *  else: no credential, no call to run9. */
    async activity(ctx: PluginContext): Promise<MountActivity> {
      const raw = await ctx.db.get(BOX_STORE, BOX_KEY);
      return summaryActivity(asMountState(raw), unreadableEntries(raw), keepDaysOf(cfgOf(ctx)));
    },
    /** Each machine on its own: its own schedule, postponement and cost (see `Holding.activities`). */
    async activities(ctx: PluginContext): Promise<MountActivity[]> {
      const raw = await ctx.db.get(BOX_STORE, BOX_KEY);
      return activitiesOf(asMountState(raw), unreadableEntries(raw), keepDaysOf(cfgOf(ctx)));
    },
    /** The window this mount still holds. Bounded on purpose, which is why it is
     *  the console's history and not anybody's ledger. */
    async usage(ctx: PluginContext): Promise<MountUsage[]> {
      // The shared window: every machine's sessions, each naming its machine when not the default.
      return usageOf(asBoxState(await ctx.db.get(BOX_STORE, BOX_KEY)));
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
    async release(ctx: PluginContext, opts?: { reason?: "idle"; id?: string }): Promise<Released | Released[] | false> {
      // Which machines: the one whose box the framework named (the idle pass acts on one thing at a
      // time, each on its own clock), or every one the mount has (an operator releasing the mount, a
      // benchmark, a settled turn without a lease). An id that names no machine now names nothing to
      // release: the box it meant is already gone or was replaced.
      const mount = await readMount(ctx);
      const targets = boxedMachines(mount).filter((n) => !opts?.id || mount!.machines[n]!.boxId === opts.id);
      const facts: Released[] = [];
      const errors: string[] = [];
      // One after another, each to the end: a machine that would not go must not keep the next from going.
      for (const machine of targets) {
        try {
          const fact = await releaseMachine(ctx, machine, opts?.reason, lease);
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
  },
  /** `run_js` and `shell` may only have STARTED the work; see `Backgrounding`. */
  background: {
    /** One look at the execution, with no waiting and nothing written. */
    async poll(handle, ctx) {
      const cfg = cfgOf(ctx);
      const h = handle as { boxId?: string; execId?: string; machine?: string };
      if (!h?.execId) throw new Error("not an execution handle");
      const api = apiFor(cfg, ctx);
      const rec = await api("GET", `/projects/${cfg.project}/workspace/execs/${h.execId}`);
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
      const api = apiFor(cfg, ctx);
      const path = `/projects/${cfg.project}/workspace/execs/${h.execId}`;
      let why: string;
      try {
        await api("POST", `${path}/kill`);
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
        state = String((await api("GET", path)).state);
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
    summary: "run9 access and secret keys, as JSON.",
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
      { name: "ak", summary: "run9 access key, from the run9 console." },
      { name: "sk", summary: "run9 secret key, issued with the access key." },
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
    { name: "provider", type: "string", choices: ["run9"], default: "run9",
      summary: "Which sandbox provider runs the container. Only run9 today." },
    { name: "image", type: "string", summary: "Container image to start from.",
      default: DEFAULTS.image },
    { name: "workdir", type: "string", summary: "Where scripts run and npm installs land. They must match, or Node resolves modules from somewhere npm did not install to.", default: "/work" },
    { name: "shape", type: "string", summary: "Machine size, e.g. 2c4g. Larger costs more per second." },
    { name: "shell", type: "string", summary: "Shell the shell tool runs commands in.", default: "/bin/sh" },
    { name: "shellPrefix", type: "string", summary: "Prepended to every shell command — for images whose toolchain lives in an environment a plain shell never enters." },
    { name: "network", type: "string", choices: ["open", "none"], default: "open",
      summary: "\"open\" or \"none\". With none every command runs in an empty network namespace: no route out, not even DNS." },
    { name: "timeoutMs", type: "number", summary: "How long one request to the provider may take.", default: 120000 },
    { name: "graceMs", type: "number", default: 5000,
      summary: "How long a command may run before it is handed over as a background job. Short commands still answer in the call; longer ones return a job and the agent carries on." },
    { name: "maxOutputBytes", type: "number", summary: "Output longer than this is cut and the rest discarded, not kept anywhere. A command whose output matters should write it to a file and save that.", default: 24000 },
    { name: "accounts", type: "string", choices: ["all", "none"], default: DEFAULTS.accounts,
      summary: "\"all\" lets tools in the container act as this agent's other accounts: every mount whose plugin can (GitHub: gh and git) and that holds a credential. The container holds a placeholder that run9 swaps for the credential only on requests to that service's hosts, so nothing in it can read the credential. \"none\" turns this off." },
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
  tools: [
    {
      name: "run",
      summary:
        "LAST RESORT for JavaScript. Prefer an ordinary code block, which is instant and free; this " +
        "starts a container that is billed for every second it exists, and it cannot call your other " +
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
        "machine (builds, tests, git). " + defaultImageSentence(DEFAULTS.image) + " An operator may have configured a " +
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
        "diff — the moment it exists, not at the end. " + notAReasonToRelease(lease),
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
      name: "keep",
      summary:
        "Save this container's filesystem under a name, so a later task can start from it instead " +
        "of installing everything again. Use it once the environment is set up — interpreter, " +
        "packages, a cloned repository — not for the results, which belong in `save`. The " +
        "container keeps running; the snapshot is independent of it. " + notAReasonToRelease(lease),
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
      summary: lease
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
      summary: lease
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
      summary:
        "List this mount's machines: each one's name, whether it is running or switched off, its image, " +
        "when it was created and last used, and when it will be switched off or deleted if nothing uses it. " +
        "Reads the record only; starts, wakes and bills nothing.",
      parameters: { type: "object", properties: {} },
      sideEffects: "read",
      idempotency: "native",
    },
  ],


  /**
   * Does this key work, asked when a person pastes it rather than when an
   * agent needs it.
   *
   * Listing the project's boxes is the cheapest authenticated call run9 has,
   * and it checks the two things that are actually wrong when a run9 mount is
   * wrong: the keys, and whether the configured project exists. A 401 and a
   * missing project are different mistakes with the same symptom otherwise —
   * the agent's first command failing — and a person who has just pasted a key
   * cannot tell them apart from that.
   *
   * It names the project as the account, because that is the thing these keys
   * grant and the thing a person can recognise on the page.
   */
  async checkCredential(ctx) {
    if (!ctx.credential) return { ok: false as const, kind: "rejected" as const, reason: "no keys: this mount cannot start a container" };
    const cfg = { ...DEFAULTS, ...(ctx.publicConfig as SandboxConfig) };
    let cred: Run9Credential;
    try {
      cred = JSON.parse(ctx.credential) as Run9Credential;
    } catch {
      return { ok: false as const, kind: "rejected" as const, reason: "the stored value is not JSON; run9 needs an object with ak and sk" };
    }
    if (!cred.ak || !cred.sk) {
      return { ok: false as const, kind: "rejected" as const, reason: "run9 needs both ak and sk; one of them is missing" };
    }
    try {
      // The endpoint answers for itself when it is not the provider.
      //
      // Once our own service sits in front, the mount holds a token we issued,
      // and asking run9 about it proves nothing: the provider has never seen
      // it. Worse, passing the question through would make the service answer
      // whether an id the caller does not own exists, which is the thing it was
      // put there to refuse.
      if (cfg.verifyWith === "endpoint") {
        const res = await fetch(`${cfg.endpoint}/credential`, {
          headers: { authorization: "Basic " + btoa(`${cred.ak}:${cred.sk}`) },
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (res.ok) return { ok: true as const, account: cfg.project };
        const said = (await res.text()).slice(0, 200);
        if (res.status === 401 || res.status === 403) {
          return { ok: false as const, kind: "rejected" as const, reason: "this key was not accepted" };
        }
        // Anything else is the service having trouble, not a verdict on the key:
        // the difference `checkCredential` exists to keep (#45).
        return { ok: false as const, kind: "unreachable" as const, reason: `the sandbox service answered ${res.status}: ${said.slice(0, 120)}` };
      }
      // Asks about one box that cannot exist, rather than listing the project.
      //
      // Verifying a key by listing every box means the answer to "does this key
      // work" arrives with everyone else's containers attached — under a shared
      // account that is every other tenant's. Nothing here read that list, but
      // the boundary was our filter rather than their refusal (cody, 2026-09-12,
      // `57b93840`),
      // and a broker in front of run9 would refuse this call outright, so the
      // narrow question is also the one that keeps working.
      //
      // Measured against the live API, like the statuses below, because the
      // first version of this file guessed and was wrong:
      //
      //   keys good, box absent   400  {"error":"box not found"}      ← reached and authorised
      //   keys bad                401  {"error":"invalid api key"}
      //   project absent          400  {"error":"project not found"}
      const res = await fetch(
        `${cfg.endpoint}/projects/${cfg.project}/workspace/boxes/b_credential_check_only`, {
          headers: { authorization: "Basic " + btoa(`${cred.ak}:${cred.sk}`) },
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
      if (res.ok) return { ok: true as const, account: cfg.project };
      const body = (await res.text()).slice(0, 200);
      // The box is not there because nothing by that name ever is: reaching
      // that answer means the keys were accepted and the project exists, which
      // is the whole question.
      if (/box not found/i.test(body)) return { ok: true as const, account: cfg.project };
      // Status alone cannot separate a bad key from a bad project name — both
      // arrive as 400 — so the body is what decides, and the name rule is
      // quoted from run9's own message: project_cid must match [a-z0-9_-]{3,20}.
      if (res.status === 401 || res.status === 403) {
        return { ok: false as const, kind: "rejected" as const, reason: "run9 rejected these keys" };
      }
      if (/project not found/i.test(body)) {
        return { ok: false as const, kind: "rejected" as const, reason: `the keys work, but project "${cfg.project}" does not exist` };
      }
      if (/project_cid must match/i.test(body)) {
        return {
          ok: false as const,
          kind: "rejected" as const,
          reason: `"${cfg.project}" is not a usable project name: run9 wants 3 to 20 characters of a-z, 0-9, dash or underscore`,
        };
      }
      // Reached but with no verdict: a 500 says nothing about the keys.
      return { ok: false as const, kind: "unreachable" as const, reason: `run9 answered ${res.status}: ${body.slice(0, 120)}` };
    } catch (e) {
      // Nothing answered — a timeout, a refused connection, DNS. No verdict.
      return { ok: false as const, kind: "unreachable" as const, reason: String((e as Error)?.message ?? e) };
    }
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
      const after = await readView(ctx, machine);
      await writeView(ctx, machine, { ...after, startFrom: env.snapId });
      return {
        startingFrom: env.name, ...named,
        note: machine === MAIN_MACHINE
          ? "the next run or shell starts from this environment"
          : `the next run or shell on machine "${machine}" starts from this environment`,
        released: !!released,
        // The kernel reads this by name; `released` above is the model's
        // boolean and stays what it was.
        ...(released ? { [LEASE_KEY]: released.lease } : {}),
        ...(released ? { releasedPrevious: released.boxId } : {}),
      };
    }
    const cfg = { ...DEFAULTS, ...(ctx.publicConfig as SandboxConfig) };

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
        ...(parkedAt(prior) !== null ? { note: "it stays switched off; this postpones its deletion" } : {}),
      };
    }

    if (!ctx.credential) throw new Error("run9 mount has no credential");
    const cred = JSON.parse(ctx.credential) as Run9Credential;
    const auth = "Basic " + btoa(`${cred.ak}:${cred.sk}`);

    const api = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(cfg.endpoint + path, {
        method,
        headers: { authorization: auth, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      const text = await res.text();
      let parsed: any = text;
      try { parsed = JSON.parse(text); } catch { /* plain text error */ }
      if (!res.ok) throw new Error(`run9 ${method} ${path} -> ${res.status}: ${String(text).slice(0, 200)}`);
      return parsed;
    };

    // One box per machine, remembered, so an install survives to the next call.
    let state: BoxState | null = await readView(ctx, machine);
    // An emptied record keeps the session history and what was kept, but has no box.
    const history = state.sessions ?? [];
    const kept = state.envs ?? [];
    if (!state.boxId) state = null;
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
      // Named machines put their name in the id, inside the same length as before: run9's ids are the
      // project's, and two machines of one agent created in one millisecond must still differ.
      const owner = `h-${ctx.caller.tenantId}-${ctx.caller.agentId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      const boxId = (machine === MAIN_MACHINE ? owner.slice(0, 40) : `${owner.slice(0, 39 - machine.length)}-${machine}`)
        + `-${Date.now().toString(36)}`;
      // `state` is null in this branch by construction — the line above nulls an
      // emptied record, and `start_from` writes exactly that — so the value can
      // only come from the record read at the top of this call. `BoxState`
      // declares the field, so there is nothing here to cast around either.
      const from = prior.startFrom;
      // What every result will report this container as: the setting, or the
      // image the kept environment itself started from. Unknown stays unknown.
      const image = from ? kept.find((e) => e.snapId === from)?.image : cfg.image;
      // The agent's other accounts this container acts as (`SandboxForm`). Asked
      // at creation because run9 registers credentials per box, and read again
      // before every later command (reconcileAccounts).
      const want = await accountsWanted(ctx, cfg);
      try {
        await api("POST", `/projects/${cfg.project}/workspace/boxes`, {
          box_id: boxId,
          // An environment kept earlier, or the bare image. Starting from a
          // snapshot is the whole point of having kept one.
          ...(from ? { source_snap_id: from } : { source_image_ref: cfg.image }),
          // Injection happens on run9's egress proxy, which only exists in
          // managed mode. Measured: under `normal` the placeholder goes out
          // unchanged, which would look like a working credential and not be one.
          ...(want.wire.length ? { network_mode: "managed" } : {}),
          ...(cfg.shape ? { desired_shape: cfg.shape } : {}),
          description: `antiproton ${ctx.caller.tenantId}/${ctx.caller.agentId}`,
        });
      } catch (e) {
        // Seen twice in one benchmark run: run9 answered 400 "already exists"
        // (once as its own database's duplicate-key error) for an id this call
        // had just minted. The box existed; only the answer was lost. Throwing
        // here failed the agent's first command and leaked the box, since no
        // record of it was ever written. If the box is there, it is ours.
        if (!/already exists|duplicate key/i.test(String(e))) throw e;
        const boxes = await api("GET", `/projects/${cfg.project}/workspace/boxes`);
        if (!(Array.isArray(boxes) && boxes.some((b: any) => b.box_id === boxId))) throw e;
      }
      // Recorded before anything else can fail: the box exists and is billed, so
      // a registration that throws must not leave it with no record naming it.
      // The record gains each placeholder only once run9 has accepted it.
      state = {
        boxId, createdAt: Date.now(), lastUsedAt: Date.now(), execs: 0, saved: [],
        sessions: history,
        ...(image ? { image } : {}),
        ...(kept.length ? { envs: kept } : {}),
      };
      await writeView(ctx, machine, state);
      // The value never enters the box and never reaches the model: only the
      // placeholder does, and run9 swaps it in on the way out.
      // `envs` above: release carries them over because a snapshot outlives its
      // box, and a new record written without them erased the list on the next
      // container's first command, stranding the snapshots in run9.
      state = await reconcileAccounts(ctx, cfg, state, api, want, machine);
      await writeView(ctx, machine, state);
    }

    // A box the idle lease switched off starts again on the next exec on its id, disk intact, so it is reused
    // rather than replaced. Recorded as running before the command goes out: from here it bills compute again,
    // so it has to be back on the short idle schedule even if this call fails. A new compute session starts
    // (the last one was recorded when it was switched off), and a postponement of its deletion does not carry
    // over to hold off switching it off. `save` included: reading a file out of a stopped box may start it.
    if (!created && parkedAt(state) !== null && (tool === "run" || tool === "shell" || tool === "save")) {
      const { parkedAt: _p, quietUntil: _q, ...running } = state;
      const t = Date.now();
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
      const url = `${cfg.endpoint}/projects/${cfg.project}/workspace/boxes/${state!.boxId}` +
        `/files/download?box_abs_path=${encodeURIComponent(path)}${archive ? "&archive=tar" : ""}`;
      const res = await fetch(url, {
        headers: { authorization: auth }, signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (!res.ok) {
        throw new Error(`could not read ${path}: ${res.status} ${(await res.text()).slice(0, 160)}`);
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
      // run9 will not fork a box's filesystem while the box is awake: "the Box
      // must already be stopped with persistence settled; this operation never
      // stops it implicitly". So stop, fork, and let the next call wake it —
      // waking preserves the filesystem, so the agent does not lose its machine
      // by keeping a copy of it.
      await api("POST", `/projects/${cfg.project}/workspace/boxes/${state!.boxId}/stop`);
      const box = (await api("GET", `/projects/${cfg.project}/workspace/boxes`))
        .find((b: any) => b.box_id === state!.boxId);
      const source = box?.box_snap_id;
      if (!source) throw new Error("the container reports no filesystem to keep");
      const forked = await api("POST", `/projects/${cfg.project}/workspace/snaps/${source}/fork`, {
        description: `antiproton ${ctx.caller.tenantId}/${ctx.caller.agentId} ${name}`,
      });
      const snapId = forked?.snap_id;
      if (!snapId) throw new Error(`fork returned no snapshot: ${JSON.stringify(forked).slice(0, 160)}`);
      const env: Env = {
        name, snapId, savedAt: Date.now(),
        ...(state!.image ? { image: state!.image } : {}),
        ...(typeof (args as any)?.note === "string" ? { note: String((args as any).note).slice(0, 200) } : {}),
      };
      const envs = [env, ...(state!.envs ?? []).filter((e) => e.name !== name)].slice(0, 20);
      state = { ...state!, envs, lastUsedAt: Date.now() };
      await writeView(ctx, machine, state);
      return {
        kept: name, snapshot: snapId, ...named,
        note: keptNote(lease),
      };
    }

    if (tool === "save") {
      const r = await saveOut(String((args as any)?.path ?? ""), (args as any)?.archive === true);
      return { ...r, note: savedNote(lease) };
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
        : { released: false, box: r.boxId, ...named, error: r.error, saved: kept, [LEASE_KEY]: r.lease };
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
    const start = async (argv: string[], workdir: string | null) => (await api(
      "POST", `/projects/${cfg.project}/workspace/boxes/${state!.boxId}/background-execs`,
      { command: argv, ...(workdir ? { workdir } : {}) },
    )).exec_id as string;
    // The box just created was wired from the mount a moment ago; any other is checked again.
    if (!created) state = await reconcileAccounts(ctx, cfg, state!, api, await accountsWanted(ctx, cfg), machine);
    let execId = await start(execArgv(cfg, command, envFor(state)), startIn);
    let movedFrom: string | null = null;

    // The work has begun. From here the call may finish it or hand it over,
    // and both have to produce the same thing — `finished` is that thing, in
    // one place, because a result built twice is two rules about one shape
    // and they drift (the lesson of #291).
    const afterStart: BoxState = { ...state, lastUsedAt: Date.now(), execs: (state.execs ?? 0) + 1 };
    await writeView(ctx, machine, afterStart);

    const grace = Date.now() + cfg.graceMs;
    for (;;) {
      const rec = await api("GET", `/projects/${cfg.project}/workspace/execs/${execId}`);
      // run9 does not start an exec in a directory that is gone (it may have been
      // removed, or lived under /tmp, which does not survive an idle box).
      // A directory the agent named is its own answer: say it does not exist
      // rather than run the command somewhere it did not ask for.
      if (rec.state === "error" && askedDir && /failed to start/i.test(String(rec.reason ?? ""))) {
        return {
          ...finished(rec, cfg, state, machine),
          note: `${askedDir} does not exist in the container; create it first, or leave workdir out`,
        };
      }
      // A remembered one that vanished: once, start again in the working directory, and say so.
      if (rec.state === "error" && startIn && !askedDir && !movedFrom && /failed to start/i.test(String(rec.reason ?? ""))) {
        movedFrom = startIn;
        execId = await start(execArgv(cfg, withCwdTrailer(`mkdir -p ${wd} && cd ${wd} || exit 1\n${a.command}`), envFor(state)), null);
        continue;
      }
      if (TERMINAL.includes(rec.state)) {
        const result = finished(rec, cfg, state, machine);
        // Only the call that ran the command writes the directory: a job finished
        // later through the poll must not write the box record (see pollBackground),
        // so a command handed over does not move the shell, as `&` would not.
        const cwd = tool === "shell" ? splitCwd(String(rec.output_summary ?? "")).cwd : null;
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
}
