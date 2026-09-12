import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext } from "./types.ts";
import type { R2Artifacts } from "../store/artifacts.ts";

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
export interface Run9Config {
  endpoint?: string;
  /** Any image with node on the PATH. */
  image?: string;
  project?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
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
  /** Most recent first, capped: this is a meter, not a second event log. */
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
 * Three clauses because the box now has three possible ends, and an agent that
 * knows only the first will leave work in a machine that goes away: it survives
 * calls, it is asked about when it goes quiet, and it is taken if nobody
 * answers.
 */
export function boxReminder(alias: string): string {
  return `this container persists between calls; if it goes idle you are asked whether to keep it, ` +
    `and released if nobody answers; the \`release\` tool on \`${alias}\` destroys it now`;
}

const SESSIONS_KEPT = 20;

const DEFAULTS = {
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
  const state = (await ctx.connection.get()) as BoxState | null;
  if (!state?.boxId || !ctx.credential) return null;
  const cfg = { ...DEFAULTS, ...(ctx.publicConfig as Run9Config) };
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
    sessions: [session, ...(state.sessions ?? [])].slice(0, SESSIONS_KEPT),
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

export function run9Plugin(artifacts: R2Artifacts | null, bucket: string): Plugin {
  return {
  id: "run9",
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
    { name: "image", type: "string", summary: "Container image to start from.",
      default: "public.ecr.aws/docker/library/node:22-alpine" },
    { name: "workdir", type: "string", summary: "Where scripts run and npm installs land. They must match, or Node resolves modules from somewhere npm did not install to.", default: "/work" },
    { name: "shape", type: "string", summary: "Machine size, e.g. 2c4g. Larger costs more per second." },
    { name: "shell", type: "string", summary: "Shell the shell tool runs commands in.", default: "/bin/sh" },
    { name: "shellPrefix", type: "string", summary: "Prepended to every shell command — for images whose toolchain lives in an environment a plain shell never enters." },
    { name: "network", type: "string", choices: ["open", "none"], default: "open",
      summary: "\"open\" or \"none\". With none every command runs in an empty network namespace: no route out, not even DNS." },
    { name: "timeoutMs", type: "number", summary: "How long one call may take.", default: 120000 },
    { name: "maxOutputBytes", type: "number", summary: "Output longer than this is cut and the rest discarded, not kept anywhere. A command whose output matters should write it to a file and save that.", default: 24000 },
    { name: "secrets", type: "string[]", references: "credential",
      summary: "Names of secrets to inject into the container. Needs managed networking; the container can use them but never read them." },
    { name: "maxQuietMinutes", type: "number", default: 60,
      summary: "Longest a single quiet request may last. The quiet tool refuses a larger one rather than shortening it: an agent that asks for a day and is silently given an hour believes it has a day." },
    { name: "project", type: "string", summary: "run9 project the boxes belong to.", default: "default" },
    { name: "endpoint", type: "string", summary: "API endpoint.", default: "https://api.run.sys9.ai" },
  ],
  version: "1.0.0",
  tools: [
    {
      name: "run",
      summary:
        "LAST RESORT for JavaScript. Prefer an ordinary code block, which is instant and free; this " +
        "starts a container that is billed for every second it exists, and it cannot call your other " +
        "tools. Use it only when you genuinely need npm packages, a real filesystem, or more than a " +
        "few seconds of compute. The container is NOT the per-execution sandbox: it persists between " +
        "calls until you release it or leave it idle long enough to be asked about, so installs and " +
        "files survive from one call to the next — do not " +
        "reinstall. Work in as few calls as you can, save what matters with `save`, and release it. " +
        "Everything inside is destroyed when it is released.",
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
        "Shell in the same billed-by-the-second container as `run`, and the same one across calls " +
        "until you release it or it goes idle — state, installed packages and files carry over. " +
        "Only for what needs a real " +
        "machine (builds, tests, git). The default image is node:22-alpine: Node and npm are present, " +
        "Python and gcc are NOT, and `apk add --no-cache <pkg>` installs more. An operator may " +
        "have configured a different image; every result reports which one is running, so read " +
        "that instead of probing for it. Save anything worth keeping, then release.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
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
        "Begin from an environment kept earlier instead of a bare image. Releases the current " +
        "container if there is one; the next run or shell starts from the snapshot. Call with no " +
        "name to see what has been kept. Setting up a machine is usually the slowest and most " +
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
      summary:
        "Destroy the container and everything in it, stopping the meter. Pass save to copy files out " +
        "first, in the same call. Do this as soon as you no longer need the machine — not at the end " +
        "of the task, at the end of the work that needed a machine.",
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
      summary:
        "Put off the next reminder about this container. Use it when you know you will come back to " +
        "the machine — a long download, a build you are waiting on, work you are returning to after " +
        "reading something. It does not extend anything: the container is billed for every second " +
        "either way, and the operator's ceiling still ends it. If you are not coming back, `release` " +
        "is the cheaper answer, and it can save files out in the same call.",
      parameters: {
        type: "object",
        properties: {
          minutes: {
            type: "number",
            description: "how long to stay quiet; a request over the mount's ceiling is refused, not shortened",
          },
        },
        required: ["minutes"],
      },
      // A write: it changes when the box is asked about, which changes what the
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
    const cfg = { ...DEFAULTS, ...(ctx.publicConfig as Run9Config) };
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
      const res = await fetch(`${cfg.endpoint}/projects/${cfg.project}/workspace/boxes`, {
        headers: { authorization: "Basic " + btoa(`${cred.ak}:${cred.sk}`) },
        signal: AbortSignal.timeout(cfg.timeoutMs),
      });
      if (res.ok) return { ok: true as const, account: cfg.project };
      const body = (await res.text()).slice(0, 200);
      // Measured against the live API rather than assumed, because the first
      // version of this guessed 404 for a missing project and run9 does not use
      // it — every one of these is a 400, so the status alone cannot tell a bad
      // key from a bad project name, and the body is what separates them:
      //
      //   bad keys            401  {"error":"invalid api key"}
      //   project absent      400  {"error":"project not found"}
      //   name not a name     400  {"error":"project_cid must match [a-z0-9_-]{3,20}"}
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
    // Checked before anything else: neither releasing nor choosing an
    // environment should be the thing that starts a container.
    const prior = (await ctx.connection.get()) as BoxState | null;
    if (tool === "release" && !prior?.boxId) {
      return { released: false, note: "nothing was running" };
    }

    if (tool === "start_from") {
      const envs = prior?.envs ?? [];
      const want = String((args as any)?.name ?? "");
      if (!want) {
        return {
          kept: envs.map((e) => ({ name: e.name, note: e.note, savedAt: e.savedAt })),
          note: envs.length ? "pass one of these as name" : "nothing kept yet; `keep` saves one",
        };
      }
      const env = envs.find((e) => e.name === want);
      if (!env) throw new Error(`no environment named ${want}; kept: ${envs.map((e) => e.name).join(", ") || "none"}`);
      // Releasing first, because the choice applies to the next container and
      // silently leaving the old one running is how a machine gets forgotten.
      const released = prior?.boxId ? await stopBox(ctx) : null;
      const after = (await ctx.connection.get()) as BoxState | null;
      await ctx.connection.set({ ...(after ?? { boxId: "", createdAt: 0, lastUsedAt: 0 }),
        startFrom: env.snapId } as unknown as Json);
      return {
        startingFrom: env.name, note: "the next run or shell starts from this environment",
        ...(released ? { releasedPrevious: released.boxId } : {}),
      };
    }
    const cfg = { ...DEFAULTS, ...(ctx.publicConfig as Run9Config) };

    // Before the credential check on purpose: putting off a reminder calls
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
      if (!prior?.boxId) return { quiet: false, note: "nothing is running, so nothing will be asked about" };
      const quietUntil = Date.now() + asked * 60_000;
      // `lastUsedAt` is deliberately NOT touched, unlike every other handler
      // here. It is what the absolute idle ceiling is measured from, so bumping
      // it would let an agent hold a box forever by asking for quiet again and
      // again — each request legal, each under the ceiling, and the ceiling
      // never reached. Deferring the question is not using the machine.
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
    let state = (await ctx.connection.get()) as BoxState | null;
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
      const name = path.replace(/^\//, "").replace(/[^A-Za-z0-9._/-]/g, "_") + (archive ? ".tar" : "");
      const stored = await artifacts.put(
        `t/${ctx.caller.tenantId}/${ctx.caller.agentId}/sandbox/${state!.boxId}/${name}`,
        body, archive ? "application/x-tar" : "application/octet-stream");
      state = { ...state!, saved: [...(state!.saved ?? []), stored.ref], lastUsedAt: Date.now() };
      await ctx.connection.set(state as unknown as Json);
      return { path, ref: stored.ref, bytes: body.length };
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
    const a = (args ?? {}) as { code?: string; install?: string[]; command?: string };
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
      command = `mkdir -p ${wd} && cd ${wd} && ${a.command}`;
    } else {
      throw new Error(`unknown tool: ${tool}`);
    }

    const started = await api(
      "POST", `/projects/${cfg.project}/workspace/boxes/${state.boxId}/execs`,
      { command: execArgv(cfg, command) },
    );
    const execId = started.exec_id as string;

    const deadline = Date.now() + cfg.timeoutMs;
    for (;;) {
      const rec = await api("GET", `/projects/${cfg.project}/workspace/execs/${execId}`);
      if (["succeeded", "failed", "killed", "cancelled", "timeout"].includes(rec.state)) {
        const out = String(rec.output_summary ?? "");
        await ctx.connection.set({
          ...state, lastUsedAt: Date.now(), execs: (state.execs ?? 0) + 1,
        } as unknown as Json);
        return {
          state: rec.state,
          exitCode: rec.exit_code ?? null,
          // "container", never "sandbox": the harness already calls the per-execution
          // JavaScript isolate a sandbox, and an agent told that "the sandbox keeps
          // nothing between executions" concluded this box was volatile too — which
          // would have it reinstalling packages on every call.
          reminder: boxReminder(ctx.alias),
          ...execOutput(out, cfg.maxOutputBytes),
          box: state.boxId,
          // So the agent learns the environment from a result it already has,
          // instead of spending turns probing for an interpreter.
          image: cfg.image,
          ...(state.envs?.length
            ? { kept: state.envs.map((e) => e.name) }
            : {}),
          ...(state.placeholders && Object.keys(state.placeholders).length
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
      if (Date.now() > deadline) {
        // Leaving it running would burn the tenant's quota unattended.
        await api("POST", `/projects/${cfg.project}/workspace/execs/${execId}/kill`).catch(() => {});
        throw new Error(`run9 exec ${execId} exceeded ${cfg.timeoutMs}ms and was killed`);
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
  },
  };
}
