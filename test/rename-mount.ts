/**
 * Giving a mount a different name, without losing what the old one keyed.
 *
 * The alias is the operator's word for a mount, and three live things are
 * filed under it: the mount row, the connection state — where a running
 * container's id lives — and, because `attachCredential` names a secret after
 * the mount, the credential itself. Moving two of the three is the failure
 * that matters: a box nothing can release, or an account the console reports
 * as unverified while it is attached and working.
 *
 * History is deliberately left where it is. `operations` and `approvals` record
 * the alias a call actually happened under.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { agentRef, secretRefKind } from "../src/runtime/secrets.ts";
import { renameSafety } from "../src/plugins/types.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

async function fixture(opts: { secret?: boolean; operatorRef?: boolean } = {}) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  const secretRef = opts.operatorRef ? "operator:run9" : opts.secret === false ? null : agentRef("node");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "node", plugin: "run9",
    installationId: "i-node", connectionId: null, toolVersion: "1.0.0",
    publicConfig: { account: "container" }, secretRef, policy: null,
  });
  if (opts.secret !== false && !opts.operatorRef) {
    await store.putSecret("t", "a", "node", { ciphertext: "sealed", iv: "iv" });
  }
  await store.putConnection("t", "a", "node", { boxId: "b-1", createdAt: 1 });
  return store;
}

await check("挂载、连接状态、凭据三样一起搬", async () => {
  const store = await fixture();
  const r = await store.renameMount("t", "a", "node", "sandbox", { newRef: agentRef("sandbox") });
  if (!r.ok) throw new Error(`rename refused: ${(r as any).error}`);

  const moved = await store.getMountByAlias("t", "a", "sandbox");
  if (!moved) throw new Error("the mount did not move");
  if (await store.getMountByAlias("t", "a", "node")) throw new Error("the old mount is still there");

  // The container. If this does not move, the box is billed by the second and
  // nothing can reach it to hand it back.
  const conn = await store.getConnection("t", "a", "sandbox");
  if (!conn) throw new Error("the connection state stayed under the old name: the running box is now unreachable");
  if ((conn as any)?.boxId !== "b-1") throw new Error("the box id did not travel with it");

  // The credential, and the pointer to it. Either half left behind is a
  // console that says "not verified" about an account that works.
  if (moved.secretRef !== agentRef("sandbox")) throw new Error(`the mount still points at ${moved.secretRef}`);
  if (!(await store.secretMeta("t", "a", "sandbox"))) throw new Error("the secret was not renamed, so the account panel will find nothing");
});

await check("运维配置的引用不跟着改名走", async () => {
  // `operator:run9` names something the deployment owns. It has nothing to do
  // with this mount's alias, and rewriting it would point the mount at a
  // reference nobody configured.
  const store = await fixture({ operatorRef: true });
  const r = await store.renameMount("t", "a", "node", "sandbox", null);
  if (!r.ok) throw new Error((r as any).error);
  const moved = await store.getMountByAlias("t", "a", "sandbox");
  if (moved!.secretRef !== "operator:run9") throw new Error(`the operator reference was rewritten to ${moved!.secretRef}`);
});

await check("重名会被整体拒绝,而不是搬一半", async () => {
  const store = await fixture();
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "sandbox", plugin: "demo",
    installationId: "i-sandbox", connectionId: null, toolVersion: "1.0.0",
    publicConfig: {}, secretRef: null, policy: null,
  });
  const r = await store.renameMount("t", "a", "node", "sandbox", { newRef: agentRef("sandbox") });
  if (r.ok) throw new Error("renaming onto an existing mount was allowed");
  // Asked before anything is written, so the refusal is about the mount. Left
  // to the primary key it would still roll back — the transaction sees to that
  // — but the person would be told about a constraint rather than about the
  // name they chose.
  if (!/already has a mount named sandbox/.test((r as any).error)) {
    throw new Error(`the refusal reads like a database error, not like an answer: ${(r as any).error}`);
  }

  // Nothing moved: the refusal has to leave the agent exactly as it was.
  const old = await store.getMountByAlias("t", "a", "node");
  if (!old) throw new Error("the refusal still took the old mount away");
  if (old.plugin !== "run9") throw new Error("the wrong mount survived");
  const conn = await store.getConnection("t", "a", "node");
  if (!conn) throw new Error("the connection state moved even though the rename was refused");
  if (!(await store.secretMeta("t", "a", "node"))) throw new Error("the secret moved even though the rename was refused");
});

await check("密文那边已经占了新名字,也整体拒绝", async () => {
  // A leftover secret under the target name would make the rename fail on a
  // primary key halfway through. Refused up front, with a sentence about
  // credentials rather than about SQL.
  const store = await fixture();
  await store.putSecret("t", "a", "sandbox", { ciphertext: "other", iv: "iv" });
  const r = await store.renameMount("t", "a", "node", "sandbox", { newRef: agentRef("sandbox") });
  if (r.ok) throw new Error("the rename ran into an occupied secret name and went ahead");
  if (!/credential/.test((r as any).error)) throw new Error(`the refusal does not say what is in the way: ${(r as any).error}`);
  if (!(await store.getMountByAlias("t", "a", "node"))) throw new Error("the mount moved anyway");
});

await check("改成同一个名字什么也不做,不存在的挂载被拒", async () => {
  const store = await fixture();
  const same = await store.renameMount("t", "a", "node", "node", null);
  if (!same.ok) throw new Error(`renaming to the same name was refused: ${(same as any).error}`);
  if (!(await store.getMountByAlias("t", "a", "node"))) throw new Error("a no-op rename removed the mount");

  const missing = await store.renameMount("t", "a", "ghost", "sandbox", null);
  if (missing.ok) throw new Error("renaming a mount that does not exist reported success");
});

await check("历史留在原地: 记录说的是【当时】那次调用挂在哪个别名下", async () => {
  const store = await fixture();
  await store.recordOperation({
    operationId: "op-1", tenantId: "t", agentId: "a", taskId: "k",
    mountAlias: "node", tool: "shell", toolVersion: "1.0.0",
  } as any);
  await store.renameMount("t", "a", "node", "sandbox", { newRef: agentRef("sandbox") });
  const op = await store.getOperation("t", "op-1");
  if (!op) throw new Error("the operation record disappeared");
  if (op.mountAlias !== "node") {
    throw new Error(`history was rewritten to ${op.mountAlias}: the call happened under "node", and saying otherwise is a lie about the past`);
  }
});

await check("框架不读容器字段,它问挂载 —— 而挂载在跑就不许改名", async () => {
  // The rule this replaces was `state.boxId`, read by the framework. Three
  // callers did that, each asserting that "something running" is one plugin's
  // idea of it. Now the mount answers, and a plugin that keeps nothing answers
  // "nothing" without knowing the question was about containers.
  const store = await fixture();
  const holding: Plugin = {
    id: "run9", version: "1.0.0", tools: [],
    async invoke() { return {}; },
    async activity(ctx) {
      const st: any = await ctx.connection.get();
      // Deliberately not the plugin's own field name: whatever it keeps, the
      // shape it answers in is the contract's.
      return { live: st?.boxId ? { id: st.boxId, startedAt: st.createdAt ?? 0, lastUsedAt: st.createdAt ?? 0 } : null };
    },
  };
  const gw = new ToolGateway(store, [holding], new Set(([holding]).map((p: any) => p.id)), { async resolve() { return null; } });
  const ctx = { tenantId: "t", agentId: "a", taskId: "k" };

  const busy = await gw.mountActivity(ctx, "node");
  if (!busy.live) throw new Error("the mount is holding b-1 and said it was holding nothing");
  const no = renameSafety(busy, Date.now());
  if (no.safe) throw new Error("a mount with a container running was cleared for renaming");
  // The sentence is the contract's; which box it is and how long it has been
  // idle come back beside it, because that is what the caller has to put in
  // front of a person deciding between waiting and releasing.
  if (no.live.id !== "b-1") throw new Error(`the refusal does not say what is in the way: ${JSON.stringify(no)}`);
  if (typeof no.live.idleMs !== "number") throw new Error("the refusal does not say how long it has been idle");

  // Hand the box back, and the same mount stops standing in the way.
  await store.putConnection("t", "a", "node", { boxId: null });
  const idle = await gw.mountActivity(ctx, "node");
  if (idle.live) throw new Error("a mount with nothing running still reported a container");
  if (!renameSafety(idle, Date.now()).safe) throw new Error("an idle mount was still refused");

  // A plugin that never heard of containers, and a mount of a plugin that is
  // not installed at all: both answer the true thing rather than throwing.
  const quiet = new ToolGateway(store, [{ id: "run9", version: "1.0.0", tools: [], async invoke() { return {}; } }], new Set(([{ id: "run9", version: "1.0.0", tools: [], async invoke() { return {}; } }]).map((p: any) => p.id)), { async resolve() { return null; } });
  if ((await quiet.mountActivity(ctx, "node")).live) throw new Error("a plugin with no activity() was read as busy");
  if ((await gw.mountActivity(ctx, "ghost")).live) throw new Error("a mount that does not exist was read as busy");
});

/**
 * What /admin/diagnose reports about a renamed mount, read the way it reads it.
 *
 * A rename in production can only be checked from outside, and the outside
 * sees two things per mount: whose credential it names (`secretRefKind`) and
 * whether state is kept under the alias. So those two readings must come out
 * right after a real rename — including the case where the credential is the
 * deployment's and must not have moved — or the check would pass a half move.
 */
await check("diagnose 的两格读数:凭证类别与连接状态跟着别名走", async () => {
  const own = await fixture();
  await own.renameMount("t", "a", "node", "sandbox", { newRef: agentRef("sandbox") });
  const moved = await own.getMountByAlias("t", "a", "sandbox");
  if (secretRefKind(moved?.secretRef) !== "agent") throw new Error(`agent credential reads as ${secretRefKind(moved?.secretRef)}`);
  if ((await own.getConnection("t", "a", "sandbox")) == null) throw new Error("no state under the new alias");
  if ((await own.getConnection("t", "a", "node")) != null) throw new Error("state left under the old alias");

  const op = await fixture({ operatorRef: true });
  await op.renameMount("t", "a", "node", "sandbox", null);
  const kept = await op.getMountByAlias("t", "a", "sandbox");
  if (kept?.secretRef !== "operator:run9" || secretRefKind(kept.secretRef) !== "operator") {
    throw new Error(`an operator reference changed: ${kept?.secretRef}`);
  }
  if (secretRefKind(null) !== "none" || secretRefKind("env:X") !== "env") throw new Error("the other kinds misread");
});

console.log(`\n  Renaming a mount\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
