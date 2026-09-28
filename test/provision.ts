/**
 * The provisioning rules (raft-agent-provider.v1) over fake deps: what a request must look like, what a
 * replay may do, that the token's origin binds the mount, and that the credential is sealed and never
 * echoed. The steps inside the agent's object run against a real runtime in test/provision-runtime.ts;
 * the registry's SQL against real D1 in test/control-plane-d1.sh.
 */
import { handleProvision, providerAgentId, type ProvisionDeps } from "../cf/src/provision/handlers.ts";
import type { ProvisionedAgent, ProvisionRegistry } from "../cf/src/control-plane.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const WHO = { label: "raft-prod", tenantId: "t-raft", raftOrigin: "https://api.raft.build" };
const CRED = "sk_agent_" + "R".repeat(32);

function fakeDeps() {
  let t = 1_800_000_000_000;
  const rows = new Map<string, ProvisionedAgent>();
  const calls: string[] = [];
  const fail = new Set<string>();
  const registry: ProvisionRegistry = {
    async create(r) {
      if ([...rows.values()].some((x) => x.agentId === r.agentId)) throw new Error("UNIQUE constraint failed");
      rows.set(r.raftAgentId, { ...r, createdAt: t, updatedAt: t, deletedAt: null });
    },
    async get(_t, id) { return rows.get(id) ?? null; },
    async getByAgentId(_t, agentId) { return [...rows.values()].find((r) => r.agentId === agentId) ?? null; },
    async update(_t, id, patch) {
      const r = rows.get(id);
      if (!r) return false;
      rows.set(id, { ...r, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)), updatedAt: t });
      return true;
    },
  };
  const deps: ProvisionDeps = {
    now: () => (t += 1000),
    registry,
    models: async () => [{ id: "deepseek-flash", label: "deepseek-flash" }],
    agent: {
      adopt: async (agentId, spec) => { calls.push(`adopt ${agentId} ${spec.name}|${spec.instructions}|${spec.raftOrigin}`); },
      attachCredential: async (agentId, credential) => {
        calls.push(`attach ${agentId} ${credential.length}`);
        return fail.has("attach") ? { ok: false, error: "Raft returned HTTP 401" } : { ok: true, account: "@cody" };
      },
      removeCredential: async (agentId) => { calls.push(`remove ${agentId}`); return true; },
      tool: async (agentId, name) => {
        calls.push(`${name} ${agentId}`);
        if (fail.has(name)) return { ok: false, error: `${name}: raft returned HTTP 503` };
        return { ok: true, result: name === "push_status" ? { enabled: true, registration: "active" } : { enabled: name === "enable_push" } };
      },
    },
  };
  return { deps, rows, calls, fail };
}

const body = (over: Record<string, unknown> = {}) => ({
  raftAgentId: "01JAGENT", raftServerId: "srv-1", raftOrigin: WHO.raftOrigin, name: "Cody", instructions: "be brief", credential: CRED, ...over,
});
async function call(deps: ProvisionDeps, method: string, path: string, payload?: unknown, key: string | null = null) {
  const r = await handleProvision(method, path, { idempotencyKey: key }, payload, WHO, deps);
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
  const row = f.rows.get("01JAGENT")!;
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
  for (const over of [{ name: "Cody 2" }, { instructions: "be long" }, { raftServerId: "srv-2" }, { model: "deepseek-flash" }]) {
    const r = await call(f.deps, "POST", "/agents", body(over), "01JAGENT");
    assert(r.status === 409 && r.body.error.code === "idempotency_conflict" && r.body.error.message.includes(Object.keys(over)[0]!), `${JSON.stringify(over)} → ${r.status} ${r.text}`);
  }
  assert(f.calls.length === 0 && f.rows.get("01JAGENT")!.name === "Cody", `calls ${f.calls.join(";")}`);
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
    [{ model: "gpt-9" }, "model"],
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
  assert(f.rows.get("01JAGENT")!.status === "provisioning" && !f.calls.some((c) => c.startsWith("enable_push")), JSON.stringify({ row: f.rows.get("01JAGENT"), calls: f.calls }));
  f.fail.delete("attach");
  const again = await call(f.deps, "POST", "/agents", body());
  assert(again.status === 200 && again.body.status === "active" && again.body.push.registered === true, again.text);
});

await check("a failed push registration is still a made agent: 201, registered false, the error kept, and a replay re-registers", async () => {
  const f = fakeDeps();
  f.fail.add("enable_push");
  const r = await call(f.deps, "POST", "/agents", body());
  assert(r.status === 201 && r.body.status === "active" && r.body.push.registered === false && /503/.test(r.body.push.error), r.text);
  assert(f.rows.get("01JAGENT")!.pushError!.includes("503"), JSON.stringify(f.rows.get("01JAGENT")));
  f.fail.delete("enable_push");
  const again = await call(f.deps, "POST", "/agents", body());
  assert(again.status === 200 && again.body.push.registered === true && again.body.push.error === undefined, again.text);
});

await check("PATCH changes what it is given, re-adopts with the merged persona, and refuses nothing-to-change or an unknown agent", async () => {
  const f = fakeDeps();
  await call(f.deps, "POST", "/agents", body());
  f.calls.length = 0;
  const r = await call(f.deps, "PATCH", "/agents/raft_01JAGENT", { instructions: "be thorough", model: "deepseek-flash" });
  assert(r.status === 200 && r.body.name === "Cody" && r.body.instructions === "be thorough" && r.body.model === "deepseek-flash", r.text);
  assert(f.calls.join(";") === "adopt raft_01JAGENT Cody|be thorough|https://api.raft.build", f.calls.join(";"));
  assert(f.rows.get("01JAGENT")!.instructions === "be thorough", "the registry did not change");
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

await check("GET reads the row and asks the plugin for live push status; models lists what may be chosen; other paths are not ours", async () => {
  const f = fakeDeps();
  await call(f.deps, "POST", "/agents", body());
  const got = await call(f.deps, "GET", "/agents/raft_01JAGENT");
  assert(got.status === 200 && got.body.push.registered === true && got.body.push.live.registration === "active", got.text);
  assert((await call(f.deps, "GET", "/agents/raft_nobody")).status === 404, "an unknown agent read");
  const models = await call(f.deps, "GET", "/models");
  assert(models.status === 200 && models.body.models[0].id === "deepseek-flash", models.text);
  for (const [m, p] of [["GET", "/agents"], ["POST", "/models"], ["GET", "/other"], ["DELETE", "/agents/raft_01JAGENT/credential"]] as const) {
    assert((await call(f.deps, m, p)).status === 0, `${m} ${p} was answered`);
  }
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
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
