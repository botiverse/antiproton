/**
 * The half of an agent's workspace read that runs inside its object (cf/src/agent-surface/in-agent.ts),
 * through the real runtime, store, gateway and sandbox plugin, with run9 stood in for by a recording
 * fetch: the state rows without the agent's sealed secrets, and the container's files only while run9
 * itself says the box is awake — no request that creates, wakes or stops a box, and no write to the
 * mount's record, whatever the box's state.
 */
import { AgentRuntime } from "../cf/src/runtime.ts";
import { heldFiles, stateGet, stateList } from "../cf/src/agent-surface/in-agent.ts";
import { workspaceList, workspaceRead, type WorkspaceDeps } from "../cf/src/agent-surface/workspace.ts";
import { BOX_KEY, BOX_STORE, LIST_SCRIPT, STAT_SCRIPT, parseListing, sandboxPlugin } from "../src/plugins/sandbox.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const T = "t", A = "a";
const SCOPE = { tenantId: T, agentId: A, alias: "sandbox", plugin: "sandbox" };
const RUNNING = { boxId: "h-t-a-box1", createdAt: 1_700_000_000_000, lastUsedAt: 1_700_000_100_000, execs: 2, saved: [] };
const originalFetch = globalThis.fetch;

/**
 * A box's filesystem, made for real in a scratch directory, and the look's scripts run on it by `sh`
 * as run9 would run them: so what is refused (a link out of the working directory, a FIFO) is refused
 * by the scripts themselves, not by a model of them. `/work` in the box is `<dir>/work` here.
 */
type Node = { kind: "d" } | { kind: "f"; body: Uint8Array } | { kind: "l"; to: string } | { kind: "p" };
const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "agent-surface-"));
let boxes = 0;
function boxFs(nodes: Record<string, Node>) {
  const dir = join(scratch, `box${++boxes}`);
  mkdirSync(join(dir, "work"), { recursive: true });
  const host = (p: string) => (p === "/work" || p.startsWith("/work/") ? dir + p : p);
  for (const [path, n] of Object.entries(nodes).sort(([a], [b]) => a.length - b.length)) {
    if (!path.startsWith("/work/")) continue;
    if (n.kind === "d") mkdirSync(host(path), { recursive: true });
    else if (n.kind === "f") writeFileSync(host(path), n.body);
    else if (n.kind === "l") symlinkSync(n.to.startsWith("/work") ? host(n.to) : n.to, host(path));
    else if (n.kind === "p") spawnSync("mkfifo", [host(path)]);
  }
  const exec = (argv: string[], cut?: (out: string) => string): { exit: number; out: string } => {
    const [sh, c, script, name, path, root] = argv as [string, string, string, string, string, string];
    const r = spawnSync(sh, [c, script, name, host(path), host(root)], { encoding: "utf8" });
    const out = r.stdout.split(dir).join("");
    return { exit: r.status ?? 1, out: cut ? cut(out) : out };
  };
  // Only a regular file is served, as run9's download does ("exactly one regular file"); reading a
  // FIFO here would block the suite rather than fail it.
  const body = (p: string) => { try { return statSync(host(p)).isFile() ? new Uint8Array(readFileSync(host(p))) : null; } catch { return null; } };
  return { exec, body };
}

const FS = {
  "/work/src": { kind: "d" }, "/work/src/lib": { kind: "d" },
  "/work/index.js": { kind: "f", body: new TextEncoder().encode("console.log(1)") },
  "/work/root": { kind: "l", to: "/" }, "/work/pw": { kind: "l", to: "/etc/passwd" },
  "/work/inner": { kind: "l", to: "/work/index.js" }, "/work/tty": { kind: "p" },
} as Record<string, Node>;

/**
 * run9, answering the box list with `state` for our box, execs from the box's filesystem, and
 * downloads as a stream that counts how much of it was pulled. Every request is kept.
 */
