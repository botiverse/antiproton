import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext, MountActivity, MountUsage } from "./types.ts";
import { backgrounded } from "./types.ts";
import type { R2Artifacts } from "../store/artifacts.ts";
import { toAgentRef } from "../store/refs.ts";

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
 * The box is per mount and kept in connection state, so a package installed by
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
  /** Ceiling on one `quiet` request, in minutes. */
  maxQuietMinutes?: number;
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
   * Credentials the container may use but not read. Declares the shape only —
   * the values come from the mount's own credential.
   */
  secrets?: InjectedSecret[];
}

interface Run9Credential {
  ak: string;
  sk: string;
  /** Values for the injected secrets the mount declares, by name. Here rather
   *  than in publicConfig because publicConfig is not a secret: it is shown in
   *  the console and derived from configuration the operator can read. */
  secrets?: Record<string, string>;
}

/**
 * A credential the container may use without ever holding.
 *
 * run9 substitutes the real value into a named header on the way out, and only
 * for the hosts listed — so a shell in the box writes the placeholder, the far
 * end receives the credential, and the agent never sees it. That is the same
 * bargain the gateway makes, enforced at run9's egress instead.
 *
 * Measured, because the documentation for it is a 404: injection happens only
 * under `network_mode: "managed"`; `inject_header_name` is required; and a
 * placeholder is unique across the project, so it is qualified per box.
 */
interface InjectedSecret {
  /** Key in the mount's credential holding the value. */
  name: string;
  /** Header the value is injected into, e.g. "authorization". */
  header: string;
  /** Hosts it may be sent to. Everything else keeps the placeholder. */
  hosts: string[];
}
/** A saved filesystem, under a name the agent chose rather than an id. */
interface Env { name: string; snapId: string; savedAt: number; note?: string }

/** Placeholders handed to the agent for this box, by credential name. */
type Placeholders = Record<string, string>;

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
}

/**
 * The mount's connection state. `sessions` is what makes the meter readable:
 * a container is the most expensive thing here and the only one billed for
 * simply existing, so how long each one lived is worth keeping even after it
 * is gone.
 */
