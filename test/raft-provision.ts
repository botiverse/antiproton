/**
 * `POST /provision/raft` (cf/src/raft-provision.ts) against a fake Raft and an
 * in-memory hook directory: the registration comes only from Raft, the grant
 * goes only back to Raft, an account the mount does not hold is refused before
 * anything exists, and a lost callback answer never guesses.
 */
import { provisionRaft, parseScope, PROVISION_GRANT_MAX_MS, PROVISION_SCHEMA, type ProvisionDeps } from "../cf/src/raft-provision.ts";
import type { GrantState, HookDirectory, HookRow } from "../cf/src/control-plane.ts";
import { sha256Hex } from "../src/runtime/inbound.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const RAFT = "https://raft.test", ORIGIN = "https://ap.test", NOW = 1_800_000_000_000;
const CAP = "cap_" + "c".repeat(40), HANDOFF = "handoff-1";
const HOOK = "H".repeat(43), OLD_HOOK = "O".repeat(43);

function directory() {
  const rows = new Map<string, HookRow & { pending: boolean }>();
  const grants: Array<{ grantHash: string; hookId: string; version: number; nonce: string; expiresAt: number }> = [];
  const dir: HookDirectory = {
    async create(r, o) { rows.set(r.hookId, { ...r, createdAt: NOW, revokedAt: null, pending: !!o?.pending }); },
    async lookup(id) { const r = rows.get(id); return r && !r.revokedAt && !r.pending ? r : null; },
    async lookupLive(id) { const r = rows.get(id); return r && !r.revokedAt ? r : null; },
    async activate(id) { const r = rows.get(id); if (!r || !r.pending) return false; r.pending = false; return true; },
    async revoke(id) { const r = rows.get(id); if (!r || r.revokedAt) return null; r.revokedAt = NOW; return r; },
    async list() { return [...rows.values()]; },
    async grant(g) { grants.push(g); },
    async useGrant() { return null; },
    async finishGrant() {},
    async grantState(): Promise<GrantState | null> { return null; },
  };
  return { dir, rows, grants };
}

type Answer = { status: number; json?: unknown } | "throw";
function raftFake(opts: { scope?: Record<string, unknown>; get?: Answer[]; post?: Answer[] } = {}) {
  const calls: Array<{ method: string; url: string; auth: string | null; redirect: unknown; body: any }> = [];
  const scope = {
    schema: PROVISION_SCHEMA, state: "pending", registrationId: "reg-1", raftAgentId: "ragent-1",
    antiprotonTenantId: "demo", antiprotonAgentId: "u-a", mountAlias: "raft",
    secretVersion: 1, nonce: "nonce-12345", expiresAt: NOW + 5 * 60_000, ...(opts.scope ?? {}),
  };
  const gets = opts.get ?? [{ status: 200, json: scope }];
  const posts = opts.post ?? ["accept" as any];
  const fetch = async (url: string, init: RequestInit) => {
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, auth: new Headers(init.headers).get("authorization"), redirect: init.redirect, body });
    const queue = method === "GET" ? gets : posts;
    const a: any = queue.length > 1 ? queue.shift() : queue[0];
    if (a === "throw") throw new Error("connection reset");
    if (a === "accept") {
      return Response.json({ state: "accepted", registrationId: scope.registrationId, endpointHash: body.endpointHash, secretVersion: body.secretVersion, at: NOW });
    }
    return Response.json(typeof a.json === "function" ? a.json(calls) : a.json ?? {}, { status: a.status });
  };
  return { fetch, calls, scope };
}

function deps(over: Partial<ProvisionDeps> & { fake: ReturnType<typeof raftFake>; confirm?: { ok: true } | { ok: false; kind: "mismatch" | "unreachable" }; version?: number }) {
  const { dir, rows, grants } = directory();
  const asked: Array<{ alias: string; plugin: string; account: string }> = [];
  const notes: string[] = [];
  const d: ProvisionDeps = {
    raftOrigin: RAFT, origin: ORIGIN, fetch: over.fake.fetch, now: () => NOW, hooks: dir,
    newHookId: () => HOOK, newGrant: () => "aphg_" + "g".repeat(43), sha256Hex,
    agent: () => ({
      async hookConfirmInboundAccount(_t, _a, alias, plugin, account) { asked.push({ alias, plugin, account }); return over.confirm ?? { ok: true }; },
      async hookRecord(_t, _a, _al, _r, reason) { notes.push(reason); },
      async hookSecretVersion() { return { current: over.version ?? 1, generatedHere: false }; },
    }),
    checkAgentName: (t, a) => { if (!/^[a-z]/.test(t) || !a) throw new Error("bad"); },
    ...over,
  };
  return { d, rows, grants, asked, notes };
}
const req = (body: unknown = { handoffId: HANDOFF }, auth: string | null = `Bearer ${CAP}`) =>
  new Request(`${ORIGIN}/provision/raft`, { method: "POST", headers: auth ? { authorization: auth } : {}, body: JSON.stringify(body) });

