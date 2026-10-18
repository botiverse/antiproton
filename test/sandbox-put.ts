/**
 * `put`: a stored file copied into the container.
 *
 * The box has no credential of ours, so the only way an attachment the agent downloaded reaches a command
 * in it is the Worker reading the object and handing it to run9's `files/upload`. The cases hold who may name
 * what (only the caller's own `artifact://` references; no raw storage address, no URL), where it may land
 * (inside the working directory), how much (25 MiB, refused before the body is read), and that the call
 * waits for run9's transfer and checks the file in the box before saying it is there. run9 and the store are
 * fakes answering here.
 */
import { createHash } from "node:crypto";
import { BOX_KEY, BOX_STORE, PUT_MAX_BYTES, PUT_SETTLE_MS, asMountState, putPathOf, sandboxPlugin } from "../src/plugins/sandbox.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return String((e as Error)?.message ?? e); }
  throw new Error("expected a refusal, and the call succeeded");
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const OWN = "t/t/a/";
const PHOTO = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 0xff, 0xd9]);

type Call = { method: string; path: string; body?: any };
interface Run9Opts {
  /** What `files/upload` answers: a status and a JSON body. */
  upload?: () => { status: number; body: unknown };
  /** Successive answers of `data-transfers/active`; the last one repeats. */
  active?: unknown[][];
  /** Exit code of the prepare script. */
  prepareExit?: number;
  /** Bytes the box reports back, when not what was uploaded. */
  readBack?: (got: Uint8Array) => string;
}

/** A mount with a fake store holding `objects` and a run9 that keeps uploaded files in `files`. */
function fixture(objects: Record<string, Uint8Array>, o: Run9Opts = {}, record: unknown = null) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" };
  if (record) tables.put(scope, BOX_STORE, BOX_KEY, record as any, null);
  const calls: Call[] = [];
  const files = new Map<string, Uint8Array>();
  const execs = new Map<string, { script: string; path: string }>();
  const reads: string[] = [];
  const sizes: string[] = [];
  let activeAt = 0;
  let n = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const method = String(init?.method ?? "GET");
    const path = String(url).replace("https://sandbox.example", "");
    let body: any;
    if (init?.body instanceof FormData) body = init.body;
    else if (init?.body) body = JSON.parse(init.body);
    calls.push({ method, path, ...(body ? { body } : {}) });
    if (method === "POST" && /background-execs$/.test(path)) {
      const id = `e${++n}`;
      execs.set(id, { script: body.command[2], path: body.command[4] });
      return new Response(JSON.stringify({ exec_id: id }));
    }
    const exec = /\/execs\/(e\d+)$/.exec(path);
    if (exec) {
      const e = execs.get(exec[1]!)!;
      if (/mkdir -p/.test(e.script)) {
        const exit = o.prepareExit ?? 0;
        return new Response(JSON.stringify({ state: exit ? "failed" : "succeeded", exit_code: exit, output_summary: "" }));
      }
      const got = files.get(e.path);
      if (!got) return new Response(JSON.stringify({ state: "failed", exit_code: 3, output_summary: "" }));
      const out = o.readBack ? o.readBack(got) : `${got.byteLength}\n${sha(got)}\n`;
      return new Response(JSON.stringify({ state: "succeeded", exit_code: 0, output_summary: out }));
    }
    if (method === "POST" && path.includes("/files/upload")) {
      const at = new URL(String(url)).searchParams.get("box_abs_path")!;
      const file = (body as FormData).get("file") as Blob;
      const answer = o.upload ? o.upload() : { status: 200, body: { state: "prepared", kind: "upload" } };
      if (answer.status === 200) files.set(at, new Uint8Array(await file.arrayBuffer()));
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    if (path.includes("/data-transfers/active")) {
      const seq = o.active ?? [[]];
      const page = seq[Math.min(activeAt++, seq.length - 1)];
      return new Response(JSON.stringify(page));
    }
    return new Response("{}");
  }) as any;
  const store = {
    async put() { throw new Error("put does not write to the store"); },
    async get(key: string) {
      reads.push(key);
      const b = objects[key];
      if (!b) throw new Error("no such artifact");
      return b;
    },
    async size(key: string) { sizes.push(key); return objects[key]?.byteLength ?? null; },
  };
  const plugin = sandboxPlugin(store as any, "local", null);
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "AKSECRET", sk: "SKSECRET" }),
    publicConfig: { endpoint: "https://sandbox.example", project: "p", graceMs: 10_000 },
    db: openPluginDatabase(tables, scope, plugin.database),
    sibling: async () => null, sandboxForms: async () => [],
  };
  const put = (args: Record<string, unknown>) => plugin.invoke("put", args as any, ctx) as Promise<any>;
  const uploads = () => calls.filter((c) => c.path.includes("/files/upload"));
  const actives = () => calls.filter((c) => c.path.includes("/data-transfers/active"));
  return { plugin, ctx, calls, files, reads, sizes, put, uploads, actives, mount: () => asMountState(tables.get(scope, BOX_STORE, BOX_KEY) as any) };
}

