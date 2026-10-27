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
import { ToolGateway, redactedError } from "../src/runtime/gateway.ts";
import type { BridgeDecl, BridgeRequest, BridgeResponse, Plugin, RouteEntry } from "../src/plugins/types.ts";
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
  // As upstream reads it: the key `event` in any case, the value in any case.
  { methods: ["POST"], path: /^\/v1\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/,
    body: (b) => Object.entries(b ?? {}).some(([k, v]) => k.toLowerCase() === "event" && String(v).toUpperCase() === "APPROVE"),
    refuse: "approving is refused on the bridge: call pr_approve" },
  // Any other review is a comment: the looser row a body the predicate above could not read must not fall through to.
  { methods: ["POST"], path: /^\/v1\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/, key: "pr_comment" },
  { methods: ["POST"], path: /^\/v1\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/comments$/, key: "pr_comment" },
  { methods: ["GET"], path: /^\/v1\/secret$/, key: "secret_read" },
  // A key row with a body check: a draft is a comment, allowed where comments are.
  { methods: ["POST"], path: /^\/v1\/drafts$/, body: (b) => b?.draft === true, key: "pr_comment" },
];

const STORED = "stored-credential-abcdef";
const MINTED = "minted-token-1234567";

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
    responseHeaders: ["stamp-cli-latest"],
    async send(ctx, req, io): Promise<BridgeResponse> {
      sent.push(req);
      // A send that fails after it minted a token from the stored session, quoting both back.
      if (req.path.startsWith("/v1/throw")) {
        const session = (() => { try { return JSON.parse(ctx.credential ?? ""); } catch { return null; } })();
        const shown = session?.access_token ?? ctx.credential;
        io.used(MINTED);
        const said = `upstream said: bad token ${shown} and ${MINTED}`;
        if (req.path === "/v1/throw-string") throw said;
        const e = new Error(said) as Error & { code?: string };
        e.code = `E_${MINTED}`;
        e.stack = `Error: ${said}\n    at send (${ctx.credential})`;
        throw e;
      }
      if (req.path === "/v1/boom") throw new Error("upstream unreachable");
      // An upstream that echoes what it was sent: the stored credential, and a token minted from it for this request.
      if (req.path === "/v1/echo") {
        return {
          status: 401, text: `bad token ${ctx.credential} or ${MINTED}`, secrets: [MINTED],
          headers: { "content-type": "text/plain", "x-request-id": `rq ${MINTED}`, authorization: `Bearer ${MINTED}`, "www-authenticate": "Bearer" },
        };
      }
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

async function gatewayWith(policy: MountPolicy | null, plugin: Plugin, opts: { credential?: string } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "bridge-")), "s.sqlite");
  const store = new SqliteStore(path);
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: opts.credential ? "env:SVC_TOKEN" : null, policy,
  });
  const db = new DatabaseSync(path);
  // Every row of every table, as text: what a store or trace kept of a call.
  const everything = () => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
  const ops = () => db.prepare("SELECT operation_id, tool, status FROM operations").all() as Array<{ operation_id: string; tool: string; status: string }>;
  const secrets = { async resolve() { return opts.credential ?? null; } };
  return { gw: new ToolGateway(store, [plugin], new Set(["svc"]), secrets), store, ops, everything };
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
  const comment: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/reviews", '{"event":"COMMENT"}', { "content-type": "application/json" }), program);
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
  const { gw, ops } = await gatewayWith(null, f.plugin);
  const held: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/close"), program);
  must(held.status === "pending", `not held: ${JSON.stringify(held)}`);
  // The table now refuses what was held: the replay runs the table again, and a person's approval does not lift it.
  routes.unshift({ methods: ["POST"], path: /\/close$/, refuse: "closing is refused" });
  const done: any = await gw.applyApproval("t", held.operationId, "approved", "person");
  must(done.ok && done.result?.status === "rejected" && done.result.error?.code === "route_refused", `the replay was not refused: ${JSON.stringify(done)}`);
  must(f.sent.length === 0, "the refused replay reached send");
  must(ops().length === 1 && ops()[0]!.status === "rejected", `the refused replay is not recorded as rejected: ${JSON.stringify(ops())}`);
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

