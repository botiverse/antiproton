/**
 * The trace export's reader (cf/src/eval-read.ts `readTraceWindow`) over a stand-in object and bucket: the object read
 * before the bucket, batches ordered by their seq range rather than their key's text, a row in both read once, the
 * window and limit applied in seq order, and a page that stops at a bound naming where to go on, so paging reaches
 * every row exactly once. And `redactCredentials` walking whatever it is given.
 *
 * Through the Worker and a real object, with a real alarm pass exporting the batches: test/eval-seed-object.ts.
 */
import { readTraceWindow, redactCredentials, TRACE_OBJECTS_SCAN, type TraceSource } from "../cf/src/eval-read.ts";
import { traceBody, traceKey, traceKeyRange, tracePrefix } from "../cf/src/trace-r2.ts";
import type { TraceOutboxRow } from "../src/trace/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const T = "t-raft", A = "raft_01JEVAL", T0 = 1_800_000_000_000;
const row = (seq: number, at = T0 + seq * 1000, who: { t?: string; a?: string } = {}): TraceOutboxRow =>
  ({ seq, at, tenantId: who.t ?? T, agentId: who.a ?? A, kind: "tool.call", spanId: `op_${seq}`, status: "succeeded", verdict: "ok", attrs: { tool: "noop" } });

/** A bucket of batches and an object's outbox, with the order they were asked in. */
function source(batches: TraceOutboxRow[][], local: TraceOutboxRow[], opts: { uploaded?: number; pageSize?: number; agent?: boolean } = {}) {
  const asked: string[] = [];
  const objects = batches.map((b) => ({ key: traceKey(T, A, b[0]!.seq, b[b.length - 1]!.seq), body: new TextDecoder().decode(traceBody(b)) }));
  // A foreign agent's batch under a neighbouring prefix, and a key this scheme never makes.
  objects.push({ key: traceKey(T, `${A}x`, 1, 1), body: new TextDecoder().decode(traceBody([row(1, T0, { a: `${A}x` })])) });
  objects.push({ key: `${tracePrefix(T, A)}notes.txt`, body: "not a batch" });
  // The same agent id in another tenant: its rows must never come through either.
  objects.push({ key: traceKey("t-other", A, 1, 3), body: new TextDecoder().decode(traceBody([row(1, T0, { t: "t-other" }), row(2, T0, { t: "t-other" }), row(3, T0, { t: "t-other" })])) });
  objects.sort((a, b) => a.key.localeCompare(b.key));
  const size = opts.pageSize ?? 1000;
  const src: TraceSource = {
    async local(afterSeq, limit) { asked.push("local"); return opts.agent === false ? null : local.filter((r) => r.seq > afterSeq).slice(0, limit); },
    async list(prefix, cursor) {
      asked.push(`list:${cursor ?? ""}`);
      const all = objects.filter((o) => o.key.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + size);
      const truncated = start + size < all.length;
      return { objects: page.map((o) => ({ key: o.key, uploaded: new Date(opts.uploaded ?? T0 + 10_000_000) })), truncated, ...(truncated ? { cursor: String(start + size) } : {}) };
    },
    async get(key) { asked.push(`get:${key}`); return objects.find((o) => o.key === key)?.body ?? null; },
  };
  return { src, asked };
}
const ALL = { from: T0, to: T0 + 86_400_000, afterSeq: 0, limit: 1000 };
const seqs = (rows: TraceOutboxRow[]) => rows.map((r) => r.seq);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const batch = (a: number, b: number) => range(a, b).map((s) => row(s));

await check("the object is read before the bucket is listed; a row in both is one row; batches go by seq, not by key text", async () => {
  // Keys "10-19" sort before "2-9" as text.
  const { src, asked } = source([batch(2, 9), batch(10, 19)], [...batch(15, 19), ...batch(20, 22)]);
  const r = await readTraceWindow(src, T, A, ALL);
  must(r.ok, show(r));
  must(show(seqs(r.rows)) === show(range(2, 22)), `rows: ${show(seqs(r.rows))}`);
  must(asked[0] === "local" && asked[1] === "list:", `order: ${show(asked)}`);
  must(r.nextCursor === null && r.scanned.objects === 2, show(r));
  must(r.rows.every((x) => x.agentId === A && x.tenantId === T), "another agent's or tenant's row came through");
});

await check("the window is from <= at < to, and the cursor is a seq: only rows after it", async () => {
  const { src } = source([batch(1, 10)], batch(11, 12));
  const r = await readTraceWindow(src, T, A, { ...ALL, from: T0 + 3000, to: T0 + 11_000, afterSeq: 4 });
  must(r.ok && show(seqs(r.rows)) === show(range(5, 10)), show(r.ok && seqs(r.rows)));
});