await check("put copies an attachment of the caller's into the box and reports what the box holds", async () => {
  const f = fixture({ [`${OWN}raft/attachments/7/photo.jpg`]: PHOTO });
  const r = await f.put({ ref: "artifact://raft/attachments/7/photo.jpg", path: "in/photo.jpg" });
  must(r.path === "/work/in/photo.jpg" && r.bytes === PHOTO.byteLength && r.sha256 === sha(PHOTO), `result: ${JSON.stringify(r)}`);
  must(r.checked === "sha256", `the box's own hash was compared: ${JSON.stringify(r)}`);
  const up = f.uploads();
  must(up.length === 1 && up[0]!.method === "POST", `one upload: ${JSON.stringify(up.map((c) => c.path))}`);
  const id = f.mount()!.machines.main!.boxId;
  must(up[0]!.path === `/projects/p/workspace/boxes/${id}/files/upload?box_abs_path=${encodeURIComponent("/work/in/photo.jpg")}`, `where: ${up[0]!.path}`);
  must(sha(f.files.get("/work/in/photo.jpg")!) === sha(PHOTO), "the bytes the box got are the stored ones");
  must(f.reads.join() === `${OWN}raft/attachments/7/photo.jpg`, `read only that key: ${f.reads}`);
  // Nothing of the store or the credential reaches the model.
  const shown = JSON.stringify(r);
  must(!/r2:\/\/|t\/t\/a\/|AKSECRET|SKSECRET|https?:/.test(shown), `the result shows an address or a credential: ${shown}`);
  must(f.mount()!.machines.main!.execs === undefined || f.mount()!.machines.main!.execs === 0, "the agent's command count is untouched");
});

await check("the description says the flow, and put is declared a write", async () => {
  const tool = sandboxPlugin(null, "local").tools.find((t) => t.name === "put")!;
  must(tool, "no put tool");
  must(tool.sideEffects === "write", `declared ${tool.sideEffects}`);
  must(/download[\s\S]*`put`[\s\S]*`shell`[\s\S]*`save`[\s\S]*view or upload/.test(tool.summary), `summary: ${tool.summary}`);
  must(/No URLs/.test(tool.summary) && /25 MiB/.test(tool.summary), `summary: ${tool.summary}`);
  must(JSON.stringify((tool.parameters as any).required) === '["ref","path"]', "ref and path are required");
});

await check("another agent's file is not reachable: the same reference names the caller's own scope", async () => {
  const f = fixture({ "t/t/other/raft/attachments/7/photo.jpg": PHOTO, "t/u/a/raft/attachments/7/photo.jpg": PHOTO });
  const msg = await refusal(f.put({ ref: "artifact://raft/attachments/7/photo.jpg", path: "p.jpg" }));
  must(/no such artifact/.test(msg), msg);
  must(f.sizes.every((k) => k.startsWith(OWN)) && f.reads.length === 0, `looked outside its scope: ${f.sizes} ${f.reads}`);
  for (const ref of ["artifact://../other/raft/attachments/7/photo.jpg", "artifact://raft/../../other/x", "artifact://"]) {
    const m = await refusal(f.put({ ref, path: "p.jpg" }));
    must(/not readable by this agent/.test(m), `${ref}: ${m}`);
  }
  must(f.uploads().length === 0 && f.calls.length === 0, `run9 was asked: ${JSON.stringify(f.calls)}`);
});

await check("a raw r2:// reference is refused, the caller's own included, and so is a URL", async () => {
  const f = fixture({ [`${OWN}raft/attachments/7/photo.jpg`]: PHOTO, "t/t/other/x": PHOTO });
  for (const ref of ["r2://antiproton-artifacts/t/t/other/x", `r2://antiproton-artifacts/${OWN}raft/attachments/7/photo.jpg`,
    "https://example.com/photo.jpg", "t/t/a/raft/attachments/7/photo.jpg", ""]) {
    const m = await refusal(f.put({ ref, path: "p.jpg" }));
    must(/must be an artifact:\/\/ reference/.test(m), `${ref}: ${m}`);
  }
  must(f.calls.length === 0 && f.reads.length === 0 && f.sizes.length === 0, "something was read or asked");
});

