/**
 * Whose a box is, at the two places that decide it: the id a new box is created under, and the adopt that follows
 * a create run9 answered "already exists".
 *
 * run9's ids are the project's, and the project is every tenant's, so an id two owners can both mint is an id
 * one of them can be handed the other's box under: the create of the second is refused "already exists", and the
 * adopt that exists for a create whose answer was lost takes the box that is there. The id used to spell the
 * identity out and cut it at 40 characters, which for Raft ids (`raft_<uuid>`) removed the agent entirely. The
 * cases below hold that the id now differs per tenant, agent, mount and machine at the same instant, stays as
 * short as before, and that run9's adopt takes a box only when it was made for this owner, against run9 answers
 * given here rather than a live project.
 *
 * Ids minted before the fix stay in records for as long as their boxes live, so a pair that already shares a box
 * keeps sharing it unless something asks whose it is. The second half holds that every path that sends a box a
 * request asks first (src/plugins/sandbox.ts `ownedProvider`), and holds it at the provider boundary rather than by
 * trusting a list of paths: the fake run9 below remembers who each box was made for, and counts every request that
 * names a box (in its path, or a snapshot of it) sent while another agent is the caller.
 */
import { BOX_KEY, BOX_STORE, MAIN_MACHINE, asMountState, boxIdFor, sandboxPlugin } from "../src/plugins/sandbox.ts";
import type { BoxLease } from "../src/plugins/sandbox.ts";
import type { PluginTraceRow } from "../src/plugins/types.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

/** Ids shaped as Raft's: one server (the tenant) and two of its agents, sharing nothing past `raft_`. */
const TENANT = "raft_6f1c2d3e-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const AGENT_A = "raft_0d9e8f7a-6b5c-4d3e-9f2a-1b0c9d8e7f6a";
const AGENT_B = "raft_a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
/** One instant for every create below: the collision needed both boxes made in the same millisecond. */
const AT = 1_800_000_000_000;
/** The longest id run9 has accepted from this plugin (`boxIdFor`). */
const RUN9_LONGEST_SEEN = 49;
const LONGEST_MACHINE = "m23456789012345678901234";

/** What the id was before, for the reading that the case below would have collided under it. */
const oldIdFor = (tenantId: string, agentId: string, at: number) =>
  `h-${tenantId}-${agentId}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 40) + `-${at.toString(36)}`;

await check("two agents of one Raft server, at the same millisecond, get different ids (they did not before)", async () => {
  must(oldIdFor(TENANT, AGENT_A, AT) === oldIdFor(TENANT, AGENT_B, AT), "control: the old ids for these two agents should have been equal");
  const a = await boxIdFor({ tenantId: TENANT, agentId: AGENT_A, mount: "sandbox", machine: MAIN_MACHINE }, AT);
  const b = await boxIdFor({ tenantId: TENANT, agentId: AGENT_B, mount: "sandbox", machine: MAIN_MACHINE }, AT);
  must(a !== b, `one id for two agents: ${a}`);
  // Two tenants whose ids share every character the old cut kept.
  const t2 = TENANT.slice(0, 38) + "fff";
  must(oldIdFor(TENANT, AGENT_A, AT) === oldIdFor(t2, AGENT_A, AT), "control: the old ids for these two tenants should have been equal");
  const c = await boxIdFor({ tenantId: t2, agentId: AGENT_A, mount: "sandbox", machine: MAIN_MACHINE }, AT);
  must(a !== c, `one id for two tenants: ${a}`);
});

await check("the id differs by mount and by machine, and a named machine's name is in it", async () => {
  const of = (mount: string, machine: string) => boxIdFor({ tenantId: TENANT, agentId: AGENT_A, mount, machine }, AT);
  const ids = [await of("sandbox", MAIN_MACHINE), await of("sandbox2", MAIN_MACHINE), await of("sandbox", "build"), await of("sandbox", "build-2")];
  must(new Set(ids).size === ids.length, `ids repeat: ${ids.join(" ")}`);
  must(/^h-[0-9a-f]{12}-[0-9a-z]+$/.test(ids[0]!), `the main machine's id has no name in it: ${ids[0]}`);
  must(/^h-[0-9a-f]{12}-build-[0-9a-z]+$/.test(ids[2]!), `a named machine's id carries its name: ${ids[2]}`);
  // The same owner at another instant: the time keeps two boxes of one machine apart.
  must(await of("sandbox", MAIN_MACHINE) !== await boxIdFor({ tenantId: TENANT, agentId: AGENT_A, mount: "sandbox", machine: MAIN_MACHINE }, AT + 1),
    "one owner's two boxes a millisecond apart got one id");
  // And the same owner at the same instant gets the same id: it is a name, not a random draw.
  must(await of("sandbox", MAIN_MACHINE) === ids[0], "the id is not a function of its owner and time");
});

