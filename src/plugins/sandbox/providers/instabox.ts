import type { CredentialCheck } from "../../types.ts";
import { ProviderError } from "../provider.ts";
import type {
  BoxSpec, BoxState, EgressSecret, ExecStatus, ProviderErrorCode, ProviderSettings, SandboxBackend, SandboxProvider, Within,
} from "../provider.ts";

/**
 * InstaBox (https://instabox.sh), behind the sandbox plugin's provider interface: every request the plugin makes
 * to InstaBox, and every reading of what it answers, is in this file. API reference: https://api.instabox.sh/v1/openapi.json
 * and https://instabox.sh/llms-full.txt; behaviour measured live is in the comments where it is relied on.
 *
 * - Auth is `X-API-Key`. Lifecycle calls (create, suspend, resume, start, stop, delete, snapshot) take an
 *   `Idempotency-Key` and answer with an operation, which is waited on with `GET /v1/operations/{id}?wait=`.
 * - InstaBox mints the machine id (`m_...`); the plugin's own name for a box goes in as the machine's `name` and
 *   the create's idempotency key, and the box carries labels (`metadata`) it can be found again by.
 * - `POST /exec` blocks until the command ends, has no idempotency key, and a retry runs the command again, so it
 *   is never retried here except after `409 machine_not_running`, which InstaBox answers before running anything.
 * - There is no background exec and no kill endpoint. A command is started detached by a short exec that
 *   redirects its output to a file in the job's directory, and polled and killed by further execs (`LAUNCH`).
 * - Files are read only with `GET /files/content`, which runs as the box's user. `GET /files` reads as root
 *   (measured 2026-10-26: it returned /etc/shadow, which `/files/content` refused with 403).
 */

interface InstaboxCredential { apiKey: string }

export const INSTABOX_ENDPOINT = "https://api.instabox.sh";

/** Waits the adapter makes between attempts; replaceable so a suite does not sleep for real. */
export const instaboxTiming = {
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
};

/** How long a create may keep asking after `no_capacity` or a rate limit before it gives up. */
const CREATE_BUDGET_MS = 180_000;
/** How long one lifecycle operation is waited for. A create was measured ready in 5-15 s, the others in 1-5 s. */
const OP_BUDGET_MS = 180_000;
/** How long a live snapshot is waited for; measured ready in 5-8 s. */
const SNAPSHOT_BUDGET_MS = 300_000;
/** Output a poll hands back whole; past it the head and the tail, as run9 does with a long output. */
export const JOB_OUTPUT_MAX = 256 * 1024;
/** Where a detached command's files live: under HOME (/data/home), which survives a stop, unlike /tmp. */
const JOBS = ".antiproton/jobs";

/**
 * Starts `$@` detached: its own session (`setsid`), so the exec's end does not take it down, with stdin, stdout and
 * stderr all away from the exec, which otherwise stays open until the command ends (measured 2026-10-26: a
 * background child holding stdout kept exec open for its full 30 s). The wrapper writes the exit code to `rc`
 * (renamed into place, so a reader sees all of it or none); `pid` is the session's leader, so its process group
 * is the job. A working directory that cannot be entered is recorded as `nostart`, in run9's words for the same.
 */
export const LAUNCH = 'd=$1; w=$2; shift 2; mkdir -p -- "$d" || exit 90; ' +
  'if [ -n "$w" ] && ! cd -- "$w" 2>/dev/null; then ' +
  "printf 'failed to start: chdir %s: no such file or directory\\n' \"$w\" > \"$d/nostart\"; exit 0; fi; " +
  'setsid nohup sh -c \'d=$1; shift; "$@"; echo $? > "$d/rc.tmp"; mv -f "$d/rc.tmp" "$d/rc"\' ap-job "$d" "$@" ' +
  '> "$d/out" 2>&1 < /dev/null & echo $! > "$d/pid"';

/**
 * One look at a job: its state on the first line, then for a finished one the output's size and the output.
 * Liveness is `/proc/<pid>`, not `kill -0`, which fails with EPERM for a process of another user and would read
 * a live job as gone. `rc` is read again after the process is found gone, since the wrapper writes it last.
 */
