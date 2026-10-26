/**
 * `ctx.sibling` answers null alike for a missing mount and for one the agent cannot call (PluginContext.sibling).
 * Two of its callers turn that null into something a person reads: raftbench's wake error, and the trace row
 * appworld writes for a second account's token it left unset. And that row is only written because its kind is
 * listed (`PLUGIN_TRACE_KINDS`): the gateway drops any other kind without a word, so the last case counts rows, not
 * "it did not throw". The appworld cases use a hand-built `ctx.trace`, so they cannot show the list; only the last
 * case can.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { appworldPlugins, SESSION_KEY, SESSION_STORE, type Catalogue } from "../src/plugins/appworld.ts";
import { raftbenchPlugin } from "../src/plugins/raftbench.ts";
import { setLogSink } from "../src/core/log.ts";
import type { Plugin, PluginContext } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

/** A database that keeps what it is given, per store. */
function memoryDb() {
  const m = new Map<string, unknown>();
  return {
    async get(store: string, key: string) { return m.get(`${store}/${key}`); },
    async put(store: string, value: unknown, key: string) { m.set(`${store}/${key}`, value); return key; },
    async delete(store: string, key: string) { m.delete(`${store}/${key}`); },
  } as any;
}

function context(sibling: PluginContext["sibling"], extra: Partial<PluginContext> = {}): PluginContext {
  return {
    caller: { tenantId: "t", agentId: "a" }, alias: "m", credential: null, publicConfig: {},
    db: memoryDb(), sibling, ...extra,
  } as unknown as PluginContext;
}

// raftbench: the wake error a person reads in the log.

async function wakeError(sibling: PluginContext["sibling"]): Promise<string> {
  const lines: string[] = [];
  setLogSink((l) => lines.push(l));
  try {
    await raftbenchPlugin.wake!(context(sibling, { publicConfig: { serverUrl: "https://raft.example", raftMount: "raft" } }));
  } finally { setLogSink(null); }
  const failed = lines.map((l) => JSON.parse(l)).find((l) => l.step === "wake_failed");
  assert(failed, `no wake_failed line: ${JSON.stringify(lines)}`);
  return String(failed.error);
}

await check("raftbench: a null sibling is reported as not callable, pointing at sibling's contract, not as absent", async () => {
  const error = await wakeError(async () => null);
  assert(error === "the raft mount is not callable (see PluginContext.sibling)", `the error reads: ${error}`);
  assert(!/^no raft mount named/.test(error), `the error still says the mount is absent: ${error}`);
});

await check("raftbench: a mount that is there but not raft says so, apart from a null one", async () => {
  const error = await wakeError(async () => ({ credential: "c", db: memoryDb(), plugin: "github", policy: null }));
  assert(error === "the raft mount is not a raft mount", `the error reads: ${error}`);
});

// appworld: the second account's token, left unset.

const catalogue: Catalogue = {
  shop: {
    description: "",
    apis: [{
      app_name: "shop", api_name: "share", path: "/share", method: "POST", description: "",
      parameters: [
        { name: "item", type: "string", required: true, description: "", default: null, constraints: [] },
        { name: "drive_access_token", type: "string", required: false, description: "", default: null, constraints: [] },
      ],
    }],
  },
};
const [shop] = appworldPlugins(catalogue, { apiBaseUrl: "https://aw.example", apps: ["shop"] });

async function share(sibling: PluginContext["sibling"]) {
  const sent: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ shared: true }), { status: 200 });
  }) as any;
  const rows: any[] = [];
  try {
    const result = await shop!.invoke("share", { item: "x" }, context(sibling, { trace: (r) => rows.push(r) }));
    return { result, sent, rows };
  } finally { globalThis.fetch = original; }
}

await check("appworld: a null sibling leaves the token unset, the result the API's own, and one row saying why", async () => {
  const { result, sent, rows } = await share(async () => null);
  assert(JSON.stringify(result) === JSON.stringify({ shared: true }), `the result was changed: ${JSON.stringify(result)}`);
  assert(sent.length === 1 && !("drive_access_token" in sent[0]), `the request: ${JSON.stringify(sent)}`);
  assert(rows.length === 1 && rows[0].kind === "appworld.sibling_unset" && rows[0].status === "not_callable"
    && rows[0].attrs.param === "drive_access_token" && rows[0].attrs.sibling === "drive", `rows: ${JSON.stringify(rows)}`);
});

await check("appworld: a sibling with no credential is told apart from a null one", async () => {
  const { rows } = await share(async () => ({ credential: null, db: memoryDb(), plugin: "drive", policy: null }));
  assert(rows.length === 1 && rows[0].status === "no_credential", `rows: ${JSON.stringify(rows)}`);
});

await check("appworld: a callable sibling sets the token and writes no row (control)", async () => {
  const db = memoryDb();
  await db.put(SESSION_STORE, { token: "drive-token", obtainedAt: Date.now() }, SESSION_KEY);
  const { sent, rows } = await share(async () => ({ credential: "{}", db, plugin: "drive", policy: null }));
  assert(sent[0]?.drive_access_token === "drive-token", `the request: ${JSON.stringify(sent)}`);
  assert(rows.length === 0, `rows: ${JSON.stringify(rows)}`);
  assert(!JSON.stringify(rows).includes("drive-token"), "a row carries the token");
});

// The gateway: only a listed kind reaches the store.

await check("the gateway writes a listed plugin kind and drops an unlisted one: the rows handed to the store are counted", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("t", "a");
  await store.createTask("t", "a", "k", {});
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "w", plugin: "writer", installationId: "i-w", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  const traced: any[] = [];
  const record = store.recordTrace.bind(store);
  store.recordTrace = async (rows) => { traced.push(...rows); return record(rows); };
  const writer: Plugin = {
    id: "writer", version: "1.0.0",
    tools: [{ name: "write", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
    async invoke(_t, args, c) {
      c.trace?.({ kind: (args as { kind: string }).kind as any, status: "s", verdict: "ok", attrs: {} });
      return { wrote: true };
    },
  };
  const gw = new ToolGateway(store, [writer], new Set(["writer"]), { async resolve() { return null; } } as any);
  const write = async (kind: string) => {
    const r: any = await gw.invoke({ tenantId: "t", agentId: "a", taskId: "k" }, "w.write", { kind });
    assert(r.status === "succeeded", `the call did not run: ${JSON.stringify(r)}`);
    return traced.filter((row) => row.kind === kind).length;
  };
  assert(await write("appworld.sibling_unset") === 1, "control: a listed kind was not written");
  assert(await write("appworld.not_listed") === 0, "an unlisted kind was written");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const passed = results.filter((r) => r.ok).length;
console.log(`${passed}/${results.length} passed`);
if (passed !== results.length) process.exit(1);
