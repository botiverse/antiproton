/**
 * Several machines on one sandbox mount, by name.
 *
 * An agent that needs two machines at once (a server and a client, a build beside a clean checkout) names
 * the second with `machine`; with no name every tool acts on "main", exactly as before there were names.
 * Each machine is its own box with its own state, schedule and directory; the kept environments and the
 * session window stay the mount's. The cases below hold that, the limit on how many may exist at once
 * (switched-off ones included), the framework's side — one held thing per machine, a release by id acting
 * on that one only, a release with no id acting on all — and the reading of a record written before
 * machines, against run9 answers given here rather than a live box.
 */
import {
  BOX_KEY, BOX_STORE, MAIN_MACHINE, asBoxState, asMountState, machineOf, sandboxPlugin, unreadableEntries, usageOf,
} from "../src/plugins/sandbox.ts";
import type { MountActivity, Released } from "../src/plugins/types.ts";
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { heldLine, heldPrompt, heldResources } from "../src/runtime/held.ts";
import { warningText } from "../src/runtime/idle-lease.ts";
import { readFile } from "node:fs/promises";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const MIN = 60_000;
const LEASE = { warnMs: 5 * MIN, maxMs: 30 * MIN };
const T0 = 1_700_000_000_000;
const box = (id: string, extra: Record<string, unknown> = {}) =>
  ({ boxId: id, createdAt: T0, lastUsedAt: T0 + MIN, execs: 1, saved: [], ...extra });

type Call = { method: string; path: string; body?: any };

/**
 * A mount with `record` stored raw, and a run9 that records every request. Every exec finishes at once and
 * reports `cwd.next` as where it ended.
 */
function fixture(record: unknown, config: Record<string, unknown> = {}, refuse: (c: Call, put: (v: unknown) => void) => boolean = () => false) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId: "t", agentId: "a", alias: "sandbox", plugin: "sandbox" };
  if (record) tables.put(scope, BOX_STORE, BOX_KEY, record as any, null);
  const calls: Call[] = [];
  const cwd = { next: "/work" };
  let n = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const method = String(init?.method ?? "GET");
    const path = String(url).replace("https://sandbox.example", "");
    const c: Call = { method, path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) };
    calls.push(c);
    if (refuse(c, (v) => tables.put(scope, BOX_STORE, BOX_KEY, v as any, null))) return new Response(JSON.stringify({ error: "no" }), { status: 500 });
    if (method === "POST" && /background-execs$/.test(path)) return new Response(JSON.stringify({ exec_id: `e${++n}` }));
    if (/\/execs\/e\d+$/.test(path)) {
      return new Response(JSON.stringify({ state: "succeeded", exit_code: 0, output_summary: `ok\n__AP_CWD__${cwd.next}\n` }));
    }
    return new Response("{}");
  }) as any;
  const plugin = sandboxPlugin(null as any, "local", LEASE);
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://sandbox.example", project: "p", graceMs: 10_000, ...config },
    db: openPluginDatabase(tables, scope, plugin.database),
    sibling: async () => null, sandboxForms: async () => [],
  };
  const raw = () => tables.get(scope, BOX_STORE, BOX_KEY) as any;
  const mount = () => asMountState(raw())!;
  const creates = () => calls.filter((c) => c.method === "POST" && /\/workspace\/boxes$/.test(c.path));
  const execsOn = (id: string) => calls.filter((c) => c.method === "POST" && c.path.endsWith(`/boxes/${id}/background-execs`));
  const stops = (id: string) => calls.filter((c) => c.method === "POST" && c.path.endsWith(`/boxes/${id}/stop`));
  const deletes = (id: string) => calls.filter((c) => c.method === "DELETE" && c.path.endsWith(`/boxes/${id}`));
  return { plugin, ctx, calls, cwd, raw, mount, creates, execsOn, stops, deletes };
}

