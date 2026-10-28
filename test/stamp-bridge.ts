/**
 * stamp on the SDK bridge (botiverse/antiproton#1092 step 3): a run_js program imports `sdk:stamp`, the published
 * client in the box, and every request it makes is a call of `stamp.request` through the real gateway, decided by
 * `STAMP_ROUTES` and sent by the plugin's `bridgeSend` with the mount's session. Asserted on outcomes — what the
 * program read, whether the run paused, what reached the mock upstream, what the gateway refused and with which code,
 * the approval card — with the Dynamic Worker executor over spec/worker-stand-in.ts, so the box's modules (the
 * vendored SDK files, the entry, the shim) are evaluated for real.
 *
 * Each case names the acceptance item it is for: the ten recorded on #1092 for step 3 (`item N`), and the plan's
 * extras.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stampPlugin, STAMP_ROUTES, API_ROUTES, UNLISTED_WRITE_KEY, apiRoute } from "../src/plugins/stamp.ts";
import { FILES, STAMP_SDK_VERSION } from "../src/plugins/stamp-sdk-box.ts";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { keepRaftIdentity } from "../src/plugins/raft-identity.ts";
import { DynamicWorkerExecutor } from "../src/runtime/dynamic-worker-executor.ts";
import { bridgeModulesFor } from "../src/runtime/pi-tools.ts";
import { DEFAULT_LIMITS } from "../src/core/execution.ts";
import { UNJUDGED_BODY } from "../src/plugins/types.ts";
import type { Plugin, RouteEntry } from "../src/plugins/types.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(c: unknown, m: string): asserts c { if (!c) throw new Error(m); }

// ---- the mock upstream --------------------------------------------------------------------------------------------

const RAFT_AGENT = "ra-1";
const RAFT_SERVER = "rs-1";
const RAFT_CREDENTIAL = "raft-mount-credential";
const ACCESS_1 = "access-token-first-0001";
const REFRESH_1 = "refresh-token-first-0001";
const ACCESS_2 = "access-token-rotated-0002";
const REFRESH_2 = "refresh-token-rotated-0002";
const session = () => JSON.stringify({
  schema: "raft-cli-agent-session.v1", access_token: ACCESS_1, refresh_token: REFRESH_1,
  access_expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
});

type Seen = { method: string; path: string; auth: string | null; ct: string | null; body: string | null };
/** What reached the upstream, owner checks and refreshes aside. */
let seen: Seen[] = [];
let refreshes = 0;
/** The access token a refresh answers: by default a new one; set to ACCESS_1 for a rotation that gives the same back. */
let refreshAccess = ACCESS_2;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
let upstream: (s: Seen) => Response | Promise<Response> = (s) => json(200, { seen: s.path });

globalThis.fetch = (async (input: any, init: any) => {
  const url = new URL(String(input));
  if (url.searchParams.get("purpose") === "owner-check") {
    return json(200, { agentId: RAFT_AGENT, serverId: RAFT_SERVER, principalType: "agent", handle: "eleanor" });
  }
  if (url.pathname === "/api/auth/agent/refresh") {
    refreshes++;
    return json(200, { schema: "raft-cli-agent-session.v1", access_token: refreshAccess, refresh_token: REFRESH_2,
      access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
  }
  const h = new Headers(init?.headers);
  const s: Seen = { method: init?.method ?? "GET", path: url.pathname + url.search, auth: h.get("authorization"),
    ct: h.get("content-type"), body: typeof init?.body === "string" ? init.body : null };
  seen.push(s);
  return upstream(s);
}) as any;

const reset = () => { seen = []; refreshes = 0; refreshAccess = ACCESS_2; upstream = (s) => json(200, { seen: s.path }); };

// ---- a stamp mount behind a real gateway --------------------------------------------------------------------------

const RAFT_STUB = { id: "raft", version: "1.0.0", tools: [], async invoke() { return {}; },
  database: { version: 8, stores: { context: {} } } } as any;
const caller = { tenantId: "t", agentId: "a", taskId: "k" };

async function mount(policy: unknown, plugin: Plugin = stampPlugin) {
  reset();
  const path = join(mkdtempSync(join(tmpdir(), "stamp-bridge-")), "s.sqlite");
  const store = new SqliteStore(path);
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "raft", plugin: "raft", installationId: "i-raft", connectionId: null,
    toolVersion: RAFT_STUB.version, publicConfig: {}, secretRef: "agent:raft", policy: null,
  });
  const db = { async put(st: string, value: any, key: string) { store.pluginDb.put({ tenantId: "t", agentId: "a", alias: "raft", plugin: "raft" }, st, key, value, null); return key; } };
  await keepRaftIdentity({ credential: RAFT_CREDENTIAL, alias: "raft", db } as any, RAFT_AGENT, RAFT_SERVER);
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "stamp", plugin: "stamp", installationId: "i", connectionId: null,
    toolVersion: plugin.version, publicConfig: {}, secretRef: "agent:stamp", policy: policy as any,
  });
  const credential = session();
  const gw = new ToolGateway(store, [plugin, RAFT_STUB], new Set(["stamp", "raft"]),
    { async resolve(ref: string) { return ref === "agent:raft" ? RAFT_CREDENTIAL : credential; } });
  const raw = new DatabaseSync(path);
  // Every row of every table, as text: what a store or trace kept.
  const everything = () => (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((t) => JSON.stringify(raw.prepare(`SELECT * FROM "${t.name}"`).all())).join("\n");
  /** One bridged request as a program's SDK makes it, straight to the gateway. */
  const request = (method: string, path: string, body: string | null = null, ct: string | null = "application/json") =>
    gw.invoke(caller, "stamp.request", { method, path, body, headers: ct ? { "content-type": ct, accept: "application/json" } : {} },
      { fromProgram: true }) as Promise<any>;
  return { gw, store, request, everything };
}

const standIn = standInLoader({ callHopMs: 1 });
const exec = new DynamicWorkerExecutor({ loader: standIn.loader, makeToolBinding: standIn.makeToolBinding });
const BRIDGES = bridgeModulesFor([{ alias: "stamp", plugin: "stamp" }],
  [{ name: "stamp__whoami", description: "", parameters: {}, address: "stamp.whoami", sideEffects: "read" } as any],
  (id) => (id === "stamp" ? stampPlugin : undefined));

