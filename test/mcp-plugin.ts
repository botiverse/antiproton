/**
 * A remote MCP server as a mount: its tools are the mount's tools, learned when
 * the mount is added or refreshed and read from the mount record everywhere
 * else.
 *
 * The server is in-process: a `fetch` that speaks Streamable HTTP JSON-RPC, put
 * in place of `globalThis.fetch`, which is what pi-mcp's transport calls. No
 * network is reached. Through the real gateway, the real sqlite store and the
 * real discovery plugin, so "the catalogue offers it and the gateway refuses
 * it" cannot hide between two fixtures.
 */
import { readFileSync } from "node:fs";
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { agentRef, KEPT_PREFIX } from "../src/runtime/secrets.ts";
import { qualifyMountedTools } from "../src/runtime/pi-tools.ts";
import { validateMount } from "../src/runtime/mount-config.ts";
import { builtinToolsPlugin } from "../src/plugins/builtin.ts";
import { mcpPlugin, parseHeaderLines, serverUrlProblem, toolSchemaOf } from "../src/plugins/mcp.ts";
import { toolsOf, type Plugin } from "../src/plugins/types.ts";
import { AgentRuntime, catalogueKey, installedRows, mountedToolEntries } from "../cf/src/runtime.ts";
import { catalogue, mountFragment } from "../cf/src/ui.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

// ---- the fake server -------------------------------------------------------

type RemoteTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: Record<string, boolean> };
type Seen = { method: string; rpc: string | null; headers: Record<string, string> };

const ECHO: RemoteTool = { name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } }, annotations: { readOnlyHint: true } };
const WRITE: RemoteTool = { name: "save", description: "Save text", inputSchema: { type: "object", properties: {} } };
const DASHED: RemoteTool = { name: "get-weather", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
const DOTTED: RemoteTool = { name: "ns.find", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };

/** A server answering initialize, tools/list and tools/call, recording every request it receives. */
function fakeServer(opts: {
  tools: () => RemoteTool[];
  call?: (name: string, args: any, headers: Record<string, string>) => unknown;
  failCall?: "http-503" | "rpc-error";
}) {
  const seen: Seen[] = [];
  let sessions = 0;
  const fetch = async (input: unknown, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    const method = String(init.method ?? "GET");
    if (method !== "POST") {
      seen.push({ method, rpc: null, headers });
      return new Response(null, { status: method === "DELETE" ? 200 : 405 });
    }
    const msg = JSON.parse(String(init.body));
    seen.push({ method, rpc: msg.method ?? null, headers });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const json = (result: unknown, extra: Record<string, string> = {}) => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }), { status: 200, headers: { "content-type": "application/json", ...extra } });
    if (msg.method === "initialize") {
      sessions++;
      return json({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "0" } },
        { "mcp-session-id": `s${sessions}` });
    }
    if (msg.method === "tools/list") return json({ tools: opts.tools() });
    if (msg.method === "tools/call" && opts.failCall === "http-503") return new Response("overloaded", { status: 503 });
    if (msg.method === "tools/call" && opts.failCall === "rpc-error") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "bad arguments" } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    if (msg.method === "tools/call") {
      return json(opts.call ? opts.call(msg.params.name, msg.params.arguments, headers)
        : { content: [{ type: "text", text: `echo: ${msg.params.arguments?.text}` }] });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, seen };
}

const realFetch = globalThis.fetch;
function serve(server: { fetch: (i: unknown, init?: RequestInit) => Promise<Response> }) {
  globalThis.fetch = server.fetch as typeof fetch;
}

// ---- the fixture -----------------------------------------------------------

const URL_ = "https://mcp.example.test/mcp";
const ctx = { tenantId: "t", agentId: "a", taskId: "k" };

async function fixture(config: Record<string, unknown> = { url: URL_ }, secrets: Record<string, string> = {}) {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "srv", plugin: "mcp", installationId: "i", connectionId: null,
    toolVersion: mcpPlugin.version, publicConfig: config as any, secretRef: null, policy: null,
  });
  const plugins: Plugin[] = [mcpPlugin];
  const builtin = builtinToolsPlugin(store, () => plugins);
  plugins.push(builtin);
  const resolver = {
    async resolve(ref: string) {
      for (const [name, value] of Object.entries(secrets)) if (ref === agentRef(KEPT_PREFIX + name)) return value;
      return null;
    },
  };
  const gw = new ToolGateway(store, plugins, new Set(["mcp", "tools"]), resolver);
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "tools", plugin: "tools", installationId: "i2", connectionId: null,
    toolVersion: builtin.version, publicConfig: {}, secretRef: null, policy: null,
  });
  return { store, gw, plugins };
}

