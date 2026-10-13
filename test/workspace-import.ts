/**
 * A migrating agent's workspace import (`POST /provision/agents/{agentId}/import`) and the hold that keeps a new
 * agent from running before it (`awaitImport`), through the Worker's own `fetch`, the real migrations on node:sqlite
 * and the whole `AgentDO` under node, as test/eval-seed-object.ts runs the evaluation routes: the files read back
 * through the workspace route exactly as sent, every bound and path rule, the retry, the second import, the agent
 * that has run, another tenant's token, a storage failure part-way (nothing visible, and the retry lands), the route
 * being production (not behind EVAL_SEED_ROUTES), the audit line, and the hold: pushes queued and no turn until the
 * import, the 24-hour valve, and `awaitImport` in a create's replay.
 */
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import type { Plugin } from "../src/plugins/types.ts";
import { agentObjectName } from "../cf/src/object-name.ts";
import { d1ProviderTokens, d1ProvisionedAgents } from "../cf/src/control-plane.ts";
import { hashProviderToken, newProviderToken } from "../cf/src/provider-token.ts";
import { sha256Hex } from "../src/store/seed-files.ts";
import { IMPORT_HOLD_MAX_MS } from "../src/store/workspace-import.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { AgentDO, default: worker } = await import("../cf/src/index.ts");
const { clearHookRoutes } = await import("../cf/src/hook-route.ts");
const { setLogSink } = await import("../src/core/log.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

const T = "t-raft", A = "raft_01JMIG", RAFT_ID = "01JMIG", OTHER_T = "t-other", AUTOMATION = "operator-token";
const MIB = 1024 * 1024;

const lines: string[] = [];
setLogSink((line) => { lines.push(line); });

/** A push plugin as in test/eval-seed-object.ts: the hook's secret in a header, `{id, text}` as the body. */
const pushy: Plugin = {
  id: "pushy", version: "1.0.0",
  tools: [{ name: "noop", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() { return {} as never; },
  async receive(event, secret) {
    if (event.headers["x-signed-with"] !== secret) return { deliver: false, reason: "bad signature", rejected: true };
    const body = JSON.parse(new TextDecoder().decode(event.body)) as { id: string; text: string };
    return { deliver: true, text: body.text, dedupeKey: body.id };
  },
};

/** D1 as node:sqlite, with every migration in cf/migrations applied. `failOn` makes a statement matching it throw once. */
function d1() {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(f, dir), "utf8"));
  const fault = { failOn: null as RegExp | null };
  const guard = (q: string) => { if (fault.failOn?.test(q)) { fault.failOn = null; throw new Error("D1 is away"); } };
  const stmt = (q: string, b: unknown[] = []): any => ({
    q, b,
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.prepare(q).get(...(b as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...(b as any[])) }),
    run: async () => { guard(q); return { meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }; },
  });
  return {
    raw: db, fault,
    prepare: (q: string) => stmt(q),
    batch: async (s: any[]) => s.map((x) => ({ results: [], meta: { changes: Number(db.prepare(x.q).run(...(x.b as any[])).changes) } })),
  } as unknown as D1Database & { raw: DatabaseSync; fault: { failOn: RegExp | null } };
}

