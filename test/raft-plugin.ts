import { createHmac } from "node:crypto";
import { raftPlugin } from "../src/plugins/raft.ts";
import type { PluginErrorFields } from "../src/plugins/types.ts";
import { ToolGateway } from "../src/runtime/gateway.ts";
import { SqliteStore } from "../src/store/sqlite.ts";

const originalFetch = globalThis.fetch;
const PUSH_SECRET = "raft-push-secret-for-tests";
const results: Array<{ name: string; ok: boolean; error?: string }> = [];

async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}

function fakeInbound() {
  let serial = 0;
  const revoked: string[] = [];
  return {
    api: {
      create: async () => {
        serial++;
        return { hookId: `hook-${serial}`, url: `https://hooks.example/hook-${serial}`, secret: `hook-secret-${serial}` };
      },
      revoke: async (hookId: string) => { revoked.push(hookId); return true; },
    },
    revoked,
  };
}

function ctx(
  credential: string | null = "sk_agent_test_1234567890",
  config: Record<string, unknown> = {},
  inbound: ReturnType<typeof fakeInbound>["api"] | undefined = fakeInbound().api,
) {
  return {
    caller: { tenantId: "tenant", agentId: "agent", taskId: "task" },
    alias: "raft",
    credential,
    publicConfig: { serverUrl: "https://raft.example", ...config },
    connection: { get: async () => null, set: async () => {} },
    inbound,
    sibling: async () => null,
  } as any;
}

function mount(initial: unknown = null, inbound = fakeInbound()) {
  let state = initial;
  return {
    ctx: {
      ...ctx(),
      connection: {
        get: async () => state,
        set: async (value: unknown) => { state = value; },
      },
      inbound: inbound.api,
    } as any,
    state: () => state as any,
    inbound,
  };
}

function pushed(payload: unknown, options: { secret?: string; deliveryId?: string } = {}) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = createHmac("sha256", options.secret ?? PUSH_SECRET).update(body).digest("hex");
  return {
    headers: {
      "x-raft-signature-256": `sha256=${signature}`,
      "x-raft-delivery-id": options.deliveryId ?? String((payload as any)?.deliveryId ?? ""),
    },
    body,
  };
}

/** An inbox notice as Raft sends it (raft-agent-inbox-notice.v1). */
function notice(overrides: Record<string, unknown> = {}) {
  return {
    schema: "raft-agent-inbox-notice.v1", noticeId: "ntc_0123456789abcdef", recipientAgentId: "agent-1", occurredAt: "2026-09-28T08:50:00.000Z",
    text: "Inbox update: 2 unread messages total; 1 changed target\n#qa-browser  pending: 2 messages · latest sender @tygg · you were mentioned",
    targets: [{ target: "#qa-browser", channelId: "c1", channelType: "channel", pendingCount: 2, firstPendingMsgId: "m1", latestMsgId: "m2", latestSenderName: "tygg", latestSenderType: "human", flags: ["mention"] }],
    ...overrides,
  };
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

function many(...answers: Response[]) {
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    const answer = answers.shift();
    if (!answer) throw new Error("unexpected fetch");
    return answer;
  }) as any;
  return calls;
}

async function failure(fn: () => Promise<unknown>): Promise<Error & PluginErrorFields> {
  try { await fn(); }
  catch (e) { return e as Error & PluginErrorFields; }
  throw new Error("expected failure");
}

await check("declares the queue drain as a non-idempotent write", async () => {
  if (raftPlugin.version !== "1.0.0") throw new Error(`unexpected plugin version: ${raftPlugin.version}`);
  const receive = raftPlugin.tools.find((tool) => tool.name === "receive_events");
  if (receive?.sideEffects !== "write" || receive.idempotency !== "none") {
    throw new Error(`unsafe declaration: ${JSON.stringify(receive)}`);
  }
  const send = raftPlugin.tools.find((tool) => tool.name === "send_message");
  if (send?.sideEffects !== "write" || send.idempotency !== "key") throw new Error("send lost its key idempotency");
  const join = raftPlugin.tools.find((tool) => tool.name === "join_channel");
  if (join?.sideEffects !== "write" || join.idempotency !== "native") throw new Error("join lost native idempotency");
  const enable = raftPlugin.tools.find((tool) => tool.name === "enable_push");
  const disable = raftPlugin.tools.find((tool) => tool.name === "disable_push");
  const status = raftPlugin.tools.find((tool) => tool.name === "push_status");
  if (enable?.sideEffects !== "write" || enable.idempotency !== "none") throw new Error("enable_push declaration changed");
  if (disable?.sideEffects !== "write" || disable.idempotency !== "native") throw new Error("disable_push declaration changed");
  if (status?.sideEffects !== "read" || status.idempotency !== "native") throw new Error("push_status declaration changed");
  const serverUrl = raftPlugin.config?.find((field) => field.name === "serverUrl");
  if (serverUrl?.format !== "origin") throw new Error("serverUrl lost its origin guard");
});

