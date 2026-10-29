/**
 * Every provider route that reaches an agent refuses a token issued for another Raft origin.
 *
 * A platform token derives the tenant from `?raftServerId=` alone (`tenantFor`), so a token minted for another Raft
 * deployment that names this server's id lands in the same tenant. What stops it on the routes under
 * `/agents/<id>/…` is the check of the row's `raftOrigin` against the token's in `agentAt`
 * (cf/src/provision/handlers.ts), the one way a route reaches the agent its path names. The routes that reach agents
 * another way (a create's replay, a connector's agents) are cases of their own, at the end.
 *
 * The routes are not listed here by hand. `handleProvision` is an if-chain, not a table, so they are found by asking
 * it: every method, with every path the router's own words can spell (each lowercase literal in the handlers' and the
 * agent surface's source, one to three segments deep, a parameter where one may stand), is sent for an agent that does
 * not exist, and a request that looks the agent up is a route that takes an agent id. That the search reached every
 * route, and that each goes through `agentAt`, is checked against the source: every agent lookup in handlers.ts is
 * either named as not the path's (NOT_THE_PATH, with why) or is `agentAt`'s one lookup, which every found route
 * makes its lookup from.
 *
 * Then, for each route in both spellings (`/agents/<providerAgentId>/…`, `/agents/by-raft-agent/<raftAgentId>/…`):
 * the agent's own origin is served (a same-origin control), another origin is refused — a 404 or no route, with
 * nothing past the lookup touched. A tenant-scoped token likewise: its own tenant at its origin is served, another
 * origin or another tenant is refused.
 */
import { readFileSync } from "node:fs";
import { handleProvision, tenantFor, type ProvisionDeps } from "../cf/src/provision/handlers.ts";
import { CONNECTION_PROVIDERS } from "../cf/src/provision/connect.ts";
import type { ProvisionedAgent } from "../cf/src/control-plane.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const OURS = "https://api.raft.build";
const THEIRS = "https://raft.other.example";
const platform = (raftOrigin: string) => ({ label: "raft-deployment", raftOrigin, scope: "platform" as const });
const SERVER = "srv-1";
const TENANT = tenantFor(platform(OURS), SERVER) as string;
const RAFT_AGENT = "01JAGENT";
const AGENT = "raft_01JAGENT";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
/** Stands where a path takes a value of its own (an operation id): a word no route compares a segment with. */
const PARAM = "op_param1";

const HANDLERS = new URL("../cf/src/provision/handlers.ts", import.meta.url);
const SOURCES = [HANDLERS, new URL("../cf/src/agent-surface/surface.ts", import.meta.url)].map((u) => readFileSync(u, "utf8"));