function run9(state: string | null, opts: { fs?: Record<string, Node>; cut?: (out: string) => string; download?: () => ReadableStream<Uint8Array> } = {}) {
  const fs = boxFs(opts.fs ?? FS);
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const argvs = new Map<string, string[]>();
  let n = 0;
  globalThis.fetch = (async (url: any, init?: any) => {
    const method = String(init?.method ?? "GET");
    const u = new URL(String(url));
    const path = u.pathname + u.search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, ...(body ? { body } : {}) });
    if (method === "GET" && u.pathname.endsWith("/workspace/boxes")) {
      return Response.json(state === null ? [] : [{ box_id: "someone-elses", state: "idle" }, { box_id: RUNNING.boxId, state }]);
    }
    if (method === "POST" && u.pathname.endsWith(`/boxes/${RUNNING.boxId}/background-execs`)) {
      const id = `e${++n}`;
      argvs.set(id, body.command);
      return Response.json({ exec_id: id });
    }
    const e = /\/workspace\/execs\/(e\d+)$/.exec(u.pathname);
    if (method === "GET" && e) {
      const r = fs.exec(argvs.get(e[1]!)!, opts.cut);
      return Response.json({ state: r.exit === 0 ? "succeeded" : "failed", exit_code: r.exit, output_summary: r.out });
    }
    if (method === "GET" && u.pathname.endsWith(`/boxes/${RUNNING.boxId}/files/download`)) {
      if (opts.download) return new Response(opts.download());
      const b = fs.body(u.searchParams.get("box_abs_path")!);
      return b ? new Response(b) : Response.json({ message: "not a regular file" }, { status: 400 });
    }
    return Response.json({ message: "not stubbed" }, { status: 404 });
  }) as any;
  return calls;
}
/** Anything that makes, wakes or ends a box: a create, a stop, a delete, a fork, or a command on a box run9 did not call awake. */
const starts = (calls: Array<{ method: string; path: string }>) =>
  calls.filter((c) => (c.method === "POST" && /\/workspace\/boxes(\?|$)/.test(c.path)) || /\/stop$/.test(c.path) || c.method === "DELETE" || /\/fork$/.test(c.path));

async function runtime(box?: unknown) {
  const host = sqliteHost();
  const rt = new AgentRuntime({
    ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
    bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any,
    secretKek: Buffer.from(new Uint8Array(32).fill(3)).toString("base64"),
    operatorRun9: { ak: "ak", sk: "sk" },
  } as any);
  await rt.ready();
  await rt.store.createAgent(T, A, { name: "x" } as any);
  await rt.provision(T, A);
  if (box) rt.store.pluginDb.put(SCOPE, BOX_STORE, BOX_KEY, box as any, null);
  const record = () => JSON.stringify(rt.store.pluginDb.get(SCOPE, BOX_STORE, BOX_KEY) ?? null);
  return { rt, host, record };
}

await check("state rows come back without the agent's sealed secrets, and a secret's name reads as nothing", async () => {
  const { rt, host } = await runtime();
  await rt.store.putState(T, A, "memory", { value: "likes tea", ref: null, bytes: 11 });
  await rt.store.putState(T, A, "notes/one", { value: { n: 1 }, ref: null, bytes: 7 });
  await rt.store.putSecret(T, A, "kept:api", { ciphertext: "SEALED", iv: "iv" });
  const rows = await stateList(rt, T, A, "", 100);
  must(JSON.stringify(rows.map((r) => r.key)) === JSON.stringify(["memory", "notes/one"]), JSON.stringify(rows));
  must((await stateGet(rt, T, A, "kept:api")) === null, "the secret's row was found among the state");
  const got = await stateGet(rt, T, A, "memory");
  must(got?.value === "likes tea", JSON.stringify(got));
  const deps: WorkspaceDeps = {
    state: { list: (t, a, p, l) => stateList(rt, t, a, p, l), get: (t, a, k) => stateGet(rt, t, a, k) },
    artifacts: { list: async () => ({ objects: [], prefixes: [] }), head: async () => null, get: async () => null },
    sandbox: { list: async () => ({ running: false }), read: async () => ({ running: false }) },
  };
  const listed = await workspaceList(deps, T, A, "state/", true);
  must(listed.ok && !JSON.stringify(listed).includes("kept"), JSON.stringify(listed));
  const read = await workspaceRead(deps, T, A, "state/kept:api");
  must(!read.ok && read.status === 404 && !JSON.stringify(read).includes("SEALED"), JSON.stringify(read));
  host.dispose();
});

await check("no box: not running, and run9 is not asked anything", async () => {
  const { rt, host, record } = await runtime();
  const calls = run9("idle");
  const before = record();
  const l = await heldFiles(rt, T, A, { op: "list", path: "" });
  const r = await heldFiles(rt, T, A, { op: "read", path: "index.js", maxBytes: 1024 });
  must(!l.running && !r.running, `${JSON.stringify(l)} ${JSON.stringify(r)}`);
  must(calls.length === 0, `run9 was asked: ${JSON.stringify(calls)}`);
  must(record() === before, "the look wrote the mount's record");
  host.dispose();
});

await check("a box the idle lease switched off: not running, and run9 is not asked anything", async () => {
  const { rt, host, record } = await runtime({ ...RUNNING, parkedAt: RUNNING.lastUsedAt + 60_000 });
  const calls = run9("idle");
  const before = record();
  const l = await heldFiles(rt, T, A, { op: "list", path: "" });
  must(!l.running, JSON.stringify(l));
  must(calls.length === 0, `run9 was asked: ${JSON.stringify(calls)}`);
  must(record() === before, "the look wrote the mount's record");
  host.dispose();
});

