/**
 * The provisioning rules (raft-agent-provider.v1) over fake deps: what a request must look like, what a
 * replay may do, that the token's origin binds the mount, and that the credential is sealed and never
 * echoed. The steps inside the agent's object run against a real runtime in test/provision-runtime.ts;
 * the registry's SQL against real D1 in test/control-plane-d1.sh.
 */
import { handleProvision, providerAgentId, repairPush, type ProvisionDeps } from "../cf/src/provision/handlers.ts";
import type { ProvisionedAgent, ProvisionRegistry } from "../cf/src/control-plane.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const WHO = { label: "raft-prod", tenantId: "t-raft", raftOrigin: "https://api.raft.build", scope: "tenant" as const };
const PLATFORM = { label: "raft-deployment", raftOrigin: "https://api.raft.build", scope: "platform" as const };
const CRED = "sk_agent_" + "R".repeat(32);

function fakeDeps() {
  let t = 1_800_000_000_000;
  const rows = new Map<string, ProvisionedAgent>();
  const calls: string[] = [];
  const tenants = new Set<string>();
  const fail = new Set<string>();
  const k = (tenantId: string, id: string) => `${tenantId}/${id}`;
  const registry: ProvisionRegistry = {
    async create(r) {
      if (fail.has("create")) throw new Error("D1_ERROR: database is unavailable");
      if ([...rows.values()].some((x) => x.tenantId === r.tenantId && x.agentId === r.agentId)) throw new Error("UNIQUE constraint failed: provisioned_agents.agent_id");
      rows.set(k(r.tenantId, r.raftAgentId), { ...r, createdAt: t, updatedAt: t, deletedAt: null });
    },
    async get(tenantId, id) { return rows.get(k(tenantId, id)) ?? null; },
    async getByAgentId(tenantId, agentId) { return [...rows.values()].find((r) => r.tenantId === tenantId && r.agentId === agentId) ?? null; },
    async update(tenantId, id, patch) {
      const r = rows.get(k(tenantId, id));
      if (!r) return false;
      rows.set(k(tenantId, id), { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: t });
      return true;
    },
  };
  const deps: ProvisionDeps = {
    now: () => (t += 1000),
    registry,
    agent: {
      adopt: async (tenantId, agentId, spec) => { tenants.add(tenantId); calls.push(`adopt ${agentId} ${spec.name}|${spec.instructions}|${spec.raftOrigin}`); },
      attachCredential: async (tenantId, agentId, credential) => {
        tenants.add(tenantId); calls.push(`attach ${agentId} ${credential.length}`);
        return fail.has("attach") ? { ok: false, error: "Raft returned HTTP 401" } : { ok: true, account: "@cody" };
      },
      removeCredential: async (tenantId, agentId) => { tenants.add(tenantId); calls.push(`remove ${agentId}`); return true; },
      tool: async (tenantId, agentId, name) => {
        tenants.add(tenantId); calls.push(`${name} ${agentId}`);
        if (fail.has(name)) return { ok: false, error: `${name}: raft returned HTTP 503` };
        return { ok: true, result: { enabled: name === "enable_push" } };
      },
      pushStatus: async (tenantId, agentId) => { tenants.add(tenantId); calls.push(`status ${agentId}`); return { enabled: true, registration: "active", lastReached: null }; },
    },
  };
  return { deps, rows, calls, fail, tenants };
}

const body = (over: Record<string, unknown> = {}) => ({
  raftAgentId: "01JAGENT", raftServerId: "srv-1", raftOrigin: WHO.raftOrigin, name: "Cody", instructions: "be brief", credential: CRED, ...over,
});
async function call(deps: ProvisionDeps, method: string, path: string, payload?: unknown, key: string | null = null, who: typeof WHO | typeof PLATFORM = WHO, raftServerId: string | null = null) {
  const r = await handleProvision(method, path, { idempotencyKey: key, raftServerId }, payload, who, deps);
  if (!r) return { status: 0, body: null as any, text: "" };
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as any, text };
}

