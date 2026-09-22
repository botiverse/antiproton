/**
 * A release says what it ended, and says it from one read.
 *
 * The framework records finished spans, and it cannot work this one out for
 * itself: a container's two instants are known only inside the release, and a
 * re-read afterwards can land on a different container, because releases are
 * not serialised against calls (`stopBox` already guards its own session
 * against that interleaving). So the fact travels out with the release — in
 * two shapes, because two of the three ending paths are tool calls that never
 * reach `holds.release`.
 *
 * Each case below is the red method for one of those shapes: delete the fact
 * at that site and exactly that case fails.
 */
import { sandboxPlugin, asBoxState } from "../src/plugins/sandbox.ts";
import { LEASE_KEY, type Released } from "../src/plugins/types.ts";
import type { Json } from "../src/core/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (c: unknown, why: string) => { if (!c) throw new Error(why); };

const BOX = "box-77";
const STARTED = 1_700_000_000_000;

/** A mount whose record holds one live box, with a run9 that answers however the test says. */
function fixture(run9: (path: string, method: string) => { status: number; body: unknown }) {
  let record: Json = {
    boxId: BOX, createdAt: STARTED, lastUsedAt: STARTED + 60_000, execs: 2, saved: [], sessions: [],
  } as unknown as Json;
  const ctx: any = {
    caller: { tenantId: "t", agentId: "a", taskId: "k" },
    alias: "sandbox",
    credential: JSON.stringify({ ak: "AK", sk: "SK", project: "p" }),
    publicConfig: { account: "container" },
    connection: { get: async () => record, set: async (v: Json) => { record = v; } },
    sibling: async () => null,
  };
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const r = run9(String(url), String(init?.method ?? "GET"));
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as any;
  return { ctx, restore: () => { globalThis.fetch = real; }, read: () => record };
}

const gone = () => ({ status: 200, body: {} });
const stuck = () => ({ status: 500, body: { message: "still running" } });

/** Every field of a fact must come from the same read, which is what makes the span honest. */
function coherent(fact: Released, why: string) {
  must(fact.id === BOX, `${why}: named ${fact.id}, not the box this release ended`);
  must(fact.startedAt === STARTED, `${why}: startedAt ${fact.startedAt} is not this box's own`);
  must(fact.endedAt > fact.startedAt, `${why}: endedAt ${fact.endedAt} does not follow startedAt`);
  // The recorder stores `endedAt - startedAt`. If a fact ever carried a
  // duration from elsewhere, the row would join correctly and still be wrong —
  // the one failure a "does this row join?" check cannot see.
  must(Number.isFinite(fact.endedAt - fact.startedAt), `${why}: the two instants do not subtract`);
}

await check("holds.release hands back what it ended", async () => {
  const f = fixture(gone);
  try {
    const out = await sandboxPlugin(null as any, "local").holds!.release(f.ctx);
    must(out && typeof out === "object", `a freed container reported ${JSON.stringify(out)}, not a fact`);
    const fact = out as Released;
    coherent(fact, "release");
    must(fact.status === "freed", `a container that is gone reported status ${fact.status}`);
    // And the record really was cleared, so this is a fact about an ended span
    // rather than one invented beside a box that is still there.
    must(!asBoxState(f.read())?.boxId, "the box record still names a container after a successful release");
  } finally { f.restore(); }
});

await check("a release that did not release still reports, on the throw", async () => {
  // The case that matters most: the box is alive and charging. The contract
  // makes this throw so it cannot read as success — and the fact rides along,
  // or the most expensive outcome would be the only unrecorded one.
  const f = fixture(stuck);
  try {
    let caught: any = null;
    try { await sandboxPlugin(null as any, "local").holds!.release(f.ctx); }
    catch (e) { caught = e; }
    must(caught, "a container that was not released did not throw");
    must(caught.released, `the failure carried no fact: ${JSON.stringify(Object.keys(caught))}`);
    coherent(caught.released, "failed release");
    must(caught.released.status === "error", `a survivor reported status ${caught.released.status}`);
    must(typeof caught.released.error === "string" && caught.released.error.length > 0,
      "a failed release did not say why");
  } finally { f.restore(); }
});

await check("the release tool reports the lease on both outcomes", async () => {
  for (const [label, run9, status] of [["freed", gone, "freed"], ["stuck", stuck, "error"]] as const) {
    const f = fixture(run9);
    try {
      const out = await sandboxPlugin(null as any, "local")
        .invoke!("release", {} as Json, f.ctx) as Record<string, unknown>;
      const fact = out[LEASE_KEY] as Released | undefined;
      must(fact, `${label}: the release tool's result carries no \`${LEASE_KEY}\``);
      coherent(fact!, `release tool (${label})`);
      must(fact!.status === status, `${label}: reported status ${fact!.status}`);
      // The model-facing fields are untouched: this key is added beside them.
      must("released" in out, `${label}: the tool stopped reporting its own boolean`);
    } finally { f.restore(); }
  }
});

await check("start_from reports the lease of the container it displaced", async () => {
  // The third ending path, and the one most easily forgotten: nobody asked for
  // a release here — the box is ended as a side effect of choosing the next
  // one. An unrecorded span is exactly as expensive as any other.
  const f = fixture(gone);
  (f.ctx.connection as any).get = async () => ({
    boxId: BOX, createdAt: STARTED, lastUsedAt: STARTED + 60_000, execs: 2, saved: [], sessions: [],
    envs: [{ name: "py", snapId: "snap-1", savedAt: STARTED + 10 }],
  });
  try {
    const out = await sandboxPlugin(null as any, "local")
      .invoke!("start_from", { name: "py" } as unknown as Json, f.ctx) as Record<string, unknown>;
    const fact = out[LEASE_KEY] as Released | undefined;
    must(fact, `start_from displaced a container and reported no \`${LEASE_KEY}\`: ${JSON.stringify(out)}`);
    coherent(fact!, "start_from");
    must(out.released === true, "start_from stopped telling the model it released the old container");
  } finally { f.restore(); }
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
