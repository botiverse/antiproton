/**
 * Every provider route that names one agent refuses a platform token issued for another Raft origin.
 *
 * A platform token derives the tenant from `?raftServerId=` alone (`tenantFor`), so a token minted for another Raft
 * deployment that names this server's id lands in the same tenant. What stops it is a check of the row's `raftOrigin`
 * against the token's, made route by route; the approval routes were the first to get it.
 *
 * The routes are not listed here by hand. `handleProvision` is an if-chain, not a table, so they are found by asking
 * it: every method, with every path the router's own words can spell (each lowercase literal in the handlers' and the
 * agent surface's source, one to three segments deep, a parameter where one may stand), is sent for an agent that does
 * not exist, and a request that looks the agent up is a route that takes an agent id. That the search reached every
 * route is checked against the source: each line of handlers.ts that looks an agent up by the path's id must have been
 * the one a found route called it from.
 *
 * Then, for each route in both spellings (`/agents/<providerAgentId>/…`, `/agents/by-raft-agent/<raftAgentId>/…`):
 * the agent's own origin is served (a same-origin control), another origin is refused — a 404 or no route, with
 * nothing past the lookup touched.
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
const WORDS = [...new Set(SOURCES.flatMap((s) => [...s.matchAll(/"([a-z][a-z0-9/-]*)"/g)])
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
function deps(row: ProvisionedAgent | null) {
  const lookups: Array<{ by: string; id: string; line: number | null }> = [];
  const touched: string[] = [];
  const registry = new Proxy({} as Record<string, unknown>, {
    get(_t, k) {
      if (k === "get") return async (tenantId: string, id: string) => { lookups.push({ by: "raftAgentId", id, line: callerLine() }); return row && row.tenantId === tenantId && row.raftAgentId === id ? row : null; };
      if (k === "getByAgentId") return async (tenantId: string, id: string) => { lookups.push({ by: "agentId", id, line: callerLine() }); return row && row.tenantId === tenantId && row.agentId === id ? row : null; };
      return async () => { touched.push(`registry.${String(k)}`); return null; };
    },
  });
  const d = new Proxy({ now: () => 1_800_000_000_000, registry } as Record<string, unknown>, {
    get(t, k) { return k in t ? t[k as string] : standIn(String(k), touched); },
  }) as unknown as ProvisionDeps;
  return { deps: d, lookups, touched };
}

async function send(d: ProvisionDeps, method: string, path: string, origin: string) {
  try {
    const r = await handleProvision(method, path, { idempotencyKey: null, raftServerId: SERVER, credentialId: "cred-1" }, {}, platform(origin), d);
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

/** The lines of handlers.ts that look an agent up by the id in the path. */
const LOOKUP_LINES = readFileSync(HANDLERS, "utf8").split("\n")
  .flatMap((l, i) => /registry\.(?:get|getByAgentId)\(tenantId, rest\[0\]/.test(l) ? [i + 1] : []);

/**
 * Routes that serve another origin's token today: the gap #1116 names, found by this test, and left for its fix.
 * TODO(#1116): refuse another origin on these (as the approval routes do) and empty this list. An entry that refuses
 * already fails the test, so the list only shrinks.
 */
const KNOWN_OPEN = new Set<string>([
  "GET ", "PATCH ", "DELETE ", "PUT credential", "POST stop", "POST import",
  "GET usage", "GET workspace-files", "GET workspace-files/read",
  "GET model", "PUT model",
  "GET connections/github", "POST connections/github", "PUT connections/github", "DELETE connections/github", "POST connections/github/confirm",
  "PUT seed", "POST seed/seal", "GET seed/manifest", "POST fresh-context", "POST restart", "GET model-input", "GET tools", "GET transcript", "GET trace",
]);

const routes = await findRoutes();

await check("the search finds routes that take an agent id, the approval routes among them", async () => {
  assert(WORDS.length > 50, `only ${WORDS.length} words read from the router's source`);
  for (const r of ["GET approvals", `POST approvals/${PARAM}/decide`, "GET ", "DELETE ", "POST stop"]) {
    assert(routes.has(r), `${r} was not found; found: ${[...routes.keys()].join(", ")}`);
  }
});

await check("every line of handlers.ts that looks an agent up by the path's id is reached by a found route", async () => {
  assert(LOOKUP_LINES.length > 0, "no lookup line read from handlers.ts");
  const reached = new Set([...routes.values()].flatMap((r) => [...r.lines]));
  const missed = LOOKUP_LINES.filter((n) => !reached.has(n));
  assert(missed.length === 0, `handlers.ts lines ${missed.join(", ")} look an agent up, and no found route reached them`);
});

const row: ProvisionedAgent = {
  tenantId: TENANT, raftAgentId: RAFT_AGENT, agentId: AGENT, raftServerId: SERVER, raftOrigin: OURS, name: "Cody", instructions: "",
  credentialHash: null, status: "active", pushRegistered: true, pushError: null, createdAt: 1, updatedAt: 1, deletedAt: null,
};
/** Refused: a 404 or no route at all, and nothing past the lookup reached. */
const refused = (r: { status: number | null }, touched: string[]) => (r.status === null || r.status === 404) && touched.length === 0;

/** The known gaps as they answered another origin's token: the finding, printed on each run. */
const open = new Map<string, string>();
const served: string[] = [];
await check("each route serves its agent's own origin and refuses another origin's token, in both spellings, but for the known gaps", async () => {
  const problems: string[] = [];
  for (const [name, { method, tail }] of routes) {
    for (const spelling of [[AGENT], ["by-raft-agent", RAFT_AGENT]]) {
      const path = ["", "agents", ...spelling, ...tail].join("/");
      const ours = deps(row);
      const control = await send(ours.deps, method, path, OURS);
      // A method the route does not serve is refused to its own origin too; it has nothing to refuse to another.
      if (refused(control, ours.touched)) continue;
      if (spelling[0] === AGENT) served.push(name);
      const theirs = deps(row);
      const other = await send(theirs.deps, method, path, THEIRS);
      if (refused(other, theirs.touched)) continue;
      const seen = `${method} ${path} → ${other.status}${theirs.touched.length ? `, reached ${[...new Set(theirs.touched)].join(" ")}` : ""}`;
      if (KNOWN_OPEN.has(name)) { if (spelling[0] === AGENT) open.set(name, seen); }
      else problems.push(seen);
    }
  }
  assert(served.length > 0, "no route served its own origin: the control proves nothing");
  assert(problems.length === 0, `another origin's token was served:\n        ${problems.join("\n        ")}`);
});

await check("every known gap is a found route that still serves another origin: a fixed one leaves the list", async () => {
  const stale = [...KNOWN_OPEN].filter((k) => !open.has(k));
  assert(stale.length === 0, `no longer open (remove from KNOWN_OPEN): ${stale.join(", ")}`);
});

console.log(`  ${routes.size} (method, path) pairs take an agent id; ${served.length} served for their own origin; ${open.size} still open to another origin:`);
for (const seen of open.values()) console.log(`    ${seen}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