// ---- mapping ---------------------------------------------------------------

await check("only readOnlyHint: true makes a read; destructive, missing or false annotations make a write; idempotency is always none", () => {
  const schema = { type: "object" };
  const of = (annotations?: Record<string, boolean>) => toolSchemaOf({ name: "x", inputSchema: schema, annotations } as any);
  must(of({ readOnlyHint: true }).sideEffects === "read", "readOnlyHint: true is a read");
  must(of(undefined).sideEffects === "write", "no annotations must be a write");
  must(of({}).sideEffects === "write", "empty annotations must be a write");
  must(of({ readOnlyHint: false }).sideEffects === "write", "readOnlyHint: false must be a write");
  must(of({ destructiveHint: true }).sideEffects === "write", "destructiveHint must be a write");
  must(of({ readOnlyHint: true, destructiveHint: true }).sideEffects === "write",
    "read-only and destructive at once must resolve to the conservative side");
  for (const a of [undefined, { readOnlyHint: true }, { idempotentHint: true }]) {
    must(of(a as any).idempotency === "none", `idempotency must be none for ${JSON.stringify(a)}`);
  }
});

// ---- settings --------------------------------------------------------------

await check("settings: a complete mount is accepted, a misspelt key is refused, and the plugin's own checks hold", () => {
  must(validateMount(mcpPlugin, { url: URL_, headers: ["Authorization: Bearer {{tok}}"] }, null).length === 0, "a complete mount was refused");
  must(validateMount(mcpPlugin, { url: URL_, header: ["x: y"] }, null).some((p) => /did you mean "headers"/.test(p.message)),
    "a misspelt setting was not refused");
  must(validateMount(mcpPlugin, {}, null).some((p) => p.key === "url"), "a mount with no url was accepted");
  must(serverUrlProblem(URL_) === null, "an https endpoint with a path was refused");
  must(serverUrlProblem("http://mcp.example.test/mcp") !== null, "plain http to a public host was accepted");
  must(serverUrlProblem("http://127.0.0.1:8799/mcp") === null, "http to loopback was refused");
  const reserved = parseHeaderLines(["Mcp-Session-Id: s1"]);
  must(!reserved.ok && /written by the MCP transport/.test(reserved.error), "a session id header was accepted");
  must(!parseHeaderLines(["no colon here"]).ok, "a line without a name was accepted");
});

// ---- snapshot, catalogue, gateway, discovery --------------------------------

await check("the snapshot reaches the catalogue and the gateway: a listed tool is offered and callable, an unlisted one is unknown_tool", async () => {
  const server = fakeServer({ tools: () => [ECHO, WRITE] });
  serve(server);
  try {
    const { store, gw, plugins } = await fixture();
    const r = await gw.refreshMountTools("t", "a", "srv");
    must(r.ok && r.changed, `refresh: ${JSON.stringify(r)}`);
    const mounts = await store.listMounts("t", "a");
    const entries = mountedToolEntries(mounts, new Map(plugins.map((p) => [p.id, p])));
    const addresses = entries.map((e) => e.address);
    must(addresses.includes("srv.echo") && addresses.includes("srv.save"), `the catalogue offers ${addresses.join()}`);
    must(entries.find((e) => e.address === "srv.echo")!.sideEffects === "read", "echo lost its read");
    must(entries.find((e) => e.address === "srv.save")!.sideEffects === "write", "save is not a write");

    const ok: any = await gw.invoke(ctx, "srv.echo", { text: "hi" });
    must(ok.status === "succeeded", `a snapshot tool was not callable: ${JSON.stringify(ok)}`);
    must(ok.result.content[0].text === "echo: hi", `result: ${JSON.stringify(ok.result)}`);
    const unknown: any = await gw.invoke(ctx, "srv.absent", {});
    must(unknown.status === "rejected" && unknown.error?.code === "unknown_tool", `a name not in the snapshot: ${JSON.stringify(unknown)}`);
  } finally { globalThis.fetch = realFetch; }
});