await check("with no machine named, everything is the one box it always was, stored as \"main\"", async () => {
  const f = fixture(null);
  const r: any = await f.plugin.invoke("shell", { command: "ls" }, f.ctx);
  must(f.creates().length === 1, `one box created: ${JSON.stringify(f.creates())}`);
  const id = f.creates()[0]!.body.box_id as string;
  must(/^h-t-a-[a-z0-9]+$/.test(id), `the default box's id has no machine in it: ${id}`);
  must(r.box === id && !("machine" in r), `the result is what it was: ${JSON.stringify(r)}`);
  must(Object.keys(f.raw().machines).join() === "main" && f.raw().machines.main.boxId === id, `stored as main: ${JSON.stringify(f.raw())}`);
  must(f.raw().boxId === undefined, "the old top-level shape is no longer written");
  must(asBoxState(f.raw())?.boxId === id, "the default view reads it");
});

await check("a named machine is its own box, with its own state and its own directory", async () => {
  const f = fixture(null);
  f.cwd.next = "/srv";
  await f.plugin.invoke("shell", { command: "cd /srv" }, f.ctx);
  f.cwd.next = "/build";
  const r: any = await f.plugin.invoke("shell", { command: "cd /build", machine: "build" }, f.ctx);
  must(f.creates().length === 2, `a second box for the named machine: ${f.creates().length}`);
  const [main, build] = [f.mount().machines.main!, f.mount().machines.build!];
  must(main.boxId !== build.boxId && /-build-/.test(build.boxId), `distinct ids, the name in the second: ${main.boxId} ${build.boxId}`);
  must(build.boxId.length <= 49, `the id is no longer than the default one can be: ${build.boxId}`);
  must(main.cwd === "/srv" && build.cwd === "/build", `each keeps its own directory: ${main.cwd} ${build.cwd}`);
  must(r.machine === "build" && r.box === build.boxId, `the result names its machine: ${JSON.stringify(r)}`);
  // The next default call goes to main's box and starts where main ended.
  f.cwd.next = "/srv";
  await f.plugin.invoke("shell", { command: "pwd" }, f.ctx);
  const last = f.calls.filter((c) => /background-execs$/.test(c.path)).at(-1)!;
  must(last.path.includes(`/boxes/${main.boxId}/`) && last.body.workdir === "/srv", `main resumed in its own place: ${JSON.stringify(last)}`);
  must(f.creates().length === 2, "no third box");
});

await check("a fourth machine is refused, the existing ones are listed, and run9 is asked nothing", async () => {
  const f = fixture({ machines: { main: box("b-main"), build: box("b-build"), web: box("b-web") } });
  let refused: any = null;
  try { await f.plugin.invoke("shell", { command: "ls", machine: "extra" }, f.ctx); } catch (e) { refused = e; }
  must(refused, "a fourth machine was created");
  const msg = String(refused.message);
  must(/main \(running\)/.test(msg) && /build \(running\)/.test(msg) && /web \(running\)/.test(msg), `lists the machines: ${msg}`);
  must(/`release`/.test(msg) && /maxMachines 3/.test(msg), `says what to do and which limit: ${msg}`);
  must(f.calls.length === 0, `run9 was called: ${JSON.stringify(f.calls)}`);
  must(!f.mount().machines.extra, "the refused machine was recorded");
  // An existing machine is still usable at the limit.
  await f.plugin.invoke("shell", { command: "ls", machine: "web" }, f.ctx);
  must(f.execsOn("b-web").length === 1 && f.creates().length === 0, "an existing machine at the limit was refused");
});

await check("a switched-off machine counts toward the limit; the setting moves it", async () => {
  const rec = { machines: { main: box("b-main"), build: box("b-build", { parkedAt: T0 + 2 * MIN }), web: box("b-web") } };
  const f = fixture(rec);
  let refused: any = null;
  try { await f.plugin.invoke("run", { code: "1", machine: "extra" }, f.ctx); } catch (e) { refused = e; }
  must(refused && /build \(switched off\)/.test(String(refused.message)), `a parked machine did not count: ${refused}`);
  const g = fixture(rec, { maxMachines: 4 });
  await g.plugin.invoke("run", { code: "1", machine: "extra" }, g.ctx);
  must(g.creates().length === 1 && g.mount().machines.extra?.boxId, "maxMachines 4 still refused a fourth");
  // A released machine frees its place.
  const h = fixture({ machines: { main: box("b-main"), build: box("b-build"), web: box("b-web") } });
  await h.plugin.invoke("release", { machine: "web" }, h.ctx);
  await h.plugin.invoke("shell", { command: "ls", machine: "extra" }, h.ctx);
  must(h.creates().length === 1, "releasing one did not make room");
});

