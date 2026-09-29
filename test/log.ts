/**
 * The structured log (src/core/log.ts): silent without a sink, one JSON line per event with one, and a
 * route that carries no id or secret. The trace outbox writes its rows through it as they commit.
 */
import { logEvent, routeOf, setLogSink } from "../src/core/log.ts";
import { appendTrace } from "../src/trace/outbox.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

await check("without a sink nothing is written; with one, each event is one JSON line", () => {
  const lines: string[] = [];
  logEvent("x", { a: 1 });
  setLogSink((l) => lines.push(l));
  try { logEvent("http", { status: 200, traceId: undefined }); } finally { setLogSink(null); }
  logEvent("y");
  must(lines.length === 1 && JSON.parse(lines[0]!).evt === "http" && JSON.parse(lines[0]!).status === 200, JSON.stringify(lines));
});

await check("a route keeps its shape and loses its ids and secrets", () => {
  const cases: Array<[string, string]> = [
    ["/hooks/hk_4f9c2a7e1b", "/hooks/:hook"],
    ["/provision/agents/by-raft-agent/ddb29255-f184-413f-bc0a-0b927cf32961/connections/github", "/provision/agents/by-raft-agent/:id/connections/github"],
    ["/provision/agents/raft_01JAGENT/credential", "/provision/agents/:id/credential"],
    ["/provision/connectors/con_1a2b3c", "/provision/connectors/:id"],
    ["/connect/start", "/connect/start"],
  ];
  for (const [path, want] of cases) must(routeOf(path) === want, `${path} → ${routeOf(path)}`);
});

await check("a trace row is a log line when it commits, naming the agent and the tool", () => {
  const lines: string[] = [];
  const { sql } = sqliteHost();
  setLogSink((l) => lines.push(l));
  try {
    appendTrace(sql as any, [{ at: 1_790_000_000_000, tenantId: "t", agentId: "a", kind: "tool.call", spanId: "op_1", status: "failed", verdict: "failed", ms: 370, attrs: { mount: "gh", tool: "github.repo_view" } }]);
  } finally { setLogSink(null); }
  const l = JSON.parse(lines[0] ?? "{}");
  must(l.evt === "trace" && l.agentId === "a" && l.kind === "tool.call" && l.status === "failed" && l.tool === "github.repo_view" && l.ms === 370, lines[0]);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
