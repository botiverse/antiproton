/**
 * Settings checked where a person can read the answer.
 *
 * The failure worth catching is the quiet one: a mount carrying `timeout_ms`
 * where the plugin reads `timeoutMs` is not rejected by anything, so the plugin
 * uses its default for ever and the symptom appears somewhere else entirely.
 */
import { validateMount, assertMountConfig } from "../src/runtime/mount-config.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import { run9Plugin } from "../src/plugins/run9.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

const run9 = run9Plugin(null as any, "local");

check("拼错的键会被拒绝,并给出最接近的那个", () => {
  const p = validateMount(run9, { timeout_ms: 5000 } as any, "env:RUN9");
  if (p.length !== 1) throw new Error(`expected one problem, got ${JSON.stringify(p)}`);
  if (!p[0]!.message.includes('did you mean "timeoutMs"')) {
    throw new Error(`no suggestion: ${p[0]!.message}`);
  }
});

check("类型不对会被说出来,而不是被强转", () => {
  const p = validateMount(run9, { timeoutMs: "5000" } as any, "env:RUN9");
  if (!p.some((x) => x.message.includes("should be number, got string"))) {
    throw new Error(JSON.stringify(p));
  }
});

check("需要账号却没有 secret_ref,挂载时就报", () => {
  const p = validateMount(run9, { image: "x" } as any, null);
  if (!p.some((x) => x.message.includes("needs an account"))) throw new Error(JSON.stringify(p));
});

check("凭据可选的插件,没有账号也能挂", () => {
  const p = validateMount(githubPlugin, {} as any, null);
  if (p.length) throw new Error(`a public-only mount was refused: ${JSON.stringify(p)}`);
});

check("合法配置不报任何问题", () => {
  const p = validateMount(run9, {
    account: "operator", image: "node:22-alpine", workdir: "/work",
    timeoutMs: 300000, secrets: ["STRIPE_KEY"],
  } as any, "env:RUN9");
  if (p.length) throw new Error(JSON.stringify(p));
});

check("account 是控制台的标签,不算插件设置", () => {
  const p = validateMount(githubPlugin, { account: "unauthenticated" } as any, null);
  if (p.length) throw new Error(JSON.stringify(p));
});

check("还没声明设置的插件不会因为已有的键被拒", () => {
  // Refusing every key on a plugin that declares none would break every mount
  // already carrying one, which is not a migration anyone asked for.
  const p = validateMount({ id: "demo", config: [], credential: undefined }, { anything: 1 } as any, null);
  if (p.length) throw new Error(JSON.stringify(p));
});

check("assert 版本会抛,并且把问题都带上", () => {
  let msg = "";
  try { assertMountConfig(run9, { timeout_ms: 1, shel: "x" } as any, null); }
  catch (e) { msg = String((e as Error).message); }
  if (!msg.includes("cannot mount run9")) throw new Error(`unexpected: ${msg}`);
  if (!msg.includes("timeoutMs") || !msg.includes("needs an account")) {
    throw new Error(`problems were dropped: ${msg}`);
  }
});

console.log(`\n  Mount settings\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