export const POLL = 'd=$1; m=$2; [ -d "$d" ] || { echo missing; exit 0; }; ' +
  'if [ -f "$d/nostart" ]; then echo nostart; cat "$d/nostart"; exit 0; fi; ' +
  'p=$(cat "$d/pid" 2>/dev/null); ' +
  'if [ -f "$d/rc" ]; then echo "rc $(cat "$d/rc")"; ' +
  'elif [ -n "$p" ] && [ -d "/proc/$p" ]; then echo running; exit 0; ' +
  'elif [ -f "$d/rc" ]; then echo "rc $(cat "$d/rc")"; ' +
  'elif [ -f "$d/killed" ]; then echo killed; ' +
  'else echo lost; fi; ' +
  's=$(stat -c %s "$d/out" 2>/dev/null || echo 0); echo "size $s"; ' +
  'if [ "$s" -le "$m" ]; then cat "$d/out" 2>/dev/null; else h=$((m/2)); head -c "$h" "$d/out"; ' +
  "printf '\\n... (%s bytes omitted) ...\\n' $((s-m)); tail -c \"$h\" \"$d/out\"; fi";

/**
 * Ends a job: TERM to its process group, then KILL to what is left after about two seconds. `killed` is written
 * first, so a poll that finds the process gone and no exit code reads it as cancelled rather than lost. Through
 * `sudo -n` first, because a job may have changed user; plain `kill` where sudo is not there.
 */
export const KILL = 'd=$1; p=$(cat "$d/pid" 2>/dev/null) || exit 3; [ -f "$d/rc" ] && exit 0; : > "$d/killed"; ' +
  'k() { sudo -n kill "$@" 2>/dev/null || kill "$@" 2>/dev/null; }; ' +
  'k -TERM -- "-$p"; i=0; while [ -d "/proc/$p" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done; ' +
  'k -KILL -- "-$p"; exit 0';

/** A directory as a tar under HOME, for `download` with `archive`; the path of the tar on stdout. */
const TAR = 't="$HOME/.antiproton/save-$2.tar"; mkdir -p "$HOME/.antiproton" && ' +
  'tar -cf "$t" -C "$(dirname -- "$1")" -- "$(basename -- "$1")" && printf %s "$t"';

/** InstaBox's machine states, in the plugin's vocabulary. */
export function boxStateOf(state: unknown): BoxState {
  switch (String(state)) {
    case "running": return "running";
    case "creating": case "starting": case "resuming": return "starting";
    case "suspending": case "suspended": return "paused";
    case "deleting": case "deleted": return "gone";
    default: return "stopped";
  }
}

/** The error envelope `{error: {code, message, retryable, retryAfterSeconds}}`, or null when the body is not one. */
function envelopeOf(text: string): { code: string; message: string; retryAfterSeconds?: number } | null {
  try {
    const e = JSON.parse(text)?.error;
    if (e && typeof e.code === "string") return { code: e.code, message: String(e.message ?? ""), ...(typeof e.retryAfterSeconds === "number" ? { retryAfterSeconds: e.retryAfterSeconds } : {}) };
  } catch { /* not JSON: an HTML gateway page, or nothing */ }
  return null;
}

/**
 * What kind of refusal an answer is. By InstaBox's own code where the body carries one (the codes measured are in
 * instabox.md); a body that is not the envelope (a 502 from a gateway, measured once) is trouble, not a verdict.
 */
export function codeOf(status: number, code: string | null): ProviderErrorCode {
  if (code === "machine_not_running") return "not_running";
  if (code === "no_capacity") return "no_capacity";
  if (code === "rate_limited" || code === "quota_exceeded" || status === 429) return "rate_limited";
  if (code === "machine_cooldown") return "transient";
  if (code === null || status >= 500 || status === 408) return "transient";
  if (status === 401 || ["missing_key", "malformed_key", "invalid_key"].includes(code)) return "auth";
  if (status === 404) return "not_found";
  if (code === "operation_conflict" || code === "idempotency_conflict") return "conflict";
  return "refused";
}

