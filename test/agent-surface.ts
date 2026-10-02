/**
 * An agent's usage and workspace (cf/src/agent-surface/), over fake deps: the usage arithmetic that
 * makes every row summable, the windows and their limits, the three workspace roots, what must never
 * be shown (the agent's sealed secrets), paths that try to leave the tree, the read cap, and the
 * container that must not be started. Then the two surfaces that call it — the public API
 * (`/v1/agents/:id/...`) and the provider binding (`/provision/agents/:id/...`, both addressings) —
 * reaching the same core, each refusing an agent its caller may not see.
 *
 * The half that runs inside the agent's object (its state rows, its container's files) runs against a
 * real runtime and the real sandbox plugin in test/agent-surface-runtime.ts.
 */
import { agentUsage, nonOverlapping, parseUsageQuery, splitModelKey, HOURLY_KEPT_MS, type LedgerRow, type UsageDeps } from "../cf/src/agent-surface/usage.ts";
import { workspaceList, workspaceRead, NOT_RUNNING_FILE, READ_MAX_BYTES, type SandboxList, type SandboxRead, type WorkspaceDeps } from "../cf/src/agent-surface/workspace.ts";
import { surface, type SurfaceDeps } from "../cf/src/agent-surface/surface.ts";
import { handleProvision, type ProvisionDeps } from "../cf/src/provision/handlers.ts";
import { handleAgentsApi, type AgentsApiDeps } from "../cf/src/agents-api/handlers.ts";
import type { ProvisionedAgent } from "../cf/src/control-plane.ts";
import type { StoredAgent } from "../cf/src/agents-api/shapes.ts";
import { KEEP_HOURLY_DAYS } from "../cf/src/usage-d1.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const H = 3_600_000, D = 24 * H;
const T0 = Date.parse("2026-10-01T00:00:00Z");
const NOW = Date.parse("2026-10-02T12:00:00Z");
const enc = (s: string) => new TextEncoder().encode(s);

// ---- fakes -----------------------------------------------------------------------------------------

interface Hourly { tenantId: string; agentId: string; hour: number; resource: string; key: string; unit: string; quantity: number }

function fakeSurface(opts: { now?: number } = {}) {
  const calls: string[] = [];
  const ledger: Hourly[] = [];
  const backlog = new Map<string, number | null | Error>();
  const warnings: string[] = [];
  const usage: UsageDeps = {
    now: () => opts.now ?? NOW,
    async ledger(tenantId, agentId, from, to, size) {
      calls.push(`ledger ${tenantId}/${agentId}`);
      const sums = new Map<string, LedgerRow>();
      for (const r of ledger) {
        if (r.tenantId !== tenantId || r.agentId !== agentId || r.hour < from || r.hour >= to) continue;
        const bucket = Math.floor(r.hour / size) * size;
        const id = JSON.stringify([bucket, r.resource, r.key, r.unit]);
        const have = sums.get(id);
        if (have) have.quantity += r.quantity; else sums.set(id, { bucket, resource: r.resource, key: r.key, unit: r.unit, quantity: r.quantity });
      }
      return [...sums.values()];
    },
    async backlogSince(tenantId, agentId) {
      calls.push(`backlog ${tenantId}/${agentId}`);
      const b = backlog.get(`${tenantId}/${agentId}`) ?? null;
      if (b instanceof Error) throw b;
      return b;
    },
    warn: (m) => { warnings.push(m); },
  };
  // A store keyed by (tenant/agent) whose `list` matches like SQL LIKE does: case-insensitively.
  const state = new Map<string, Map<string, { value: unknown; ref: string | null; bytes: number; updatedAt: number }>>();
  const objects = new Map<string, { bytes: Uint8Array; uploaded: number; contentType?: string }>();
  const gets: string[] = [];
  type Box = { running: boolean; files: Map<string, Uint8Array>; dirs: Set<string>; others?: Set<string>; cut?: { truncated: boolean; omitted?: number }; fail?: string };
  let sandbox: Box = { running: false, files: new Map(), dirs: new Set([""]) };
  const sandboxCalls: string[] = [];
  const workspace: WorkspaceDeps = {
    state: {
      async list(tenantId, agentId, prefix, limit) {
        calls.push(`state.list ${tenantId}/${agentId}`);
        const rows = [...(state.get(`${tenantId}/${agentId}`) ?? new Map()).entries()]
          .filter(([k]) => k.toLowerCase().startsWith(prefix.toLowerCase())).sort(([a], [b]) => (a < b ? -1 : 1)).slice(0, limit);
        return rows.map(([key, v]) => ({ key, bytes: v.bytes, updatedAt: v.updatedAt }));
      },
      async get(tenantId, agentId, key) {
        calls.push(`state.get ${tenantId}/${agentId} ${key}`);
        return state.get(`${tenantId}/${agentId}`)?.get(key) ?? null;
      },
    },
    artifacts: {
      async list(prefix) {
        calls.push(`artifacts.list ${prefix}`);
        const objs: Array<{ key: string; size: number; uploaded: number }> = [];
        const prefixes = new Set<string>();
        for (const [key, o] of objects) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          const cut = rest.indexOf("/");
          if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
          else objs.push({ key, size: o.bytes.byteLength, uploaded: o.uploaded });
        }
        return { objects: objs, prefixes: [...prefixes] };
      },
      async head(key) {
        const o = objects.get(key);
        return o ? { key, size: o.bytes.byteLength, uploaded: o.uploaded, ...(o.contentType ? { contentType: o.contentType } : {}) } : null;
      },
      async get(key) {
        gets.push(key);
        const o = objects.get(key);
        return o ? { key, size: o.bytes.byteLength, uploaded: o.uploaded, bytes: o.bytes, ...(o.contentType ? { contentType: o.contentType } : {}) } : null;
      },
    },
    sandbox: {
      async list(tenantId, agentId, path): Promise<SandboxList> {
        sandboxCalls.push(`list ${tenantId}/${agentId} ${path}`);
        if (!sandbox.running) return { running: false };
        if (sandbox.fail) throw new Error(sandbox.fail);
        if (sandbox.files.has(path)) return { running: true, found: false, notDirectory: true };
        if (!sandbox.dirs.has(path)) return { running: true, found: false };
        const pre = path ? path + "/" : "";
        const entries = new Map<string, { name: string; isDirectory: boolean; size: number; modifiedAt: number }>();
        for (const d of sandbox.dirs) if (d.startsWith(pre) && d !== path && !d.slice(pre.length).includes("/")) entries.set(d, { name: d.slice(pre.length), isDirectory: true, size: 0, modifiedAt: T0 });
        for (const [f, b] of sandbox.files) if (f.startsWith(pre) && !f.slice(pre.length).includes("/")) entries.set(f, { name: f.slice(pre.length), isDirectory: false, size: b.byteLength, modifiedAt: T0 });
        return { running: true, found: true, entries: [...entries.values()], ...(sandbox.cut ?? { truncated: false }) };
      },
      async read(tenantId, agentId, path, maxBytes): Promise<SandboxRead> {
        sandboxCalls.push(`read ${tenantId}/${agentId} ${path}`);
        if (!sandbox.running) return { running: false };
        if (sandbox.fail) throw new Error(sandbox.fail);
        if (sandbox.dirs.has(path)) return { running: true, found: true, kind: "directory", size: 0, modifiedAt: T0, bytes: null };
        if (sandbox.others?.has(path)) return { running: true, found: true, kind: "other", size: 0, modifiedAt: T0, bytes: null };
        const b = sandbox.files.get(path);
        if (!b) return { running: true, found: false };
        return { running: true, found: true, kind: "file", size: b.byteLength, modifiedAt: T0, bytes: b.byteLength > maxBytes ? null : b };
      },
    },
  };
  const deps: SurfaceDeps = { usage, workspace };
  const put = (tenantId: string, agentId: string, key: string, value: unknown, ref: string | null = null) => {
    const k = `${tenantId}/${agentId}`;
    if (!state.has(k)) state.set(k, new Map());
    state.get(k)!.set(key, { value, ref, bytes: JSON.stringify(value).length, updatedAt: T0 + H });
  };
  return {
    deps, calls, ledger, backlog, warnings, put, objects, gets, sandboxCalls,
    setSandbox: (s: typeof sandbox) => { sandbox = s; },
    row: (hour: number, resource: string, key: string, unit: string, quantity: number, agentId = "agent_1", tenantId = "t") =>
      ledger.push({ tenantId, agentId, hour, resource, key, unit, quantity }),
  };
}