/** Run a program against this mount, every host call to its gateway as a program's. */
function run(m: Awaited<ReturnType<typeof mount>>, source: string, limits = DEFAULT_LIMITS) {
  return exec.execute(source, {
    bridges: BRIDGES,
    invoke: (c: any) => m.gw.invoke(caller, c.tool, c.args, { fromProgram: true }),
  } as any, limits) as Promise<any>;
}
const PROLOGUE = `const { stamp, ApiError, NetworkError } = await import("sdk:stamp");
async function attempt(method, path, body) {
  try { return { ok: await stamp(method, path, body) }; }
  catch (e) { return { name: e.constructor.name, api: e instanceof ApiError, net: e instanceof NetworkError, status: e.status ?? null, message: e.message, code: e.body?.error?.code ?? null }; }
}
`;

/** Allows everything a mount owner can: what is refused here is refused by the table or the core, not by policy. */
const OPEN = { write: "allow", tools: { request: "allow", [UNLISTED_WRITE_KEY]: "allow", pr_merge: "allow", pr_approve: "allow", pr_comment: "allow", api: "allow" } };

// ---- the box -------------------------------------------------------------------------------------------------------

await check("pin: the box's SDK files are byte-equal to node_modules, at the version package.json pins", () => {
  const pin = JSON.parse(readFileSync("package.json", "utf8")).dependencies["@botiverse/stamp-sdk"];
  const installed = JSON.parse(readFileSync("node_modules/@botiverse/stamp-sdk/package.json", "utf8")).version;
  must(STAMP_SDK_VERSION === pin && installed === pin, `vendored ${STAMP_SDK_VERSION}, pinned ${pin}, installed ${installed}`);
  must(JSON.stringify(Object.keys(FILES).sort()) === '["lib/client.mjs","lib/errors.mjs","lib/locale.mjs"]', `files: ${Object.keys(FILES)}`);
  for (const [name, src] of Object.entries(FILES)) {
    must(src === readFileSync(`node_modules/@botiverse/stamp-sdk/${name}`, "utf8"), `${name} differs from the installed package`);
  }
  execFileSync(process.execPath, ["scripts/vendor-stamp-sdk.mjs", "--check"], { stdio: "pipe" });
  const box = stampPlugin.bridge!.box;
  must(Object.keys(FILES).every((f) => box.files[f] === FILES[f]), "the bridge does not ship the vendored files");
  must(!/injected-auth|session\.mjs|agent-refresh/.test(Object.values(box.files).join("\n")), "the box carries the SDK's session handling");
});

await check("the box's auth holds no credential and is not the agent mode, so a 401 never refreshes there (item A3)", async () => {
  const m = await mount(null);
  upstream = () => json(401, { error: "unauthorized" });
  const r = await run(m, PROLOGUE + `output(await attempt("GET", "/v1/me"));`);
  must(r.status === "completed", `run: ${JSON.stringify(r)}`);
  must(r.hostCalls === 1, `the box made ${r.hostCalls} host calls on a 401; it must not retry`);
  must(r.outputs[0].status === 401 && r.outputs[0].api, `the program read ${JSON.stringify(r.outputs[0])}`);
  // The gateway rotated and resent once; the box's placeholder never left it.
  must(refreshes === 1 && seen.length === 2, `refreshes ${refreshes}, upstream saw ${seen.length}`);
  must(seen[0]!.auth === `Bearer ${ACCESS_1}` && seen[1]!.auth === `Bearer ${ACCESS_2}`, `upstream saw ${seen.map((s) => s.auth)}`);
  const entry = stampPlugin.bridge!.box.files[stampPlugin.bridge!.box.entry]!;
  must(/mode: "bridge"/.test(entry) && !/ACCESS|REFRESH|access_token/.test(entry), "the entry's auth");
  // Read only by the client's network-retry path, which the shim's errors never take (they carry no code): stated,
  // so one SDK call stays one host call if that changes.
  must(/\{ retryReads: false \}/.test(entry), "the entry's client retries reads");
});

// ---- item 1: refuse rows with a body check, both exits -----------------------------------------------------------

const REVIEW = "/api/v3/repos/o/r/pulls/7/reviews";
await check("item 1: an APPROVE review in any casing, and on reviews/<id>/events, is refused where everything is allowed", async () => {
  const m = await mount(OPEN);
  for (const [path, body] of [
    [REVIEW, '{"event":"APPROVE"}'], [REVIEW, '{"event":"approve"}'], [REVIEW, '{"event":" Approve "}'],
    [REVIEW, '{"EVENT":"APPROVE","body":"lgtm"}'], [`${REVIEW}/55/events`, '{"event":"APPROVE"}'], [`${REVIEW.toUpperCase()}`, '{"event":"APPROVE"}'],
  ] as const) {
    const r = await m.request("POST", path, body);
    must(r.status === "rejected" && r.error?.code === "route_refused" && /pr_approve/.test(r.error.message), `${path} ${body}: ${JSON.stringify(r)}`);
  }
  must(seen.length === 0, `an approval reached upstream: ${JSON.stringify(seen)}`);
});

await check("item 1: a COMMENT review is decided under pr_comment: pending where pr_comment is held, runs where it is allowed", async () => {
  const held = await mount({ tools: { request: "allow", pr_comment: "approval" } });
  const r1 = await held.request("POST", REVIEW, '{"event":"COMMENT","body":"hi"}');
  must(r1.status === "pending", `held: ${JSON.stringify(r1)}`);
  const card = (await held.store.listApprovals("t", "pending"))[0]!.request as any;
  must(card.policyKey === "pr_comment", `the hold names ${card.policyKey}`);
  must(seen.length === 0, "a held review reached upstream");
  const allowed = await mount({ tools: { pr_comment: "allow" } });
  const r2 = await allowed.request("POST", REVIEW, '{"event":"COMMENT","body":"hi"}');
  must(r2.status === "succeeded" && (seen.length as number) === 1 && seen[0]!.path === REVIEW, `allowed: ${JSON.stringify(r2)}`);
  // A review edit is a comment too.
  const edit = await allowed.request("PUT", `${REVIEW}/55`, '{"body":"edited"}');
  must(edit.status === "succeeded", `a review edit: ${JSON.stringify(edit)}`);
  const denied = await mount({ tools: { pr_comment: "deny" } });
  const r3 = await denied.request("POST", REVIEW, '{"event":"COMMENT"}');
  must(r3.status === "rejected" && r3.error?.code === "policy_denied", `pr_comment: deny: ${JSON.stringify(r3)}`);
});