/** A refusal a retry will not change: a 4xx other than 408, 409 and 429, as for run9. */
const definitiveStatus = (status: number) => status >= 400 && status < 500 && ![408, 409, 429].includes(status);

function refusal(what: string, status: number, text: string, retryAfterHeader: string | null): ProviderError {
  const env = envelopeOf(text);
  const afterS = env?.retryAfterSeconds ?? (retryAfterHeader && /^\d+$/.test(retryAfterHeader) ? Number(retryAfterHeader) : undefined);
  const said = env ? `${env.code}: ${env.message}` : text.slice(0, 200);
  return new ProviderError(`InstaBox ${what} -> ${status}: ${said.slice(0, 200)}`, {
    code: codeOf(status, env?.code ?? null), definitive: env !== null && definitiveStatus(status), status, detail: text,
    ...(afterS !== undefined ? { retryAfterMs: afterS * 1000 } : {}),
  });
}

function parseCredential(credential: string): InstaboxCredential {
  const c = JSON.parse(credential) as Partial<InstaboxCredential>;
  if (typeof c?.apiKey !== "string" || !c.apiKey) throw new Error("the stored credential has no InstaBox apiKey");
  return { apiKey: c.apiKey };
}

/** `2c4g` as InstaBox's size fields; null when it is not that form. */
export function shapeOf(shape: string | undefined): { vcpus: number; memMiB: number } | null {
  const m = /^(\d+)c(\d+)g$/.exec(String(shape ?? ""));
  return m ? { vcpus: Number(m[1]), memMiB: Number(m[2]) * 1024 } : null;
}

const randomTag = () => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The one caller every request goes through. JSON in and out, a refusal thrown as a `ProviderError` reading
 * `InstaBox {method} {path} -> {status}: {code}: {message}`. With a `deadline` the operation shares, a request
 * that would start past it is not sent.
 */