await check("a box run9 has let sleep, or does not list: not running, after one read of the list and nothing else", async () => {
  for (const state of ["ready", "error", "deleted", "something-new", null]) {
    const { rt, host, record } = await runtime(RUNNING);
    const calls = run9(state);
    const before = record();
    const l = await heldFiles(rt, T, A, { op: "list", path: "" });
    const r = await heldFiles(rt, T, A, { op: "read", path: "index.js", maxBytes: 1024 });
    must(!l.running && !r.running, `${state}: ${JSON.stringify(l)} ${JSON.stringify(r)}`);
    must(calls.every((c) => c.method === "GET" && /\/workspace\/boxes$/.test(c.path)), `${state}: more than the list was asked: ${JSON.stringify(calls)}`);
    must(starts(calls).length === 0, `${state}: a box was started`);
    must(record() === before, `${state}: the look wrote the mount's record`);
    host.dispose();
  }
});

const downloads = (calls: Array<{ method: string; path: string }>) => calls.filter((c) => /files\/download/.test(c.path));

await check("an awake box is listed by a read-only command with the path as an argument, under the working directory, and nothing is started", async () => {
  const { rt, host, record } = await runtime(RUNNING);
  const calls = run9("idle");
  const before = record();
  const l = await heldFiles(rt, T, A, { op: "list", path: "" });
  must(l.running && "entries" in l && l.truncated === false, JSON.stringify(l));
  const names = l.entries.map((e) => `${e.name}${e.isDirectory ? "/" : ""}`).sort();
  must(JSON.stringify(names) === JSON.stringify(["index.js", "inner", "pw", "root", "src/", "tty"]), `links must be listed as links, not followed: ${JSON.stringify(names)}`);
  const exec = calls.find((c) => c.method === "POST")!;
  must(exec.body.command[0] === "sh" && exec.body.command[2] === LIST_SCRIPT && exec.body.command[4] === "/work" && exec.body.command[5] === "/work", JSON.stringify(exec.body));
  must(!/ -L /.test(LIST_SCRIPT) && !/ -L /.test(STAT_SCRIPT), "find follows links");
  const src = await heldFiles(rt, T, A, { op: "list", path: "src" });
  must(src.running && "entries" in src && src.entries.length === 1 && src.entries[0]!.name === "lib", JSON.stringify(src));
  must(starts(calls).length === 0, `a box was started: ${JSON.stringify(starts(calls))}`);
  must(record() === before, "the look wrote the mount's record: a look must not postpone an idle release");
  host.dispose();
});

await check("a link out of the working directory is neither listed through nor read: to /, to a file outside, and in the middle of a path", async () => {
  const { rt, host } = await runtime(RUNNING);
  const calls = run9("idle");
  for (const path of ["root", "root/etc", "../../etc", "src/../../etc"]) {
    const l = await heldFiles(rt, T, A, { op: "list", path });
    must(l.running && !l.found, `${path} listed: ${JSON.stringify(l)}`);
  }
  for (const path of ["pw", "root/etc/passwd"]) {
    const r = await heldFiles(rt, T, A, { op: "read", path, maxBytes: 1024 });
    must(r.running && !r.found, `${path} read: ${JSON.stringify(r)}`);
  }
  must(downloads(calls).length === 0, `something outside was downloaded: ${JSON.stringify(downloads(calls))}`);
  const inner = await heldFiles(rt, T, A, { op: "read", path: "inner", maxBytes: 1024 });
  must(inner.running && inner.found && inner.kind === "file" && new TextDecoder().decode(inner.bytes!) === "console.log(1)", `a link inside the directory: ${JSON.stringify(inner)}`);
  must(downloads(calls).at(-1)!.path.includes(encodeURIComponent("/work/index.js")), "the download was not of the resolved path");
  host.dispose();
});

await check("only a regular file is downloaded: a directory or a device is reported and never fetched", async () => {
  const { rt, host } = await runtime(RUNNING);
  const calls = run9("running");
  const dir = await heldFiles(rt, T, A, { op: "read", path: "src", maxBytes: 1024 });
  const dev = await heldFiles(rt, T, A, { op: "read", path: "tty", maxBytes: 1024 });
  must(dir.running && dir.found && dir.kind === "directory" && dir.bytes === null, JSON.stringify(dir));
  must(dev.running && dev.found && dev.kind === "other" && dev.bytes === null, JSON.stringify(dev));
  must(downloads(calls).length === 0, `downloaded: ${JSON.stringify(downloads(calls))}`);
  host.dispose();
});

await check("listing a file is told apart from a path that does not exist", async () => {
  const { rt, host } = await runtime(RUNNING);
  run9("idle");
  const file = await heldFiles(rt, T, A, { op: "list", path: "index.js" });
  must(file.running && !file.found && (file as any).notDirectory === true, JSON.stringify(file));
  const none = await heldFiles(rt, T, A, { op: "list", path: "nope" });
  must(none.running && !none.found && !(none as any).notDirectory, JSON.stringify(none));
  host.dispose();
});