await check("paging by nextCursor reaches every row exactly once, whether a page stops at its limit or at the batch bound", async () => {
  const batches = range(0, TRACE_OBJECTS_SCAN + 4).map((i) => batch(i * 5 + 1, i * 5 + 5));
  const last = (TRACE_OBJECTS_SCAN + 5) * 5;
  const { src } = source(batches, batch(last - 2, last + 3), { pageSize: 7 });
  for (const limit of [1, 3, 7, 1000]) {
    const got: number[] = [];
    let afterSeq = 0, pages = 0;
    for (;;) {
      const r = await readTraceWindow(src, T, A, { ...ALL, afterSeq, limit });
      must(r.ok, show(r));
      must(r.rows.length <= limit, `page over its limit: ${r.rows.length}`);
      got.push(...seqs(r.rows));
      pages++;
      if (r.nextCursor === null) break;
      must(Number(r.nextCursor) > afterSeq, `limit ${limit}: the cursor did not move (${afterSeq} -> ${r.nextCursor})`);
      afterSeq = Number(r.nextCursor);
      must(pages < 1000, "paging does not end");
    }
    must(show(got) === show(range(1, last + 3)), `limit ${limit}: ${got.length} rows, ${show(got.slice(0, 12))}…`);
  }
  // The bound itself: one page with no limit to hit still stops after TRACE_OBJECTS_SCAN batches and says where.
  const first = await readTraceWindow(src, T, A, ALL);
  must(first.ok && first.scanned.objects === TRACE_OBJECTS_SCAN && first.nextCursor === String(TRACE_OBJECTS_SCAN * 5), show(first.ok && [first.scanned, first.nextCursor]));
});

await check("a batch uploaded well before the window opens is not read; one uploaded after is", async () => {
  const early = source([batch(1, 5)], [], { uploaded: T0 - 2 * 3_600_000 });
  const r = await readTraceWindow(early.src, T, A, { ...ALL, from: T0 });
  must(r.ok && r.rows.length === 0 && !early.asked.some((a) => a.startsWith("get:")), show(early.asked));
  const late = source([batch(1, 5)], [], { uploaded: T0 });
  const s = await readTraceWindow(late.src, T, A, { ...ALL, from: T0 });
  must(s.ok && s.rows.length === 5, show(s));
});

await check("an object that is not the agent's is 404 and the bucket is never listed", async () => {
  const { src, asked } = source([batch(1, 2)], [], { agent: false });
  const r = await readTraceWindow(src, T, A, ALL);
  must(!r.ok && r.status === 404 && show(asked) === show(["local"]), show([r, asked]));
});

await check("traceKeyRange reads back exactly what traceKey wrote under that prefix, and nothing else", () => {
  const p = tracePrefix(T, A);
  must(show(traceKeyRange(p, traceKey(T, A, 12, 340))) === show({ fromSeq: 12, toSeq: 340 }), "round trip");
  for (const k of [traceKey(T, `${A}x`, 1, 2), `${p}1-2.json`, `${p}x-2.ndjson`, `${p}sub/1-2.ndjson`]) must(traceKeyRange(p, k) === null, k);
});

await check("redactCredentials walks every depth of arrays and objects, keys included, and leaves everything else as it was", () => {
  const key = "sk-" + "ant-api03-" + "k".repeat(40);
  const input = { n: 1, b: true, z: null, s: "fine", deep: [[[{ x: [{ y: key }] }]]], [`${key}`]: 2 };
  const r = redactCredentials(input);
  must(r.redactions === 2 && !show(r.value).includes(key), show(r));
  must(show(r.value) === show({ n: 1, b: true, z: null, s: "fine", deep: [[[{ x: [{ y: "<redacted:api-key>" }] }]]], "<redacted:api-key>": 2 }), show(r.value));
  must(show(input.deep) !== show((r.value as any).deep), "the input was changed in place");
  const two = redactCredentials({ [key]: 1, [key + "b"]: 2 });
  must(two.redactions === 2 && Object.keys(two.value as object).length === 2, `two keys of one kind collided: ${show(two)}`);
});

// ---- what the export catches, and what it leaves ---------------------------------------------------------------------

/** Assembled at run time, so this file's own text carries none of them whole. */
const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" + ".eyJzdWIiOiJhZ2VudCIsImV4cCI6OTk5OTk5OTk5OX0" + ".dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const OPAQUE = "3f9a8b7c6d5e4f3a" + "2b1c0d9e8f7a6b5c";
const b64 = (t: string) => Buffer.from(t).toString("base64");
/**
 * Each case a reviewer found leaking (PR #827), with the part that must not survive. `secretGet*` are a kept secret's
 * `{name, value}`: found by the tool that returned it (below), not by any shape, since a bare UUID has none.
 */