await check("item 1: REQUEST_CHANGES is held under stamp.write, not run as a comment where comments are allowed", async () => {
  const m = await mount({ tools: { request: "allow", pr_comment: "allow" } });
  const r = await m.request("POST", REVIEW, '{"event":"request_changes","body":"no"}');
  must(r.status === "pending", `REQUEST_CHANGES: ${JSON.stringify(r)}`);
  const card = (await m.store.listApprovals("t", "pending"))[0]!.request as any;
  must(card.policyKey === UNLISTED_WRITE_KEY, `held under ${card.policyKey}`);
  must(seen.length === 0, "it reached upstream");
});

await check("item 1: a review body the APPROVE row cannot judge is refused with its own message, never held or run", async () => {
  const m = await mount(OPEN);
  const approveMsg = STAMP_ROUTES.find((r) => r.body && r.refuse)!.refuse!;
  for (const [what, body, ct] of [
    ["COMMENT as text/plain", '{"event":"COMMENT"}', "text/plain"],
    ["no content-type", '{"event":"COMMENT"}', null],
    ["an array", '[{"event":"COMMENT"}]', "application/json"],
    ["an event array", '{"event":["APPROVE"]}', "application/json"],
    ["an event object", '{"event":{"APPROVE":1}}', "application/json"],
    ["an unparsable body", '{"event":"COMMENT"', "application/json"],
  ] as const) {
    const r = await m.request("POST", REVIEW, body, ct);
    must(r.status === "rejected" && r.error?.code === "route_refused", `${what}: ${JSON.stringify(r)}`);
    must(r.error.message !== approveMsg && r.error.message !== UNJUDGED_BODY && /pr_comment/.test(r.error.message) && /pr_approve/.test(r.error.message),
      `${what} is refused with ${JSON.stringify(r.error.message)}, not the row's unsure message`);
  }
  must(seen.length === 0, `an unjudged review reached upstream: ${JSON.stringify(seen)}`);
});

// ---- item 2: the SDK sends JSON -------------------------------------------------------------------------------------

await check("item 2: the real SDK sends content-type: application/json on a review, so a COMMENT reaches upstream from a program", async () => {
  const m = await mount(null);
  const r = await run(m, PROLOGUE + `output(await attempt("POST", "${REVIEW}", { event: "COMMENT", body: "from code" }));`);
  must(r.status === "completed" && r.outputs[0].ok, `run: ${JSON.stringify(r)}`);
  must(seen.length === 1 && seen[0]!.ct === "application/json" && JSON.parse(seen[0]!.body!).event === "COMMENT",
    `upstream saw ${JSON.stringify(seen)}`);
  must(seen[0]!.auth === `Bearer ${ACCESS_1}`, `upstream's authorization: ${seen[0]!.auth}`);
});

// ---- items 3 and 4: the policy keys -----------------------------------------------------------------------------

await check("item 3: request has no entry in stamp's defaults, and an unlisted GET runs on a mount with no policy", async () => {
  must(stampPlugin.defaultPolicy?.tools?.request === undefined, `request: ${stampPlugin.defaultPolicy?.tools?.request}`);
  const m = await mount(null);
  const r = await m.request("GET", "/api/v3/repos/o/r/contents/README.md?ref=main", null, null);
  must(r.status === "succeeded" && r.result.status === 200 && seen.length === 1, `an unlisted read: ${JSON.stringify(r)}`);
});

await check("item 4: stamp.write is approval by default; a plugin default of allow still holds; deny refuses; only the mount lifts it", async () => {
  must(stampPlugin.defaultPolicy?.tools?.[UNLISTED_WRITE_KEY] === "approval", "stamp.write's default");
  const labels = "/api/v3/repos/o/r/labels";
  const byDefault = await mount(null);
  const r1 = await byDefault.request("POST", labels, '{"name":"x"}');
  must(r1.status === "pending" && seen.length === 0, `default: ${JSON.stringify(r1)}`);
  const loose = { ...stampPlugin, defaultPolicy: { tools: { ...stampPlugin.defaultPolicy!.tools, [UNLISTED_WRITE_KEY]: "allow" as const } } };
  const r2 = await (await mount(null, loose)).request("POST", labels, '{"name":"x"}');
  must(r2.status === "pending" && seen.length === 0, `a plugin default of allow: ${JSON.stringify(r2)}`);
  const r3 = await (await mount({ tools: { [UNLISTED_WRITE_KEY]: "deny" } })).request("POST", labels, '{"name":"x"}');
  must(r3.status === "rejected" && r3.error?.code === "policy_denied", `deny: ${JSON.stringify(r3)}`);
  const r4 = await (await mount({ tools: { [UNLISTED_WRITE_KEY]: "allow" } })).request("POST", labels, '{"name":"x"}');
  must(r4.status === "succeeded" && (seen.length as number) === 1, `the mount's allow: ${JSON.stringify(r4)}`);
});

await check("the dotted stamp.write is a valid policy key: the gateway takes the plugin, and a mount's entry for it applies", async () => {
  // `mount` builds the gateway, which refuses a plugin whose defaultPolicy or bridge it does not take (`checkBridge`).
  const m = await mount({ tools: { "stamp.write": "allow" } });
  const r = await m.request("DELETE", "/v1/repositories/o/r/pulls/7/queue/req_1", null);
  must(r.status === "succeeded", `stamp.write: allow on the mount did not apply: ${JSON.stringify(r)}`);
});

await check("every key in STAMP_ROUTES is a stamp tool of the same name, or stamp.write; none is request", () => {
  const tools = new Set(stampPlugin.tools.map((t) => t.name));
  const keys = [...new Set(STAMP_ROUTES.filter((r) => r.key).map((r) => r.key!))];
  const bad = keys.filter((k) => k !== UNLISTED_WRITE_KEY && !tools.has(k));
  must(bad.length === 0 && !keys.includes("request"), `keys that name no tool: ${bad}`);
  must(JSON.stringify(keys.sort()) === JSON.stringify(["issue_comment", "issue_create", "pr_comment", "pr_create", "pr_unapprove", "stamp.write"]), `keys: ${keys}`);
  must(stampPlugin.version === "1.0.0", `version ${stampPlugin.version}`);
});