const q = (s: string) => new URLSearchParams(s);
const window = (from: string, to: string, bucket = "1h") => {
  const p = parseUsageQuery(q(`from=${from}&to=${to}&bucket=${bucket}`), NOW);
  if ("param" in p) throw new Error(`refused: ${p.param} ${p.message}`);
  return p;
};
const pick = (rows: Array<{ at: string; resource: string; dimensions: Record<string, string>; unit: string; quantity: number }>, f: Partial<Record<string, string>> & { resource?: string; at?: string; unit?: string }) =>
  rows.filter((r) => (!f.resource || r.resource === f.resource) && (!f.at || r.at === f.at) && (!f.unit || r.unit === f.unit) &&
    Object.entries(f).every(([k, v]) => ["resource", "at", "unit"].includes(k) || r.dimensions[k] === v));

// ---- usage -----------------------------------------------------------------------------------------

await check("model tokens come out non-overlapping: output without reasoning, cache_write split into 5m and 1h, and the rows sum to the ledger's totals", async () => {
  const f = fakeSurface();
  const h = T0 + 3 * H;
  for (const [kind, n] of [["input", 100], ["output", 50], ["reasoning", 20], ["cache_read", 30], ["cache_write", 40], ["cache_write_1h", 15]] as const) {
    f.row(h, "model.tokens", `deepseek-chat:${kind}`, "tokens", n);
  }
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"));
  const m = pick(u.rows, { resource: "model.tokens", model: "deepseek-chat" });
  const by = Object.fromEntries(m.map((r) => [r.dimensions.kind, r.quantity]).sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)));
  must(JSON.stringify(by) === JSON.stringify({ cache_read: 30, cache_write_1h: 15, cache_write_5m: 25, input: 100, output: 30, reasoning: 20 }), JSON.stringify(by));
  must(!m.some((r) => r.dimensions.kind === "cache_write"), "the overlapping total is still emitted");
  const sum = m.reduce((s, r) => s + r.quantity, 0);
  must(sum === 100 + 50 + 30 + 40, `the rows sum to ${sum}, not input + output + cache_read + cache_write = 220`);
  must(m.every((r) => r.unit === "tokens" && r.at === "2026-10-01T03:00:00.000Z"), JSON.stringify(m));
});

await check("the subtraction is per bucket and per model: one model's reasoning is never taken from another's output, or from another hour's", async () => {
  const f = fakeSurface();
  f.row(T0 + H, "model.tokens", "a:output", "tokens", 10);
  f.row(T0 + 2 * H, "model.tokens", "a:output", "tokens", 10);
  f.row(T0 + 2 * H, "model.tokens", "a:reasoning", "tokens", 8);
  f.row(T0 + H, "model.tokens", "b:output", "tokens", 7);
  f.row(T0 + H, "model.tokens", "b:reasoning", "tokens", 7);
  f.row(T0 + H, "model.tokens", "b:cache_write", "tokens", 9);
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-01T06:00:00Z"));
  const out = (at: string, model: string) => pick(u.rows, { at, model, kind: "output" })[0]?.quantity ?? 0;
  must(out("2026-10-01T01:00:00.000Z", "a") === 10, `a's first hour lost output to the second hour's reasoning: ${out("2026-10-01T01:00:00.000Z", "a")}`);
  must(out("2026-10-01T02:00:00.000Z", "a") === 2, `a's second hour: ${out("2026-10-01T02:00:00.000Z", "a")}`);
  must(out("2026-10-01T01:00:00.000Z", "b") === 0 && pick(u.rows, { model: "b", kind: "output" }).length === 0, "an output that is all reasoning is no row, not a zero");
  must(pick(u.rows, { model: "b", kind: "cache_write_5m" })[0]?.quantity === 9 && pick(u.rows, { model: "b", kind: "cache_write_1h" }).length === 0, "a cache write with no 1h part is all 5m");
});

await check("tool calls come out as succeeded and failed, from calls less failed per bucket and tool; a tool's time keeps its own unit", async () => {
  const f = fakeSurface();
  f.row(T0, "tool.call", "gh.issue_list", "calls", 5);
  f.row(T0, "tool.call", "gh.issue_list", "failed", 2);
  f.row(T0, "tool.call", "gh.issue_list", "ms", 900);
  f.row(T0 + H, "tool.call", "gh.issue_list", "calls", 1);
  f.row(T0, "tool.call", "web.fetch", "calls", 3);
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-01T02:00:00Z"));
  const at0 = "2026-10-01T00:00:00.000Z";
  must(pick(u.rows, { at: at0, tool: "gh.issue_list", outcome: "succeeded" })[0]?.quantity === 3, JSON.stringify(u.rows));
  must(pick(u.rows, { at: at0, tool: "gh.issue_list", outcome: "failed" })[0]?.quantity === 2, "failed");
  must(pick(u.rows, { at: "2026-10-01T01:00:00.000Z", tool: "gh.issue_list", outcome: "succeeded" })[0]?.quantity === 1, "the next hour's call is its own");
  must(pick(u.rows, { tool: "web.fetch", outcome: "failed" }).length === 0 && pick(u.rows, { tool: "web.fetch", outcome: "succeeded" })[0]?.quantity === 3, "no failures, no failed row");
  must(u.rows.filter((r) => r.resource === "tool.call" && r.unit === "calls").every((r) => r.dimensions.outcome), "a calls row without an outcome overlaps the others");
  const ms = pick(u.rows, { tool: "gh.issue_list", unit: "ms" });
  must(ms.length === 1 && ms[0]!.resource === "tool.duration" && ms[0]!.quantity === 900 && ms[0]!.dimensions.outcome === undefined, JSON.stringify(ms));
});

