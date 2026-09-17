/**
 * An operator adding a mount the defaults do not give (`/admin/mounts`).
 * The runtime half: every silent skip of `provision` becomes an answer, and an
 * alias that is already taken is never replaced.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { AgentRuntime } from "../cf/src/runtime.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

async function runtime() {
  const store = new SqliteStore(":memory:");
  await store.init();
  const rt = new AgentRuntime({
    ctx: { storage: {} } as any, bucket: {} as any, bucketName: "b",
    models: { resolve: () => null } as any,
  } as any);
  (rt as any).store = store;
  (rt as any).ready = async () => {};
  return { store, rt };
}

const web = { alias: "web2", plugin: "http", config: { account: "open web", maxBytes: 24_000 } };

await check("a mount is added, and adding the same one again is a repeat", async () => {
  const { store, rt } = await runtime();
  const first = await rt.addMount("t", "a", web);
  must(first.ok && first.added === true, `first: ${JSON.stringify(first)}`);
  const m = await store.getMountByAlias("t", "a", "web2");
  must(m?.plugin === "http" && m.secretRef === null && m.policy === null, `mount: ${JSON.stringify(m)}`);
  const again = await rt.addMount("t", "a", web);
  must(again.ok && again.added === false, `again: ${JSON.stringify(again)}`);
});

await check("an alias that is a different mount is refused, not replaced", async () => {
  const { store, rt } = await runtime();
  await rt.addMount("t", "a", web);
  const other = await rt.addMount("t", "a", { ...web, config: { account: "open web", maxBytes: 1_000 } });
  must(!other.ok && /already a different mount/.test(other.error), `other config: ${JSON.stringify(other)}`);
  const plugin = await rt.addMount("t", "a", { alias: "web2", plugin: "state", config: { account: "x" } });
  must(!plugin.ok, `other plugin: ${JSON.stringify(plugin)}`);
  must((await store.getMountByAlias("t", "a", "web2"))?.publicConfig?.maxBytes === 24_000, "the mount changed");
});

await check("a switched-off plugin is an answer, not a silent skip", async () => {
  const { store, rt } = await runtime();
  await store.setPluginChoice("t", "a", "http", "disable");
  const r = await rt.addMount("t", "a", web);
  must(!r.ok && /switched off/.test(r.error), `off: ${JSON.stringify(r)}`);
  must(!(await store.getMountByAlias("t", "a", "web2")), "mounted anyway");
});

await check("an unknown plugin, a bad alias and an undeclared setting are refused", async () => {
  const { store, rt } = await runtime();
  const nope = await rt.addMount("t", "a", { alias: "x", plugin: "nope", config: {} });
  must(!nope.ok && /no plugin named nope/.test(nope.error), `unknown: ${JSON.stringify(nope)}`);
  for (const alias of ["", "Web", "a__b", "1web", "w".repeat(25)]) {
    const r = await rt.addMount("t", "a", { ...web, alias });
    must(!r.ok && /an alias is/.test(r.error), `alias ${JSON.stringify(alias)}: ${JSON.stringify(r)}`);
  }
  const typo = await rt.addMount("t", "a", { ...web, config: { account: "open web", max_bytes: 1 } });
  must(!typo.ok, `undeclared setting: ${JSON.stringify(typo)}`);
  must((await store.listMounts("t", "a")).length === 0, "something was mounted");
});

console.log(`\n  Adding a mount by hand\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
