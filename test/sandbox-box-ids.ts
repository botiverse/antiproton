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
 */
import { BOX_KEY, BOX_STORE, MAIN_MACHINE, asMountState, boxIdFor, sandboxPlugin } from "../src/plugins/sandbox.ts";
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

type Call = { method: string; path: string; body?: any };

/**
 * A run9 project shared by every mount made from it, as the real one is. `boxes` is what it lists; a create of an
 * id it already holds is refused as run9 refuses it, and `lose` makes the next create land and its answer be lost.
 */
function run9Project() {
  const boxes = new Map<string, Record<string, unknown>>();
  const calls: Call[] = [];
  const o = { lose: false };
  let n = 0;
  globalThis.fetch = (async (url: string, init?: any) => {
    const method = String(init?.method ?? "GET");
    const path = String(url).replace("https://run9.example", "");
    const c: Call = { method, path, ...(init?.body ? { body: JSON.parse(init.body) } : {}) };
    calls.push(c);
    if (method === "POST" && /\/workspace\/boxes$/.test(path)) {
      if (boxes.has(c.body.box_id)) return new Response(JSON.stringify({ error: "box already exists" }), { status: 400 });
      boxes.set(c.body.box_id, { box_id: c.body.box_id, state: "ready", description: c.body.description });
      if (o.lose) { o.lose = false; return new Response(JSON.stringify({ error: "duplicate key value violates unique constraint" }), { status: 400 }); }
      return new Response(JSON.stringify({ box_id: c.body.box_id, state: "ready" }), { status: 201 });
    }
    if (method === "GET" && /\/workspace\/boxes$/.test(path)) return new Response(JSON.stringify([...boxes.values()]));
    if (method === "POST" && /background-execs$/.test(path)) return new Response(JSON.stringify({ exec_id: `e${++n}` }));
    if (/\/execs\/e\d+$/.test(path)) return new Response(JSON.stringify({ state: "succeeded", exit_code: 0, output_summary: "ok\n__AP_CWD__/work\n" }));
    return new Response("{}");
  }) as any;
  const creates = () => calls.filter((c) => c.method === "POST" && /\/workspace\/boxes$/.test(c.path));
  const execsOn = (id: string) => calls.filter((c) => c.method === "POST" && c.path.endsWith(`/boxes/${id}/background-execs`));
  return { boxes, calls, creates, execsOn, o };
}

function mountOf(tenantId: string, agentId: string) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const scope = { tenantId, agentId, alias: "sandbox", plugin: "sandbox" };
  const plugin = sandboxPlugin(null as any, "local", null);
  const ctx: any = {
    caller: { tenantId, agentId, taskId: "k" }, alias: "sandbox",
    credential: JSON.stringify({ ak: "a", sk: "b" }),
    publicConfig: { endpoint: "https://run9.example", project: "p", graceMs: 10_000 },
    db: openPluginDatabase(tables, scope, plugin.database),
    sibling: async () => null, sandboxForms: async () => [],
  };
  const main = () => asMountState(tables.get(scope, BOX_STORE, BOX_KEY) as any)?.machines.main;
  return { plugin, ctx, main };
}

const realNow = Date.now;
const frozen = <T>(fn: () => Promise<T>) => { Date.now = () => AT; return fn().finally(() => { Date.now = realNow; }); };
const thrown = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return String((e as Error)?.message ?? e); } };

await check("two agents of one server, first command in the same millisecond: two creates, two boxes, each its own", async () => {
  const p = run9Project();
  const a = mountOf(TENANT, AGENT_A), b = mountOf(TENANT, AGENT_B);
  await frozen(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx));
  await frozen(() => b.plugin.invoke("shell", { command: "ls" }, b.ctx));
  const ids = p.creates().map((c) => c.body.box_id as string);
  must(ids.length === 2 && ids[0] !== ids[1], `creates: ${JSON.stringify(ids)}`);
  must(a.main()?.boxId === ids[0] && b.main()?.boxId === ids[1], `records: ${a.main()?.boxId} ${b.main()?.boxId}`);
  must(p.execsOn(ids[0]!).length === 1 && p.execsOn(ids[1]!).length === 1, "each command ran in its own agent's box");
});

await check("a box listed under the minted id but made for another owner is not adopted: the create's refusal stands", async () => {
  const p = run9Project();
  const a = mountOf(TENANT, AGENT_A);
  const id = await boxIdFor({ tenantId: TENANT, agentId: AGENT_A, mount: "sandbox", machine: MAIN_MACHINE }, AT);
  p.boxes.set(id, { box_id: id, state: "idle", description: `antiproton ${TENANT}/${AGENT_B}` });
  const err = await thrown(() => frozen(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx)));
  must(err !== null && /already exists/.test(err), `the create's own refusal: ${err}`);
  must(!a.main()?.boxId, `no record names the other owner's box: ${JSON.stringify(a.main())}`);
  must(p.execsOn(id).length === 0, "a command ran in the other owner's box");
});

await check("a box listed under the minted id with no description is not adopted either", async () => {
  const p = run9Project();
  const a = mountOf(TENANT, AGENT_A);
  const id = await boxIdFor({ tenantId: TENANT, agentId: AGENT_A, mount: "sandbox", machine: MAIN_MACHINE }, AT);
  p.boxes.set(id, { box_id: id, state: "idle" });
  const err = await thrown(() => frozen(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx)));
  must(err !== null && /already exists/.test(err), `the create's own refusal: ${err}`);
  must(!a.main()?.boxId && p.execsOn(id).length === 0, `adopted: ${JSON.stringify(a.main())}`);
});

await check("a create whose answer was lost is still adopted: the box is there, made for this owner", async () => {
  const p = run9Project();
  const a = mountOf(TENANT, AGENT_A);
  p.o.lose = true;
  const r: any = await frozen(() => a.plugin.invoke("shell", { command: "ls" }, a.ctx));
  const id = p.creates()[0]!.body.box_id as string;
  must(p.creates().length === 1 && p.boxes.has(id), `one create, landed: ${p.creates().length}`);
  must(a.main()?.boxId === id && r.box === id, `adopted and recorded: ${JSON.stringify(a.main())} ${JSON.stringify(r)}`);
  must(p.execsOn(id).length === 1, "the command ran in the adopted box");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.ok ? "" : `\n    ${r.error}`}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