await check("POST makes the agent in five steps, in order, and the answer never carries the credential", async () => {
  const f = fakeDeps();
  const r = await call(f.deps, "POST", "/agents", body(), "01JAGENT");
  assert(r.status === 201, `status ${r.status} ${r.text}`);
  assert(r.body.providerAgentId === "raft_01JAGENT" && r.body.status === "active" && r.body.push.registered === true && r.body.push.error === undefined, r.text);
  assert(!r.text.includes(CRED) && !r.text.includes("sk_agent"), "the credential is in the answer");
  assert(f.calls.join(";") === "adopt raft_01JAGENT Cody|be brief|https://api.raft.build;attach raft_01JAGENT 41;enable_push raft_01JAGENT", f.calls.join(";"));
  const row = f.rows.get("t-raft/01JAGENT")!;
  assert(row.status === "active" && row.pushRegistered && row.pushError === null && !JSON.stringify(row).includes("sk_agent"), JSON.stringify(row));
});

await check("a replay with the same body is 200, makes no second row, and finishes the steps again", async () => {
  const f = fakeDeps();
  await call(f.deps, "POST", "/agents", body(), "01JAGENT");
  f.calls.length = 0;
  const again = await call(f.deps, "POST", "/agents", body(), "01JAGENT");
  assert(again.status === 200 && again.body.providerAgentId === "raft_01JAGENT" && f.rows.size === 1, `${again.status} rows ${f.rows.size}`);
  assert(f.calls.join(";") === "adopt raft_01JAGENT Cody|be brief|https://api.raft.build;attach raft_01JAGENT 41;enable_push raft_01JAGENT", f.calls.join(";"));
});

await check("the same key with any field different is 409 and touches nothing: edits go through PATCH", async () => {
  const f = fakeDeps();
  await call(f.deps, "POST", "/agents", body(), "01JAGENT");
  f.calls.length = 0;
  for (const over of [{ name: "Cody 2" }, { instructions: "be long" }, { raftServerId: "srv-2" }]) {
    const r = await call(f.deps, "POST", "/agents", body(over), "01JAGENT");
    assert(r.status === 409 && r.body.error.code === "idempotency_conflict" && r.body.error.message.includes(Object.keys(over)[0]!), `${JSON.stringify(over)} → ${r.status} ${r.text}`);
  }
  assert(f.calls.length === 0 && f.rows.get("t-raft/01JAGENT")!.name === "Cody", `calls ${f.calls.join(";")}`);
});

await check("a replay that carries a different credential is 409, so a delayed retry cannot overwrite a newer one; a row from before the hash accepts and records the first replay", async () => {
  const f = fakeDeps();
  await call(f.deps, "POST", "/agents", body());
  f.calls.length = 0;
  const other = await call(f.deps, "POST", "/agents", body({ credential: "sk_agent_" + "N".repeat(32) }));
  assert(other.status === 409 && /credential/.test(other.body.error.message) && f.calls.length === 0, `${other.status} ${other.text} calls ${f.calls.join(";")}`);
  const same = await call(f.deps, "POST", "/agents", body());
  assert(same.status === 200, same.text);
  // PUT rotates: the new hash is what a later replay is compared against.
  await call(f.deps, "PUT", "/agents/raft_01JAGENT/credential", { credential: "sk_agent_" + "N".repeat(32) });
  const stale = await call(f.deps, "POST", "/agents", body());
  assert(stale.status === 409, `a replay with the pre-rotation credential got ${stale.status}`);
  // A row made before the hash existed (null): the first replay is accepted and records the hash.
  const row = f.rows.get("t-raft/01JAGENT")!; f.rows.set("t-raft/01JAGENT", { ...row, credentialHash: null });
  const first = await call(f.deps, "POST", "/agents", body());
  assert(first.status === 200 && f.rows.get("t-raft/01JAGENT")!.credentialHash !== null, `${first.status} hash ${f.rows.get("t-raft/01JAGENT")!.credentialHash}`);
});