await check("a tool's calls, failures and time in one bucket: succeeded and failed tool.call rows, one tool.duration row, and no tool.call row in ms", async () => {
  const f = fakeSurface();
  f.row(T0, "tool.call", "web.fetch", "calls", 4);
  f.row(T0, "tool.call", "web.fetch", "failed", 1);
  f.row(T0, "tool.call", "web.fetch", "ms", 1234);
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z"));
  const shape = u.rows.map((r) => `${r.resource}|${JSON.stringify(r.dimensions)}|${r.unit}|${r.quantity}`).sort();
  must(JSON.stringify(shape) === JSON.stringify([
    'tool.call|{"tool":"web.fetch","outcome":"failed"}|calls|1',
    'tool.call|{"tool":"web.fetch","outcome":"succeeded"}|calls|3',
    'tool.duration|{"tool":"web.fetch"}|ms|1234',
  ]), JSON.stringify(shape));
  must(!u.rows.some((r) => r.resource === "tool.call" && r.unit !== "calls"), "a tool.call row in another unit");
  const units = new Map<string, Set<string>>();
  for (const r of u.rows) units.set(r.resource, (units.get(r.resource) ?? new Set()).add(r.unit));
  must([...units.values()].every((s) => s.size === 1), `a resource with two units: ${JSON.stringify([...units].map(([k, v]) => [k, [...v]]))}`);
});

await check("a model name with ':' in it is split on the last ':'", async () => {
  must(JSON.stringify(splitModelKey("ollama:llama3:8b:output")) === JSON.stringify({ model: "ollama:llama3:8b", kind: "output" }), "split");
  const f = fakeSurface();
  f.row(T0, "model.tokens", "ollama:llama3:8b:output", "tokens", 12);
  f.row(T0, "model.tokens", "ollama:llama3:8b:reasoning", "tokens", 5);
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z"));
  must(pick(u.rows, { model: "ollama:llama3:8b", kind: "output" })[0]?.quantity === 7, JSON.stringify(u.rows));
  must(!u.rows.some((r) => r.dimensions.model === "ollama"), "split on the first ':'");
});

await check("a difference that would go negative is shown as nothing and reported, never as a negative quantity", async () => {
  const f = fakeSurface();
  f.row(T0, "model.tokens", "m:output", "tokens", 5);
  f.row(T0, "model.tokens", "m:reasoning", "tokens", 9);
  f.row(T0, "tool.call", "x", "calls", 1);
  f.row(T0, "tool.call", "x", "failed", 3);
  f.row(T0, "js.run", "run_js", "runs", -2);
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z"));
  must(u.rows.every((r) => r.quantity > 0), JSON.stringify(u.rows));
  must(pick(u.rows, { model: "m", kind: "reasoning" })[0]?.quantity === 9, "the reasoning itself is still shown");
  must(f.warnings.some((w) => /output less reasoning/.test(w)) && f.warnings.some((w) => /calls less failed/.test(w)), `not reported: ${JSON.stringify(f.warnings)}`);
});

await check("other resources pass through with their key as the one dimension", async () => {
  const f = fakeSurface();
  f.row(T0, "js.run", "run_js", "runs", 2);
  f.row(T0, "sandbox.container", "sandbox", "ms", 60_000);
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z"));
  must(pick(u.rows, { resource: "js.run", key: "run_js", unit: "runs" })[0]?.quantity === 2, JSON.stringify(u.rows));
  must(pick(u.rows, { resource: "sandbox.container", key: "sandbox", unit: "ms" })[0]?.quantity === 60_000, JSON.stringify(u.rows));
});

await check("1d buckets are cut at 00:00 UTC, and the window is widened to whole buckets", async () => {
  const f = fakeSurface();
  f.row(Date.parse("2026-09-30T23:00:00Z"), "js.run", "run_js", "runs", 1);
  f.row(Date.parse("2026-10-01T23:00:00Z"), "js.run", "run_js", "runs", 2);
  f.row(Date.parse("2026-10-02T00:00:00Z"), "js.run", "run_js", "runs", 4);
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T05:00:00+08:00", "2026-10-02T06:30:00Z", "1d"));
  must(u.from === "2026-09-30T00:00:00.000Z" && u.to === "2026-10-03T00:00:00.000Z", `window ${u.from}..${u.to}`);
  const by = Object.fromEntries(u.rows.map((r) => [r.at, r.quantity]));
  must(JSON.stringify(by) === JSON.stringify({ "2026-09-30T00:00:00.000Z": 1, "2026-10-01T00:00:00.000Z": 2, "2026-10-02T00:00:00.000Z": 4 }), JSON.stringify(by));
});

await check("asOf is now when the agent has sent everything, and partial says whether the window reaches past it", async () => {
  const f = fakeSurface();
  const done = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"));
  must(done.asOf === new Date(NOW).toISOString() && done.partial === false, JSON.stringify(done));
  const ended = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-02T00:00:00Z", "2026-10-02T11:30:00Z"));
  must(ended.to === "2026-10-02T12:00:00.000Z" && ended.partial === false, `the last bucket ended at now: ${JSON.stringify(ended)}`);
  const open = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-02T00:00:00Z", "2026-10-02T11:59:59Z", "1d"));
  must(open.to === "2026-10-03T00:00:00.000Z" && open.partial === true, `the day is unfinished: ${JSON.stringify(open)}`);
  const future = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-02T00:00:00Z", "2026-10-03T00:00:00Z"));
  must(future.partial === true, "a window ending after now is partial");
});

await check("usage the agent has not sent yet moves asOf back to it, and a window past that is partial", async () => {
  const f = fakeSurface();
  f.backlog.set("t/agent_1", Date.parse("2026-10-01T20:15:00Z"));
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z"));
  must(u.asOf === "2026-10-01T20:15:00.000Z" && u.partial === true, JSON.stringify(u));
  const before = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-01T20:00:00Z"));
  must(before.partial === false, "a window that ends before the unsent usage is whole");
  f.backlog.set("t/agent_1", new Error("object unreachable"));
  const unknown = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-01T20:00:00Z"));
  must(unknown.partial === true, "not knowing what is unsent must not read as whole");
});

