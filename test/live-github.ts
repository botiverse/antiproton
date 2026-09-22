/**
 * Live vertical slice: mount -> real GitHub call -> large result parked in R2
 * as a reference -> only a summary is what a model would ever see.
 * Requires ~/.secrets/antiproton.env. Read-only; creates no GitHub side effects.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { R2Artifacts } from "../src/store/artifacts.ts";
import { githubPlugin } from "../src/plugins/github.ts";

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
  installationId: "inst-public", connectionId: null, toolVersion: "2.0.0",
  publicConfig: { account: "unauthenticated" }, secretRef: null,
});

const gw = new ToolGateway(store, [githubPlugin], new Set(([githubPlugin]).map((p: any) => p.id)));
const ctx = { tenantId: T, agentId: "agent-1", taskId: "task-1" };

const t0 = performance.now();
const res = await gw.invoke(ctx, "gh_public.issue_list", { repo: "nodejs/node", perPage: 30 });
const ms = Math.round(performance.now() - t0);
console.log(`\n  gh_public.issue_list -> ${res.status}  (${ms}ms)`);
if (res.status !== "succeeded") {
  console.log("  ", JSON.stringify((res as any).error));
  process.exit(1);
}

const full = JSON.stringify(res.result);
const artifacts = new R2Artifacts({
  endpoint: process.env.R2_ENDPOINT!,
  accessKeyId: process.env.R2_ACCESS_KEY_ID!,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
  bucket: "antiproton-artifacts",
});
const key = `t/${T}/agent-1/${res.operationId}.json`;
const t1 = performance.now();
const stored = await artifacts.put(key, full, "application/json");
const putMs = Math.round(performance.now() - t1);
await store.completeOperation(T, res.operationId, "succeeded", stored.ref);

const roundTrip = new TextDecoder().decode(await artifacts.get(key));
const items = res.result as any[];
const summary = items.slice(0, 3).map((i) => `#${i.number} ${i.title}`);

console.log(`  full result:   ${full.length} bytes -> ${stored.ref} (${putMs}ms)`);
console.log(`  integrity:     ${roundTrip === full ? "byte-identical on read-back" : "MISMATCH"}`);
console.log(`  operation:     ${(await store.getOperation(T, res.operationId))!.resultRef}`);
console.log(`  model sees:    ${items.length} issues, first 3:`);
for (const s of summary) console.log(`                 ${s.slice(0, 68)}`);
console.log(`  wakeup event:  ${(await store.pendingEvents(T, "task-1", "harness"))[0]?.kind}\n`);
await store.close();