await check("a registry failure that is not the unique index is not a conflict: it propagates, so Raft retries instead of giving up", async () => {
  const f = fakeDeps();
  f.fail.add("create");
  let threw: unknown = null;
  try { await call(f.deps, "POST", "/agents", body()); } catch (e) { threw = e; }
  assert(threw !== null && /D1_ERROR/.test(String((threw as Error).message)), `no propagation: ${String(threw)}`);
  assert(f.rows.size === 0 && f.calls.length === 0, "something was made");
});

await check("a POST whose raftOrigin is not the token's is 422 before anything is made", async () => {
  const f = fakeDeps();
  const r = await call(f.deps, "POST", "/agents", body({ raftOrigin: "https://evil.example" }));
  assert(r.status === 422 && r.body.error.code === "origin_mismatch" && r.body.error.param === "raftOrigin", r.text);
  assert(f.rows.size === 0 && f.calls.length === 0, "something was made");
});

await check("each malformed field is 422 naming the field, and nothing is made", async () => {
  const f = fakeDeps();
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ raftAgentId: "has space" }, "raftAgentId"],
    [{ raftServerId: "" }, "raftServerId"],
    [{ raftOrigin: "not a url" }, "raftOrigin"],
    [{ name: "" }, "name"],
    [{ name: "x".repeat(61) }, "name"],
    [{ instructions: "x".repeat(8001) }, "instructions"],
    [{ instructions: `use ${"sk" + "_agent_" + "Q".repeat(24)} for raft` }, "instructions"],
    [{ credential: "not-a-credential" }, "credential"],
    [{ credential: undefined }, "credential"],
  ];
  for (const [over, param] of cases) {
    const r = await call(f.deps, "POST", "/agents", body(over));
    assert(r.status === 422 && r.body.error.param === param, `${JSON.stringify(over)} → ${r.status} ${r.text}`);
    assert(!r.text.includes("sk_agent_Q"), "a credential-shaped string was echoed");
  }
  const key = await call(f.deps, "POST", "/agents", body(), "other-key");
  assert(key.status === 422 && key.body.error.param === "Idempotency-Key", key.text);
  assert(f.rows.size === 0 && f.calls.length === 0, "something was made");
});

await check("a refused credential leaves the row provisioning without push, and the replay that fixes it finishes", async () => {
  const f = fakeDeps();
  f.fail.add("attach");
  const r = await call(f.deps, "POST", "/agents", body());
  assert(r.status === 422 && r.body.error.code === "credential_refused" && r.body.error.param === "credential", r.text);
  assert(f.rows.get("t-raft/01JAGENT")!.status === "provisioning" && !f.calls.some((c) => c.startsWith("enable_push")), JSON.stringify({ row: f.rows.get("t-raft/01JAGENT"), calls: f.calls }));
  f.fail.delete("attach");
  const again = await call(f.deps, "POST", "/agents", body());
  assert(again.status === 200 && again.body.status === "active" && again.body.push.registered === true, again.text);
});

await check("a failed push registration is still a made agent: 201, registered false, the error kept, and a replay re-registers", async () => {
  const f = fakeDeps();
  f.fail.add("enable_push");
  const r = await call(f.deps, "POST", "/agents", body());
  assert(r.status === 201 && r.body.status === "active" && r.body.push.registered === false && /503/.test(r.body.push.error), r.text);
  assert(f.rows.get("t-raft/01JAGENT")!.pushError!.includes("503"), JSON.stringify(f.rows.get("t-raft/01JAGENT")));
  f.fail.delete("enable_push");
  const again = await call(f.deps, "POST", "/agents", body());
  assert(again.status === 200 && again.body.push.registered === true && again.body.push.error === undefined, again.text);
});