await check("no id is longer than run9 has accepted, and every one is lowercase letters, digits and dashes", async () => {
  for (const machine of [MAIN_MACHINE, "b", LONGEST_MACHINE]) {
    const id = await boxIdFor({ tenantId: TENANT, agentId: AGENT_A, mount: "a-mount-with-a-long-alias", machine }, AT);
    must(id.length <= RUN9_LONGEST_SEEN, `${id} is ${id.length} characters`);
    must(/^[a-z0-9-]+$/.test(id), `${id} has a character outside [a-z0-9-]`);
  }
});

// ---- through the plugin, against a run9 that answers here

type Call = { method: string; path: string; body?: any; caller: string };
type Box = { box_id: string; state: string; description?: string; box_snap_id: string };

/**
 * A run9 project shared by every mount made from it, as the real one is. `boxes` is what it lists, each with the
 * owner it was made for (from the create's description, or given when a test puts a box there). A create of an id it
 * already holds is refused as run9 refuses it, and `lose` makes the next create land and its answer be lost.
 *
 * `caller` is who the test is acting as; every request naming a box whose owner is someone else is a `crossing`.
 */
function run9Project() {
  const boxes = new Map<string, Box>();
  const owners = new Map<string, string>();
  const calls: Call[] = [];
  const crossings: Call[] = [];
  const o = { lose: false, caller: "" };
  let n = 0, sec = 0;
  const secrets = new Map<string, Array<{ name: string; secret_id: string }>>();
  /** The box a request names: in its path, or as the snapshot `keep` forks. */
  const named = (path: string): string | null => {
    const m = /\/workspace\/boxes\/([^/?]+)/.exec(path);
    if (m) return decodeURIComponent(m[1]!);
    const snap = /\/workspace\/snaps\/snap-of-([^/?]+)\/fork/.exec(path);
    return snap ? decodeURIComponent(snap[1]!) : null;
  };
  globalThis.fetch = (async (url: string, init?: any) => {
    const method = String(init?.method ?? "GET");
    const path = String(url).replace("https://run9.example", "");
    let body: any;
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined; } catch { body = undefined; }
    const c: Call = { method, path, ...(body ? { body } : {}), caller: o.caller };
    calls.push(c);
    const id = named(path);
    if (id !== null && owners.has(id) && owners.get(id) !== o.caller) crossings.push(c);
    const ok = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (method === "POST" && /\/workspace\/boxes$/.test(path)) {
      if (boxes.has(body.box_id)) return ok({ error: "box already exists" }, 400);
      boxes.set(body.box_id, { box_id: body.box_id, state: "ready", description: body.description, box_snap_id: `snap-of-${body.box_id}` });
      owners.set(body.box_id, String(body.description ?? "").replace(/^antiproton /, ""));
      if (o.lose) { o.lose = false; return ok({ error: "duplicate key value violates unique constraint" }, 400); }
      return ok({ box_id: body.box_id, state: "ready" }, 201);
    }
    if (method === "GET" && /\/workspace\/boxes$/.test(path)) return ok([...boxes.values()]);
    if (id !== null && !boxes.has(id)) return ok({ error: "box not found" }, 400);
    if (method === "POST" && /background-execs$/.test(path)) { boxes.get(id!)!.state = "running"; return ok({ exec_id: `e${++n}` }); }
    if (/\/execs\/e\d+$/.test(path)) return ok({ state: "succeeded", exit_code: 0, output_summary: "ok\n__AP_CWD__/work\n" });
    if (/\/execs\/e\d+\/kill$/.test(path)) return ok({});
    if (method === "POST" && /\/stop$/.test(path)) { boxes.get(id!)!.state = "ready"; return ok({}); }
    if (method === "DELETE" && /\/workspace\/boxes\/[^/]+$/.test(path)) { boxes.delete(id!); return ok({}); }
    if (/\/files\/download/.test(path)) return new Response("bytes");
    if (/\/files\/upload/.test(path)) return ok({ state: "succeeded" });
    if (/\/secrets$/.test(path)) {
      const list = secrets.get(id!) ?? [];
      secrets.set(id!, list);
      if (method === "POST") { list.push({ name: body.name, secret_id: `s${++sec}` }); return ok({}); }
      return ok(list);
    }
    if (method === "DELETE" && /\/secrets\//.test(path)) return ok({});
    if (/\/snaps\/[^/]+\/fork$/.test(path)) return ok({ snap_id: `kept-${++n}` });
    return ok({});
  }) as any;
  const creates = () => calls.filter((c) => c.method === "POST" && /\/workspace\/boxes$/.test(c.path));
  const on = (id: string) => calls.filter((c) => named(c.path) === id);
  const execsOn = (id: string) => on(id).filter((c) => c.method === "POST" && c.path.endsWith("/background-execs"));
  const lists = () => calls.filter((c) => c.method === "GET" && /\/workspace\/boxes$/.test(c.path));
  /** A box made for `owner` (`tenant/agent`), as an older build left it; `description` null for none at all. */
  const put = (id: string, owner: string, description: string | null = `antiproton ${owner}`) => {
    boxes.set(id, { box_id: id, state: "idle", ...(description !== null ? { description } : {}), box_snap_id: `snap-of-${id}` });
    owners.set(id, owner);
  };
  return { boxes, owners, calls, crossings, creates, on, execsOn, lists, put, o };
}

