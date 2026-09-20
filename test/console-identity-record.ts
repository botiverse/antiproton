/**
 * The badge, from the record the gateway actually writes.
 *
 * `test/console-events.ts` asks what the card draws for a given event, and
 * `test/call-id-in-the-record.ts` asks what the store keeps. Both are green
 * against a payload each of them spells out, so between them sits a stretch
 * nobody is asking about: whether the event the gateway writes is still the
 * event the page knows how to read. A key renamed in `completedPayload` moves
 * the store and its own test together and leaves the page silently unjoined —
 * the badge stops appearing, and no suite says why (@cody's undefined sabotage
 * went green for the same reason one layer down, 2026-09-20).
 *
 * So this runs a failing call through a real gateway and a real store, takes
 * the `operation.completed` it wrote, and hands it to `eventList` beside the
 * `tool.result` the transcript would carry. Nothing here writes a payload by
 * hand: the key the page joins on comes from the producer, so a rename breaks
 * this test rather than the page.
 */
import { SqliteStore } from "../src/store/sqlite.ts";
import { DurableObjectStore } from "../src/store/durable-object.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { eventList } from "../cf/src/ui.ts";
import type { Plugin } from "../src/plugins/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const caller = { tenantId: "t", agentId: "a", taskId: "k" };
const CALL = "toolu_page";

/** A plugin that fails the way `github.ts` does: the sentence for a person, the fields for a page. */
const refusing = (identity: string, credentialRef?: string): Plugin => ({
  id: "svc", version: "1.0.0", defaultForAllAgents: true,
  tools: [{ name: "go", summary: "", parameters: {}, sideEffects: "read", idempotency: "native" }],
  async invoke() {
    const e: Error & { identity?: string; credentialRef?: string } =
      new Error("svc.go: 403 forbidden — this call was anonymous: the `svc` mount has no account attached");
    e.identity = identity;
    if (credentialRef) e.credentialRef = credentialRef;
    throw e;
  },
});

const BACKENDS = {
  sqlite: async () => { const s = new SqliteStore(":memory:"); await s.init(); return s; },
  "durable-object": async () => {
    const host = sqliteHost();
    const s = new DurableObjectStore({ storage: { sql: host.sql, transactionSync: host.transactionSync } } as any);
    await s.init();
    return s;
  },
} as const;

/** One refused call, and the event the store kept for it. */
async function recorded(identity: string, credentialRef: string | undefined, backend: keyof typeof BACKENDS) {
  const store: any = await BACKENDS[backend]();
  await store.createAgent("t", "a");
  await store.addMount({
    tenantId: "t", agentId: "a", alias: "svc", plugin: "svc", installationId: "i", connectionId: null,
    toolVersion: "1.0.0", publicConfig: {}, secretRef: null, policy: null,
  });
  const gw = new ToolGateway(store, [refusing(identity, credentialRef)], { async resolve() { return null; } });
  const r: any = await gw.invoke(caller, "svc.go", {}, { callId: CALL });
  must(r.status !== "succeeded", "the call was supposed to fail");
  const [op] = (await store.taskEvents("t", "k")).filter((e: any) => e.kind === "operation.completed");
  must(op, "the store kept no operation.completed for a finished call");
  return op;
}

/** The page's side of the same call: what the transcript carries for it. */
const page = (op: any) => eventList([
  { sequence: 1, kind: "model.response", payload: { toolCalls: [{ id: CALL, name: "svc.go", arguments: {} }] }, createdAt: 1_000 },
  { sequence: 2, kind: "tool.result", payload: { tool: "svc.go", callId: CALL, isError: true, status: "rejected", result: "svc.go: 403 forbidden" }, createdAt: 2_000 },
  { sequence: Number(op.sequence ?? 3), kind: op.kind, payload: op.payload, createdAt: Number(op.createdAt ?? 3_000) },
]);

for (const backend of Object.keys(BACKENDS) as Array<keyof typeof BACKENDS>) {
  await check(`a refused call reaches the card as a badge, through the real record (${backend})`, async () => {
    const op = await recorded("none", undefined, backend);
    const html = page(op);
    must(/id="call-toolu_page"/.test(html), "the call row is there to badge");
    must(/anonymous · no account/.test(html),
      `the record the gateway wrote did not reach the badge: ${JSON.stringify(op.payload)}`);
  });
}

await check("who can fix it survives the round trip too, not only the state", async () => {
  const op = await recorded("unreadable", "operator", "durable-object");
  const html = page(op);
  must(/anonymous · credential unreadable/.test(html), "the state arrived");
  must(/whoever deploys/.test(html),
    `the kind of credential did not arrive, so the badge would send the reader to the wrong person: ${JSON.stringify(op.payload)}`);
});

await check("the page joins on the producer's key, not on a name a test wrote down", async () => {
  // The join is worth only as much as the key it is made on, and this is the
  // one assertion that would notice a rename: the payload is the store's, and
  // the id in it is the one the page looks a call up by.
  const op = await recorded("none", undefined, "sqlite");
  must(op.payload?.callId === CALL,
    `the record names the call as ${JSON.stringify(op.payload?.callId)}, and the card looks it up by callId`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"}  ${r.name}${r.error ? ` — ${r.error}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