await check("the release tool with a machine deletes that one only; without one, only main", async () => {
  const f = fixture({ machines: { main: box("b-main"), build: box("b-build") }, envs: [{ name: "e", snapId: "s1", savedAt: 1 }] });
  const r: any = await f.plugin.invoke("release", { machine: "build" }, f.ctx);
  must(r.released === true && r.machine === "build" && r.box === "b-build", `release: ${JSON.stringify(r)}`);
  must(f.deletes("b-build").length === 1 && f.deletes("b-main").length === 0, `deleted: ${JSON.stringify(f.calls)}`);
  must(!f.mount().machines.build && f.mount().machines.main?.boxId === "b-main", `record: ${JSON.stringify(f.raw())}`);
  must(f.mount().envs?.[0]?.name === "e", "kept environments are the mount's and survive a machine's release");
  const s = usageOf(asBoxState(f.raw()));
  must(s.length === 1 && s[0]!.id === "b-build" && (f.raw().sessions[0].machine === "build"), `the session names its machine: ${JSON.stringify(f.raw().sessions)}`);
  const none: any = await f.plugin.invoke("release", { machine: "build" }, f.ctx);
  must(none.released === false && /machine "build"/.test(none.note), `a released machine again: ${JSON.stringify(none)}`);
  await f.plugin.invoke("release", {}, f.ctx);
  must(f.deletes("b-main").length === 1, "no machine named means main");
});

await check("holds.release with an id acts on that machine only: parks a running one, deletes a parked one", async () => {
  const f = fixture({ machines: { main: box("b-main"), build: box("b-build"), old: box("b-old", { parkedAt: T0 + 2 * MIN }) } });
  const fact = await f.plugin.holds!.release(f.ctx, { reason: "idle", id: "b-build" }) as Released;
  must(fact && fact.id === "b-build" && fact.status === "freed", `the fact is that machine's: ${JSON.stringify(fact)}`);
  must(f.stops("b-build").length === 1 && f.deletes("b-build").length === 0, "the running machine was not just switched off");
  must(f.stops("b-main").length === 0 && f.deletes("b-main").length === 0, "main was touched");
  must(typeof f.mount().machines.build?.parkedAt === "number" && f.mount().machines.main?.parkedAt === undefined, `parked: ${JSON.stringify(f.raw())}`);
  await f.plugin.holds!.release(f.ctx, { reason: "idle", id: "b-old" });
  must(f.deletes("b-old").length === 1 && !f.mount().machines.old, "the parked machine was not deleted");
  must(f.mount().machines.main?.boxId === "b-main" && f.mount().machines.build?.boxId === "b-build", "the others were touched");
  const gone = await f.plugin.holds!.release(f.ctx, { reason: "idle", id: "b-nobody" });
  must(gone === false, `an id that names no machine released something: ${JSON.stringify(gone)}`);
});