await check("the listed writes are decided under their tools' keys: unapprove, PR create, issue create, issue comment", async () => {
  for (const [method, path, key] of [
    ["POST", "/v1/repositories/o/r/pulls/7/unapprove", "pr_unapprove"],
    ["POST", "/v1/pull-requests", "pr_create"],
    ["POST", "/api/v3/repos/o/r/pulls", "pr_create"],
    ["POST", "/v1/repositories/o/r/issues", "issue_create"],
    ["POST", "/api/v3/repos/o/r/issues", "issue_create"],
    ["POST", "/v1/repositories/o/r/issues/3/comments", "issue_comment"],
    ["POST", "/api/v3/repos/o/r/issues/3/comments", "issue_comment"],
    ["POST", "/v1/repositories/o/r/pulls/7/comments", "pr_comment"],
    ["POST", "/api/v3/repos/o/r/pulls/7/comments", "pr_comment"],
  ] as const) {
    const m = await mount({ tools: { [key]: "approval" } });
    const r = await m.request(method, path, "{}");
    const card = (await m.store.listApprovals("t", "pending"))[0]?.request as any;
    must(r.status === "pending" && card?.policyKey === key, `${method} ${path}: ${JSON.stringify(r)} under ${card?.policyKey}`);
    const d = await (await mount({ tools: { [key]: "deny" } })).request(method, path, "{}");
    must(d.status === "rejected" && d.error?.code === "policy_denied", `${key}: deny did not refuse ${path}: ${JSON.stringify(d)}`);
  }
});

// ---- item 5: percent-escapes ------------------------------------------------------------------------------------

await check("item 5: a percent-escape in the path is refused before the table and never reaches upstream", async () => {
  const m = await mount(OPEN);
  for (const path of ["/api/v3/repos/o/r/contents/docs%2Freadme.md", "/v1/repositories/o/r/pulls%2F7%2Fmerge", "/v1/repositories/o/r/pulls/7%2Fmerge"]) {
    for (const method of ["GET", "PUT"]) {
      const r = await m.request(method, path, method === "GET" ? null : "{}");
      must(r.status === "rejected" && r.error?.code === "bad_request" && /percent/.test(r.error.message), `${method} ${path}: ${JSON.stringify(r)}`);
    }
  }
  // The query form the docs name instead.
  const q = await m.request("GET", "/api/v3/repos/o/r/commits?sha=feature/x", null, null);
  must(q.status === "succeeded", `a query form: ${JSON.stringify(q)}`);
  must(seen.length === 1 && seen[0]!.path === "/api/v3/repos/o/r/commits?sha=feature/x", `upstream saw ${JSON.stringify(seen)}`);
});

// ---- item 6: the session endpoints ----------------------------------------------------------------------------

await check("item 6: /api/auth/* is refused, GET and POST alike, where everything is allowed; so is anything outside the prefixes", async () => {
  const m = await mount(OPEN);
  for (const [method, path] of [["GET", "/api/auth/agent/session"], ["POST", "/api/auth/agent/refresh"], ["POST", "/api/auth/agent/exchange"],
    ["DELETE", "/api/auth"], ["GET", "/api/v4/x"], ["POST", "/healthz"], ["GET", "/v1"]] as const) {
    const r = await m.request(method, path, method === "GET" ? null : '{"refresh_token":"x"}');
    must(r.status === "rejected" && r.error?.code === "route_refused", `${method} ${path}: ${JSON.stringify(r)}`);
    // Its own row, not only the prefix row: the message says why a program may not touch the session.
    must(path.startsWith("/api/auth") === /\/api\/auth/.test(r.error.message), `${method} ${path} is refused as ${JSON.stringify(r.error.message)}`);
  }
  must(seen.length === 0 && refreshes === 0, `reached upstream: ${JSON.stringify(seen)}, refreshes ${refreshes}`);
});

// ---- item 7: the bytes the box reads ----------------------------------------------------------------------------

await check("item 7: an answer with odd whitespace reads the same in the box, though its bytes were rewritten", async () => {
  const m = await mount(null);
  upstream = () => json(200, '{\n    "number" :   7 ,\n\t"title":"t" ,  "n": 1.50 }\n');
  const r = await run(m, PROLOGUE + `output(await stamp("GET", "/v1/repositories/o/r/pulls/7"));`);
  must(r.status === "completed" && JSON.stringify(r.outputs[0]) === '{"number":7,"title":"t","n":1.5}', `read ${JSON.stringify(r)}`);
});

// ---- item 8: response headers -----------------------------------------------------------------------------------

await check("item 8: the box gets stamp-cli-latest and -minimum, content-type and x-request-id; never set-cookie or another header", async () => {
  const m = await mount(null);
  upstream = () => json(200, "{}", { "stamp-cli-latest": "1.4.0", "stamp-cli-minimum": "1.0.0", "set-cookie": "s=1", "x-request-id": "rq-9", "x-other": "y", "www-authenticate": "Bearer" });
  const r = await m.request("GET", "/v1/me", null, null);
  must(r.status === "succeeded", JSON.stringify(r));
  const h = r.result.headers;
  must(JSON.stringify(Object.keys(h).sort()) === '["content-type","stamp-cli-latest","stamp-cli-minimum","x-request-id"]', `headers: ${JSON.stringify(h)}`);
});

// ---- item 9: redaction, including a throw -----------------------------------------------------------------------

await check("item 9: a token minted by a 401 rotation, echoed back, is redacted in the answer; the retry carried it", async () => {
  const m = await mount(null);
  let n = 0;
  upstream = (s) => (n++ === 0 ? json(401, { error: "expired" })
    : json(200, { you_sent: s.auth, refresh: REFRESH_2, first: ACCESS_1 }, { "x-request-id": `rq ${ACCESS_2}` }));
  const r = await run(m, PROLOGUE + `output(await stamp("GET", "/v1/me"));`);
  must(r.status === "completed", JSON.stringify(r));
  must(seen.length === 2 && seen[1]!.auth === `Bearer ${ACCESS_2}` && refreshes === 1, `upstream saw ${JSON.stringify(seen)}`);
  const out = JSON.stringify(r.outputs);
  must(!out.includes(ACCESS_2) && !out.includes(REFRESH_2) && !out.includes(ACCESS_1) && out.includes("[redacted]"), `the box read ${out}`);
  must(!m.everything().includes(ACCESS_2) && !m.everything().includes(REFRESH_2), "the store kept a rotated token");
});