await check("serverUrl rejects cleartext non-loopback origins before sending the credential", async () => {
  globalThis.fetch = (async () => { throw new Error("network reached"); }) as any;
  const why = await failure(() => raftPlugin.invoke("send_message", {
    target: "#general", content: "hello", idempotencyKey: "stable-http-rejection",
  }, ctx("sk_agent_test_1234567890", { serverUrl: "http://raft.example" })));
  if (!/https/.test(why.message) || /network reached/.test(why.message)) throw why;
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
  if (calls[0]!.init.redirect !== "manual") {
    throw new Error(`fetch must use the Workers-compatible manual redirect guard: ${calls[0]!.init.redirect}`);
  }
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

await check("a truncated pull says so in words, and a complete one carries no such note", async () => {
  const calls = one(json(200, { events: [{ message_id: "m-9", seq: 12, content: "x", sender_type: "human", sender_name: "t", timestamp: "2026-09-28T10:00:00.000Z", channel_name: "g", channel_type: "channel" }], last_seen_seq: 12, has_more: true }));
  const out = await raftPlugin.invoke("receive_events", { since: "latest", limit: 10 }, ctx()) as any;
  if (out.hasMore !== true || !/call receive_events again until hasMore is false/.test(out.note) || calls.length !== 1) throw new Error(JSON.stringify(out));
  one(json(200, { events: [], last_seen_seq: 12, has_more: false }));
  const done = await raftPlugin.invoke("receive_events", { since: "latest" }, ctx()) as any;
  if (done.hasMore !== false || "note" in done) throw new Error(JSON.stringify(done));
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
    [raftPlugin], new Set([raftPlugin.id]),
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
  const calls = one(json(200, {
    agentId: "agent-1", agentName: "raft-bot", agentDisplayName: "Release Bot", serverId: "server-1",
    credentialId: "secret-id", scopes: ["all"],
  }));
  const checked = await raftPlugin.checkCredential!(ctx());
  if (!checked.ok || checked.account !== "Release Bot (@raft-bot)") throw new Error(JSON.stringify(checked));
  if (calls.length !== 1 || calls[0]!.url !== "https://raft.example/internal/agent-api") {
    throw new Error(`credential check used the wrong endpoint: ${JSON.stringify(calls)}`);
  }
});

await check("credential check falls back to the stable Raft agent name", async () => {
  one(json(200, {
    agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1",
    credentialId: "secret-id", scopes: ["all"],
  }));
  const checked = await raftPlugin.checkCredential!(ctx());
  if (!checked.ok || checked.account !== "@raft-bot") throw new Error(JSON.stringify(checked));
});

await check("enable_push creates a hook and registers it without exposing its secret", async () => {
  const calls = many(
    json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: "Release Bot", serverId: "server-1" }),
    json(200, { ok: true }),
  );
  const m = mount();
  const out = await raftPlugin.invoke("enable_push", {}, m.ctx) as any;
  if (!out.enabled || out.account !== "Release Bot (@raft-bot)" || out.registration !== "active") {
    throw new Error(`enable result: ${JSON.stringify(out)}`);
  }
  if (calls.length !== 2 || calls[0]!.url !== "https://raft.example/internal/agent-api" ||
      calls[1]!.url !== "https://raft.example/internal/agent-api/push-webhook" || calls[1]!.init.method !== "PUT") {
    throw new Error(`enable used the wrong identity endpoint: ${JSON.stringify(calls)}`);
  }
  const registered = JSON.parse(String(calls[1]!.init.body));
  if (registered.url !== "https://hooks.example/hook-1" || registered.secret !== "hook-secret-1") {
    throw new Error(`wrong registration: ${JSON.stringify(registered)}`);
  }
  const encoded = JSON.stringify({ out, state: m.state() });
  if (encoded.includes("hook-secret") || encoded.includes("hooks.example")) throw new Error(`hook material leaked: ${encoded}`);
  if (JSON.stringify(m.state()) !== JSON.stringify({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-1",
    staleHookIds: [], registration: "active", lastReached: null,
  })) {
    throw new Error(`push state: ${JSON.stringify(m.state())}`);
  }
});

