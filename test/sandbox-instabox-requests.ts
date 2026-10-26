/**
 * Every request the sandbox plugin makes to InstaBox, and everything it hands back, against a fake InstaBox that
 * answers deterministically, as test/sandbox-provider-requests.ts does for run9: the method, path, query, headers
 * that matter (idempotency key, delete confirmation, content type), body and time limit of each request, each
 * tool's result or refusal, and the record the mount is left with. Compared with
 * `sandbox-instabox-requests.golden.json`; a change made on purpose rewrites it (`--update`) and shows in review.
 *
 * Beside the golden, each scenario asserts the properties a reviewer should not have to find in a diff: the
 * idempotency and confirmation headers, the labels and backstops on a create, that an exec is never sent twice
 * except after `machine_not_running`, that `GET /files` (which reads as root) is never asked, and that machines
 * are only ever listed by label.
 *
 * The fake runs the adapter's own scripts (`LAUNCH`, `POLL`, `KILL`) by recognising them, so a detached job is
 * started, polled and killed the way the box would see it. The clock is the suite's: one second per request, and
 * the adapter's waits (`instaboxTiming.sleep`) move it rather than sleeping.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BOX_KEY, BOX_STORE, sandboxPlugin } from "../src/plugins/sandbox.ts";
import type { BoxLease } from "../src/plugins/sandbox.ts";
import { CP_IN, CP_OUT, IN_CONTAINER, instaboxTiming, KILL, LAUNCH, NO_CONTAINER, POLL, SETUP } from "../src/plugins/sandbox/providers/instabox.ts";
import type { SandboxForm } from "../src/plugins/types.ts";
import { Backgrounded } from "../src/plugins/types.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { execFileSync } from "node:child_process";

const GOLDEN = new URL("./sandbox-instabox-requests.golden.json", import.meta.url);
const UPDATE = process.argv.includes("--update");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, what: string): asserts cond { if (!cond) throw new Error(what); }

// ---- the clock, the waits and the randomness: all the suite's

const T0 = 1_800_000_000_000;
let now = T0;
const realNow = Date.now;
Date.now = () => now;
const realSleep = instaboxTiming.sleep;
instaboxTiming.sleep = async (ms: number) => { now += ms; };
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => Object.assign(realTimeout(ms), { timeoutMs: ms });
let rnd = 0;
const realRandom = crypto.getRandomValues.bind(crypto);
(crypto as any).getRandomValues = <T extends ArrayBufferView>(a: T): T => {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  for (let i = 0; i < b.length; i++) b[i] = (rnd++ * 37 + 11) & 0xff;
  return a;
};

// ---- a fake InstaBox

const ENDPOINT = "https://instabox.example";
const KEY = "ibk_test_key_000000";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
type Answer = { status?: number; json?: unknown; text?: string; bytes?: Uint8Array; headers?: Record<string, string> };
interface Req { method: string; path: string; headers: Record<string, string>; body: unknown; timeoutMs: number | null }
interface Machine { id: string; name: string; state: string; metadata: Record<string, string>; deleteAt: string; body: any }
/** A job's answers, one per poll; the last repeats. `{state:"running"}` or `{rc, output}`. */
type JobAnswer = { state: "running" } | { rc: number; output: string };
interface Fake {
  log: unknown[];
  reqs: Req[];
  machines: Map<string, Machine>;
  /** Answers for the next jobs started, one list per job. */
  jobs: JobAnswer[][];
  /** Checked before the defaults: the first that answers wins. */
  overrides: Array<(r: Req) => Answer | undefined>;
  /** Each command run in a machine's container (`IN_CONTAINER`), as the container got it. */
  inContainer: string[][];
  /** Whether the container is there to run in; false: `IN_CONTAINER` answers as it does when it cannot start one. */
  container: boolean;
}