await check("item 9: the kept session's token, rotated by an earlier call and in no credential, is redacted on the next", async () => {
  const m = await mount(null);
  let n = 0;
  // The second call echoes only what is not in the mount's credential: the kept session's tokens.
  upstream = (s) => (n++ === 0 ? json(401, { error: "expired" }) : n === 2 ? json(200, {}) : json(200, { you_sent: s.auth, refresh: REFRESH_2 }));
  const r = await run(m, PROLOGUE + `await stamp("GET", "/v1/me"); output(await stamp("GET", "/v1/me"));`);
  must(r.status === "completed" && seen.length === 3 && seen[2]!.auth === `Bearer ${ACCESS_2}`, `run: ${JSON.stringify(r)} ${JSON.stringify(seen)}`);
  must(JSON.stringify(r.outputs) === '[{"you_sent":"Bearer [redacted]","refresh":"[redacted]"}]', `the second call read ${JSON.stringify(r.outputs)}`);
});

await check("item 9: a send that throws after the rotation reaches the box with the minted token redacted", async () => {
  const m = await mount(null);
  let n = 0;
  upstream = () => {
    if (n++ === 0) return json(401, { error: "expired" });
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: `ECONNRESET ${ACCESS_2} ${REFRESH_2}` } });
  };
  const r = await run(m, PROLOGUE + `output(await attempt("POST", "/v1/repositories/o/r/pulls/7/comments", { body: "x" }));`);
  must(r.status === "completed", JSON.stringify(r));
  const o = r.outputs[0];
  must(o.net === true && /fetch failed/.test(o.message), `the program read ${JSON.stringify(o)}`);
  const all = JSON.stringify(r) + m.everything();
  must(!all.includes(ACCESS_2) && !all.includes(REFRESH_2), `a rotated token leaked: ${JSON.stringify(o)}`);
});

// ---- item 10: errors as the SDK shapes them -----------------------------------------------------------------------

await check("item 10: a refusal is an ApiError 403 with a readable message and error.code route_refused; a failure a NetworkError", async () => {
  const m = await mount(null);
  upstream = () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
  const r = await run(m, PROLOGUE + `output(await attempt("PUT", "/v1/repositories/o/r/pulls/7/merge", {}));
    output(await attempt("GET", "/v1/me"));`);
  must(r.status === "completed", JSON.stringify(r));
  const [refused, failed] = r.outputs;
  must(refused.api && refused.status === 403 && refused.code === "route_refused", `refusal: ${JSON.stringify(refused)}`);
  must(/^403: .*pr_merge/.test(refused.message) && !/object Object/.test(refused.message), `the refusal's message: ${refused.message}`);
  must(failed.net && failed.name === "NetworkError" && /ECONNREFUSED/.test(failed.message), `failure: ${JSON.stringify(failed)}`);
});

// ---- the plan's extras ------------------------------------------------------------------------------------------

const V1PR = "/v1/repositories/o/r/pulls/7";
const MERGES: Array<[string, string, string]> = [
  ["POST", `${V1PR}/merge`, "route_refused"], ["PUT", `${V1PR}/merge`, "route_refused"], ["PATCH", `${V1PR}/merge`, "route_refused"],
  ["PUT", `${V1PR}/auto-merge`, "route_refused"], ["POST", `${V1PR}/auto-merge`, "route_refused"],
  ["POST", `${V1PR}/queue`, "route_refused"], ["PUT", `${V1PR}/queue/req_1`, "route_refused"],
  ["PUT", `${V1PR}/MERGE`, "route_refused"], ["PUT", `${V1PR}/Merge/`, "route_refused"], ["PUT", `${V1PR}/merge?x=1`, "route_refused"],
  ["POST", `${V1PR}/approve`, "route_refused"], ["POST", `${V1PR}/APPROVE/`, "route_refused"],
  ["PUT", "/api/v3/repos/o/r/pulls/7/merge", "route_refused"], ["POST", "/api/v3/repos/o/r/merges", "route_refused"],
  ["PUT", "/API/V3/REPOS/o/r/PULLS/7/MERGE", "route_refused"],
  ["POST", "/api/v3/graphql", "route_refused"], ["GET", "/api/v3/graphql", "route_refused"],
  ["PUT", `${V1PR}//merge`, "bad_request"], ["PUT", `${V1PR}/merge/.`, "bad_request"], ["PUT", `${V1PR}/%6Derge`, "bad_request"],
];
await check("every merge and approve spelling is refused where every key is allowed, and none reaches upstream", async () => {
  const m = await mount(OPEN);
  for (const [method, path, code] of MERGES) {
    const r = await m.request(method, path, method === "GET" ? null : '{"query":"mutation{mergePullRequest}"}');
    must(r.status === "rejected" && r.error?.code === code, `${method} ${path}: ${JSON.stringify(r)}`);
  }
  must(seen.length === 0, `reached upstream: ${JSON.stringify(seen)}`);
  // Whether a pull request was merged is a read, and passes.
  const read = await m.request("GET", "/api/v3/repos/o/r/pulls/7/merge", null, null);
  must(read.status === "succeeded", `the merged-or-not read: ${JSON.stringify(read)}`);
});

await check("cancelling auto-merge and leaving the queue (DELETE) are held under stamp.write, not refused; allowed, they run", async () => {
  for (const path of [`${V1PR}/auto-merge`, `${V1PR}/queue`, `${V1PR}/queue/req_1`]) {
    const held = await mount({ tools: { pr_merge: "allow" } });
    const r = await held.request("DELETE", path, null);
    const card = (await held.store.listApprovals("t", "pending"))[0]?.request as any;
    must(r.status === "pending" && card?.policyKey === UNLISTED_WRITE_KEY, `${path}: ${JSON.stringify(r)}`);
    const ran = await (await mount({ tools: { [UNLISTED_WRITE_KEY]: "allow" } })).request("DELETE", path, null);
    must(ran.status === "succeeded" && seen.length === 1 && seen[0]!.method === "DELETE", `${path} allowed: ${JSON.stringify(ran)}`);
  }
});

await check("a mount with pr_merge: deny cannot merge from code, by any route the program tries", async () => {
  const m = await mount({ write: "allow", tools: { pr_merge: "deny", request: "allow", [UNLISTED_WRITE_KEY]: "allow" } });
  const r = await run(m, PROLOGUE + `for (const [mt, p] of [["PUT", "${V1PR}/auto-merge"], ["PUT", "${V1PR}/merge"], ["PUT", "/api/v3/repos/o/r/pulls/7/merge"],
      ["POST", "/api/v3/repos/o/r/merges"], ["POST", "/api/v3/graphql"]]) output((await attempt(mt, p, {})).code);`);
  must(r.status === "completed" && r.outputs.every((c: string) => c === "route_refused") && r.outputs.length === 5, `outputs: ${JSON.stringify(r)}`);
  must(seen.length === 0, `reached upstream: ${JSON.stringify(seen)}`);
});