await check("a release with no id lets every machine go and reports each", async () => {
  const f = fixture({ machines: { main: box("b-main"), build: box("b-build", { parkedAt: T0 + 2 * MIN }) } });
  const out = await f.plugin.holds!.release(f.ctx) as Released[];
  must(Array.isArray(out) && out.map((x) => x.id).sort().join() === "b-build,b-main", `one fact per machine: ${JSON.stringify(out)}`);
  must(f.deletes("b-main").length === 1 && f.deletes("b-build").length === 1, `both deleted: ${JSON.stringify(f.calls)}`);
  must(Object.keys(f.mount().machines).length === 0, `the record still names a machine: ${JSON.stringify(f.raw())}`);
  // One that will not go does not keep the other from going, and every fact rides on the error.
  const g = fixture({ machines: { main: box("b-main"), build: box("b-build") } },
    {}, (c) => c.method === "DELETE" && c.path.endsWith("/boxes/b-main"));
  let thrown: any = null;
  try { await g.plugin.holds!.release(g.ctx); } catch (e) { thrown = e; }
  must(thrown && /b-main not released/.test(String(thrown.message)), `the failure was not thrown: ${thrown}`);
  must(g.deletes("b-build").length === 1, "a failure on main kept build from going");
  const facts = thrown.released as Released[];
  must(Array.isArray(facts) && facts.some((x) => x.id === "b-main" && x.status === "error") && facts.some((x) => x.id === "b-build" && x.status === "freed"),
    `both facts ride on the error: ${JSON.stringify(facts)}`);
});

await check("a machine's release keeps what another wrote to the shared lists while it was being deleted", async () => {
  // The release reads the record, deletes the box, then writes. A session or kept environment recorded in
  // between (by a release of another machine that does not hold this one's lock) must survive the write.
  const start = { machines: { main: box("b-main"), build: box("b-build") }, sessions: [] };
  let raced = false;
  const f = fixture(start, {}, (c, put) => {
    if (c.method === "DELETE" && c.path.endsWith("/boxes/b-build") && !raced) {
      raced = true;
      put({ ...start, sessions: [{ boxId: "b-other", startedAt: T0, endedAt: T0 + MIN, lastUsedAt: T0, execs: 1, saved: [] }],
        envs: [{ name: "kept-meanwhile", snapId: "s9", savedAt: 9 }] });
    }
    return false;
  });
  await f.plugin.invoke("release", { machine: "build" }, f.ctx);
  must(raced, "the case never raced");
  const ids = (f.mount().sessions ?? []).map((x) => x.boxId);
  must(ids.includes("b-other") && ids.includes("b-build"), `a session written meanwhile was lost: ${JSON.stringify(ids)}`);
  must(f.mount().envs?.[0]?.name === "kept-meanwhile", `an environment kept meanwhile was lost: ${JSON.stringify(f.mount().envs)}`);
});

await check("a record from before machines reads as main, and the next write moves it to the new shape", async () => {
  const old = { boxId: "b-old", createdAt: T0, lastUsedAt: T0 + MIN, execs: 2, cwd: "/srv", sessions: [], envs: [{ name: "e", snapId: "s1", savedAt: 1 }] };
  const m = asMountState(old as any)!;
  must(m.machines.main?.boxId === "b-old" && m.machines.main.cwd === "/srv" && m.envs?.[0]?.name === "e", `old record: ${JSON.stringify(m)}`);
  must(asMountState({ boxId: "", createdAt: 0, lastUsedAt: 0, sessions: [] } as any)?.machines.main === undefined, "a released old record names no machine");
  must(asMountState({ boxId: 7 } as any) === null && unreadableEntries({ boxId: 7 } as any) === 1, "an unreadable old record is still unreadable");
  const f = fixture(old);
  f.cwd.next = "/srv";
  await f.plugin.invoke("shell", { command: "ls" }, f.ctx);
  must(f.creates().length === 0 && f.execsOn("b-old").length === 1, "the old box was not reused as main");
  must(f.execsOn("b-old")[0]!.body.workdir === "/srv", "its directory was lost");
  must(f.raw().machines?.main?.boxId === "b-old" && f.raw().boxId === undefined && f.raw().envs?.[0]?.name === "e", `rewritten: ${JSON.stringify(f.raw())}`);
  // A damaged entry is dropped and counted; the others survive it.
  const bad = { machines: { main: box("b-main"), "Bad Name": box("b-x"), web: { boxId: 3 } } };
  must(Object.keys(asMountState(bad as any)!.machines).join() === "main", "a damaged entry was read, or took the others with it");
  must(unreadableEntries(bad as any) === 2, `two damaged entries counted: ${unreadableEntries(bad as any)}`);
});