/** The artifacts bucket, kept. `failPutAfter`: that many puts succeed, then one throws (once). */
function bucket() {
  const objects = new Map<string, Uint8Array>();
  const fault = { failPutAfter: null as number | null };
  const view = (key: string, bytes: Uint8Array) => ({
    key, size: bytes.byteLength, uploaded: new Date(1), httpMetadata: {},
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
  return {
    objects, fault,
    put: async (key: string, body: Uint8Array | string) => {
      if (fault.failPutAfter !== null && fault.failPutAfter-- <= 0) { fault.failPutAfter = null; throw new Error("R2 is away"); }
      objects.set(key, typeof body === "string" ? new TextEncoder().encode(body) : new Uint8Array(body));
      // A real put yields; the concurrency case needs two imports to interleave here.
      await sleep(1);
      return {};
    },
    get: async (key: string) => (objects.has(key) ? view(key, objects.get(key)!) : null),
    head: async (key: string) => (objects.has(key) ? view(key, objects.get(key)!) : null),
    delete: async (keys: string | string[]) => { for (const k of [keys].flat()) objects.delete(k); },
    list: async (o: { prefix?: string }) => ({
      objects: [...objects.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((k) => view(k, objects.get(k)!)),
      delimitedPrefixes: [], truncated: false,
    }),
  };
}

const RAFT_CRED = "sk_agent_" + "M".repeat(32);

/**
 * The deployment, two tenant tokens, and the agent made by Raft's own `POST /provision/agents` (with `post` added to
 * its body). `flag` is EVAL_SEED_ROUTES as the deployment sets it; null for production. `pushy` adds a push hook.
 */
async function world(opts: { flag?: string | null; post?: Record<string, unknown>; pushy?: boolean } = {}) {
  clearHookRoutes();
  const DB = d1();
  const raw = sqliteHost();
  const jobs: string[] = [];
  let alarmAt: number | null = null;
  // The object's SQL, with a fault a case can arm: the n-th `INSERT INTO agent_state` throws.
  const sqlFault = { failAfter: null as number | null };
  const sql = {
    exec(q: string, ...b: unknown[]) {
      if (sqlFault.failAfter !== null && q.includes("INSERT INTO agent_state") && sqlFault.failAfter-- <= 0) {
        sqlFault.failAfter = null;
        throw new Error("SQLITE_FULL: injected");
      }
      return raw.sql.exec(q, ...b);
    },
  };
  const ctx = {
    storage: {
      sql, transactionSync: raw.transactionSync,
      getAlarm: async () => alarmAt, setAlarm: async (at: number) => { alarmAt = at; }, deleteAlarm: async () => { alarmAt = null; },
    },
    blockConcurrencyWhile: async <R>(fn: () => Promise<R>) => fn(),
    id: { toString: () => "do-1" }, getWebSockets: () => [], exports: {},
  };
  class TestDO extends AgentDO { protected override extraPlugins() { return [pushy]; } }
  const objects = new Map<string, InstanceType<typeof TestDO>>();
  const another = (n: string) => {
    const host = sqliteHost();
    const o = new TestDO({ ...ctx, storage: { ...ctx.storage, sql: host.sql, transactionSync: host.transactionSync }, id: { toString: () => n } } as never, env as never);
    objects.set(n, o);
    return o;
  };
  const R2 = bucket();
  const env: Record<string, unknown> = {
    MODEL_QUEUE: { send: async (m: { jobId: string }) => { jobs.push(m.jobId); } },
    ARTIFACTS: R2, ARTIFACT_BUCKET: "b", CONTROL_DB: DB, HARNESS_MODEL: "m1",
    DEEPSEEK_BASE_URL: "https://model.example/v1", DEEPSEEK_API_KEY: "k", AUTOMATION_TOKEN: AUTOMATION,
    SECRET_KEK: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    ...(opts.flag == null ? {} : { EVAL_SEED_ROUTES: opts.flag }),
    AGENT: { idFromName: (n: string) => n, get: (n: string) => objects.get(n) ?? another(n) },
  };
  const D = new TestDO(ctx as never, env as never);
  objects.set(agentObjectName(T, A), D);
  const token = newProviderToken(), other = newProviderToken();
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(token), label: "raft-test", raftOrigin: "https://raft.example", scope: "tenant", tenantId: T });
  await d1ProviderTokens(DB).issue({ hash: await hashProviderToken(other), label: "raft-other", raftOrigin: "https://raft.example", scope: "tenant", tenantId: OTHER_T });
  const w0 = { D, rt: D.runtime(), raw, sqlFault, DB, R2, env, jobs, token, other, tokenHash: await hashProviderToken(token), alarmAt: () => alarmAt, hook: { hookId: "", secret: "" } };
  const posted = await provisionPost(w0, opts.post ?? {});
  must(posted.status === 201, `POST /provision/agents: ${posted.status} ${posted.text}`);
  await w0.rt.ready();
  if (opts.pushy) {
    await w0.rt.store.setPluginChoice(T, A, "pushy", "enable");
    await w0.rt.store.addMount({ tenantId: T, agentId: A, alias: "p", plugin: "pushy", installationId: "i-p", connectionId: null,
      toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null });
    const made = await (await worker.fetch(new Request("https://x/admin/hooks", {
      method: "POST", headers: { "x-harness-token": AUTOMATION, "content-type": "application/json" },
      body: JSON.stringify({ tenantId: T, agentId: A, alias: "p" }),
    }), env as never)).json() as { hookId: string; secret: string };
    must(made.hookId && made.secret, `hook: ${show(made)}`);
    w0.hook = made;
  }
  return w0;
}
type World = Awaited<ReturnType<typeof world>>;

/** `POST /provision/agents` as Raft sends it, with Raft stood in for by a fetch that answers the credential's check. */
async function provisionPost(w: { env: Record<string, unknown>; token: string }, extra: Record<string, unknown>) {
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers ?? {});
    if (String(url) === "https://raft.example/internal/agent-api" && headers.get("authorization") === `Bearer ${RAFT_CRED}`) {
      return Response.json({ agentId: "ag-1", agentName: "mig", agentDisplayName: "Mig", serverId: "srv-1" });
    }
    return Response.json({ errorCode: "NOT_FOUND" }, { status: 404 });
  }) as typeof fetch;
  try {
    const res = await worker.fetch(new Request("https://x/provision/agents", {
      method: "POST", headers: { authorization: `Bearer ${w.token}`, "content-type": "application/json" },
      body: JSON.stringify({ raftAgentId: RAFT_ID, raftServerId: "srv-1", raftOrigin: "https://raft.example", name: "n", instructions: "", credential: RAFT_CRED, ...extra }),
    }), w.env as never);
    const text = await res.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: res.status, body, text };
  } finally { globalThis.fetch = real; }
}

/** A provider route under /provision, as Raft calls it. */
async function call(w: World, method: string, path: string, opts: { body?: BodyInit; auth?: string | null } = {}) {
  const auth = opts.auth === undefined ? w.token : opts.auth;
  const res = await worker.fetch(new Request(`https://x/provision/${path}`, {
    method, headers: auth === null ? {} : { authorization: `Bearer ${auth}` }, ...(opts.body === undefined ? {} : { body: opts.body }),
  }), w.env as never);
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: res.status, body, text };
}