const LEASE: BoxLease = { warnMs: 5 * 60_000, maxMs: 30 * 60_000 };

function mountOf(tenantId: string, agentId: string, o: { lease?: BoxLease | null; record?: unknown } = {}) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId, agentId, alias: "sandbox", plugin: "sandbox" };
  if (o.record) tables.put(scope, BOX_STORE, BOX_KEY, o.record as any, null);
  const artifacts = {
    async put(key: string, body: Uint8Array) { return { ref: `r2://bucket/${key}`, bytes: body.byteLength }; },
    async get() { return new TextEncoder().encode("a file"); },
    async size() { return 6; },
  };
  const plugin = sandboxPlugin(artifacts as any, "bucket", o.lease ?? null);
  const traces: PluginTraceRow[] = [];
  const ctx: any = {
    caller: { tenantId, agentId, taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://run9.example", project: "p", graceMs: 10_000 },
    db: openPluginDatabase(tables, scope, plugin.database),
    sibling: async () => null, sandboxForms: async () => [],
    trace: (row: PluginTraceRow) => { traces.push(row); },
  };
  const raw = () => tables.get(scope, BOX_STORE, BOX_KEY) as any;
  const main = () => asMountState(raw())?.machines.main;
  return { plugin, ctx, main, raw, traces, owner: `${tenantId}/${agentId}` };
}

const realNow = Date.now;
const frozen = <T>(fn: () => Promise<T>) => { Date.now = () => AT; return fn().finally(() => { Date.now = realNow; }); };
const thrown = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return String((e as Error)?.message ?? e); } };
/** What the console was given while `fn` ran, and what `fn` returned or threw. */
async function logged<T>(fn: () => Promise<T>): Promise<{ lines: string[]; value?: T; error?: string }> {
  const real = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { return { lines, value: await fn() }; } catch (e) { return { lines, error: String((e as Error)?.message ?? e) }; } finally { console.log = real; }
}

/** The old record of a box minted before the fix: an id two agents could both have, and no owner check yet. */
const OLD_ID = oldIdFor(TENANT, AGENT_A, AT);
const legacyRecord = (boxId: string) => ({ machines: { main: { boxId, createdAt: AT, lastUsedAt: AT, execs: 1, saved: [] } } });
const NOT_OURS = "The machine you were using belonged to another agent, so it was left to them and a new one was made for you; nothing you had on the old one is here.";
const count = (hay: string, needle: string) => hay.split(needle).length - 1;

