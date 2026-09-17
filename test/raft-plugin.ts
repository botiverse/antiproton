import { raftPlugin } from "../src/plugins/raft.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { SqliteStore } from "../src/store/sqlite.ts";

const originalFetch = globalThis.fetch;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];

async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

function ctx(credential: string | null = "sk_agent_test_1234567890", config: Record<string, unknown> = {}) {
  return {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "task" },
    alias: "raft",
    credential,
    publicConfig: { serverUrl: "https://raft.example", ...config },
    connection: { get: async () => null, set: async () => {} },
    sibling: async () => null,
  } as any;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function one(answer: Response) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer;
  }) as any;
  return calls;
}

async function failure(fn: () => Promise<unknown>): Promise<Error & { retryable?: boolean }> {
  try { await fn(); }
  catch (e) { return e as Error & { retryable?: boolean }; }
  throw new Error("expected failure");
}

await check("declares the queue drain as a non-idempotent write", async () => {
  const receive = raftPlugin.tools.find((tool) => tool.name === "receive_events");
  if (receive?.sideEffects !== "write" || receive.idempotency !== "none") {
    throw new Error(`unsafe declaration: ${JSON.stringify(receive)}`);
  }
  const send = raftPlugin.tools.find((tool) => tool.name === "send_message");
  if (send?.sideEffects !== "write" || send.idempotency !== "key") throw new Error("send lost its key idempotency");
  const join = raftPlugin.tools.find((tool) => tool.name === "join_channel");
  if (join?.sideEffects !== "write" || join.idempotency !== "native") throw new Error("join lost native idempotency");
});

await check("send uses the configured origin, keeps the credential host-side, and projects the response", async () => {
  const calls = one(json(200, {
    ok: true, state: "sent", messageId: "m-1", messageSeq: 7,
    recentUnread: [{ content: "must not enter the result" }], serverExtra: "also hidden",
  }));
  const out = await raftPlugin.invoke("send_message", {
    target: "#general", content: "hello", idempotencyKey: "stable-1",
  }, ctx()) as any;
  if (JSON.stringify(out) !== JSON.stringify({ state: "sent", messageId: "m-1", messageSeq: 7 })) {
    throw new Error(`unexpected projection: ${JSON.stringify(out)}`);
  }
  if (calls.length !== 1 || calls[0]!.url !== "https://raft.example/internal/agent-api/send") {
    throw new Error(`wrong request: ${JSON.stringify(calls)}`);
  }
  const headers = new Headers(calls[0]!.init.headers);
  if (headers.get("authorization") !== "Bearer sk_agent_test_1234567890") throw new Error("credential not attached");
  if (String(calls[0]!.init.body).includes("sk_agent_")) throw new Error("credential entered the JSON body");
  const body = JSON.parse(String(calls[0]!.init.body));
  if (body.idempotencyKey !== "stable-1" || body.target !== "#general" || body.content !== "hello") {
    throw new Error(`wrong send body: ${JSON.stringify(body)}`);
  }
  if (calls[0]!.init.redirect !== "error") throw new Error("fetch may forward the credential through a redirect");
});

await check("send requires a stable idempotency key before reaching Raft", async () => {
  globalThis.fetch = (async () => { throw new Error("network reached"); }) as any;
  const why = await failure(() => raftPlugin.invoke("send_message", { target: "#general", content: "hello" }, ctx()));
  if (!/idempotencyKey/.test(why.message)) throw why;
});