await check("PATCH changes what it is given, re-adopts with the merged persona, and refuses nothing-to-change or an unknown agent", async () => {
  const f = fakeDeps();
  await call(f.deps, "POST", "/agents", body());
  f.calls.length = 0;
  const r = await call(f.deps, "PATCH", "/agents/raft_01JAGENT", { instructions: "be thorough" });
  assert(r.status === 200 && r.body.name === "Cody" && r.body.instructions === "be thorough" && !("model" in r.body), r.text);
  assert(f.calls.join(";") === "adopt raft_01JAGENT Cody|be thorough|https://api.raft.build", f.calls.join(";"));
  assert(f.rows.get("t-raft/01JAGENT")!.instructions === "be thorough", "the registry did not change");
  const empty = await call(f.deps, "PATCH", "/agents/raft_01JAGENT", {});
  assert(empty.status === 422 && empty.body.error.code === "empty", empty.text);
  const bad = await call(f.deps, "PATCH", "/agents/raft_01JAGENT", { name: "x".repeat(61) });
  assert(bad.status === 422 && bad.body.error.param === "name", bad.text);
  const unknown = await call(f.deps, "PATCH", "/agents/raft_nobody", { name: "x" });
  assert(unknown.status === 404, unknown.text);
});

await check("PUT credential seals the new one and re-registers push; a bad shape is 422", async () => {
  const f = fakeDeps();
  await call(f.deps, "POST", "/agents", body());
  f.calls.length = 0;
  const r = await call(f.deps, "PUT", "/agents/raft_01JAGENT/credential", { credential: "sk_agent_" + "N".repeat(32) });
  assert(r.status === 200 && r.body.push.registered === true && !r.text.includes("sk_agent"), r.text);
  assert(f.calls.join(";") === "attach raft_01JAGENT 41;enable_push raft_01JAGENT", f.calls.join(";"));
  const bad = await call(f.deps, "PUT", "/agents/raft_01JAGENT/credential", { credential: "nope" });
  assert(bad.status === 422 && bad.body.error.param === "credential", bad.text);
});

await check("DELETE stops push, removes the credential, marks the row, and is the same answer the second time; GET then shows deleted without a live probe", async () => {
  const f = fakeDeps();
  await call(f.deps, "POST", "/agents", body());
  f.calls.length = 0;
  const r = await call(f.deps, "DELETE", "/agents/raft_01JAGENT");
  assert(r.status === 200 && r.body.status === "deleted" && r.body.push.registered === false && r.body.deletedAt !== null, r.text);
  assert(f.calls.join(";") === "disable_push raft_01JAGENT;remove raft_01JAGENT", f.calls.join(";"));
  f.calls.length = 0;
  const again = await call(f.deps, "DELETE", "/agents/raft_01JAGENT");
  assert(again.status === 200 && again.body.status === "deleted" && f.calls.length === 0, `${again.text} calls ${f.calls.join(";")}`);
  const got = await call(f.deps, "GET", "/agents/raft_01JAGENT");
  assert(got.status === 200 && got.body.status === "deleted" && got.body.push.live === undefined && f.calls.length === 0, got.text);
  for (const [m, p, b] of [["PATCH", "/agents/raft_01JAGENT", { name: "x" }], ["PUT", "/agents/raft_01JAGENT/credential", { credential: CRED }]] as const) {
    const after = await call(f.deps, m, p, b);
    assert(after.status === 404, `${m} on a deleted agent → ${after.status}`);
  }
  const recreate = await call(f.deps, "POST", "/agents", body());
  assert(recreate.status === 409 && recreate.body.error.code === "deleted", recreate.text);
  assert((await call(f.deps, "DELETE", "/agents/raft_nobody")).status === 404, "an unknown agent deleted");
});

await check("a DELETE whose disable_push fails still deletes, and says what could not be undone", async () => {
  const f = fakeDeps();
  await call(f.deps, "POST", "/agents", body());
  f.fail.add("disable_push");
  const r = await call(f.deps, "DELETE", "/agents/raft_01JAGENT");
  assert(r.status === 200 && r.body.status === "deleted" && /503/.test(r.body.push.error), r.text);
  assert(f.calls.some((c) => c.startsWith("remove ")), "the credential stayed");
});