await check("a registration: scope read from Raft, account confirmed, pending hook, grant sent back to Raft only", async () => {
  const fake = raftFake();
  const { d, rows, grants, asked } = deps({ fake });
  const res = await provisionRaft(req({ handoffId: HANDOFF, callbackUrl: "https://evil.test/x", antiprotonAgentId: "someone" }), d);
  const out: any = await res.json();
  const hash = await sha256Hex(`${ORIGIN}/hooks/${HOOK}`);
  must(res.status === 200 && out.state === "accepted" && out.hookId === HOOK && out.endpointHash === hash && out.registrationId === "reg-1", JSON.stringify(out));
  must(!JSON.stringify(out).includes("aphg_"), "the grant reached the caller");
  must(fake.calls.length === 2 && fake.calls.every((c) => c.url.startsWith(`${RAFT}/internal/external-agent-provisioning/${HANDOFF}`)), `calls ${JSON.stringify(fake.calls.map((c) => c.url))}`);
  must(fake.calls.every((c) => c.auth === `Bearer ${CAP}` && c.redirect === "manual"), "a call carried another credential or followed redirects");
  must(asked.length === 1 && asked[0].alias === "raft" && asked[0].plugin === "raft" && asked[0].account === "ragent-1", JSON.stringify(asked));
  const sent = fake.calls[1].body;
  must(sent.grant === "aphg_" + "g".repeat(43) && sent.nonce === "nonce-12345" && sent.secretVersion === 1 && sent.hookId === HOOK && sent.endpointHash === hash, JSON.stringify(sent));
  must(rows.get(HOOK)?.pending === true && rows.get(HOOK)?.agentId === "u-a", "the hook is not pending for the scoped agent");
  must(grants.length === 1 && grants[0].nonce === "nonce-12345" && grants[0].grantHash !== sent.grant, "grant row");
});

await check("nothing is created when the account is not confirmed, and the caller learns only the kind", async () => {
  for (const [confirm, status, error] of [[{ ok: false, kind: "mismatch" }, 403, "account_mismatch"], [{ ok: false, kind: "unreachable" }, 503, "account_unconfirmed"]] as const) {
    const fake = raftFake();
    const { d, rows, grants } = deps({ fake, confirm });
    const res = await provisionRaft(req(), d);
    const out: any = await res.json();
    must(res.status === status && out.error === error && Object.keys(out).length === 1, `${status}: ${JSON.stringify(out)}`);
    must(rows.size === 0 && grants.length === 0 && fake.calls.length === 1, "a hook, a grant or a callback happened");
  }
});

await check("no configured origin, no capability, or a malformed id: refused before Raft is called", async () => {
  const fake = raftFake();
  for (const [d, r, status] of [
    [deps({ fake, raftOrigin: undefined }).d, req(), 503],
    [deps({ fake, raftOrigin: "https://raft.test/path" }).d, req(), 503],
    [deps({ fake }).d, req(undefined, null), 401],
    [deps({ fake }).d, req(undefined, "Basic abc"), 401],
    [deps({ fake }).d, req({ handoffId: "../x" }), 400],
  ] as const) {
    const res = await provisionRaft(r, d);
    must(res.status === status, `expected ${status}, got ${res.status}`);
  }
  must(fake.calls.length === 0, "Raft was called");
});