const LEAKS: Array<[string, unknown, string[]]> = [
  ["presigned", "https://bucket.r2.cloudflarestorage.com/t/x/y?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=abc%2F20261009&X-Amz-Signature=" + "0123456789abcdef".repeat(4), ["abc%2F20261009", "0123456789abcdef0123"]],
  ["jwtBare", JWT, [JWT.split(".")[1]!, JWT.split(".")[2]!]],
  ["bearerHeader", `Authorization: Bearer ${JWT}`, [JWT.split(".")[1]!]],
  ["bearerOpaque", `Authorization: Bearer ${OPAQUE}`, [OPAQUE]],
  ["basicAuth", "Authorization: Basic " + b64("user:supersecretpassword"), [b64("user:supersecretpassword")]],
  ["headersObj", { headers: { authorization: `Bearer ${OPAQUE}` } }, [OPAQUE]],
  ["cookie", "Set-Cookie: session=s%3AeyJ1c2VyIjoiYWdlbnQifQ.abcDEF123; HttpOnly", ["abcDEF123", "eyJ1c2VyIjoiYWdlbnQifQ"]],
  ["run9", "RUN9_TOKEN=r9_live_" + "abcdefghijklmnopqrstuvwxyz012345", ["abcdefghijklmnop"]],
  ["b64sk", b64("sk_agent_" + "abcdefghijklmnopqrstuvwx"), [b64("sk_agent_" + "abcdefghijklmnopqrstuvwx")]],
  ["b64ghp", b64("ghp_" + "a".repeat(36)), [b64("ghp_" + "a".repeat(36)).slice(0, 20)]],
  ["jsonInString", JSON.stringify({ token: "sk_agent_" + "abcdefghijklmnopqrst" }), ["abcdefghijklmnopqrst"]],
  ["escapedJson", JSON.stringify(JSON.stringify({ k: "sk-" + "a".repeat(40) })), ["a".repeat(40)]],
  ["urlEncodedSk", encodeURIComponent("sk_agent_" + "abcdefghij/klmnopqrst+"), ["abcdefghij", "klmnopqrst"]],
  ["splitSk", ["sk_agent_" + "abcdefgh", "ijklmnopqrst"], ["abcdefgh"]],
  ["googleKey", "AIza" + "SyD-abcdefghijklmnopqrstuvwxyz12345", ["abcdefghijklmnopqrstuvwxyz12345"]],
  ["stripe", "sk_live_" + "a".repeat(24), ["a".repeat(24)]],
  ["gcpSa", '{"type":"service_account","private_key_id":"abc123"}', ["abc123"]],
  ["anthropicNew", "sk-ant-api03-" + "a".repeat(80), ["a".repeat(80)]],
  ["ghpShort", "ghp_" + "a".repeat(30), ["a".repeat(30)]],
  ["ghsInUrl", "https://x-access-token:ghs_" + "a".repeat(36) + "@github.com/o/r.git", ["a".repeat(36)]],
  ["ptToken", "pt-" + "a".repeat(40), ["a".repeat(40)]],
  ["githubPat", "github_pat_" + "A1".repeat(12), ["A1".repeat(12)]],
  ["proxyAuthObj", { "Proxy-Authorization": "Basic " + b64("u:p") }, [b64("u:p")]],
  ["cookieObj", { cookie: "sid=abc" }, ["sid=abc"]],
  ["queryParams", "https://api.example.com/cb?code_state=1&access_token=AT123456&refresh_token=RT123456&client_secret=CS123456&password=PW123456&sig=SG123456&token=TK123456",
    ["AT123456", "RT123456", "CS123456", "PW123456", "SG123456", "TK123456"]],
  ["envLines", "export API_KEY=k3y-value-1\nDB_PASSWORD=p4ss-value-2\nPASSWORD=p4ss-value-3\nAWS_SECRET=s3cr-value-4", ["k3y-value-1", "p4ss-value-2", "p4ss-value-3", "s3cr-value-4"]],
  ["keyNames", { Token: "t-val-1", client_secret: "c-val-2", apiKey: "a-val-3", api_key: "a-val-4", Credential: { user: "u-val-5" }, x_password: "p-val-6", Authorization: "x-val-7" },
    ["t-val-1", "c-val-2", "a-val-3", "a-val-4", "u-val-5", "p-val-6", "x-val-7"]],
  ["b64Jwt", b64(`Authorization: Bearer ${OPAQUE}`), [b64(`Authorization: Bearer ${OPAQUE}`).slice(0, 24)]],
];