await check("a window the ledger marks unreadable is partial", async () => {
  const f = fakeSurface();
  f.row(T0, "sandbox.container", "sandbox", "unreadable", 1);
  const u = await agentUsage(f.deps.usage, "t", "agent_1", window("2026-10-01T00:00:00Z", "2026-10-01T02:00:00Z"));
  must(u.partial === true, JSON.stringify(u));
});

await check("the window is at most 31 days, and every bad parameter is refused by name", () => {
  const ok = parseUsageQuery(q("from=2026-09-01T00:00:00Z&to=2026-10-02T00:00:00Z&bucket=1d"), NOW);
  must(!("param" in ok), `31 days refused: ${JSON.stringify(ok)}`);
  const cases: Array<[string, string]> = [
    ["from=2026-09-01T00:00:00Z&to=2026-10-02T00:00:00.001Z&bucket=1d", "to"],
    ["to=2026-10-02T00:00:00Z", "from"],
    ["from=2026-10-01&to=2026-10-02T00:00:00Z", "from"],
    ["from=2026-10-01T00:00:00Z&to=yesterday", "to"],
    ["from=2026-10-01T00:00:00&to=2026-10-02T00:00:00Z", "from"],
    ["from=2026-10-02T00:00:00Z&to=2026-10-01T00:00:00Z", "to"],
    ["from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&bucket=1w", "bucket"],
    ["from=2026-08-01T00:00:00Z&to=2026-08-02T00:00:00Z&bucket=1h", "bucket"],
  ];
  for (const [s, param] of cases) {
    const r = parseUsageQuery(q(s), NOW);
    must("param" in r && r.param === param, `${s}: ${JSON.stringify(r)}`);
  }
  must(HOURLY_KEPT_MS === KEEP_HOURLY_DAYS * D, `hourly buckets are offered for ${HOURLY_KEPT_MS / D} days, the ledger keeps them ${KEEP_HOURLY_DAYS}`);
});

await check("the pure split is the same function the read uses: no row of a known kind leaves as the overlapping total", () => {
  const rows = nonOverlapping([
    { bucket: T0, resource: "model.tokens", key: "m:cache_write", unit: "tokens", quantity: 10 },
    { bucket: T0, resource: "model.tokens", key: "m:cache_write_1h", unit: "tokens", quantity: 10 },
  ]);
  must(rows.length === 1 && rows[0]!.dimensions.kind === "cache_write_1h" && rows[0]!.quantity === 10, JSON.stringify(rows));
});

// ---- workspace -------------------------------------------------------------------------------------

function workspaceFixture() {
  const f = fakeSurface();
  f.put("t", "a", "memory", "the user prefers short answers");
  f.put("t", "a", "todo", "- ship it");
  f.put("t", "a", "notes/one", { n: 1 });
  f.put("t", "a", "notes/two", "two");
  f.put("t", "a", "notes/.draft", "hidden");
  // A row named as a sealed secret is named. The real store keeps secrets in another table, so this is
  // the case the filter exists for: a store that one day held both must still not show one.
  f.put("t", "a", "kept:api", "SECRET-VALUE-123");
  f.put("t", "a", "KEPT:other", "SECRET-VALUE-456");
  f.put("t", "a2", "memory", "another agent's memory");
  f.objects.set("t/t/a/op_1.json", { bytes: enc('{"ok":true}'), uploaded: T0, contentType: "application/json" });
  f.objects.set("t/t/a/sandbox/b1/report.txt", { bytes: enc("report"), uploaded: T0 });
  f.objects.set("t/t/a/.cache", { bytes: enc("x"), uploaded: T0 });
  f.objects.set("t/t/a2/theirs.txt", { bytes: enc("not yours"), uploaded: T0 });
  return f;
}
const names = (r: Awaited<ReturnType<typeof workspaceList>>) => (r.ok ? r.files.map((x) => x.path) : [`refused ${r.status}`]);

await check("the top level is the three roots, as directories", async () => {
  const f = workspaceFixture();
  for (const dir of ["", "/", "./"]) {
    const r = await workspaceList(f.deps.workspace, "t", "a", dir, false);
    must(JSON.stringify(names(r)) === JSON.stringify(["state/", "artifacts/", "sandbox/"]), `${JSON.stringify(dir)}: ${JSON.stringify(names(r))}`);
    must(r.ok && r.files.every((x) => x.isDirectory), "roots are directories");
  }
});

await check("state/ lists the agent's keys one level at a time, `/` making directories, hidden ones only on request", async () => {
  const f = workspaceFixture();
  const top = await workspaceList(f.deps.workspace, "t", "a", "state/", false);
  must(JSON.stringify(names(top)) === JSON.stringify(["state/notes/", "state/memory", "state/todo"]), JSON.stringify(names(top)));
  const notes = await workspaceList(f.deps.workspace, "t", "a", "state/notes", false);
  must(JSON.stringify(names(notes)) === JSON.stringify(["state/notes/one", "state/notes/two"]), JSON.stringify(names(notes)));
  const all = await workspaceList(f.deps.workspace, "t", "a", "state/notes/", true);
  must(all.ok && all.files.find((x) => x.name === ".draft")?.isHidden === true, JSON.stringify(all));
  must(top.ok && top.files.every((x) => !("isHidden" in x)), "a visible file says nothing about hiding");
  const mem = top.ok ? top.files.find((x) => x.name === "memory") : null;
  must(mem && mem.size > 0 && mem.modifiedAt === new Date(T0 + H).toISOString() && mem.isDirectory === false, JSON.stringify(mem));
});

await check("state files read as their text, or as JSON when the value is not text", async () => {
  const f = workspaceFixture();
  const text = await workspaceRead(f.deps.workspace, "t", "a", "state/memory");
  must(text.ok && text.file.content === "the user prefers short answers" && text.file.mimeType === "text/plain" && text.file.encoding === "utf-8" && !text.file.binary, JSON.stringify(text));
  must(text.ok && text.file.size === enc("the user prefers short answers").byteLength, "size is the content's");
  const json = await workspaceRead(f.deps.workspace, "t", "a", "state/notes/one");
  must(json.ok && JSON.parse(json.file.content!).n === 1 && json.file.mimeType === "application/json", JSON.stringify(json));
});