interface BoxState {
  boxId: string;
  createdAt: number;
  lastUsedAt: number;
  /** What the agent may write; never the values behind them. */
  placeholders?: Placeholders;
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
   * whatever holds the provider's key rather than here (cody, 2026-09-12).
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
   * The directory the last `shell` command ended in, so the next one starts
   * there. Each run9 exec is a fresh process: a `cd` does not carry over, and
   * agents were writing `cd /testbed && …` into every call (tygg, 2026-09-15).
   * Absent on a new box, where the first call starts in the working directory.
   */
  cwd?: string;
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
 * Vera's probe: nine containers for one agent, `uses: 1` each, 3.3–9.5 s
 * apiece, and the model quoted this line back while watching the box id change
 * under it.
 *
 * So the lifetime it states is the one the agent can actually use — every call
 * in this turn — and it names what outlives the turn instead, which is a kept
 * filesystem.
 *
 * With the lease on (tygg, 2026-09-15: a container is destroyed by the agent's
 * own `release`, not by the end of a turn; the agent is told before an idle one
 * is taken and may postpone that) the runtime hands the plugin the lease and
 * the sentence names that lifetime instead. The numbers come from the lease,
 * never from here.
 */
export interface BoxLease {
  /** How long before the release the agent is told. */
  warnMs: number;
  /** Idle this long and the box is released, unless the agent postponed it. */
  maxMs: number;
}

const leaseMinutes = (ms: number) => Math.max(1, Math.round(ms / 60_000));

/**
 * What happens to an idle box under a lease, said once for the reminder, `run` and `shell`.
 *
 * "Files survive" is true of the box's root disk, not of /tmp. In a run9 box /tmp is a tmpfs; measured on
 * production on 2026-09-15, a marker in /tmp was gone after 18 idle minutes while one in /work (the default
 * working directory) was still there, in the same box, with no reboot in between. An agent that writes its
 * work to /tmp and comes back after a pause would find it missing, so the sentence says where to keep it.
 */
export function leaseTerms(lease: BoxLease): string {
  return `after ${leaseMinutes(lease.maxMs)} idle minutes it is released; ${leaseMinutes(lease.warnMs)} minutes `
    + `before that you are told, and \`quiet\` postpones the release by as long as you choose, within the mount's limit; `
    + `files under /tmp do not survive while it sits idle, so keep your work in the working directory`;
}

export function boxReminder(alias: string, lease: BoxLease | null = null): string {
  if (lease) {
    return `every call uses this same container, in this turn and later ones, until you release it; ${leaseTerms(lease)}`
      + `; \`keep\` on \`${alias}\` saves its filesystem beyond that, and \`release\` destroys it now`;
  }
  return `every call in this turn uses this same container, and it is handed back when the turn ends`
    + `; \`keep\` on \`${alias}\` saves its filesystem for a later turn, and \`release\` destroys it now`;
}

/**
 * The stored state, or null when what came back is not it.
 *
 * `ConnectionState` hands back `Json`, which is `unknown` — so `as BoxState`
 * was never a narrowing, it was an assertion the compiler cannot check, on
 * data that outlives the code that wrote it. The risk is not a mistyped call
 * site; it is this call site reading a row written by an older version, which
 * is exactly what a generic parameter would hide (Rex, 2026-09-12).
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
  alias: string,
  lease: BoxLease | null = null,
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
    // "container", never "sandbox": the harness already calls the per-execution
    // JavaScript isolate a sandbox, and an agent told that "the sandbox keeps
    // nothing between executions" concluded this box was volatile too — which
    // would have it reinstalling packages on every call.
    reminder: boxReminder(alias, lease),
    ...execOutput(out, cfg.maxOutputBytes),
    box: state?.boxId ?? null,
    // So the agent learns the environment from a result it already has,
    // instead of spending turns probing for an interpreter.
    image: cfg.image,
    ...(state?.envs?.length ? { kept: state.envs.map((e) => e.name) } : {}),
    ...(state?.placeholders && Object.keys(state.placeholders).length
      ? {
          credentials: Object.entries(state.placeholders).map(([name, ph]) => ({
            name, writeThis: ph,
            toHosts: (cfg.secrets ?? []).find((d) => d.name === name)?.hosts ?? [],
            header: (cfg.secrets ?? []).find((d) => d.name === name)?.header,
          })),
          note: "write the placeholder where the credential would go; it is substituted " +
            "on the way out, only for those hosts. You cannot read the value, and neither " +
            "can anything running in this container.",
        }
      : {}),
  };
}

export function asBoxState(v: Json): BoxState | null {
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
  // field ships `undefined` into the console's usage report (Rex, 2026-09-12
  // for the lists, 2026-09-15 for what is in them).
  const { sessions, envs, ...rest } = o;
  return {
    ...(rest as unknown as BoxState),
    ...(Array.isArray(sessions) ? { sessions: sessions.filter(isSession) } : {}),
    ...(Array.isArray(envs) ? { envs: envs.filter(isEnv) } : {}),
  };
}

function isSession(v: unknown): v is Session {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return typeof s.boxId === "string" && typeof s.startedAt === "number"
    && typeof s.endedAt === "number" && typeof s.lastUsedAt === "number"
    && typeof s.execs === "number"
    && Array.isArray(s.saved) && s.saved.every((x) => typeof x === "string");
}

function isEnv(v: unknown): v is Env {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e.name === "string" && typeof e.snapId === "string"
    && typeof e.savedAt === "number" && (e.note === undefined || typeof e.note === "string");
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
  endpoint: "https://api.run.sys9.ai",
  image: "public.ecr.aws/docker/library/node:22-alpine",
  project: "default",
  timeoutMs: 120_000,
  graceMs: 5_000,
  maxOutputBytes: 24_000,
  maxQuietMinutes: 60,
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
  ctx: PluginContext,
): Promise<{ boxId: string; freed: boolean; error?: string; liveMs: number } | null> {
  const state = asBoxState(await ctx.connection.get());
  if (!state?.boxId || !ctx.credential) return null;
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
  const session = sessionOf(state, Date.now());
  await ctx.connection.set({
    boxId: "", createdAt: 0, lastUsedAt: 0,
    sessions: keepSessions(state.sessions, session),
    // Kept environments outlive the container by construction — a forked
    // snapshot is independent of the box it came from — so losing the record of
    // them here would strand real storage under ids nobody can name any more.
    ...(state.envs?.length ? { envs: state.envs } : {}),
  } as unknown as Json);
  return { boxId: state.boxId, freed: !error, error, liveMs: session.endedAt - session.startedAt };
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
export function activityOf(state: BoxState | null | undefined): MountActivity {
  const billing = "billed for every second it exists, not per call";
  if (!state?.boxId) return { live: null, billing };
  return {
    live: {
      id: state.boxId,
      startedAt: state.createdAt,
      // An unused box is idle from when it started, not from zero: the same
      // rule the release record follows, so the two agree about its age.
      lastUsedAt: state.lastUsedAt || state.createdAt,
    },
    quietUntil: state.quietUntil ?? null,
    billing,
  };
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
 * connection record, not about how much history matters — the history lives
 * where the key does.
 */
export function keepSessions(prior: Session[] | undefined, next: Session): Session[] {
  return [next, ...(prior ?? [])].slice(0, SESSIONS_KEPT);
}

export function sessionOf(
  state: { boxId: string; createdAt: number; lastUsedAt?: number; execs?: number; saved?: string[] },
  endedAt: number,
): Session {
  return {
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

export function execArgv(cfg: { shell: string; shellPrefix?: string; network?: "open" | "none" }, command: string): string[] {
  const line = cfg.shellPrefix ? `${cfg.shellPrefix}${command}` : command;
  const argv = [cfg.shell, "-lc", line];
  const open = cfg.network === undefined || cfg.network === "open";
  return open ? argv : ["unshare", "-n", "--", ...argv];
}

export function sandboxPlugin(artifacts: R2Artifacts | null, bucket: string, lease: BoxLease | null = null): Plugin {
  // `run`, `shell` and every result state the same lifetime (boxReminder): with a lease, the box stays until
  // the agent releases it or the idle ceiling takes it; without one, a settled turn hands it back.
  const runLifetime = lease
    ? "The container is NOT the per-execution sandbox: every call uses the same one, in this turn and later " +
      "ones, so installs and files survive from one call to the next — do not reinstall. It stays until you " +
      `release it; ${leaseTerms(lease)}. Work in as few calls as you can, save what matters with \`save\`, and ` +
      "release it once the machine will not be needed again. Everything inside is destroyed when it is released."
    : "The container is NOT the per-execution sandbox: every call in this " +
      "turn uses the same one, so installs and files survive from one call to the next — do not " +
      "reinstall. It is handed back when the turn ends, so a later turn starts a new container " +
      "unless you saved this one's filesystem with `keep`. Work in as few calls as you can, save " +
      "what matters with `save`, and release it. Everything inside is destroyed when it is released.";
  const shellLifetime = lease
    ? "Shell in the same billed-by-the-second container as `run`, and the same one for every call, in this " +
      "turn and later ones — state, installed packages and files carry over — until you release it; " +
      `${leaseTerms(lease)}.`
    : "Shell in the same billed-by-the-second container as `run`, and the same one for every call " +
      "in this turn — state, installed packages and files carry over from one call to the next, and " +
      "the container is handed back when the turn ends.";
  // `release` and `quiet` follow the same switch (Piper, 2026-09-15): "leave it running, it is released on its
  // own and you are told first" is true only under a lease. Without one (the SWE-bench runner, a Worker with no
  // lease settings) the container goes back when the turn ends, and there is no release to postpone. No
  // minutes here: those come from the lease, in `run`, `shell` and the reminder.
  const releaseSummary = lease
    ? "Destroy the container and everything in it, stopping the meter. Pass save to copy files out " +
      "first, in the same call. Release it when this machine will not be needed again. If you or the " +
      "person you are working for will come back to it, leave it running: an idle container is released " +
      "on its own after a while, you are told before that, and `quiet` keeps it longer. A kept " +
      "environment or a saved file is for starting a fresh machine later, not a reason to destroy one " +
      "you are about to use again."
    : "Destroy the container and everything in it, stopping the meter. Pass save to copy files out " +
      "first, in the same call. It is handed back when the turn ends anyway, so release it earlier only " +
      "when you are done with the machine before the turn is; `keep` and `save` are how work outlives the turn.";
  const quietSummary = lease
    ? "Postpone the release of this container: it is kept for at least `minutes` more from now, and " +
      "you are not told about it again until shortly before then. Use it when you are coming back to " +
      "the machine — a build you are waiting on, work you return to after reading something. It is " +
      "billed for every second either way; if you are done with it, `release` is the cheaper answer, " +
      "and it can save files out in the same call."
    : "Has no effect in this deployment: the container is handed back when the turn ends, so there is " +
      "no idle release to postpone. Use `keep` to carry an environment into a later turn.";
  return {
  id: "sandbox",
  // Seeded despite being the only metered mount: a container the agent cannot
  // reach is a task it cannot finish, and it is meant to stay unused (tygg,
  // 2026-09-12). The lease is what keeps an idle one from being free to forget.
  defaultForAllAgents: true,
  // One container per mount, created on demand — two calls at once would
  // create two, and only one of them would ever be released.
  exclusive: true,
  credential: {
    required: true,
    summary: "run9 access and secret keys, as JSON.",
    // The credential also carries `secrets`: a value per injected secret the
    // mount declares. Those names come from the `secrets` setting rather than
    // from here, so a fixed list cannot name them and this one does not try.
    // No mount injects secrets in production yet; when one does, the field
    // gains a way to say "one entry per name in that setting".
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
      default: "public.ecr.aws/docker/library/node:22-alpine" },
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
    { name: "secrets", type: "string[]", references: "credential",
      summary: "Names of secrets to inject into the container. Needs managed networking; the container can use them but never read them." },
    { name: "maxQuietMinutes", type: "number", default: 60,
      summary: "Longest a single postponement of the release may be. The quiet tool refuses a larger one rather than shortening it: an agent that asks for a day and is silently given an hour believes it has a day." },
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
        "few seconds of compute. " + runLifetime,
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "JavaScript, run with `node -e`" },
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
        "machine (builds, tests, git). The default image is node:22-alpine: Node and npm are present, " +
        "Python and gcc are NOT, and `apk add --no-cache <pkg>` installs more. An operator may " +
        "have configured a different image; every result reports which one is running, so read " +
        "that instead of probing for it. Save anything worth keeping, then release.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
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
        "diff — the moment it exists, not at the end.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "absolute path inside the box" },
          archive: { type: "boolean", description: "true to take a directory as a tar" },
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
        "container keeps running; the snapshot is independent of it and survives its release.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "short name you will recognise later, e.g. 'py-scipy'" },
          note: { type: "string", description: "one line on what is in it" },
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
        "expensive part of using one, and this is how you stop paying for it twice.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
      },
      sideEffects: "write",
      idempotency: "none",
    },
    {
      name: "release",
      summary: releaseSummary,
      parameters: {
        type: "object",
        properties: {
          save: {
            type: "array", items: { type: "string" },
            description: "absolute paths to keep before destroying the box",
          },
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
      summary: quietSummary,
      parameters: {
        type: "object",
        properties: {
          minutes: {
            type: "number",
            description: "how many more minutes to keep the container, from now; a request over the mount's limit is refused, not shortened",
          },
        },
        required: ["minutes"],
      },
      // A write: it changes when the box is released, which changes what the
      // box costs. Not idempotent, because each call moves the instant.
      sideEffects: "write",
      idempotency: "none",
    },
  ],

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
   *  below reads the mount's connection state and never looks at the caller's
   *  task. */
  async release(ctx: PluginContext): Promise<boolean> {
    const r = await stopBox(ctx);
    if (r === null) return false;
    // A container is the one thing here billed for merely existing, so a
    // release that did not release has to say so. stopBox has reported this
    // since the day thirteen boxes were found alive; nothing was listening.
    if (!r.freed) throw new Error(`run9 box ${r.boxId} not released: ${r.error ?? "unknown"}`);
    return true;
  },

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
      // put there to refuse (cody, 2026-09-12).
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
      // the boundary was our filter rather than their refusal (cody, 2026-09-12),
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

  /** What this mount is keeping alive, read from its own state and nothing
   *  else: no credential, no call to run9. */
  async activity(ctx: PluginContext): Promise<MountActivity> {
    return activityOf(asBoxState(await ctx.connection.get()));
  },

  /** The window this mount still holds. Bounded on purpose, which is why it is
   *  the console's history and not anybody's ledger. */
  async usage(ctx: PluginContext): Promise<MountUsage[]> {
    return usageOf(asBoxState(await ctx.connection.get()));
  },

  async invoke(tool: string, args: Json, ctx: PluginContext): Promise<Json> {
    // Checked before anything else: neither releasing nor choosing an
    // environment should be the thing that starts a container.
    const prior = asBoxState(await ctx.connection.get());
    if (tool === "release" && !prior?.boxId) {
      return { released: false, note: "nothing was running" };
    }

    if (tool === "start_from") {
      const envs = prior?.envs ?? [];
      const want = String((args as any)?.name ?? "");
      if (!want) {
        // `released: false` because the summary promised a release and this
        // call is the one that does not perform it — a model reading
        // `{kept: [], note}` alone cannot tell whether its container was just
        // taken away (Vera, 2026-09-14). Every ending of this tool now says so
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
      const released = prior?.boxId ? await stopBox(ctx) : null;
      const after = asBoxState(await ctx.connection.get());
      await ctx.connection.set({ ...(after ?? { boxId: "", createdAt: 0, lastUsedAt: 0 }),
        startFrom: env.snapId } as unknown as Json);
      return {
        startingFrom: env.name, note: "the next run or shell starts from this environment",
        released: !!released,
        ...(released ? { releasedPrevious: released.boxId } : {}),
      };
    }
    const cfg = { ...DEFAULTS, ...(ctx.publicConfig as SandboxConfig) };

    // Before the credential check on purpose: postponing a release calls
    // nothing at run9, so a mount whose key was removed can still answer it.
    if (tool === "quiet") {
      const cap = cfg.maxQuietMinutes ?? DEFAULTS.maxQuietMinutes;
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
          `Ask for ${cap} or fewer, or release the container — it is billed for every second either way.`,
        );
      }
      if (!prior?.boxId) return { quiet: false, note: "nothing is running, so there is no release to postpone" };
      const quietUntil = Date.now() + asked * 60_000;
      // The postponement is its own instant, and `lastUsedAt` is deliberately
      // NOT touched, unlike every other handler here: the idle pass keeps the box
      // until the later of the two (idle-lease.ts `releaseAt`), and the page can
      // still tell "used" from "kept by request". Postponing is not using the
      // machine. There is no total cap: each postponement is a call the agent
      // chose to make, within this mount's limit (tygg, 2026-09-15).
      await ctx.connection.set({ ...prior, quietUntil } as unknown as Json);
      return { quiet: true, box: prior.boxId, minutes: asked, until: new Date(quietUntil).toISOString() };
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

    // One box per mount, remembered, so an install survives to the next call.
    let state = asBoxState(await ctx.connection.get());
    // An emptied record keeps the session history but has no box.
    const history = state?.sessions ?? [];
    if (state && !state.boxId) state = null;
    if (!state) {
      const boxId = `h-${ctx.caller.tenantId}-${ctx.caller.agentId}`
        .toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) + `-${Date.now().toString(36)}`;
      // `state` is null in this branch by construction — the line above nulls an
      // emptied record, and `start_from` writes exactly that — so the value can
      // only come from the record read at the top of this call. `BoxState`
      // declares the field, so there is nothing here to cast around either.
      const from = prior?.startFrom;
      const declared = cfg.secrets ?? [];
      // Before the box exists, because after it exists a throw leaks it.
      //
      // A declared secret with no value used to be skipped. The box came up,
      // the placeholder was never registered, and the agent wrote a string
      // run9 had never heard of — so a half-filled credential surfaced as the
      // far end rejecting the request, which points at everything except the
      // mount. Saying it here costs nothing and names the actual mistake.
      const missing = declared.filter((d) => !cred.secrets?.[d.name]);
      if (missing.length) {
        throw new Error(
          `run9 mount declares ${missing.map((d) => `"${d.name}"`).join(", ")} in its secrets ` +
          `setting, and the credential carries no value for ${missing.length > 1 ? "them" : "it"}`,
        );
      }
      try {
        await api("POST", `/projects/${cfg.project}/workspace/boxes`, {
          box_id: boxId,
          // An environment kept earlier, or the bare image. Starting from a
          // snapshot is the whole point of having kept one.
          ...(from ? { source_snap_id: from } : { source_image_ref: cfg.image }),
          // Injection happens on run9's egress proxy, which only exists in
          // managed mode. Measured: under `normal` the placeholder goes out
          // unchanged, which would look like a working credential and not be one.
          ...(declared.length ? { network_mode: "managed" } : {}),
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
      // Register the declared credentials against the new box. The value never
      // enters the box and never reaches the model: only the placeholder does.
      const placeholders: Placeholders = {};
      for (const d of declared) {
        const value = cred.secrets![d.name]!;
        // Qualified by box, because a placeholder is unique across the project
        // and two agents would otherwise collide on the same name.
        const placeholder = `__AP_${d.name}_${boxId.slice(-8)}__`;
        await api("POST", `/projects/${cfg.project}/workspace/boxes/${boxId}/secrets`, {
          name: d.name, value, placeholder,
          inject_header_name: d.header, allowed_hosts: d.hosts,
        });
        placeholders[d.name] = placeholder;
      }
      state = {
        boxId, createdAt: Date.now(), lastUsedAt: Date.now(), execs: 0, saved: [],
        sessions: history,
        ...(Object.keys(placeholders).length ? { placeholders } : {}),
      };
      await ctx.connection.set(state as unknown as Json);
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
      // then never open it again (cody, 2026-09-13). `..` at the root stays at
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
      // (tygg, 2026-09-14).
      const shown = toAgentRef(stored.ref, ctx.caller) ?? stored.ref;
      state = { ...state!, saved: [...(state!.saved ?? []), shown], lastUsedAt: Date.now() };
      await ctx.connection.set(state as unknown as Json);
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
        ...(typeof (args as any)?.note === "string" ? { note: String((args as any).note).slice(0, 200) } : {}),
      };
      const envs = [env, ...(state!.envs ?? []).filter((e) => e.name !== name)].slice(0, 20);
      state = { ...state!, envs, lastUsedAt: Date.now() };
      await ctx.connection.set(state as unknown as Json);
      return {
        kept: name, snapshot: snapId,
        note: "independent of this container and survives its release; " +
          "start a later one from it with `start_from`",
      };
    }

    if (tool === "save") {
      const r = await saveOut(String((args as any)?.path ?? ""), (args as any)?.archive === true);
      return { ...r, note: "kept outside the box; it survives release" };
    }

    if (tool === "release") {
      // Saving first, in the same call, so "keep this and hand the machine
      // back" does not depend on the agent remembering to do it in two.
      const kept: unknown[] = [];
      for (const path of ((args as any)?.save ?? []) as string[]) {
        kept.push(await saveOut(path, false));
      }
      const r = await stopBox(ctx);
      if (!r) return { released: false, note: "nothing was running", saved: kept };
      return r.freed
        ? { released: true, box: r.boxId, liveMs: r.liveMs, saved: kept,
            note: "the container and its files are gone; anything saved above is not" }
        : { released: false, box: r.boxId, error: r.error, saved: kept };
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
      // An explicit `workdir` (tygg, 2026-09-15) runs this one command there; a
      // relative one is taken from where the shell is now.
      command = (askedDir ?? state.cwd) ? withCwdTrailer(a.command) : withCwdTrailer(`mkdir -p ${wd} && cd ${wd} || exit 1\n${a.command}`);
    } else {
      throw new Error(`unknown tool: ${tool}`);
    }

    // Started on run9's *background* route, not the plain one, because that is
    // the only kind of execution run9 will kill: `POST /execs/{id}/kill` on an
    // execution created here answers 400 `exec is not background mode`, and the
    // command runs to completion regardless. Measured on a box of our own
    // (Piper, 2026-09-14): a foreground `sleep 45 && echo … > /tmp/fg-probe`
    // was killed, answered 400, finished `succeeded` and wrote its file; the
    // same command started here was killed with 200, went to `cancelled
    // (explicit_cancel)`, and its file never appeared. That is the whole of the
    // defect Vera reproduced — a job refused by the cap kept running, unlisted
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
    let execId = await start(execArgv(cfg, command), startIn);
    let movedFrom: string | null = null;

    // The work has begun. From here the call may finish it or hand it over,
    // and both have to produce the same thing — `finished` is that thing, in
    // one place, because a result built twice is two rules about one shape
    // and they drift (the lesson of #291).
    const afterStart: BoxState = { ...state, lastUsedAt: Date.now(), execs: (state.execs ?? 0) + 1 };
    await ctx.connection.set(afterStart as unknown as Json);

    const grace = Date.now() + cfg.graceMs;
    for (;;) {
      const rec = await api("GET", `/projects/${cfg.project}/workspace/execs/${execId}`);
      // run9 does not start an exec in a directory that is gone (it may have been
      // removed, or lived under /tmp, which does not survive an idle box).
      // A directory the agent named is its own answer: say it does not exist
      // rather than run the command somewhere it did not ask for.
      if (rec.state === "error" && askedDir && /failed to start/i.test(String(rec.reason ?? ""))) {
        return {
          ...finished(rec, cfg, state, ctx.alias, lease),
          note: `${askedDir} does not exist in the container; create it first, or leave workdir out`,
        };
      }
      // A remembered one that vanished: once, start again in the working directory, and say so.
      if (rec.state === "error" && startIn && !askedDir && !movedFrom && /failed to start/i.test(String(rec.reason ?? ""))) {
        movedFrom = startIn;
        execId = await start(execArgv(cfg, withCwdTrailer(`mkdir -p ${wd} && cd ${wd} || exit 1\n${a.command}`)), null);
        continue;
      }
      if (TERMINAL.includes(rec.state)) {
        const result = finished(rec, cfg, state, ctx.alias, lease);
        // Only the call that ran the command writes the directory: a job finished
        // later through the poll must not write connection state (see pollBackground),
        // so a command handed over does not move the shell, as `&` would not.
        const cwd = tool === "shell" ? splitCwd(String(rec.output_summary ?? "")).cwd : null;
        const moved = movedFrom !== null && (state.cwd ?? null) !== null;
        if (tool === "shell" && (cwd ?? null) !== (state.cwd ?? null)) {
          await ctx.connection.set({ ...afterStart, cwd: cwd ?? undefined } as unknown as Json);
        }
        return moved
          ? { ...result, note: `${movedFrom} no longer exists, so this command started in ${wd}` }
          : result;
      }
      if (Date.now() > grace) {
        // Handed over rather than waited on: the turn is serialised while this
        // call is open (`exclusive`), so waiting here costs the agent every
        // other tool it might have run and every thought it might have had
        // (cody measured three quarters of billed Worker time on SWE-bench).
        // The ceiling that used to live here is the runtime's now, and so is
        // the cancelling — `timeoutMs` no longer means "how long the Worker
        // holds".
        return backgrounded(
          { boxId: state.boxId, execId },
          `running in the container; its result arrives on its own, and \`jobs\` lists what is running`,
        );
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  },

  /** One look at the execution, with no waiting and nothing written. */
  async pollBackground(handle, ctx) {
    const cfg = cfgOf(ctx);
    const h = handle as { boxId?: string; execId?: string };
    if (!h?.execId) throw new Error("not an execution handle");
    const api = apiFor(cfg, ctx);
    const rec = await api("GET", `/projects/${cfg.project}/workspace/execs/${h.execId}`);
    if (!TERMINAL.includes(rec.state)) return { done: false, progress: { state: rec.state } };
    // The box as it was when the work started: this runs outside the call, and
    // writing connection state from here would race a second job finishing at
    // the same moment — the read-modify-write `exclusive` exists to prevent,
    // in a new place (Piper, 2026-09-14).
    const state = asBoxState(await ctx.connection.get());
    return { done: true, result: finished(rec, cfg, state, ctx.alias, lease) as Json };
  },

  /**
   * Stop it and stop paying for it — and say so when it did not stop.
   *
   * The `.catch(() => {})` that used to be here decided, inside the plugin,
   * that a failed kill did not matter. It did: with three jobs running, a
   * refused fourth was cancelled through this path, the kill did not take, and
   * the command ran to completion in the container — with no job id, so
   * nothing could list it or cancel it (Vera, 2026-09-14). Both layers
   * swallowed the failure, so our ledger and the container were free to differ
   * with nobody able to notice.
   *
   * So: kill, then *confirm*. "I sent a kill" is our record; "the process is
   * gone" is the fact, and the bill follows the fact. Returning means the
   * execution is in a state that will not change again; anything else throws,
   * and the caller — which owns the ledger — decides what to record and
   * whether to ask again (cody, 2026-09-14: no retry loop here, because the
   * runtime is what keeps a refused job tracked and calls back at its ceiling).
   *
   * **A terminal state is run9's record, not the process.** That the two agree
   * — that `cancelled` means the shell is gone — is something we measured (a
   * `sleep && echo … > file` whose file never appeared: cody three times, Piper
   * once) and not something the API defines, so it can change without telling
   * us. Whoever edits this path or the one that starts an execution owes that
   * reading again; every cheaper check in the suites reads a record, and a
   * record is what was wrong the first time.
   */
  async cancelBackground(handle, ctx) {
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
    // would be passing on a claim we did not make (Vera, 2026-09-14). The two
    // are told apart by what follows the colon: run9's own answer, or `kill
    // accepted`.
    throw new Error(`could not confirm exec ${h.execId} stopped: ${why}`);
  },

  };
}