await check("every leaking case is replaced and counted, none of its credential is left, and a second walk replaces nothing more", () => {
  for (const [name, input, parts] of LEAKS) {
    const r = redactCredentials(input);
    const out = show(r.value);
    must(r.redactions > 0, `${name}: nothing replaced: ${out}`);
    for (const p of parts) must(!out.includes(p), `${name}: ${p.slice(0, 12)}… is left: ${out}`);
    const again = redactCredentials(r.value);
    must(again.redactions === 0 && show(again.value) === out, `${name}: a second walk changed it: ${show(again)}`);
  }
});

await check("a query parameter, header or env value is replaced, not the text around it", () => {
  const r = redactCredentials("see https://h.example/p?page=2&X-Amz-Signature=abcdef0123&q=cats now");
  must(r.value === "see https://h.example/p?page=2&X-Amz-Signature=<redacted:signed-url>&q=cats now" && r.redactions === 1, show(r));
  const env = redactCredentials("RUN9_TOKEN=r9tokenvalue\nHOME=/root");
  must(env.value === "RUN9_TOKEN=<redacted:env-secret>\nHOME=/root", show(env));
  const auth = redactCredentials(`curl -H "Authorization: Bearer ${OPAQUE}" https://h.example`);
  must(auth.value === 'curl -H "Authorization: Bearer <redacted:authorization>" https://h.example' && auth.redactions === 1, show(auth));
});

const SECRET = "0f8fad5b-d9cb-469f-a165-70867728950e", PW = "hunter2-correct-horse-battery";
const putCall = (alias: string, value: unknown) => ({ id: "c1", name: `${alias}__secret_put`, arguments: { name: "exa", value } });
const getResult = (alias: string, result: unknown) => ({ tool: `${alias}__secret_get`, callId: "c2", isError: false, status: "succeeded", result, at: 5 });

await check("a kept-secret tool's arguments and result lose every string but the secret's name, in any shape, under any alias", () => {
  for (const alias of ["state", "memory", "s2"]) {
    const ev = {
      events: [
        { sequence: 1, kind: "model.response", payload: { text: "storing", toolCalls: [putCall(alias, SECRET)] } },
        { sequence: 2, kind: "tool.result", payload: getResult(alias, { name: "exa", value: SECRET }) },
        { sequence: 3, kind: "tool.result", payload: getResult(alias, JSON.stringify({ name: "db", value: PW })) },
        { sequence: 4, kind: "tool.result", payload: getResult(alias, [{ type: "text", text: `value: ${PW}` }]) },
        { sequence: 5, kind: "tool.result", payload: getResult(alias, { secret: { value: PW, extra: PW } }) },
      ],
      byOp: { op_1: { state: "approved", approver: "u", tool: `${alias}.secret_put`, request: { name: "db", value: PW } } },
      rows: [{ seq: 1, kind: "tool.call", attrs: { tool: "state.secret_get", mount: alias, detail: PW } }],
    };
    const r = redactCredentials(ev);
    const out = show(r.value);
    must(!out.includes(SECRET) && !out.includes(PW), `${alias}: ${out}`);
    const v = r.value as any;
    must(v.events[0].payload.toolCalls[0].arguments.name === "exa" && v.events[0].payload.toolCalls[0].arguments.value === "<redacted:kept-secret>", show(v.events[0]));
    must(v.events[0].payload.text === "storing" && v.events[1].payload.result.name === "exa" && v.events[1].payload.status === "succeeded" && v.events[1].payload.callId === "c2", show(v.events[1]));
    must(v.byOp.op_1.request.name === "db" && v.byOp.op_1.approver === "u" && v.rows[0].attrs.mount === alias, show(v.byOp));
    // put's value, get's value, the JSON string whole, the content block's type and text (every string under the
    // result but a name), the nested value and its sibling, the approval's value, the trace detail.
    must(r.redactions === 9, `${alias}: ${r.redactions}`);
  }
  // Positive control: the same shapes under a tool not named secret_* keep the UUID, which no shape recognises.
  const plain = redactCredentials({ tool: "state__get", result: { name: "exa", value: SECRET } });
  must(plain.redactions === 0 && show(plain.value).includes(SECRET), show(plain));
});

