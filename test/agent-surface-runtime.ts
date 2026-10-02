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
import { BOX_KEY, BOX_STORE, parseFindLines } from "../src/plugins/sandbox.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

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

/** run9, answering the box list with `state` for our box, and execs from `exec`. Every request is kept. */
function run9(state: string | null, exec: (argv: string[]) => { exit: number; out: string } = () => ({ exit: 0, out: "" }), file?: Uint8Array) {
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
      const r = exec(argvs.get(e[1]!)!);
      return Response.json({ state: r.exit === 0 ? "succeeded" : "failed", exit_code: r.exit, output_summary: r.out });
    }
    if (method === "GET" && u.pathname.endsWith(`/boxes/${RUNNING.boxId}/files/download`) && file) return new Response(file);
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

await check("an awake box is listed by a read-only command with the path as an argument, under the working directory, and nothing is started", async () => {
  const { rt, host, record } = await runtime(RUNNING);
  const calls = run9("idle", (argv) => (argv[4] === "/work/src"
    ? { exit: 0, out: "d\t4096\t1759300000.5\tlib\nf\t12\t1759300001.25\tindex.js\nf\t3\t17593" }
    : { exit: 3, out: "" }));
  const before = record();
  const l = await heldFiles(rt, T, A, { op: "list", path: "src" });
  must(l.running && "entries" in l, JSON.stringify(l));
  must(JSON.stringify(l.entries) === JSON.stringify([
    { name: "lib", isDirectory: true, size: 4096, modifiedAt: 1759300000500 },
    { name: "index.js", isDirectory: false, size: 12, modifiedAt: 1759300001250 },
  ]), `a line cut off mid-way was kept, or one was lost: ${JSON.stringify(l.entries)}`);
  const exec = calls.find((c) => c.method === "POST")!;
  must(exec.body.command[0] === "sh" && exec.body.command[1] === "-c" && exec.body.command[4] === "/work/src" && !exec.body.command[2].includes("/work/src"), JSON.stringify(exec.body));
  const missing = await heldFiles(rt, T, A, { op: "list", path: "nope" });
  must(missing.running && missing.found === false, JSON.stringify(missing));
  await heldFiles(rt, T, A, { op: "list", path: "../../etc" });
  const climbed = calls.filter((c) => c.method === "POST").at(-1)!;
  must(climbed.body.command[4] === "/work/etc", `a path climbed out of the working directory: ${climbed.body.command[4]}`);
  must(starts(calls).length === 0, `a box was started: ${JSON.stringify(starts(calls))}`);
  must(record() === before, "the look wrote the mount's record: a look must not postpone an idle release");
  host.dispose();
});

await check("an awake box's file is measured first, downloaded only when under the cap, and a directory is not downloaded", async () => {
  const body = new TextEncoder().encode("console.log(1)");
  const stat = (type: string, size: number) => () => ({ exit: 0, out: `${type}\t${size}\t1759300000\t.x\n` });
  for (const [type, size, max, downloads] of [["f", body.byteLength, 1024, 1], ["f", 5_000_000, 1024, 0], ["d", 4096, 1024, 0]] as const) {
    const { rt, host } = await runtime(RUNNING);
    const calls = run9("running", stat(type, size), body);
    const r = await heldFiles(rt, T, A, { op: "read", path: "index.js", maxBytes: max });
    must(r.running && r.found, JSON.stringify(r));
    const got = calls.filter((c) => /files\/download/.test(c.path));
    must(got.length === downloads, `${type} ${size}: ${got.length} downloads`);
    if (downloads) must("bytes" in r && new TextDecoder().decode(r.bytes!) === "console.log(1)" && got[0]!.path.includes(encodeURIComponent("/work/index.js")), JSON.stringify(r));
    else must("bytes" in r && r.bytes === null && r.size === size && r.isDirectory === (type === "d"), JSON.stringify(r));
    must(starts(calls).length === 0, "a box was started");
    host.dispose();
  }
});

await check("find's output is read line by line, and a name with a tab in it keeps the rest of its name", async () => {
  const e = parseFindLines("f\t1\t2.5\ta\tb\n\nl\t0\t1\tlink\nnot a line\n");
  must(JSON.stringify(e.map((x) => x.name)) === JSON.stringify(["a\tb", "link"]), JSON.stringify(e));
});

globalThis.fetch = originalFetch;
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