await check("enable_push revokes a newly created hook after a definite registration failure", async () => {
  many(
    json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" }),
    json(400, { errorCode: "INVALID_PUSH_ENDPOINT" }),
  );
  const original = {
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old",
    staleHookIds: [], registration: "active", lastReached: null,
  };
  const m = mount(original);
  const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
  if (!/HTTP 400/.test(why.message) || JSON.stringify(m.state()) !== JSON.stringify(original)) throw why;
  if (m.inbound.revoked.join(",") !== "hook-1") throw new Error(`revoked ${m.inbound.revoked}`);
});

await check("a failed hook cleanup remains recorded without replacing the registration error", async () => {
  many(
    json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" }),
    json(400, { errorCode: "INVALID_PUSH_ENDPOINT" }),
  );
  const inbound = fakeInbound();
  inbound.api.revoke = async () => { throw new Error("private cleanup detail"); };
  const m = mount(null, inbound);
  const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
  if (!/HTTP 400/.test(why.message) || /private cleanup detail/.test(why.message)) throw why;
  if (m.state().hookId !== "hook-1" || m.state().enabled !== false) throw new Error(JSON.stringify(m.state()));
});

await check("enable_push preserves an ambiguous new registration for recovery without leaking its secret", async () => {
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) return json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" });
    throw new Error("private transport detail");
  }) as any;
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old",
    staleHookIds: [], registration: "active", lastReached: null,
  });
  const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
  const encoded = JSON.stringify({ message: why.message, state: m.state() });
  if (!/may already have landed/.test(why.message) || m.state().registration !== "uncertain" ||
      m.state().hookId !== "hook-1" || m.state().staleHookIds.join(",") !== "hook-old") throw why;
  if (encoded.includes("hook-secret") || encoded.includes("hooks.example") || /private transport detail/.test(encoded)) {
    throw new Error(`hook material leaked: ${encoded}`);
  }
  if (m.inbound.revoked.length !== 0) throw new Error(`ambiguous hook was revoked: ${m.inbound.revoked}`);
});

await check("enable_push recovers after three ambiguous registrations without exhausting hook capacity", async () => {
  let serial = 0;
  const active = new Set<string>();
  const inbound = {
    api: {
      create: async () => {
        if (active.size >= 3) throw new Error("already has 3 live hooks");
        const hookId = `hook-${++serial}`;
        active.add(hookId);
        return { hookId, url: `https://hooks.example/${hookId}`, secret: `hook-secret-${serial}` };
      },
      revoke: async (hookId: string) => active.delete(hookId),
    },
    revoked: [],
  };
  let registrations = 0;
  globalThis.fetch = (async (url: any) => {
    if (String(url) === "https://raft.example/internal/agent-api") {
      return json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" });
    }
    registrations++;
    if (registrations <= 3) throw new Error("private transport detail");
    return json(200, { ok: true });
  }) as any;
  const m = mount(null, inbound);
  for (let attempt = 0; attempt < 3; attempt++) {
    const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
    if (!/may already have landed/.test(why.message)) throw why;
  }
  const enabled = await raftPlugin.invoke("enable_push", {}, m.ctx) as any;
  if (!enabled.enabled || enabled.registration !== "active" || active.size !== 1 || !active.has("hook-4")) {
    throw new Error(JSON.stringify({ enabled, active: [...active], state: m.state() }));
  }
  if (m.state().hookId !== "hook-4" || m.state().staleHookIds.length !== 0) {
    throw new Error(JSON.stringify(m.state()));
  }
});