await check("the host-call budget: a loop of 100 SDK reads is refused at the 65th with host_call_budget_exceeded", async () => {
  const m = await mount(null);
  const r = await run(m, PROLOGUE + `let i = 0;
    for (; i < 100; i++) { const a = await attempt("GET", "/v1/me"); if (!a.ok) { output([i + 1, a.code]); break; } }`,
    { ...DEFAULT_LIMITS, wallTimeMs: 30_000 });
  must(r.status === "completed" && JSON.stringify(r.outputs[0]) === '[65,"host_call_budget_exceeded"]', `outputs: ${JSON.stringify(r)}`);
  must(seen.length === 64, `upstream saw ${seen.length}`);
});

await check("a held write pauses the program; the card names method, path, repository, PR and the policy key", async () => {
  const m = await mount(null);
  const r = await run(m, PROLOGUE + `output("before");
    try { await stamp("DELETE", "${V1PR}/auto-merge"); } catch (e) { output("caught"); }
    output("after");`);
  must(r.status === "paused" && r.held?.length === 1, `run: ${JSON.stringify(r)}`);
  must(JSON.stringify(r.outputs) === '["before"]', `outputs: ${JSON.stringify(r.outputs)}`);
  const a = await m.store.listApprovals("t", "pending");
  const req = a[0]?.request as any;
  must(a.length === 1 && a[0]!.operationId === r.held[0].operationId, `approvals: ${JSON.stringify(a)}`);
  must(req.policyKey === UNLISTED_WRITE_KEY && req.route?.method === "DELETE" && req.route?.path === `${V1PR}/auto-merge`
    && req.route?.repo === "o/r" && req.route?.pr === 7, `card: ${JSON.stringify(req)}`);
  must(seen.length === 0, "a held write reached upstream");
});

await check("a method outside GET, HEAD, POST, PUT, PATCH, DELETE is a bad request, on a refused path and an unlisted one alike", async () => {
  const m = await mount(OPEN);
  for (const method of ["FOO", "PROPFIND", "foo", "OPTIONS"]) {
    for (const path of ["/api/auth/session", "/api/v3/repos/o/r/labels"]) {
      const r = await m.request(method, path, "{}");
      must(r.status === "rejected" && r.error?.code === "bad_request" && /method/.test(r.error.message), `${method} ${path}: ${JSON.stringify(r)}`);
    }
  }
  must(seen.length === 0 && (await m.store.listApprovals("t", "pending")).length === 0, `reached upstream or held: ${JSON.stringify(seen)}`);
  must(/"status":"rejected"/.test(m.everything()) && !/"status":"pending"/.test(m.everything()), "the operations were not ended rejected");
});

await check("a held request is kept with only the headers that leave the box, and the approved replay runs from it", async () => {
  const m = await mount(null);
  const r = await run(m, PROLOGUE + `await stamp("POST", "/api/v3/repos/o/r/labels", { name: "x" });`);
  must(r.status === "paused", `run: ${JSON.stringify(r)}`);
  const a = await m.store.listApprovals("t", "pending");
  const args = (a[0]!.request as any).args;
  must(JSON.stringify(Object.keys(args.headers).sort()) === '["accept","content-type"]', `the kept headers: ${JSON.stringify(args.headers)}`);
  must(!JSON.stringify(a).includes("authorization") && !m.everything().includes("Bearer bridge"), "the box's authorization was kept");
  const done: any = await m.gw.applyApproval("t", a[0]!.operationId, "approved", "owner");
  must(done.ok && done.executed && done.result?.status === "succeeded", `the replay: ${JSON.stringify(done)}`);
  must(seen.length === 1 && seen[0]!.method === "POST" && seen[0]!.ct === "application/json" && seen[0]!.auth === `Bearer ${ACCESS_1}`
    && JSON.parse(seen[0]!.body!).name === "x", `upstream saw ${JSON.stringify(seen)}`);
});

await check("item 1: a review that names event twice is refused as unjudged, whatever the last one says; any case counts", async () => {
  const m = await mount(OPEN);
  const unsure = (STAMP_ROUTES.find((r) => r.refuse !== undefined && r.unsure) as { unsure: string }).unsure;
  for (const body of ['{"event":"APPROVE","event":"COMMENT"}', '{"event":"COMMENT","body":"x","Event":"COMMENT"}',
    '{"body":{"event":"a","event":"b"},"event":"COMMENT","event":"COMMENT"}']) {
    const r = await m.request("POST", REVIEW, body);
    must(r.status === "rejected" && r.error?.code === "route_refused" && r.error.message === unsure, `${body}: ${JSON.stringify(r)}`);
  }
  // A key repeated deeper down, or a string that only looks like one, is not a repeated event.
  for (const body of ['{"comments":[{"event":"a"},{"event":"b"}],"event":"COMMENT"}', '{"body":"\\"event\\":1, event","event":"COMMENT"}']) {
    const r = await m.request("POST", REVIEW, body);
    must(r.status === "succeeded", `${body}: ${JSON.stringify(r)}`);
  }
  must(seen.length === 2, `upstream saw ${seen.length}`);
});

await check("item 1: the APPROVE check applies to every write to a review: PUT, PATCH and DELETE with event APPROVE are refused", async () => {
  const m = await mount(OPEN);
  for (const [method, path] of [["PUT", `${REVIEW}/55`], ["PATCH", `${REVIEW}/55`], ["PUT", `${REVIEW}/55/events`], ["DELETE", `${REVIEW}/55`], ["PATCH", REVIEW]] as const) {
    const r = await m.request(method, path, '{"event":"APPROVE"}');
    must(r.status === "rejected" && r.error?.code === "route_refused" && /pr_approve/.test(r.error.message), `${method} ${path}: ${JSON.stringify(r)}`);
  }
  must(seen.length === 0, `reached upstream: ${JSON.stringify(seen)}`);
});