await check("a sealed secret is never listed and never readable, however its name is spelled", async () => {
  const f = workspaceFixture();
  for (const hidden of [false, true]) {
    const r = await workspaceList(f.deps.workspace, "t", "a", "state/", hidden);
    must(r.ok && !r.files.some((x) => /kept/i.test(x.name)), `listed: ${JSON.stringify(names(r))}`);
  }
  for (const p of ["state/kept:api", "state/KEPT:other", "state/Kept:api", "state/kept%3Aapi", "state/kept%3aapi", "state/%6Bept:api",
    "state/./kept:api", "state//kept:api", "/state/kept:api", "state/kept:api/", "state/ kept:api"]) {
    const r = await workspaceRead(f.deps.workspace, "t", "a", p);
    must(!r.ok && r.status === 404, `${p}: ${JSON.stringify(r)}`);
    must(!JSON.stringify(r).includes("SECRET-VALUE"), `${p} carried the value`);
  }
  for (const d of ["state/kept:api/", "state/kept%3Aapi/"]) {
    const r = await workspaceList(f.deps.workspace, "t", "a", d, true);
    must(!r.ok && r.status === 404, `${d}: ${JSON.stringify(r)}`);
  }
  must(!f.calls.some((c) => /state\.get .* kept/i.test(c)), `a secret's name was looked up: ${f.calls.filter((c) => /kept/i.test(c)).join("; ")}`);
});

await check("paths that move through the tree, or leave the roots, are refused before anything is read", async () => {
  const f = workspaceFixture();
  const before = f.calls.length;
  for (const p of ["../x", "state/../../etc/passwd", "state/notes/../kept:api", "state/%2e%2e/memory", "state/%2E%2E/memory", "artifacts/..%2fa2/theirs.txt",
    "artifacts/x%2f..%2f..", "state\\..\\memory", "/etc/passwd", "secrets/x", "statex/memory", "state/me\u0000mory", "state/.", "sandbox/../state/memory"]) {
    const r = await workspaceRead(f.deps.workspace, "t", "a", p);
    must(!r.ok && r.status === 400 && r.param === "path", `${JSON.stringify(p)}: ${JSON.stringify(r)}`);
  }
  for (const d of ["artifacts/../state", "..", "state/../..", "x/"]) {
    const r = await workspaceList(f.deps.workspace, "t", "a", d, false);
    must(!r.ok && r.status === 400 && r.param === "dirPath", `${d}: ${JSON.stringify(r)}`);
  }
  must(f.calls.length === before, `a refused path still reached a store: ${f.calls.slice(before).join("; ")}`);
});

await check("artifacts/ lists the agent's own objects one level down, never another agent's whose id begins the same", async () => {
  const f = workspaceFixture();
  const top = await workspaceList(f.deps.workspace, "t", "a", "artifacts/", false);
  must(JSON.stringify(names(top)) === JSON.stringify(["artifacts/sandbox/", "artifacts/op_1.json"]), JSON.stringify(names(top)));
  must(f.calls.includes("artifacts.list t/t/a/"), `listed under the wrong prefix: ${f.calls.join("; ")}`);
  const deep = await workspaceList(f.deps.workspace, "t", "a", "artifacts/sandbox/b1", false);
  must(JSON.stringify(names(deep)) === JSON.stringify(["artifacts/sandbox/b1/report.txt"]), JSON.stringify(names(deep)));
  const other = await workspaceRead(f.deps.workspace, "t", "a", "artifacts/theirs.txt");
  must(!other.ok && other.status === 404, "another agent's object read");
  const read = await workspaceRead(f.deps.workspace, "t", "a", "artifacts/op_1.json");
  must(read.ok && read.file.content === '{"ok":true}' && read.file.mimeType === "application/json", JSON.stringify(read));
  const hidden = await workspaceList(f.deps.workspace, "t", "a", "artifacts/", true);
  must(hidden.ok && hidden.files.some((x) => x.name === ".cache" && x.isHidden), "hidden on request");
});

await check("a file over 1 MB is reported and not returned, without being fetched; exactly 1 MB is returned", async () => {
  const f = workspaceFixture();
  f.objects.set("t/t/a/big.txt", { bytes: new Uint8Array(READ_MAX_BYTES + 1).fill(97), uploaded: T0 });
  f.objects.set("t/t/a/edge.txt", { bytes: new Uint8Array(READ_MAX_BYTES).fill(97), uploaded: T0 });
  const big = await workspaceRead(f.deps.workspace, "t", "a", "artifacts/big.txt");
  must(big.ok && big.file.content === null && big.file.binary === true && big.file.size === READ_MAX_BYTES + 1, JSON.stringify(big));
  must(!f.gets.includes("t/t/a/big.txt"), "the large object was fetched to be refused");
  const edge = await workspaceRead(f.deps.workspace, "t", "a", "artifacts/edge.txt");
  must(edge.ok && edge.file.content?.length === READ_MAX_BYTES && !edge.file.binary, `edge: ${edge.ok ? edge.file.size : JSON.stringify(edge)}`);
  f.put("t", "a", "huge", "b".repeat(READ_MAX_BYTES + 10));
  const state = await workspaceRead(f.deps.workspace, "t", "a", "state/huge");
  must(state.ok && state.file.content === null && state.file.size === READ_MAX_BYTES + 10, "a state value past the cap");
});

await check("bytes that are not UTF-8, or carry a NUL, come back as base64 and say so", async () => {
  const f = workspaceFixture();
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe]);
  f.objects.set("t/t/a/pic.png", { bytes: png, uploaded: T0 });
  f.objects.set("t/t/a/nul.bin", { bytes: enc("a\u0000b"), uploaded: T0 });
  f.objects.set("t/t/a/latin1.txt", { bytes: new Uint8Array([0x63, 0x61, 0x66, 0xe9]), uploaded: T0 });
  const r = await workspaceRead(f.deps.workspace, "t", "a", "artifacts/pic.png");
  must(r.ok && r.file.binary && r.file.encoding === "base64" && r.file.mimeType === "image/png" && r.file.size === png.byteLength, JSON.stringify(r));
  must(r.ok && Buffer.from(r.file.content!, "base64").equals(Buffer.from(png)), "the base64 is not the file");
  for (const p of ["artifacts/nul.bin", "artifacts/latin1.txt"]) {
    const b = await workspaceRead(f.deps.workspace, "t", "a", p);
    must(b.ok && b.file.binary && b.file.encoding === "base64", `${p}: ${JSON.stringify(b)}`);
  }
  const utf = await workspaceRead(f.deps.workspace, "t", "a", "state/memory");
  must(utf.ok && !utf.file.binary, "text read as binary");
});