await check("a path that leaves the working directory is refused; one that stays is resolved", async () => {
  for (const bad of ["../etc/passwd", "/etc/passwd", "/work/../etc/x", "a/../../x", "", "/work", ".", "/workx/y"]) {
    let m = "";
    try { putPathOf("/work", bad); } catch (e) { m = String((e as Error).message); }
    must(/inside the working directory|path is required/.test(m), `${JSON.stringify(bad)} was taken: ${m || putPathOf("/work", bad)}`);
  }
  must(putPathOf("/work", "a/./b/../c.txt") === "/work/a/c.txt", putPathOf("/work", "a/./b/../c.txt"));
  must(putPathOf("/work", "/work/in/x") === "/work/in/x", "absolute inside");
  must(putPathOf("/", "/etc/x") === "/etc/x", "a workdir of / allows any file");
  const f = fixture({ [`${OWN}x`]: PHOTO });
  const m = await refusal(f.put({ ref: "artifact://x", path: "../../etc/passwd" }));
  must(/inside the working directory \/work/.test(m), m);
  must(f.calls.length === 0, `run9 was asked before the path was checked: ${JSON.stringify(f.calls)}`);
});

await check("a file over 25 MiB is refused before its body is read, and before a box is asked for", async () => {
  const big = new Uint8Array(PUT_MAX_BYTES + 1);
  const f = fixture({ [`${OWN}big.bin`]: big });
  const m = await refusal(f.put({ ref: "artifact://big.bin", path: "big.bin" }));
  must(/over the 25\.0 MiB/.test(m), m);
  must(f.reads.length === 0 && f.calls.length === 0, `read ${f.reads.length}, run9 calls ${f.calls.length}`);
  // Exactly the limit goes through.
  const g = fixture({ [`${OWN}edge.bin`]: new Uint8Array(PUT_MAX_BYTES) });
  const r = await g.put({ ref: "artifact://edge.bin", path: "edge.bin" });
  must(r.bytes === PUT_MAX_BYTES, `the limit itself was refused: ${JSON.stringify(r)}`);
});

await check("a store whose body is longer than its size said is still held to the limit", async () => {
  const f = fixture({});
  const lying = { async size() { return 10; }, async get() { return new Uint8Array(PUT_MAX_BYTES + 1); }, async put() { throw new Error("no"); } };
  const plugin = sandboxPlugin(lying as any, "local", null);
  const m = await refusal(plugin.invoke("put", { ref: "artifact://x", path: "x" } as any, f.ctx) as Promise<unknown>);
  must(/over the 25\.0 MiB/.test(m), m);
  must(f.calls.length === 0, "a box was asked for");
});

await check("run9 refusing the upload is a clear error, and so is a failure it reports", async () => {
  const f = fixture({ [`${OWN}x`]: PHOTO }, { upload: () => ({ status: 500, body: { error: "disk full" } }) });
  const m = await refusal(f.put({ ref: "artifact://x", path: "x" }));
  must(/run9 refused the upload to \/work\/x: 500/.test(m) && /disk full/.test(m), m);
  const g = fixture({ [`${OWN}x`]: PHOTO }, { upload: () => ({ status: 200, body: { state: "prepared", failure_code: "box_busy" } }) });
  const m2 = await refusal(g.put({ ref: "artifact://x", path: "x" }));
  must(/did not complete the upload/.test(m2) && /box_busy/.test(m2), m2);
  const h = fixture({ [`${OWN}x`]: PHOTO }, { upload: () => ({ status: 200, body: { state: "error", reason: "host lost" } }) });
  const m3 = await refusal(h.put({ ref: "artifact://x", path: "x" }));
  must(/did not complete the upload/.test(m3) && /host lost/.test(m3), m3);
  for (const s of [f, g, h]) must(!/AKSECRET|SKSECRET/.test(JSON.stringify(s.calls.map((c) => c.path))), "credential in a path");
});

await check("a file in the box that is not the one sent is an error, not a success", async () => {
  const f = fixture({ [`${OWN}x`]: PHOTO }, { readBack: (b) => `${b.byteLength}\n${"0".repeat(64)}\n` });
  const m = await refusal(f.put({ ref: "artifact://x", path: "x" }));
  must(/is not the file sent/.test(m), m);
  const g = fixture({ [`${OWN}x`]: PHOTO }, { readBack: (b) => `${b.byteLength - 1}\n` });
  const m2 = await refusal(g.put({ ref: "artifact://x", path: "x" }));
  must(/is not the file sent/.test(m2), m2);
  // An image without sha256sum: the size alone is compared, and the result says so.
  const h = fixture({ [`${OWN}x`]: PHOTO }, { readBack: (b) => `${b.byteLength}\n` });
  const r = await h.put({ ref: "artifact://x", path: "x" });
  must(r.checked === "size" && r.sha256 === sha(PHOTO), JSON.stringify(r));
});