await check("GET reads the row and asks the plugin for live push status; there is no model anywhere; other paths are not ours", async () => {
  const f = fakeDeps();
  const made = await call(f.deps, "POST", "/agents", body({ model: "deepseek-flash" }));
  assert(made.status === 201 && !("model" in made.body), `a model field came back: ${made.text}`);
  f.calls.length = 0;
  const got = await call(f.deps, "GET", "/agents/raft_01JAGENT");
  assert(got.status === 200 && got.body.push.registered === true && got.body.push.live.registration === "active", got.text);
  // Read from the mount's state, never through the gateway: a poll leaves no tool call behind.
  assert(f.calls.join(";") === "status raft_01JAGENT", `GET ran tools: ${f.calls.join(";")}`);
  assert((await call(f.deps, "GET", "/agents/raft_nobody")).status === 404, "an unknown agent read");
  for (const [m, p] of [["GET", "/agents"], ["GET", "/models"], ["GET", "/other"], ["DELETE", "/agents/raft_01JAGENT/credential"]] as const) {
    assert((await call(f.deps, m, p)).status === 0, `${m} ${p} was answered`);
  }
});

await check("an agent is also addressed by the Raft id it was made from, so a lost POST answer still lets Raft delete it", async () => {
  const f = fakeDeps();
  const never = await call(f.deps, "DELETE", "/agents/by-raft-agent/01JAGENT");
  assert(never.status === 404 && /Raft agent 01JAGENT/.test(never.body.error.message), `never created → ${never.status} ${never.text}`);
  await call(f.deps, "POST", "/agents", body());
  const got = await call(f.deps, "GET", "/agents/by-raft-agent/01JAGENT");
  assert(got.status === 200 && got.body.providerAgentId === "raft_01JAGENT" && got.body.push.live.enabled === true, got.text);
  const patched = await call(f.deps, "PATCH", "/agents/by-raft-agent/01JAGENT", { name: "Cody 2" });
  assert(patched.status === 200 && patched.body.name === "Cody 2", patched.text);
  const cred = await call(f.deps, "PUT", "/agents/by-raft-agent/01JAGENT/credential", { credential: CRED });
  assert(cred.status === 200 && cred.body.push.registered === true, cred.text);
  f.calls.length = 0;
  const gone = await call(f.deps, "DELETE", "/agents/by-raft-agent/01JAGENT");
  assert(gone.status === 200 && gone.body.status === "deleted" && f.calls.join(";") === "disable_push raft_01JAGENT;remove raft_01JAGENT", gone.text);
  assert((await call(f.deps, "DELETE", "/agents/by-raft-agent/01JAGENT")).status === 200, "a second delete by Raft id changed its answer");
  assert((await call(f.deps, "GET", "/agents/raft_01JAGENT")).body.status === "deleted", "the two addresses disagree");
  for (const [m, p] of [["GET", "/agents/by-raft-agent"], ["GET", "/agents/by-raft-agent/01JAGENT/other"], ["PUT", "/agents/by-raft-agent/01JAGENT/credential/x"]] as const) {
    assert((await call(f.deps, m, p, {})).status === 0, `${m} ${p} was answered`);
  }
});

