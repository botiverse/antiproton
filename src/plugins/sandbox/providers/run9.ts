import type { CredentialCheck } from "../../types.ts";
import { ProviderError } from "../provider.ts";
import type {
  BoxSpec, BoxState, EgressSecret, ExecStatus, ProviderErrorCode, ProviderSettings, SandboxBackend, SandboxProvider, Within,
} from "../provider.ts";

/**
 * run9 (https://run.sys9.ai), behind the sandbox plugin's provider interface: every request the plugin makes to
 * run9, and every reading of what run9 answers, is in this file.
 *
 * Endpoints are under `{endpoint}/projects/{project}/workspace`, authorised with Basic `ak:sk`. A box is created
 * under an id the plugin chooses, ids are the project's (so one minted twice collides), and every command runs
 * on run9's background route, because that is the only kind of execution run9 will kill.
 */

interface Run9Credential {
  ak: string;
  sk: string;
}

/**
 * The states in which run9 says a box is awake. Its docs (https://run.sys9.ai/docs/box, read
 * 2026-10-02): "ready: the box exists, but it is not awake yet. idle: the box is awake and waiting
 * for the next exec or file transfer. running: an exec or file transfer is active." and "Boxes wake
 * when used and can sleep when idle." (https://run.sys9.ai/docs/execute-commands: "The box wakes for
 * the command. When it is idle, run9 can let it sleep."). So `idle` and `running` are awake;
 * `ready`, anything else, or a state this code has never seen is not.
 *
 * **What this cannot close.** run9 sleeps an idle box on its own schedule, which nothing here can
 * hold off, so a box listed `idle` may go to sleep in the one round trip before the read's command
 * reaches it, and that command then wakes it. Our own release cannot land there (the mount's lock
 * covers the check and the start), only run9's sleep can. run9 documents file reads that never wake
 * a box (https://run.sys9.ai/docs/file-transfer: "These commands do not start a transfer job or wake
 * a stopped box", for `sys9 run box file ls/stat/cat`), but the HTTP API behind them is not in its
 * swagger (https://api.run.sys9.ai/swagger.yaml, read 2026-10-02, has only `files/download` and
 * `files/upload`, and a `file_access_url` field without a protocol), so it is not used until it is
 * documented or measured.
 */
export const AWAKE_STATES: readonly string[] = ["idle", "running"];

/**
 * How long `upload` waits for run9 to finish the transfer it accepted. run9 answers an upload with a "prepared
 * transfer session" (swagger `uploadBoxFiles`, `DataTransferPrepareView`, https://api.run.sys9.ai/swagger.yaml
 * read 2026-10-17), which carries a `state` but no id to read it back by; the one place a transfer's progress is
 * documented is `GET /workspace/data-transfers/active` (`pending` / `running` / `succeeded` / `error` /
 * `cancelled`). So the call waits there until no upload into the box is still active, and the plugin then checks
 * the file.
 */
export const PUT_SETTLE_MS = 60_000;

/**
 * A refusal a retry will not change: a 4xx other than 408 timeout, 409 conflict and 429 rate limit, which are
 * run9 busy, not a verdict.
 */
function definitiveStatus(status: number): boolean {
  return status >= 400 && status < 500 && ![408, 409, 429].includes(status);
}

/**
 * What kind of refusal an answer is, from its status and what run9 said with it.
 *
 * run9 answers a GET for a box it does not have with 400 "box not found" (measured for `checkCredential`, which
 * relies on it); that a DELETE answers the same is assumed from that, not measured, and a 404 is read the same
 * way. "already exists" (once as its own database's duplicate-key error) is what a create of an id run9 already
 * has answers; a 409 without it is run9 busy.
 */
function codeOf(status: number, said: string): ProviderErrorCode {
  if (status === 404 || /box not found/i.test(said)) return "not_found";
  if (/already exists|duplicate key/i.test(said)) return "conflict";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 409 || status >= 500) return "transient";
  if (status >= 400) return "refused";
  return "transient";
}

const refusal = (message: string, status: number, said: string) =>
  new ProviderError(message, { code: codeOf(status, said), definitive: definitiveStatus(status), status, detail: said });

const authOf = (cred: Run9Credential) => "Basic " + btoa(`${cred.ak}:${cred.sk}`);