await check("a mount with no snapshot offers nothing and calls nothing", async () => {
  const { store, gw, plugins } = await fixture();
  const mounts = await store.listMounts("t", "a");
  must(mountedToolEntries(mounts, new Map(plugins.map((p) => [p.id, p]))).every((e) => !e.address.startsWith("srv.")),
    "a mount that was never listed offered tools");
  const r: any = await gw.invoke(ctx, "srv.echo", {});
  must(r.error?.code === "unknown_tool", `got ${JSON.stringify(r)}`);
});

await check("a remote name an agent cannot address is skipped at snapshot time, absent from catalogue, gateway and describe, and diagnosed", async () => {
  serve(fakeServer({ tools: () => [ECHO, DASHED, DOTTED, { ...ECHO, description: "second echo" }] }));
  try {
    const { store, gw, plugins } = await fixture();
    const r = await gw.refreshMountTools("t", "a", "srv");
    must(r.ok, `refresh: ${JSON.stringify(r)}`);
    const mount = (await store.getMountByAlias("t", "a", "srv"))!;
    // Filtered in the stored list itself, so every reader of toolsOf reads the same thing.
    const stored = mount.toolSnapshot!.tools.map((t) => t.name);
    must(stored.join() === "echo", `the stored snapshot holds ${stored.join()}`);
    must(toolsOf(mcpPlugin, mount).map((t) => t.name).join() === "echo", "toolsOf does not serve the stored list");
    const skipped = mount.toolSnapshot!.skipped.map((s) => s.name);
    must(skipped.includes("get-weather") && skipped.includes("ns.find"), `skipped: ${skipped.join()}`);
    must(mount.toolSnapshot!.skipped.some((s) => s.name === "echo" && /more than once/.test(s.reason)), "the duplicate was not diagnosed");

    const addresses = mountedToolEntries([mount], new Map(plugins.map((p) => [p.id, p]))).map((e) => e.address);
    must(!addresses.some((a) => a.includes("weather") || a.includes("find")), `the catalogue offers a skipped name: ${addresses.join()}`);
    const dotted: any = await gw.invoke(ctx, "srv.ns.find", {});
    must(dotted.status === "rejected" && dotted.error?.code === "unknown_tool", `a skipped dotted name reached the plugin: ${JSON.stringify(dotted)}`);

    const described: any = await gw.invoke(ctx, "tools.describe", { name: "srv.ns.find" });
    must(described.status === "succeeded" && described.result.error === "unknown tool", `describe of a skipped name: ${JSON.stringify(described)}`);
    const searched: any = await gw.invoke(ctx, "tools.search", { query: "weather" });
    const found = JSON.stringify(searched.result);
    must(searched.status === "succeeded" && found.includes("srv__echo"), `search did not answer with the catalogue: ${found}`);
    must(!/weather|ns[._]find/.test(found), `search found a skipped name: ${found}`);

    const listed: any = await gw.invoke(ctx, "tools.mounts", {});
    const srv = listed.result.find((m: any) => m.alias === "srv");
    must(srv?.notOffered?.some((n: string) => n.includes("get-weather")), `tools.mounts does not say why: ${JSON.stringify(srv)}`);
  } finally { globalThis.fetch = realFetch; }
});

await check("describe and search answer for a snapshot tool (the catalogue and the schema lookup read one list)", async () => {
  serve(fakeServer({ tools: () => [ECHO, WRITE] }));
  try {
    const { gw } = await fixture();
    await gw.refreshMountTools("t", "a", "srv");
    const searched: any = await gw.invoke(ctx, "tools.search", { query: "echo" });
    must(searched.status === "succeeded", `search: ${JSON.stringify(searched)}`);
    must(Array.isArray(searched.result), `search found nothing for "echo": ${JSON.stringify(searched.result)}`);
    const hit = (searched.result as any[]).find((t) => t.plugin === "mcp");
    must(hit?.name === "srv__echo", `search did not find the remote tool: ${JSON.stringify(searched.result)}`);
    for (const name of ["srv__echo", "srv.echo", "echo"]) {
      const d: any = await gw.invoke(ctx, "tools.describe", { name });
      must(d.status === "succeeded", `describe ${name} failed: ${JSON.stringify(d)}`);
      must(JSON.stringify(d.result.parameters) === JSON.stringify(ECHO.inputSchema), `describe ${name} gave ${JSON.stringify(d.result)}`);
      must(d.result.idempotency === "none", `describe ${name} lost the idempotency`);
    }
  } finally { globalThis.fetch = realFetch; }
});

// ---- version pin and refresh ------------------------------------------------