function caller(settings: ProviderSettings, apiKey: string) {
  const base = settings.endpoint || INSTABOX_ENDPOINT;
  const send = (method: string, path: string, o: { body?: string | Uint8Array<ArrayBuffer>; headers?: Record<string, string>; timeoutMs: number }) =>
    fetch(base + path, {
      method,
      headers: { "x-api-key": apiKey, ...(o.headers ?? {}) },
      body: o.body,
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  const api = async (method: string, path: string, body?: unknown, o: Within & { idem?: string; headers?: Record<string, string> } = {}): Promise<any> => {
    let timeoutMs = o.timeoutMs ?? settings.timeoutMs;
    if (o.deadline !== undefined) {
      timeoutMs = o.deadline - Date.now();
      if (timeoutMs <= 0) throw new ProviderError(`InstaBox ${method} ${path}: ran out of time`, { code: "transient", definitive: false });
    }
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (o.idem) headers["idempotency-key"] = o.idem;
    const res = await send(method, path, { body: body === undefined ? undefined : JSON.stringify(body), headers, timeoutMs });
    const text = await res.text();
    if (!res.ok) throw refusal(`${method} ${path.split("?")[0]}`, res.status, text, res.headers.get("retry-after"));
    if (!text) return null;
    try { return JSON.parse(text); } catch {
      throw new ProviderError(`InstaBox ${method} ${path.split("?")[0]} -> ${res.status}: an answer that is not JSON`, { code: "transient", definitive: false, status: res.status, detail: text });
    }
  };
  return { send, api };
}

function open(settings: ProviderSettings, credential: string, o: { wake?: boolean } = {}): SandboxProvider {
  const { apiKey } = parseCredential(credential);
  const { send, api } = caller(settings, apiKey);
  const wakeOnUse = o.wake !== false;
  const m = (id: string) => `/v1/machines/${encodeURIComponent(id)}`;

  /** An operation to its end: `succeeded`, or a `ProviderError` with the operation's own error code. */
  const waitOp = async (op: any, what: string, budgetMs = OP_BUDGET_MS): Promise<any> => {
    const until = Date.now() + budgetMs;
    let cur = op;
    for (;;) {
      if (cur?.state === "succeeded") return cur;
      if (cur?.state === "failed") {
        const e = cur.error ?? {};
        const code = typeof e.code === "string" ? e.code : null;
        throw new ProviderError(`InstaBox ${what} failed: ${code ?? "error"}: ${String(e.message ?? "").slice(0, 160)}`, {
          code: code ? codeOf(code === "no_capacity" ? 503 : 409, code) : "transient", definitive: false, detail: JSON.stringify(e),
          ...(typeof e.retryAfterSeconds === "number" ? { retryAfterMs: e.retryAfterSeconds * 1000 } : {}),
        });
      }
      if (!cur?.id) throw new ProviderError(`InstaBox ${what}: no operation to wait for`, { code: "transient", definitive: false, detail: JSON.stringify(cur) });
      if (Date.now() > until) {
        throw new ProviderError(`InstaBox ${what} was still ${cur.state} (${cur.phase ?? ""}) after ${Math.round(budgetMs / 1000)} s`, { code: "transient", definitive: false });
      }
      cur = await api("GET", `/v1/operations/${encodeURIComponent(cur.id)}?wait=25s`, undefined, { timeoutMs: 40_000 });
    }
  };

  /** A lifecycle call: its operation, waited on. */
  const lifecycle = async (id: string, verb: string, body?: unknown) =>
    waitOp(await api("POST", `${m(id)}/${verb}`, body, { idem: `${verb}-${id}-${Date.now().toString(36)}-${randomTag()}` }), `${verb} of ${id}`);

  const machine = async (id: string, within?: Within) => api("GET", m(id), undefined, within);

  /** A paused or stopped box running again: `resume` for a paused one, `start` for a stopped one. */
  const wake = async (id: string) => {
    for (let i = 0; i < 60; i++) {
      const state = boxStateOf((await machine(id)).state);
      if (state === "running") return;
      if (state === "gone") throw new ProviderError(`InstaBox machine ${id} is gone`, { code: "not_found", definitive: true });
      if (state === "paused" || state === "stopped") {
        try {
          await lifecycle(id, state === "paused" ? "resume" : "start");
        } catch (e) {
          // Another operation on the machine (its own idle pause, say) is a reason to look again, not a verdict.
          if (!(e instanceof ProviderError && e.code === "conflict")) throw e;
        }
      }
      await instaboxTiming.sleep(1000);
    }
    throw new ProviderError(`InstaBox machine ${id} did not come back to running`, { code: "transient", definitive: false });
  };

  /**
   * A request that needs the box running. `machine_not_running` is answered before anything runs, so the request
   * is made once more after the box is woken; that is the only retry an exec ever gets. InstaBox pauses an idle
   * box on its own schedule, which is how a box the plugin records as running can be found paused.
   */
  const running = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    try { return await fn(); } catch (e) {
      if (!wakeOnUse || !(e instanceof ProviderError && e.code === "not_running")) throw e;
      await wake(id);
      return fn();
    }
  };

  const exec = (id: string, argv: string[], within?: Within & { timeoutSeconds?: number }) =>
    running(id, () => api("POST", `${m(id)}/exec`, { argv, timeoutSeconds: within?.timeoutSeconds ?? 60 }, within)) as
      Promise<{ stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean }>;

  /** `m_.../jobid` -> both halves. */
  const jobOf = (execId: string) => {
    const at = execId.indexOf("/");
    if (at <= 0) throw new ProviderError(`not an InstaBox job handle: ${execId}`, { code: "refused", definitive: true });
    const id = execId.slice(0, at), job = execId.slice(at + 1);
    if (!/^[A-Za-z0-9_-]+$/.test(job)) throw new ProviderError(`not an InstaBox job handle: ${execId}`, { code: "refused", definitive: true });
    return { id, dir: `$HOME/${JOBS}/${job}`, job };
  };
  /** The job's directory as the scripts get it: HOME is expanded in the box, so it goes through `sh -c`. */
  const inJob = (script: string, dir: string, ...rest: string[]) => ["sh", "-c", `set -- "${dir}" "$@"; ${script}`, "ap", ...rest];

  const provider: SandboxProvider = {
    async create(spec: BoxSpec) {
      const size = spec.fromSnapshot ? null : shapeOf(spec.shape ?? settings.shape);
      const lifetime = Math.max(1, Math.min(24, Number(settings.maxLifetimeHours ?? 24)));
      const body = {
        name: spec.id,
        // A box from a snapshot gets the snapshot's size; naming one there is not what InstaBox documents.
        ...(spec.fromSnapshot ? { snapshotId: spec.fromSnapshot } : { templateId: settings.template || "universal" }),
        ...(size ? size : {}),
        metadata: spec.labels,
        // Server-side backstops against a box nothing will release: deleted after this long whatever its state
        // (86400 s is the most InstaBox takes), and paused after running this long without a break.
        deleteAfterSeconds: Math.round(lifetime * 3600),
        maxRunMinutes: Math.max(1, Math.round(Number(settings.maxRunMinutes ?? 480))),
        // Refused at once when no host has room, rather than accepted and failed later: nothing is created then.
        failFast: true,
        // No credential of the org's reaches the box (see `caps.boxSecrets`).
        secrets: [], envSecrets: [], vault: false,
      };
      const until = Date.now() + CREATE_BUDGET_MS;
      // The key stays the same while a request may have been taken (a gateway error, an answer that does not
      // read), so asking again cannot make a second machine. A refusal that created nothing (no room, a rate limit)
      // or a failed operation could be answered again from its key with the same refusal, so the next attempt
      // after one of those gets a key of its own.
      let spent = 0;
      for (;;) {
        const key = spent === 0 ? `create-${spec.id}` : `create-${spec.id}-${spent}`;
        let op: any;
        try {
          op = await api("POST", "/v1/machines", body, { idem: key });
          const done = await waitOp(op, `create of ${spec.id}`);
          const deleteAt = Date.parse(String(done.machine?.deleteAt ?? ""));
          return { id: String(done.machineId ?? op.machineId), ...(Number.isFinite(deleteAt) ? { deleteAt } : {}) };
        } catch (e) {
          if (!(e instanceof ProviderError)) throw e;
          if (op || e.code === "no_capacity" || e.code === "rate_limited") spent += 1;
          // A failed create from a template is deleted by InstaBox; one from a snapshot with storage stays,
          // stopped, and would be a box nobody records. Deleted here, best effort.
          // A create whose operation was still running when the wait ended may yet finish: deleted too.
          if (op?.machineId && (spec.fromSnapshot || e.code === "transient")) await provider.delete(String(op.machineId)).catch(() => {});
          const again = e.code === "no_capacity" || e.code === "rate_limited" || (e.code === "transient" && !op);
          const wait = e.retryAfterMs ?? (e.code === "transient" ? 2_000 : 30_000);
          if (!again || Date.now() + wait > until) throw e;
          await instaboxTiming.sleep(wait);
        }
      }
    },

    /** The box with this name among those carrying the spec's labels: never a listing of the whole account. */
    async adopt(spec: BoxSpec) {
      const found = (await provider.list!(spec.labels)).find((b) => b.name === spec.id && b.state !== "gone");
      return found ? found.id : null;
    },

    async status(id: string, within?: Within): Promise<BoxState> {
      try {
        return boxStateOf((await machine(id, within)).state);
      } catch (e) {
        if (e instanceof ProviderError && e.code === "not_found") return "gone";
        throw e;
      }
    },

    async execBackground(id, req, within) {
      const job = `j${Date.now().toString(36)}${randomTag()}`;
      const dir = `$HOME/${JOBS}/${job}`;
      const r = await exec(id, inJob(LAUNCH, dir, req.workdir ?? "", ...req.argv), within);
      if (r.exitCode !== 0) {
        throw new ProviderError(`InstaBox could not start the command: exit ${r.exitCode} ${String(r.stderr ?? "").slice(0, 160)}`,
          { code: "transient", definitive: false });
      }
      return `${id}/${job}`;
    },

    async poll(execId: string, within?: Within): Promise<ExecStatus> {
      const { id, dir } = jobOf(execId);
      const r = await exec(id, inJob(POLL, dir, String(JOB_OUTPUT_MAX)), within);
      const out = String(r.stdout ?? "");
      const nl = out.indexOf("\n");
      const head = nl < 0 ? out : out.slice(0, nl);
      const rest = nl < 0 ? "" : out.slice(nl + 1);
      if (head === "running") return { state: "running", exitCode: null, output: "", reason: null, couldNotStart: false };
      if (head === "nostart") return { state: "error", exitCode: null, output: "", reason: rest.trim(), couldNotStart: true };
      if (head === "missing") {
        return { state: "error", exitCode: null, output: "", reason: "the job's record is not on the machine", couldNotStart: false };
      }
      const sized = /^size \d+\n?/.exec(rest);
      const output = sized ? rest.slice(sized[0].length) : rest;
      const rc = /^rc (\d+)$/.exec(head);
      if (rc) {
        const code = Number(rc[1]);
        return { state: code === 0 ? "succeeded" : "failed", exitCode: code, output, reason: null, couldNotStart: false };
      }
      if (head === "killed") return { state: "cancelled", exitCode: null, output, reason: "explicit_cancel", couldNotStart: false };
      return {
        state: "error", exitCode: null, output,
        reason: "the command ended without reporting an exit code: the machine was stopped or restarted while it ran",
        couldNotStart: false,
      };
    },

    async kill(execId: string) {
      const { id, dir } = jobOf(execId);
      const r = await exec(id, inJob(KILL, dir));
      if (r.exitCode === 3) throw new ProviderError(`InstaBox job ${execId} is not on the machine`, { code: "not_found", definitive: true });
      if (r.exitCode !== 0) throw new ProviderError(`InstaBox could not kill ${execId}: exit ${r.exitCode}`, { code: "transient", definitive: false });
    },

    async upload(id: string, path: string, bytes: Uint8Array) {
      await running(id, async () => {
        const res = await send("PUT", `${m(id)}/files?path=${encodeURIComponent(path)}&parents=true`, {
          body: bytes as Uint8Array<ArrayBuffer>, headers: { "content-type": "application/octet-stream" }, timeoutMs: settings.timeoutMs,
        });
        const text = await res.text();
        if (!res.ok) throw refusal(`upload to ${path}`, res.status, text, res.headers.get("retry-after"));
      });
    },

    async download(id: string, path: string, o: { archive?: boolean; timeoutMs: number }): Promise<Response> {
      const get = async (p: string) => running(id, async () => {
        const res = await send("GET", `${m(id)}/files/content?path=${encodeURIComponent(p)}`, { timeoutMs: o.timeoutMs });
        if (!res.ok) {
          const text = await res.text();
          throw refusal(`download of ${p}`, res.status, text, res.headers.get("retry-after"));
        }
        return res;
      });
      if (!o.archive) return get(path);
      // No archive route: the directory is put in a tar in the box, read back, and the tar removed.
      const tag = randomTag();
      const made = await exec(id, ["sh", "-c", TAR, "ap", path, tag], { timeoutSeconds: 600 });
      if (made.exitCode !== 0) {
        throw new ProviderError(`InstaBox could not make a tar of ${path}: exit ${made.exitCode} ${String(made.stderr ?? "").slice(0, 160)}`,
          { code: "refused", definitive: true, status: 404, detail: String(made.stderr ?? "") });
      }
      const tar = String(made.stdout ?? "");
      try {
        const res = await get(tar);
        return new Response(new Uint8Array(await res.arrayBuffer()), { status: 200 });
      } finally {
        await exec(id, ["rm", "-f", "--", tar]).catch(() => {});
      }
    },

    /** Stop keeps both disks; /tmp and processes are lost (measured). A paused box is resumed first: InstaBox refuses to stop one. */
    async stop(id: string) {
      const state = await provider.status(id);
      if (state === "stopped") return;
      if (state === "paused") await lifecycle(id, "resume");
      await lifecycle(id, "stop", { timeoutSeconds: 10 });
    },

    /** Suspend keeps memory and processes (measured: resume in 1.4-2 s, the same PID still running). */
    async pause(id: string) {
      try {
        await lifecycle(id, "suspend");
      } catch (e) {
        // Already paused (InstaBox's own idle pause got there first) or stopped is what was asked for.
        if (e instanceof ProviderError && (e.code === "conflict" || e.code === "not_running")) {
          const state = await provider.status(id);
          if (state === "paused" || state === "stopped") return;
        }
        throw e;
      }
    },

    async wake(id: string) {
      await wake(id);
    },

    /** Deleted with the machine's own id as the confirmation, so a wrong id deletes nothing (409, measured). */
    async delete(id: string) {
      const op = await api("DELETE", m(id), undefined, {
        idem: `delete-${id}-${Date.now().toString(36)}-${randomTag()}`, headers: { "x-confirm-delete": id }, timeoutMs: 30_000,
      });
      await waitOp(op, `delete of ${id}`);
    },

    /** A live snapshot: the box keeps running (measured 2026-10-26, ready in 5-8 s, processes intact). */
    async snapshot(id: string, description: string) {
      const name = `ap-${Date.now().toString(36)}-${randomTag()}`;
      let snap = await running(id, () => api("POST", `${m(id)}/snapshots`, { name, description: description.slice(0, 200) }, { idem: name }));
      const until = Date.now() + SNAPSHOT_BUDGET_MS;
      while (snap?.status === "pending") {
        if (Date.now() > until) throw new ProviderError(`InstaBox snapshot ${snap.id} was still pending after ${SNAPSHOT_BUDGET_MS / 1000} s`, { code: "transient", definitive: false });
        await instaboxTiming.sleep(1000);
        snap = await api("GET", `/v1/snapshots/${encodeURIComponent(snap.id)}`);
      }
      if (snap?.status !== "ready" || typeof snap.id !== "string") {
        throw new ProviderError(`InstaBox snapshot did not complete: ${snap?.status ?? "no answer"} ${String(snap?.error ?? "").slice(0, 160)}`, { code: "transient", definitive: false });
      }
      return snap.id as string;
    },

    async deleteSnapshot(snapId: string) {
      try {
        await api("DELETE", `/v1/snapshots/${encodeURIComponent(snapId)}`, undefined, {
          idem: `delete-${snapId}-${Date.now().toString(36)}-${randomTag()}`, headers: { "x-confirm-delete": snapId },
        });
      } catch (e) {
        if (e instanceof ProviderError && e.code === "not_found") return;
        throw e;
      }
    },

    async list(labels: Record<string, string>) {
      const terms = Object.entries(labels).map(([k, v]) => `metadata=${encodeURIComponent(`${k}:${v}`)}`);
      if (!terms.length) throw new Error("listing InstaBox machines needs at least one label: the whole account is never listed");
      const out: Array<{ id: string; name: string; state: BoxState; labels: Record<string, string> }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 50; page++) {
        const got: any = await api("GET", `/v1/machines?${[...terms, ...(cursor ? [`cursor=${encodeURIComponent(cursor)}`] : [])].join("&")}`);
        for (const x of Array.isArray(got?.machines) ? got.machines : []) {
          const meta = (x?.metadata ?? {}) as Record<string, string>;
          // Checked again here: a server that ignored the filter must not hand back another tenant's machine.
          if (Object.entries(labels).every(([k, v]) => meta[k] === v)) {
            out.push({ id: String(x.id), name: String(x.name ?? ""), state: boxStateOf(x.state), labels: meta });
          }
        }
        cursor = typeof got?.nextCursor === "string" && got.nextCursor ? got.nextCursor : null;
        if (!cursor) break;
      }
      return out;
    },

    async usage(id: string) {
      const u = await api("GET", `${m(id)}/usage`);
      return {
        runningSeconds: Number(u?.runningSeconds ?? 0), vcpuSeconds: Number(u?.vcpuSeconds ?? 0),
        memGiBSeconds: Number(u?.memGiBSeconds ?? 0), diskGiBSeconds: Number(u?.diskGiBSeconds ?? 0),
      };
    },

    // InstaBox's credential injection is by org-wide secret (`PUT /v1/orgs/{id}/secrets/{name}`), not per box.
    // The plugin does not wire accounts on this provider (`caps.boxSecrets`), so these are never called.
    async addSecret(_id: string, _s: EgressSecret) { throw noBoxSecrets(); },
    async listSecrets(_id: string) { return []; },
    async removeSecret(_id: string, _secretId: unknown) { throw noBoxSecrets(); },
  };
  return provider;
}

