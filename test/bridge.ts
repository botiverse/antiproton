/**
 * The gateway's half of the SDK bridge (botiverse/antiproton#1092): `<alias>.request` is one tool call through the
 * pipeline every tool call takes, classified on its route first. Asserted on outcomes — ran, awaiting approval,
 * refused and with which code, the operation rows and the approval request — with a fixture plugin whose table has
 * a listed write, a listed read, a body-dependent row and a refusal, and whose `send` records what reached it.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import type { BridgeDecl, BridgeRequest, Plugin, RouteEntry } from "../src/plugins/types.ts";
import type { MountPolicy } from "../src/core/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const caller = { tenantId: "t", agentId: "a", taskId: "k" };
const program = { fromProgram: true as const };

const ROUTES: RouteEntry[] = [
  { methods: ["POST"], path: /^\/v1\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/, refuse: "merging is refused on the bridge: call pr_merge" },
  { methods: ["POST"], path: /^\/v1\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/, body: (b) => String((b as any)?.event ?? "").toUpperCase() === "APPROVE", refuse: "approving is refused on the bridge: call pr_approve" },
  { methods: ["POST"], path: /^\/v1\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/, key: "pr_comment" },
  { methods: ["GET"], path: /^\/v1\/secret$/, key: "secret_read" },
];

function fixture(routes: RouteEntry[] = ROUTES, extra: Partial<Plugin> = {}) {
  const sent: BridgeRequest[] = [];
  const decl: BridgeDecl = {
    box: { files: { "index.js": "export default (f) => ({ svc: f });" }, entry: "index.js", exports: ["svc"] },
    routes,
    unlistedWriteKey: "svc.write",
    normalize: (p) => {
      if (p.startsWith("/v1/outside")) throw new Error("path must stay under the service's prefixes");
      return p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
    },
    describe: (p) => {
      const m = /^\/v1\/repos\/([^/]+\/[^/]+)(?:\/pulls\/(\d+))?/.exec(p);
      return m ? { repo: m[1], ...(m[2] ? { pr: Number(m[2]) } : {}) } : {};
    },
    responseHeaders: ["stamp-cli-*"],
    async send(_ctx, req) {
      sent.push(req);
      if (req.path === "/v1/boom") throw new Error("upstream unreachable");
      return {
        status: req.path === "/v1/missing" ? 404 : 200,
        headers: { "content-type": "application/json", "x-request-id": "rq", "stamp-cli-latest": "1.2.3", "set-cookie": "s=1" },
        text: JSON.stringify({ seen: req.path }),
      };
    },
  };
  const plugin: Plugin = {
    id: "svc", version: "1.0.0",
    tools: [
      { name: "pr_comment", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" },
      { name: "secret_read", summary: "", parameters: {}, sideEffects: "read", idempotency: "none" },
    ],
    defaultPolicy: { tools: { "svc.write": "approval" } },
    bridge: decl,
    async invoke() { throw new Error("a bridged request never reaches invoke"); },
    ...extra,
  };
  return { plugin, sent, decl };
}

async function gatewayWith(policy: MountPolicy | null, plugin: Plugin) {
  const path = join(mkdtempSync(join(tmpdir(), "bridge-")), "s.sqlite");
  const store = new SqliteStore(path);
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy,
  });
  const db = new DatabaseSync(path);
  const ops = () => db.prepare("SELECT operation_id, tool, status FROM operations").all() as Array<{ operation_id: string; tool: string; status: string }>;
  return { gw: new ToolGateway(store, [plugin], new Set(["svc"]), { async resolve() { return null; } }), store, ops };
}

const req = (method: string, path: string, body: string | null = null, headers: Record<string, string> = {}) => ({ method, path, body, headers });

await check("an unlisted write is held, even with write: allow and the request tool allowed", async () => {
  const f = fixture();
  const { gw, store } = await gatewayWith({ write: "allow", tools: { request: "allow" } }, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/labels", '{"name":"x"}'), program);
  must(r.status === "pending" && r.error?.code === "awaiting_approval", `an unlisted write was not held: ${JSON.stringify(r)}`);
  must(f.sent.length === 0, "a held request reached send");
  const a = await store.listApprovals("t", "pending");
  must(a.length === 1 && (a[0]!.request as any).policyKey === "svc.write", `the hold does not name the unlisted-write key: ${JSON.stringify(a.map((x) => x.request))}`);
});

await check("an unlisted write is held for a plugin whose defaultPolicy forgot the unlisted-write key", async () => {
  const f = fixture(ROUTES, { defaultPolicy: undefined });
  const { gw } = await gatewayWith({ write: "allow", tools: { request: "allow" } }, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("DELETE", "/v1/repos/o/r"), program);
  must(r.status === "pending" && f.sent.length === 0, `an unlisted write ran with no default: ${JSON.stringify(r)}`);
});

await check("an unlisted write runs once the mount allows both the request tool and the unlisted-write key", async () => {
  const f = fixture();
  const { gw } = await gatewayWith({ tools: { request: "allow", "svc.write": "allow" } }, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/labels", "{}"), program);
  must(r.status === "succeeded" && f.sent.length === 1, `it did not run: ${JSON.stringify(r)}`);
});

await check("an unlisted GET follows the mount's read policy: free by default, held where reads are", async () => {
  const f = fixture();
  const free = await gatewayWith(null, f.plugin);
  const r1: any = await free.gw.invoke(caller, "svc.request", req("GET", "/v1/repos/o/r"), program);
  must(r1.status === "succeeded" && f.sent.length === 1, `an unlisted read was not free: ${JSON.stringify(r1)}`);
  const held = await gatewayWith({ read: "approval" }, f.plugin);
  const r2: any = await held.gw.invoke(caller, "svc.request", req("GET", "/v1/repos/o/r"), program);
  must(r2.status === "pending", `read: approval did not hold an unlisted read: ${JSON.stringify(r2)}`);
  const denied = await gatewayWith({ read: "deny" }, f.plugin);
  const r3: any = await denied.gw.invoke(caller, "svc.request", req("HEAD", "/v1/repos/o/r"), program);
  must(r3.status === "rejected" && r3.error?.code === "policy_denied", `read: deny did not refuse an unlisted HEAD: ${JSON.stringify(r3)}`);
});

await check("a listed route is decided under its key and the request tool, the stricter: the tool's deny on pr_comment holds on the bridge", async () => {
  const f = fixture();
  const denied = await gatewayWith({ tools: { request: "allow", pr_comment: "deny" } }, f.plugin);
  const r1: any = await denied.gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/comments", "{}"), program);
  must(r1.status === "rejected" && r1.error?.code === "policy_denied", `pr_comment: deny was bypassed on the bridge: ${JSON.stringify(r1)}`);
  const allowed = await gatewayWith({ tools: { request: "allow", pr_comment: "allow" } }, f.plugin);
  const r2: any = await allowed.gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/comments", "{}"), program);
  must(r2.status === "succeeded", `both allowed and it did not run: ${JSON.stringify(r2)}`);
  const readKey = await gatewayWith({ tools: { secret_read: "approval" } }, f.plugin);
  const r3: any = await readKey.gw.invoke(caller, "svc.request", req("GET", "/v1/secret"), program);
  must(r3.status === "pending", `a listed read's key did not hold it: ${JSON.stringify(r3)}`);
});

await check("a refused route ends rejected before any verdict, with one operation row, even where every key is allowed", async () => {
  const f = fixture();
  const { gw, ops } = await gatewayWith({ write: "allow", tools: { request: "allow", "svc.write": "allow" } }, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/merge/"), program);
  must(r.status === "rejected" && r.error?.code === "route_refused" && /pr_merge/.test(r.error.message), `a merge was not refused: ${JSON.stringify(r)}`);
  const approve: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/reviews", '{"event":"approve"}'), program);
  must(approve.status === "rejected" && approve.error?.code === "route_refused" && /pr_approve/.test(approve.error.message), `an approval review was not refused: ${JSON.stringify(approve)}`);
  const comment: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/reviews", '{"event":"COMMENT"}'), program);
  must(comment.status === "succeeded", `a comment review was refused or held: ${JSON.stringify(comment)}`);
  must(f.sent.length === 1, `${f.sent.length} requests reached send; only the comment review should`);
  const rows = ops();
  must(rows.length === 3 && rows.filter((o) => o.status === "rejected").length === 2 && rows.every((o) => o.tool === "svc.request"),
    `operations: ${JSON.stringify(rows)}`);
});

// Every spelling of a refused route that upstream would route the same way meets the refusal, or is refused as a
// path, whatever the plugin's own normalize does: here the fixture has none, so the core's rules alone decide.
const MERGE_SPELLINGS: Array<[string, string]> = [
  ["/v1/repos/o/r/pulls/7/merge?x=1", "route_refused"],
  ["/v1/repos/o/r/pulls/7/merge#", "route_refused"],
  ["/v1/repos/o/r/pulls/7/MERGE/", "route_refused"],
  ["/v1/repos/o/r/pulls/7/%6Derge", "bad_request"],
  ["/v1/repos/o/r/pulls/7/merge/.", "bad_request"],
  ["/v1/repos/o/r/pulls/7//merge", "bad_request"],
  ["/v1/repos/o/r/pulls/7/m%65rge?x", "bad_request"],
];
const OPEN: MountPolicy = { write: "allow", tools: { request: "allow", "svc.write": "allow", pr_comment: "allow" } };

for (const [path, code] of MERGE_SPELLINGS) {
  await check(`a merge spelled ${path} does not run where unlisted writes are allowed: ${code}`, async () => {
    const f = fixture();
    f.decl.normalize = undefined;
    const { gw, ops } = await gatewayWith(OPEN, f.plugin);
    const r: any = await gw.invoke(caller, "svc.request", req("POST", path), program);
    must(r.status === "rejected" && r.error?.code === code, `it was not refused as ${code}: ${JSON.stringify(r)}`);
    must(f.sent.length === 0 && ops().length === 1 && ops()[0]!.status === "rejected", `it reached send, or its row: ${JSON.stringify(ops())}`);
  });
  await check(`a merge spelled ${path}, held before and approved, is refused on the replay: ${code}`, async () => {
    const f = fixture();
    f.decl.normalize = undefined;
    const { gw, store } = await gatewayWith(OPEN, f.plugin);
    // A held request as an earlier table would have left it: the replay runs today's rules, not the hold's.
    await store.requireApproval({
      tenantId: "t", operationId: `op_held_${code}`, agentId: "a", taskId: "k", mountAlias: "svc", tool: "request",
      request: { tool: "svc.request", args: req("POST", path) as any, heldBy: "policy" },
    });
    const done: any = await gw.applyApproval("t", `op_held_${code}`, "approved", "person");
    must(done.ok && done.result?.status === "rejected" && done.result.error?.code === code, `the replay was not refused: ${JSON.stringify(done)}`);
    must(f.sent.length === 0, "the replay reached send");
  });
}

await check("a path that could leave the origin is refused before anything: //host, a backslash, whitespace", async () => {
  const f = fixture();
  f.decl.normalize = undefined;
  const { gw } = await gatewayWith(OPEN, f.plugin);
  // Each refused by the rule meant for it, not by another that happens to catch it too (`//host` is an empty segment).
  const cases: Array<[string, RegExp]> = [["//evil.com/x", /names no host/], ["/\\evil.com/x", /backslash/], ["/v1/a b", /whitespace/],
    ["/v1/a\tb", /whitespace/], ["/v1/a\u0000", /control/]];
  for (const [path, why] of cases) {
    const r: any = await gw.invoke(caller, "svc.request", req("GET", path), program);
    must(r.status === "rejected" && r.error?.code === "bad_request" && why.test(r.error.message),
      `${JSON.stringify(path)} was not refused for ${why}: ${JSON.stringify(r)}`);
  }
  must(f.sent.length === 0, `${f.sent.length} reached send`);
});

await check("send gets the query but never the fragment, and a GET or HEAD no body", async () => {
  const f = fixture();
  f.decl.normalize = undefined;
  const { gw } = await gatewayWith(null, f.plugin);
  await gw.invoke(caller, "svc.request", req("GET", "/v1/repos/o/r/issues?page=2#top", "a body"), program);
  await gw.invoke(caller, "svc.request", req("HEAD", "/v1/repos/o/r", "a body"), program);
  must(f.sent.length === 2 && f.sent[0]!.path === "/v1/repos/o/r/issues?page=2" && f.sent[0]!.body === null && f.sent[1]!.body === null,
    `send was handed ${JSON.stringify(f.sent)}`);
});

await check("the request tool's own deny holds though the route's key allows: stricter, not the key alone", async () => {
  const f = fixture();
  const { gw } = await gatewayWith({ tools: { request: "deny", pr_comment: "allow" } }, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/comments", "{}"), program);
  must(r.status === "rejected" && r.error?.code === "policy_denied" && f.sent.length === 0, `request: deny was lifted by the key: ${JSON.stringify(r)}`);
});

await check("a refused route is refused on an approved replay too", async () => {
  const routes = [...ROUTES];
  const f = fixture(routes);
  const { gw } = await gatewayWith(null, f.plugin);
  const held: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/close"), program);
  must(held.status === "pending", `not held: ${JSON.stringify(held)}`);
  // The table now refuses what was held: the replay runs the table again, and a person's approval does not lift it.
  routes.unshift({ methods: ["POST"], path: /\/close$/, refuse: "closing is refused" });
  const done: any = await gw.applyApproval("t", held.operationId, "approved", "person");
  must(done.ok && done.result?.status === "rejected" && done.result.error?.code === "route_refused", `the replay was not refused: ${JSON.stringify(done)}`);
  must(f.sent.length === 0, "the refused replay reached send");
});

await check("an approved replay of a held write runs it once", async () => {
  const f = fixture();
  const { gw, ops } = await gatewayWith(null, f.plugin);
  const held: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/labels", "{}"), program);
  const done: any = await gw.applyApproval("t", held.operationId, "approved", "person");
  must(done.ok && done.result?.status === "succeeded" && f.sent.length === 1, `the replay did not run once: ${JSON.stringify(done)}`);
  must(ops().length === 1 && ops()[0]!.status === "succeeded", `operations: ${JSON.stringify(ops())}`);
});

await check("only content-type and accept reach send; the plugin's response headers are filtered to what the box may read", async () => {
  const f = fixture();
  const { gw } = await gatewayWith(null, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/missing", null,
    { Authorization: "Bearer box", "Content-Type": "application/json", accept: "application/json", cookie: "c=1", "x-forwarded-for": "1.2.3.4" }), program);
  must(JSON.stringify(f.sent[0]?.headers) === '{"content-type":"application/json","accept":"application/json"}',
    `send was handed ${JSON.stringify(f.sent[0]?.headers)}`);
  must(r.status === "succeeded", `an upstream 404 is not a successful tool result: ${JSON.stringify(r)}`);
  must(r.result.status === 404 && r.result.text === '{"seen":"/v1/missing"}', `the answer: ${JSON.stringify(r.result)}`);
  must(JSON.stringify(Object.keys(r.result.headers).sort()) === '["content-type","stamp-cli-latest","x-request-id"]',
    `the box would read headers ${JSON.stringify(r.result.headers)}`);
});

await check("a send that throws is a failed call; a path normalize refuses is rejected with its row", async () => {
  const f = fixture();
  const { gw, ops } = await gatewayWith(null, f.plugin);
  const r1: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/boom"), program);
  must(r1.status === "failed", `a throwing send: ${JSON.stringify(r1)}`);
  const r2: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/outside/b"), program);
  must(r2.status === "rejected" && r2.error?.code === "bad_request" && /prefixes/.test(r2.error.message), `a path normalize refuses: ${JSON.stringify(r2)}`);
  must(ops().length === 2, `operations: ${JSON.stringify(ops())}`);
});

await check("the model cannot call <alias>.request itself: refused before an operation exists", async () => {
  const f = fixture();
  const { gw, ops } = await gatewayWith({ tools: { request: "allow" } }, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/repos/o/r"));
  must(r.status === "rejected" && r.error?.code === "program_only", `a model call was not refused: ${JSON.stringify(r)}`);
  must(f.sent.length === 0 && ops().length === 0, "it reached send or left an operation");
});

await check("one bridged request is one operation, recorded under the plugin's request tool", async () => {
  const f = fixture();
  const { gw, ops } = await gatewayWith(null, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/repos/o/r"), { ...program, callId: "toolu_1" });
  must(r.status === "succeeded", `not run: ${JSON.stringify(r)}`);
  const rows = ops();
  must(rows.length === 1 && rows[0]!.operation_id === r.operationId && rows[0]!.tool === "svc.request" && rows[0]!.status === "succeeded",
    `operations: ${JSON.stringify(rows)}`);
});

await check("the approval request carries the route — method, path, repo, PR — the policy key, and a long body cut at 2 KiB with its size", async () => {
  const f = fixture();
  const { gw, store } = await gatewayWith(null, f.plugin);
  const long = JSON.stringify({ text: "x".repeat(5000) });
  await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/12/labels", long), program);
  await gw.invoke(caller, "svc.request", req("PUT", "/v1/other", "short"), program);
  const [a, b] = (await store.listApprovals("t", "pending")).map((x) => x.request as any);
  const first = [a, b].find((x) => x.route.path.includes("/pulls/"))!, second = [a, b].find((x) => x !== first)!;
  must(first.policyKey === "svc.write" && first.route.method === "POST" && first.route.path === "/v1/repos/o/r/pulls/12/labels"
    && first.route.repo === "o/r" && first.route.pr === 12, `route: ${JSON.stringify({ ...first.route, body: undefined })}`);
  must(first.route.body.length === 2048 && first.route.bodyTruncated === true && first.route.bodySize === long.length,
    `the body was not cut and sized: ${first.route.body.length} ${first.route.bodyTruncated} ${first.route.bodySize}`);
  must(second.route.body === "short" && second.route.bodyTruncated === undefined && second.route.repo === undefined && second.route.pr === undefined,
    `a short body or a path describe names nothing: ${JSON.stringify(second.route)}`);
});

await check("registration refuses a bridge beside a tool of its own named request, and an unlisted-write key that is a tool's name", async () => {
  const own = fixture(ROUTES, { tools: [{ name: "request", summary: "", parameters: {}, sideEffects: "write", idempotency: "none" }] });
  let threw = "";
  try { await gatewayWith(null, own.plugin); } catch (e) { threw = String((e as Error).message); }
  must(/reserves that name/.test(threw), `a plugin with its own request tool was accepted: ${threw}`);
  const clash = fixture();
  clash.decl.unlistedWriteKey = "pr_comment";
  threw = "";
  try { await gatewayWith(null, clash.plugin); } catch (e) { threw = String((e as Error).message); }
  must(/not a tool's name/.test(threw), `an unlisted-write key naming a tool was accepted: ${threw}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
