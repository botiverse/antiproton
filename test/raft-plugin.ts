import { createHmac } from "node:crypto";
import { raftPlugin } from "../src/plugins/raft.ts";
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

function pushed(payload: unknown, options: { secret?: string; eventId?: string } = {}) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const signature = createHmac("sha256", options.secret ?? PUSH_SECRET).update(body).digest("hex");
  return {
    headers: {
      "x-raft-signature-256": `sha256=${signature}`,
      "x-raft-event-id": options.eventId ?? String((payload as any)?.eventId ?? ""),
    },
    body,
  };
}

function pushPayload(overrides: Record<string, unknown> = {}) {
  return {
    schema: "raft-agent-inbox.v1",
    eventId: "event-1",
    recipientAgentId: "agent-1",
    reason: "inbox_changed",
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

async function failure(fn: () => Promise<unknown>): Promise<Error & { retryable?: boolean }> {
  try { await fn(); }
  catch (e) { return e as Error & { retryable?: boolean }; }
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

await check("a signed Raft inbox notification wakes one canonical pull without network access", async () => {
  const m = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  globalThis.fetch = (async () => { throw new Error("receive called the network"); }) as any;
  const incoming = pushPayload();
  const out = await raftPlugin.receive!(pushed(incoming), PUSH_SECRET, m.ctx);
  if (!out.deliver || out.dedupeKey !== "event-1") throw new Error(JSON.stringify(out));
  if (!out.text.includes("the `receive_events` tool from the `raft` mount exactly once") ||
      !out.text.includes("canonical inbox batch") || !out.text.includes("Do not retry automatically")) {
    throw new Error(out.text);
  }
  if (m.state()?.lastReached?.eventId !== "event-1") throw new Error(`last reach not stored: ${JSON.stringify(m.state())}`);
});

await check("push verifies the signature and matching event id before reading mount state", async () => {
  let reads = 0;
  const guarded = {
    ...ctx(),
    connection: { get: async () => { reads++; return null; }, set: async () => { throw new Error("state written"); } },
  } as any;
  const unsigned = pushed(pushPayload());
  delete (unsigned.headers as any)["x-raft-signature-256"];
  const missing = await raftPlugin.receive!(unsigned, PUSH_SECRET, guarded);
  if (missing.deliver || !missing.rejected) throw new Error(JSON.stringify(missing));
  const wrongSecret = await raftPlugin.receive!(pushed(pushPayload(), { secret: "wrong" }), PUSH_SECRET, guarded);
  if (wrongSecret.deliver || !wrongSecret.rejected) throw new Error(JSON.stringify(wrongSecret));
  const wrongId = await raftPlugin.receive!(pushed(pushPayload(), { eventId: "other" }), PUSH_SECRET, guarded);
  if (wrongId.deliver || !wrongId.rejected || reads !== 0) throw new Error(JSON.stringify({ wrongId, reads }));
});

await check("push rejects event ids that cannot be used as bounded dedupe keys", async () => {
  let reads = 0;
  const guarded = {
    ...ctx(),
    connection: { get: async () => { reads++; return null; }, set: async () => { throw new Error("state written"); } },
  } as any;
  for (const eventId of ["contains space", "x".repeat(129), ""]) {
    const out = await raftPlugin.receive!(pushed(pushPayload({ eventId })), PUSH_SECRET, guarded);
    if (out.deliver || !out.rejected) throw new Error(JSON.stringify({ eventId, out }));
  }
  if (reads !== 0) throw new Error(`invalid event ids reached mount state: ${reads}`);
});

await check("push drops disabled and cross-agent inbox notifications", async () => {
  const disabled = mount({ enabled: false, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const disabledOut = await raftPlugin.receive!(pushed(pushPayload()), PUSH_SECRET, disabled.ctx);
  if (disabledOut.deliver || !/disabled/.test(disabledOut.reason)) throw new Error(JSON.stringify(disabledOut));

  const enabled = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  const cross = await raftPlugin.receive!(pushed(pushPayload({ recipientAgentId: "agent-2" })), PUSH_SECRET, enabled.ctx);
  if (cross.deliver || !/different/.test(cross.reason)) throw new Error(JSON.stringify(cross));
});

await check("push refuses raw content instead of creating a second message delivery plane", async () => {
  const enabled = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  for (const extra of [
    { message: { messageId: "message-1", content: "raw message" } },
    { content: "raw message" },
    { events: [{ content: "raw message" }] },
  ]) {
    const out = await raftPlugin.receive!(pushed(pushPayload(extra)), PUSH_SECRET, enabled.ctx);
    if (out.deliver || !out.rejected || !/must not carry message content/.test(out.reason)) {
      throw new Error(JSON.stringify({ extra, out }));
    }
    if (JSON.stringify(out).includes("raw message")) throw new Error(`content leaked in rejection: ${JSON.stringify(out)}`);
  }
});

await check("push requires the exact content-free Phase 0 reason", async () => {
  const enabled = mount({ enabled: true, agentId: "agent-1", agentName: "raft-bot", lastReached: null });
  for (const reason of [undefined, "message_available", "inbox_changed "]) {
    const out = await raftPlugin.receive!(pushed(pushPayload({ reason })), PUSH_SECRET, enabled.ctx);
    if (out.deliver || !out.rejected) throw new Error(JSON.stringify({ reason, out }));
  }
});

await check("disable_push stops later delivery and push_status exposes no secret", async () => {
  const m = mount({
    enabled: true, agentId: "agent-1", agentName: "raft-bot",
    hookId: "hook-old", staleHookIds: ["hook-stale"], registration: "active",
    lastReached: { eventId: "event-old", at: Date.parse("2026-09-17T00:00:00.000Z") },
  });
  const calls = one(new Response(null, { status: 204 }));
  const disabled = await raftPlugin.invoke("disable_push", {}, m.ctx) as any;
  const status = await raftPlugin.invoke("push_status", {}, m.ctx) as any;
  if (disabled.enabled !== false || status.enabled !== false || status.account !== "@raft-bot") {
    throw new Error(JSON.stringify({ disabled, status }));
  }
  if (status.lastReached?.eventId !== "event-old" || JSON.stringify(status).includes(PUSH_SECRET)) {
    throw new Error(JSON.stringify(status));
  }
  if (calls.length !== 1 || calls[0]!.init.method !== "DELETE" ||
      calls[0]!.url !== "https://raft.example/internal/agent-api/push-webhook") throw new Error(JSON.stringify(calls));
  if (m.inbound.revoked.sort().join(",") !== "hook-old,hook-stale" || m.state().hookId !== null) {
    throw new Error(JSON.stringify({ state: m.state(), revoked: m.inbound.revoked }));
  }
});

await check("an ambiguous disable keeps the local hook and enabled state", async () => {
  globalThis.fetch = (async () => { throw new Error("private delete detail"); }) as any;
  const original = {
    enabled: true, agentId: "agent-1", agentName: "raft-bot", hookId: "hook-old",
    staleHookIds: [], registration: "active", lastReached: null,
  };
  const m = mount(original);
  const why = await failure(() => raftPlugin.invoke("disable_push", {}, m.ctx));
  if (!/may already have landed/.test(why.message) || /private delete detail/.test(why.message)) throw why;
  if (JSON.stringify(m.state()) !== JSON.stringify(original) || m.inbound.revoked.length !== 0) {
    throw new Error(JSON.stringify({ state: m.state(), revoked: m.inbound.revoked }));
  }
});

await check("push_status safely normalizes corrupt persisted connection state", async () => {
  for (const lastReached of [{ eventId: 9, at: "yesterday" }, { eventId: "event-future", at: 1e100 }]) {
    const m = mount({ enabled: "yes", agentId: 42, agentName: ["bad"], lastReached });
    const status = await raftPlugin.invoke("push_status", {}, m.ctx) as any;
    if (JSON.stringify(status) !== JSON.stringify({
      enabled: false, account: null, registration: null, cleanupPending: 0, lastReached: null,
    })) {
      throw new Error(JSON.stringify(status));
    }
  }
});

globalThis.fetch = originalFetch;
console.log(`\n  raft plugin\n  ${"─".repeat(56)}`);
for (const result of results) {
  console.log(result.ok ? `  \x1b[32m✓\x1b[0m ${result.name}` : `  \x1b[31m✗\x1b[0m ${result.name}\n      \x1b[31m${result.error}\x1b[0m`);
}
const passed = results.filter((result) => result.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