type F = { path: string; bytes: Uint8Array | string };
const enc = (b: Uint8Array | string) => typeof b === "string" ? new TextEncoder().encode(b) : b;
const file = (f: F) => { const b = enc(f.bytes); return { path: f.path, contentBase64: Buffer.from(b).toString("base64"), sha256: sha256Hex(b) }; };
/** An import body: the files as Raft's exporter sends them, `totalBytes` their sum unless given. */
function body(migrationId: string, files: F[], extra: Record<string, unknown> = {}) {
  return { migrationId, files: files.map(file), totalBytes: files.reduce((n, f) => n + enc(f.bytes).byteLength, 0), ...extra };
}
const imp = (w: World, b: unknown, opts: { auth?: string | null; path?: string } = {}) =>
  call(w, "POST", opts.path ?? `agents/${A}/import`, { body: typeof b === "string" ? b : JSON.stringify(b), auth: opts.auth });
const readFile = (w: World, path: string) => call(w, "GET", `agents/${A}/workspace-files/read?path=${encodeURIComponent("state/" + path)}`);

/** Every state row of the agent, and whether an import is recorded: what "nothing written" is checked against. */
const stateKeys = async (w: World) => (await w.rt.store.listState(T, A, "", 10_000)).map((r) => r.key);
const imported = (w: World) => {
  try { return w.raw.sql.exec("SELECT COUNT(*) AS n FROM workspace_import").toArray()[0]!.n as number; }
  catch { return 0; }
};
async function nothingWritten(w: World, what: string) {
  const keys = await stateKeys(w);
  must(keys.length === 0, `${what}: state rows were written: ${show(keys.slice(0, 5))}`);
  must(imported(w) === 0, `${what}: an import was recorded`);
  const spilled = [...w.R2.objects.keys()].filter((k) => k.includes("/import/"));
  must(spilled.length === 0, `${what}: objects left in the bucket: ${show(spilled)}`);
}

async function push(w: World, id: string, text: string) {
  const res = await worker.fetch(new Request(`https://x/hooks/${w.hook.hookId}`, {
    method: "POST", headers: { "x-signed-with": w.hook.secret, "content-type": "application/json" }, body: JSON.stringify({ id, text }),
  }), w.env as never);
  return { status: res.status, body: await res.text() };
}

/** Alarm passes until the model has been asked `n` things, or nothing is due soon (test/hook-fast-ack.ts). */
async function settle(w: World, n: number) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && w.jobs.length < n) {
    await w.D.alarm();
    if (w.jobs.length >= n) return;
    const at = w.alarmAt();
    if (at === null || at - Date.now() > 5_000) return;
    await sleep(Math.min(Math.max(0, at - Date.now()), 50));
  }
}
const asked = async (w: World, i: number) => show(await w.D.takeJob(T, A, w.jobs[i]!));
const jobCount = (w: World) => w.jobs.length;
const pending = (w: World) => {
  try { return w.raw.sql.exec("SELECT COUNT(*) AS n FROM inbound_pending").toArray()[0]!.n as number; }
  catch { return 0; }
};
/** The hold's trace rows, wherever they are: still in the object's outbox, or exported to the bucket by a pass. */
const holdRows = (w: World) => {
  let local: any[] = [];
  try { local = w.raw.sql.exec("SELECT kind, status, verdict, attrs FROM trace_outbox WHERE kind = 'import.hold'").toArray().map((r: any) => ({ ...r, attrs: JSON.parse(r.attrs) })); }
  catch { /* no outbox yet */ }
  const exported = [...w.R2.objects.values()].flatMap((b) => new TextDecoder().decode(b).split("\n"))
    .filter((l) => l.includes('"import.hold"')).map((l) => JSON.parse(l))
    .map((r) => ({ kind: r.kind, status: r.status, verdict: r.verdict, attrs: typeof r.attrs === "string" ? JSON.parse(r.attrs) : r.attrs }));
  return [...exported, ...local];
};
const tables = (w: World) => w.raw.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r: any) => String(r.name));

const uuid = () => crypto.randomUUID();
/** Text past the state row's inline bound (32 KiB as JSON), so it is spilled to object storage. */
const LARGE = "line of the agent's notes ✓\n".repeat(2_000);

// ---- the import --------------------------------------------------------------------------------