function headersOf(h: unknown): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries([...h.entries()]);
  return Object.fromEntries(Object.entries(h as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

function fake(): Fake {
  const f: Fake = { log: [], reqs: [], machines: new Map(), jobs: [], overrides: [], inContainer: [], container: true };
  const ops = new Map<string, any>();
  const opByKey = new Map<string, string>();
  const snaps = new Map<string, { id: string; name: string; reads: number; from: string }>();
  const files = new Map<string, Uint8Array>();
  const jobs = new Map<string, { argv: string[]; answers: JobAnswer[]; served: number; killed: boolean; nostart: string | null }>();
  let mN = 0, opN = 0, snN = 0;
  const op = (type: string, machineId: string, extra: Record<string, unknown> = {}) => {
    const id = `op_${++opN}`;
    const o = { id, machineId, type, state: "queued", error: null, ...extra };
    ops.set(id, o);
    return o;
  };
  const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
    ({ status, json: { error: { code, message, requestId: "req_x", retryable: false, operationId: null, ...extra } } });
  globalThis.fetch = (async (url: string, init?: any) => {
    now += 1000;
    const method = String(init?.method ?? "GET");
    const u = String(url);
    if (!u.startsWith(ENDPOINT)) throw new Error(`a request left the fake: ${u}`);
    const path = u.slice(ENDPOINT.length);
    const h = headersOf(init?.headers);
    let body: unknown = null;
    if (init?.body instanceof Uint8Array) body = { bytes: init.body.byteLength, sha256: sha(init.body) };
    else if (init?.body !== undefined && init?.body !== null) { try { body = JSON.parse(String(init.body)); } catch { body = { text: String(init.body) }; } }
    const req: Req = { method, path, headers: h, body, timeoutMs: (init?.signal as { timeoutMs?: number } | undefined)?.timeoutMs ?? null };
    f.reqs.push(req);
    f.log.push({
      method, path,
      ...(h["idempotency-key"] ? { idem: h["idempotency-key"] } : {}),
      ...(h["x-confirm-delete"] ? { confirm: h["x-confirm-delete"] } : {}),
      ...(h["content-type"] ? { contentType: h["content-type"] } : {}),
      key: h["x-api-key"] === KEY ? "ok" : (h["x-api-key"] ?? "none"),
      body, timeoutMs: req.timeoutMs,
    });
    for (const o of f.overrides) {
      const a = o(req);
      if (a) return answer(a);
    }
    const [p, qs = ""] = path.split("?");
    const q = new URLSearchParams(qs);
    let m: RegExpExecArray | null;
    if (method === "GET" && p === "/v1/me") return answer({ json: { userId: 42, login: "probe", allowedSpecs: [{ vcpus: 2, memMiB: 4096 }] } });
    if (method === "POST" && p === "/v1/machines") {
      const key = h["idempotency-key"]!;
      if (opByKey.has(key)) return answer({ status: 202, json: ops.get(opByKey.get(key)!) });
      const b = body as any;
      if ([...f.machines.values()].some((x) => x.name === b.name)) return answer(err(409, "operation_conflict", "name taken"));
      const id = `m_${++mN}`;
      f.machines.set(id, { id, name: b.name, state: "creating", metadata: b.metadata ?? {}, deleteAt: new Date(now + b.deleteAfterSeconds * 1000).toISOString(), body: b });
      const o = op("create", id);
      opByKey.set(key, o.id);
      return answer({ status: 202, json: o });
    }
    if (method === "GET" && p === "/v1/machines") {
      const want = q.getAll("metadata").map((t) => [t.slice(0, t.indexOf(":")), t.slice(t.indexOf(":") + 1)]);
      return answer({ json: { machines: [...f.machines.values()].filter((x) => want.every(([k, v]) => x.metadata[k!] === v)).map(view), nextCursor: null } });
    }
    if ((m = /^\/v1\/operations\/([^/]+)$/.exec(p!)) && method === "GET") {
      const o = ops.get(m[1]!);
      if (!o) return answer(err(404, "not_found", "no such operation"));
      if (o.state === "queued") {
        o.state = "succeeded";
        const x = f.machines.get(o.machineId);
        if (x) {
          if (o.type === "create" || o.type === "start" || o.type === "resume") x.state = "running";
          if (o.type === "stop") x.state = "stopped";
          if (o.type === "suspend") x.state = "suspended";
          if (o.type === "delete") f.machines.delete(o.machineId);
        }
      }
      const x = f.machines.get(o.machineId);
      return answer({ json: { ...o, ...(o.state === "succeeded" && x ? { machine: view(x) } : {}) } });
    }
    if ((m = /^\/v1\/machines\/([^/]+)$/.exec(p!))) {
      const x = f.machines.get(m[1]!);
      if (!x) return answer(err(404, "not_found", "no such machine"));
      // A machine read while it boots has booted: what a later look at a real one finds.
      if (method === "GET" && x.state === "creating") x.state = "running";
      if (method === "GET") return answer({ json: view(x) });
      if (method === "DELETE") {
        if (h["x-confirm-delete"] !== x.id && h["x-confirm-delete"] !== x.name) return answer(err(409, "delete_confirmation_required", "confirm"));
        return answer({ status: 202, json: op("delete", x.id) });
      }
    }
    if ((m = /^\/v1\/machines\/([^/]+)\/(suspend|resume|start|stop)$/.exec(p!)) && method === "POST") {
      const x = f.machines.get(m[1]!);
      if (!x) return answer(err(404, "not_found", "no such machine"));
      if (!h["idempotency-key"]) return answer(err(400, "bad_request", "Idempotency-Key header is required"));
      const verb = m[2]!;
      if (verb === "stop" && x.state === "suspended") return answer(err(409, "operation_conflict", "machine is suspended; start or delete it"));
      if (verb === "suspend" && x.state !== "running") return answer(err(409, "operation_conflict", `machine is ${x.state}`));
      return answer({ status: 202, json: op(verb, x.id) });
    }
    if ((m = /^\/v1\/machines\/([^/]+)\/exec$/.exec(p!)) && method === "POST") {
      const x = f.machines.get(m[1]!);
      if (!x) return answer(err(404, "not_found", "no such machine"));
      if (x.state !== "running") return answer(err(409, "machine_not_running", `machine is ${x.state}; start it first`));
      return answer({ json: execOf((body as any).argv as string[]) });
    }
    if ((m = /^\/v1\/machines\/([^/]+)\/files$/.exec(p!))) {
      const x = f.machines.get(m[1]!);
      if (!x) return answer(err(404, "not_found", "no such machine"));
      // GET here is the endpoint that reads as root: answered, so a request to it is visible, and asserted absent.
      if (method === "GET") return answer({ json: { path: q.get("path"), type: "file", content: "read as root" } });
      if (method === "PUT") {
        if (x.state !== "running") return answer(err(409, "machine_not_running", "machine is not running"));
        const bytes = init.body as Uint8Array;
        files.set(q.get("path")!, bytes);
        return answer({ status: 201, json: { path: q.get("path"), size: bytes.byteLength, sha256: sha(bytes), mode: "0644", created: true } });
      }
    }
    if ((m = /^\/v1\/machines\/([^/]+)\/files\/content$/.exec(p!)) && method === "GET") {
      const x = f.machines.get(m[1]!);
      if (!x) return answer(err(404, "not_found", "no such machine"));
      if (x.state !== "running") return answer(err(409, "machine_not_running", "machine is not running"));
      const at = q.get("path")!;
      return answer({ bytes: files.get(at) ?? new TextEncoder().encode(`bytes of ${at}`) });
    }
    if ((m = /^\/v1\/machines\/([^/]+)\/snapshots$/.exec(p!)) && method === "POST") {
      const x = f.machines.get(m[1]!);
      if (!x) return answer(err(404, "not_found", "no such machine"));
      if (x.state !== "running") return answer(err(409, "machine_not_running", "machine is not running"));
      const s = { id: `sn_${++snN}`, name: (body as any).name, reads: 0, from: x.id };
      snaps.set(s.id, s);
      return answer({ status: 202, json: { id: s.id, name: s.name, status: "pending" } });
    }
    if ((m = /^\/v1\/snapshots\/([^/]+)$/.exec(p!))) {
      const s = snaps.get(m[1]!);
      if (!s) return answer(err(404, "not_found", "no such snapshot"));
      if (method === "GET") return answer({ json: { id: s.id, name: s.name, status: ++s.reads >= 2 ? "ready" : "pending" } });
      if (method === "DELETE") {
        if (h["x-confirm-delete"] !== s.id) return answer(err(409, "delete_confirmation_required", "confirm"));
        snaps.delete(s.id);
        return answer({ status: 204, text: "" });
      }
    }
    if ((m = /^\/v1\/machines\/([^/]+)\/usage$/.exec(p!)) && method === "GET") {
      return answer({ json: { runningSeconds: 61, vcpuSeconds: 122, memGiBSeconds: 244, diskGiBSeconds: 2196 } });
    }
    return answer({ status: 599, text: `the fake has no answer for ${method} ${path}` });

    /** The adapter's scripts, recognised by what they contain; anything else is a plain command. */
    function execOf(argv: string[]): Record<string, unknown> {
      const script = argv[0] === "sh" && argv[1] === "-c" ? argv[2]! : "";
      const args = argv.slice(4);
      if (script === IN_CONTAINER) {
        if (!f.container) return { exitCode: 125, stdout: "", stderr: `${NO_CONTAINER}\n` };
        f.inContainer.push(args);
        return execOf(args);
      }
      if (script === CP_IN) {
        files.set(args[1]!, files.get(args[0]!) ?? new Uint8Array());
        files.delete(args[0]!);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (script === CP_OUT) {
        const at = `/data/home/.antiproton/out-${args[1]}`;
        files.set(at, args[2] === "tar" ? new TextEncoder().encode(`tar of ${args[0]}`) : files.get(args[0]!) ?? new TextEncoder().encode(`bytes of ${args[0]}`));
        return { exitCode: 0, stdout: at };
      }
      const job = /jobs\/([A-Za-z0-9_-]+)/.exec(script)?.[1];
      if (script.endsWith(LAUNCH) && job) {
        const [workdir, ...cmd] = args;
        const nostart = workdir && workdir.startsWith("/nope") ? `failed to start: chdir ${workdir}: no such file or directory` : null;
        jobs.set(job, { argv: cmd, answers: f.jobs.shift() ?? [], served: 0, killed: false, nostart });
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (script.endsWith(POLL) && job) {
        const j = jobs.get(job);
        if (!j) return { exitCode: 0, stdout: "missing\n" };
        if (j.nostart) return { exitCode: 0, stdout: `nostart\n${j.nostart}\n` };
        if (j.killed) return { exitCode: 0, stdout: "killed\nsize 0\n" };
        const a = j.answers.length ? j.answers[Math.min(j.served++, j.answers.length - 1)]! : defaultJob(j.argv, files);
        if ("state" in a) return { exitCode: 0, stdout: "running\n" };
        return { exitCode: 0, stdout: `rc ${a.rc}\nsize ${a.output.length}\n${a.output}` };
      }
      if (script.endsWith(KILL) && job) {
        const j = jobs.get(job);
        if (!j) return { exitCode: 3, stdout: "" };
        j.killed = true;
        return { exitCode: 0, stdout: "" };
      }
      if (argv[0] === "sh" && script.includes("tar -cf")) {
        files.set(`/data/home/.antiproton/save-${args[1]}.tar`, new TextEncoder().encode(`tar of ${args[0]}`));
        return { exitCode: 0, stdout: `/data/home/.antiproton/save-${args[1]}.tar` };
      }
      if (argv[0] === "rm") return { exitCode: 0, stdout: "" };
      return { exitCode: 127, stdout: "", stderr: `the fake does not run ${argv.join(" ").slice(0, 80)}` };
    }
  }) as any;
  return f;
}

function view(x: Machine) {
  return { id: x.id, name: x.name, state: x.state, metadata: x.metadata, deleteAt: x.deleteAt, spec: { vcpus: x.body.vcpus, memMiB: x.body.memMiB } };
}

function answer(a: Answer): Response {
  const body = a.bytes ?? (a.text !== undefined ? a.text : JSON.stringify(a.json ?? {}));
  return new Response(a.status === 204 ? null : body as string | Uint8Array<ArrayBuffer>, { status: a.status ?? 200, headers: a.headers });
}

/** What a job nobody scripted ends with: each kind of command the plugin sends gets its own. */
function defaultJob(argv: string[], files: Map<string, Uint8Array>): JobAnswer {
  const line = argv.join(" ");
  if (argv[2] === SETUP) return { rc: 0, output: "pulled the image in 16 s\n" };
  if (line.includes("#total")) return { rc: 0, output: "f\t5\t1700000000.5\tout.txt\nd\t0\t1700000001\tsrc\n#total\t2\n" };
  if (line.includes("realpath") && line.includes("-maxdepth 0")) return { rc: 0, output: "f\t13\t1700000002.25\t/data/home/work/out.txt\n" };
  if (line.includes("sha256sum")) {
    const got = files.get(argv[4]!);
    return got ? { rc: 0, output: `${got.byteLength}\n${sha(got)}\n` } : { rc: 3, output: "" };
  }
  if (line.includes("dirname")) return { rc: 0, output: "" };
  return { rc: 0, output: "hello\n__AP_CWD__/data/home/work\n" };
}

// ---- a mount

const LEASE: BoxLease = { warnMs: 300_000, maxMs: 1_800_000 };
const FORM: SandboxForm = {
  summary: "gh and git act as the agent's GitHub account.",
  egress: [{ name: "GH_TOKEN", header: "authorization", hosts: ["api.github.com"], value: (c) => `token ${c}`, placeholder: (p) => `token ${p}` }],
  env: (p) => ({ GH_TOKEN: p }),
};

function mount(o: { lease?: BoxLease | null; config?: Record<string, unknown>; credential?: string | null; forms?: boolean } = {}) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" };
  const objects: Record<string, Uint8Array> = { "t/t/a/raft/attachments/7/photo.jpg": new TextEncoder().encode("a photo, 21 bytes....") };
  const stored: string[] = [];
  const artifacts = {
    async put(key: string, body: Uint8Array, type: string) { stored.push(`${key} ${type} ${body.byteLength}`); return { ref: `r2://bucket/${key}` }; },
    async get(key: string) { const b = objects[key]; if (!b) throw new Error("no such artifact"); return b; },
    async size(key: string) { return objects[key]?.byteLength ?? null; },
  };
  const plugin = sandboxPlugin(artifacts as any, "bucket", o.lease ?? null);
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: o.credential === undefined ? JSON.stringify({ apiKey: KEY }) : o.credential,
    credentialRefKind: "agent",
    publicConfig: { provider: "instabox", endpoint: ENDPOINT, graceMs: 3_000, ...(o.config ?? {}) },
    db: openPluginDatabase(tables, scope, plugin.database),
    sibling: async () => null,
    sandboxForms: async () => o.forms ? [{ alias: "github", plugin: "github", form: FORM, credential: "ghp_x", used: async () => {} }] : [],
    offered: [],
  };
  const record = () => tables.get(scope, BOX_STORE, BOX_KEY) as any;
  return { plugin, ctx, record, stored };
}

const locked = <T>(fn: () => Promise<T>) => fn();

async function step(name: string, fn: () => Promise<unknown>, log: unknown[]): Promise<any> {
  try {
    const r = await fn();
    log.push({ step: name, result: bytesOut(r) });
    return r;
  } catch (e) {
    const err = e as Error & { released?: unknown };
    log.push({ step: name, threw: String(err?.message ?? err), ...(err?.released ? { released: err.released } : {}) });
    return undefined;
  }
}
function bytesOut(v: unknown): unknown {
  if (v instanceof Backgrounded) return { backgrounded: { handle: v.handle, note: v.note ?? null } };
  if (v instanceof Uint8Array) return { bytes: new TextDecoder().decode(v) };
  if (Array.isArray(v)) return v.map(bytesOut);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, bytesOut(x)]));
  return v;
}

