/** Web search with a key: what the mount promises, and what a failure must not be read as. */
import { exaPlugin } from "../src/plugins/exa.ts";
import type { PluginErrorFields } from "../src/plugins/types.ts";

/** What a refusal from this plugin is: a message for a person, and the fields a
 *  console badges from. Typed here so a narrowing `instanceof Error` cannot
 *  quietly hide the half the assertions are about. */
type Refusal = Error & PluginErrorFields;

const results: Array<{ row: string; name: string; ok: boolean; error?: string }> = [];
const test = async (row: string, name: string, fn: () => Promise<void>) => {
  try { await fn(); results.push({ row, name, ok: true }); }
  catch (e) { results.push({ row, name, ok: false, error: (e as Error).message }); }
};
function assert(c: unknown, w: string): asserts c { if (!c) throw new Error(`assertion failed: ${w}`); }
const eq = (a: unknown, b: unknown, w: string) =>
  assert(Object.is(a, b), `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const ctx = (over: Record<string, unknown> = {}) => ({
  caller: { tenantId: "t", agentId: "a", taskId: "k" },
  alias: "web",
  credential: "a-key",
  credentialRefKind: "operator" as const,
  publicConfig: {},
  connection: { async get() { return null; }, async set() {} },
  async sibling() { return null; },
  ...over,
});

/** Stands in for the network, and records what was sent. */
let sent: { url: string; init: RequestInit } | null = null;
const real = globalThis.fetch;
const stub = (status: number, body: unknown, ok = status < 400) => {
  globalThis.fetch = (async (url: any, init: any) => {
    sent = { url: String(url), init };
    return {
      ok, status, statusText: `HTTP ${status}`,
      async json() { return body; },
    } as any;
  }) as any;
};
const restore = () => { globalThis.fetch = real; };

const BODY = {
  requestId: "r", searchTime: 1, costDollars: { total: 0.007 },
  results: [
    { id: "1", title: "First", url: "https://a.test/1", highlights: ["alpha", "beta"] },
    { id: "2", title: "Second", url: "https://b.test/2", highlights: ["gamma"] },
  ],
};

await test("结果形状", "a result carries title, url and the highlights joined", async () => {
  stub(200, BODY);
  try {
    const out: any = await exaPlugin.invoke("search", { query: "q" } as any, ctx() as any);
    eq(out.count, 2, "count");
    eq(out.query, "q", "query is echoed");
    eq(out.results[0].title, "First", "title");
    eq(out.results[0].url, "https://a.test/1", "url");
    // Joined rather than first: a first highlight is often page chrome.
    eq(out.results[0].snippet, "alpha … beta", "snippet");
  } finally { restore(); }
});

await test("请求形状", "the key travels in the header and never in the url", async () => {
  stub(200, BODY);
  try {
    await exaPlugin.invoke("search", { query: "q", limit: 3 } as any, ctx() as any);
    assert(sent, "a request was made");
    eq(sent!.url, "https://api.exa.ai/search", "one fixed endpoint, no agent-chosen url");
    // The whole reason this plugin may hold a key: a key in a query string is
    // a key in every proxy log between here and there.
    assert(!sent!.url.includes("a-key"), "the key is not in the url");
    const headers = sent!.init.headers as Record<string, string>;
    eq(headers["x-api-key"], "a-key", "the key is a header");
    const body = JSON.parse(String(sent!.init.body));
    eq(body.query, "q", "query");
    eq(body.numResults, 3, "limit arrives as numResults");
    eq(body.contents.highlights, true, "highlights are asked for, or results carry no content");
  } finally { restore(); }
});

await test("上限", "limit is clamped rather than passed through", async () => {
  stub(200, BODY);
  try {
    await exaPlugin.invoke("search", { query: "q", limit: 500 } as any, ctx() as any);
    eq(JSON.parse(String(sent!.init.body)).numResults, 20, "clamped to the documented ceiling");
  } finally { restore(); }
});

await test("无凭据", "with no key the error says who attaches one", async () => {
  const e = await exaPlugin.invoke("search", { query: "q" } as any,
    ctx({ credential: null, credentialRefKind: "none" }) as any).catch((x) => x as Refusal) as Refusal;
  assert(e instanceof Error, "it refuses");
  assert(/attach/.test(e.message), `names the repair: ${e.message}`);
  // The console badges a stored failure off the field, not off the sentence.
  eq(e.identity, "none", "identity travels as data");
});

await test("过载非空结果", "an overloaded service is transient and is not an empty result", async () => {
  stub(503, { error: "Exa is temporarily over capacity.", tag: "SERVICE_OVERLOADED" });
  try {
    const e = await exaPlugin.invoke("search", { query: "q" } as any, ctx() as any).catch((x) => x as Refusal) as Refusal;
    assert(e instanceof Error, "it refuses");
    assert(/SERVICE_OVERLOADED/.test(e.message), `the service's own tag travels: ${e.message}`);
    assert(/not an empty result/.test(e.message), "an agent must not read this as 'nothing exists'");
    eq(e.transient, true, "it clears on its own");
  } finally { restore(); }
});

