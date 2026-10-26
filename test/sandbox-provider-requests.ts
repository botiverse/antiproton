/**
 * Every request the sandbox plugin makes to its provider, and everything it hands back, against a fake run9
 * that answers deterministically: the method, path, query, content type, authorization and body of each request,
 * each tool's result or refusal, and the record the mount is left with. Compared with
 * `sandbox-provider-requests.golden.json`, which holds what the plugin did when this suite was written.
 *
 * It exists so the plugin can be restructured behind its provider interface without moving any of that: a change
 * to a request, a result or the record reddens the scenario that made it, and names the first entry that differs.
 * A change made on purpose rewrites the golden (`node test/sandbox-provider-requests.ts --update`) and shows up
 * in review as a diff of that file, request by request.
 *
 * The clock is the suite's: `Date.now` moves one second per request and stands still otherwise, so box ids, the
 * times in results and every deadline depend only on the requests made, which is the thing compared. Each
 * request's time limit is read off its `AbortSignal.timeout`, so a changed limit is a changed request too.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { BOX_KEY, BOX_STORE, sandboxPlugin } from "../src/plugins/sandbox.ts";
import type { BoxLease } from "../src/plugins/sandbox.ts";
import type { SandboxForm } from "../src/plugins/types.ts";
import { Backgrounded } from "../src/plugins/types.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";

const GOLDEN = new URL("./sandbox-provider-requests.golden.json", import.meta.url);
const UPDATE = process.argv.includes("--update");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

// ---- the clock

const T0 = 1_800_000_000_000;
let now = T0;
const realNow = Date.now;
Date.now = () => now;

// ---- how long each request may take, readable from its signal

const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms: number) => Object.assign(realTimeout(ms), { timeoutMs: ms });

// ---- a fake run9

type Answer = { status?: number; json?: unknown; text?: string; bytes?: Uint8Array };
type ExecAnswer = Record<string, unknown>;
interface Fake {
  log: unknown[];
  /** Answers for the next executions started, one list per execution; the last answer of each repeats. */
  execs: ExecAnswer[][];
  /** Checked before the defaults: the first that answers wins. */
  overrides: Array<(method: string, path: string) => Answer | undefined>;
}