await check("happy path: every file reads back through workspace-files exactly as imported; instructions applied as a PATCH applies them", async () => {
  const w = await world();
  const files: F[] = [
    { path: "MEMORY.md", bytes: "# Memory\nthe user prefers short answers\n" },
    { path: "./notes//2026/plan.md", bytes: "plan: ship it 🚀\n" },
    { path: "notes/big.log", bytes: LARGE },
    { path: "empty.txt", bytes: "" },
    // Past the seed route's 256 KiB bound and under the read's 1 MiB, with a BOM: read back whole, byte for byte.
    { path: "notes/long.md", bytes: "\uFEFF" + "长".repeat(200_000) },
  ];
  const id = uuid();
  const r = await imp(w, body(id, files, { instructions: "You migrated here from a laptop." }));
  must(r.status === 201, `import: ${r.status} ${r.text}`);
  const total = files.reduce((n, f) => n + enc(f.bytes).byteLength, 0);
  must(r.body.migrationId === id && r.body.providerAgentId === A && r.body.raftAgentId === RAFT_ID && r.body.fileCount === 5
    && r.body.totalBytes === total && r.body.instructions === true, `answer: ${show({ ...r.body, files: undefined })}`);
  must(show(r.body.files.map((f: any) => f.path)) === show(["MEMORY.md", "empty.txt", "notes/2026/plan.md", "notes/big.log", "notes/long.md"]), `paths: ${show(r.body.files)}`);
  for (const f of files) {
    const key = f.path.replace(/^\.\//, "").replace(/\/\//g, "/");
    const got = await readFile(w, key);
    const text = typeof f.bytes === "string" ? f.bytes : "";
    must(got.status === 200 && got.body.content === text && got.body.sha256 === sha256Hex(text) && got.body.encoding === "utf-8",
      `${key}: ${got.status} ${got.text.slice(0, 200)}`);
  }
  must([...w.R2.objects.keys()].some((k) => k.startsWith(`t/${T}/${A}/import/`)), "the large file was not spilled");
  const listed = await call(w, "GET", `agents/${A}/workspace-files?dirPath=state/notes/`);
  must(listed.status === 200 && show(listed.body.files.map((f: any) => f.name)) === show(["2026", "big.log", "long.md"]), `listing: ${listed.text}`);
  must((await d1ProvisionedAgents(w.DB).get(T, RAFT_ID))?.instructions === "You migrated here from a laptop.", "registry instructions");
  must(((await w.rt.store.loadAgent(T, A))?.config as any)?.description === "You migrated here from a laptop.", "the agent's record");
  // Through the state plugin the agent itself uses, too.
  must((await w.rt.store.getState(T, A, "MEMORY.md"))?.value === "# Memory\nthe user prefers short answers\n", "state get");
});

await check("GET /provision/import-limits answers the bounds Raft's exporter applies", async () => {
  const w = await world();
  const r = await call(w, "GET", "import-limits");
  must(r.status === 200 && show(r.body) === show({ maxTotalBytes: 10 * MIB, maxFiles: 2000, maxFileBytes: 2 * MIB }), `${r.status} ${r.text}`);
  const none = await call(w, "GET", "import-limits", { auth: null });
  must(none.status === 401, `no token: ${none.status}`);
});

await check("bounds: 2,000 files and a 2 MiB file and 10 MiB together are taken; one more of each is 413 naming the field, and nothing is written", async () => {
  const w = await world();
  const many = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `f/${i}.txt`, bytes: `${i}` }));
  const r1 = await imp(w, body(uuid(), many(2001)));
  must(r1.status === 413 && r1.body.error.param === "files" && r1.body.error.code === "too_many_files", `2001: ${r1.status} ${r1.text}`);
  await nothingWritten(w, "2001 files");
  const big = (n: number) => "x".repeat(n);
  const r2 = await imp(w, body(uuid(), [{ path: "a.txt", bytes: big(2 * MIB + 1) }]));
  must(r2.status === 413 && r2.body.error.param === "files[0].contentBase64" && r2.body.error.code === "file_too_large", `2 MiB + 1: ${r2.status} ${r2.text}`);
  await nothingWritten(w, "2 MiB + 1");
  // Five files of 2 MiB and one byte more, under a totalBytes that claims the bound: refused at the file past it.
  const over = [...Array.from({ length: 5 }, (_, i) => ({ path: `b${i}.txt`, bytes: big(2 * MIB) })), { path: "b5.txt", bytes: "y" }];
  const r3 = await imp(w, { ...body(uuid(), over), totalBytes: 10 * MIB });
  must(r3.status === 413 && r3.body.error.param === "files" && r3.body.error.code === "too_large", `10 MiB + 1: ${r3.status} ${r3.text.slice(0, 300)}`);
  const r4 = await imp(w, { ...body(uuid(), [{ path: "a.txt", bytes: "x" }]), totalBytes: 10 * MIB + 1 });
  must(r4.status === 413 && r4.body.error.param === "totalBytes", `totalBytes over: ${r4.status} ${r4.text.slice(0, 300)}`);
  await nothingWritten(w, "10 MiB + 1");
  const r5 = await imp(w, body(uuid(), [{ path: "a.txt", bytes: "x" }], { instructions: "i".repeat(8001) }));
  must(r5.status === 422 && r5.body.error.param === "instructions", `instructions 8001: ${r5.status} ${r5.text}`);
  await nothingWritten(w, "instructions");
  const r6 = await imp(w, "{\"migrationId\":\"" + "x".repeat(16 * MIB) + "\"}");
  must(r6.status === 413 && r6.body.error.param === "body", `16 MiB request: ${r6.status} ${r6.text.slice(0, 200)}`);
  await nothingWritten(w, "request");
  // Exactly at every bound: taken.
  const five = Array.from({ length: 5 }, (_, i) => ({ path: `c${i}.txt`, bytes: big(2 * MIB) }));
  const ok = await imp(w, body(uuid(), five, { instructions: "i".repeat(8000) }));
  must(ok.status === 201 && ok.body.totalBytes === 10 * MIB, `10 MiB exactly: ${ok.status} ${ok.text.slice(0, 300)}`);
  const w2 = await world();
  const ok2 = await imp(w2, body(uuid(), many(2000)));
  must(ok2.status === 201 && ok2.body.fileCount === 2000, `2000 files: ${ok2.status} ${ok2.text.slice(0, 300)}`);
  must((await stateKeys(w2)).length === 2000, "2000 rows");
});