await check("Raft refusing, failing, or describing something malformed stops before anything exists", async () => {
  const cases: Array<[Parameters<typeof raftFake>[0], number, string]> = [
    [{ get: [{ status: 401 }] }, 401, "handoff_not_accepted"],
    [{ get: [{ status: 302 }] }, 401, "handoff_not_accepted"],
    [{ get: [{ status: 503 }] }, 502, "raft_unreachable"],
    [{ get: ["throw"] }, 502, "raft_unreachable"],
    [{ scope: { state: "accepted" } }, 409, "handoff_invalid"],
    [{ scope: { schema: "other" } }, 409, "handoff_invalid"],
    [{ scope: { mountAlias: "Raft__x" } }, 409, "handoff_invalid"],
    [{ scope: { antiprotonTenantId: undefined } }, 409, "handoff_invalid"],
    [{ scope: { expiresAt: NOW + 10_000 } }, 409, "handoff_invalid"],
    [{ scope: { secretVersion: 0 } }, 409, "handoff_invalid"],
    [{ scope: { secretVersion: 2 } }, 409, "handoff_invalid"],
  ];
  for (const [opts, status, error] of cases) {
    const fake = raftFake(opts);
    const { d, rows, grants } = deps({ fake });
    const res = await provisionRaft(req(), d);
    const out: any = await res.json();
    must(res.status === status && out.error === error, `${JSON.stringify(opts)}: ${res.status} ${JSON.stringify(out)}`);
    must(rows.size === 0 && grants.length === 0, `${JSON.stringify(opts)} left something behind`);
  }
});

await check("a grant lives no longer than the handoff, and never past ten minutes", async () => {
  const short = raftFake({ scope: { expiresAt: NOW + 60_000 } });
  const a = deps({ fake: short });
  await provisionRaft(req(), a.d);
  must(a.grants[0].expiresAt === NOW + 60_000, `short: ${a.grants[0]?.expiresAt}`);
  const long = raftFake({ scope: { expiresAt: NOW + 3_600_000 } });
  const b = deps({ fake: long });
  await provisionRaft(req(), b.d);
  must(b.grants[0].expiresAt === NOW + PROVISION_GRANT_MAX_MS, `long: ${b.grants[0]?.expiresAt}`);
});

await check("a definite no withdraws the pending hook; a lost answer never does", async () => {
  // Refused outright, or answered for something else.
  for (const post of [[{ status: 409 }], [{ status: 200, json: { state: "accepted", registrationId: "reg-2" } }]] as Answer[][]) {
    const { d, rows } = deps({ fake: raftFake({ post }) });
    const res = await provisionRaft(req(), d);
    must(res.status === 502 && (await res.json() as any).error === "grant_rejected", `post ${JSON.stringify(post)}: ${res.status}`);
    must(rows.get(HOOK)?.revokedAt !== null, "a rejected hook was left pending");
  }
  // Lost, and Raft says it failed: withdrawn.
  {
    const fake = raftFake({ post: ["throw"] });
    const scope = fake.scope;
    const { d, rows } = deps({ fake: { ...fake, fetch: raftFake({ get: [{ status: 200, json: scope }, { status: 200, json: { state: "expired" } }], post: ["throw"] }).fetch } });
    const res = await provisionRaft(req(), d);
    must(res.status === 502 && (await res.json() as any).error === "grant_rejected" && rows.get(HOOK)?.revokedAt !== null, "an expired handoff kept the hook");
  }
  // Lost, and Raft cannot say: pending, recorded, not withdrawn.
  {
    const f = raftFake({ get: [{ status: 200, json: undefined }, { status: 503 }], post: ["throw"] });
    const first = f.scope;
    const g = raftFake({ get: [{ status: 200, json: first }, { status: 503 }], post: ["throw"] });
    const { d, rows, notes } = deps({ fake: g });
    const res = await provisionRaft(req(), d);
    must(res.status === 502 && (await res.json() as any).error === "callback_outcome_unknown", `unknown: ${res.status}`);
    must(rows.get(HOOK)?.pending === true && rows.get(HOOK)?.revokedAt === null, "an unknown outcome withdrew or activated the hook");
    must(notes.length === 1 && /callback_outcome_unknown/.test(notes[0]), JSON.stringify(notes));
    must(f.calls.length === 0, "unused fake was called");
  }
});