/** Each lowercase word the router's source spells in quotes, a slash-joined literal taken apart. */
const WORDS = [...new Set(SOURCES.flatMap((s) => [...s.matchAll(/["'`]([a-z][a-z0-9/-]*)["'`]/g)])
  .flatMap((m) => m[1]!.split("/")).filter((w) => /^[a-z][a-z0-9-]*$/.test(w)))];

/** A stand-in for every dependency but the registry: any property is another stand-in, any call is recorded. */
function standIn(path: string, touched: string[]): any {
  return new Proxy(function () {}, {
    get(_t, k) { return k === "then" ? undefined : standIn(`${path}.${String(k)}`, touched); },
    apply() { touched.push(path); return Promise.resolve(null); },
  });
}

/** The line of handlers.ts a registry call came from, read off the stack. */
function callerLine(): number | null {
  const at = (new Error().stack ?? "").split("\n").find((l) => l.includes("provision/handlers.ts:"));
  const m = at?.match(/handlers\.ts:(\d+):/);
  return m ? Number(m[1]) : null;
}

/**
 * Deps whose registry holds `row` (or nothing) and records each lookup, and where every other dependency is a stand-in.
 * `touched` is what was reached past the lookup: a registry write, a call into the agent, D1, a connector.
 */
function deps(row: ProvisionedAgent | null, extra: Record<string, unknown> = {}, others: ProvisionedAgent[] = []) {
  const rows = [...(row ? [row] : []), ...others];
  const lookups: Array<{ by: string; id: string; line: number | null }> = [];
  const touched: string[] = [];
  const registry = new Proxy({} as Record<string, unknown>, {
    get(_t, k) {
      if (k === "get") return async (tenantId: string, id: string) => { lookups.push({ by: "raftAgentId", id, line: callerLine() }); return rows.find((r) => r.tenantId === tenantId && r.raftAgentId === id) ?? null; };
      if (k === "getByAgentId") return async (tenantId: string, id: string) => { lookups.push({ by: "agentId", id, line: callerLine() }); return rows.find((r) => r.tenantId === tenantId && r.agentId === id) ?? null; };
      return async () => { touched.push(`registry.${String(k)}`); return null; };
    },
  });
  const d = new Proxy({ now: () => 1_800_000_000_000, registry, ...extra } as Record<string, unknown>, {
    get(t, k) { return k in t ? t[k as string] : standIn(String(k), touched); },
  }) as unknown as ProvisionDeps;
  return { deps: d, lookups, touched };
}

/** A platform token of `who` when it is an origin; otherwise the token given. */
type Who = Parameters<typeof handleProvision>[4];
async function send(d: ProvisionDeps, method: string, path: string, who: string | Who, body: unknown = {}) {
  try {
    const r = await handleProvision(method, path, { idempotencyKey: null, raftServerId: SERVER, credentialId: "cred-1" }, body, typeof who === "string" ? platform(who) : who, d);
    return r === null ? { status: null as number | null, text: "" } : { status: r.status, text: await r.text() };
  } catch (e) {
    // A stand-in answers null where a real dependency answers a value, and a handler may trip on it: that is a request
    // the route served, past the agent.
    return { status: -1, text: String((e as Error)?.message ?? e) };
  }
}

/** Every (method, tail) that looks the agent up: the routes that take an agent id. A tail is what follows the id. */
async function findRoutes() {
  const tails: string[][] = [[]];
  const between = [PARAM, ...CONNECTION_PROVIDERS];
  for (const a of WORDS) {
    tails.push([a]);
    for (const b of [...WORDS, ...between]) tails.push([a, b]);
    for (const b of between) for (const c of WORDS) tails.push([a, b, c]);
  }
  const found = new Map<string, { method: string; tail: string[]; lines: Set<number> }>();
  for (const tail of tails) {
    for (const method of METHODS) {
      const f = deps(null);
      await send(f.deps, method, ["", "agents", AGENT, ...tail].join("/"), OURS);
      const own = f.lookups.filter((l) => l.id === AGENT);
      if (!own.length) continue;
      // A segment that took the parameter and a provider's name alike is a parameter, not a word: one route.
      if (tail.length === 3 && tail[1] !== PARAM && found.has(`${method} ${[tail[0], PARAM, tail[2]].join("/")}`)) continue;
      found.set(`${method} ${tail.join("/")}`, { method, tail, lines: new Set(own.map((l) => l.line).filter((n): n is number => n !== null)) });
    }
  }
  return found;
}

/**
 * The calls in handlers.ts that look an agent up by an id that is not the path's, each with why. Every other
 * `registry.get(` / `registry.getByAgentId(` call in the file is taken to look up the path's agent, and must be
 * reached by a found route. An entry here must match exactly one line, so one that goes stale fails.
 */
const NOT_THE_PATH: Array<{ call: string; why: string }> = [
  { call: "const row = await deps.registry.get(tenantId, raftAgentId);\n  if (!row || row.deletedAt !== null) return { ok: false", why: "repairPush: the id an operator names, no provider route" },
  { call: "let row = await deps.registry.get(tenantId, raftAgentId);", why: "POST /agents: the body's raftAgentId (a create or its replay; see the cases outside /agents/<id> below)" },
  { call: "const a = raftAgentId === row.raftAgentId ? row : await deps.registry.get(tenantId, raftAgentId);", why: "reconnect in place: the other agents bound to the connector" },
  { call: "for (const raftAgentId of bound) rows.set(raftAgentId, await deps.registry.get(tenantId, raftAgentId));", why: "DELETE /connectors/:id: the agents bound to the connector" },
  { call: "const got = await c.registry.get(tenantId, row.raftAgentId, p);", why: "the connection registry, keyed by an agent already found (two calls)" },
];
const HANDLERS_TEXT = readFileSync(HANDLERS, "utf8");
const lineOf = (offset: number) => HANDLERS_TEXT.slice(0, offset).split("\n").length;
/** Every agent lookup call in handlers.ts, by line. */
const LOOKUP_CALLS = [...HANDLERS_TEXT.matchAll(/registry\.(?:get|getByAgentId)\(/g)].map((m) => lineOf(m.index!));
/** The lines NOT_THE_PATH names, and how often each entry matched. */
const EXEMPT = NOT_THE_PATH.map((e) => {
  const at: number[] = [];
  for (let i = HANDLERS_TEXT.indexOf(e.call); i >= 0; i = HANDLERS_TEXT.indexOf(e.call, i + 1)) {
    const call = HANDLERS_TEXT.slice(i).search(/registry\.(?:get|getByAgentId)\(/);
    at.push(lineOf(i + call));
  }
  return { ...e, at };
});
/** The lines that must look up the path's agent: every lookup call NOT_THE_PATH does not explain. */
const LOOKUP_LINES = [...new Set(LOOKUP_CALLS.filter((n) => !EXEMPT.some((e) => e.at.includes(n))))];

const routes = await findRoutes();

await check("the search finds routes that take an agent id, the approval routes among them", async () => {
  assert(WORDS.length > 50, `only ${WORDS.length} words read from the router's source`);
  for (const r of ["GET approvals", `POST approvals/${PARAM}/decide`, "GET ", "DELETE ", "POST stop"]) {
    assert(routes.has(r), `${r} was not found; found: ${[...routes.keys()].join(", ")}`);
  }
});

await check("every agent lookup in handlers.ts is agentAt's, which every found route goes through, or named with a reason as not the path's", async () => {
  assert(LOOKUP_CALLS.length > LOOKUP_LINES.length && LOOKUP_LINES.length > 0, `lookups read from handlers.ts: ${LOOKUP_CALLS.length}, of the path's ${LOOKUP_LINES.length}`);
  const stale = EXEMPT.filter((e) => e.at.length !== (e.why.includes("two calls") ? 2 : 1));
  assert(stale.length === 0, `NOT_THE_PATH entries that match no call, or more than they say: ${stale.map((e) => `${e.call.split("\n")[0]} (${e.at.length})`).join("; ")}`);
  // The path's agent is looked up in one place, `agentAt`, and every found route made its lookup there.
  assert(LOOKUP_LINES.length === 1, `handlers.ts looks the path's agent up on lines ${LOOKUP_LINES.join(", ")}: only agentAt may`);
  const elsewhere = [...routes.entries()].filter(([, r]) => r.lines.size === 0 || [...r.lines].some((n) => n !== LOOKUP_LINES[0]));
  assert(elsewhere.length === 0, `looked the path's agent up outside agentAt (handlers.ts:${LOOKUP_LINES[0]}): ${elsewhere.map(([k, r]) => `${k} at ${[...r.lines].join(",")}`).join("; ")}`);
});

const row: ProvisionedAgent = {
  tenantId: TENANT, raftAgentId: RAFT_AGENT, agentId: AGENT, raftServerId: SERVER, raftOrigin: OURS, name: "Cody", instructions: "",
  credentialHash: null, status: "active", pushRegistered: true, pushError: null, createdAt: 1, updatedAt: 1, deletedAt: null,
};
/** Refused: a 404 or no route at all, and nothing past the lookup reached. */
const refused = (r: { status: number | null }, touched: string[]) => (r.status === null || r.status === 404) && touched.length === 0;

const served: Array<{ name: string; method: string; path: string }> = [];
await check("each route serves its agent's own origin and refuses another origin's token, in both spellings", async () => {
  const problems: string[] = [];
  for (const [name, { method, tail }] of routes) {
    for (const spelling of [[AGENT], ["by-raft-agent", RAFT_AGENT]]) {
      const path = ["", "agents", ...spelling, ...tail].join("/");
      const ours = deps(row);
      const control = await send(ours.deps, method, path, OURS);
      // A method the route does not serve is refused to its own origin too; it has nothing to refuse to another.
      if (refused(control, ours.touched)) continue;
      served.push({ name, method, path });
      const theirs = deps(row);
      const other = await send(theirs.deps, method, path, THEIRS);
      if (refused(other, theirs.touched)) continue;
      const seen = `${method} ${path} → ${other.status}${theirs.touched.length ? `, reached ${[...new Set(theirs.touched)].join(" ")}` : ""}`;
      problems.push(seen);
    }
  }
  assert(served.length > 0, "no route served its own origin: the control proves nothing");
  assert(problems.length === 0, `another origin's token was served:\n        ${problems.join("\n        ")}`);
});

await check("a tenant-scoped token: its tenant at its origin is served; another origin, or another tenant, is refused", async () => {
  const tenantToken = (tenantId: string, raftOrigin: string) => ({ label: "raft-tenant", tenantId, raftOrigin, scope: "tenant" as const });
  const problems: string[] = [];
  for (const { method, path } of served) {
    const own = deps(row);
    if (refused(await send(own.deps, method, path, tenantToken(TENANT, OURS)), own.touched)) problems.push(`${method} ${path}: refused its own tenant token`);
    for (const [why, who] of [["another origin", tenantToken(TENANT, THEIRS)], ["another tenant", tenantToken("t-other", OURS)]] as const) {
      const d = deps(row);
      const r = await send(d.deps, method, path, who);
      if (!refused(r, d.touched)) problems.push(`${method} ${path}: served ${why}'s tenant token (${r.status})`);
    }
  }
  assert(served.length > 0 && problems.length === 0, problems.join("\n        ") || "nothing served");
});

// ---- the cases outside /agents/<id>/…: a route that reaches an agent another way --------------------------------

const SEALED = { ciphertext: "c", iv: "i" };
const CONNECTOR = { id: "k1", tenantId: TENANT, provider: "github", account: "octo", accountId: "1", creatorRaftUserId: "u-1", sealed: SEALED, createdAt: 1 };
/** Connections whose calls are recorded: `acted` names each agent a call changed, `touched` everything else reached. */
function connections(acted: string[], bound: string[]) {
  return {
    newId: () => "k-new",
    confirm: async () => ({ ok: true, account: "octo", accountId: "1", sealed: SEALED, refresh: null, reconnect: { connectorId: "k1", actingRole: "admin" } }),
    connectors: {
      get: async () => CONNECTOR, reconnect: async () => true, record: async () => {}, remove: async () => { acted.push("connector removed"); }, create: async () => {},
    },
    registry: { boundTo: async () => bound, remove: async () => {}, put: async () => {}, get: async () => null },
    reconnect: async (_t: string, agentId: string) => { acted.push(agentId); return { ok: true, updated: true }; },
    detachIfFrom: async (_t: string, agentId: string) => { acted.push(agentId); return true; },
    attach: async (_t: string, agentId: string) => { acted.push(agentId); return { ok: true, account: "octo" }; },
  };
}
const THEIR_AGENT: ProvisionedAgent = { ...row, raftAgentId: "01JTHEIRS", agentId: "raft_01JTHEIRS", raftOrigin: THEIRS };
const CREATE = (raftOrigin: string) => ({ raftAgentId: RAFT_AGENT, raftServerId: SERVER, raftOrigin, name: "Cody", instructions: "", credential: "sk_agent_" + "R".repeat(32) });

/**
 * Each case: what the agent's own origin gets (served) and whether another origin's token still gets more than a
 * refusal (`open`), with what it answered.
 */
const OUTSIDE: Record<string, () => Promise<{ served: boolean; open: boolean; seen: string }>> = {
  // A create replayed by another origin, for a Raft agent id this tenant already has. Refused: 409 agent_id_taken
  // (the id is taken, as the unique index says), never the replay's field-by-field conflict, nothing run.
  "POST /agents replayed by another origin": async () => {
    const ours = deps(row);
    const control = await send(ours.deps, "POST", "/agents", OURS, CREATE(OURS));
    const theirs = deps(row);
    const other = await send(theirs.deps, "POST", "/agents", THEIRS, CREATE(THEIRS));
    const code = (() => { try { return JSON.parse(other.text)?.error?.code; } catch { return null; } })();
    return { served: control.status !== 404 && ours.touched.length > 0, open: !(other.status === 409 && code === "agent_id_taken" && theirs.touched.length === 0), seen: `${other.status} ${other.text.slice(0, 160)}` };
  },
  // Disconnecting a connector one of this origin's agents is bound to.
  "DELETE /connectors/:id from another origin": async () => {
    const body = { actingRaftUserId: "u-1", actingRole: "admin" };
    const mine: string[] = [], theirs: string[] = [];
    const control = await send(deps(row, { connections: connections(mine, [RAFT_AGENT]) }).deps, "DELETE", "/connectors/k1", OURS, body);
    const other = await send(deps(row, { connections: connections(theirs, [RAFT_AGENT]) }).deps, "DELETE", "/connectors/k1", THEIRS, body);
    return { served: control.status === 200 && mine.includes(AGENT), open: theirs.length > 0, seen: `${other.status}, changed ${theirs.join(" ") || "nothing"}` };
  },
  // A reconnect in place confirmed for this origin's agent, on a connector another origin's agent is bound to too.
  "confirm's reconnect in place reaches another origin's agent": async () => {
    const acted: string[] = [];
    const r = await send(deps(row, { connections: connections(acted, [RAFT_AGENT, THEIR_AGENT.raftAgentId]) }, [THEIR_AGENT]).deps,
      "POST", `/agents/${AGENT}/connections/github/confirm`, OURS, { pending: "pending-123", raftUserId: "u-1" });
    return { served: acted.includes(AGENT), open: acted.includes(THEIR_AGENT.agentId), seen: `${r.status}, reconnected ${acted.join(" ")}` };
  },
};
await check("outside /agents/<id>: each case serves its own origin, and refuses another origin", async () => {
  const problems: string[] = [];
  for (const [name, probe] of Object.entries(OUTSIDE)) {
    const r = await probe();
    if (!r.served) problems.push(`${name}: the control was not served (${r.seen})`);
    else if (r.open) problems.push(`${name}: another origin was served (${r.seen})`);
  }
  assert(problems.length === 0, problems.join("\n        "));
});

console.log(`  ${routes.size} (method, path) pairs take an agent id; ${served.length} (both spellings) served for their own origin; ${Object.keys(OUTSIDE).length} cases outside /agents/<id>`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
