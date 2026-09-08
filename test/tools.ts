/**
 * Mount addressing + gateway conformance. These are the rows that only make
 * sense under the revised §5/§9 design: binding happens at configuration time,
 * so a call carries business arguments only.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway, type SecretResolver } from "../src/runtime/gateway.ts";
import { parseTemplateCall } from "../src/core/tools.ts";
import type { Plugin } from "../src/plugins/types.ts";
import type { Json } from "../src/core/types.ts";

const T = "tenant-a";
let seen: Array<{ tool: string; credential: string | null; args: Json }> = [];

const fake: Plugin = {
  id: "github",
  version: "1.0.0",
  tools: [{ name: "issues.list", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke(tool, args, ctx) {
    seen.push({ tool, credential: ctx.credential, args });
    if ((args as any).boom) {
      const e = new Error("upstream 503") as Error & { retryable?: boolean };
      e.retryable = true;
      throw e;
    }
    return { ok: true, account: ctx.publicConfig.account };
  },
};

const secrets: SecretResolver = {
  async resolve(ref) {
    return ({ "vault:work": "TOKEN_WORK", "vault:oss": "TOKEN_OSS" } as Record<string, string>)[ref] ?? null;
  },
};

async function fixture(aliases: Array<[string, string | null, string]>) {
  seen = [];
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent(T, "agent-1");
  await store.createTask(T, "agent-1", "task-1", {});
  for (const [alias, secretRef, account] of aliases) {
    await store.addMount({
      tenantId: T, agentId: "agent-1", alias, plugin: "github",
      installationId: `inst-${alias}`, connectionId: `conn-${alias}`,
      toolVersion: "1.0.0", publicConfig: { account }, secretRef,
    });
  }
  return { store, gw: new ToolGateway(store, [fake], secrets) };
}
const ctx = { tenantId: T, agentId: "agent-1", taskId: "task-1" };

type Test = { row: string; name: string; fn: () => Promise<void> };
const tests: Test[] = [];
const test = (row: string, name: string, fn: () => Promise<void>) => tests.push({ row, name, fn });
function assert(c: unknown, what: string): asserts c {
  if (!c) throw new Error(`assertion failed: ${what}`);
}
const eq = (a: unknown, b: unknown, w: string) =>
  assert(Object.is(a, b), `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

test("多账号", "two accounts are distinct aliases, never a parameter", async () => {
  const { store, gw } = await fixture([["gh_work", "vault:work", "work"], ["gh_oss", "vault:oss", "oss"]]);
  const a = await gw.invoke(ctx, "gh_work.issues.list", { repo: "example/project" });
  const b = await gw.invoke(ctx, "gh_oss.issues.list", { repo: "example/project" });
  eq(a.status, "succeeded", "work call ok");
  eq(b.status, "succeeded", "oss call ok");
  eq(seen[0]!.credential, "TOKEN_WORK", "work credential");
  eq(seen[1]!.credential, "TOKEN_OSS", "oss credential");
  assert(!("connection" in (seen[0]!.args as object)), "args carry no platform fields");
  const op = await store.getOperation(T, (a as any).operationId);
  eq(op!.mountAlias, "gh_work", "operation records the resolved mount");
  await store.close();
});

test("歧义必须报错", "a bare plugin name with two mounts is refused, with candidates", async () => {
  const { store, gw } = await fixture([["gh_work", null, "work"], ["gh_oss", null, "oss"]]);
  const r = await gw.invoke(ctx, "github.issues.list", { repo: "x/y" });
  eq(r.status, "rejected", "refused");
  eq((r as any).error.code, "ambiguous_mount", "ambiguity reported");
  eq((r as any).error.candidates.join(","), "gh_oss.issues.list,gh_work.issues.list", "candidates listed");
  eq(seen.length, 0, "nothing was dispatched");
  await store.close();
});

test("单挂载简写", "a bare plugin name resolves when there is exactly one mount", async () => {
  const { store, gw } = await fixture([["gh", "vault:work", "work"]]);
  eq((await gw.invoke(ctx, "github.issues.list", { repo: "x/y" })).status, "succeeded", "resolved");
  await store.close();
});

test("未挂载", "an unmounted plugin returns an actionable authorization link", async () => {
  const { store, gw } = await fixture([]);
  const r = await gw.invoke(ctx, "slack.messages.post", { text: "hi" });
  eq((r as any).error.code, "not_mounted", "not mounted");
  assert((r as any).error.authorizationUrl.includes("slack"), "carries an authorization url");
  assert(!("operationId" in r), "no operation id is fabricated for a pre-acceptance failure");
  await store.close();
});

test("保留字冲突", "platform fields are rejected inside the argument object", async () => {
  const bad = parseTemplateCall(["github.issues.list ", ""], [{ repo: "x/y", connection: "work" }]);
  assert("error" in bad, "rejected");
  eq(bad.error.code, "reserved_argument", "reserved word reported");
  const good = parseTemplateCall(["gh_work.issues.list ", ""], [{ repo: "x/y" }]);
  assert(!("error" in good), "plain business args accepted");
  eq(good.ref.head, "gh_work", "alias parsed");
  eq(good.ref.tool, "issues.list", "tool parsed");
});

test("模板语法", "the tool template accepts only a literal name plus 1-2 values", async () => {
  assert("error" in parseTemplateCall(["x.y ", " and then "], [{}, {}]), "trailing text refused");
  assert("error" in parseTemplateCall(["x.y ", "", ""], [{}, {}, {}]), "three values refused");
  assert("error" in parseTemplateCall(["x.y ", ""], ["not-an-object"]), "non-object args refused");
  assert("error" in parseTemplateCall(["notatoolname ", ""], [{}]), "bare word refused");
  const withOpts = parseTemplateCall(["gh_work.issues.create ", "", ""], [{ title: "t" }, { idempotencyKey: "k1" }]);
  assert(!("error" in withOpts), "second slot accepted");
  eq(withOpts.opts.idempotencyKey, "k1", "idempotency key lands in opts, not args");
});

test("版本固定", "a registry drifting from the mount's pinned version fails loudly", async () => {
  const { store } = await fixture([["gh_work", null, "work"]]);
  const drifted = new ToolGateway(store, [{ ...fake, version: "2.0.0" }], secrets);
  const r = await drifted.invoke(ctx, "gh_work.issues.list", { repo: "x/y" });
  eq((r as any).error.code, "version_mismatch", "refused rather than silently upgraded");
  await store.close();
});

test("unknown 语义", "a possibly-landed request is unknown, not failed", async () => {
  const { store, gw } = await fixture([["gh_work", null, "work"]]);
  const r = await gw.invoke(ctx, "gh_work.issues.list", { repo: "x/y", boom: true });
  eq(r.status, "unknown", "not auto-classified as failed");
  const op = await store.getOperation(T, (r as any).operationId);
  eq(op!.status, "unknown", "persisted as unknown for a human/agent to resolve");
  await store.close();
});

test("写操作重放", "a replayed write is not performed twice", async () => {
  let performed = 0;
  const writer: Plugin = {
    id: "github", version: "1.0.0",
    tools: [{ name: "issues.create", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" }],
    async invoke() { performed++; return { ok: true }; },
  };
  const { store } = await fixture([["gh_work", null, "work"]]);
  const gw2 = new ToolGateway(store, [writer], secrets);

  const first = await gw2.invoke(ctx, "gh_work.issues.create", { title: "x" }, { idempotencyKey: "cmd1:0" });
  eq(first.status, "succeeded", "first attempt runs");
  eq(performed, 1, "performed once");

  // The crash-and-replay case: same command, same call index, same key.
  const replay = await gw2.invoke(ctx, "gh_work.issues.create", { title: "x" }, { idempotencyKey: "cmd1:0" });
  eq(replay.status, "unknown", "a possibly-landed write is unknown, not repeated");
  eq((replay as any).error.code, "already_attempted", "and says why");
  eq(performed, 1, "the side effect did not happen twice");
  eq((replay as any).operationId, (first as any).operationId, "same derived operation id");

  // A different call index within the same command is a different operation.
  await gw2.invoke(ctx, "gh_work.issues.create", { title: "y" }, { idempotencyKey: "cmd1:1" });
  eq(performed, 2, "a genuinely different call still runs");
  await store.close();
});

test("读操作重放", "a replayed read is simply re-executed", async () => {
  let performed = 0;
  const reader: Plugin = {
    id: "github", version: "1.0.0",
    tools: [{ name: "issues.list", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
    async invoke() { performed++; return []; },
  };
  const { store } = await fixture([["gh_work", null, "work"]]);
  const gw2 = new ToolGateway(store, [reader], secrets);
  const a = await gw2.invoke(ctx, "gh_work.issues.list", {}, { idempotencyKey: "cmd2:0" });
  const b = await gw2.invoke(ctx, "gh_work.issues.list", {}, { idempotencyKey: "cmd2:0" });
  eq(a.status, "succeeded", "first read succeeds");
  eq(b.status, "succeeded", "replayed read succeeds too");
  eq(performed, 2, "re-reading is harmless, so it is allowed");
  await store.close();
});

let pass = 0, fail = 0;
console.log(`\n  Tool gateway & mount addressing\n  ${"─".repeat(62)}`);
for (const t of tests) {
  try {
    await t.fn(); pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${t.row.padEnd(14)} ${t.name}`);
  } catch (e) {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${t.row.padEnd(14)} ${t.name}\n      \x1b[31m${(e as Error).message}\x1b[0m`);
  }
}
console.log(`  ${"─".repeat(62)}\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