await check("receive makes exactly one request and returns only the message projection", async () => {
  const calls = one(json(200, {
    events: [{
      id: "m-2", seq: 9, content: "hi", sender_type: "human", sender_name: "tygg",
      channel_name: "wg-raft-sdk", channel_type: "regular", internalSecret: "hidden",
      attachments: [{ id: "a-1", filename: "readme.txt", storageKey: "hidden" }],
    }],
    last_seen_seq: 9, last_seen_msgId: "m-2", has_more: false, reply_target: "#wg-raft-sdk",
    pending_notice_ids: ["hidden"], wake_reason: "hidden",
  }));
  const out = await raftPlugin.invoke("receive_events", { since: 3, limit: 4 }, ctx()) as any;
  if (calls.length !== 1 || calls[0]!.url !== "https://raft.example/internal/agent-api/events?since=3&limit=4") {
    throw new Error(`receive calls: ${JSON.stringify(calls)}`);
  }
  if (calls[0]!.init.cache !== "no-store") throw new Error(`receive cache mode: ${calls[0]!.init.cache}`);
  const encoded = JSON.stringify(out);
  if (!encoded.includes('"messageId":"m-2"') || !encoded.includes('"senderName":"tygg"')) throw new Error(encoded);
  if (/internalSecret|storageKey|pending_notice_ids|wake_reason/.test(encoded)) throw new Error(`unprojected data: ${encoded}`);
});

await check("receive transport failure is uncertain and is never retried inside the plugin", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("socket closed"); }) as any;
  const why = await failure(() => raftPlugin.invoke("receive_events", {}, ctx()));
  if (calls !== 1) throw new Error(`receive made ${calls} attempts`);
  if (why.retryable !== true || !/acknowledgement may already have occurred/.test(why.message)) {
    throw new Error(`uncertainty was lost: ${why.message}, retryable=${why.retryable}`);
  }
});

await check("receive rejects an invalid response without exposing its body", async () => {
  one(json(200, { events: "wrong", secret: "body-secret" }));
  const why = await failure(() => raftPlugin.invoke("receive_events", {}, ctx()));
  if (!/acknowledgement may already have occurred/.test(why.message) || /body-secret/.test(why.message)) throw why;
});

await check("receive HTTP and non-JSON failures preserve acknowledgement uncertainty without leaking bodies", async () => {
  for (const response of [
    json(500, { message: "private upstream detail" }),
    new Response("private proxy page", { status: 502, headers: { "content-type": "text/html" } }),
  ]) {
    one(response);
    const why = await failure(() => raftPlugin.invoke("receive_events", {}, ctx()));
    if (!/acknowledgement may already have occurred/.test(why.message) || !/no retry was attempted/.test(why.message)) {
      throw new Error(`uncertainty was lost: ${why.message}`);
    }
    if (/private upstream detail|private proxy page/.test(why.message)) throw new Error(`body leaked: ${why.message}`);
  }
});

await check("the gateway persists every post-dispatch receive failure as unknown", async () => {
  const store = new SqliteStore(":memory:");
  await store.init();
  await store.createAgent("tenant", "agent");
  await store.addMount({
    tenantId: "tenant", agentId: "agent", alias: "raft", plugin: "raft",
    installationId: "raft-test", connectionId: null, toolVersion: raftPlugin.version,
    publicConfig: { serverUrl: "https://raft.example" }, secretRef: "secret:raft", policy: null,
  });
  const gateway = new ToolGateway(
    store,
    [{ ...raftPlugin, defaultForAllAgents: true }],
    { async resolve() { return "sk_agent_test_1234567890"; } },
  );
  const invoke = () => gateway.invoke(
    { tenantId: "tenant", agentId: "agent", taskId: "task" },
    "raft.receive_events",
    {},
  );
  const cases: Array<[string, () => void]> = [
    ["transport", () => {
      globalThis.fetch = (async () => { throw new Error("private socket detail"); }) as any;
    }],
    ["HTTP JSON", () => { one(json(500, { message: "private upstream detail" })); }],
    ["HTTP non-JSON", () => {
      one(new Response("private proxy page", { status: 200, headers: { "content-type": "text/html" } }));
    }],
    ["invalid success", () => { one(json(200, { events: "wrong", secret: "body-secret" })); }],
  ];
  for (const [name, arrange] of cases) {
    arrange();
    const out = await invoke();
    if (out.status !== "unknown") throw new Error(`${name} persisted as ${out.status}: ${JSON.stringify(out)}`);
    const message = out.error?.message ?? "";
    if (!/acknowledgement may already have occurred/.test(message) || !/no retry was attempted/.test(message)) {
      throw new Error(`${name} lost the uncertainty/no-retry contract: ${message}`);
    }
    if (/private socket detail|private upstream detail|private proxy page|body-secret/.test(message)) {
      throw new Error(`${name} leaked a response or transport detail: ${message}`);
    }
  }
});

