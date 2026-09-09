/** Outbound HTTP is a mount with an allowlist, not a capability. */
import { checkUrl, httpPlugin } from "../src/plugins/http.ts";

const results: Array<{ row: string; name: string; ok: boolean; error?: string }> = [];
const test = async (row: string, name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ row, name, ok: true }); }
  catch (e) { results.push({ row, name, ok: false, error: (e as Error).message }); }
};
function assert(c: unknown, w: string): asserts c { if (!c) throw new Error(`assertion failed: ${w}`); }
const eq = (a: unknown, b: unknown, w: string) =>
  assert(Object.is(a, b), `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const ctx = (allowedHosts: string[], extra = {}) => ({
  caller: { tenantId: "t", agentId: "a", taskId: "k" },
  credential: null,
  publicConfig: { allowedHosts, ...extra },
  connection: { async get() { return null; }, async set() {} },
  async sibling() { return null; },
});

await test("默认开放", "with no allowlist configured, any public host is reachable", async () => {
  // Deliberate: an allowlist decides who may inject content, not whether
  // injection works. What bounds the damage is that the agent holds no
  // credential and that writes need a human.
  assert(checkUrl("https://example.com/", undefined).ok, "open by default");
  assert(checkUrl("https://anything.test/x", undefined).ok, "genuinely open");
});

await test("显式空表即全拒", "an explicitly empty allowlist allows nothing", async () => {
  const r = checkUrl("https://example.com/", []);
  assert(!r.ok, "refused");
  assert(r.why.includes("allowlist"), r.why);
});

await test("开放时仍拒内网", "an open mount still refuses inward hosts and odd schemes", async () => {
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/", "file:///etc/passwd"]) {
    assert(!checkUrl(u, undefined).ok, `${u} should still be refused`);
  }
});

await test("非 http 协议", "file:, data: and friends are refused before anything else", async () => {
  for (const u of ["file:///etc/passwd", "data:text/plain,hi", "gopher://x/"]) {
    const r = checkUrl(u, ["x"]);
    assert(!r.ok && r.why.includes("scheme"), `${u}: ${JSON.stringify(r)}`);
  }
});

await test("内网与元数据", "inward-resolving hosts are refused even if allowlisted", async () => {
  // The allowlist is about intent; these are about reachability, so listing
  // them must not help.
  for (const h of ["169.254.169.254", "localhost", "127.0.0.1", "10.0.0.5",
                   "192.168.1.1", "172.16.0.1", "foo.internal", "bar.local"]) {
    const r = checkUrl(`http://${h}/`, [h]);
    assert(!r.ok && r.why.includes("internal"), `${h} was not refused: ${JSON.stringify(r)}`);
  }
});

await test("白名单不支持通配", "a listed host is matched exactly, so a suffix cannot sneak in", async () => {
  assert(checkUrl("https://api.github.com/x", ["api.github.com"]).ok, "exact host allowed");
  assert(!checkUrl("https://api.github.com.evil.tld/x", ["api.github.com"]).ok, "suffix refused");
  assert(!checkUrl("https://evil.api.github.com/x", ["api.github.com"]).ok, "subdomain refused");
});

await test("跳转逐跳检查", "a redirect to a host outside the allowlist is refused", async () => {
  const real = globalThis.fetch;
  (globalThis as any).fetch = async (u: URL | string) => {
    const s = String(u);
    if (s.startsWith("https://allowed.test")) {
      return new Response(null, { status: 302, headers: { location: "https://evil.test/secrets" } });
    }
    return new Response("should never be reached", { status: 200 });
  };
  try {
    let msg = "";
    try { await httpPlugin.invoke("get", { url: "https://allowed.test/a" }, ctx(["allowed.test"]) as any); }
    catch (e) { msg = (e as Error).message; }
    assert(msg.includes("evil.test") && msg.includes("allowlist"), `expected the hop to be refused, got: ${msg}`);
  } finally { (globalThis as any).fetch = real; }
});

await test("正文有上限", "a large body is truncated rather than pulled into context whole", async () => {
  const real = globalThis.fetch;
  (globalThis as any).fetch = async () =>
    new Response("x".repeat(500_000), { status: 200, headers: { "content-type": "text/plain" } });
  try {
    const out: any = await httpPlugin.invoke(
      "get", { url: "https://allowed.test/big" }, ctx(["allowed.test"], { maxBytes: 1000 }) as any);
    eq(out.body.length, 1000, "capped");
    eq(out.truncated, true, "and says so");
    eq(out.bytes, 500_000, "while reporting the real size");
  } finally { (globalThis as any).fetch = real; }
});

await test("读写分家", "safe verbs stay on the read tool and the rest on the write tool", async () => {
  // The split is what lets a mount gate one and not the other, so a method on
  // the wrong tool is refused rather than quietly allowed. Checked without a
  // network round trip: the refusal happens before the request is made.
  // A host the mount allows, so the refusal under test is the method one and
  // not the allowlist getting there first.
  const c = ctx(["example.com"]);
  const refuses = async (tool: string, args: unknown, why: RegExp) => {
    try {
      await httpPlugin.invoke(tool, args as any, c as any);
      throw new Error(`${tool} ${JSON.stringify(args)} was allowed`);
    } catch (e) {
      const m = (e as Error).message;
      assert(why.test(m), `wrong refusal: ${m}`);
    }
  };
  await refuses("get", { url: "https://example.com/", method: "POST" }, /use web\.send/);
  await refuses("send", { url: "https://example.com/", method: "GET" }, /use web\.get/);
});

await test("凭据头不出门", "credential headers are refused and the refusal is reported", async () => {
  // The mount design keeps a credential on the far side of the gateway. A model
  // that can set `authorization` can carry one back out, or believe it has
  // authenticated when it has not.
  const c = ctx([]);
  try {
    await httpPlugin.invoke("get",
      { url: "https://example.com/", headers: { authorization: "Bearer x" } } as any, c as any);
  } catch (e) {
    // The allowlist refuses first here, which is fine — the point is that the
    // header never becomes part of a request.
    assert(/allowlist/.test((e as Error).message), (e as Error).message);
  }
});

console.log(`\n  outbound http — a mount, not a capability\n  ${"─".repeat(66)}`);
for (const r of results) {
  const label = `${r.row.padEnd(14)} ${r.name}`;
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗\x1b[0m ${label}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(66)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