await check("a file that grew past the cap after it was measured is not read whole: the download stops at the cap", async () => {
  const { rt, host } = await runtime(RUNNING);
  let pulled = 0;
  const chunk = new Uint8Array(64 * 1024);
  const calls = run9("idle", {
    download: () => new ReadableStream<Uint8Array>({ pull(c) { pulled++; if (pulled > 1000) c.close(); else c.enqueue(chunk); } }),
  });
  const r = await heldFiles(rt, T, A, { op: "read", path: "index.js", maxBytes: 1024 * 1024 });
  must(r.running && r.found && r.kind === "file" && r.bytes === null && r.size > 1024 * 1024, JSON.stringify({ ...r, bytes: undefined }));
  must(pulled < 40, `read ${pulled} chunks of 64 KB for a 1 MB cap`);
  must(downloads(calls).length === 1, "not downloaded once");
  host.dispose();
});

await check("a listing the box cut short, or past 1000 entries, says it was cut and by how many when it knows", async () => {
  const many: Record<string, Node> = {};
  for (let i = 0; i < 1003; i++) many[`/work/f${String(i).padStart(4, "0")}`] = { kind: "f", body: new Uint8Array(1) };
  {
    const { rt, host } = await runtime(RUNNING);
    run9("idle", { fs: many });
    const l = await heldFiles(rt, T, A, { op: "list", path: "" });
    must(l.running && "entries" in l && l.entries.length === 1000 && l.truncated && l.omitted === 3, JSON.stringify({ ...l, entries: undefined }));
    host.dispose();
  }
  {
    // run9 keeps the head and the tail of a long output: the middle, and with it entries, is gone.
    const { rt, host } = await runtime(RUNNING);
    run9("idle", { fs: many, cut: (out) => out.slice(0, 2000) + "\n...\n" + out.slice(-60) });
    const l = await heldFiles(rt, T, A, { op: "list", path: "" });
    must(l.running && "entries" in l && l.truncated && l.omitted === 1003 - l.entries.length, JSON.stringify({ ...l, entries: l.running && "entries" in l ? l.entries.length : 0 }));
    host.dispose();
  }
  {
    const { rt, host } = await runtime(RUNNING);
    run9("idle", { fs: many, cut: (out) => out.slice(0, 2000) });
    const l = await heldFiles(rt, T, A, { op: "list", path: "" });
    must(l.running && "entries" in l && l.truncated && l.omitted === undefined, `a lost total must not read as a count: ${JSON.stringify({ ...l, entries: undefined })}`);
    host.dispose();
  }
  must(JSON.stringify(parseListing("f\t1\t2.5\ta\tb\n#total\t1\n")) === JSON.stringify({ entries: [{ name: "a\tb", isDirectory: false, size: 1, modifiedAt: 2500 }], truncated: false }), "a name with a tab");
});

await check("the mount's lock is held for deciding the box is awake and starting the command, never for the wait", async () => {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  tables.put(SCOPE, BOX_STORE, BOX_KEY, RUNNING as any, null);
  const plugin = sandboxPlugin(null as any, "local");
  const ctx: any = {
    caller: { tenantId: T, agentId: A, taskId: "k" }, alias: "sandbox", credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", project: "p" },
    db: openPluginDatabase(tables, SCOPE, plugin.database), sibling: async () => null, sandboxForms: async () => [],
  };
  const calls = run9("idle");
  let inside = false;
  const insideLock: string[] = [];
  const locked = async <X>(fn: () => Promise<X>) => { inside = true; try { return await fn(); } finally { inside = false; } };
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init?: any) => { if (inside) insideLock.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`); return real(url, init); }) as any;
  await plugin.holds!.files!.list(ctx, "", locked);
  must(JSON.stringify(insideLock) === JSON.stringify(["GET /projects/p/workspace/boxes", "POST /projects/p/workspace/boxes/h-t-a-box1/background-execs"]), `list held the lock for: ${JSON.stringify(insideLock)}`);
  must(calls.some((c) => /\/workspace\/execs\//.test(c.path)), "the wait did not happen at all");
  insideLock.length = 0;
  await plugin.holds!.files!.read(ctx, "index.js", 1024, locked);
  must(!insideLock.some((c) => /\/workspace\/execs\//.test(c)), `read waited under the lock: ${JSON.stringify(insideLock)}`);
  must(insideLock.filter((c) => /files\/download/.test(c)).length === 1, `the download is behind the lock, with a fresh check: ${JSON.stringify(insideLock)}`);
});

globalThis.fetch = originalFetch;
rmSync(scratch, { recursive: true, force: true });
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
