/**
 * AppWorld through the ordinary machinery: mounts, gateway, secret_ref,
 * per-mount connection state. Requires both AppWorld servers:
 *   appworld serve apis --port 8800 & appworld serve environment --port 8799 &
 */
import { readFileSync } from "node:fs";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway, type SecretResolver } from "../src/runtime/gateway.ts";
import { appworldPlugins, type Catalogue } from "../src/plugins/appworld.ts";

const ENV = process.env.AW_ENV_URL ?? "http://localhost:8799";
const API = process.env.AW_API_URL ?? "http://localhost:8800";
const TASK = process.env.AW_TASK ?? "50e1ac9_1";
const T = "tenant-a", AGENT = "agent-1", TASK_ID = "t1";

const j = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
const test = async (name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: (e as Error).message }); }
};
function assert(c: unknown, what: string): asserts c {
  if (!c) throw new Error(`assertion failed: ${what}`);
}

await j(`${ENV}/initialize`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ task_id: TASK, experiment_name: "harness-test", remote_apis_url: API }),
});

// The admin's job, done once at configuration time — not the agent's.
const profile = await j(`${API}/supervisor/profile`);
const passwords: Array<{ account_name: string; password: string }> =
  await j(`${API}/supervisor/account_passwords`);
const credentialFor = (app: string) => {
  const pw = passwords.find((p) => p.account_name === app);
  if (!pw) return null;
  const username = app === "phone" ? profile.phone_number : profile.email;
  return JSON.stringify({ username, password: pw.password });
};

const catalogue = JSON.parse(
  readFileSync(new URL("../bench/appworld/catalogue.json", import.meta.url).pathname, "utf8"),
) as Catalogue;
const plugins = appworldPlugins(catalogue, { apiBaseUrl: API });

const store = new SqliteStore(":memory:");
await store.init();
await store.createAgent(T, AGENT);
await store.createTask(T, AGENT, TASK_ID, {});
for (const p of plugins) {
  await store.addMount({
    tenantId: T, agentId: AGENT, alias: p.id, plugin: p.id,
    installationId: `inst-${p.id}`, connectionId: null, toolVersion: "1.0.0",
    publicConfig: { account: profile.email }, secretRef: `aw:${p.id}`,
  });
}
const secrets: SecretResolver = {
  async resolve(ref) { return credentialFor(ref.replace(/^aw:/, "")); },
};
const gw = new ToolGateway(store, plugins, secrets);
const ctx = { tenantId: T, agentId: AGENT, taskId: TASK_ID };

// ---------------------------------------------------------------- cases

await test("凭据不进模型面 — no schema mentions access_token", async () => {
  const leaks = plugins.flatMap((p) =>
    p.tools.filter((t) => JSON.stringify(t.parameters).includes("access_token"))
      .map((t) => `${p.id}.${t.name}`));
  assert(leaks.length === 0, `tools exposing access_token: ${leaks.slice(0, 5).join(", ")}`);
});

await test("密码工具被收回 — the credential-reading tool is not mounted", async () => {
  const r = await gw.invoke(ctx, "supervisor.show_account_passwords", {});
  assert(r.status === "rejected", `expected rejection, got ${r.status}`);
  assert((r as any).error.code === "unknown_tool", `expected unknown_tool, got ${(r as any).error.code}`);
});

await test("无令牌起步 — connection state is empty before the first call", async () => {
  const c = await store.getConnection(T, AGENT, "spotify");
  assert(c === null, `expected no session, got ${JSON.stringify(c)}`);
});

await test("网关代登录 — an authenticated call succeeds without the agent logging in", async () => {
  const r = await gw.invoke(ctx, "spotify.show_account", {});
  assert(r.status === "succeeded", `status ${r.status}: ${JSON.stringify((r as any).error ?? "")}`);
  assert((r as any).result.email === profile.email, "returned the supervisor's account");
});

await test("令牌落在 mount 的连接态里 — token cached, not in the result", async () => {
  const c = (await store.getConnection(T, AGENT, "spotify")) as any;
  assert(c && typeof c.token === "string" && c.token.length > 0, "session token stored");
  const r = await gw.invoke(ctx, "spotify.show_account", {});
  assert(r.status === "succeeded", "second call succeeds");
  assert(!JSON.stringify((r as any).result).includes(c.token), "token never appears in a tool result");
});

await test("会话按 mount 隔离 — logging into spotify does not authenticate amazon", async () => {
  assert(await store.getConnection(T, AGENT, "amazon") === null, "amazon has no session yet");
  const r = await gw.invoke(ctx, "amazon.show_account", {});
  assert(r.status === "succeeded", `amazon call: ${r.status}`);
  const a = (await store.getConnection(T, AGENT, "amazon")) as any;
  const s = (await store.getConnection(T, AGENT, "spotify")) as any;
  assert(a.token !== s.token, "each mount holds its own token");
});

await test("过期令牌自动重取 — a poisoned session is re-established transparently", async () => {
  await store.putConnection(T, AGENT, "spotify", { token: "not-a-real-token", obtainedAt: 0 });
  const r = await gw.invoke(ctx, "spotify.show_account", {});
  assert(r.status === "succeeded", `expected recovery, got ${r.status}`);
  const c = (await store.getConnection(T, AGENT, "spotify")) as any;
  assert(c.token !== "not-a-real-token", "session was replaced");
});

await test("读操作可用 — a real query returns data", async () => {
  const r = await gw.invoke(ctx, "spotify.show_playlist_library", { page_limit: 3 });
  assert(r.status === "succeeded", `status ${r.status}: ${JSON.stringify((r as any).error ?? "")}`);
  assert(Array.isArray((r as any).result), "playlist library is a list");
});

await test("跨租户不可见 — another tenant cannot use this mount", async () => {
  const r = await gw.invoke({ ...ctx, tenantId: "tenant-b" }, "spotify.show_account", {});
  assert(r.status === "rejected", `expected rejection, got ${r.status}`);
  assert((r as any).error.code === "not_mounted", `got ${(r as any).error.code}`);
});

console.log(`\n  AppWorld as mounts — ${plugins.length} plugins, ` +
  `${plugins.reduce((a, p) => a + p.tools.length, 0)} tools\n  ${"─".repeat(66)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(66)}\n  ${pass} passed, ${results.length - pass} failed\n`);
await store.close();
process.exit(pass === results.length ? 0 : 1);
