/** Outbound HTTP is a mount with an allowlist, not a capability. */
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
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
  alias: "web",
  credential: null,
  publicConfig: { allowedHosts, ...extra },
  async sibling() { return null; },
  // The agent's kept secrets, as the gateway answers for them: by name, null when there is none.
  async agentSecret(name: string) { return name === "acme" ? "sk-acme-0123456789" : null; },
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
  // The refusal names the tool to use and the mount it is on, and not the
  // dispatch address: `web.send` is not a name the model can call.
  await refuses("get", { url: "https://example.com/", method: "POST" }, /use the `send` tool on `web`/);
  await refuses("send", { url: "https://example.com/", method: "GET" }, /use the `get` tool on `web`/);
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

await test("按名用密钥", "a kept secret is named in secretHeaders, filled in on the way out, and never comes back", async () => {
  const real = globalThis.fetch;
  const sent: Array<{ url: string; headers: Record<string, string> }> = [];
  (globalThis as any).fetch = async (u: URL | string, init: any) => {
    sent.push({ url: String(u), headers: init.headers });
    // A service that echoes what it was sent, in the body and in a header.
    return new Response(JSON.stringify({ youSent: init.headers["x-api-key"] }), {
      status: 200, headers: { "content-type": "application/json", "x-echo": String(init.headers["x-api-key"]) },
    });
  };
  try {
    const out: any = await httpPlugin.invoke("send",
      { url: "https://api.acme.test/v1", body: { q: 1 }, secretHeaders: { "X-Api-Key": "acme" } } as any, ctx(["api.acme.test"]) as any);
    eq(sent[0]?.headers["x-api-key"], "sk-acme-0123456789", "the value went out in the header");
    assert(!JSON.stringify(out).includes("sk-acme-0123456789"), `the value came back: ${JSON.stringify(out)}`);
    assert(out.body.includes("[secret acme]") && out.headers["x-echo"] === "[secret acme]", `the echo is not named: ${JSON.stringify(out)}`);
    eq(out.secretHeaders?.["x-api-key"], "acme", "the result says which secret went where, by name");
    let msg = "";
    try { await httpPlugin.invoke("get", { url: "https://api.acme.test/v1", secretHeaders: { authorization: "nope" } } as any, ctx(["api.acme.test"]) as any); }
    catch (e) { msg = (e as Error).message; }
    assert(/no secret named nope/.test(msg), `a missing secret: ${msg}`);
  } finally { (globalThis as any).fetch = real; }
});

await test("跳转不带密钥", "a kept secret goes to the first URL's origin only, not after a redirect elsewhere", async () => {
  const real = globalThis.fetch;
  const sent: Array<{ url: string; key?: string }> = [];
  (globalThis as any).fetch = async (u: URL | string, init: any) => {
    const s = String(u);
    sent.push({ url: s, key: init.headers.authorization });
    if (s.startsWith("https://api.acme.test/")) return new Response(null, { status: 302, headers: { location: "https://cdn.other.test/x" } });
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    const out: any = await httpPlugin.invoke("get",
      { url: "https://api.acme.test/a", secretHeaders: { authorization: "acme" } } as any, ctx(["api.acme.test", "cdn.other.test"]) as any);
    eq(sent[0]?.key, "sk-acme-0123456789", "the first hop carried it");
    eq(sent[1]?.key, undefined, "the redirect to another origin did not");
    eq(out.secretHeadersNotSentTo, "cdn.other.test", "and the result says where it was held back");
  } finally { (globalThis as any).fetch = real; }
});

