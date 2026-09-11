/**
 * End-to-end: agent-authored JS runs inside QuickJS, reaches GitHub only through
 * the tool tag, and any oversized result is parked in R2 so the model sees a
 * reference instead of 100KB of JSON.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { QuickJsExecutor, DEFAULT_LIMITS } from "../src/runtime/executor.ts";
import { R2Artifacts } from "../src/store/artifacts.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import type { ToolResult } from "../src/core/tools.ts";

for (const line of readFileSync(`${homedir()}/.secrets/antiproton.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) process.env[m[1]!] = m[2]!;
}

const T = "tenant-a";
const store = new SqliteStore(":memory:");
await store.init();
await store.createAgent(T, "agent-1");
await store.createTask(T, "agent-1", "task-1", {});
await store.addMount({
  tenantId: T, agentId: "agent-1", alias: "gh_public", plugin: "github",
  installationId: "inst-public", connectionId: null, toolVersion: githubPlugin.version,
  publicConfig: { account: "unauthenticated" }, secretRef: null,
});

const gw = new ToolGateway(store, [githubPlugin]);
const ctx = { tenantId: T, agentId: "agent-1", taskId: "task-1" };
const artifacts = new R2Artifacts({
  endpoint: process.env.R2_ENDPOINT!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  bucket: "antiproton-artifacts",
});

const OFFLOAD_BYTES = 8 * 1024;
const offloaded: string[] = [];

// The bridge is where §5.4 lives: the sandbox never receives a large result.
const host = {
  async invoke(call: { tool: string; args: any }): Promise<ToolResult> {
    const res = await gw.invoke(ctx, call.tool, call.args);
    if (res.status !== "succeeded") return res;
    const body = JSON.stringify(res.result);
    if (body.length <= OFFLOAD_BYTES) return res;
    const key = `t/${T}/agent-1/${res.operationId}.json`;
    const stored = await artifacts.put(key, body, "application/json");
    await store.completeOperation(T, res.operationId, "succeeded", stored.ref);
    offloaded.push(stored.ref);
    const items = Array.isArray(res.result) ? (res.result as any[]) : [];
    return {
      status: "succeeded",
      operationId: res.operationId,
      result: {
        artifact: stored.ref,
        bytes: stored.bytes,
        count: items.length,
        preview: items.slice(0, 3).map((i) => ({ number: i.number, title: i.title })),
      },
    };
  },
};

// What a model would have written.
const agentCode = `
const repo = "nodejs/node";
const issues = await tool\`gh_public.issue_list \${ { repo, perPage: 30 } }\`;

if (issues.status !== "succeeded") {
  output({ problem: issues.status, error: issues.error });
} else {
  const r = issues.result;
  output({
    repo,
    issues: r.count,
    parked: r.artifact,
    sizeKb: Math.round(r.bytes / 1024),
    headline: r.preview.map(i => "#" + i.number + " " + i.title.slice(0, 40))
  });
}
`;

const t0 = performance.now();
const result = await new QuickJsExecutor().execute(agentCode, host, {
  ...DEFAULT_LIMITS,
  wallTimeMs: 15_000,
});
const ms = Math.round(performance.now() - t0);

console.log(`\n  execution:  ${result.status}  (${ms}ms, ${result.hostCalls} host call)`);
if (result.error) console.log("  error:     ", result.error);
console.log("  output:    ", JSON.stringify(result.outputs[0], null, 2).split("\n").join("\n             "));
console.log(`  operations: ${result.acceptedOperationIds.join(", ")}`);
const op = await store.getOperation(T, result.acceptedOperationIds[0]!);
console.log(`  recorded:   ${op!.tool} v${op!.toolVersion} via mount "${op!.mountAlias}" -> ${op!.status}`);
console.log(`  result_ref: ${op!.resultRef}`);
console.log(`  wakeup:     ${(await store.pendingEvents(T, "task-1", "harness"))[0]?.kind}\n`);
await store.close();