await check("machines lists each machine with its state, image, times and schedule", async () => {
  const f = fixture({ machines: {
    main: box("b-main", { image: "img:1", cwd: "/srv" }),
    build: box("b-build", { parkedAt: T0 + 2 * MIN }),
    next: { boxId: "", createdAt: 0, lastUsedAt: 0, startFrom: "s1" },
  }, envs: [{ name: "ready", snapId: "s1", savedAt: 1 }] });
  const r: any = await f.plugin.invoke("machines", {}, f.ctx);
  must(f.calls.length === 0, "listing called run9");
  const by = Object.fromEntries(r.machines.map((x: any) => [x.machine, x]));
  must(r.machines[0].machine === "main", "main first");
  must(by.main.state === "running" && by.main.image === "img:1" && by.main.cwd === "/srv", `main: ${JSON.stringify(by.main)}`);
  must(by.main.switchedOffAfter === new Date(T0 + MIN + LEASE.maxMs).toISOString(), `main's switch-off: ${by.main.switchedOffAfter}`);
  must(by.build.state === "switched off" && by.build.deletedAfter === new Date(T0 + 2 * MIN + 7 * 86_400_000).toISOString(), `build: ${JSON.stringify(by.build)}`);
  must(by.next.state === "none" && by.next.startsFrom === "ready", `pending: ${JSON.stringify(by.next)}`);
  must(r.limit === 3 && /2 of at most 3/.test(r.note), `limit: ${JSON.stringify(r)}`);
  const empty = fixture(null);
  const e: any = await empty.plugin.invoke("machines", {}, empty.ctx);
  must(e.machines.length === 1 && e.machines[0].machine === "main" && e.machines[0].state === "none", `empty: ${JSON.stringify(e)}`);
});

await check("start_from with a machine replaces that machine only, and its next box starts from the snapshot", async () => {
  const f = fixture({ machines: { main: box("b-main"), build: box("b-build") }, envs: [{ name: "ready", snapId: "s1", savedAt: 1, image: "img:k" }] });
  const r: any = await f.plugin.invoke("start_from", { name: "ready", machine: "build" }, f.ctx);
  must(r.released === true && r.releasedPrevious === "b-build" && r.machine === "build", `start_from: ${JSON.stringify(r)}`);
  must(f.deletes("b-build").length === 1 && f.deletes("b-main").length === 0, "main was released");
  must(f.mount().machines.build?.startFrom === "s1" && !f.mount().machines.main?.startFrom, `startFrom: ${JSON.stringify(f.raw())}`);
  await f.plugin.invoke("shell", { command: "ls", machine: "build" }, f.ctx);
  must(f.creates()[0]?.body.source_snap_id === "s1", `the new box did not start from the snapshot: ${JSON.stringify(f.creates())}`);
  must(f.mount().machines.build?.image === "img:k" && !f.mount().machines.build?.startFrom, "the new box's record");
});

await check("quiet acts on the named machine's schedule only", async () => {
  const f = fixture({ machines: { main: box("b-main"), build: box("b-build") } });
  const r: any = await f.plugin.invoke("quiet", { minutes: 20, machine: "build" }, f.ctx);
  must(r.quiet === true && r.box === "b-build", `quiet: ${JSON.stringify(r)}`);
  must(typeof f.mount().machines.build?.quietUntil === "number" && f.mount().machines.main?.quietUntil === undefined, "the wrong machine was postponed");
});

await check("a machine name that is not one is refused before anything happens", async () => {
  for (const bad of ["Build", "1st", "a b", "x".repeat(25), 7]) {
    let threw = false;
    try { machineOf({ machine: bad }); } catch { threw = true; }
    must(threw, `accepted ${JSON.stringify(bad)}`);
  }
  must(machineOf({}) === MAIN_MACHINE && machineOf({ machine: "" }) === MAIN_MACHINE && machineOf({ machine: "web-2" }) === "web-2", "valid names");
  const f = fixture(null);
  let threw = false;
  try { await f.plugin.invoke("shell", { command: "ls", machine: "../x" }, f.ctx); } catch { threw = true; }
  must(threw && f.calls.length === 0, "a bad name reached run9");
});