await check("enable_push clears stale hooks before create and revokes the current hook after replacement", async () => {
  const order: string[] = [];
  const inbound = fakeInbound();
  const originalRevoke = inbound.api.revoke;
  inbound.api.revoke = async (hookId: string) => { order.push(`revoke:${hookId}`); return originalRevoke(hookId); };
  let request = 0;
  globalThis.fetch = (async (_url: any, init?: any) => {
    request++;
    if (request === 1) return json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: null, serverId: "server-1" });
    order.push(`register:${init?.method}`);
    return json(200, { ok: true });
  }) as any;
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old",
    staleHookIds: ["hook-older"], registration: "uncertain", lastReached: null,
  }, inbound);
  await raftPlugin.invoke("enable_push", {}, m.ctx);
  if (order.join(",") !== "revoke:hook-older,register:PUT,revoke:hook-old") throw new Error(order.join(","));
  if (m.state().hookId !== "hook-1" || m.state().staleHookIds.length !== 0 || m.state().registration !== "active") {
    throw new Error(JSON.stringify(m.state()));
  }
});

await check("push state keeps every valid hook id until it is explicitly revoked", async () => {
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-current",
    staleHookIds: ["hook-1", "hook-2", "hook-3"], registration: "uncertain", lastReached: null,
  });
  one(new Response(null, { status: 204 }));
  const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
  if (disabled.cleanupPending !== 0 || m.inbound.revoked.sort().join(",") !== "hook-1,hook-2,hook-3,hook-current") {
    throw new Error(JSON.stringify({ disabled, revoked: m.inbound.revoked, state: m.state() }));
  }
});

await check("a bare 200 on push registration is a registration, not a malformed answer", async () => {
  const m = mount();
  const calls = many(json(200, { agentId: "agent-1", agentName: "raft-bot", serverId: "srv" }), new Response("", { status: 200 }));
  const out = await raftPlugin.invoke("enable_push", {}, m.ctx) as any;
  if (out.enabled !== true || out.registration !== "active" || calls[1]!.init.method !== "PUT") throw new Error(JSON.stringify({ out, calls: calls.map((c) => c.init.method) }));
});