await check("paths: traversal, absolute, backslash, control characters, a directory, reserved names and a duplicate are 422 naming the path; nothing is written", async () => {
  const w = await world();
  const bad: Array<[string, string]> = [
    ["../etc/passwd", "invalid"], ["a/../../b", "invalid"], ["..", "invalid"], ["/etc/passwd", "invalid"], ["a\\b", "invalid"],
    ["a\u0000b", "invalid"], ["a\nb", "invalid"], ["a\u007fb", "invalid"], ["notes/", "invalid"], ["", "invalid"],
    ["with space.md", "invalid"], ["C:/x", "invalid"], ["x".repeat(129), "invalid"],
    ["kept:token", "reserved"], ["memory", "reserved"], ["todo", "reserved"], ["journal", "reserved"], ["./memory", "reserved"],
  ];
  for (const [path, code] of bad) {
    const r = await imp(w, body(uuid(), [{ path: "ok.txt", bytes: "fine" }, { path, bytes: "x" }]));
    must(r.status === 422 && r.body.error.param === "files[1].path" && r.body.error.code === code, `${show(path)}: ${r.status} ${r.text}`);
  }
  const dup = await imp(w, body(uuid(), [{ path: "a/b.md", bytes: "1" }, { path: "./a//b.md", bytes: "2" }]));
  must(dup.status === 422 && dup.body.error.code === "duplicate_path" && dup.body.error.param === "files[1].path", `duplicate: ${dup.text}`);
  // Said as what they are, not as a key-rule miss: the reader is told which character to drop.
  for (const path of ["a\\b", "a\u0001b"]) {
    const r = await imp(w, body(uuid(), [{ path, bytes: "x" }]));
    must(/backslash or a control character/.test(r.body?.error?.message ?? ""), `${show(path)}: ${r.text}`);
  }
  for (const [path, says] of [["../x", "`..` segment"], ["/x", "relative"], ["x/", "directory"]] as const) {
    const r = await imp(w, body(uuid(), [{ path, bytes: "x" }]));
    must(String(r.body?.error?.message ?? "").includes(says), `${path}: ${r.text}`);
  }
  await nothingWritten(w, "paths");
});

await check("contents: a wrong sha256, a wrong totalBytes, bytes that are not UTF-8 text, a credential, and a utf-8 `content` field are refused naming the field", async () => {
  const w = await world();
  const good = file({ path: "a.txt", bytes: "hello" });
  const cases: Array<[string, unknown, number, string, string]> = [
    ["sha256 of other bytes", { migrationId: uuid(), files: [{ ...good, sha256: sha256Hex("other") }], totalBytes: 5 }, 422, "files[0].sha256", "sha256_mismatch"],
    ["sha256 not hex", { migrationId: uuid(), files: [{ ...good, sha256: "zz" }], totalBytes: 5 }, 422, "files[0].sha256", "invalid"],
    ["totalBytes off by one", { migrationId: uuid(), files: [good], totalBytes: 6 }, 422, "totalBytes", "total_mismatch"],
    ["totalBytes missing", { migrationId: uuid(), files: [good] }, 422, "totalBytes", "invalid"],
    ["not base64", { migrationId: uuid(), files: [{ ...good, contentBase64: "aGVsbG8" }], totalBytes: 5 }, 422, "files[0].contentBase64", "invalid"],
    ["invalid UTF-8", body(uuid(), [{ path: "b.bin", bytes: new Uint8Array([0xff, 0xfe, 0x00, 0x41]) }]), 422, "files[0].contentBase64", "not_text"],
    ["a NUL", body(uuid(), [{ path: "b.txt", bytes: "a\u0000b" }]), 422, "files[0].contentBase64", "not_text"],
    ["a credential", body(uuid(), [{ path: "c.txt", bytes: "key: sk-ant-api03-" + "A".repeat(90) }]), 422, "files[0].contentBase64", "credential_in_text"],
    ["utf-8 content", { migrationId: uuid(), files: [{ path: "a.txt", content: "hello", sha256: sha256Hex("hello") }], totalBytes: 5 }, 400, "files[0].content", "unknown_field"],
    ["an unknown top-level field", { ...body(uuid(), []), importId: "x" }, 400, "importId", "unknown_field"],
    ["no migrationId", { files: [], totalBytes: 0 }, 422, "migrationId", "invalid"],
    ["a migrationId with a slash", { migrationId: "a/b", files: [], totalBytes: 0 }, 422, "migrationId", "invalid"],
  ];
  for (const [what, b, status, param, code] of cases) {
    const r = await imp(w, b);
    must(r.status === status && r.body?.error?.param === param && r.body.error.code === code, `${what}: ${r.status} ${r.text.slice(0, 300)}`);
  }
  const notJson = await imp(w, "{not json");
  must(notJson.status === 400 && notJson.body.error.code === "invalid_json", `not JSON: ${notJson.text}`);
  await nothingWritten(w, "contents");
});