// ---- what every request must be, whichever scenario made it

function invariants(f: Fake) {
  for (const r of f.reqs) {
    const what = `${r.method} ${r.path}`;
    must(r.headers["x-api-key"] === KEY && !r.headers.authorization, `${what}: not authorised with X-API-Key alone`);
    must(!(r.method === "GET" && /\/files(\?|$)/.test(r.path)), `${what}: GET /files reads as root and must never be asked`);
    if (r.method === "GET" && r.path.split("?")[0] === "/v1/machines") {
      const terms = new URLSearchParams(r.path.split("?")[1] ?? "").getAll("metadata");
      must(["tenant:t", "agent:a", "mount:sandbox"].every((t) => terms.includes(t)), `${what}: machines listed without the mount's labels`);
    }
    const lifecycle = /^\/v1\/machines(\/[^/]+\/(suspend|resume|start|stop|snapshots))?$/.test(r.path.split("?")[0]!) && r.method === "POST";
    if (lifecycle || r.method === "DELETE") must(!!r.headers["idempotency-key"], `${what}: no Idempotency-Key`);
    const del = /^\/v1\/(machines|snapshots)\/([^/]+)$/.exec(r.path);
    if (r.method === "DELETE" && del) must(r.headers["x-confirm-delete"] === del[2], `${what}: X-Confirm-Delete is not the id being deleted`);
    if (r.method === "POST" && r.path === "/v1/machines") {
      const b = r.body as any;
      must(b.failFast === true && b.deleteAfterSeconds > 0 && b.deleteAfterSeconds <= 86400 && b.maxRunMinutes > 0, `${what}: create without failFast and both backstops: ${JSON.stringify(b)}`);
      must(b.metadata?.tenant === "t" && b.metadata?.agent === "a" && b.metadata?.mount === "sandbox" && typeof b.metadata?.machine === "string", `${what}: create without the labels`);
      must(JSON.stringify(b.secrets) === "[]" && b.vault === false, `${what}: create selects org secrets`);
      if (!b.snapshotId) must(b.vcpus === 2 && b.memMiB === 4096 && b.templateId === "universal", `${what}: not the smallest size on the default template`);
    }
  }
}
const execs = (f: Fake) => f.reqs.filter((r) => r.method === "POST" && r.path.endsWith("/exec"));