await check("an inbox notice reaches the agent as Raft wrote it, with the one instruction to read, and is deduped on its notice id", async () => {
  const m = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  globalThis.fetch = (async () => { throw new Error("receive called the network"); }) as any;
  const out = await raftPlugin.receive!(pushed(notice(), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, m.ctx);
  if (!out.deliver || out.dedupeKey !== "ntc_0123456789abcdef") throw new Error(JSON.stringify(out));
  if (!out.text.startsWith("Inbox update: 2 unread") || !out.text.includes("`receive_events` tool from the `raft` mount") || !/acknowledges/.test(out.text)) throw new Error(out.text);
  if (m.state()?.lastReached?.deliveryId !== "ntc_0123456789abcdef") throw new Error(JSON.stringify(m.state()));
  const extra = await raftPlugin.receive!(pushed(notice({ latestPreview: "added later", other: 1 }), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, m.ctx);
  if (!extra.deliver) throw new Error(`a field it does not know was refused: ${JSON.stringify(extra)}`);
  const long = await raftPlugin.receive!(pushed(notice({ text: "y".repeat(5000) }), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, m.ctx);
  if (!long.deliver || !long.text.includes("… (cut)") || long.text.length > 4300) throw new Error(`length ${long.deliver ? long.text.length : "-"}`);
});

await check("a notice is checked for its signature and header before any state is read, and a signed body Raft got wrong is 400, never 401", async () => {
  let reads = 0;
  const guarded = { ...ctx(), connection: { get: async () => { reads++; return null; }, set: async () => { throw new Error("state written"); } } } as any;
  const unsigned = pushed(notice(), { deliveryId: "ntc_0123456789abcdef" }); delete (unsigned.headers as any)["x-raft-signature-256"];
  const rej = await raftPlugin.receive!(unsigned, PUSH_SECRET, guarded);
  if (rej.deliver || !rej.rejected) throw new Error(JSON.stringify(rej));
  const wrongSecret = await raftPlugin.receive!(pushed(notice(), { secret: "wrong", deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, guarded);
  if (wrongSecret.deliver || !wrongSecret.rejected) throw new Error(JSON.stringify(wrongSecret));
  for (const [bad, expect] of [
    [notice({ text: "" }), /not a notice: text missing/], [notice({ targets: "none" }), /targets missing/], [notice({ noticeId: "has space" }), /noticeId missing/],
    [{ schema: "raft-agent-inbox.v2", deliveryId: "ibx_x", recipientAgentId: "agent-1", cursor: { fromSeq: 1, toSeq: 1 }, events: [{ content: "raw message" }] }, /schema is "raft-agent-inbox\.v2", not raft-agent-inbox-notice\.v1/],
    [{ schema: "raft-agent-inbox.v1", eventId: "e", recipientAgentId: "agent-1", reason: "inbox_changed" }, /schema is "raft-agent-inbox\.v1"/],
    [{ noticeId: "n", recipientAgentId: "agent-1", text: "x", targets: [] }, /schema is "undefined"/],
  ] as const) {
    const r = await raftPlugin.receive!(pushed(bad, { deliveryId: String((bad as any).noticeId ?? (bad as any).deliveryId ?? (bad as any).eventId) }), PUSH_SECRET, guarded);
    if (r.deliver || r.rejected || !r.malformed || !expect.test(r.reason) || JSON.stringify(r).includes("raw message")) throw new Error(JSON.stringify({ bad, r }));
  }
  const wrongHeader = await raftPlugin.receive!(pushed(notice(), { deliveryId: "ntc_other" }), PUSH_SECRET, guarded);
  if (wrongHeader.deliver || !wrongHeader.malformed || reads !== 0) throw new Error(JSON.stringify({ wrongHeader, reads }));
});

await check("a notice for a mount whose push is off, or for another Raft agent, is ignored and not delivered", async () => {
  const off = mount({ enabled: false, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const ignored = await raftPlugin.receive!(pushed(notice(), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, off.ctx);
  if (ignored.deliver || ignored.malformed || ignored.rejected || !/disabled/.test(ignored.reason)) throw new Error(JSON.stringify(ignored));
  const on = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const cross = await raftPlugin.receive!(pushed(notice({ recipientAgentId: "agent-2" }), { deliveryId: "ntc_0123456789abcdef" }), PUSH_SECRET, on.ctx);
  if (cross.deliver || !/different/.test(cross.reason)) throw new Error(JSON.stringify(cross));
});

await check("activity posts the events as given to Raft's ingest while push is on, and says skipped when it is off", async () => {
  const on = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const calls = one(json(200, { accepted: 2 }));
  const events = [
    { eventId: "raft_x:1", hookEventName: "UserPromptSubmit" as const, occurredAt: "2026-09-28T08:00:00.000Z" },
    { eventId: "raft_x:2", hookEventName: "Stop" as const, occurredAt: "2026-09-28T08:00:05.000Z" },
  ];
  const out = await raftPlugin.reportActivity!(events, on.ctx);
  if (!("sent" in out) || out.sent !== 2) throw new Error(JSON.stringify(out));
  const body = JSON.parse(calls[0]!.init.body);
  if (calls[0]!.url !== "https://raft.example/internal/agent-api/activity" || calls[0]!.init.method !== "POST" ||
      body.schema !== "raft-agent-activity-ingest.v1" || JSON.stringify(body.events) !== JSON.stringify(events) || Object.keys(body).length !== 2) {
    throw new Error(JSON.stringify({ url: calls[0]!.url, body }));
  }
  if (!String(calls[0]!.init.headers.authorization).startsWith("Bearer sk_agent_")) throw new Error("no credential on the activity call");
  const off = mount({ enabled: false, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const quiet = one(json(200, {}));
  const skipped = await raftPlugin.reportActivity!(events, off.ctx);
  if (!("skipped" in skipped) || quiet.length !== 0) throw new Error(JSON.stringify({ skipped, calls: quiet.length }));
  const none = await raftPlugin.reportActivity!([], on.ctx);
  if (!("sent" in none) || none.sent !== 0 || quiet.length !== 0) throw new Error(JSON.stringify(none));
});

await check("an activity post that fails throws, so the runtime keeps the events for the next pass", async () => {
  const on = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  one(json(503, { errorCode: "UNAVAILABLE" }));
  const why = await failure(() => raftPlugin.reportActivity!([{ eventId: "raft_x:1", hookEventName: "Stop", occurredAt: "2026-09-28T08:00:00.000Z" }], on.ctx));
  if (!/HTTP 503/.test(why.message)) throw new Error(why.message);
});

await check("disable_push tells Raft the session ended before deregistering, and still deregisters when that post fails", async () => {
  const m = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old", staleHookIds: [], registration: "active", lastReached: null });
  const calls = many(json(500, {}), new Response(null, { status: 204 }));
  const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
  if (disabled.enabled !== false || disabled.remoteDeregistration !== "confirmed") throw new Error(JSON.stringify(disabled));
  const first = JSON.parse(calls[0]!.init.body);
  if (calls[0]!.url !== "https://raft.example/internal/agent-api/activity" || first.events[0].hookEventName !== "SessionEnd" ||
      !String(first.events[0].eventId).startsWith("agent-1:session-end:") || calls[1]!.init.method !== "DELETE") {
    throw new Error(JSON.stringify(calls.map((c) => [c.init.method, c.url])));
  }
  const off = mount({ enabled: false, agentId: "agent-1", agentName: "raft-bot", hookId: null, staleHookIds: [], registration: null, lastReached: null });
  const quiet = one(new Response(null, { status: 204 }));
  await raftPlugin.invoke("disable_push", {}, off.ctx);
  if (quiet.length !== 1 || quiet[0]!.init.method !== "DELETE") throw new Error(`a disabled mount announced a session end: ${JSON.stringify(quiet.map((c) => c.init.method))}`);
});

await check("disable_push stops later delivery and push_status exposes no secret", async () => {
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot",
    hookId: "hook-old", staleHookIds: ["hook-stale"], registration: "active",
    lastReached: { deliveryId: "delivery-old", at: Date.parse("2026-09-17T00:00:00.000Z") },
  });
  const calls = many(json(200, {}), new Response(null, { status: 204 }));
  const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
  const status = await raftPlugin.invoke("push_status", {}, m.ctx) as any;
  if (disabled.enabled !== false || disabled.remoteDeregistration !== "confirmed" || disabled.cleanupPending !== 0 ||
      status.enabled !== false || status.account !== "@raft-bot") {
    throw new Error(JSON.stringify({ disabled, status }));
  }
  if (status.lastReached?.deliveryId !== "delivery-old" || JSON.stringify(status).includes(PUSH_SECRET)) {
    throw new Error(JSON.stringify(status));
  }
  if (calls.length !== 2 || calls[1]!.init.method !== "DELETE" ||
      calls[1]!.url !== "https://raft.example/internal/agent-api/push-webhook") throw new Error(JSON.stringify(calls.map((c) => [c.init.method, c.url])));
  if (m.inbound.revoked.sort().join(",") !== "hook-old,hook-stale" || m.state().hookId !== null) {
    throw new Error(JSON.stringify({ state: m.state(), revoked: m.inbound.revoked }));
  }
});

await check("disable_push closes the local endpoint even when Raft returns an error", async () => {
  for (const remote of ["network", "not-found"] as const) {
    globalThis.fetch = remote === "network"
      ? (async () => { throw new Error("private delete detail"); }) as any
      : (async () => json(404, { errorCode: "PUSH_WEBHOOK_NOT_FOUND" })) as any;
    const m = mount({
      enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: `hook-${remote}`,
      staleHookIds: [`stale-${remote}`], registration: "active", lastReached: null,
    });
    const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
    const expectedRemote = remote === "not-found" ? "confirmed" : "unconfirmed";
    if (disabled.enabled !== false || disabled.remoteDeregistration !== expectedRemote || disabled.cleanupPending !== 0 ||
        m.state().enabled !== false || m.state().hookId !== null || m.state().staleHookIds.length !== 0 ||
        m.inbound.revoked.sort().join(",") !== `hook-${remote},stale-${remote}`) {
      throw new Error(JSON.stringify({ remote, disabled, state: m.state(), revoked: m.inbound.revoked }));
    }
  }
});

await check("disable_push stays disabled while retaining hooks whose local revoke failed", async () => {
  globalThis.fetch = (async () => { throw new Error("private delete detail"); }) as any;
  const inbound = fakeInbound();
  inbound.api.revoke = async () => { throw new Error("private cleanup detail"); };
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old",
    staleHookIds: ["hook-stale"], registration: "active", lastReached: null,
  }, inbound);
  const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
  if (disabled.enabled !== false || disabled.remoteDeregistration !== "unconfirmed" || disabled.cleanupPending !== 2 ||
      m.state().enabled !== false || m.state().hookId !== null ||
      m.state().staleHookIds.sort().join(",") !== "hook-old,hook-stale") {
    throw new Error(JSON.stringify({ disabled, state: m.state() }));
  }
});

await check("push_status safely normalizes corrupt persisted connection state", async () => {
  for (const lastReached of [{ deliveryId: 9, at: "yesterday" }, { deliveryId: "event-future", at: 1e100 }, { eventId: "v1-shape", at: 1 }]) {
    const m = mount({ enabled: "yes", agentId: 42, agentName: ["bad"], lastReached });
    const status = await raftPlugin.invoke("push_status", {}, m.ctx) as any;
    if (JSON.stringify(status) !== JSON.stringify({
      enabled: false, account: null, registration: null, cleanupPending: 0, lastReached: null,
    })) {
      throw new Error(JSON.stringify(status));
    }
  }
});

/**
 * Which question a failure answers, per site.
 *
 * One flag could not say. This file set `retryable` for an uncertain delivery
 * while its own comment said callers must not retry; `github.ts` set the same
 * flag for a refused quota where nothing happened; `appworld.ts` set it for a
 * 5xx with the comment "5xx may have landed". Two questions — will this clear
 * on its own, and may the last attempt have landed — and a 5xx answers yes to
 * both (@Vera counted the three sites, 2026-09-20).
 */
await check("an uncertain delivery says it may have landed, and does not say it will clear", async () => {
  globalThis.fetch = (async () => new Response("", { status: 500 })) as any;
  const why = await failure(() => raftPlugin.invoke("receive_events", {}, ctx()));
  if (why.mayHaveLanded !== true) throw new Error(`uncertainty was lost: mayHaveLanded=${why.mayHaveLanded}`);
  if (why.transient !== undefined) throw new Error(`a drained batch was called self-clearing: transient=${why.transient}`);
  // The flag its consumer still reads must not move until that consumer does.
  if (why.retryable !== true) throw new Error(`the transitional flag changed: retryable=${why.retryable}`);
});

/**
 * A state holding as many ids as the cap still enables push, once they are gone.
 *
 * There used to be a cap check in `enable_push` between the cleanup and
 * `create()`, and it could not fire: the cleanup either throws or empties the
 * list. This pins the reason not to "fix" it by moving it earlier — the ids it
 * would count are the ones the cleanup removes, so refusing first would leave a
 * mount whose revokes had failed a few times unable to enable push ever again.
 */
await check("a mount carrying a cap's worth of superseded endpoints can still enable push once they are revoked", async () => {
  const calls = many(
    json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: "Release Bot", serverId: "server-1" }),
    json(200, { ok: true }),
  );
  const inbound = fakeInbound();
  const m = mount(
    { hookId: "hook-live", staleHookIds: ["hook-old-1", "hook-old-2"], registration: "active", lastReached: null },
    inbound,
  );
  const out = await raftPlugin.invoke("enable_push", {}, m.ctx) as any;
  if (out.enabled !== true) throw new Error(`refused a recoverable state: ${JSON.stringify(out)}`);
  if (inbound.revoked.length !== 3) {
    throw new Error(`expected the three old ids revoked, got ${JSON.stringify(inbound.revoked)}`);
  }
  if (calls.length !== 2) throw new Error(`unexpected requests: ${JSON.stringify(calls.map((c) => c.url))}`);
});

await check("a leftover endpoint that could not be revoked says a retry may work, and not that it landed", async () => {
  // The reachable half of enable_push's cleanup: the revoke failed, so nothing
  // was created and nothing landed, and the sentence invites another attempt.
  one(json(200, { agentId: "agent-1", agentName: "raft-bot", agentDisplayName: "Release Bot", serverId: "server-1" }));
  const refuses = {
    api: {
      create: async () => ({ hookId: "hook-9", url: "https://hooks.example/hook-9", secret: "s" }),
      revoke: async () => { throw new Error("revoke refused"); },
    },
    revoked: [] as string[],
  };
  const m = mount({ hookId: null, staleHookIds: ["hook-old"], registration: null, lastReached: null }, refuses);
  const why = await failure(() => raftPlugin.invoke("enable_push", {}, m.ctx));
  if (!/could not be cleaned up/.test(why.message)) throw new Error(`a different failure: ${why.message}`);
  if (why.transient !== true) throw new Error(`does not invite the retry its sentence asks for: ${why.transient}`);
  if (why.mayHaveLanded !== undefined) throw new Error(`claimed something may have landed: ${why.mayHaveLanded}`);
});

globalThis.fetch = originalFetch;
console.log(`\n  raft plugin\n  ${"─".repeat(56)}`);
for (const result of results) {
  console.log(result.ok ? `  \x1b[32m✓\x1b[0m ${result.name}` : `  \x1b[31m✗\x1b[0m ${result.name}\n      \x1b[31m${result.error}\x1b[0m`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