await check("the snapshot hash is not the version pin: the pin stays the plugin's version and calls pass it", async () => {
  serve(fakeServer({ tools: () => [ECHO] }));
  try {
    const { store, gw } = await fixture();
    const r = await gw.refreshMountTools("t", "a", "srv");
    must(r.ok, JSON.stringify(r));
    const mount = (await store.getMountByAlias("t", "a", "srv"))!;
    must(mount.toolVersion === mcpPlugin.version, `the pin moved to ${mount.toolVersion}`);
    must(mount.toolSnapshot!.hash !== mount.toolVersion && /^[0-9a-f]{64}$/.test(mount.toolSnapshot!.hash), "the hash is not a hash");
    const call: any = await gw.invoke(ctx, "srv.echo", { text: "x" });
    must(call.status === "succeeded", `the version check refused a refreshed mount: ${JSON.stringify(call)}`);
  } finally { globalThis.fetch = realFetch; }
});

await check("a refresh replaces the snapshot only when the list changed, and the harness key follows the hash", async () => {
  let tools = [ECHO];
  serve(fakeServer({ tools: () => tools }));
  try {
    const { store, gw } = await fixture();
    const first = await gw.refreshMountTools("t", "a", "srv");
    must(first.ok && first.changed, `first: ${JSON.stringify(first)}`);
    const before = (await store.getMountByAlias("t", "a", "srv"))!;
    const key = catalogueKey([before], {});
    await new Promise((r) => setTimeout(r, 5));
    const same = await gw.refreshMountTools("t", "a", "srv");
    must(same.ok && !same.changed, `the same list was reported as a change: ${JSON.stringify(same)}`);
    const after = (await store.getMountByAlias("t", "a", "srv"))!;
    must(after.toolSnapshot!.takenAt === before.toolSnapshot!.takenAt, "the stored snapshot was rewritten for an unchanged list");
    must(catalogueKey([after], {}) === key, "an unchanged list moved the harness key");

    tools = [ECHO, WRITE];
    const moved = await gw.refreshMountTools("t", "a", "srv");
    must(moved.ok && moved.changed, `a changed list was not a change: ${JSON.stringify(moved)}`);
    const now = (await store.getMountByAlias("t", "a", "srv"))!;
    must(now.toolSnapshot!.tools.map((t) => t.name).join() === "echo,save", "the new list was not stored");
    must(catalogueKey([now], {}) !== key, "a changed list left the harness key as it was, so a cached harness keeps the old tools");
  } finally { globalThis.fetch = realFetch; }
});