const ENDPOINT = "https://run9.example";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function headersOf(h: unknown): Record<string, string> {
  if (!h) return {};
  if (h instanceof Headers) return Object.fromEntries([...h.entries()]);
  return Object.fromEntries(Object.entries(h as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
}

async function bodyOf(b: unknown): Promise<unknown> {
  if (b === undefined || b === null) return null;
  if (b instanceof FormData) {
    const out: unknown[] = [];
    for (const [name, v] of b.entries()) {
      out.push(typeof v === "string" ? { name, value: v } : { name, filename: (v as File).name, size: v.size, sha256: sha(new Uint8Array(await v.arrayBuffer())) });
    }
    return { form: out };
  }
  const s = String(b);
  try { return { json: JSON.parse(s) }; } catch { return { text: s }; }
}

function fake(): Fake {
  const f: Fake = { log: [], execs: [], overrides: [] };
  const boxes = new Map<string, { state: string }>();
  const started = new Map<string, { command: string[]; answers: ExecAnswer[]; served: number; killed: boolean }>();
  const files = new Map<string, Uint8Array>();
  const secrets = new Map<string, Array<{ name: string; secret_id: string }>>();
  let execN = 0, secretN = 0, snapN = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    now += 1000;
    const method = String(init?.method ?? "GET");
    const u = String(url);
    if (!u.startsWith(ENDPOINT)) throw new Error(`a request left the fake: ${u}`);
    const path = u.slice(ENDPOINT.length);
    const h = headersOf(init?.headers);
    f.log.push({
      method, path,
      ...(h["content-type"] ? { contentType: h["content-type"] } : {}),
      ...(h.authorization ? { authorization: h.authorization } : {}),
      body: await bodyOf(init?.body),
      timeoutMs: (init?.signal as { timeoutMs?: number } | undefined)?.timeoutMs ?? null,
    });
    for (const o of f.overrides) {
      const a = o(method, path);
      if (a) return answer(a);
    }
    const p = path.replace(/^\/projects\/[^/]+\/workspace/, "");
    let m: RegExpExecArray | null;
    if (method === "GET" && path === "/whoami") return answer({ json: { org: { org_id: "org-1" } } });
    if (method === "GET" && path === "/credential") return answer({ json: { ok: true } });
    if (method === "POST" && p === "/boxes") {
      const body = JSON.parse(init.body);
      boxes.set(body.box_id, { state: "idle" });
      return answer({ json: { box_id: body.box_id, state: "ready" } });
    }
    if (method === "GET" && p === "/boxes") {
      return answer({ json: [{ box_id: "someone-elses", state: "idle", box_snap_id: "s-other" },
        ...[...boxes].map(([id, b]) => ({ box_id: id, state: b.state, box_snap_id: `s-${id}` }))] });
    }
    if ((m = /^\/boxes\/([^/]+)\/stop$/.exec(p)) && method === "POST") {
      const b = boxes.get(m[1]!);
      if (b) b.state = "stopped";
      return answer({ json: {} });
    }
    if ((m = /^\/boxes\/([^/]+)$/.exec(p))) {
      if (method === "GET") return boxes.has(m[1]!) ? answer({ json: { box_id: m[1] } }) : answer({ status: 400, json: { error: "box not found" } });
      if (method === "DELETE") {
        if (!boxes.delete(m[1]!)) return answer({ status: 400, json: { error: "box not found" } });
        return answer({ json: {} });
      }
    }
    if ((m = /^\/boxes\/([^/]+)\/background-execs$/.exec(p)) && method === "POST") {
      const body = JSON.parse(init.body);
      const id = `e${++execN}`;
      const b = boxes.get(m[1]!);
      if (b) b.state = "running";
      started.set(id, { command: body.command, answers: f.execs.shift() ?? [], served: 0, killed: false });
      return answer({ json: { exec_id: id } });
    }
    if ((m = /^\/execs\/([^/]+)\/kill$/.exec(p)) && method === "POST") {
      const e = started.get(m[1]!);
      if (!e) return answer({ status: 404, json: { error: "exec not found" } });
      e.killed = true;
      return answer({ json: {} });
    }
    if ((m = /^\/execs\/([^/]+)$/.exec(p)) && method === "GET") {
      const e = started.get(m[1]!);
      if (!e) return answer({ status: 404, json: { error: "exec not found" } });
      if (e.killed) return answer({ json: { state: "cancelled", exit_code: null, output_summary: "", reason: "explicit_cancel" } });
      if (e.answers.length) return answer({ json: e.answers[Math.min(e.served++, e.answers.length - 1)] });
      return answer({ json: defaultExec(e.command, files) });
    }
    if ((m = /^\/boxes\/([^/]+)\/files\/download$/.exec(p.split("?")[0]!)) && method === "GET") {
      const q = new URL(u).searchParams;
      return answer({ bytes: new TextEncoder().encode(`bytes of ${q.get("box_abs_path")}${q.get("archive") ? " as tar" : ""}`) });
    }
    if ((m = /^\/boxes\/([^/]+)\/files\/upload$/.exec(p.split("?")[0]!)) && method === "POST") {
      const at = new URL(u).searchParams.get("box_abs_path")!;
      const file = (init.body as FormData).get("file") as Blob;
      files.set(at, new Uint8Array(await file.arrayBuffer()));
      return answer({ json: { state: "prepared", kind: "upload" } });
    }
    if (p.startsWith("/data-transfers/active") && method === "GET") {
      return answer({ json: [{ box_id: "x", direction: "upload", state: "succeeded" }] });
    }
    if ((m = /^\/boxes\/([^/]+)\/secrets$/.exec(p))) {
      const list = secrets.get(m[1]!) ?? [];
      secrets.set(m[1]!, list);
      if (method === "POST") {
        list.push({ name: JSON.parse(init.body).name, secret_id: `sec${++secretN}` });
        return answer({ json: {} });
      }
      if (method === "GET") return answer({ json: list });
    }
    if ((m = /^\/boxes\/([^/]+)\/secrets\/([^/]+)$/.exec(p)) && method === "DELETE") {
      const list = secrets.get(m[1]!) ?? [];
      secrets.set(m[1]!, list.filter((s) => s.secret_id !== m![2]));
      return answer({ json: {} });
    }
    if ((m = /^\/snaps\/([^/]+)\/fork$/.exec(p)) && method === "POST") return answer({ json: { snap_id: `kept-${++snapN}` } });
    return answer({ status: 599, text: `the fake has no answer for ${method} ${path}` });
  }) as any;
  return f;
}