await check("a path that is a directory in the box is refused before anything is uploaded", async () => {
  const f = fixture({ [`${OWN}x`]: PHOTO }, { prepareExit: 6 });
  const m = await refusal(f.put({ ref: "artifact://x", path: "in" }));
  must(/is a directory/.test(m), m);
  must(f.uploads().length === 0, "uploaded over a directory");
});

await check("an upload run9 has only prepared is waited for until its transfer is no longer active", async () => {
  const running = [{ box_id: "", direction: "upload", state: "running", path_summary: "/work/x" }];
  const f = fixture({ [`${OWN}x`]: PHOTO }, { active: [running, running, []] });
  const r = await f.put({ ref: "artifact://x", path: "x" });
  must(r.bytes === PHOTO.byteLength, JSON.stringify(r));
  must(f.actives().length === 3, `polled ${f.actives().length} times`);
  const id = f.mount()!.machines.main!.boxId;
  must(f.actives()[0]!.path.endsWith(`/data-transfers/active?box_id=${id}`), f.actives()[0]!.path);
  // The read-back comes after the transfer settled, not before.
  const order = f.calls.map((c) => c.path.includes("data-transfers") ? "A" : /background-execs$/.test(c.path) ? "X" : "").filter(Boolean).join("");
  must(order === "XAAAX", `order of prepare, polls, read-back: ${order}`);
  // A download, or another box's upload, is not this one.
  const g = fixture({ [`${OWN}x`]: PHOTO }, { active: [[{ direction: "download", state: "running" }, { box_id: "other", direction: "upload", state: "running" }]] });
  await g.put({ ref: "artifact://x", path: "x" });
  must(g.actives().length === 1, `waited on someone else's transfer: ${g.actives().length}`);
});

await check("an upload run9 says succeeded is not polled", async () => {
  const f = fixture({ [`${OWN}x`]: PHOTO }, { upload: () => ({ status: 200, body: { state: "succeeded" } }) });
  await f.put({ ref: "artifact://x", path: "x" });
  must(f.actives().length === 0, `polled ${f.actives().length}`);
});

await check("a transfer that errors while waited for is an error", async () => {
  const f = fixture({ [`${OWN}x`]: PHOTO }, { active: [[{ direction: "upload", state: "running" }], [{ direction: "upload", state: "error", reason: "agent gone" }]] });
  const m = await refusal(f.put({ ref: "artifact://x", path: "x" }));
  must(/did not complete the upload/.test(m) && /error/.test(m) && /agent gone/.test(m), m);
});

await check("a transfer still running after the wait is an error that says it may still land", async () => {
  const realNow = Date.now;
  let skew = 0;
  try {
    const f = fixture({ [`${OWN}x`]: PHOTO }, { active: [[{ direction: "upload", state: "running" }]] });
    const inner = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: any) => {
      // Each poll moves the clock a third of the way through the wait.
      if (String(url).includes("data-transfers")) skew += PUT_SETTLE_MS / 3 + 1;
      return inner(url, init);
    }) as any;
    Date.now = () => realNow() + skew;
    const m = await refusal(f.put({ ref: "artifact://x", path: "x" }));
    must(/had not finished the upload/.test(m) && /may still land/.test(m), m);
    must(f.actives().length >= 3 && f.actives().length <= 4, `bounded: ${f.actives().length} polls`);
  } finally { Date.now = realNow; }
});

await check("put on a switched-off box records it as running again before the upload", async () => {
  const T0 = Date.now() - 3_600_000;
  const f = fixture({ [`${OWN}x`]: PHOTO }, {}, { machines: { main: { boxId: "b1", createdAt: T0, lastUsedAt: T0, parkedAt: T0 + 1, execs: 2, saved: [] } } });
  await f.put({ ref: "artifact://x", path: "x" });
  const m = f.mount()!.machines.main!;
  must(m.boxId === "b1" && (m as any).parkedAt === undefined, `still parked: ${JSON.stringify(m)}`);
  must(f.uploads()[0]!.path.includes("/boxes/b1/"), "uploaded somewhere else");
});

await check("without object storage put says so and starts nothing", async () => {
  const f = fixture({});
  const plugin = sandboxPlugin(null, "local", null);
  const m = await refusal(plugin.invoke("put", { ref: "artifact://x", path: "x" } as any, f.ctx) as Promise<unknown>);
  must(/no object storage/.test(m), m);
  must(f.calls.length === 0, "run9 was asked");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