await check("a refresh that fails leaves the stored list as it was", async () => {
  serve(fakeServer({ tools: () => [ECHO] }));
  const { store, gw } = await fixture();
  try { await gw.refreshMountTools("t", "a", "srv"); } finally { globalThis.fetch = realFetch; }
  globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
  try {
    const r = await gw.refreshMountTools("t", "a", "srv");
    must(!r.ok && /could not list srv's tools/.test(r.error), `got ${JSON.stringify(r)}`);
    must((await store.getMountByAlias("t", "a", "srv"))!.toolSnapshot!.tools[0]!.name === "echo", "a failed refresh lost the list");
  } finally { globalThis.fetch = realFetch; }
});

// ---- secrets in headers ------------------------------------------------------

await check("a {{name}} header is filled from the agent's kept secret on every request, and an echo of it is hidden", async () => {
  const server = fakeServer({
    tools: () => [ECHO],
    call: (_n, _a, headers) => ({ content: [{ type: "text", text: `you sent ${headers["authorization"]}` }] }),
  });
  serve(server);
  try {
    const { gw } = await fixture({ url: URL_, headers: ["Authorization: Bearer {{tok}}", "X-Plain: v"] }, { tok: "sk-very-secret" });
    must((await gw.refreshMountTools("t", "a", "srv")).ok, "refresh failed");
    const r: any = await gw.invoke(ctx, "srv.echo", { text: "x" });
    must(r.status === "succeeded", JSON.stringify(r));
    const posts = server.seen.filter((s) => s.method === "POST");
    must(posts.length > 0 && posts.every((s) => s.headers["authorization"] === "Bearer sk-very-secret"),
      `a request went without the filled header: ${JSON.stringify(posts.map((p) => p.headers["authorization"]))}`);
    must(posts.every((s) => s.headers["x-plain"] === "v"), "a plain header was not sent");
    const text = r.result.content[0].text as string;
    must(!text.includes("sk-very-secret") && text.includes("[secret tok]"), `the echo reached the model: ${text}`);
  } finally { globalThis.fetch = realFetch; }
});

await check("a {{name}} with no kept secret fails before anything is sent, and says how to fix it", async () => {
  const server = fakeServer({ tools: () => [ECHO] });
  serve(server);
  try {
    const { gw } = await fixture({ url: URL_, headers: ["Authorization: Bearer {{missing}}"] });
    const r = await gw.refreshMountTools("t", "a", "srv");
    must(!r.ok && /no secret named missing/.test(r.error), `got ${JSON.stringify(r)}`);
    must(server.seen.length === 0, "a request went out with an unfilled header");
  } finally { globalThis.fetch = realFetch; }
});

await check("a tool that reports isError is a tool_error carrying its text", async () => {
  serve(fakeServer({ tools: () => [ECHO], call: () => ({ isError: true, content: [{ type: "text", text: "no such city" }] }) }));
  try {
    const { gw } = await fixture();
    await gw.refreshMountTools("t", "a", "srv");
    const r: any = await gw.invoke(ctx, "srv.echo", { text: "x" });
    must(r.status === "failed" && r.error?.code === "tool_error" && /no such city/.test(r.error.message), JSON.stringify(r));
  } finally { globalThis.fetch = realFetch; }
});

await check("a call lost on the way (5xx) is unknown, since it may have run; a protocol refusal is failed", async () => {
  for (const [failCall, want] of [["http-503", "unknown"], ["rpc-error", "failed"]] as const) {
    serve(fakeServer({ tools: () => [ECHO], failCall }));
    try {
      const { gw } = await fixture();
      await gw.refreshMountTools("t", "a", "srv");
      const r: any = await gw.invoke(ctx, "srv.echo", { text: "x" });
      must(r.status === want && r.error?.code === "tool_error", `${failCall}: ${JSON.stringify(r)}`);
    } finally { globalThis.fetch = realFetch; }
  }
});

// ---- pi-mcp's behavioural contracts (docs/pi-upstream.md) --------------------

await check("pi-mcp: every connection initializes again, with no session id carried over, and no GET stream is opened", async () => {
  const server = fakeServer({ tools: () => [ECHO] });
  serve(server);
  try {
    const { gw } = await fixture();
    await gw.refreshMountTools("t", "a", "srv");
    await gw.invoke(ctx, "srv.echo", { text: "1" });
    await gw.invoke(ctx, "srv.echo", { text: "2" });
    const inits = server.seen.filter((s) => s.rpc === "initialize");
    must(inits.length === 3, `three connections made ${inits.length} initialize requests`);
    must(inits.every((s) => !s.headers["mcp-session-id"]), "an initialize carried a session id from an earlier connection");
    // Within one connection the session the server assigned is used: the transport does follow it.
    must(server.seen.some((s) => s.rpc === "tools/call" && s.headers["mcp-session-id"]), "the call did not carry its own session");
    must(!server.seen.some((s) => s.method === "GET"), "a GET stream was opened");
  } finally { globalThis.fetch = realFetch; }
});

await check("pi-mcp: the plugin imports only the HTTP client, and its bundle carries no child_process", async () => {
  const source = readFileSync(new URL("../src/plugins/mcp.ts", import.meta.url), "utf8");
  const imports = [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@earendil-works\/pi-mcp[^"]*"/g)];
  must(imports.length === 1, `expected one import from pi-mcp, found ${imports.length}`);
  const names = imports[0]![1]!.split(",").map((s) => s.trim()).filter(Boolean).sort();
  must(names.join() === "McpClient,StreamableHttpTransport,toLlmContent", `pi-mcp names imported: ${names.join()}`);
  const esbuild = await import("esbuild");
  const bundle = async (entry: { path?: string; contents?: string }) => {
    const out = await esbuild.build({
      ...(entry.path ? { entryPoints: [entry.path] } : { stdin: { contents: entry.contents!, resolveDir: process.cwd(), loader: "ts" } }),
      bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
    });
    return out.outputFiles[0]!.text;
  };
  // The positive control: the same check does see the stdio transport when it is imported.
  const withStdio = await bundle({ contents: `import { StdioTransport } from "@earendil-works/pi-mcp"; console.log(StdioTransport);` });
  must(/child_process/.test(withStdio), "the control bundle has no child_process, so this check cannot see it");
  const plugin = await bundle({ path: new URL("../src/plugins/mcp.ts", import.meta.url).pathname });
  must(!/child_process|cross-spawn/.test(plugin), "the plugin's bundle pulls in the stdio transport");
});

// ---- creation through the runtime -------------------------------------------

await check("adding the mount through the runtime takes the snapshot, and the runtime's gateway serves it", async () => {
  serve(fakeServer({ tools: () => [ECHO] }));
  try {
    const host = sqliteHost();
    const rt: any = new AgentRuntime({
      ctx: { storage: { sql: host.sql, transactionSync: host.transactionSync } } as any,
      bucket: {} as any, bucketName: "b", models: { resolve: () => null } as any, extraPlugins: [],
    } as any);
    await rt.store.init();
    rt.ready = async () => {};
    await rt.store.createAgent("t", "a");
    await rt.store.setPluginChoice("t", "a", "mcp", "enable");
    const added = await rt.addMount("t", "a", { alias: "srv", plugin: "mcp", config: { url: URL_ } });
    must(added.ok && added.added && added.tools?.ok && added.tools.tools.join() === "echo", `add: ${JSON.stringify(added)}`);
    const m = await rt.store.getMountByAlias("t", "a", "srv");
    must(m?.toolSnapshot?.tools?.[0]?.name === "echo", "the snapshot was not stored at creation");
    const call: any = await rt.gateway().invoke(ctx, "srv.echo", { text: "y" });
    must(call.status === "succeeded", JSON.stringify(call));
    const named = qualifyMountedTools(mountedToolEntries(await rt.store.listMounts("t", "a"), new Map(rt.plugins().map((p: Plugin) => [p.id, p]))));
    must(named.some((t) => t.name === "srv__echo"), `the runtime's catalogue: ${named.map((t) => t.name).join()}`);
    const refreshed = await rt.refreshMountTools("t", "a", "srv");
    must(refreshed.ok && !refreshed.changed, `refresh: ${JSON.stringify(refreshed)}`);
  } finally { globalThis.fetch = realFetch; }
});

// ---- where the snapshot is kept, and where a person reads it -----------------

await check("an object whose mounts table predates the snapshot gains the column, and old rows read as no snapshot", async () => {
  const host = sqliteHost();
  // The mounts table as it was before the snapshot existed, with a row in it.
  host.sql.exec(`CREATE TABLE mounts (
     tenant_id TEXT NOT NULL, agent_id TEXT NOT NULL, alias TEXT NOT NULL, installation_id TEXT NOT NULL,
     connection_id TEXT, plugin TEXT NOT NULL, tool_version TEXT NOT NULL, public_config TEXT NOT NULL,
     secret_ref TEXT, policy TEXT, PRIMARY KEY (tenant_id, agent_id, alias))`);
  host.sql.exec(`INSERT INTO mounts VALUES ('t','a','old','i',NULL,'http','1.0.0','{}',NULL,NULL)`);
  const store = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
  await store.init();
  const old = await store.getMountByAlias("t", "a", "old");
  must(old && old.toolSnapshot === null, `the old row: ${JSON.stringify(old)}`);
  const snap = { hash: "h", tools: [], skipped: [{ name: "a-b", reason: "r" }], takenAt: 1 };
  must(await store.updateMountToolSnapshot("t", "a", "old", snap), "the update found no row");
  must((await store.getMountByAlias("t", "a", "old"))!.toolSnapshot!.skipped[0]!.name === "a-b", "the snapshot did not round-trip");
});

await check("the console says where an MCP plugin's tools come from, and shows a mount's skipped tools", () => {
  const rows = installedRows([mcpPlugin], {}, new Set());
  must(rows[0]!.toolsPerMount === true, "the row does not say its tools are per mount");
  const html = catalogue({ installed: rows, mounts: [], used: {} });
  must(html.includes("tools listed by each mount&#39;s server") || html.includes("tools listed by each mount's server"),
    "the catalogue does not say the tools come from the server");
  must(!/0 tools/.test(html), "the catalogue reports an MCP plugin as having 0 tools");
  const mount = {
    alias: "srv", plugin: "mcp", version: "1.0.0", config: { url: URL_ }, problems: [], tools: ["srv__echo"],
    toolNotes: ['remote tool "get-weather" is not offered: not a name an agent can address'],
  };
  const page = mountFragment({ installed: rows, mounts: [mount], used: {} }, "srv");
  must(page.includes("get-weather"), "the mount's page does not show the skipped tool");
});

console.log(`\n  MCP plugin\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