const noBoxSecrets = () => new ProviderError("InstaBox has no per-machine credentials", { code: "refused", definitive: true });

/** Who these keys are: `GET /v1/me`, the one call any key may make. */
async function me(settings: ProviderSettings, credential: string): Promise<Response> {
  const { apiKey } = parseCredential(credential);
  return caller(settings, apiKey).send("GET", "/v1/me", { timeoutMs: settings.timeoutMs });
}

async function checkCredential(settings: ProviderSettings, credential: string): Promise<CredentialCheck> {
  try { parseCredential(credential); } catch {
    return { ok: false as const, kind: "rejected" as const, reason: "InstaBox needs an object with apiKey, as JSON" };
  }
  try {
    const res = await me(settings, credential);
    const text = await res.text();
    if (res.ok) {
      let body: any = null;
      try { body = JSON.parse(text); } catch { /* judged below */ }
      const account = accountOf(body);
      return account ? { ok: true as const, account } : { ok: false as const, kind: "unreachable" as const, reason: "InstaBox answered /v1/me without saying who this is" };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false as const, kind: "rejected" as const, reason: `InstaBox rejected this key: ${envelopeOf(text)?.code ?? res.status}` };
    }
    return { ok: false as const, kind: "unreachable" as const, reason: `InstaBox answered ${res.status}: ${text.slice(0, 120)}` };
  } catch (e) {
    return { ok: false as const, kind: "unreachable" as const, reason: String((e as Error)?.message ?? e) };
  }
}