function answer(a: Answer): Response {
  const body = a.bytes ?? (a.text !== undefined ? a.text : JSON.stringify(a.json ?? {}));
  return new Response(body as string | Uint8Array<ArrayBuffer>, { status: a.status ?? 200 });
}

/** What run9 answers for a command nobody scripted: each kind of script the plugin sends gets its own. */
function defaultExec(command: string[], files: Map<string, Uint8Array>): ExecAnswer {
  const line = command.join(" ");
  if (line.includes("#total")) {
    return { state: "succeeded", exit_code: 0, output_summary: "f\t5\t1700000000.5\tout.txt\nd\t0\t1700000001\tsrc\n#total\t2\n" };
  }
  if (line.includes("realpath") && line.includes("-maxdepth 0")) {
    return { state: "succeeded", exit_code: 0, output_summary: "f\t13\t1700000002.25\t/work/out.txt\n" };
  }
  if (line.includes("sha256sum")) {
    const got = files.get(command[4]!);
    return got ? { state: "succeeded", exit_code: 0, output_summary: `${got.byteLength}\n${sha(got)}\n` } : { state: "failed", exit_code: 3, output_summary: "" };
  }
  if (line.includes("dirname")) return { state: "succeeded", exit_code: 0, output_summary: "" };
  return { state: "succeeded", exit_code: 0, output_summary: "hello\n__AP_CWD__/work\n" };
}

// ---- a mount

const LEASE: BoxLease = { warnMs: 300_000, maxMs: 1_800_000 };
const FORM: SandboxForm = {
  summary: "gh and git act as the agent's GitHub account.",
  egress: [
    { name: "GH_TOKEN", header: "authorization", hosts: ["api.github.com"], value: (c) => `token ${c}`, placeholder: (p) => `token ${p}` },
    { name: "GH_TOKEN_GIT", header: "authorization", hosts: ["github.com"], value: (c) => `Basic ${btoa(`x:${c}`)}`, placeholder: (p) => `Basic ${btoa(`x:${p}`)}` },
  ],
  env: (p) => ({ GH_TOKEN: p }),
};

function mount(o: { lease?: BoxLease | null; config?: Record<string, unknown>; credential?: string | null; forms?: () => string | null; refKind?: string } = {}) {
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
  const used: string[] = [];
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: o.credential === undefined ? JSON.stringify({ ak: "AK", sk: "SK" }) : o.credential,
    credentialRefKind: o.refKind ?? "operator",
    publicConfig: { endpoint: ENDPOINT, project: "p", graceMs: 3_000, ...(o.config ?? {}) },
    db: openPluginDatabase(tables, scope, plugin.database),
    sibling: async () => null,
    sandboxForms: async () => {
      const c = o.forms?.() ?? null;
      return c === null ? [] : [{ alias: "github", plugin: "github", form: FORM, credential: c, used: async () => { used.push("github"); } }];
    },
    offered: [],
  };
  const record = () => tables.get(scope, BOX_STORE, BOX_KEY);
  return { plugin, ctx, record, stored, used };
}

const locked = <T>(fn: () => Promise<T>) => fn();