await check("a lost answer Raft did accept is a success; a pending one is replayed once with the same payload", async () => {
  const base = raftFake().scope;
  // Accepted behind a lost answer.
  {
    const hash = await sha256Hex(`${ORIGIN}/hooks/${HOOK}`);
    const fake = raftFake({ get: [{ status: 200, json: base }, { status: 200, json: { state: "accepted", registrationId: "reg-1", hookId: HOOK, endpointHash: hash, secretVersion: 1 } }], post: [{ status: 502 }] });
    const { d, rows } = deps({ fake });
    const res = await provisionRaft(req(), d);
    must(res.status === 200 && (await res.json() as any).state === "accepted", `accepted after loss: ${res.status}`);
    must(rows.get(HOOK)?.revokedAt === null, "withdrawn although Raft accepted");
  }
  // Still pending: one replay, same payload.
  {
    const fake = raftFake({ get: [{ status: 200, json: base }, { status: 200, json: { state: "pending" } }], post: ["throw", "accept" as any] });
    const { d } = deps({ fake });
    const res = await provisionRaft(req(), d);
    must(res.status === 200, `replayed: ${res.status}`);
    const posts = fake.calls.filter((c) => c.method === "POST");
    must(posts.length === 2 && JSON.stringify(posts[0].body) === JSON.stringify(posts[1].body), "the replay was not the same payload");
  }
  // Pending twice: no second replay.
  {
    const fake = raftFake({ get: [{ status: 200, json: base }, { status: 200, json: { state: "pending" } }], post: ["throw"] });
    const { d, rows } = deps({ fake });
    const res = await provisionRaft(req(), d);
    must(res.status === 502 && fake.calls.filter((c) => c.method === "POST").length === 2 && rows.get(HOOK)?.revokedAt === null, "replayed more than once or withdrew");
  }
});

await check("a rotation reuses the bound hook, and only when hash, mount and next version all match", async () => {
  const hash = await sha256Hex(`${ORIGIN}/hooks/${OLD_HOOK}`);
  const rot = { secretVersion: 2, hookId: OLD_HOOK, endpointHash: hash };
  const setup = async (d: ProvisionDeps, alias = "raft", pending = false) =>
    d.hooks.create({ hookId: OLD_HOOK, tenantId: "demo", agentId: "u-a", alias }, { pending });
  {
    const fake = raftFake({ scope: rot });
    const x = deps({ fake });
    await setup(x.d);
    const res = await provisionRaft(req(), x.d);
    const out: any = await res.json();
    must(res.status === 200 && out.hookId === OLD_HOOK && out.secretVersion === 2 && x.grants[0].version === 2 && x.rows.size === 1, JSON.stringify(out));
  }
  for (const [label, scope, prep, version] of [
    ["another hash", { ...rot, endpointHash: "0".repeat(64) }, (d: ProvisionDeps) => setup(d), 1],
    ["another mount", rot, (d: ProvisionDeps) => setup(d, "gh"), 1],
    ["a pending hook", rot, (d: ProvisionDeps) => setup(d, "raft", true), 1],
    ["no such hook", rot, async () => {}, 1],
    ["a skipped version", { ...rot, secretVersion: 3 }, (d: ProvisionDeps) => setup(d), 1],
  ] as const) {
    const x = deps({ fake: raftFake({ scope }), version });
    await prep(x.d);
    const res = await provisionRaft(req(), x.d);
    must(res.status === 409 && (await res.json() as any).error === "hook_not_rotatable" && x.grants.length === 0, `${label}: ${res.status}`);
  }
});

await check("the scope parser takes exactly the agreed field names", async () => {
  const ok = parseScope({ schema: PROVISION_SCHEMA, state: "pending", registrationId: "r", raftAgentId: "a", antiprotonTenantId: "t",
    antiprotonAgentId: "g", mountAlias: "raft", secretVersion: 1, nonce: "nnnnnnnn", expiresAt: NOW + 60_000 }, NOW);
  must(typeof ok === "object" && ok.alias === "raft" && ok.tenantId === "t" && ok.hookId === null, JSON.stringify(ok));
  const old = parseScope({ schema: PROVISION_SCHEMA, state: "pending", registrationId: "r", raftAgentId: "a", antiprotonTenantId: "t",
    antiprotonAgentId: "g", mountId: "raft", secretVersion: 1, nonce: "nnnnnnnn", expiresAt: NOW + 60_000 }, NOW);
  must(typeof old === "string" && /mountAlias/.test(old), `mountId accepted: ${JSON.stringify(old)}`);
});

console.log(`\n  Raft push registration\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