await check("a platform token acts in the tenant named by the Raft server: raft_<serverId> on POST from the body, elsewhere from the URL, and none without it", async () => {
  const f = fakeDeps();
  const made = await call(f.deps, "POST", "/agents", body({ raftServerId: "d21383ee-df0a-4ed0-8f4c-ef263f2adb68" }), "01JAGENT", PLATFORM);
  assert(made.status === 201 && [...f.tenants].join(",") === "raft_d21383ee-df0a-4ed0-8f4c-ef263f2adb68", `${made.status} tenants ${[...f.tenants]}`);
  assert(f.rows.get("raft_d21383ee-df0a-4ed0-8f4c-ef263f2adb68/01JAGENT")?.tenantId === "raft_d21383ee-df0a-4ed0-8f4c-ef263f2adb68", "row not in the derived tenant");
  // Another server, same Raft agent id: another tenant, no clash.
  const other = await call(f.deps, "POST", "/agents", body({ raftServerId: "95f993fa-2a68-4797-b8ae-7beb7d984ada" }), "01JAGENT", PLATFORM);
  assert(other.status === 201 && f.rows.size === 2, `${other.status} rows ${f.rows.size}`);
  // Reads and deletes need the server on the URL; without it nothing is looked up.
  const noServer = await call(f.deps, "GET", "/agents/by-raft-agent/01JAGENT", undefined, null, PLATFORM);
  assert(noServer.status === 422 && noServer.body.error.param === "raftServerId", noServer.text);
  const got = await call(f.deps, "GET", "/agents/by-raft-agent/01JAGENT", undefined, null, PLATFORM, "95f993fa-2a68-4797-b8ae-7beb7d984ada");
  assert(got.status === 200 && got.body.raftServerId === "95f993fa-2a68-4797-b8ae-7beb7d984ada", got.text);
  const gone = await call(f.deps, "DELETE", "/agents/by-raft-agent/01JAGENT", undefined, null, PLATFORM, "d21383ee-df0a-4ed0-8f4c-ef263f2adb68");
  assert(gone.status === 200 && gone.body.status === "deleted" && f.rows.get("raft_95f993fa-2a68-4797-b8ae-7beb7d984ada/01JAGENT")?.status === "active", "the wrong server's agent was touched");
  // A tenant token ignores the URL's server: its tenant is fixed.
  const fixed = fakeDeps();
  await call(fixed.deps, "POST", "/agents", body());
  const ignored = await call(fixed.deps, "GET", "/agents/by-raft-agent/01JAGENT", undefined, null, WHO, "some-other-server");
  assert(ignored.status === 200 && [...fixed.tenants].join(",") === "t-raft", ignored.text);
  const badServer = await call(f.deps, "POST", "/agents", body({ raftServerId: "has space" }), "01JAGENT", PLATFORM);
  assert(badServer.status === 422 && badServer.body.error.param === "raftServerId", badServer.text);
});

await check("the antiproton agent id is the Raft id, prefixed, made legal for an object name, and bounded", async () => {
  assert(providerAgentId("01JAGENT") === "raft_01JAGENT", providerAgentId("01JAGENT"));
  assert(providerAgentId("a/b:c") === "raft_a_b_c", providerAgentId("a/b:c"));
  assert(providerAgentId("x".repeat(64)).length === 64, `length ${providerAgentId("x".repeat(64)).length}`);
  assert(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(providerAgentId("01JAGENT")), "not an object name");
  const f = fakeDeps();
  // Two Raft ids that sanitise alike: ":" is legal in a Raft id and not in an object name.
  assert((await call(f.deps, "POST", "/agents", body({ raftAgentId: "a_b" }))).status === 201, "the first of the pair was not made");
  const clash = await call(f.deps, "POST", "/agents", body({ raftAgentId: "a:b" }));
  assert(clash.status === 409 && clash.body.error.code === "agent_id_taken", clash.text);
});

console.log(`\n  provision (raft-agent-provider.v1)\n  ${"─".repeat(56)}`);
await check("the push repair re-registers through the same tool creation used, and the row follows the result", async () => {
  const { deps, rows, calls, fail } = fakeDeps();
  const made = await call(deps, "POST", "/agents", body(), "01JAGENT");
  assert(made.status === 201, `create: ${made.status} ${made.text}`);
  const before = calls.length;
  const row = [...rows.values()][0]!;
  const fixed = await repairPush(deps, row.tenantId, row.raftAgentId);
  assert(fixed.ok && fixed.push === true && fixed.error === null, `repair: ${JSON.stringify(fixed)}`);
  assert(calls.slice(before).join(";") === `enable_push ${row.agentId}`, `the repair did something other than enable_push: ${calls.slice(before).join(";")}`);
  fail.add("enable_push");
  const broken = await repairPush(deps, row.tenantId, row.raftAgentId);
  assert(broken.ok && broken.push === false && /503/.test(String(broken.error)), `a failed registration must say so: ${JSON.stringify(broken)}`);
  assert(rows.get(`${row.tenantId}/${row.raftAgentId}`)!.pushRegistered === false, "the row still says registered after a failed repair");
  const missing = await repairPush(deps, row.tenantId, "never-made");
  assert(!missing.ok && /no live provisioned agent never-made/.test(missing.error), `an unknown agent: ${JSON.stringify(missing)}`);
});

for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