await test("密钥模板", "a header can wrap a kept secret in text, as most APIs want Bearer <key>", async () => {
  const real = globalThis.fetch;
  const sent: Array<Record<string, string>> = [];
  (globalThis as any).fetch = async (_u: URL | string, init: any) => {
    sent.push(init.headers);
    return new Response(`auth was ${init.headers.authorization}`, { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    const out: any = await httpPlugin.invoke("get",
      { url: "https://api.acme.test/v1", secretHeaders: { authorization: "Bearer {{acme}}" } } as any, ctx(["api.acme.test"]) as any);
    eq(sent[0]?.authorization, "Bearer sk-acme-0123456789", "the template was filled");
    eq(out.body, "auth was Bearer [secret acme]", "and the echo names the secret");
    eq(out.secretHeaders?.authorization, "Bearer {{acme}}", "the result shows the template, not the value");
    let msg = "";
    try { await httpPlugin.invoke("get", { url: "https://api.acme.test/v1", secretHeaders: { authorization: "Bearer {{nope}}" } } as any, ctx(["api.acme.test"]) as any); }
    catch (e) { msg = (e as Error).message; }
    assert(/no secret named nope/.test(msg), `a missing name in a template: ${msg}`);
  } finally { (globalThis as any).fetch = real; }
});

await test("跳出后不再带", "once a redirect leaves the first origin, the secret stays behind even when it comes back", async () => {
  const real = globalThis.fetch;
  const sent: Array<{ url: string; key?: string }> = [];
  (globalThis as any).fetch = async (u: URL | string, init: any) => {
    const s = String(u);
    sent.push({ url: s, key: init.headers.authorization });
    if (s === "https://api.acme.test/a") return new Response(null, { status: 302, headers: { location: "https://cdn.other.test/x" } });
    if (s === "https://cdn.other.test/x") return new Response(null, { status: 302, headers: { location: "https://api.acme.test/b" } });
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  };
  try {
    await httpPlugin.invoke("get",
      { url: "https://api.acme.test/a", secretHeaders: { authorization: "acme" } } as any, ctx(["api.acme.test", "cdn.other.test"]) as any);
    eq(sent.length, 3, "three hops");
    eq(sent[2]?.key, undefined, "the hop back to the first origin went without it");
  } finally { (globalThis as any).fetch = real; }
});

// Binary bodies. Decoding leniently turned an image or a gzip stream into a "text" result of U+FFFD runs, which is
// neither the file nor anything a model can use; a binary body comes back described instead, and text exactly as before.
const cat = (...parts: Array<number[] | Uint8Array>) => Uint8Array.from(parts.flatMap((p) => [...p]));
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w: number, h: number) => cat([0x89, ...ascii("PNG\r\n\x1a\n")], be32(13), ascii("IHDR"), be32(w), be32(h), [8, 6, 0, 0, 0], [0, 0, 0, 0],
  be32(0), ascii("IEND"), [0xae, 0x42, 0x60, 0x82]);
const jpeg = (w: number, h: number) => cat([0xff, 0xd8], [0xff, 0xe0], [0, 16], ascii("JFIF\0"), [1, 1, 0, 0, 1, 0, 1, 0, 0],
  [0xff, 0xc0], [0, 17], [8], [h >> 8, h & 255], [w >> 8, w & 255], [3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], [0xff, 0xd9]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
/** Deterministic noise: a fixed LCG, so a failure reproduces. */
const noise = (n: number) => { let x = 12345; return Uint8Array.from({ length: n }, () => (x = (x * 1103515245 + 12345) >>> 0) >>> 24); };
async function served(body: Uint8Array, type: string | null, extra: Record<string, unknown> = {}, tool = "get"): Promise<any> {
  const real = globalThis.fetch;
  (globalThis as any).fetch = async () =>
    new Response(body as Uint8Array<ArrayBuffer>, { status: 200, headers: type === null ? {} : { "content-type": type } });
  try { return await httpPlugin.invoke(tool, { url: "https://files.test/x", ...extra } as any, ctx([], { allowedHosts: undefined, ...extra }) as any); }
  finally { (globalThis as any).fetch = real; }
}
const described = (r: any, kind: string, mimeType: string | undefined, b: Uint8Array) => {
  assert(!("body" in r) && !("text" in r), `binary came back as text: ${JSON.stringify(r).slice(0, 160)}`);
  eq(r.kind, kind, "kind");
  eq(r.mimeType, mimeType, "mimeType");
  eq(r.bytes, b.byteLength, "bytes are the body's byte length");
  eq(r.sha256, sha(b), "sha256 of the body");
  assert(/not returned as text/.test(r.note), `note: ${r.note}`);
  eq(r.status, 200, "status still reported");
};

await test("二进制·JPEG", "a JPEG body is described with its dimensions, not decoded", async () => {
  const b = jpeg(640, 480);
  const r = await served(b, "image/jpeg");
  described(r, "image", "image/jpeg", b);
  eq(r.width, 640, "width"); eq(r.height, 480, "height");
  assert(!("view" in r), "no view marker: this mount has no artifact to attach");
});

await test("二进制·PNG", "a PNG body is described with its dimensions, not decoded", async () => {
  const b = png(32, 16);
  const r = await served(b, "image/png");
  described(r, "image", "image/png", b);
  eq(r.width, 32, "width"); eq(r.height, 16, "height");
});

await test("gzip→文本", "a gzip body that expands to text comes back as that text", async () => {
  const text = "line one\nzwei: ü, 三\n";
  const z = gzipSync(Buffer.from(text));
  const r = await served(z, "application/gzip");
  eq(r.body, text, "the expanded text");
  eq(r.bytes, text.length, "bytes measures the text, as for any text body");
  eq(r.decompressed?.from, "gzip", "says it was expanded");
  eq(r.decompressed?.bytes, z.byteLength, "and from how many bytes");
  const html = await served(gzipSync(Buffer.from("<html><title>T</title><p>hi</p></html>")), "application/octet-stream");
  eq(html.title, "T", "expanded html goes through the html path");
});

await test("gzip→二进制", "a gzip body that expands to binary is described as what it expands to", async () => {
  const b = png(8, 8);
  const r = await served(gzipSync(b), "application/x-gzip");
  described(r, "image", "image/png", b);
  eq(r.decompressed?.from, "gzip", "says it was expanded");
  const bad = cat([0x1f, 0x8b], noise(200));
  const c = await served(bad, "application/gzip");
  described(c, "binary", "application/gzip", bad);
  assert(/not a gzip stream that decompresses/.test(c.note), `corrupt gzip note: ${c.note}`);
});

await test("gzip 上限", "a gzip body that expands past the cap is not expanded", async () => {
  const z = gzipSync(Buffer.alloc(17 * 1024 * 1024, 0x61));
  const r = await served(z, "application/gzip");
  described(r, "binary", "application/gzip", z);
  assert(/expands past/.test(r.note), `note: ${r.note}`);
});

await test("随机二进制", "random bytes are described, not decoded", async () => {
  const b = noise(4096);
  described(await served(b, "application/octet-stream"), "binary", "application/octet-stream", b);
  described(await served(b, null), "binary", undefined, b);
});

await test("非法 UTF-8", "bytes that are not UTF-8, under a type that does not say text, are described", async () => {
  const b = Uint8Array.from([0x41, 0x42, 0xc3, 0x28, 0xff, 0xfe, 0x80, 0x43]);
  described(await served(b, "application/octet-stream"), "binary", "application/octet-stream", b);
  described(await served(b, null), "binary", undefined, b);
  // A page in another charset says it is text: it stays the text it always was, a few U+FFFD and all.
  const latin1 = Uint8Array.from([...ascii("caf"), 0xe9, ...ascii(" cr"), 0xe8, ...ascii("me")]);
  const t = await served(latin1, "text/plain; charset=iso-8859-1");
  eq(t.body, await new Response(latin1).text(), "declared text that is not UTF-8 is unchanged");
});

await test("含 NUL", "a body with a NUL in it is described even under a text type", async () => {
  const b = Uint8Array.from([...ascii("hello"), 0, ...ascii("world")]);
  described(await served(b, "text/plain"), "binary", "text/plain", b);
});

await test("错标 text/plain", "a binary body labelled text/plain is described as what its bytes say", async () => {
  const b = jpeg(10, 20);
  const r = await served(b, "text/plain; charset=utf-8");
  described(r, "image", "image/jpeg", b);
  eq(r.contentType, "text/plain; charset=utf-8", "the declared type is still reported");
  const n = noise(2048);
  described(await served(n, "text/plain"), "binary", "text/plain", n);
  // No NUL in either, so only the signature tells: a JPEG whose header has no zero byte, and a PDF that is all ASCII.
  const bare = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 1, 1, 8, 1, 2, 3, 4, 3, 1, 0x22, 1, 2, 0x11, 1, 0xff, 0xd9]);
  assert(!bare.includes(0), "the fixture has no NUL");
  const j = await served(bare, "text/plain");
  described(j, "image", "image/jpeg", bare);
  eq(j.width, 0x0304, "width"); eq(j.height, 0x0102, "height");
  const pdf = new Uint8Array(Buffer.from("%PDF-1.7\n1 0 obj << >> endobj\n"));
  described(await served(pdf, "text/plain"), "binary", "application/pdf", pdf);
});

await test("多字节文本不变", "multi-byte UTF-8 text, BOM and a cut mid-character included, is returned as before", async () => {
  const b = new Uint8Array(Buffer.from("﻿héllo 世界 🎉 done", "utf8"));
  const before = await new Response(b).text();
  const r = await served(b, "text/plain; charset=utf-8", { maxBytes: 10 });
  eq(r.body, before.slice(0, 10), "the same slice of the same decode");
  eq(r.bytes, before.length, "bytes counts as before");
  eq(r.truncated, true, "truncated");
  eq(Object.keys(r).join(","), "status,statusText,url,contentType,headers,bytes,truncated,hops,body", "the same fields in the same order");
  const json = await served(new Uint8Array(Buffer.from('{"名":"值"}')), "application/json");
  eq(json.body, '{"名":"值"}', "json as-is");
});

await test("send 同样", "send describes a binary response the same way", async () => {
  const b = png(4, 4);
  described(await served(b, "image/png", { body: "x" }, "send"), "image", "image/png", b);
});

console.log(`\n  outbound http — a mount, not a capability\n  ${"─".repeat(66)}`);
for (const r of results) {
  const label = `${r.row.padEnd(14)} ${r.name}`;
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗\x1b[0m ${label}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(66)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