await check("a 401 the rotation cannot change is not resent with the same token: one request upstream, the 401 reaches the box", async () => {
  const m = await mount(null);
  refreshAccess = ACCESS_1;
  upstream = () => json(401, { error: "unauthorized" });
  const r = await m.request("GET", "/v1/me", null, null);
  must(r.status === "succeeded" && r.result.status === 401, `result: ${JSON.stringify(r)}`);
  must(refreshes === 1 && seen.length === 1, `refreshes ${refreshes}, upstream saw ${seen.length}: ${JSON.stringify(seen.map((x) => x.auth))}`);
});

await check("a path refusal thrown by gatewayFetch inside send keeps its own words; it is not reported as a network failure", async () => {
  // A table with no rows, so the request reaches send: what is left to stop it is gatewayFetch's own prefix check.
  const bare = { ...stampPlugin, bridge: { ...stampPlugin.bridge!, routes: [] } };
  const m = await mount(null, bare);
  const r = await m.request("GET", "/api/auth/agent/session", null, null);
  must(r.status === "failed" && /path must start with \/v1\/ or \/api\/v3\//.test(r.error?.message) && !/fetch failed/.test(r.error?.message),
    `result: ${JSON.stringify(r)}`);
  must(seen.length === 0, "it reached upstream");
});

await check("GitHub's /repositories/<id> alias is refused for every method: merge, an APPROVE review, a read", async () => {
  const m = await mount(OPEN);
  for (const [method, path, body] of [
    ["PUT", "/api/v3/repositories/123/pulls/7/merge", "{}"],
    ["POST", "/api/v3/repositories/123/pulls/7/reviews", '{"event":"APPROVE"}'],
    ["GET", "/api/v3/repositories/123", null],
    ["DELETE", "/API/V3/Repositories/123/git/refs/heads/x", null],
  ] as const) {
    const r = await m.request(method, path, body, body ? "application/json" : null);
    must(r.status === "rejected" && r.error?.code === "route_refused" && /repos\/<owner>\/<repo>/.test(r.error.message), `${method} ${path}: ${JSON.stringify(r)}`);
  }
  must(seen.length === 0, `reached upstream: ${JSON.stringify(seen)}`);
});

await check("a review write that carries a query is refused, whatever the body; without one, and a read with one, it runs", async () => {
  const m = await mount(OPEN);
  for (const [method, path] of [["POST", `${REVIEW}?event=APPROVE`], ["POST", `${REVIEW}?`], ["PUT", `${REVIEW}/55?x=1`],
    ["POST", `${REVIEW}/55/events?event=approve`], ["DELETE", `${REVIEW}/55?a`], ["POST", `${REVIEW}/?event=APPROVE`]] as const) {
    const r = await m.request(method, path, "{}");
    must(r.status === "rejected" && r.error?.code === "route_refused" && /query/.test(r.error.message), `${method} ${path}: ${JSON.stringify(r)}`);
  }
  must(seen.length === 0, `reached upstream: ${JSON.stringify(seen)}`);
  const plain = await m.request("POST", REVIEW, '{"event":"COMMENT","body":"hi"}');
  const read = await m.request("GET", `${REVIEW}?per_page=5`, null, null);
  must(plain.status === "succeeded" && read.status === "succeeded" && (seen.length as number) === 2, `without a query: ${JSON.stringify(plain)}; a read: ${JSON.stringify(read)}`);
});

await check("describe names the repository and number on v1 and v3 pull and issue paths, and nothing elsewhere", () => {
  const d = stampPlugin.bridge!.describe!;
  must(JSON.stringify(d("/v1/repositories/o/r/pulls/7/comments")) === '{"repo":"o/r","pr":7}', "v1 pull");
  must(JSON.stringify(d("/api/v3/repos/o/r/issues/3/comments?x=1")) === '{"repo":"o/r","pr":3}', "v3 issue");
  must(JSON.stringify(d("/api/v3/repos/o/r/labels")) === '{"repo":"o/r"}', "repo only");
  must(JSON.stringify(d("/v1/pull-requests")) === "{}", "no repo");
  // In any case, as the table matches: the card must name what a person signs for however the program spelled it.
  must(JSON.stringify(d("/V1/Repositories/o/r/PULLS/7")) === '{"repo":"o/r","pr":7}', "v1 in another case");
  must(JSON.stringify(d("/API/V3/REPOS/o/r/ISSUES/3")) === '{"repo":"o/r","pr":3}', "v3 in another case");
});

// ---- step 4: `api` is decided by the same rows (botiverse/antiproton#1092) -------------------------------------------

/** Every refusal and `unsure` the bridge says, as text: pinned so that sharing the rows with `api` changed none of them. */
const BRIDGE_WORDS = [
  "a program's request through sdk:stamp may not reach /api/auth: the mount keeps and refreshes its own session",
  "a program's request through sdk:stamp may not leave /v1/ and /api/v3/",
  "a program's request through sdk:stamp may not approve: call pr_approve, which names the exact head a person signs for",
  "a program's request through sdk:stamp may not merge, enable auto-merge or join the queue: call pr_merge, which names the exact head a person signs for",
  "a program's request through sdk:stamp may not merge through GitHub's API: call pr_merge, which names the exact head a person signs for",
  "a program's request through sdk:stamp may not use GitHub's GraphQL API, which can approve or merge: use the REST paths, or the stamp tools",
  "a program's request through sdk:stamp may not use GitHub's /repositories/<id> paths: name the repository as /api/v3/repos/<owner>/<repo>, or use the pr_* tools",
  "a program's request through sdk:stamp may not write a review with a query string, which this table cannot judge: put every field in the JSON body",
  "a program's request through sdk:stamp may not approve through a review: call pr_approve, which names the exact head a person signs for",
  "this review's body could not be read as a JSON object with a string `event` (sent with content-type: application/json), so it may be an approval and is refused. Send it as JSON, or use the tools: pr_comment to comment, pr_approve to approve",
];

