/**
 * The sign-in decision over the control plane (task #18): who is let in, who is refused, and that a
 * directory which cannot answer refuses instead of throwing. The SQL itself runs against real D1 in
 * test/control-plane-d1.sh; this is the decision around it.
 */
import { admit, type IdentityDirectory, type Invitation, type IdentityRow } from "../cf/src/control-plane.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

/** A directory with the same write rules as d1Identities, and hooks to make it fail or race. */
function directory(seed: Record<string, Invitation & { addedBy: string }> = {}) {
  const rows = new Map(Object.entries(seed));
  const writes: string[] = [];
  const hooks: { lookup?: () => void; beforeRegister?: () => void; register?: () => void } = {};
  const dir: IdentityDirectory = {
    async lookup(key) { hooks.lookup?.(); const r = rows.get(key); return r ? { agentId: r.agentId, tenantId: r.tenantId } : null; },
    async upsert(key, row, by) { writes.push(`upsert ${key} ${by}`); rows.set(key, { ...row, addedBy: by }); },
    async register(key, row, by) {
      hooks.beforeRegister?.();
      hooks.register?.();
      writes.push(`register ${key} ${by}`);
      if (!rows.has(key)) rows.set(key, { ...row, addedBy: by });
      const r = rows.get(key)!;
      return { agentId: r.agentId, tenantId: r.tenantId };
    },
    async remove(key) { rows.delete(key); },
    async list() { return [] as IdentityRow[]; },
    async importRows() { throw new Error("not used here"); },
  };
  return { dir, rows, writes, hooks };
}

const derived = { agentId: "u-gh-1", tenantId: "t-gh-1" };

await check("an invited key is admitted as its row, and nothing is written", async () => {
  const d = directory({ "github:1": { agentId: "u-old", tenantId: "demo", addedBy: "automation" } });
  const a = await admit(d.dir, "github:1", { openSignup: true, derive: () => derived });
  assert(a.ok && a.row.agentId === "u-old" && a.row.tenantId === "demo" && !a.registered, `got ${JSON.stringify(a)}`);
  assert(d.writes.length === 0, `wrote ${d.writes.join(", ")}`);
});

await check("with sign-up closed an unknown key is refused as not invited, and nothing is written", async () => {
  const d = directory();
  const a = await admit(d.dir, "github:1", { openSignup: false, derive: () => derived });
  assert(!a.ok && a.reason === "not-invited", `got ${JSON.stringify(a)}`);
  assert(d.writes.length === 0 && d.rows.size === 0, `wrote ${d.writes.join(", ")}`);
});

await check("with sign-up open an unknown key registers its derived pair as self", async () => {
  const d = directory();
  const a = await admit(d.dir, "github:1", { openSignup: true, derive: () => derived });
  assert(a.ok && a.registered && a.row.agentId === derived.agentId && a.row.tenantId === derived.tenantId, `got ${JSON.stringify(a)}`);
  assert(d.rows.get("github:1")?.addedBy === "self", `row ${JSON.stringify(d.rows.get("github:1"))}`);
});

await check("an operator row written between the lookup and sign-up's write wins, and is what the person gets", async () => {
  const d = directory();
  d.hooks.beforeRegister = () => { d.rows.set("github:1", { agentId: "u-old", tenantId: "demo", addedBy: "automation" }); };
  const a = await admit(d.dir, "github:1", { openSignup: true, derive: () => derived });
  assert(a.ok && a.row.agentId === "u-old" && a.row.tenantId === "demo" && !a.registered, `got ${JSON.stringify(a)}`);
  assert(d.rows.get("github:1")?.addedBy === "automation", "sign-up overwrote the operator's row");
});

await check("a directory that cannot answer refuses as unavailable, at the read and at the write, and never throws", async () => {
  const down = directory();
  down.hooks.lookup = () => { throw new Error("D1_ERROR: unavailable"); };
  const a = await admit(down.dir, "github:1", { openSignup: true, derive: () => derived });
  assert(!a.ok && a.reason === "unavailable" && /D1_ERROR/.test(a.error ?? ""), `read: got ${JSON.stringify(a)}`);
  const writeFails = directory();
  writeFails.hooks.register = () => { throw new Error("D1_ERROR: write failed"); };
  const b = await admit(writeFails.dir, "github:1", { openSignup: true, derive: () => derived });
  assert(!b.ok && b.reason === "unavailable", `write: got ${JSON.stringify(b)}`);
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