/** One step's outcome: what it returned, or what it threw and the release fact riding on it. */
async function step(name: string, fn: () => Promise<unknown>, log: unknown[]): Promise<any> {
  try {
    const r = await fn();
    log.push({ step: name, result: r instanceof Uint8Array ? { bytes: new TextDecoder().decode(r) } : bytesOut(r) });
    return r;
  } catch (e) {
    const err = e as Error & { released?: unknown; identity?: unknown };
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

/** Placeholders carry a random part by design; everything else is the clock's or the fake's, so it stays. */
const normalise = (s: string) => s
  .replace(/__AP_([A-Za-z0-9_]+?)_[0-9a-f]{6}__/g, "__AP_$1_<fresh>__")
  .replace(/(Basic )([A-Za-z0-9+/=]{20,})/g, (all, pre, b64) => {
    try { const d = atob(b64); return /__AP_/.test(d) ? `${pre}<${d.replace(/__AP_([A-Za-z0-9_]+?)_[0-9a-f]{6}__/g, "__AP_$1_<fresh>__")}>` : all; } catch { return all; }
  });

// ---- the scenarios

const declared = (lease: BoxLease | null) => {
  const p = sandboxPlugin(null, "bucket", lease);
  return {
    id: p.id, version: p.version, provides: p.provides, database: p.database, credential: p.credential, config: p.config,
    holdsTools: p.holds?.tools, tools: p.tools,
  };
};

const SCENARIOS: Record<string, () => Promise<unknown[]>> = {
  async "the plugin as declared: tools, settings and credential, with and without a lease"() {
    return [declared(null), declared(LEASE)];
  },

  async "create, shell, run, save, keep, a credential replaced, release"() {
    const f = fake();
    let token = "ghp_first";
    const m = mount({ forms: () => token });
    const out = f.log;
    await step("shell creates the box and wires the account", () => m.plugin.invoke("shell", { command: "echo hello" }, m.ctx), out);
    await step("shell again, in a directory of its own", () => m.plugin.invoke("shell", { command: "ls", workdir: "src" }, m.ctx), out);
    await step("run with an install", () => m.plugin.invoke("run", { code: "import x from 'zod'; console.log(1)", install: ["zod"] }, m.ctx), out);
    await step("save a file", () => m.plugin.invoke("save", { path: "/work/out.txt" }, m.ctx), out);
    await step("save a directory as tar", () => m.plugin.invoke("save", { path: "/work/dist", archive: true }, m.ctx), out);
    await step("save a relative path is refused", () => m.plugin.invoke("save", { path: "out.txt" }, m.ctx), out);
    await step("keep the environment", () => m.plugin.invoke("keep", { name: "py-env", note: "python and git" }, m.ctx), out);
    token = "ghp_second";
    await step("shell after the credential was replaced", () => m.plugin.invoke("shell", { command: "gh auth status" }, m.ctx), out);
    await step("machines", () => m.plugin.invoke("machines", {}, m.ctx), out);
    await step("release, saving first", () => m.plugin.invoke("release", { save: ["/work/out.txt"] }, m.ctx), out);
    await step("release again", () => m.plugin.invoke("release", {}, m.ctx), out);
    return [...out, { stored: m.stored, used: m.used }, { record: m.record() }];
  },

  async "put a stored file into the box"() {
    const f = fake();
    const m = mount();
    const out = f.log;
    await step("put", () => m.plugin.invoke("put", { ref: "artifact://raft/attachments/7/photo.jpg", path: "in/photo.jpg" }, m.ctx), out);
    await step("put outside the working directory", () => m.plugin.invoke("put", { ref: "artifact://raft/attachments/7/photo.jpg", path: "/etc/x" }, m.ctx), out);
    return [...out, { record: m.record() }];
  },

  async "a command handed over as a job, polled and cancelled"() {
    const f = fake();
    const m = mount({ config: { graceMs: 0 } });
    f.execs.push([{ state: "running" }]);
    const out = f.log;
    const r: any = await step("shell is handed over", () => m.plugin.invoke("shell", { command: "sleep 100" }, m.ctx), out);
    const h = r?.handle;
    await step("poll while it runs", () => m.plugin.background!.poll(h, m.ctx), out);
    await step("cancel", () => m.plugin.background!.cancel(h, m.ctx), out);
    await step("poll once it is cancelled", () => m.plugin.background!.poll(h, m.ctx), out);
    f.execs.push([{ state: "succeeded", exit_code: 0, output_summary: "done\n" }]);
    await step("a second command finishes in the call", () => m.plugin.invoke("shell", { command: "true" }, m.ctx), out);
    f.overrides.push((method, path) => method === "POST" && path.endsWith("/kill") ? { status: 400, json: { error: "exec is not background mode" } } : undefined);
    f.execs.push([{ state: "running" }]);
    const r2: any = await step("a third is handed over", () => m.plugin.invoke("shell", { command: "sleep 100" }, m.ctx), out);
    const h2 = r2?.handle;
    await step("a refused kill is not confirmed", () => m.plugin.background!.cancel(h2, m.ctx), out);
    return [...out, { record: m.record() }];
  },

  async "the idle lease switches a box off, a command brings it back, and release deletes it"() {
    const f = fake();
    const m = mount({ lease: LEASE });
    const out = f.log;
    await step("shell", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    await step("activities while running", () => m.plugin.holds!.activities!(m.ctx), out);
    await step("idle release switches it off", () => m.plugin.holds!.release(m.ctx, { reason: "idle" }), out);
    await step("activities while off", () => m.plugin.holds!.activities!(m.ctx), out);
    await step("quiet while off", () => m.plugin.invoke("quiet", { minutes: 600 }, m.ctx), out);
    await step("shell brings it back", () => m.plugin.invoke("shell", { command: "echo back" }, m.ctx), out);
    await step("quiet while running", () => m.plugin.invoke("quiet", { minutes: 30 }, m.ctx), out);
    f.overrides.push((method, path) => method === "POST" && path.endsWith("/stop") ? { status: 503, text: "busy" } : undefined);
    await step("a stop run9 refuses", () => m.plugin.holds!.release(m.ctx, { reason: "idle" }), out);
    f.overrides.pop();
    await step("idle release switches it off again", () => m.plugin.holds!.release(m.ctx, { reason: "idle" }), out);
    await step("idle release of a switched-off box deletes it", () => m.plugin.holds!.release(m.ctx, { reason: "idle" }), out);
    await step("usage", () => m.plugin.holds!.usage!(m.ctx), out);
    return [...out, { record: m.record() }];
  },

  async "the workspace view lists and reads only an awake box"() {
    const f = fake();
    const m = mount();
    const out = f.log;
    await step("list with no box", () => m.plugin.holds!.files!.list(m.ctx, "", locked), out);
    await step("shell", () => m.plugin.invoke("shell", { command: "echo hi > out.txt" }, m.ctx), out);
    await step("list", () => m.plugin.holds!.files!.list(m.ctx, "", locked), out);
    await step("read", () => m.plugin.holds!.files!.read(m.ctx, "out.txt", 1000, locked), out);
    await step("read over the cap", () => m.plugin.holds!.files!.read(m.ctx, "out.txt", 5, locked), out);
    f.overrides.push((method, path) => method === "GET" && path.includes("/files/download") ? { status: 404, text: "no such file" } : undefined);
    await step("a download run9 refuses", () => m.plugin.holds!.files!.read(m.ctx, "out.txt", 1000, locked), out);
    await step("save that run9 refuses", () => m.plugin.invoke("save", { path: "/work/out.txt" }, m.ctx), out);
    f.overrides.pop();
    f.overrides.push((method, path) => method === "GET" && /\/workspace\/boxes$/.test(path) ? { json: [] } : undefined);
    await step("list when run9 does not list it", () => m.plugin.holds!.files!.list(m.ctx, "", locked), out);
    return [...out];
  },

  async "credential checks and the account"() {
    const f = fake();
    const out = f.log;
    const ask = (credential: string | null, config: Record<string, unknown> = {}) => {
      const m = mount({ credential, config });
      return { check: () => m.plugin.checkCredential!(m.ctx), account: () => m.plugin.credentialAccount!(m.ctx) };
    };
    const good = JSON.stringify({ ak: "AK", sk: "SK" });
    await step("good keys", () => ask(good).check(), out);
    await step("no keys", () => ask(null).check(), out);
    await step("not JSON", () => ask("ak=1").check(), out);
    await step("no sk", () => ask(JSON.stringify({ ak: "AK" })).check(), out);
    await step("verified by the endpoint", () => ask(good, { verifyWith: "endpoint" }).check(), out);
    for (const [status, text] of [[401, "{\"error\":\"invalid api key\"}"], [400, "{\"error\":\"project not found\"}"],
      [400, "{\"error\":\"project_cid must match [a-z0-9_-]{3,20}\"}"], [500, "oops"], [200, "{}"]] as const) {
      f.overrides.length = 0;
      f.overrides.push((method, path) => path.includes("b_credential_check_only") || path === "/credential" ? { status, text } : undefined);
      await step(`run9 answers ${status} ${text}`, () => ask(good).check(), out);
      await step(`the endpoint answers ${status}`, () => ask(good, { verifyWith: "endpoint" }).check(), out);
    }
    f.overrides.length = 0;
    await step("account", () => ask(good).account(), out);
    await step("account behind an endpoint", () => ask(good, { verifyWith: "endpoint" }).account(), out);
    await step("account of no keys", () => ask(null).account(), out);
    await step("account of keys that are not JSON", () => ask("x").account(), out);
    for (const status of [503, 429, 401]) {
      f.overrides.length = 0;
      f.overrides.push((method, path) => path === "/whoami" ? { status, text: "no" } : undefined);
      await step(`account when /whoami answers ${status}`, () => ask(good).account(), out);
    }
    f.overrides.length = 0;
    f.overrides.push((method, path) => path === "/whoami" ? { json: { org: {} } } : undefined);
    await step("account with no org id", () => ask(good).account(), out);
    return [...out];
  },

  async "a create whose answer was lost is adopted; one that was not is refused"() {
    const f = fake();
    const m = mount();
    const out = f.log;
    // The fake records the box on the first POST and this answer replaces run9's: the box exists, the answer is lost.
    const real = globalThis.fetch;
    let lost = true;
    globalThis.fetch = (async (url: string, init?: any) => {
      const r = await real(url, init);
      if (lost && init?.method === "POST" && /\/workspace\/boxes$/.test(String(url))) {
        lost = false;
        return new Response("{\"error\":\"duplicate key value violates unique constraint\"}", { status: 400 });
      }
      return r;
    }) as any;
    await step("shell whose create answered duplicate key", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    globalThis.fetch = real;
    await step("release", () => m.plugin.invoke("release", {}, m.ctx), out);
    f.overrides.push((method, path) => method === "POST" && /\/workspace\/boxes$/.test(path) ? { status: 400, text: "{\"error\":\"box already exists\"}" } : undefined);
    await step("shell whose create is refused and not listed", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    f.overrides.length = 0;
    f.overrides.push((method, path) => method === "POST" && /\/workspace\/boxes$/.test(path) ? { status: 429, text: "slow down" } : undefined);
    await step("shell whose create is rate limited", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    return [...out, { record: m.record() }];
  },

  async "a delete run9 refuses keeps the box, and forget drops it only after a definitive refusal"() {
    const f = fake();
    const m = mount();
    const out = f.log;
    await step("shell", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    f.overrides.push((method) => method === "DELETE" ? { status: 503, text: "{\"error\":\"try later\"}" } : undefined);
    await step("release refused by an outage", () => m.plugin.holds!.release(m.ctx), out);
    await step("forget after an outage does not forget", () => m.plugin.holds!.release(m.ctx, { forget: true }), out);
    f.overrides.length = 0;
    f.overrides.push((method) => method === "DELETE" ? { status: 403, text: "{\"error\":\"forbidden\"}" } : undefined);
    await step("the agent's release refused outright", () => m.plugin.invoke("release", {}, m.ctx), out);
    await step("forget after a definitive refusal", () => m.plugin.holds!.release(m.ctx, { forget: true }), out);
    f.overrides.length = 0;
    await step("shell makes a new box", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    f.overrides.push((method) => method === "DELETE" ? { status: 404, text: "gone" } : undefined);
    await step("already gone is believed for the key that made it", () => m.plugin.holds!.release(m.ctx), out);
    f.overrides.length = 0;
    f.overrides.push((method, path) => method === "POST" && path.endsWith("/stop") ? { status: 500, text: "stop failed" } : undefined);
    await step("shell", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    await step("a stop that fails before the delete does not stop the delete", () => m.plugin.holds!.release(m.ctx), out);
    return [...out, { record: m.record() }];
  },

  async "start_from a kept environment, and a named machine"() {
    const f = fake();
    const m = mount();
    const out = f.log;
    await step("start_from lists nothing", () => m.plugin.invoke("start_from", {}, m.ctx), out);
    await step("shell", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    await step("keep", () => m.plugin.invoke("keep", { name: "base" }, m.ctx), out);
    await step("start_from base releases the box", () => m.plugin.invoke("start_from", { name: "base" }, m.ctx), out);
    await step("shell starts from the snapshot", () => m.plugin.invoke("shell", { command: "echo from" }, m.ctx), out);
    await step("shell on a named machine", () => m.plugin.invoke("shell", { command: "echo two", machine: "two" }, m.ctx), out);
    await step("keep from a machine that does not exist", () => m.plugin.invoke("keep", { name: "x", machine: "three" }, m.ctx), out);
    f.overrides.push((method, path) => method === "GET" && /\/workspace\/boxes$/.test(path) ? { json: [] } : undefined);
    await step("keep when run9 lists no filesystem", () => m.plugin.invoke("keep", { name: "y" }, m.ctx), out);
    f.overrides.length = 0;
    f.overrides.push((method, path) => method === "POST" && path.endsWith("/fork") ? { json: { nope: true } } : undefined);
    await step("keep when the fork returns no snapshot", () => m.plugin.invoke("keep", { name: "z" }, m.ctx), out);
    f.overrides.length = 0;
    await step("activity", () => m.plugin.holds!.activity!(m.ctx), out);
    await step("release all", () => m.plugin.holds!.release(m.ctx), out);
    return [...out, { record: m.record() }];
  },

  async "a stranded box is deleted with the new key, whose not-found is not believed"() {
    const f = fake();
    const m = mount({ refKind: "operator" });
    const out = f.log;
    const r: any = await step("shell", () => m.plugin.invoke("shell", { command: "echo hi" }, m.ctx), out);
    await step("strand it", () => m.plugin.holds!.strand!(m.ctx, r?.box, "the key stopped working"), out);
    m.ctx.credentialRefKind = "agent";
    f.overrides.push((method) => method === "DELETE" ? { status: 400, text: "{\"error\":\"box not found\"}" } : undefined);
    await step("release: not found is not believed", () => m.plugin.holds!.release(m.ctx), out);
    await step("release again before the retry is due", () => m.plugin.holds!.release(m.ctx), out);
    await step("forget after a definitive refusal", () => m.plugin.holds!.release(m.ctx, { forget: true }), out);
    return [...out, { record: m.record() }];
  },

  async "a working directory run9 cannot start in"() {
    const f = fake();
    const m = mount();
    const out = f.log;
    await step("shell", () => m.plugin.invoke("shell", { command: "mkdir -p /tmp/x && cd /tmp/x" }, m.ctx), out);
    f.execs.push([{ state: "succeeded", exit_code: 0, output_summary: "__AP_CWD__/tmp/x\n" }]);
    await step("shell ends under /tmp", () => m.plugin.invoke("shell", { command: "cd /tmp/x" }, m.ctx), out);
    f.execs.push([{ state: "error", reason: "failed to start: chdir /tmp/x: no such file or directory" }]);
    await step("the remembered directory is gone", () => m.plugin.invoke("shell", { command: "pwd" }, m.ctx), out);
    f.execs.push([{ state: "error", reason: "failed to start: chdir /nope: no such file or directory" }]);
    await step("an asked directory that does not exist", () => m.plugin.invoke("shell", { command: "pwd", workdir: "/nope" }, m.ctx), out);
    f.execs.push([{ state: "error", reason: "platform trouble" }]);
    await step("an exec that errs otherwise", () => m.plugin.invoke("shell", { command: "pwd" }, m.ctx), out);
    f.overrides.push((method, path) => method === "GET" && /\/execs\//.test(path) ? { status: 502, text: "<html>bad gateway</html>" } : undefined);
    await step("an exec status run9 cannot answer", () => m.plugin.invoke("shell", { command: "pwd" }, m.ctx), out);
    f.overrides.length = 0;
    await step("no credential", () => m.plugin.invoke("shell", { command: "pwd" }, { ...m.ctx, credential: null }), out);
    await step("poll with no credential", () => m.plugin.background!.poll({ boxId: "b", execId: "e1" }, { ...m.ctx, credential: null }), out);
    return [...out, { record: m.record() }];
  },
};

// ---- compare

const golden: Record<string, unknown[]> = UPDATE ? {} : JSON.parse(readFileSync(GOLDEN, "utf8"));
const got: Record<string, unknown[]> = {};
for (const [name, run] of Object.entries(SCENARIOS)) {
  now = T0;
  got[name] = JSON.parse(normalise(JSON.stringify(await run())));
  if (UPDATE) continue;
  await check(name, () => {
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
await check("the fake was reached and the plugin made requests in every scenario that drives it", () => {
  for (const [name, entries] of Object.entries(got)) {
    if (name.startsWith("the plugin as declared")) continue;
    if (!entries.some((e: any) => e && typeof e.method === "string")) throw new Error(`${name} made no request`);
  }
});

Date.now = realNow;
AbortSignal.timeout = realTimeout;
if (UPDATE) {
  writeFileSync(GOLDEN, JSON.stringify(got, null, 1) + "\n");
  console.log(`wrote ${Object.keys(got).length} scenarios to ${GOLDEN.pathname}`);
}
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.ok ? "" : `\n    ${r.error}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