await check("step 4 pin: API_ROUTES is STAMP_ROUTES row by row — same methods, pattern, query rule, body check and key; only the wording differs", () => {
  must(API_ROUTES.length === STAMP_ROUTES.length && API_ROUTES.length === 19, `rows: ${API_ROUTES.length} vs ${STAMP_ROUTES.length}`);
  STAMP_ROUTES.forEach((b, i) => {
    const a = API_ROUTES[i]!;
    const at = `row ${i} (${b.path.source})`;
    must(JSON.stringify(a.methods) === JSON.stringify(b.methods), `${at}: methods ${a.methods} vs ${b.methods}`);
    must(a.path.source === b.path.source && a.path.flags === b.path.flags, `${at}: pattern ${a.path}`);
    must(a.withQuery === b.withQuery, `${at}: withQuery`);
    // The same function, not a copy of it: a predicate edited in one table is edited in both.
    must(a.body === b.body, `${at}: body check`);
    must(a.key === b.key, `${at}: key ${a.key} vs ${b.key}`);
    const unsure = (r: RouteEntry) => (r.refuse !== undefined ? r.unsure : undefined);
    must((a.refuse === undefined) === (b.refuse === undefined) && (unsure(a) === undefined) === (unsure(b) === undefined), `${at}: refuse/unsure`);
    if (b.refuse !== undefined) {
      const prefix = "a program's request through sdk:stamp may not ";
      must(b.refuse.startsWith(prefix) && a.refuse === `api may not ${b.refuse.slice(prefix.length)}`, `${at}: ${JSON.stringify(a.refuse)}`);
    }
  });
  const words = STAMP_ROUTES.flatMap((r) => (r.refuse !== undefined ? [r.refuse, r.unsure] : [])).filter((x): x is string => x !== undefined);
  must(JSON.stringify(words) === JSON.stringify(BRIDGE_WORDS), `the bridge's wording moved: ${JSON.stringify(words)}`);
});

/** Each spelling, its body as the box would send it; `api` gets the same body parsed, as a model's arguments carry it. */
const PARITY: Array<[string, string, string | null, string]> = [
  ["POST", `${V1PR}/approve`, "{}", "refused"],
  ["PUT", `${V1PR}/MERGE`, "{}", "refused"],
  ["PUT", `${V1PR}/merge/`, "{}", "refused"],
  ["PUT", `${V1PR}/queue/req_1`, "{}", "refused"],
  ["DELETE", `${V1PR}/auto-merge`, null, UNLISTED_WRITE_KEY],
  ["DELETE", `${V1PR}/queue/req_1`, null, UNLISTED_WRITE_KEY],
  ["PUT", "/api/v3/repos/o/r/pulls/7/merge", "{}", "refused"],
  ["POST", "/api/v3/repos/o/r/merges", "{}", "refused"],
  ["POST", "/api/v3/graphql", '{"query":"mutation{x}"}', "refused"],
  ["PUT", "/api/v3/repositories/123/pulls/7/merge", "{}", "refused"],
  ["POST", REVIEW, '{"event":"APPROVE"}', "refused"],
  ["POST", `${REVIEW}/55/events`, '{"Event":" approve "}', "refused"],
  ["POST", REVIEW, '{"event":"COMMENT","Event":"APPROVE"}', "refused"],
  ["POST", REVIEW, '{"event":["APPROVE"]}', "refused"],
  ["POST", `${REVIEW}?x=1`, '{"event":"COMMENT"}', "refused"],
  ["POST", REVIEW, '{"event":"REQUEST_CHANGES"}', UNLISTED_WRITE_KEY],
  ["POST", REVIEW, '{"event":"COMMENT","body":"hi"}', "pr_comment"],
  ["PUT", `${REVIEW}/55`, '{"body":"edited"}', "pr_comment"],
  ["POST", "/api/v3/repos/o/r/pulls/7/comments", '{"body":"x"}', "pr_comment"],
  ["POST", `${V1PR}/unapprove`, "{}", "pr_unapprove"],
  ["POST", "/v1/pull-requests", "{}", "pr_create"],
  ["POST", "/api/v3/repos/o/r/issues", "{}", "issue_create"],
  ["POST", "/v1/repositories/o/r/issues/3/comments", "{}", "issue_comment"],
  ["POST", "/api/v3/repos/o/r/labels", '{"name":"x"}', UNLISTED_WRITE_KEY],
  ["DELETE", "/api/v3/repos/o/r/git/refs/heads/x", null, UNLISTED_WRITE_KEY],
  // A matrix parameter and a character outside ASCII: refused by both, on a listed route and an unlisted one alike.
  ["PUT", `${V1PR}/merge;x`, "{}", "refused"],
  ["POST", "/api/v3/repos/o/r/labels;x", '{"name":"x"}', "refused"],
  ["PUT", "/api/v3/repos/o/r/pulls/7/ｍerge", "{}", "refused"],
  ["POST", "/api/v3/repos/o/r/issues/3/commentsé", "{}", "refused"],
  // A space or a control character once decoded: the bridge refuses any escape, api refuses these after decoding.
  ["PUT", "/api/v3/repos/o/r/pulls/7/merge%09", "{}", "refused"],
  ["PUT", "/api/v3/repos/o/r/pulls/7/merge%00", "{}", "refused"],
  ["PUT", "/api/v3/repos/o/r/pulls/7/merge%20", "{}", "refused"],
  // An escape that is not UTF-8, beside one that would spell a merge or an approval once decoded.
  ["PUT", "/api/v3/repos/o%FF/r/pulls/7%2Fmerge", "{}", "refused"],
  ["PUT", "/api/v3/repos/o/r/pulls/7%FF%2Fmerge", "{}", "refused"],
  ["POST", "/api/v3/repos/o/r%FF/pulls/7%2Fapprove", "{}", "refused"],
];

await check("step 4 parity: the bridge and api decide every spelling alike — the same key, or both refuse (; and non-ASCII included)", async () => {
  const keyed = { request: "allow", pr_comment: "approval", pr_create: "approval", pr_unapprove: "approval", issue_create: "approval", issue_comment: "approval" };
  for (const [method, path, body, want] of PARITY) {
    const m = await mount({ tools: keyed });
    const r = await m.request(method, path, body);
    const card = (await m.store.listApprovals("t", "pending"))[0]?.request as any;
    const bridge = r.status === "rejected" && (r.error?.code === "route_refused" || r.error?.code === "bad_request") ? "refused"
      : r.status === "pending" ? card?.policyKey : `${r.status} ${r.error?.code}`;
    const args = { method, path, ...(body === null ? {} : { body: JSON.parse(body) }) };
    const { route } = apiRoute(method, path, args.body);
    const api = route.kind === "refused" ? "refused" : route.kind === "unlisted-read" ? "read" : route.key;
    const hook = stampPlugin.policyKey!("api", args as any);
    must(bridge === want && api === want, `${method} ${path} ${body}: bridge ${bridge}, api ${api}, want ${want}`);
    must(hook === (want === "refused" ? undefined : want), `${method} ${path}: policyKey ${hook}`);
  }
  must(seen.length === 0, `reached upstream: ${JSON.stringify(seen)}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