/**
 * The account a key acts on: a workspace key's org (`orgId`), else the user, whose personal org every machine it
 * creates goes into. Two keys of one user reach the same machines; each key has no id of its own here.
 */
function accountOf(body: any): string | null {
  if (typeof body?.orgId === "string" && body.orgId) return `instabox:${body.orgId}`;
  if (typeof body?.userId === "number" || (typeof body?.userId === "string" && body.userId)) return `instabox:user:${body.userId}`;
  return null;
}

async function account(settings: ProviderSettings, credential: string): Promise<string | null> {
  try { parseCredential(credential); } catch { return null; }
  // A network failure throws through: nobody answered, which is not "no account".
  const res = await me(settings, credential);
  if (res.status >= 500 || [408, 409, 429].includes(res.status)) throw new Error(`InstaBox answered ${res.status} to /v1/me`);
  if (!res.ok) return null;
  return accountOf(await res.json().catch(() => null));
}

export const instabox: SandboxBackend = {
  id: "instabox",
  name: "InstaBox",
  caps: {
    pause: "memory",
    snapshot: "live",
    backgroundExec: "emulated",
    publicPorts: true,
    egressPolicy: false,
    // From InstaBox pricing (https://instabox.sh/llms-full.txt): runtime per second while running; a paused or
    // stopped machine pays storage only.
    billing: "running",
    // `usage()` reads InstaBox's own meter, but held time is still the plugin's estimate until metering reads it.
    usageMeter: "estimate",
    boxSecrets: false,
  },
  // Commands run as the box's user (uid 1000), not root, so `unshare -n` alone is refused. A user namespace that
  // maps that user to itself gives the empty network namespace without sudo and leaves the uid the same.
  isolateNetwork: ["unshare", "--user", "--map-current-user", "--net", "--"],
  open,
  checkCredential,
  account,
};