/**
 * The one caller every request goes through. `json` is the API's own shape — a JSON content type, a JSON body
 * when there is one, the answer parsed when it parses — and a refusal is a `ProviderError` reading
 * `run9 {method} {path} -> {status}: {what run9 said}`. Without it the request carries only the credential,
 * which is how the stop, delete, file and credential requests have always gone out, and the answer comes back
 * unread for the caller to judge.
 */
function caller(settings: ProviderSettings, auth: string) {
  const send = (method: string, path: string, o: { json?: boolean; body?: string | FormData; timeoutMs: number }) =>
    fetch(settings.endpoint + path, {
      method,
      headers: o.json ? { authorization: auth, "content-type": "application/json" } : { authorization: auth },
      body: o.body,
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  /** The JSON API. With a `deadline` the operation shares, a request that would start past it is not sent. */
  const api = async (method: string, path: string, body?: unknown, within: Within = {}): Promise<any> => {
    let timeoutMs = within.timeoutMs ?? settings.timeoutMs;
    if (within.deadline !== undefined) {
      timeoutMs = within.deadline - Date.now();
      if (timeoutMs <= 0) throw new Error(`run9 ${method} ${path}: the look ran out of time`);
    }
    const res = await send(method, path, { json: true, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
    const text = await res.text();
    let parsed: any = text;
    try { parsed = JSON.parse(text); } catch { /* plain text error */ }
    if (!res.ok) throw refusal(`run9 ${method} ${path} -> ${res.status}: ${String(text).slice(0, 200)}`, res.status, text);
    return parsed;
  };
  return { send, api };
}

/** A secrets listing as run9 answers it: a bare array of views, each with its `secret_id`. Throws on anything else. */
export function secretViews(listed: unknown, path: string): any[] {
  if (!Array.isArray(listed)) throw new Error(`run9 GET ${path}: not a list of secrets (${typeof listed === "string" ? "text" : JSON.stringify(listed)?.slice(0, 80)})`);
  for (const s of listed) {
    if (!s || typeof s !== "object" || typeof (s as any).secret_id !== "string") {
      throw new Error(`run9 GET ${path}: an entry without its secret_id (${JSON.stringify(s)?.slice(0, 80)})`);
    }
  }
  return listed;
}

function open(settings: ProviderSettings, credential: string): SandboxProvider {
  const cred = JSON.parse(credential) as Run9Credential;
  const { send, api } = caller(settings, authOf(cred));
  const ws = `/projects/${settings.project}/workspace`;
  const box = (id: string) => `${ws}/boxes/${id}`;
  const exec = (execId: string) => `${ws}/execs/${execId}`;
  return {
    async create(spec: BoxSpec) {
      await api("POST", `${ws}/boxes`, {
        box_id: spec.id,
        ...(spec.fromSnapshot ? { source_snap_id: spec.fromSnapshot } : { source_image_ref: spec.image }),
        // Injection happens on run9's egress proxy, which only exists in
        // managed mode. Measured: under `normal` the placeholder goes out
        // unchanged, which would look like a working credential and not be one.
        ...(spec.egressSecrets ? { network_mode: "managed" } : {}),
        ...(spec.shape ? { desired_shape: spec.shape } : {}),
        description: spec.description,
      });
      return { id: spec.id };
    },

    /**
     * A create answered "already exists" for an id the plugin had just minted (seen twice in one benchmark run,
     * once as run9's own database's duplicate-key error): the box is there and only the answer was lost, so it is
     * this spec's when the project lists it.
     */
    async adopt(spec: BoxSpec) {
      return (await this.status(spec.id)) === "gone" ? null : spec.id;
    },

    /**
     * From the project's list, the one read that starts nothing. The list is every box in the project, which
     * under the operator's account is every tenant's; only the one asked about is read from it.
     */
    async status(id: string, within?: Within): Promise<BoxState> {
      const boxes = await api("GET", `${ws}/boxes`, undefined, within);
      const listed = Array.isArray(boxes) ? boxes.find((x: any) => x?.box_id === id) : null;
      if (!listed) return "gone";
      return AWAKE_STATES.includes(String(listed.state)) ? "running" : "stopped";
    },

    async execBackground(id, req, within) {
      return (await api("POST", `${box(id)}/background-execs`,
        { command: req.argv, ...(req.workdir ? { workdir: req.workdir } : {}) }, within)).exec_id as string;
    },

    async poll(execId: string, within?: Within): Promise<ExecStatus> {
      const rec = await api("GET", exec(execId), undefined, within);
      return {
        state: rec.state,
        exitCode: rec.exit_code,
        output: rec.output_summary,
        reason: rec.reason,
        // run9 does not start an exec in a directory that is gone, and says so in the reason.
        couldNotStart: rec.state === "error" && /failed to start/i.test(String(rec.reason ?? "")),
      };
    },

    async kill(execId: string) {
      await api("POST", `${exec(execId)}/kill`);
    },

    async upload(id: string, path: string, bytes: Uint8Array) {
      // `box_abs_path` as a query parameter, the one place run9 accepts it for both of its upload modes.
      const form = new FormData();
      form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>]), path.split("/").at(-1) ?? "file");
      const res = await send("POST", `${box(id)}/files/upload?box_abs_path=${encodeURIComponent(path)}`,
        { body: form, timeoutMs: settings.timeoutMs });
      const text = await res.text();
      if (!res.ok) throw refusal(`run9 refused the upload to ${path}: ${res.status} ${text.slice(0, 160)}`, res.status, text);
      let view: any = null;
      try { view = JSON.parse(text); } catch { /* checked by the plugin by reading the file */ }
      const said = String(view?.state ?? "").toLowerCase();
      const failure = String(view?.failure_code ?? "");
      if (failure || ["error", "cancelled", "failed"].includes(said)) {
        throw new ProviderError(`run9 did not complete the upload to ${path}: ${[said, failure, view?.reason].filter(Boolean).join(", ")}`,
          { code: "transient", definitive: false, detail: text });
      }
      // Anything short of finished is waited for where run9 reports transfers (see `PUT_SETTLE_MS`).
      if (said === "succeeded") return;
      const settleBy = Date.now() + PUT_SETTLE_MS;
      for (;;) {
        const active = await api("GET", `${ws}/data-transfers/active?box_id=${encodeURIComponent(id)}`);
        const uploads = (Array.isArray(active) ? active : [])
          .filter((t: any) => (!t?.box_id || t.box_id === id) && t?.direction === "upload");
        const broken = uploads.find((t: any) => t?.state === "error" || t?.state === "cancelled");
        if (broken) {
          throw new ProviderError(`run9 did not complete the upload to ${path}: ${broken.state}${broken.reason ? `, ${String(broken.reason).slice(0, 120)}` : ""}`,
            { code: "transient", definitive: false });
        }
        if (!uploads.some((t: any) => t?.state !== "succeeded")) return;
        if (Date.now() > settleBy) {
          throw new ProviderError(`run9 had not finished the upload to ${path} after ${PUT_SETTLE_MS / 1000} s; ` +
            "it may still land, so check the file before using it, or put it again", { code: "transient", definitive: false });
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    },

    async download(id: string, path: string, o: { archive?: boolean; timeoutMs: number }): Promise<Response> {
      const res = await send("GET", `${box(id)}/files/download?box_abs_path=${encodeURIComponent(path)}${o.archive ? "&archive=tar" : ""}`,
        { timeoutMs: o.timeoutMs });
      if (!res.ok) {
        const text = await res.text();
        throw refusal(`run9 download of ${path} -> ${res.status}: ${text.slice(0, 160)}`, res.status, text);
      }
      return res;
    },

    /**
     * `stop` halts the runtime and keeps the box and its disk; the next exec on the same id starts it again with
     * its files (measured 2026-10-01: about two seconds, /work intact, processes gone).
     */
    async stop(id: string) {
      const res = await send("POST", `${box(id)}/stop`, { timeoutMs: 30_000 });
      if (!res.ok) {
        const said = (await res.text()).slice(0, 120);
        throw refusal(`stop returned ${res.status}: ${said}`, res.status, said);
      }
    },

    /**
     * Hand the box back for real.
     *
     * `stop` is not release: it returns 200, halts the runtime, and leaves the box
     * and its storage in place — the state stays `ready` and storage keeps being
     * billed, which is the largest component of the quota. Only `DELETE` actually
     * frees it. Stopping first is a courtesy so nothing is killed mid-write, and
     * its answer is not waited on for anything but that.
     */
    async delete(id: string) {
      await send("POST", `${box(id)}/stop`, { timeoutMs: 20_000 }).catch(() => {});
      const res = await send("DELETE", box(id), { timeoutMs: 30_000 });
      if (res.ok) return;
      const said = (await res.text()).slice(0, 120);
      throw refusal(`delete returned ${res.status}: ${said}`, res.status, said);
    },

    /**
     * run9 will not fork a box's filesystem while the box is awake: "the Box
     * must already be stopped with persistence settled; this operation never
     * stops it implicitly". So stop, fork, and let the next call wake it —
     * waking preserves the filesystem, so the agent does not lose its machine
     * by keeping a copy of it.
     */
    async snapshot(id: string, description: string) {
      await api("POST", `${box(id)}/stop`);
      const listed = (await api("GET", `${ws}/boxes`)).find((b: any) => b.box_id === id);
      const source = listed?.box_snap_id;
      if (!source) throw new Error("the container reports no filesystem to keep");
      const forked = await api("POST", `${ws}/snaps/${source}/fork`, { description });
      const snapId = forked?.snap_id;
      if (!snapId) throw new Error(`fork returned no snapshot: ${JSON.stringify(forked).slice(0, 160)}`);
      return snapId as string;
    },

    async addSecret(id: string, s: EgressSecret) {
      await api("POST", `${box(id)}/secrets`, {
        name: s.name, value: s.value, placeholder: s.placeholder,
        inject_header_name: s.header, allowed_hosts: s.hosts,
      });
    },

    // listBoxSecrets and listProjectSecrets (https://api.run.sys9.ai/swagger.yaml, read 2026-10-29, sha256
    // fa95943a…b98c1): a bare array of api.ProjectSecretView, no pagination, no wrapper. Anything else (a wrapped
    // or paged shape, a proxy's HTML) is refused rather than read as "none": a withdrawal is confirmed by an empty
    // list, so a list that could not be read must never look like one.
    async listSecrets(id: string) {
      return secretViews(await api("GET", `${box(id)}/secrets`), `${box(id)}/secrets`)
        .map((s) => ({ name: s.name, id: s.secret_id, placeholder: s.placeholder }));
    },

    async listProjectSecrets() {
      return secretViews(await api("GET", `/projects/${settings.project}/secrets`), `/projects/${settings.project}/secrets`)
        .map((s) => ({ name: s.name, id: s.secret_id, placeholder: s.placeholder, boxLabel: s.box_label ?? null, scope: s.scope ?? null }));
    },

    async removeSecret(id: string, secretId: unknown) {
      await api("DELETE", `${box(id)}/secrets/${secretId}`);
    },
  };
}

/**
 * Does this key work, asked when a person pastes it rather than when an
 * agent needs it.
 *
 * Asking about one box is the cheapest authenticated call run9 has,
 * and it checks the two things that are actually wrong when a run9 mount is
 * wrong: the keys, and whether the configured project exists. A 401 and a
 * missing project are different mistakes with the same symptom otherwise —
 * the agent's first command failing — and a person who has just pasted a key
 * cannot tell them apart from that.
 *
 * It names the project as the account, because that is the thing these keys
 * grant and the thing a person can recognise on the page.
 */
async function checkCredential(settings: ProviderSettings, credential: string): Promise<CredentialCheck> {
  let cred: Run9Credential;
  try {
    cred = JSON.parse(credential) as Run9Credential;
  } catch {
    return { ok: false as const, kind: "rejected" as const, reason: "the stored value is not JSON; run9 needs an object with ak and sk" };
  }
  if (!cred.ak || !cred.sk) {
    return { ok: false as const, kind: "rejected" as const, reason: "run9 needs both ak and sk; one of them is missing" };
  }
  const { send } = caller(settings, authOf(cred));
  try {
    // The endpoint answers for itself when it is not the provider.
    //
    // Once our own service sits in front, the mount holds a token we issued,
    // and asking run9 about it proves nothing: the provider has never seen
    // it. Worse, passing the question through would make the service answer
    // whether an id the caller does not own exists, which is the thing it was
    // put there to refuse.
    if (settings.verifyWith === "endpoint") {
      const res = await send("GET", "/credential", { timeoutMs: settings.timeoutMs });
      if (res.ok) return { ok: true as const, account: settings.project };
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
    // the boundary was our filter rather than their refusal (`57b93840`),
    // and a broker in front of run9 would refuse this call outright, so the
    // narrow question is also the one that keeps working.
    //
    // Measured against the live API, like the statuses below, because the
    // first version of this file guessed and was wrong:
    //
    //   keys good, box absent   400  {"error":"box not found"}      ← reached and authorised
    //   keys bad                401  {"error":"invalid api key"}
    //   project absent          400  {"error":"project not found"}
    const res = await send("GET", `/projects/${settings.project}/workspace/boxes/b_credential_check_only`, { timeoutMs: settings.timeoutMs });
    if (res.ok) return { ok: true as const, account: settings.project };
    const body = (await res.text()).slice(0, 200);
    // The box is not there because nothing by that name ever is: reaching
    // that answer means the keys were accepted and the project exists, which
    // is the whole question.
    if (/box not found/i.test(body)) return { ok: true as const, account: settings.project };
    // Status alone cannot separate a bad key from a bad project name — both
    // arrive as 400 — so the body is what decides, and the name rule is
    // quoted from run9's own message: project_cid must match [a-z0-9_-]{3,20}.
    if (res.status === 401 || res.status === 403) {
      return { ok: false as const, kind: "rejected" as const, reason: "run9 rejected these keys" };
    }
    if (/project not found/i.test(body)) {
      return { ok: false as const, kind: "rejected" as const, reason: `the keys work, but project "${settings.project}" does not exist` };
    }
    if (/project_cid must match/i.test(body)) {
      return {
        ok: false as const,
        kind: "rejected" as const,
        reason: `"${settings.project}" is not a usable project name: run9 wants 3 to 20 characters of a-z, 0-9, dash or underscore`,
      };
    }
    // Reached but with no verdict: a 500 says nothing about the keys.
    return { ok: false as const, kind: "unreachable" as const, reason: `run9 answered ${res.status}: ${body.slice(0, 120)}` };
  } catch (e) {
    // Nothing answered — a timeout, a refused connection, DNS. No verdict.
    return { ok: false as const, kind: "unreachable" as const, reason: String((e as Error)?.message ?? e) };
  }
}

/**
 * The run9 organisation these keys act on, by run9's `GET /whoami` (`org.org_id`), with the project the mount
 * names: a box lives in a project of an organisation, and keys of the same organisation reach the same project.
 * The access key is not it — each key of one account has its own.
 *
 * Null for an endpoint that is not run9 itself (`verifyWith: "endpoint"`): what a service in front answers for
 * `/whoami` is its own business, and could be one identity for every tenant — a "same" that is not.
 */
async function account(settings: ProviderSettings, credential: string): Promise<string | null> {
  if (settings.verifyWith === "endpoint") return null;
  let cred: Run9Credential;
  try { cred = JSON.parse(credential) as Run9Credential; } catch { return null; }
  if (!cred.ak || !cred.sk) return null;
  // A network failure throws through: nobody answered, which is not "no account" (`Plugin.credentialAccount`).
  const res = await caller(settings, authOf(cred)).send("GET", "/whoami", { timeoutMs: settings.timeoutMs });
  // Busy is not an answer either: a timeout, a conflict, a rate limit, or a server error. Thrown, so the change
  // waits rather than reading "no account" and deleting machines a same-account key would have kept.
  if (res.status >= 500 || [408, 409, 429].includes(res.status)) throw new Error(`run9 answered ${res.status} to /whoami`);
  if (!res.ok) return null;
  const org = (await res.json().catch(() => null) as { org?: { org_id?: unknown } } | null)?.org?.org_id;
  return typeof org === "string" && org ? `${org}/${settings.project}` : null;
}

export const run9: SandboxBackend = {
  id: "run9",
  name: "run9",
  caps: {
    pause: "disk",
    snapshot: "stopped",
    billing: "exists",
    boxSecrets: true,
  },
  // A run9 box runs commands as root with the full capability set, so a plain `unshare -n` makes the namespace.
  isolateNetwork: ["unshare", "-n", "--"],
  open,
  checkCredential,
  account,
};