// ---- the scenarios

const SCENARIOS: Record<string, (out: unknown[]) => Promise<void>> = {
  async "an InstaBox mount's tools say what InstaBox does with an idle box; run9's text is untouched"(out) {
    const lease = sandboxPlugin(null, "bucket", LEASE), none = sandboxPlugin(null, "bucket", null);
    const rec = (provider: string, config: Record<string, unknown> = {}) => ({ publicConfig: { provider, ...config } }) as any;
    const ib = lease.mountTools!(rec("instabox"));
    out.push({ lease: ib.map((t) => ({ name: t.name, summary: t.summary })) });
    out.push({ noLease: none.mountTools!(rec("instabox")).map((t) => ({ name: t.name, summary: t.summary })) });
    out.push({ longerLife: lease.mountTools!(rec("instabox", { maxLifetimeHours: 24, keepStoppedDays: 0.5 })).find((t) => t.name === "shell")!.summary });
    must(JSON.stringify(lease.mountTools!(rec("run9"))) === JSON.stringify(lease.tools), "a run9 mount's tools are not the plugin's own");
    must(JSON.stringify(lease.mountTools!(rec("fly"))) === JSON.stringify(lease.tools), "a mount naming an unknown provider gets other tools");
    const shell = ib.find((t) => t.name === "shell")!.summary;
    must(shell.includes("it is paused, keeping its memory") && shell.includes("24 hours after it was created") && !shell.includes("switched off, and the next call switches it back on"),
      "the InstaBox shell description does not state InstaBox's idle life");
  },

  async "create, shell, run, put, save, keep, start_from, release"(out) {
    const f = fake();
    const m = mount({ lease: LEASE, forms: true });
    await step("shell creates the machine", () => m.plugin.invoke("shell", { command: "echo hello" }, m.ctx), out);
    await step("shell again, in a directory of its own", () => m.plugin.invoke("shell", { command: "ls", workdir: "src" }, m.ctx), out);
    await step("run", () => m.plugin.invoke("run", { code: "console.log(1)" }, m.ctx), out);
    await step("put", () => m.plugin.invoke("put", { ref: "artifact://raft/attachments/7/photo.jpg", path: "in/photo.jpg" }, m.ctx), out);
    await step("save a file", () => m.plugin.invoke("save", { path: "/data/home/work/in/photo.jpg" }, m.ctx), out);
    await step("save a directory as tar", () => m.plugin.invoke("save", { path: "/data/home/work/in", archive: true }, m.ctx), out);
    await step("keep", () => m.plugin.invoke("keep", { name: "py-env" }, m.ctx), out);
    await step("keep under the same name replaces and deletes the old snapshot", () => m.plugin.invoke("keep", { name: "py-env" }, m.ctx), out);
    await step("start_from releases the machine", () => m.plugin.invoke("start_from", { name: "py-env" }, m.ctx), out);
    await step("shell creates from the snapshot", () => m.plugin.invoke("shell", { command: "echo from" }, m.ctx), out);
    await step("machines", () => m.plugin.invoke("machines", {}, m.ctx), out);
    await step("release, saving first", () => m.plugin.invoke("release", { save: ["/data/home/work/out.txt"] }, m.ctx), out);
    out.push(...f.log, { stored: m.stored }, { record: m.record() });
    invariants(f);
    const creates = f.reqs.filter((r) => r.method === "POST" && r.path === "/v1/machines");
    must(creates.length === 2 && (creates[1]!.body as any).snapshotId === "sn_2" && !(creates[1]!.body as any).templateId, "the second machine was not created from the kept snapshot");
    must(f.reqs.some((r) => r.method === "DELETE" && r.path === "/v1/snapshots/sn_1"), "the replaced snapshot was not deleted");
    must(m.record().machines.main === undefined && m.record().envs[0].snapId === "sn_2", "the record does not end with no machine and the snapshot kept");
    must(!f.reqs.some((r) => r.path.includes("/secrets")), "a credential was registered with InstaBox");
  },

  async "a command handed over as a job, polled, cancelled; one finishing on its own"(out) {
    const f = fake();
    const m = mount({ config: { graceMs: 0 } });
    f.jobs.push([{ state: "running" }]);
    const r: any = await step("shell is handed over", () => m.plugin.invoke("shell", { command: "sleep 100" }, m.ctx), out);
    const h = r?.handle;
    await step("poll while it runs", () => m.plugin.background!.poll(h, m.ctx), out);
    await step("cancel", () => m.plugin.background!.cancel(h, m.ctx), out);
    await step("poll once cancelled", () => m.plugin.background!.poll(h, m.ctx), out);
    f.jobs.push([{ state: "running" }, { rc: 0, output: "done\n__AP_CWD__/data/home/work\n" }]);
    const r2: any = await step("a second is handed over", () => m.plugin.invoke("shell", { command: "sleep 2" }, m.ctx), out);
    await step("poll: running", () => m.plugin.background!.poll(r2?.handle, m.ctx), out);
    await step("poll: done", () => m.plugin.background!.poll(r2?.handle, m.ctx), out);
    await step("a directory that does not exist", () => m.plugin.invoke("shell", { command: "pwd", workdir: "/nope" }, m.ctx), out);
    out.push(...f.log, { record: m.record() });
    invariants(f);
    must(typeof h?.execId === "string" && h.execId.startsWith("m_1/j"), `the handle does not name the machine and the job: ${JSON.stringify(h)}`);
    const kills = execs(f).filter((e) => String((e.body as any).argv[2]).endsWith(KILL));
    must(kills.length === 1, `expected one kill exec, got ${kills.length}`);
    const launches = execs(f).filter((e) => String((e.body as any).argv[2]).endsWith(LAUNCH));
    must(launches.every((e) => (e.body as any).argv[2].includes("setsid nohup") && (e.body as any).argv[2].includes('> "$d/out" 2>&1 < /dev/null &')),
      "a job was started without its output redirected away from the exec");
  },

  async "idle: paused, resumed by a call; paused again, then deleted with a warning; never switched off"(out) {
    const f = fake();
    const m = mount({ lease: LEASE });
    await step("shell", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    await step("idle release pauses it", () => m.plugin.holds!.release(m.ctx, { reason: "idle" }), out);
    await step("activities while paused", () => m.plugin.holds!.activities!(m.ctx), out);
    await step("machines while paused", () => m.plugin.invoke("machines", {}, m.ctx), out);
    await step("the workspace view does not wake it", () => m.plugin.holds!.files!.list(m.ctx, "", locked), out);
    await step("quiet while paused", () => m.plugin.invoke("quiet", { minutes: 600 }, m.ctx), out);
    await step("shell resumes it", () => m.plugin.invoke("shell", { command: "echo back" }, m.ctx), out);
    await step("machines while running", () => m.plugin.invoke("machines", {}, m.ctx), out);
    await step("idle release pauses it again", () => m.plugin.holds!.release(m.ctx, { reason: "idle" }), out);
    await step("the next idle step deletes it", () => m.plugin.holds!.release(m.ctx, { reason: "idle" }), out);
    // A machine InstaBox itself switched off (an archive time, say) is started by the next call.
    await step("shell makes a new machine", () => m.plugin.invoke("shell", { command: "echo new" }, m.ctx), out);
    f.machines.get("m_2")!.state = "stopped";
    await step("shell starts one InstaBox switched off", () => m.plugin.invoke("shell", { command: "echo started" }, m.ctx), out);
    await step("usage", () => m.plugin.holds!.usage!(m.ctx), out);
    out.push(...f.log, { record: m.record() });
    invariants(f);
    const verbs = f.reqs.filter((r) => (r.method === "POST" && /\/(suspend|resume|start|stop)$/.test(r.path)) || r.method === "DELETE").map((r) => r.method === "DELETE" ? "delete" : r.path.split("/").pop());
    must(JSON.stringify(verbs) === JSON.stringify(["suspend", "resume", "suspend", "delete", "start"]),
      `the lifecycle calls were not pause, resume, pause, delete (and a start for the one InstaBox stopped): ${verbs.join(",")}`);
    const paused = (out.find((e: any) => e.step === "activities while paused") as any).result[0].live.lease;
    must(paused.warnMs > 0 && /paused machine/.test(paused.consequence), `a paused machine is not on the warned deletion schedule: ${JSON.stringify(paused)}`);
  },

  async "a create InstaBox has no room for is asked again, with a new key after a failed operation"(out) {
    const f = fake();
    const m = mount();
    let refusals = 1;
    f.overrides.push((r) => r.method === "POST" && r.path === "/v1/machines" && refusals-- > 0
      ? { status: 503, json: { error: { code: "no_capacity", message: "no host has room", retryable: true, retryAfterSeconds: 60 } } } : undefined);
    await step("shell after one no_capacity", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    await step("release", () => m.plugin.invoke("release", {}, m.ctx), out);
    // A gateway error may hide a create that was taken: asked again under the same key, which replays it.
    let gateway = 1;
    f.overrides.push((r) => r.method === "POST" && r.path === "/v1/machines" && gateway-- > 0 ? { status: 502, text: "<html>bad gateway</html>" } : undefined);
    await step("shell after a gateway error on the create", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    await step("release", () => m.plugin.invoke("release", {}, m.ctx), out);
    // An accepted create whose operation fails no_capacity: the next attempt must not replay that operation.
    let failOp = true;
    f.overrides.push((r) => {
      if (failOp && r.method === "GET" && r.path.startsWith("/v1/operations/")) {
        failOp = false;
        // InstaBox deletes a create that fails before it gets a host.
        f.machines.delete("m_3");
        return { json: { id: r.path.split("/")[3]!.split("?")[0], machineId: "m_3", type: "create", state: "failed", error: { code: "no_capacity", message: "no host", retryAfterSeconds: 30 } } };
      }
      return undefined;
    });
    await step("shell after a failed create operation", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    await step("release", () => m.plugin.invoke("release", {}, m.ctx), out);
    f.overrides.length = 0;
    f.overrides.push((r) => r.method === "POST" && r.path === "/v1/machines"
      ? { status: 503, json: { error: { code: "no_capacity", message: "no host has room", retryable: true, retryAfterSeconds: 60 } } } : undefined);
    await step("shell when there is never room", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    f.overrides.length = 0;
    f.overrides.push((r) => r.method === "POST" && r.path === "/v1/machines" ? { status: 429, json: { error: { code: "rate_limited", message: "3 starts a minute", retryable: true, retryAfterSeconds: 60 } }, headers: { "retry-after": "60" } } : undefined);
    await step("shell when rate limited throughout", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    out.push(...f.log, { record: m.record() });
    invariants(f);
    const keys = f.reqs.filter((r) => r.method === "POST" && r.path === "/v1/machines").map((r) => r.headers["idempotency-key"]!);
    must(keys[0] !== keys[1], "a create refused for no room was asked again under the key that answered the refusal");
    must(keys[2] === keys[3], "a create answered by a gateway error was asked again under a new key, which could make a second machine");
    must(keys[4] !== keys[5], "a create whose operation failed was asked again under the same key, which replays the failure");
    must(f.machines.size === 0, "a machine was left behind");
  },

  async "a machine InstaBox paused on its own is resumed, and the command sent once more"(out) {
    const f = fake();
    const m = mount();
    await step("shell", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    f.machines.get("m_1")!.state = "suspended";
    const before = execs(f).length;
    await step("shell finds it paused", () => m.plugin.invoke("shell", { command: "echo again" }, m.ctx), out);
    const launches = execs(f).slice(before).filter((e) => String((e.body as any).argv[2]).endsWith(LAUNCH));
    f.machines.get("m_1")!.state = "suspended";
    await step("save finds it paused", () => m.plugin.invoke("save", { path: "/data/home/work/out.txt" }, m.ctx), out);
    // An exec that failed in a way that may have run the command is not sent again.
    const sent = execs(f).length;
    f.overrides.push((r) => r.method === "POST" && r.path.endsWith("/exec") ? { status: 502, text: "<html>bad gateway</html>" } : undefined);
    await step("an exec answered by a gateway error", () => m.plugin.invoke("shell", { command: "echo once" }, m.ctx), out);
    const afterGateway = execs(f).length - sent;
    f.overrides.length = 0;
    out.push(...f.log, { record: m.record() });
    invariants(f);
    must(launches.length === 2, `expected the launch refused once and sent once more, got ${launches.length} launches`);
    must(afterGateway === 1, `an exec answered 502 was sent ${afterGateway} times`);
  },

  async "a release deletes with the machine's own id as confirmation; refusals keep the record"(out) {
    const f = fake();
    const m = mount();
    await step("shell", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    f.overrides.push((r) => r.method === "DELETE" ? { status: 503, json: { error: { code: "host_unavailable", message: "try later", retryable: true } } } : undefined);
    await step("release refused by an outage", () => m.plugin.holds!.release(m.ctx), out);
    f.overrides.length = 0;
    f.overrides.push((r) => r.method === "DELETE" ? { status: 409, json: { error: { code: "delete_confirmation_required", message: "confirm" } } } : undefined);
    await step("release refused for the confirmation", () => m.plugin.invoke("release", {}, m.ctx), out);
    f.overrides.length = 0;
    await step("release", () => m.plugin.invoke("release", {}, m.ctx), out);
    await step("shell makes a new machine", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    f.machines.clear();
    await step("already gone is believed for the key that made it", () => m.plugin.holds!.release(m.ctx), out);
    out.push(...f.log, { record: m.record() });
    invariants(f);
  },

  async "a create whose name is taken adopts the machine found by its labels"(out) {
    const f = fake();
    const m = mount();
    // The create was accepted and its answer lost: the machine is there, under this name, and a second create
    // with a different key is refused as a name conflict.
    let lost = true;
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: any) => {
      const r = await real(url, init);
      if (lost && init?.method === "POST" && String(url).endsWith("/v1/machines")) {
        lost = false;
        return new Response(JSON.stringify({ error: { code: "operation_conflict", message: "name taken" } }), { status: 409 });
      }
      return r;
    }) as any;
    await step("shell whose create answered conflict", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    globalThis.fetch = real;
    await step("release", () => m.plugin.invoke("release", {}, m.ctx), out);
    f.overrides.push((r) => r.method === "POST" && r.path === "/v1/machines" ? { status: 409, json: { error: { code: "operation_conflict", message: "name taken" } } } : undefined);
    await step("shell whose create conflicts and nothing carries its labels", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    out.push(...f.log, { record: m.record() });
    invariants(f);
    const lists = f.reqs.filter((r) => r.method === "GET" && r.path.startsWith("/v1/machines?"));
    must(lists.length === 2 && lists.every((r) => r.path.includes("metadata=machine%3Amain")), "adoption did not list by every label");
  },

  async "network none, accounts, credentials and the account"(out) {
    const f = fake();
    const m = mount({ config: { network: "none" }, forms: true });
    await step("shell with no network", () => m.plugin.invoke("shell", { command: "curl example.com" }, m.ctx), out);
    const launch = execs(f).find((e) => String((e.body as any).argv[2]).endsWith(LAUNCH))!;
    const ask = (credential: string | null) => {
      const x = mount({ credential });
      return { check: () => x.plugin.checkCredential!(x.ctx), account: () => x.plugin.credentialAccount!(x.ctx) };
    };
    await step("good key", () => ask(JSON.stringify({ apiKey: KEY })).check(), out);
    await step("run9 keys on an InstaBox mount", () => ask(JSON.stringify({ ak: "AK", sk: "SK" })).check(), out);
    await step("account", () => ask(JSON.stringify({ apiKey: KEY })).account(), out);
    for (const status of [401, 503]) {
      f.overrides.length = 0;
      f.overrides.push((r) => r.path === "/v1/me" ? { status, json: { error: { code: status === 401 ? "invalid_key" : "unavailable", message: "no" } } } : undefined);
      await step(`check when /v1/me answers ${status}`, () => ask(JSON.stringify({ apiKey: KEY })).check(), out);
      await step(`account when /v1/me answers ${status}`, () => ask(JSON.stringify({ apiKey: KEY })).account(), out);
    }
    f.overrides.length = 0;
    const p = sandboxPlugin(null, "bucket");
    out.push({ configProblems: [{ provider: "instabox", shape: "big" }, { provider: "instabox", endpoint: "https://api.run.sys9.ai" }, { provider: "instabox", maxLifetimeHours: 48 }, { provider: "instabox" }, { shape: "big" }].map((c) => p.configProblem!(c as any) ?? null) });
    out.push(...f.log, { record: m.record() });
    invariants(f);
    const argv = (launch.body as any).argv as string[];
    must(argv.slice(5, 10).join(" ") === "unshare --user --map-current-user --net --", `the command was not started in a user and network namespace: ${argv.slice(4, 12).join(" ")}`);
    must(!f.reqs.some((r) => r.path.includes("/secrets")), "a credential was registered with InstaBox");
  },

  async "an image runs as a container in the machine: set up at create, and every command, file and job goes into it"(out) {
    const f = fake();
    const IMAGE = "docker.io/swebench/sweb.eval.x86_64.astropy_1776_astropy-12907:latest";
    const m = mount({ lease: LEASE, config: { image: IMAGE, workdir: "/testbed", network: "none", shell: "/bin/bash",
      shellPrefix: "source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && " } });
    await step("shell creates the machine and its container", () => m.plugin.invoke("shell", { command: "python -V" }, m.ctx), out);
    await step("shell again", () => m.plugin.invoke("shell", { command: "git status" }, m.ctx), out);
    await step("put", () => m.plugin.invoke("put", { ref: "artifact://raft/attachments/7/photo.jpg", path: "in/photo.jpg" }, m.ctx), out);
    await step("save a file", () => m.plugin.invoke("save", { path: "/testbed/in/photo.jpg" }, m.ctx), out);
    await step("save a directory as tar", () => m.plugin.invoke("save", { path: "/testbed/in", archive: true }, m.ctx), out);
    m.ctx.publicConfig.graceMs = 0;
    f.jobs.push([{ state: "running" }]);
    const bg: any = await step("a command handed over as a job", () => m.plugin.invoke("shell", { command: "sleep 100" }, m.ctx), out);
    await step("poll it", () => m.plugin.background!.poll(bg?.handle, m.ctx), out);
    await step("cancel it", () => m.plugin.background!.cancel(bg?.handle, m.ctx), out);
    m.ctx.publicConfig.graceMs = 3_000;
    await step("the workspace view lists the container's working directory", () => m.plugin.holds!.files!.list(m.ctx, "", locked), out);
    await step("keep", () => m.plugin.invoke("keep", { name: "env" }, m.ctx), out);
    await step("start_from", () => m.plugin.invoke("start_from", { name: "env" }, m.ctx), out);
    f.jobs.push([{ rc: 0, output: "started the container already there\n" }]);
    await step("shell creates from the snapshot, starting the container kept in it", () => m.plugin.invoke("shell", { command: "echo from" }, m.ctx), out);
    await step("machines", () => m.plugin.invoke("machines", {}, m.ctx), out);
    await step("release", () => m.plugin.invoke("release", {}, m.ctx), out);
    out.push(...f.log, { stored: m.stored }, { inContainer: f.inContainer }, { record: m.record() });
    invariants(f);
    const argvs = execs(f).map((e) => (e.body as any).argv as string[]);
    const setups = argvs.filter((a) => a[2]!.endsWith(LAUNCH) && a.includes(SETUP));
    must(setups.length === 2, `expected the container set up once per machine, got ${setups.length}`);
    for (const a of setups) {
      const at = a.indexOf(SETUP);
      must(JSON.stringify(a.slice(at + 2, at + 5)) === JSON.stringify([IMAGE, "none", "/testbed"]), `the container was not asked for with the image, no network and the working directory: ${a.slice(at + 2).join(" ")}`);
    }
    // On the machine itself only the setup, its polls, the copies in and out and their clean-up: nothing the agent wrote.
    const onMachine = argvs.filter((a) => a[2] !== IN_CONTAINER);
    for (const a of onMachine) {
      const ok = a.includes(SETUP) || /jobs\/setup-/.test(a[2]!) || a[2] === CP_IN || a[2] === CP_OUT || (a[0] === "rm" && /\.antiproton\/out-/.test(a[3]!));
      must(ok, `a command ran on the machine, outside the container: ${a.join(" ").slice(0, 200)}`);
    }
    must(!argvs.some((a) => a.includes("unshare")), "a command was put in a namespace the container refuses; its network is Docker's");
    must(f.inContainer.some((a) => a[2]!.endsWith(LAUNCH) && a.some((x) => x.includes("source /opt/miniconda3/etc/profile.d/conda.sh && conda activate testbed && mkdir -p /testbed"))),
      "the agent's command did not reach the container with its prefix");
    must(f.inContainer.some((a) => a[2]!.endsWith(KILL)), "the job was not killed in the container");
    const puts = f.reqs.filter((r) => r.method === "PUT");
    must(puts.length === 1 && /path=%2Ftmp%2F\.ap-in-/.test(puts[0]!.path), `the upload did not go to the machine's /tmp on its way into the container: ${puts.map((r) => r.path).join(", ")}`);
    must(!f.reqs.some((r) => r.method === "GET" && r.path.includes("/files/content") && !r.path.includes(".antiproton%2Fout-")), "a file was read from the machine rather than copied out of the container");
    must(m.record().envs?.[0]?.image === IMAGE, "the kept environment does not record the image");
  },

  async "an image's container: the network open or closed by the setting, a container that cannot come up, one gone"(out) {
    const f = fake();
    const IMAGE = "docker.io/library/python:3.12";
    const network = async (value: unknown) => {
      const m = mount({ config: { image: IMAGE, ...(value === undefined ? {} : { network: value }) } });
      await step(`shell with network ${JSON.stringify(value)}`, () => m.plugin.invoke("shell", { command: "true" }, m.ctx), out);
      const a = execs(f).map((e) => (e.body as any).argv as string[]).reverse().find((x) => x.includes(SETUP))!;
      await step("release", () => m.plugin.invoke("release", {}, m.ctx), out);
      return a[a.indexOf(SETUP) + 3];
    };
    const nets = { open: await network("open"), absent: await network(undefined), none: await network("none"), typo: await network("None") };
    out.push({ nets });
    must(nets.open === "bridge" && nets.absent === "bridge" && nets.none === "none" && nets.typo === "none", `the container's network did not follow the setting, closed unless open: ${JSON.stringify(nets)}`);
    // A container that will not come up (an image that cannot be pulled): the machine is deleted, and nothing recorded.
    const m = mount({ config: { image: "docker.io/nobody/nothing:latest" } });
    f.jobs.push([{ state: "running" }, { rc: 4, output: "Error response from daemon: pull access denied\n" }]);
    const before = f.machines.size;
    await step("shell when the image cannot be pulled", () => m.plugin.invoke("shell", { command: "true" }, m.ctx), out);
    must(f.machines.size === before, "the machine whose container did not come up was left behind");
    must(!m.record()?.machines?.main, "a machine whose container did not come up was recorded");
    // A container that is gone and cannot be started again: said, not read as the command's own failure.
    const g = mount({ config: { image: IMAGE } });
    await step("shell", () => g.plugin.invoke("shell", { command: "true" }, g.ctx), out);
    f.container = false;
    await step("shell when the container cannot be started", () => g.plugin.invoke("shell", { command: "true" }, g.ctx), out);
    f.container = true;
    out.push(...f.log, { record: g.record() });
    invariants(f);
  },
};

// ---- the scripts as a shell reads them: the fake only recognises them, so a quoting slip would pass it

await check("every script the adapter sends parses as sh", () => {
  for (const [name, script] of Object.entries({ LAUNCH, POLL, KILL, SETUP, IN_CONTAINER, CP_IN, CP_OUT })) {
    try { execFileSync("sh", ["-n", "-c", script], { stdio: "pipe" }); } catch (e) {
      throw new Error(`${name} does not parse: ${String((e as any).stderr ?? e).trim()}`);
    }
  }
});

// ---- compare

const golden: Record<string, unknown[]> = UPDATE ? {} : JSON.parse(readFileSync(GOLDEN, "utf8"));
const got: Record<string, unknown[]> = {};
for (const [name, run] of Object.entries(SCENARIOS)) {
  now = T0;
  rnd = 0;
  const out: unknown[] = [];
  let failed: string | null = null;
  try { await run(out); } catch (e) { failed = String((e as Error)?.message ?? e); }
  got[name] = JSON.parse(JSON.stringify(out));
  await check(name, () => {
    if (failed) throw new Error(failed);
    if (UPDATE) return;
    const want = golden[name];
    if (!want) throw new Error("no golden entry for this scenario; run with --update to record one");
    const n = Math.max(want.length, got[name]!.length);
    for (let i = 0; i < n; i++) {
      const a = JSON.stringify(want[i]), b = JSON.stringify(got[name]![i]);
      if (a !== b) throw new Error(`entry ${i} of ${n} differs:\n  golden: ${a?.slice(0, 600)}\n  now:    ${b?.slice(0, 600)}`);
    }
  });
}
if (!UPDATE) await check("the golden names no scenario this suite no longer runs", () => {
  const stale = Object.keys(golden).filter((k) => !(k in SCENARIOS));
  if (stale.length) throw new Error(`stale: ${stale.join("; ")}`);
});

Date.now = realNow;
AbortSignal.timeout = realTimeout;
instaboxTiming.sleep = realSleep;
(crypto as any).getRandomValues = realRandom;
if (UPDATE) {
  writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + "\n");
  console.log(`wrote ${Object.keys(got).length} scenarios to ${GOLDEN.pathname}`);
}
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.ok ? "" : `\n    ${r.error}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