await check("two agents of one server, first command in the same millisecond: two creates, two boxes, each its own", async () => {
  const p = run9Project();
  const a = mountOf(TENANT, AGENT_A), b = mountOf(TENANT, AGENT_B);
  p.o.caller = a.owner;
  await frozen(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx));
  p.o.caller = b.owner;
  await frozen(() => b.plugin.invoke("shell", { command: "ls" }, b.ctx));
  const ids = p.creates().map((c) => c.body.box_id as string);
  must(ids.length === 2 && ids[0] !== ids[1], `creates: ${JSON.stringify(ids)}`);
  must(a.main()?.boxId === ids[0] && b.main()?.boxId === ids[1], `records: ${a.main()?.boxId} ${b.main()?.boxId}`);
  must(p.execsOn(ids[0]!).length === 1 && p.execsOn(ids[1]!).length === 1, "each command ran in its own agent's box");
  must(p.crossings.length === 0, `requests crossed owners: ${JSON.stringify(p.crossings)}`);
  // Made by this build: shown to be ours at creation, so nothing is asked about them later.
  must(a.main()?.ownerChecked === true && p.lists().length === 0, `a new box was asked about: ${p.lists().length} lists`);
});

await check("a box listed under the minted id but made for another owner is not adopted: the create's refusal stands", async () => {
  const p = run9Project();
  const a = mountOf(TENANT, AGENT_A);
  const id = await boxIdFor({ tenantId: TENANT, agentId: AGENT_A, mount: "sandbox", machine: MAIN_MACHINE }, AT);
  p.put(id, `${TENANT}/${AGENT_B}`);
  p.o.caller = a.owner;
  const err = await thrown(() => frozen(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx)));
  must(err !== null && /already exists/.test(err), `the create's own refusal: ${err}`);
  must(!a.main()?.boxId, `no record names the other owner's box: ${JSON.stringify(a.main())}`);
  must(p.execsOn(id).length === 0 && p.crossings.length === 0, `a request reached the other owner's box: ${JSON.stringify(p.crossings)}`);
});

await check("a box listed under the minted id with no description is not adopted either", async () => {
  const p = run9Project();
  const a = mountOf(TENANT, AGENT_A);
  const id = await boxIdFor({ tenantId: TENANT, agentId: AGENT_A, mount: "sandbox", machine: MAIN_MACHINE }, AT);
  p.put(id, "nobody", null);
  p.o.caller = a.owner;
  const err = await thrown(() => frozen(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx)));
  must(err !== null && /already exists/.test(err), `the create's own refusal: ${err}`);
  must(!a.main()?.boxId && p.execsOn(id).length === 0, `adopted: ${JSON.stringify(a.main())}`);
});

await check("a create whose answer was lost is still adopted: the box is there, made for this owner", async () => {
  const p = run9Project();
  const a = mountOf(TENANT, AGENT_A);
  p.o.lose = true;
  p.o.caller = a.owner;
  const r: any = await frozen(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx));
  const id = p.creates()[0]!.body.box_id as string;
  must(p.creates().length === 1 && p.boxes.has(id), `one create, landed: ${p.creates().length}`);
  must(a.main()?.boxId === id && r.box === id, `adopted and recorded: ${JSON.stringify(a.main())} ${JSON.stringify(r)}`);
  must(p.execsOn(id).length === 1, "the command ran in the adopted box");
});

// ---- a record that already names another agent's box

