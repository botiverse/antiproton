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
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
  { call: "const row = await deps.registry.get(tenantId, raftAgentId).catch(() => undefined);", why: "DELETE /connectors/:id: the agents bound to the connector" },
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
/** This origin's connector, which another origin's token must never reach. */
const CONNECTOR = { id: "k1", tenantId: TENANT, provider: "github", account: "octo", accountId: "1", creatorRaftUserId: "u-1", raftOrigin: OURS, sealed: SEALED, createdAt: 1 };
/**
 * Connections whose calls are recorded: `acted` names each agent a call changed, and each connector written or removed.
 * `store` is the tenant's connectors, every origin's, as D1 holds them.
 */
/** How an agent's mount answers a detach: by the connector's credential (`match`), then by the agent (`byAgent`). */
type DetachMode = { match: boolean | "throw"; byAgent: boolean | "throw" };
function connections(acted: string[], bound: string[], store: Array<typeof CONNECTOR> = [CONNECTOR], modes: Record<string, DetachMode> = {}) {
  const answer = (v: boolean | "throw", what: string) => { if (v === "throw") throw new Error(`${what} failed`); return v; };
  return {
    newId: () => "k-new",
    confirm: async () => ({ ok: true, account: "octo", accountId: "1", sealed: SEALED, refresh: null, reconnect: { connectorId: "k1", actingRole: "admin" } }),
    link: async () => ({ url: "https://link.example/x", expiresAt: "2026-01-01T00:00:00.000Z" }),
    connectors: {
      get: async (_t: string, id: string) => store.find((k) => k.id === id) ?? null,
      list: async (_t: string, provider: string) => store.filter((k) => k.provider === provider),
      reconnect: async (_t: string, id: string) => { acted.push(`connector ${id} reconnected`); return true; },
      record: async () => {}, checked: async () => {},
      remove: async () => { acted.push("connector removed"); }, create: async () => {},
    },
    registry: { boundTo: async () => bound, remove: async () => {}, put: async () => {}, get: async () => null },
    reconnect: async (_t: string, agentId: string) => { acted.push(agentId); return { ok: true, updated: true }; },
    detachIfFrom: async (_t: string, agentId: string) => {
      const m = answer(modes[agentId]?.match ?? true, "the match");
      if (m) acted.push(agentId);
      return m;
    },
    detach: async (_t: string, agentId: string) => {
      const m = answer(modes[agentId]?.byAgent ?? true, "the detach by agent");
      if (m) acted.push(`${agentId} by agent`);
      return m;
    },
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

await check("handlers.ts reads a connector only through ownConnector, and never holds the registry or the connectors under another name", async () => {
  const src = HANDLERS_TEXT;
  const reads = [...src.matchAll(/connectors\.(?:get|list)\(/g)].map((m) => lineOf(m.index!));
  const own = src.split("\n").flatMap((l, i) => /^async function ownConnectors?\(/.test(l) ? [i + 1] : []);
  // Each read is the body of one of the two helpers: the line after its signature.
  const outside = reads.filter((n) => !own.some((o) => n === o + 1));
  assert(own.length === 2 && reads.length === 2 && outside.length === 0, `connector reads outside ownConnector: handlers.ts:${outside.join(",")} (helpers at ${own.join(",")})`);
  // A name for the registry or the connectors would let a lookup, or a read, past both checks above.
  const aliases = [
    ...src.matchAll(/=\s*(?:deps|c|connections)\s*\.\s*(?:registry|connectors)\s*[;,)\n]/g),
    ...src.matchAll(/\{[^}]*\b(?:registry|connectors)\b[^}]*\}\s*=\s*(?:deps|c)\b/g),
    ...src.matchAll(/\[\s*["'`](?:registry|connectors|get|getByAgentId|list)["'`]\s*\]/g),
  ].map((m) => `${lineOf(m.index!)}: ${m[0].trim()}`);
  assert(aliases.length === 0, `aliased: ${aliases.join("; ")}`);
});

// ---- another origin's own agent, and this origin's connector --------------------------------------------------

/**
 * Another Raft origin's platform token names this server's id, so it is in this tenant, and makes an agent of its
 * own there (a create checks the body's origin against the token's, nothing more). Through that agent it must not
 * list, attach, reconnect or disconnect this origin's connector, and each answer must be the bytes a connector that
 * does not exist gets: any difference would tell it that one does.
 */
const ACTING = { actingRaftUserId: "u-9", actingRole: "admin" };
const FOREIGN_OPS: Record<string, { method: string; path: (agent: string) => string; body: (origin: string, id: string) => unknown; who: "agent" | "token" }> = {
  list: { method: "GET", path: (a) => `/agents/${a}/connections/github`, body: () => ({}), who: "agent" },
  attach: { method: "PUT", path: (a) => `/agents/${a}/connections/github`, body: (_o, id) => ({ connectorId: id, ...ACTING }), who: "agent" },
  "reconnect (the link)": { method: "POST", path: (a) => `/agents/${a}/connections/github`,
    body: (o, id) => ({ returnUrl: `${o}/back`, initiatedBy: { raftUserId: "u-9" }, connectorId: id, actingRole: "admin" }), who: "agent" },
  "reconnect (the confirm)": { method: "POST", path: (a) => `/agents/${a}/connections/github/confirm`, body: () => ({ pending: "pending-123", raftUserId: "u-9" }), who: "agent" },
  disconnect: { method: "DELETE", path: () => "/connectors/k1", body: () => ACTING, who: "token" },
};

await check("another origin's own agent cannot list, attach, reconnect or disconnect this origin's connector, and each answer is a missing connector's, byte for byte", async () => {
  const problems: string[] = [];
  for (const [name, op] of Object.entries(FOREIGN_OPS)) {
    const run = async (origin: string, store: Array<typeof CONNECTOR>, id = "k1") => {
      const acted: string[] = [];
      const agent = origin === OURS ? row : THEIR_AGENT;
      const d = deps(agent, { connections: connections(acted, [agent.raftAgentId], store) }, origin === OURS ? [THEIR_AGENT] : [row]);
      const path = op.path(agent.agentId).replace("/connectors/k1", `/connectors/${id}`);
      const r = await send(d.deps, op.method, path, origin, op.body(origin, id));
      return { ...r, acted, touched: d.touched };
    };
    // Control: this origin's own agent and token reach it.
    const ours = await run(OURS, [CONNECTOR]);
    const reached = op.method === "GET" ? ours.text.includes('"k1"') : ours.acted.length > 0 || ours.status === 200;
    if (!reached) { problems.push(`${name}: the control did not reach the connector (${ours.status} ${ours.text.slice(0, 160)})`); continue; }
    const foreign = await run(THEIRS, [CONNECTOR]);
    const absent = await run(THEIRS, []);
    const other = await run(THEIRS, [], "k-0b5e7c1d");
    if (foreign.acted.some((a) => a.includes("k1") || a === AGENT || a === "connector removed")) problems.push(`${name}: changed ${foreign.acted.join(", ")}`);
    if (foreign.text.includes("octo") || foreign.text.includes("u-1")) problems.push(`${name}: the connector's account or creator was shown: ${foreign.text.slice(0, 200)}`);
    if (foreign.status !== absent.status || foreign.text !== absent.text) {
      problems.push(`${name}: not a missing connector's answer:\n          foreign ${foreign.status} ${foreign.text.slice(0, 200)}\n          absent  ${absent.status} ${absent.text.slice(0, 200)}`);
    }
    // A random id that never existed: the same bytes but for the id the request named, which the answer echoes.
    if (other.status !== absent.status || other.text.replaceAll("k-0b5e7c1d", "k1") !== absent.text) {
      problems.push(`${name}: a random missing id answers otherwise: ${other.status} ${other.text.slice(0, 200)}`);
    }
  }
  assert(problems.length === 0, problems.join("\n        "));
});

/** A D1 over node:sqlite with every migration applied, up to (not including) `before` when given. */
function d1(before?: string) {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../cf/migrations/", import.meta.url);
  const files = readdirSync(dir).filter((n) => n.endsWith(".sql")).sort();
  const at = before ? files.findIndex((n) => n.startsWith(before)) : files.length;
  assert(at > 0, `no migration ${before}`);
  const apply = (fs: string[]) => { for (const f of fs) db.exec(readFileSync(new URL(f, dir), "utf8")); };
  apply(files.slice(0, at));
  const stmt = (q: string, b: unknown[] = []): any => ({
    bind: (...v: unknown[]) => stmt(q, v),
    first: async () => (db.prepare(q).get(...(b as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(q).all(...(b as any[])) }),
    run: async () => ({ meta: { changes: Number(db.prepare(q).run(...(b as any[])).changes) } }),
  });
  const D1 = { prepare: (q: string) => stmt(q) } as unknown as D1Database;
  /** A fixture: agents of two origins, connectors, bindings and create events, as they could be before 0030. */
  const agent = (id: string, origin: string) => db.prepare("INSERT INTO provisioned_agents(tenant_id, raft_agent_id, agent_id, raft_server_id, raft_origin, name, instructions, status, created_at, updated_at) VALUES (?, ?, ?, 'srv-1', ?, 'n', '', 'active', 1, 1)")
    .run(TENANT, id, `raft_${id}`, origin);
  const connector = (id: string) => db.prepare("INSERT INTO connectors(id, tenant_id, provider, account, creator_raft_user_id, ciphertext, iv, created_at) VALUES (?, ?, 'github', 'octo', 'u-1', 'c', 'i', 1)").run(id, TENANT);
  const bind = (agentId: string, id: string) => db.prepare("INSERT INTO provisioned_connections(tenant_id, raft_agent_id, provider, account, connected_by, connected_at, connector_id) VALUES (?, ?, 'github', 'octo', 'u-1', 1, ?)").run(TENANT, agentId, id);
  const made = (agentId: string, id: string) => db.prepare("INSERT INTO connector_events(tenant_id, connector_id, raft_agent_id, action, acting_raft_user_id, acting_role, at) VALUES (?, ?, ?, 'create', 'u-1', 'creator', 1)").run(TENANT, id, agentId);
  return { db, D1, rest: () => apply(files.slice(at)), agent, connector, bind, made };
}

await check("disconnect: each bound agent ends detached, kept, cleared elsewhere, or failed; only the first is clean, and another origin's ids are not answered", async () => {
  const MINE2: ProvisionedAgent = { ...row, raftAgentId: "01JMINE2", agentId: "raft_01JMINE2" };
  const MINE3: ProvisionedAgent = { ...row, raftAgentId: "01JMINE3", agentId: "raft_01JMINE3" };
  const THEIRS2: ProvisionedAgent = { ...THEIR_AGENT, raftAgentId: "01JTHEIRS2", agentId: "raft_01JTHEIRS2" };
  const go = async (agents: ProvisionedAgent[], modes: Record<string, DetachMode>) => {
    const acted: string[] = [];
    const d = deps(agents[0]!, { connections: connections(acted, agents.map((a) => a.raftAgentId), [CONNECTOR], modes) }, agents.slice(1));
    const r = await send(d.deps, "DELETE", "/connectors/k1", OURS, ACTING);
    return { ...r, body: JSON.parse(r.text || "null"), acted };
  };
  // Clean: this origin's agent, by the connector's credential. Kept: this origin's agent whose mount holds another
  // credential (a key put there since): left as it is, named apart, never as detached.
  const clean = await go([row, MINE2], { [MINE2.agentId]: { match: false, byAgent: true } });
  assert(clean.status === 200 && JSON.stringify(clean.body.detached) === JSON.stringify([RAFT_AGENT]) && JSON.stringify(clean.body.kept) === JSON.stringify([MINE2.raftAgentId])
    && !("otherOrigins" in clean.body) && !clean.acted.includes(`${MINE2.agentId} by agent`) && clean.acted.includes("connector removed"), `clean and kept: ${clean.status} ${clean.text}`);
  // Cleared elsewhere: another origin's agents, held an older copy (the match fails), removed by the agent. Not clean,
  // and their ids are not in the answer.
  const other = await go([row, THEIR_AGENT, THEIRS2], { [THEIR_AGENT.agentId]: { match: false, byAgent: true } });
  assert(other.status === 200 && JSON.stringify(other.body.detached) === JSON.stringify([RAFT_AGENT]) && other.body.otherOrigins?.cleared === 2
    && other.body.otherOrigins.failed === 0 && /re-authorise or revoke it on GitHub/.test(other.body.otherOrigins.message)
    && !other.text.includes("THEIRS") && other.acted.includes(`${THEIR_AGENT.agentId} by agent`), `elsewhere: ${other.status} ${other.text}`);
  // Failed: neither the match nor the agent removes it. Never detached; the connector stays, for the same call again.
  const mine = await go([row, MINE3], { [MINE3.agentId]: { match: "throw", byAgent: true } });
  assert(mine.status === 502 && mine.body.error.code === "partially_disconnected" && JSON.stringify(mine.body.detached) === JSON.stringify([RAFT_AGENT])
    && mine.body.failed?.[0]?.raftAgentId === MINE3.raftAgentId && !mine.acted.includes("connector removed"), `failed: ${mine.status} ${mine.text}`);
  // Another origin's agent whose older copy the agent detach cannot remove either.
  const theirs = await go([row, THEIR_AGENT], { [THEIR_AGENT.agentId]: { match: false, byAgent: "throw" } });
  assert(theirs.status === 502 && theirs.body.otherOrigins?.failed === 1 && (theirs.body.failed ?? []).length === 0 && !theirs.text.includes("THEIRS")
    && !theirs.acted.includes("connector removed"), `failed elsewhere: ${theirs.status} ${theirs.text}`);
});

await check("migration 0030 on a fixture made before it: each connector takes the origin of the agent it was made for, or none; another origin's bindings are cut, each recorded first", async () => {
  const f = d1("0030_");
  // One connection per agent and provider: an agent for each binding.
  for (const [id, origin] of [["A", OURS], ["B", THEIRS], ["C", OURS], ["D", THEIRS], ["E", OURS], ["F", OURS], ["G", THEIRS]] as const) f.agent(id, origin);
  // Made for A (ours); B of another origin bound to it too, as nothing stopped before 0030.
  f.connector("k_made"); f.made("A", "k_made"); f.bind("A", "k_made"); f.bind("B", "k_made");
  // Made for an agent with no row any more, bound to D alone: no origin, not D's.
  f.connector("k_orphan"); f.made("GONE", "k_orphan"); f.bind("D", "k_orphan");
  // No event, bound to C and E, both ours: no origin either; bound agents say who holds it, not who made it.
  f.connector("k_bound"); f.bind("C", "k_bound"); f.bind("E", "k_bound");
  f.connector("k_split"); f.bind("F", "k_split"); f.bind("G", "k_split");
  f.connector("k_none");
  f.rest();
  const got = Object.fromEntries((f.db.prepare("SELECT id, raft_origin FROM connectors ORDER BY id").all() as any[]).map((r) => [r.id, r.raft_origin]));
  const want = { k_bound: null, k_made: OURS, k_none: null, k_orphan: null, k_split: null };
  assert(JSON.stringify(got) === JSON.stringify(want), `backfilled: ${JSON.stringify(got)}`);
  const bindings = (f.db.prepare("SELECT raft_agent_id || ':' || connector_id AS b FROM provisioned_connections ORDER BY b").all() as any[]).map((r) => r.b);
  assert(JSON.stringify(bindings) === JSON.stringify(["A:k_made", "C:k_bound", "D:k_orphan", "E:k_bound", "F:k_split", "G:k_split"]), `bindings left: ${JSON.stringify(bindings)}`);
  const cut = f.db.prepare("SELECT * FROM connector_events WHERE action = 'origin_mismatch_removed'").all() as any[];
  assert(cut.length === 1 && cut[0].connector_id === "k_made" && cut[0].raft_agent_id === "B" && cut[0].acting_role === "system" && cut[0].at > 1_700_000_000_000
    && JSON.stringify(JSON.parse(cut[0].reason)) === JSON.stringify({ agentOrigin: THEIRS, connectorOrigin: OURS, provider: "github" }), `the record of the cut: ${JSON.stringify(cut)}`);
});

await check("renewal: a connector's pair reaches only its own origin's agents; another origin's agent, or any agent of one with no origin, finds no connector", async () => {
  const f = d1();
  for (const [id, origin] of [["A", OURS], ["B", THEIRS], ["C", OURS], ["F", OURS]] as const) f.agent(id, origin);
  const put = (id: string, origin: string | null) => f.db.prepare("INSERT INTO connectors(id, tenant_id, provider, account, creator_raft_user_id, ciphertext, iv, created_at, raft_origin) VALUES (?, ?, 'github', 'octo', 'u-1', 'c', 'i', 1, ?)").run(id, TENANT, origin);
  put("k1", OURS); put("k_null", null);
  // A binding of another origin's agent that the migration did not see (written around the new checks).
  f.bind("A", "k1"); f.bind("B", "k1"); f.bind("C", "k1"); f.bind("F", "k_null");
  const { connectorAudience, d1ConnectorGrants } = await import("../cf/src/control-plane.ts");
  const g = d1ConnectorGrants(f.D1);
  assert((await g.grant(TENANT, "k1", "raft_A"))?.id === "k1", "control: its own origin's agent finds it");
  assert((await g.grant(TENANT, "k1", "raft_B")) === null, "another origin's agent found the connector");
  assert((await g.grant(TENANT, "k_null", "raft_F")) === null, "an agent of a connector with no origin found it");
  assert((await g.grant(TENANT, "k1", "raft_NOBODY")) === null, "an agent with no row found it");
  const to = await connectorAudience(f.D1, TENANT, "k1");
  assert(JSON.stringify(to) === JSON.stringify(["raft_A", "raft_C"]), `handed to: ${JSON.stringify(to)}`);
  assert((await connectorAudience(f.D1, TENANT, "k_null")).length === 0, "a connector with no origin was handed to its agents");
});

console.log(`  ${routes.size} (method, path) pairs take an agent id; ${served.length} (both spellings) served for their own origin; ${Object.keys(OUTSIDE).length} cases outside /agents/<id>`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