await check("an agent's own sealed values are scrubbed wherever they appear — values, keys, any depth, inside text, escaped, encoded or base64 — each appearance counted", () => {
  const r = redactCredentials({
    text: `first ${PW} and again ${PW}`, [PW]: 1, deep: [[{ k: [`x${PW}y`] }]], json: JSON.stringify({ a: PW }),
    url: `https://h.example/?q=${encodeURIComponent(PW + " !")}`, b: Buffer.from(PW).toString("base64"), uuid: SECRET,
  }, { secrets: [PW, SECRET, "short7!"] });
  const out = show(r.value);
  must(!out.includes(PW) && !out.includes(SECRET) && !out.includes(Buffer.from(PW).toString("base64")) && !out.includes(encodeURIComponent(PW)), out);
  const v = r.value as any;
  must(v.text === "first <redacted:agent-secret> and again <redacted:agent-secret>" && v["<redacted:agent-secret>"] === 1 && v.deep[0][0].k[0] === "x<redacted:agent-secret>y", out);
  must(r.redactions === 8, `2 in text, the key, the deep one, the JSON, the encoded, the base64, the UUID: ${r.redactions}`);
  // Shorter than EXACT_MIN is not scrubbed: it would match ordinary words.
  const short = redactCredentials("short7! is a phrase", { secrets: ["short7!"] });
  must(short.redactions === 0 && short.value === "short7! is a phrase", show(short));
});

await check("ordinary transcript text is left alone: ids, UUIDs, seqs, plain URLs, code, prose about auth, hashes, usage counts", () => {
  const ordinary = {
    agentId: "raft_01JEVAL", sessionId: "main.3", cursor: "0", nextCursor: "500", total: 812,
    events: [
      { sequence: 1, kind: "message", payload: { text: "Message 0f8fad5b-d9cb-469f-a165-70867728950e from #general (seq 4411)", at: 1791536400000 }, createdAt: 1791536400000 },
      { sequence: 2, kind: "model.response", payload: { text: "Use Bearer authentication or Basic auth; the token is in the header. Set PASSWORD in your shell.", toolCalls: [{ id: "call_9f8e7d6c5b4a", name: "p__get", arguments: { url: "https://api.github.com/repos/o/r/issues?state=open&page=2&per_page=50", accept: "application/json" } }], usage: { inputTokens: 1234, outputTokens: 56, totalTokens: 1290 }, finishReason: "toolUse" } },
      { sequence: 3, kind: "tool.result", payload: { tool: "p__get", callId: "call_9f8e7d6c5b4a", isError: false, status: "succeeded", result: { sha: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", tree: "f6e612d13fdf9969186f7a9f5dbb4808252e00fc", body: "const token = getToken();\nif (!token) throw new Error('no token');\nconst MAX_KEY = 5;\nheaders.authorization = `Bearer ${token}`;\nexport KEY=$API_KEY\n" } } },
      { sequence: 4, kind: "tool.result", payload: { tool: "sandbox__run", result: { stdout: "ok 12 tests\nhttps://example.com/docs/auth#bearer\nbase64: " + b64("hello world, this is plain text") } } },
    ],
    byOp: { op_7: { state: "approved", approver: "user_123", tool: "github.create_issue", request: { title: "Fix token refresh", body: "steps: 1, 2, 3" } } },
  };
  const r = redactCredentials(ordinary);
  must(r.redactions === 0 && show(r.value) === show(ordinary), `ordinary text changed (${r.redactions}): ${show(r.value).slice(0, 600)}`);
});

await check("a walk survives what a hostile result can hold: deep nesting, a __proto__ key, keys that collide with a replacement, megabytes of text", () => {
  let deep: unknown = "sk-" + "c".repeat(40);
  for (let i = 0; i < 20_000; i++) deep = [deep];
  const d = redactCredentials(deep);
  must(d.redactions === 1 && !show(d.value).includes("c".repeat(40)), "deep arrays");
  let obj: unknown = "x";
  for (let i = 0; i < 5_000; i++) obj = { a: obj };
  must(redactCredentials(obj).redactions === 1, "deep objects");
  const proto = redactCredentials(JSON.parse('{"__proto__": {"x": "sk-' + "d".repeat(40) + '"}}'));
  must(show(proto.value) === '{"__proto__":{"x":"<redacted:api-key>"}}' && proto.redactions === 1, show(proto));
  const k = (c: string) => "sk-" + c.repeat(40);
  const coll = redactCredentials({ [k("a")]: 1, [k("b")]: 2, "<redacted:api-key>": 3 });
  must(Object.values(coll.value as object).sort().join() === "1,2,3" && coll.redactions === 2, show(coll));
  const t0 = Date.now();
  redactCredentials("a ".repeat(4_000_000));
  redactCredentials("x".repeat(8_000_000));
  must(Date.now() - t0 < 20_000, `16 MB of text took ${Date.now() - t0} ms`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