await check("idempotent: the same migrationId and body again answers the same body (200), writes nothing more; a different one is 409 already_imported", async () => {
  const w = await world();
  const id = uuid();
  const files: F[] = [{ path: "a.md", bytes: "one" }, { path: "b/big.txt", bytes: LARGE }];
  const first = await imp(w, body(id, files, { instructions: "be brief" }));
  must(first.status === 201, `first: ${first.text}`);
  const objects = w.R2.objects.size;
  const updated = (await w.rt.store.getState(T, A, "a.md"))?.updatedAt;
  // The files in another order are the same import: paths are unique, so their order means nothing.
  const again = await imp(w, body(id, [...files].reverse(), { instructions: "be brief" }));
  must(again.status === 200 && again.text === first.text, `replay: ${again.status} ${again.text}`);
  must(w.R2.objects.size === objects, `the replay left objects: ${w.R2.objects.size} vs ${objects}`);
  must((await w.rt.store.getState(T, A, "a.md"))?.updatedAt === updated, "the replay rewrote a row");
  for (const [what, b] of [
    ["another migrationId", body(uuid(), files, { instructions: "be brief" })],
    ["the same id, another file", body(id, [{ path: "a.md", bytes: "two" }, files[1]!], { instructions: "be brief" })],
    ["the same id, other instructions", body(id, files, { instructions: "be long" })],
    ["the same id, no instructions", body(id, files)],
  ] as const) {
    const r = await imp(w, b);
    must(r.status === 409 && r.body.error.code === "already_imported", `${what}: ${r.status} ${r.text}`);
  }
  must((await readFile(w, "a.md")).body.content === "one", "a refused import changed a file");
  must(w.R2.objects.size === objects, "a refused import left objects");
  // The by-raft-agent path reaches the same agent and the same answer.
  const byRaft = await imp(w, body(id, files, { instructions: "be brief" }), { path: `agents/by-raft-agent/${RAFT_ID}/import` });
  must(byRaft.status === 200 && byRaft.text === first.text, `by Raft id: ${byRaft.status} ${byRaft.text}`);
});

await check("two different imports at once: one lands (201), the other is 409, and only the winner's files and objects remain", async () => {
  const w = await world();
  const [a, b] = await Promise.all([
    imp(w, body(uuid(), [{ path: "x.txt", bytes: LARGE + "A" }, { path: "y.txt", bytes: "a" }])),
    imp(w, body(uuid(), [{ path: "x.txt", bytes: LARGE + "B" }, { path: "z.txt", bytes: "b" }])),
  ]);
  const statuses = [a.status, b.status].sort();
  must(show(statuses) === show([201, 409]), `statuses: ${a.status} ${b.status} ${a.text.slice(0, 200)} ${b.text.slice(0, 200)}`);
  const won = a.status === 201 ? "A" : "B";
  must((await readFile(w, "x.txt")).body.content === LARGE + won, "x.txt is not the winner's");
  must(show(await stateKeys(w)) === show(won === "A" ? ["x.txt", "y.txt"] : ["x.txt", "z.txt"]), `keys: ${show(await stateKeys(w))}`);
  must([...w.R2.objects.keys()].filter((k) => k.includes("/import/")).length === 1, `objects: ${show([...w.R2.objects.keys()])}`);
});

await check("agent_active: an agent whose main conversation has a turn is 409 and nothing is written", async () => {
  const w = await world();
  await w.rt.postMessage(T, A, "a real turn", "prompt");
  await settle(w, 1);
  must(jobCount(w) === 1, `the turn did not run: ${jobCount(w)}`);
  const before = await stateKeys(w);
  const r = await imp(w, body(uuid(), [{ path: "a.md", bytes: "x" }], { instructions: "nope" }));
  must(r.status === 409 && r.body.error.code === "agent_active", `${r.status} ${r.text}`);
  must(show(await stateKeys(w)) === show(before) && imported(w) === 0, "something was written");
  must((await d1ProvisionedAgents(w.DB).get(T, RAFT_ID))?.instructions === "", "instructions were applied");
});

await check("tenant isolation: another tenant's token is 404 on both paths; no token is 401; nothing is written", async () => {
  const w = await world();
  const b = body(uuid(), [{ path: "a.md", bytes: "x" }]);
  for (const path of [`agents/${A}/import`, `agents/by-raft-agent/${RAFT_ID}/import`]) {
    const r = await imp(w, b, { auth: w.other, path });
    must(r.status === 404 && r.body.error.code === "not_found", `${path}: ${r.status} ${r.text}`);
  }
  must((await imp(w, b, { auth: null })).status === 401, "no token");
  must((await imp(w, b, { path: "agents/raft_nobody/import" })).status === 404, "another agent id");
  await nothingWritten(w, "isolation");
});

await check("atomic: a storage failure on the third row rolls every row back, deletes the spilled objects, and the retry lands", async () => {
  const w = await world();
  const files: F[] = [{ path: "a.md", bytes: LARGE + "a" }, { path: "b.md", bytes: "b" }, { path: "c.md", bytes: "c" }, { path: "d.md", bytes: LARGE + "d" }];
  const id = uuid();
  w.sqlFault.failAfter = 2;
  const r = await imp(w, body(id, files));
  must(r.status === 500, `with the fault: ${r.status} ${r.text}`);
  must(w.sqlFault.failAfter === null, "the fault never fired");
  await nothingWritten(w, "rolled back");
  for (const f of files) must((await readFile(w, f.path)).status === 404, `${f.path} is visible`);
  const retry = await imp(w, body(id, files));
  must(retry.status === 201 && retry.body.fileCount === 4, `retry: ${retry.status} ${retry.text}`);
  must((await readFile(w, "d.md")).body.content === LARGE + "d", "d.md after the retry");
});

await check("atomic: an object-storage failure part-way through the spills writes no row and leaves no object; the retry lands", async () => {
  const w = await world();
  const files: F[] = [{ path: "a.md", bytes: LARGE + "a" }, { path: "b.md", bytes: LARGE + "b" }, { path: "c.md", bytes: "c" }];
  const id = uuid();
  w.R2.fault.failPutAfter = 1;
  const r = await imp(w, body(id, files));
  must(r.status === 500, `with the fault: ${r.status} ${r.text}`);
  await nothingWritten(w, "R2 failed");
  const retry = await imp(w, body(id, files));
  must(retry.status === 201, `retry: ${retry.status} ${retry.text}`);
  must((await readFile(w, "b.md")).body.content === LARGE + "b", "b.md after the retry");
});