await check("a record naming another agent's box: let go of, said once, a new box made; the other box is never sent anything", async () => {
  const p = run9Project();
  // Agent B made the box; agent A's record names the same id, as a collision before the fix left it.
  p.put(OLD_ID, `${TENANT}/${AGENT_B}`);
  const before = JSON.stringify(p.boxes.get(OLD_ID));
  const a = mountOf(TENANT, AGENT_A, { record: legacyRecord(OLD_ID) });
  p.o.caller = a.owner;
  const first = await logged(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx) as Promise<any>);
  must(first.error === undefined, `the call failed: ${first.error}`);
  const r = first.value as any;
  // (1) The branch was taken: whose the box is was asked, the record let go of it, a new box was made and used,
  // the fact was written for counting, and the agent was told, once.
  must(p.lists().length >= 1, "nobody asked whose the box is");
  const made = p.creates().map((c) => c.body.box_id as string);
  must(made.length === 1 && made[0] !== OLD_ID, `creates: ${JSON.stringify(made)}`);
  must(a.main()?.boxId === made[0] && r.box === made[0], `the record and the result name the new box: ${JSON.stringify(a.main())} ${r.box}`);
  must(p.execsOn(made[0]!).length === 1, "the command did not run in the new box");
  const rows = a.traces.filter((t) => t.kind === "sandbox.box_owner");
  must(rows.length === 1 && rows[0]!.status === "box_not_ours" && rows[0]!.verdict === "blocked", `trace: ${JSON.stringify(a.traces)}`);
  const at = rows[0]!.attrs;
  must(at.code === "box_not_ours" && at.tenant === TENANT && at.agent === AGENT_A && at.mount === "sandbox" && at.machine === "main" && at.box === OLD_ID,
    `trace attrs: ${JSON.stringify(at)}`);
  must(first.lines.filter((l) => l.includes('"code":"box_not_ours"') && l.includes(OLD_ID)).length === 1, `log lines: ${JSON.stringify(first.lines)}`);
  must(count(JSON.stringify(r), NOT_OURS) === 1, `the sentence, once, in the result: ${JSON.stringify(r)}`);
  // (2) Nothing reached the other agent's box: no exec, no stop, no delete, no secret, and it is as it was.
  must(p.on(OLD_ID).length === 0, `requests on the other agent's box: ${JSON.stringify(p.on(OLD_ID))}`);
  must(p.crossings.length === 0, `requests crossed owners: ${JSON.stringify(p.crossings)}`);
  must(JSON.stringify(p.boxes.get(OLD_ID)) === before, `the other agent's box changed: ${before} -> ${JSON.stringify(p.boxes.get(OLD_ID))}`);
  // The next call is an ordinary one: nothing said, nothing asked, the new box used.
  const next = await logged(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx) as Promise<any>);
  must(count(JSON.stringify(next.value), NOT_OURS) === 0 && !/another agent/.test(JSON.stringify(next.value)), `said again: ${JSON.stringify(next.value)}`);
  must(a.traces.filter((t) => t.kind === "sandbox.box_owner").length === 1 && !next.lines.some((l) => l.includes("box_owner")), "counted again");
  must(p.execsOn(made[0]!).length === 2 && p.on(OLD_ID).length === 0, "the next call did not go to the new box");
});

await check("a record naming this agent's own box from before the fix keeps it: asked once, then used as always", async () => {
  const p = run9Project();
  p.put(OLD_ID, `${TENANT}/${AGENT_A}`);
  const a = mountOf(TENANT, AGENT_A, { record: legacyRecord(OLD_ID) });
  p.o.caller = a.owner;
  const r: any = await a.plugin.invoke("shell", { command: "ls" }, a.ctx);
  must(p.creates().length === 0 && a.main()?.boxId === OLD_ID && r.box === OLD_ID, `the box was not kept: ${JSON.stringify(a.main())}`);
  must(p.execsOn(OLD_ID).length === 1 && p.lists().length === 1, `exec ${p.execsOn(OLD_ID).length}, lists ${p.lists().length}`);
  must(a.main()?.ownerChecked === true && !/another agent/.test(JSON.stringify(r)), `record ${JSON.stringify(a.main())}, result ${JSON.stringify(r)}`);
  must(a.traces.length === 0, `a trace row for an owned box: ${JSON.stringify(a.traces)}`);
  await a.plugin.invoke("shell", { command: "ls" }, a.ctx);
  must(p.lists().length === 1 && p.execsOn(OLD_ID).length === 2, `asked again: ${p.lists().length} lists`);
});

await check("a box run9 lists with no description is kept and said once (owner_unknown), never let go of", async () => {
  const p = run9Project();
  p.put(OLD_ID, `${TENANT}/${AGENT_A}`, null);
  const a = mountOf(TENANT, AGENT_A, { record: legacyRecord(OLD_ID) });
  p.o.caller = a.owner;
  const first = await logged(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx) as Promise<any>);
  must(first.error === undefined && (first.value as any).box === OLD_ID, `the box was not kept: ${first.error ?? JSON.stringify(first.value)}`);
  must(p.creates().length === 0 && p.execsOn(OLD_ID).length === 1 && a.main()?.boxId === OLD_ID, `record ${JSON.stringify(a.main())}`);
  const rows = a.traces.filter((t) => t.kind === "sandbox.box_owner");
  must(rows.length === 1 && rows[0]!.status === "owner_unknown" && rows[0]!.verdict === "ok" && rows[0]!.attrs.box === OLD_ID, `trace: ${JSON.stringify(rows)}`);
  must(first.lines.filter((l) => l.includes('"code":"owner_unknown"')).length === 1, `log: ${JSON.stringify(first.lines)}`);
  must(!/another agent/.test(JSON.stringify(first.value)), "the agent was told its own box was another's");
  await a.plugin.invoke("shell", { command: "ls" }, a.ctx);
  must(a.traces.length === 1 && p.lists().length === 1, `said or asked again: ${a.traces.length} rows, ${p.lists().length} lists`);
});