await check("confirm never lifts a deny: request: deny, or the route key's deny, with confirm is refused, not carded", async () => {
  for (const policy of [{ tools: { request: "deny" as const, pr_comment: "allow" as const } }, { tools: { request: "allow" as const, pr_comment: "deny" as const } }]) {
    const f = fixture();
    const { gw, store } = await gatewayWith(policy, f.plugin);
    const r: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/comments", "{}"), { ...program, confirm: true });
    must(r.status === "rejected" && r.error?.code === "policy_denied", `${JSON.stringify(policy)} + confirm: ${JSON.stringify(r)}`);
    must((await store.listApprovals("t", "pending")).length === 0 && f.sent.length === 0, "a card was made, or it ran");
  }
  const f = fixture();
  const { gw } = await gatewayWith({ tools: { request: "allow", pr_comment: "allow" } }, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/comments", "{}"), { ...program, confirm: true });
  must(r.status === "pending" && f.sent.length === 0, `allow + confirm is not a card: ${JSON.stringify(r)}`);
});

// A refuse row with a body check refuses any body it cannot read as a JSON object: holding it instead would let a
// mount that allows unlisted writes run it, and skipping it would reach the comment row, which this mount allows.
const COMMENTS_OPEN: MountPolicy = { tools: { request: "allow", pr_comment: "allow" } };
for (const [what, body, expect] of [
  ["a byte-order mark before the JSON", '\uFEFF{"event":"APPROVE"}', "refused"],
  ["a form-encoded body", "event=APPROVE", "refused"],
  ["a JSON array", '[{"event":"APPROVE"}]', "refused"],
  ["a bare JSON string", '"APPROVE"', "refused"],
  ["the key spelled Event", '{"Event":"APPROVE"}', "refused"],
  ["a comment review", '{"event":"COMMENT"}', "ran"],
] as const) {
  await check(`a review with ${what} where comments are allowed: ${expect}`, async () => {
    const f = fixture();
    const { gw } = await gatewayWith(COMMENTS_OPEN, f.plugin);
    const r: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/pulls/7/reviews", body, { "content-type": "application/json" }), program);
    const got = r.status === "pending" ? "pending" : r.error?.code === "route_refused" ? "refused" : r.status === "succeeded" ? "ran" : JSON.stringify(r);
    must(got === expect, `expected ${expect}, got ${got}`);
    must((expect === "ran") === (f.sent.length === 1), `send was reached ${f.sent.length} times`);
  });
}

// How the body was sent decides whether a row's "not this row" can be trusted: upstream reads a body that is not
// sent as JSON its own way.
for (const [what, contentType, body, expect] of [
  ["a comment review sent as text/plain", "text/plain", '{"event":"COMMENT"}', "refused"],
  ["a comment review with no content-type", null, '{"event":"COMMENT"}', "refused"],
  ["a comment review sent as form data", "application/x-www-form-urlencoded", '{"event":"COMMENT"}', "refused"],
  ["an approval review sent as text/plain", "text/plain", '{"event":"APPROVE"}', "refused"],
  ["a comment review sent as a +json type with a charset", "application/vnd.api+json; charset=utf-8", '{"event":"COMMENT"}', "ran"],
] as const) {
  await check(`${what} where comments are allowed: ${expect}`, async () => {
    const f = fixture();
    const { gw } = await gatewayWith(COMMENTS_OPEN, f.plugin);
    const r: any = await gw.invoke(caller, "svc.request",
      req("POST", "/v1/repos/o/r/pulls/7/reviews", body, contentType ? { "content-type": contentType } : {}), program);
    const got = r.status === "pending" ? "pending" : r.error?.code === "route_refused" ? "refused" : r.status === "succeeded" ? "ran" : JSON.stringify(r);
    must(got === expect, `expected ${expect}, got ${got}`);
  });
}

// An approval sent every way upstream might read it, on a mount where every unlisted write runs: none reaches send.
for (const [what, contentType, body] of [
  ["as JSON", "application/json", '{"event":"APPROVE"}'],
  ["form-encoded", "application/x-www-form-urlencoded", "event=APPROVE"],
  ["with no content-type", null, "event=APPROVE"],
  ["as JSON labelled text/plain", "text/plain", '{"event":"APPROVE"}'],
] as const) {
  for (const [mount, policy] of [["a default mount", null], ["a mount that allows unlisted writes", OPEN]] as const) {
  await check(`an approval review ${what}, on ${mount}, is refused (not held) and never sent`, async () => {
    const f = fixture();
    const { gw } = await gatewayWith(policy, f.plugin);
    const r: any = await gw.invoke(caller, "svc.request",
      req("POST", "/v1/repos/o/r/pulls/7/reviews", body, contentType ? { "content-type": contentType } : {}), program);
    must(r.status === "rejected" && r.error?.code === "route_refused", `it was not refused: ${JSON.stringify(r)}`);
    must(f.sent.length === 0, "it reached send");
  });
  }
}

await check("a key row with a body check applies to JSON sent as JSON, and holds the same body sent as text/plain", async () => {
  const f = fixture();
  const { gw } = await gatewayWith(COMMENTS_OPEN, f.plugin);
  const json: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/drafts", '{"draft":true}', { "content-type": "application/json" }), program);
  must(json.status === "succeeded" && f.sent.length === 1, `the key did not apply to JSON: ${JSON.stringify(json)}`);
  const text: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/drafts", '{"draft":true}', { "content-type": "text/plain" }), program);
  must(text.status === "pending" && f.sent.length === 1, `text/plain was not held: ${JSON.stringify(text)}`);
});

await check("two secrets that overlap in the text are both redacted, and a secret is redacted as a JSON string shows it", async () => {
  const f = fixture();
  const quoted = 'pa"ss\\word-123';
  f.decl.send = async (_ctx, req, io) => {
    io.used("AAAAAAAAbbbb"); io.used("bbbbCCCCCCCC"); io.used(quoted);
    return { status: 200, headers: {}, text: req.path === "/v1/a" ? "x AAAAAAAAbbbbCCCCCCCC y" : JSON.stringify({ t: quoted }) };
  };
  const { gw } = await gatewayWith(null, f.plugin);
  const a: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/a"), program);
  must(a.result.text === "x [redacted] y", `overlap: ${JSON.stringify(a.result.text)}`);
  const b: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/b"), program);
  must(b.result.text === '{"t":"[redacted]"}', `JSON-escaped: ${JSON.stringify(b.result.text)}`);
});

for (const [what, thrown] of [
  ["a message getter that throws", () => ({ get message(): string { throw new Error(`getter saw ${STORED}`); }, toString() { return `obj ${STORED}`; } })],
  ["a toString that throws", () => ({ toString(): string { throw new Error(`toString saw ${STORED}`); } })],
  ["an Error whose message getter throws", () => { const e = new Error("x"); Object.defineProperty(e, "message", { get() { throw new Error(`getter saw ${STORED}`); } }); return e; }],
] as const) {
  await check(`a send that throws a value with ${what}: the credential reaches neither the result nor the store`, async () => {
    const f = fixture();
    f.decl.send = async () => { throw thrown(); };
    const { gw, everything } = await gatewayWith(null, f.plugin, { credential: STORED });
    let r: any;
    try { r = await gw.invoke(caller, "svc.request", req("GET", "/v1/x"), program); } catch (e) { throw new Error(`it escaped the gateway: ${String((e as Error)?.message)}`); }
    must(r.status === "failed", `the call reads ${JSON.stringify(r)}`);
    must(!(JSON.stringify(r) + everything()).includes(STORED), "the credential reached the result or the store");
  });
}

await check("a JSON answer that spells a secret with escapes, as a value or a key, holds none once the box parses it", async () => {
  const f = fixture();
  const secret = "abcdefgh/1234/ijkl";
  f.decl.send = async (_ctx, _req, io) => {
    io.used(secret);
    return { status: 200, headers: { "content-type": "application/json; charset=utf-8" },
      text: '{"token":"abcdefgh\\/1234\\/ijkl","k":"\\u0061bcdefgh/1234/ijkl","abcdefgh\\/1234\\/ijkl":1,"n":[1.50]}' };
  };
  const { gw } = await gatewayWith(null, f.plugin);
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/x"), program);
  must(!r.result.text.includes("\\/1234"), `the escaped spelling was handed over: ${r.result.text}`);
  const parsed = JSON.parse(r.result.text);
  must(!JSON.stringify(parsed).includes(secret) && parsed.token === "[redacted]" && parsed.k === "[redacted]" && parsed["[redacted]"] === 1,
    `after parsing: ${JSON.stringify(parsed)}`);
});

await check("a JSON answer that does not parse, and a text answer, are redacted as they stand", async () => {
  const f = fixture();
  f.decl.send = async (_ctx, req) => ({ status: 200, headers: { "content-type": req.path === "/v1/a" ? "application/json" : "text/plain" },
    text: `{"broken": "${STORED}` });
  const { gw } = await gatewayWith(null, f.plugin, { credential: STORED });
  for (const path of ["/v1/a", "/v1/b"]) {
    const r: any = await gw.invoke(caller, "svc.request", req("GET", path), program);
    must(r.result.text === '{"broken": "[redacted]', `${path}: ${JSON.stringify(r.result.text)}`);
  }
});

await check("an error whose message cannot be read leaves only a fixed sentence: no original message, no original field", async () => {
  const f = fixture();
  f.decl.send = async () => {
    const e = Object.assign(new Error("x"), { code: "ORIG_CODE", httpStatus: 418, detail: "ORIG_DETAIL" });
    Object.defineProperty(e, "message", { get() { throw new Error(`ORIG_GETTER saw ${STORED}`); } });
    throw e;
  };
  const { gw, everything } = await gatewayWith(null, f.plugin, { credential: STORED });
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/x"), program);
  must(r.status === "failed" && r.error?.message === "the request failed, and its error could not be read", `the call reads ${JSON.stringify(r)}`);
  const kept = JSON.stringify(r) + everything();
  must(!/ORIG_|\\?"httpStatus\\?":418/.test(kept) && !kept.includes(STORED), `an original field or the message reached the record: ${kept.match(/.{40}(ORIG_|httpStatus).{40}/)?.[0]}`);
});

await check("a secret that begins with another is redacted whole, longest first", async () => {
  const f = fixture();
  const longer = "prefix-token-1-extended-XYZ";
  f.decl.send = async (_ctx, _req, io) => { io.used(longer); return { status: 200, headers: {}, text: `echo ${longer}` }; };
  const { gw } = await gatewayWith(null, f.plugin, { credential: "prefix-token-1" });
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/x"), program);
  must(r.result.text === "echo [redacted]", `the longer secret's rest was handed over: ${JSON.stringify(r.result.text)}`);
});

await check("registration refuses a defaultPolicy decision that is not allow, approval or deny", async () => {
  for (const defaultPolicy of [{ tools: { "svc.write": "alow" } }, { write: "Deny" }]) {
    const f = fixture(ROUTES, { defaultPolicy: defaultPolicy as any });
    let threw = "";
    try { await gatewayWith(null, f.plugin); } catch (e) { threw = String((e as Error).message); }
    must(/a decision is allow, approval or deny/.test(threw), `${JSON.stringify(defaultPolicy)} was accepted: ${threw}`);
  }
});

await check("the body cap counts UTF-8 bytes: a CJK body of a third of a MiB in characters is past it", async () => {
  const f = fixture();
  const { gw, store } = await gatewayWith(null, f.plugin);
  const over: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/x", "\u4e2d".repeat(349526)), program);
  must(over.status === "rejected" && over.error?.code === "bad_request" && /bytes as UTF-8, got 1048578/.test(over.error.message),
    `a 1048578-byte body was taken: ${JSON.stringify(over).slice(0, 200)}`);
  const under: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/x", "\u4e2d".repeat(349525)), program);
  must(under.status === "pending", `a 1048575-byte body was refused: ${JSON.stringify(under).slice(0, 200)}`);
  must((await store.listApprovals("t", "pending")).length === 1, "the refused body was carded");
});

await check("the mount's credential and a token minted for the request never reach the box: text and header values redacted", async () => {
  const f = fixture();
  const { gw } = await gatewayWith(null, f.plugin, { credential: STORED });
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/echo"), program);
  must(r.status === "succeeded" && r.result.status === 401, `not answered: ${JSON.stringify(r)}`);
  const seen = JSON.stringify(r.result);
  must(!seen.includes(STORED) && !seen.includes(MINTED), `a credential reached the box: ${seen}`);
  must(r.result.text === "bad token [redacted] or [redacted]" && r.result.headers["x-request-id"] === "rq [redacted]", `redaction: ${seen}`);
  must(!("authorization" in r.result.headers) && !("www-authenticate" in r.result.headers), `credential headers reached the box: ${seen}`);
});

const SESSION = JSON.stringify({ access_token: "access-abcdefgh123", refresh_token: "refresh-ijklmnop456", expires: 3600 });
for (const [label, credential, hidden] of [
  ["a bare stored token", STORED, [STORED, MINTED]],
  ["a stored JSON session", SESSION, ["access-abcdefgh123", "refresh-ijklmnop456", MINTED]],
] as const) {
  for (const path of ["/v1/throw", "/v1/throw-string"]) {
    await check(`a send that throws (${path}) with ${label} and a token it registered: neither reaches the result, the store or the trace`, async () => {
      const f = fixture();
      const { gw, everything } = await gatewayWith(null, f.plugin, { credential });
      const r: any = await gw.invoke(caller, "svc.request", req("GET", path), program);
      must(r.status === "failed" && /^upstream said: bad token \[redacted\] and \[redacted\]$/.test(r.error?.message ?? ""),
        `the failure reads ${JSON.stringify(r)}`);
      const kept = JSON.stringify(r) + "\n" + everything();
      for (const x of hidden) must(!kept.includes(x), `${x} reached the result, the store or the trace`);
      // The trace applies its own redaction on top (a token after "token" reads `<redacted>` there); either marker will do.
      must(/upstream said: bad token [<[]redacted[>\]] and [<[]redacted[>\]]/.test(everything()), "the redacted failure is not on the record");
      // The error the gateway hands on in place of the plugin's carries nothing else of it: no field, however named.
      const original = Object.assign(new Error(`bad ${credential}`), { code: "E", httpStatus: 500, retryable: true, original: credential, extra: { credential } });
      const own = Object.getOwnPropertyNames(redactedError(original, [credential]));
      must(own.every((k) => ["message", "name", "stack", "code", "httpStatus", "retryable"].includes(k)), `the error carries ${JSON.stringify(own)}`);
    });
  }
}

await check("a stored JSON session's fields are redacted from an answer, not only the whole record", async () => {
  const f = fixture();
  f.decl.send = async (ctx) => ({ status: 200, headers: { "x-request-id": "refresh-ijklmnop456" }, text: `token access-abcdefgh123 of ${ctx.credential}` });
  const { gw } = await gatewayWith(null, f.plugin, { credential: SESSION });
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/x"), program);
  must(r.result.text === "token [redacted] of [redacted]" && r.result.headers["x-request-id"] === "[redacted]", `answer: ${JSON.stringify(r.result)}`);
});

await check("a credential header is dropped at the answer too, not only at registration: a list changed afterwards", async () => {
  const f = fixture();
  const { gw } = await gatewayWith(null, f.plugin, { credential: STORED });
  // The declaration is a plain object; registration read it once, and the answer is filtered on what it says now.
  f.decl.responseHeaders = ["stamp-cli-latest", "authorization", "www-authenticate"];
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/echo"), program);
  must(!("authorization" in r.result.headers) && !("www-authenticate" in r.result.headers), `credential headers reached the box: ${JSON.stringify(r.result.headers)}`);
});

await check("registration refuses a response-header pattern and a credential header, even listed by name", async () => {
  for (const names of [["stamp-cli-*"], ["set-cookie"], ["Authorization"]]) {
    const f = fixture();
    f.decl.responseHeaders = names;
    let threw = "";
    try { await gatewayWith(null, f.plugin); } catch (e) { threw = String((e as Error).message); }
    must(/exact header names only/.test(threw), `${JSON.stringify(names)} was accepted: ${threw}`);
  }
});

await check("a path with ; or a character outside ASCII is refused", async () => {
  const f = fixture();
  f.decl.normalize = undefined;
  const { gw } = await gatewayWith(OPEN, f.plugin);
  for (const path of ["/v1/repos/o/r/pulls/7/merge;x", "/v1/repos/o/r/pulls/7/\uFF4Derge", "/v1/caf\u00e9"]) {
    const r: any = await gw.invoke(caller, "svc.request", req("POST", path), program);
    must(r.status === "rejected" && r.error?.code === "bad_request" && /outside printable ASCII/.test(r.error.message), `${path}: ${JSON.stringify(r)}`);
  }
  must(f.sent.length === 0, "one reached send");
});

await check("a query may carry ; and characters outside ASCII: it takes no part in routing, and reaches send as sent", async () => {
  const f = fixture();
  f.decl.normalize = undefined;
  const { gw } = await gatewayWith(null, f.plugin);
  for (const path of ["/v1/search?q=a;b", "/v1/search?q=a&sort=desc;x", "/v1/search?q=caf\u00e9"]) {
    const r: any = await gw.invoke(caller, "svc.request", req("GET", path), program);
    must(r.status === "succeeded", `${path}: ${JSON.stringify(r)}`);
  }
  must(JSON.stringify(f.sent.map((x) => x.path)) === JSON.stringify(["/v1/search?q=a;b", "/v1/search?q=a&sort=desc;x", "/v1/search?q=caf\u00e9"]),
    `send was handed ${JSON.stringify(f.sent.map((x) => x.path))}`);
  const r: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/search?q=a b"), program);
  must(r.status === "rejected" && r.error?.code === "bad_request", `whitespace in a query was taken: ${JSON.stringify(r)}`);
});

await check("a header with CR or LF, a path past 2048 characters and a body past 1 MiB are refused, and no card keeps them", async () => {
  const f = fixture();
  const { gw, store, ops } = await gatewayWith(null, f.plugin);
  const cases: Array<[ReturnType<typeof req>, RegExp]> = [
    [req("POST", "/v1/x", "{}", { "content-type": "application/json\r\nX-Evil: 1" }), /printable ASCII/],
    [req("GET", "/v1/" + "a".repeat(2045)), /at most 2048/],
    [req("POST", "/v1/x", "x".repeat(1024 * 1024 + 1)), /at most 1048576/],
  ];
  for (const [r0, why] of cases) {
    const r: any = await gw.invoke(caller, "svc.request", r0, program);
    must(r.status === "rejected" && r.error?.code === "bad_request" && why.test(r.error.message), `${why}: ${JSON.stringify(r).slice(0, 300)}`);
  }
  must((await store.listApprovals("t", "pending")).length === 0 && f.sent.length === 0, "a refused request was carded or sent");
  must(ops().length === 3 && ops().every((o) => o.status === "rejected"), `operations: ${JSON.stringify(ops())}`);
  const atCap: any = await gw.invoke(caller, "svc.request", req("POST", "/v1/x", "x".repeat(1024 * 1024)), program);
  must(atCap.status === "pending", `a body at the cap was not taken: ${JSON.stringify(atCap).slice(0, 200)}`);
  const pathAtCap: any = await gw.invoke(caller, "svc.request", req("GET", "/v1/" + "a".repeat(2044)), program);
  must(pathAtCap.status === "succeeded", `a path at the cap was not taken: ${JSON.stringify(pathAtCap).slice(0, 200)}`);
});

await check("the card names the content-type the replay sends a held write with", async () => {
  const f = fixture();
  const { gw, store } = await gatewayWith(null, f.plugin);
  await gw.invoke(caller, "svc.request", req("POST", "/v1/x", "a=1", { "content-type": "application/x-www-form-urlencoded" }), program);
  const [a] = await store.listApprovals("t", "pending");
  must((a!.request as any).route.contentType === "application/x-www-form-urlencoded", `card: ${JSON.stringify(a!.request)}`);
});

await check("the unlisted-write floor is absolute: a plugin default of allow still holds, deny refuses, only the mount lifts it", async () => {
  const loose = fixture(ROUTES, { defaultPolicy: { tools: { "svc.write": "allow" } } });
  const a = await gatewayWith(null, loose.plugin);
  const r1: any = await a.gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/labels", "{}"), program);
  must(r1.status === "pending" && loose.sent.length === 0, `a plugin default of allow let an unlisted write run: ${JSON.stringify(r1)}`);
  const strict = fixture(ROUTES, { defaultPolicy: { tools: { "svc.write": "deny" } } });
  const b = await gatewayWith(null, strict.plugin);
  const r2: any = await b.gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/labels", "{}"), program);
  must(r2.status === "rejected" && r2.error?.code === "policy_denied", `a plugin default of deny was loosened: ${JSON.stringify(r2)}`);
  const owner = fixture(ROUTES, { defaultPolicy: { tools: { "svc.write": "deny" } } });
  const c = await gatewayWith({ tools: { request: "allow", "svc.write": "allow" } }, owner.plugin);
  const r3: any = await c.gw.invoke(caller, "svc.request", req("POST", "/v1/repos/o/r/labels", "{}"), program);
  must(r3.status === "succeeded" && owner.sent.length === 1, `the mount's allow did not lift it: ${JSON.stringify(r3)}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