await check("instructions that fail to apply after the files landed are applied by the identical retry, and never by a later one", async () => {
  const w = await world();
  const id = uuid();
  const b = body(id, [{ path: "a.md", bytes: "x" }], { instructions: "after retry" });
  (w.DB as any).fault.failOn = /UPDATE provisioned_agents SET instructions/;
  const r = await imp(w, b);
  must(r.status === 500, `with D1 away: ${r.status} ${r.text}`);
  must((await readFile(w, "a.md")).body.content === "x", "the files did not land");
  must((await d1ProvisionedAgents(w.DB).get(T, RAFT_ID))?.instructions === "", "instructions applied despite the fault");
  const retry = await imp(w, b);
  must(retry.status === 200 && retry.body.instructions === true, `retry: ${retry.status} ${retry.text}`);
  must((await d1ProvisionedAgents(w.DB).get(T, RAFT_ID))?.instructions === "after retry", "the retry did not apply them");
  // A PATCH after it; a late retry must not put the import's instructions back over it.
  const patched = await call(w, "PATCH", `agents/${A}`, { body: JSON.stringify({ instructions: "patched" }) });
  must(patched.status === 200, `PATCH: ${patched.text}`);
  must((await imp(w, b)).status === 200, "late retry");
  must((await d1ProvisionedAgents(w.DB).get(T, RAFT_ID))?.instructions === "patched", "a late retry overwrote the PATCH");
});

await check("production: the route is served without EVAL_SEED_ROUTES and with it, the same", async () => {
  for (const flag of [null, "0", "1"]) {
    const w = await world({ flag });
    const r = await imp(w, body(uuid(), [{ path: "a.md", bytes: "x" }]));
    must(r.status === 201, `${flag}: ${r.status} ${r.text}`);
    const seed = await call(w, "PUT", `agents/${A}/seed?path=z.md`, { body: "z" });
    must(seed.status === (flag === "1" ? 200 : 404), `${flag}: the seed route ${seed.status}`);
  }
});

await check("audit: one line per request, naming the token by its hash, the counts and the outcome; never a file's content or the token", async () => {
  const w = await world();
  lines.length = 0;
  const SECRET_TEXT = "the-content-marker-9f3e";
  const id = uuid();
  const b = body(id, [{ path: "a.md", bytes: SECRET_TEXT }, { path: "b.md", bytes: "bb" }]);
  await imp(w, b);
  await imp(w, b);
  await imp(w, body(uuid(), []));
  await imp(w, body(uuid(), [{ path: "../x", bytes: SECRET_TEXT }]));
  const ours = lines.map((l) => JSON.parse(l)).filter((l) => l.evt === "provision.import");
  must(show(ours.map((l) => l.outcome)) === show(["imported", "replayed", "refused", "refused"]), `outcomes: ${show(ours)}`);
  must(ours.every((l) => l.credentialId === w.tokenHash && l.tenant === T && l.agent === A), `ids: ${show(ours)}`);
  must(ours[0].files === 2 && ours[0].bytes === SECRET_TEXT.length + 2 && ours[0].migrationId === id, show(ours[0]));
  must(ours[2].code === "already_imported" && ours[3].code === "invalid", show(ours.slice(2)));
  const all = lines.join("\n");
  must(!all.includes(SECRET_TEXT) && !all.includes(Buffer.from(SECRET_TEXT).toString("base64")) && !all.includes(w.token), "a log line carries a content or the token");
});

// ---- the hold (`awaitImport`) ------------------------------------------------------------------

await check("awaitImport: a push before the import is accepted and queued and starts no turn; the import lifts the hold and the first turn runs with it", async () => {
  const w = await world({ post: { awaitImport: true }, pushy: true });
  const p = await push(w, "e1", "PUSHED-BEFORE-IMPORT");
  must(p.status === 202, `push: ${p.status} ${p.body}`);
  await settle(w, 1);
  must(jobCount(w) === 0, `a turn started while held: ${jobCount(w)} jobs`);
  must(pending(w) === 1, `the push is not queued: ${pending(w)}`);
  // The pass comes back when the hold would lift on its own.
  const since = Number(w.raw.sql.exec("SELECT since FROM import_hold").toArray()[0]!.since);
  must(Math.abs((w.alarmAt() ?? 0) - (since + IMPORT_HOLD_MAX_MS)) < 5_000, `alarm at ${w.alarmAt()} vs deadline ${since + IMPORT_HOLD_MAX_MS}`);
  // A message by another route has no queue and is refused while held.
  let threw = "";
  try { await w.rt.postMessage(T, A, "console", "prompt"); } catch (e) { threw = String((e as Error).message); }
  must(/waiting for its workspace import/.test(threw), `postMessage while held: ${threw || "no error"}`);
  const r = await imp(w, body(uuid(), [{ path: "MEMORY.md", bytes: "imported memory" }], { instructions: "IMPORTED-PERSONA-77" }));
  must(r.status === 201, `import: ${r.status} ${r.text}`);
  // Woken now, not at the hold's deadline: the queued push is posted by the pass the import armed.
  must((w.alarmAt() ?? Infinity) <= Date.now() + 1_000, `the import armed no wake: ${w.alarmAt()}`);
  await settle(w, 1);
  must(jobCount(w) === 1, `no turn after the import: ${jobCount(w)}`);
  const req = await asked(w, 0);
  must(req.includes("PUSHED-BEFORE-IMPORT") && req.includes("IMPORTED-PERSONA-77"), `the first turn: push ${req.includes("PUSHED-BEFORE-IMPORT")} persona ${req.includes("IMPORTED-PERSONA-77")}`);
  const rows = holdRows(w);
  must(rows.length === 1 && rows[0].status === "import" && rows[0].verdict === "ok", `trace: ${show(rows)}`);
});