await check("join resolves a visible channel, then joins its encoded id", async () => {
  const seen: string[] = [];
  let n = 0;
  globalThis.fetch = (async (url: any) => {
    seen.push(String(url));
    return n++ === 0
      ? json(200, { channels: [{ id: "id/with space", name: "engineering", joined: false }], privateDetails: "hidden" })
      : json(200, { ok: true, attention: { internal: "hidden" } });
  }) as any;
  const out = await raftPlugin.invoke("join_channel", { target: "#engineering" }, ctx()) as any;
  if (out.state !== "joined" || out.channelId !== "id/with space") throw new Error(JSON.stringify(out));
  if (seen[1] !== "https://raft.example/internal/agent-api/channels/id%2Fwith%20space/join") {
    throw new Error(`join URL: ${seen[1]}`);
  }
});

await check("join returns already_joined without a mutation", async () => {
  const calls = one(json(200, { channels: [{ id: "c-1", name: "general", joined: true }] }));
  const out = await raftPlugin.invoke("join_channel", { target: "#general" }, ctx()) as any;
  if (out.state !== "already_joined" || calls.length !== 1) throw new Error(JSON.stringify({ out, calls }));
});

await check("join refuses DMs and thread targets before reaching Raft", async () => {
  globalThis.fetch = (async () => { throw new Error("network reached"); }) as any;
  for (const target of ["dm:@tygg", "#general:abcd1234", "general"]) {
    const why = await failure(() => raftPlugin.invoke("join_channel", { target }, ctx()));
    if (!/regular channel/.test(why.message)) throw why;
  }
});

await check("the mount setting cannot redirect a credential to a path or embedded user", async () => {
  globalThis.fetch = (async () => { throw new Error("network reached"); }) as any;
  for (const serverUrl of ["https://evil.example/path", "https://user@evil.example", "file:///tmp/socket"]) {
    const why = await failure(() => raftPlugin.invoke("receive_events", {}, ctx(undefined, { serverUrl })));
    if (!/serverUrl/.test(why.message)) throw why;
  }
});

await check("credential check distinguishes rejection from an unreachable server", async () => {
  one(json(401, { errorCode: "UNAUTHORIZED", message: "secret response text" }));
  const rejected = await raftPlugin.checkCredential!(ctx());
  if (rejected.ok || rejected.kind !== "rejected" || /secret response text/.test(rejected.reason)) {
    throw new Error(`rejection: ${JSON.stringify(rejected)}`);
  }
  globalThis.fetch = (async () => { throw new Error("secret socket detail"); }) as any;
  const unreachable = await raftPlugin.checkCredential!(ctx());
  if (unreachable.ok || unreachable.kind !== "unreachable" || /secret socket detail/.test(unreachable.reason)) {
    throw new Error(`unreachable: ${JSON.stringify(unreachable)}`);
  }
});

await check("credential check returns the bound Raft identity", async () => {
  one(json(200, { runtimeContext: { agentId: "agent-1", serverId: "server-1", workspacePath: "/private/path" } }));
  const checked = await raftPlugin.checkCredential!(ctx());
  if (!checked.ok || checked.account !== "agent-1 @ server-1") throw new Error(JSON.stringify(checked));
});

globalThis.fetch = originalFetch;
console.log(`\n  raft plugin\n  ${"─".repeat(56)}`);
for (const result of results) {
  console.log(result.ok ? `  \x1b[32m✓\x1b[0m ${result.name}` : `  \x1b[31m✗\x1b[0m ${result.name}\n      \x1b[31m${result.error}\x1b[0m`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