await test("坏钥匙不可重试", "a rejected key is NOT transient, so an agent does not loop on it", async () => {
  stub(401, { error: "Invalid API key", tag: "INVALID_API_KEY" });
  try {
    const e = await exaPlugin.invoke("search", { query: "q" } as any, ctx() as any).catch((x) => x as Refusal) as Refusal;
    assert(/INVALID_API_KEY/.test(e.message), e.message);
    // The two failures above arrive as the same "it did not work" unless this
    // is decided per status: one clears by waiting, the other never does.
    eq(e.transient, false, "waiting cannot fix a rejected key");
    eq(e.identity, "attached", "a key was used, and it was refused");
  } finally { restore(); }
});

await test("读不懂非零结果", "a body this parser cannot read is refused, not reported as zero", async () => {
  stub(200, { requestId: "r" });
  try {
    const e = await exaPlugin.invoke("search", { query: "q" } as any, ctx() as any).catch((x) => x as Refusal) as Refusal;
    assert(e instanceof Error, "it refuses");
    assert(/not an empty result/.test(e.message), "the one thing it must not say is 'no results'");
  } finally { restore(); }
});

await test("非 http 结果", "a result without an http(s) url is dropped, not passed on", async () => {
  stub(200, { results: [{ title: "x", url: "javascript:alert(1)", highlights: [] }, BODY.results[0]] });
  try {
    const out: any = await exaPlugin.invoke("search", { query: "q" } as any, ctx() as any);
    eq(out.count, 1, "only the http(s) one survives");
    eq(out.results[0].url, "https://a.test/1", "and it is the right one");
  } finally { restore(); }
});

await test("片段上限", "a long highlight is cut, and the result says how many were", async () => {
  // Live measurement, not a guess: three real results came back with 5,962 /
  // 2,520 / 5,002 characters of highlights, so eight of them would not fit in
  // a tool result at all. The default is the first cap that left room under
  // the 4 KB parking line on both queries measured — see the plugin.
  stub(200, { results: [
    { title: "long", url: "https://a.test/1", highlights: ["x".repeat(6000)] },
    { title: "short", url: "https://b.test/2", highlights: ["ok"] },
  ] });
  try {
    const out: any = await exaPlugin.invoke("search", { query: "q" } as any, ctx() as any);
    eq(out.results[0].snippet.length, 256, "cut to the default cap");
    eq(out.results[1].snippet, "ok", "a short one is untouched");
    eq(out.cut, 1, "and the count says one was shortened, so the loss is visible");
  } finally { restore(); }
});

await test("上限可配", "the cap is a mount setting, not a constant", async () => {
  stub(200, { results: [{ title: "long", url: "https://a.test/1", highlights: ["x".repeat(6000)] }] });
  try {
    const out: any = await exaPlugin.invoke("search", { query: "q" } as any,
      ctx({ publicConfig: { snippetChars: 12 } }) as any);
    eq(out.results[0].snippet.length, 12, "the mount's number wins");
    eq(out.cut, 1, "still reported");
  } finally { restore(); }
});

await test("未知工具", "this mount answers one tool and says so", async () => {
  const e = await exaPlugin.invoke("get", { url: "https://x.test" } as any, ctx() as any).catch((x) => x as Refusal) as Refusal;
  assert(/unknown tool/.test(e.message), e.message);
});

console.log(`\n  exa — web search as a mount that holds a key\n  ${"─".repeat(66)}`);
for (const r of results) {
  const label = `${r.row.padEnd(14)} ${r.name}`;
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗\x1b[0m ${label}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(66)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