await check("awaitImport: an import without instructions lifts the hold in its own transaction", async () => {
  const w = await world({ post: { awaitImport: true }, pushy: true });
  await push(w, "e1", "queued");
  await settle(w, 1);
  must(jobCount(w) === 0, "held");
  must((await imp(w, body(uuid(), [{ path: "a.md", bytes: "x" }]))).status === 201, "import");
  must((w.alarmAt() ?? Infinity) <= Date.now() + 1_000, `the import armed no wake: ${w.alarmAt()}`);
  await settle(w, 1);
  must(jobCount(w) === 1, `after: ${jobCount(w)}`);
});

await check("awaitImport: an import whose instructions did not apply keeps the hold, so no turn runs on the old persona; the retry lifts it", async () => {
  const w = await world({ post: { awaitImport: true }, pushy: true });
  await push(w, "e1", "QUEUED-PUSH");
  await settle(w, 1);
  (w.DB as any).fault.failOn = /UPDATE provisioned_agents SET instructions/;
  const b = body(uuid(), [{ path: "a.md", bytes: "x" }], { instructions: "PERSONA-AFTER-RETRY" });
  must((await imp(w, b)).status === 500, "the first import did not fail");
  await settle(w, 1);
  must(jobCount(w) === 0, `a turn ran with the instructions not applied: ${jobCount(w)}`);
  must((await imp(w, b)).status === 200, "retry");
  await settle(w, 1);
  must(jobCount(w) === 1 && (await asked(w, 0)).includes("PERSONA-AFTER-RETRY"), `after the retry: ${jobCount(w)} jobs`);
});

await check("awaitImport: with no import for 24 hours the hold lifts on its own, a trace row says why, and the queued push runs", async () => {
  const w = await world({ post: { awaitImport: true }, pushy: true });
  await push(w, "e1", "WAITED-A-DAY");
  await settle(w, 1);
  must(jobCount(w) === 0, "held");
  // A day passes: the hold is dated back rather than the clock moved forward, the one fact the valve reads.
  w.raw.sql.exec("UPDATE import_hold SET since = ?", Date.now() - IMPORT_HOLD_MAX_MS - 1);
  // And the push, queued a day ago by the same token: older than the queue's own age bound, yet not given up.
  w.raw.sql.exec("UPDATE inbound_pending SET received_at = ?", Date.now() - IMPORT_HOLD_MAX_MS);
  await settle(w, 1);
  must(jobCount(w) === 1 && (await asked(w, 0)).includes("WAITED-A-DAY"), `after the valve: ${jobCount(w)} jobs`);
  const rows = holdRows(w);
  must(rows.length === 1 && rows[0].status === "valve" && rows[0].verdict === "failed" && /24 hours/.test(rows[0].attrs.reason), `trace: ${show(rows)}`);
  // An import after the valve finds an agent that has run.
  const r = await imp(w, body(uuid(), [{ path: "a.md", bytes: "x" }]));
  must(r.status === 409 && r.body.error.code === "agent_active", `late import: ${r.status} ${r.text}`);
});

await check("awaitImport is compared on a create's replay: the same answers 200, a different value is 409 idempotency_conflict; absent and false are one", async () => {
  const w = await world({ post: { awaitImport: true } });
  must((await provisionPost(w, { awaitImport: true })).status === 200, "same");
  for (const v of [false, undefined]) {
    const r = await provisionPost(w, v === undefined ? {} : { awaitImport: v });
    must(r.status === 409 && r.body.error.code === "idempotency_conflict" && /awaitImport/.test(r.body.error.message), `${v}: ${r.status} ${r.text}`);
  }
  must((await provisionPost(w, { awaitImport: "yes" })).status === 422, "a non-boolean");
  const plain = await world();
  must((await provisionPost(plain, { awaitImport: false })).status === 200, "false is absent");
  const r = await provisionPost(plain, { awaitImport: true });
  must(r.status === 409 && /awaitImport/.test(r.body.error.message), `true on an agent made without: ${r.status} ${r.text}`);
  // After the import a replay of the create never holds the agent again.
  must((await imp(w, body(uuid(), []))).status === 201, "import");
  must((await provisionPost(w, { awaitImport: true })).status === 200, "replay after import");
  must(w.raw.sql.exec("SELECT lifted_at FROM import_hold").toArray()[0]!.lifted_at !== null, "the replay held the agent again");
});

await check("without awaitImport nothing is held: a push runs at once and no hold table is made", async () => {
  const w = await world({ pushy: true });
  await push(w, "e1", "AT-ONCE");
  await settle(w, 1);
  must(jobCount(w) === 1 && (await asked(w, 0)).includes("AT-ONCE"), `jobs: ${jobCount(w)}`);
  must(!tables(w).includes("import_hold"), "an import_hold table was made");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