await check("a spilled state value is read from the bucket, and only from under the agent's own scope", async () => {
  const f = workspaceFixture();
  f.objects.set("t/t/a/state/big.json", { bytes: enc(JSON.stringify("a long document")), uploaded: T0 });
  f.put("t", "a", "big", null, "r2://bucket/t/t/a/state/big.json");
  const r = await workspaceRead(f.deps.workspace, "t", "a", "state/big");
  must(r.ok && r.file.content === "a long document", JSON.stringify(r));
  f.put("t", "a", "stray", null, "r2://bucket/t/t/a2/theirs.txt");
  const stray = await workspaceRead(f.deps.workspace, "t", "a", "state/stray");
  must(!stray.ok && stray.status === 404, `a reference out of scope was followed: ${JSON.stringify(stray)}`);
});

await check("an unknown path is 404 under every root, and a directory is not read as a file", async () => {
  const f = workspaceFixture();
  for (const p of ["state/nope", "artifacts/nope.txt", "state/notes/nope"]) {
    const r = await workspaceRead(f.deps.workspace, "t", "a", p);
    must(!r.ok && r.status === 404, `${p}: ${JSON.stringify(r)}`);
  }
  for (const d of ["state/nope/", "artifacts/nope/"]) {
    const r = await workspaceList(f.deps.workspace, "t", "a", d, false);
    must(!r.ok && r.status === 404, `${d}: ${JSON.stringify(r)}`);
  }
  const dir = await workspaceRead(f.deps.workspace, "t", "a", "state");
  must(!dir.ok && dir.status === 400, JSON.stringify(dir));
});

await check("sandbox/ with no container running holds one text file saying so, and nothing else is there", async () => {
  const f = workspaceFixture();
  const r = await workspaceList(f.deps.workspace, "t", "a", "sandbox/", true);
  must(JSON.stringify(names(r)) === JSON.stringify([`sandbox/${NOT_RUNNING_FILE}`]), JSON.stringify(names(r)));
  const text = await workspaceRead(f.deps.workspace, "t", "a", `sandbox/${NOT_RUNNING_FILE}`);
  must(text.ok && /not running/.test(text.file.content!) && /never starts/.test(text.file.content!), JSON.stringify(text));
  must(r.ok && r.files[0]!.size === text.file.size, "the listed size is the file's");
  const sub = await workspaceList(f.deps.workspace, "t", "a", "sandbox/src", false);
  must(!sub.ok && sub.status === 404, JSON.stringify(sub));
  const file = await workspaceRead(f.deps.workspace, "t", "a", "sandbox/index.js");
  must(!file.ok && file.status === 404, JSON.stringify(file));
});

await check("sandbox/ with the container running shows its working directory, one level at a time, under the same cap", async () => {
  const f = workspaceFixture();
  f.setSandbox({ running: true, dirs: new Set(["", "src"]), files: new Map([["index.js", enc("console.log(1)")], ["src/a.ts", enc("x")], ["big.bin", new Uint8Array(READ_MAX_BYTES + 5)]]) });
  const top = await workspaceList(f.deps.workspace, "t", "a", "sandbox/", false);
  must(JSON.stringify(names(top)) === JSON.stringify(["sandbox/src/", "sandbox/big.bin", "sandbox/index.js"]), JSON.stringify(names(top)));
  const src = await workspaceList(f.deps.workspace, "t", "a", "sandbox/src/", false);
  must(JSON.stringify(names(src)) === JSON.stringify(["sandbox/src/a.ts"]), JSON.stringify(names(src)));
  must(f.sandboxCalls.includes("list t/a src"), `the container was asked for the wrong path: ${f.sandboxCalls.join("; ")}`);
  const js = await workspaceRead(f.deps.workspace, "t", "a", "sandbox/index.js");
  must(js.ok && js.file.content === "console.log(1)" && js.file.mimeType === "text/javascript", JSON.stringify(js));
  const big = await workspaceRead(f.deps.workspace, "t", "a", "sandbox/big.bin");
  must(big.ok && big.file.content === null && big.file.size === READ_MAX_BYTES + 5, JSON.stringify(big));
});

await check("a 31-day window is measured after widening to whole buckets: 31 days from midnight passes, 31 days from noon is 32 and is refused", () => {
  const whole = parseUsageQuery(q("from=2026-09-01T00:00:00Z&to=2026-10-02T00:00:00Z&bucket=1d"), NOW);
  must(!("param" in whole), JSON.stringify(whole));
  const noon = parseUsageQuery(q("from=2026-09-01T12:00:00Z&to=2026-10-02T12:00:00Z&bucket=1d"), NOW);
  must("param" in noon && noon.param === "to", `a 31-day request covering 32 days passed: ${JSON.stringify(noon)}`);
  const hourly = parseUsageQuery(q("from=2026-09-01T00:30:00Z&to=2026-10-02T00:30:00Z&bucket=1h"), NOW);
  must("param" in hourly && hourly.param === "to", `31 days and an hour passed: ${JSON.stringify(hourly)}`);
});

await check("a listing applies the read's rule to every segment: a key with a secret-named segment inside a directory is not listed", async () => {
  const f = workspaceFixture();
  f.put("t", "a", "notes/kept:y", "SECRET-VALUE-789");
  f.put("t", "a", "kept:dir/z", "SECRET-VALUE-000");
  const notes = await workspaceList(f.deps.workspace, "t", "a", "state/notes/", true);
  must(notes.ok && !JSON.stringify(notes).includes("kept"), JSON.stringify(names(notes)));
  const top = await workspaceList(f.deps.workspace, "t", "a", "state/", true);
  must(top.ok && !JSON.stringify(top).includes("kept"), `a directory named as a secret was listed: ${JSON.stringify(names(top))}`);
});

await check("a listing that left entries out says so, with how many when known; a whole one says nothing", async () => {
  const f = workspaceFixture();
  f.setSandbox({ running: true, dirs: new Set([""]), files: new Map([["a.txt", enc("a")]]), cut: { truncated: true, omitted: 41 } });
  const cut = await workspaceList(f.deps.workspace, "t", "a", "sandbox/", false);
  must(cut.ok && cut.truncated === true && cut.omitted === 41, JSON.stringify(cut));
  f.setSandbox({ running: true, dirs: new Set([""]), files: new Map([["a.txt", enc("a")]]), cut: { truncated: true } });
  const unknown = await workspaceList(f.deps.workspace, "t", "a", "sandbox/", false);
  must(unknown.ok && unknown.truncated === true && !("omitted" in unknown), `an unknown count was given a number: ${JSON.stringify(unknown)}`);
  f.setSandbox({ running: true, dirs: new Set([""]), files: new Map([["a.txt", enc("a")]]) });
  const whole = await workspaceList(f.deps.workspace, "t", "a", "sandbox/", false);
  must(whole.ok && !("truncated" in whole) && !("omitted" in whole), JSON.stringify(whole));
  for (let i = 0; i < 1005; i++) f.objects.set(`t/t/a/many/${String(i).padStart(4, "0")}`, { bytes: enc("x"), uploaded: T0 });
  const many = await workspaceList(f.deps.workspace, "t", "a", "artifacts/many/", false);
  must(many.ok && many.files.length === 1000 && many.truncated === true && many.omitted === 5, `cap: ${many.ok ? `${many.files.length} ${many.truncated} ${many.omitted}` : JSON.stringify(many)}`);
});