// ---- every way in, against the fake's own record of who owns each box

/**
 * Every entry point of the plugin that can reach a recorded box: the tools, a release (the agent's, the idle lease's
 * switch-off, an operator's), a withdrawal and a person's look at the files. A job's poll and cancel name an execution
 * run9 issued, never a box, and `machines` and `quiet` read and write only the record.
 */
const ENTRY_POINTS: Array<[string, (m: ReturnType<typeof mountOf>) => Promise<unknown>]> = [
  ["shell", (m) => m.plugin.invoke("shell", { command: "ls" }, m.ctx)],
  ["run", (m) => m.plugin.invoke("run", { code: "console.log(1)" }, m.ctx)],
  ["put", (m) => m.plugin.invoke("put", { ref: "artifact://raft/attachments/7/photo.jpg", path: "in/photo.jpg" }, m.ctx)],
  ["save", (m) => m.plugin.invoke("save", { path: "/work/out.txt" }, m.ctx)],
  ["keep", (m) => m.plugin.invoke("keep", { name: "env" }, m.ctx)],
  ["release", (m) => m.plugin.invoke("release", {}, m.ctx)],
  ["start_from", (m) => m.plugin.invoke("start_from", { name: "kept" }, m.ctx)],
  ["holds.release (idle: switch off)", (m) => m.plugin.holds!.release(m.ctx, { reason: "idle" })],
  ["holds.release (operator: delete)", (m) => m.plugin.holds!.release(m.ctx)],
  ["holds.withdraw", (m) => m.plugin.holds!.withdraw!(m.ctx)],
  ["files.list (look)", (m) => m.plugin.holds!.files!.list(m.ctx, "", (fn) => fn())],
  ["files.read (look)", (m) => m.plugin.holds!.files!.read(m.ctx, "out.txt", 1024, (fn) => fn())],
];
const recordFor = (boxId: string) => ({
  machines: { main: { boxId, createdAt: AT, lastUsedAt: AT, execs: 1, saved: [] } },
  envs: [{ name: "kept", snapId: "snap-kept", savedAt: AT }],
});

await check("every entry point, from an agent whose record names another agent's box: nothing it sends reaches that box", async () => {
  const bad: string[] = [];
  for (const [name, go] of ENTRY_POINTS) {
    const p = run9Project();
    p.put(OLD_ID, `${TENANT}/${AGENT_B}`);
    const before = JSON.stringify(p.boxes.get(OLD_ID));
    const a = mountOf(TENANT, AGENT_A, { record: recordFor(OLD_ID), lease: name.includes("idle") ? LEASE : null });
    p.o.caller = a.owner;
    await logged(() => go(a));
    if (p.crossings.length) bad.push(`${name}: ${JSON.stringify(p.crossings.map((c) => `${c.method} ${c.path}`))}`);
    else if (JSON.stringify(p.boxes.get(OLD_ID)) !== before) bad.push(`${name}: the box changed`);
    // It was asked about, so the check ran rather than nothing having been tried.
    else if (!p.lists().length) bad.push(`${name}: nothing asked whose the box is`);
    // A look writes nothing; every other path lets go of the box in the record.
    else if (!name.includes("look") && a.main()?.boxId === OLD_ID) bad.push(`${name}: the record still names it`);
  }
  must(bad.length === 0, bad.join("\n    "));
});

await check("the same entry points, from the box's own agent: each does reach it (the case above is not vacuous)", async () => {
  const missed: string[] = [];
  for (const [name, go] of ENTRY_POINTS) {
    const p = run9Project();
    p.put(OLD_ID, `${TENANT}/${AGENT_A}`);
    const a = mountOf(TENANT, AGENT_A, { record: recordFor(OLD_ID), lease: name.includes("idle") ? LEASE : null });
    p.o.caller = a.owner;
    await logged(() => go(a));
    if (!p.on(OLD_ID).length) missed.push(name);
    if (p.crossings.length) missed.push(`${name} crossed: ${JSON.stringify(p.crossings)}`);
  }
  must(missed.length === 0, `never reached its own box: ${missed.join(", ")}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.ok ? "" : `\n    ${r.error}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