await check("activities: one per machine, each on its own schedule and named with what the tools need", async () => {
  const f = fixture({ machines: { main: box("b-main"), build: box("b-build", { parkedAt: T0 + 2 * MIN, lastUsedAt: T0 + 5 * MIN }) } });
  const acts = await f.plugin.holds!.activities!(f.ctx);
  must(acts.length === 2, `two: ${JSON.stringify(acts)}`);
  const [m, b] = acts as [MountActivity, MountActivity];
  must(m.live?.id === "b-main" && m.live.name === "main" && m.live.args === undefined, `main: ${JSON.stringify(m.live)}`);
  must(b.live?.id === "b-build" && b.live.name === "build" && JSON.stringify(b.live.args) === '{"machine":"build"}', `build: ${JSON.stringify(b.live)}`);
  must(m.live!.lease?.warnMs === 0 && b.live!.lease?.maxMs === 7 * 86_400_000, "each on its own state's schedule");
  must(/billed for every second/.test(String(m.billing)) && /stopped/.test(String(b.billing)), "each with its own cost");
  // The one answer prefers the running machine, though the parked one was used later.
  const one = await f.plugin.holds!.activity(f.ctx);
  must(one.live?.id === "b-main", `the summary hid the running machine: ${JSON.stringify(one.live)}`);
  // Alone, main is not named at all, as before.
  const solo = fixture({ machines: { main: box("b-main") } });
  const [s] = await solo.plugin.holds!.activities!(solo.ctx);
  must(s!.live?.name === undefined && s!.live?.args === undefined, `a lone main is named: ${JSON.stringify(s!.live)}`);
});

await check("the framework holds one thing per machine, and its sentences name the machine and its argument", async () => {
  const f = fixture({ machines: { main: box("b-main"), build: box("b-build") } });
  const held = await heldResources([{ alias: "sandbox", plugin: "sandbox" }], [f.plugin], () => f.plugin.holds!.activities!(f.ctx));
  must(held.length === 2 && held.map((h) => h.live.id).join() === "b-main,b-build", `one Held per machine: ${JSON.stringify(held.map((h) => h.live.id))}`);
  const nameOf = (alias: string, tool: string) => `${alias}__${tool}`;
  const line = heldLine(held[1]!, nameOf, T0 + 10 * MIN);
  must(/holding build \(b-build\)/.test(line) && /`sandbox__release` with \{"machine":"build"\}/.test(line), `line: ${line}`);
  const prompt = heldPrompt(held, nameOf)!;
  must(/main \(b-main\)/.test(prompt) && /build \(b-build\)/.test(prompt) && /`sandbox__quiet` with \{"machine":"build"\} keeps it longer/.test(prompt), `prompt: ${prompt}`);
  const warn = warningText("sandbox", { release: "sandbox__release", postpone: "sandbox__quiet" }, null, 25 * MIN, 5 * MIN, 60,
    { name: held[1]!.live.name, args: held[1]!.live.args });
  must(/mount's "build" has been idle/.test(warn) && /`sandbox__release` with \{"machine":"build"\}\./.test(warn), `warning: ${warn}`);
});

await check("the idle pass releases one thing at a time, by its id, and finds it again by id", async () => {
  // A reading of the source: the pass needs a live object to run (see test/held.ts for the same reading).
  const src = await readFile(new URL("../cf/src/runtime.ts", import.meta.url), "utf8");
  const at = src.indexOf("async #idlePass(");
  const body = src.slice(at, src.indexOf("\n  }\n", at));
  for (const use of ["mountActivities(", 'reason: "idle", id: h.live.id', "a.live?.id === h.live.id", "name: h.live.name, args: h.live.args"]) {
    must(body.includes(use), `the idle pass no longer reads ${use}`);
  }
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