await check("in the container, listing a file is refused as not a directory, and reading anything but a regular file is refused", async () => {
  const f = workspaceFixture();
  f.setSandbox({ running: true, dirs: new Set([""]), files: new Map([["index.js", enc("x")]]), others: new Set(["tty"]) });
  const file = await workspaceList(f.deps.workspace, "t", "a", "sandbox/index.js", false);
  must(!file.ok && file.status === 400 && file.param === "dirPath", JSON.stringify(file));
  const gone = await workspaceList(f.deps.workspace, "t", "a", "sandbox/nope/", false);
  must(!gone.ok && gone.status === 404, JSON.stringify(gone));
  const dev = await workspaceRead(f.deps.workspace, "t", "a", "sandbox/tty");
  must(!dev.ok && dev.status === 400 && /regular file/.test(dev.message), JSON.stringify(dev));
});

// ---- the two surfaces ------------------------------------------------------------------------------

const WHO = { label: "raft", tenantId: "t", raftOrigin: "https://raft.example", scope: "tenant" as const };
const OTHER = { label: "raft-2", tenantId: "t-other", raftOrigin: "https://raft.example", scope: "tenant" as const };
const PLATFORM = { label: "raft-platform", raftOrigin: "https://raft.example", scope: "platform" as const };

function provisionDeps(f: ReturnType<typeof fakeSurface>, rows: ProvisionedAgent[]): ProvisionDeps {
  const nope = async () => { throw new Error("a read must not reach this"); };
  return {
    now: () => NOW,
    surface: f.deps,
    registry: {
      create: nope, update: nope,
      get: async (tenantId: string, raftAgentId: string) => rows.find((r) => r.tenantId === tenantId && r.raftAgentId === raftAgentId) ?? null,
      getByAgentId: async (tenantId: string, agentId: string) => rows.find((r) => r.tenantId === tenantId && r.agentId === agentId) ?? null,
    } as any,
    agent: { adopt: nope, attachCredential: nope, removeCredential: nope, tool: nope, pushStatus: nope } as any,
  };
}
const agentRow = (over: Partial<ProvisionedAgent> = {}): ProvisionedAgent => ({
  tenantId: "t", raftAgentId: "01JX", agentId: "raft_01JX", raftServerId: "srv-1", raftOrigin: WHO.raftOrigin, name: "x", instructions: "",
  credentialHash: null, status: "active", pushRegistered: true, pushError: null, createdAt: T0, updatedAt: T0, deletedAt: null, ...over,
});
async function provider(deps: ProvisionDeps, path: string, qs: string, who: typeof WHO | typeof PLATFORM = WHO) {
  const query = q(qs);
  const r = await handleProvision("GET", path, { idempotencyKey: null, raftServerId: query.get("raftServerId") }, undefined, who, deps, query);
  if (!r) return { status: 0, body: null as any, text: "" };
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text) as any, text };
}
function v1Deps(f: ReturnType<typeof fakeSurface>, tenantId: string, agents: Record<string, StoredAgent>): AgentsApiDeps {
  const nope = async () => { throw new Error("a read must not reach this"); };
  return {
    now: () => NOW, sleep: async () => {}, mintAgentId: () => "x", mintSessionId: () => "s",
    surface: { tenantId, deps: f.deps },
    index: { getAgent: async (id: string) => agents[id] ?? null } as any,
    agents: { adopt: nope, openSession: nope, postInput: nope, status: nope, toolResults: nope, cancel: nope, transcript: nope } as any,
  };
}
async function v1(deps: AgentsApiDeps, path: string, qs: string) {
  const r = await handleAgentsApi("GET", path, q(qs), undefined, deps);
  if (!r) return { status: 0, body: null as any, text: "" };
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text) as any, text };
}
const STORED: StoredAgent = { name: "a", instructions: null, model: "m", metadata: {}, tools: [], createdAt: T0, updatedAt: T0 };
const USAGE_QS = "from=2026-10-01T00:00:00Z&to=2026-10-01T02:00:00Z&bucket=1h";

function bothSurfaces() {
  const f = fakeSurface();
  for (const agentId of ["raft_01JX", "agent_1"]) {
    f.row(T0, "model.tokens", "m:output", "tokens", 10, agentId);
    f.row(T0, "model.tokens", "m:reasoning", "tokens", 4, agentId);
    f.put("t", agentId, "memory", "hello");
  }
  return f;
}

await check("the provider routes answer the agreed bodies, by our id and by the Raft id alike, through the core", async () => {
  const f = bothSurfaces();
  const deps = provisionDeps(f, [agentRow()]);
  const byId = await provider(deps, "/agents/raft_01JX/usage", USAGE_QS);
  const byRaft = await provider(deps, "/agents/by-raft-agent/01JX/usage", USAGE_QS);
  must(byId.status === 200 && byRaft.status === 200, `${byId.status} ${byId.text} / ${byRaft.status} ${byRaft.text}`);
  must(byId.text === byRaft.text, `the two addressings differ:\n${byId.text}\n${byRaft.text}`);
  must(byId.body.raftAgentId === "01JX" && byId.body.bucket === "1h" && byId.body.from === "2026-10-01T00:00:00.000Z" && typeof byId.body.asOf === "string" && typeof byId.body.partial === "boolean", byId.text);
  must(pick(byId.body.rows, { kind: "output" })[0]?.quantity === 6, byId.text);
  const core = await surface(f.deps, "usage", "t", "raft_01JX", q(USAGE_QS));
  must(core.ok && JSON.stringify(core.body) === JSON.stringify((({ raftAgentId: _r, providerAgentId: _p, ...rest }) => rest)(byId.body)), "the route's body is not the core's");
  const files = await provider(deps, "/agents/by-raft-agent/01JX/workspace-files", "dirPath=state/");
  must(files.status === 200 && JSON.stringify(files.body.files.map((x: any) => x.path)) === JSON.stringify(["state/memory"]), files.text);
  const read = await provider(deps, "/agents/raft_01JX/workspace-files/read", "path=state/memory");
  must(read.status === 200 && read.body.content === "hello" && read.body.encoding === "utf-8", read.text);
  const bad = await provider(deps, "/agents/raft_01JX/usage", "from=2026-10-01T00:00:00Z");
  must(bad.status === 400 && bad.body.error.param === "to", bad.text);
});

await check("the public API answers the same bodies for an agent its key made, from the same core", async () => {
  const f = bothSurfaces();
  const deps = v1Deps(f, "t", { agent_1: STORED });
  const u = await v1(deps, "/agents/agent_1/usage", USAGE_QS);
  must(u.status === 200 && u.body.agentId === "agent_1", u.text);
  const p = await provider(provisionDeps(f, [agentRow()]), "/agents/raft_01JX/usage", USAGE_QS);
  const strip = (b: any) => { const { agentId: _a, raftAgentId: _r, providerAgentId: _p, ...rest } = b; return JSON.stringify(rest); };
  must(strip(u.body) === strip(p.body), `the surfaces differ:\n${strip(u.body)}\n${strip(p.body)}`);
  const files = await v1(deps, "/agents/agent_1/workspace/files", "dirPath=");
  must(files.status === 200 && files.body.files.length === 3, files.text);
  const read = await v1(deps, "/agents/agent_1/workspace/files/read", "path=state/memory");
  const pread = await provider(provisionDeps(f, [agentRow()]), "/agents/raft_01JX/workspace-files/read", "path=state/memory");
  must(read.status === 200 && read.text === pread.text, `${read.text} / ${pread.text}`);
  const bad = await v1(deps, "/agents/agent_1/workspace/files/read", "path=../x");
  must(bad.status === 400 && bad.body.error.param === "path" && bad.body.error.type === "invalid_request_error", bad.text);
  const traversal = await provider(provisionDeps(f, [agentRow()]), "/agents/raft_01JX/workspace-files/read", "path=state/../../x");
  must(traversal.status === 400 && traversal.body.error.param === "path", traversal.text);
});

await check("an agent the caller may not see is 404 on both surfaces, and the core is never asked", async () => {
  const f = bothSurfaces();
  const rows = [agentRow(), agentRow({ raftAgentId: "01JDEL", agentId: "raft_01JDEL", status: "deleted", deletedAt: T0 })];
  const pdeps = provisionDeps(f, rows);
  const before = f.calls.length;
  const asks: Array<[string, string, typeof WHO | typeof PLATFORM]> = [
    ["/agents/raft_01JX/usage", USAGE_QS, OTHER],
    ["/agents/by-raft-agent/01JX/workspace-files", "dirPath=state/", OTHER],
    ["/agents/raft_01JX/workspace-files/read", "path=state/memory", OTHER],
    ["/agents/by-raft-agent/01JDEL/usage", USAGE_QS, WHO],
    ["/agents/raft_01JDEL/workspace-files/read", "path=state/memory", WHO],
    ["/agents/raft_nobody/workspace-files", "", WHO],
  ];
  for (const [path, qs, who] of asks) {
    const r = await provider(pdeps, path, qs, who);
    must(r.status === 404 && r.body.error.code === "not_found", `${who.label} ${path}: ${r.status} ${r.text}`);
  }
  const vdeps = v1Deps(f, "t", { agent_1: STORED });
  for (const [path, qs] of [["/agents/agent_2/usage", USAGE_QS], ["/agents/raft_01JX/workspace/files", ""], ["/agents/raft_01JX/workspace/files/read", "path=state/memory"]]) {
    const r = await v1(vdeps, path!, qs!);
    must(r.status === 404 && r.body.error.code === "not_found", `${path}: ${r.status} ${r.text}`);
  }
  must(f.calls.length === before, `the core was asked for an agent the caller may not see: ${f.calls.slice(before).join("; ")}`);
});

await check("a platform token names the Raft server beside the read's own parameters: none is 422, another server's tenant has no such agent", async () => {
  const f = fakeSurface();
  f.row(T0, "js.run", "run_js", "runs", 1, "raft_01JX", "raft_srv-1");
  const deps = provisionDeps(f, [agentRow({ tenantId: "raft_srv-1" })]);
  const none = await provider(deps, "/agents/raft_01JX/usage", USAGE_QS, PLATFORM);
  must(none.status === 422 && none.body.error.param === "raftServerId", none.text);
  const right = await provider(deps, "/agents/by-raft-agent/01JX/usage", `${USAGE_QS}&raftServerId=srv-1`, PLATFORM);
  must(right.status === 200 && pick(right.body.rows, { key: "run_js" })[0]?.quantity === 1, right.text);
  must(f.calls.includes("ledger raft_srv-1/raft_01JX"), `the core read another tenant: ${f.calls.join("; ")}`);
  const wrong = await provider(deps, "/agents/raft_01JX/workspace-files", "dirPath=state/&raftServerId=srv-2", PLATFORM);
  must(wrong.status === 404, wrong.text);
  const read = await provider(deps, "/agents/raft_01JX/workspace-files/read", "raftServerId=srv-1&path=state/missing", PLATFORM);
  must(read.status === 404 && /no file/.test(read.body.error.message), `the server parameter got in the path's way: ${read.text}`);
});

await check("a failure underneath is answered without its detail on both surfaces, and the detail is logged", async () => {
  const f = bothSurfaces();
  const detail = "run9 POST /projects/shared-proj/workspace/boxes/h-t-agent_1-abc/background-execs -> 500: boom";
  f.setSandbox({ running: true, dirs: new Set([""]), files: new Map(), fail: detail });
  const p = await provider(provisionDeps(f, [agentRow()]), "/agents/raft_01JX/workspace-files", "dirPath=sandbox/");
  const v = await v1(v1Deps(f, "t", { agent_1: STORED }), "/agents/agent_1/workspace/files/read", "path=sandbox/x");
  for (const [who, r] of [["provider", p], ["v1", v]] as const) {
    must(r.status === 502, `${who}: ${r.status} ${r.text}`);
    must(!/run9|shared-proj|h-t-|background-execs|boom/.test(r.text), `${who} leaked: ${r.text}`);
  }
  must(p.body.error.code === "unavailable" && v.body.error.type === "server_error", `${p.text} / ${v.text}`);
  must(f.warnings.filter((w) => w.includes("shared-proj")).length === 2, `the detail was not logged: ${JSON.stringify(f.warnings)}`);
});

await check("without the surface wired, the routes are not there rather than half there", async () => {
  const f = bothSurfaces();
  const deps = { ...provisionDeps(f, [agentRow()]) };
  delete (deps as any).surface;
  const r = await provider(deps, "/agents/raft_01JX/usage", USAGE_QS);
  must(r.status === 0, `answered ${r.status}`);
  const other = await provider(provisionDeps(f, [agentRow()]), "/agents/raft_01JX/usages", USAGE_QS);
  must(other.status === 0, `a near-miss path answered ${other.status}`);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
