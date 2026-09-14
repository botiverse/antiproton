/**
 * What a model or a person may be shown of an artifact reference, and what a
 * reference may resolve to (tygg, 2026-09-14: a raw key carries tenant
 * information and must not reach users).
 */
import { AGENT_REF, keyForRef, maskRawRefs, toAgentRef } from "../src/store/refs.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const me = { tenantId: "t-me", agentId: "u-me" };
const raw = "r2://antiproton-artifacts/t/t-me/u-me/state/notes.json";

await check("a shown reference names no bucket, tenant or agent", async () => {
  const shown = toAgentRef(raw, me);
  assert(shown === `${AGENT_REF}state/notes.json`, `unexpected form: ${shown}`);
  for (const secret of ["antiproton-artifacts", "t-me", "u-me", "r2://", "t/"]) {
    assert(!String(shown).includes(secret), `the shown reference still carries ${secret}: ${shown}`);
  }
  assert(toAgentRef("t/t-me/u-me/op_1.json", me) === `${AGENT_REF}op_1.json`, "a bare key did not convert");
});

await check("a reference round-trips to the same key for its owner", async () => {
  const shown = toAgentRef(raw, me)!;
  assert(keyForRef(shown, me) === "t/t-me/u-me/state/notes.json", `wrong key: ${keyForRef(shown, me)}`);
});

await check("another agent or tenant's key is never shown and never resolves", async () => {
  assert(toAgentRef("r2://b/t/t-me/u-other/x.json", me) === null, "another agent's key was shown");
  assert(toAgentRef("r2://b/t/t-other/u-me/x.json", me) === null, "another tenant's key was shown (same agent id)");
  // The same shown path resolves under the caller's scope, never the issuer's.
  assert(keyForRef(`${AGENT_REF}x.json`, { tenantId: "t-other", agentId: "u-x" }) === "t/t-other/u-x/x.json",
    "a shown reference resolved outside the caller's own scope");
  assert(keyForRef("r2://b/t/t-other/u-x/x.json", me) === null, "a raw reference into another tenant resolved");
  // A prefix neighbour: agent `u-me` must not reach agent `u-me2`.
  assert(keyForRef("r2://b/t/t-me/u-me2/x.json", me) === null, "a neighbouring agent's raw reference resolved");
});

await check("a legacy raw reference inside the caller's scope still resolves", async () => {
  assert(keyForRef(raw, me) === "t/t-me/u-me/state/notes.json", "an old transcript's reference stopped resolving");
});

await check("a path that moves or has an empty segment resolves to nothing", async () => {
  for (const bad of ["../../t-other/u-x/x.json", "state/../../../x", "a//b", "./x", ""]) {
    assert(keyForRef(`${AGENT_REF}${bad}`, me) === null, `artifact://${bad} resolved`);
  }
  assert(keyForRef("r2://b/t/t-me/u-me/state/aa/../zz.json", me) === null, "a legacy reference with .. resolved");
  assert(keyForRef("state/notes.json", me) === null, "a bare path with no scheme resolved");
});

await check("each of the three kinds round-trips, and a shown reference is never raw", async () => {
  // The kind is where the object was written, so it survives the round trip
  // without being named anywhere (Vera, 2026-09-14).
  for (const path of ["op_7f3a.json", "state/huge2.json", "sandbox/box-1/work/sub/out.txt"]) {
    const rawRef = `r2://antiproton-artifacts/t/t-me/u-me/${path}`;
    const shown = toAgentRef(rawRef, me);
    assert(shown === `${AGENT_REF}${path}`, `${path} was shown as ${shown}`);
    assert(!String(shown).startsWith("r2://"), `a raw reference was produced: ${shown}`);
    assert(keyForRef(shown!, me) === `t/t-me/u-me/${path}`, `${path} did not resolve back to its own key`);
  }
});

await check("text written before the change is shown with the owner's raw references rewritten", async () => {
  // A stored tool result, serialised: the JSON escaping around the reference must not stop the rewrite.
  const stored = JSON.stringify({ ref: raw, note: `read it with artifacts__read { ref: "${raw}" }` });
  const shown = maskRawRefs(stored, me);
  for (const secret of ["r2://", "antiproton-artifacts", "t/t-me/u-me"]) {
    assert(!shown.includes(secret), `still carries ${secret}: ${shown}`);
  }
  assert(shown.includes(`${AGENT_REF}state/notes.json`), `not rewritten to the shown form: ${shown}`);
  // The shown form still resolves for its owner, so a model can copy it from an old transcript.
  assert(keyForRef(`${AGENT_REF}state/notes.json`, me) === "t/t-me/u-me/state/notes.json", "the rewritten form does not resolve");
  // Another agent's raw reference is not rewritten into something this owner could resolve.
  const other = "r2://b/t/t-me/u-me2/x.json";
  assert(maskRawRefs(other, me) === other, `a neighbouring agent's reference was rewritten: ${maskRawRefs(other, me)}`);
  // A regex-special id cannot widen the match.
  assert(maskRawRefs("r2://b/t/tXme/u-me/x", { tenantId: "t.me", agentId: "u-me" }) === "r2://b/t/tXme/u-me/x", "a dot in an id matched any character");
});

await check("a bare key an older error echoed is masked too, and only the owner's", async () => {
  // "no such artifact: <key>" put the bare key in tool results, and answers quoted it.
  const said = "artifacts__read: no such artifact: t/t-me/u-me/../../other/u-x/state/s.json";
  const shown = maskRawRefs(said, me);
  assert(!shown.includes("t/t-me/u-me/"), `the bare key survived: ${shown}`);
  assert(shown.includes(`${AGENT_REF}../../other/u-x/state/s.json`), `not rewritten to the shown form: ${shown}`);
  // Inside JSON and at the very start of the text.
  assert(maskRawRefs(JSON.stringify({ e: "t/t-me/u-me/op_1.json" }), me) === JSON.stringify({ e: `${AGENT_REF}op_1.json` }), "a bare key inside JSON survived");
  assert(maskRawRefs("t/t-me/u-me/x", me) === `${AGENT_REF}x`, "a bare key at the start of the text survived");
  // Not a neighbour, not another tenant, not a longer path that merely contains the scope.
  assert(maskRawRefs("t/t-me/u-me2/x", me) === "t/t-me/u-me2/x", "a neighbouring agent's bare key was rewritten");
  assert(maskRawRefs("t/t-other/u-me/x", me) === "t/t-other/u-me/x", "another tenant's bare key was rewritten");
  assert(maskRawRefs("backup/t/t-me/u-me/x", me) === "backup/t/t-me/u-me/x", "a longer path containing the scope was rewritten");
});

for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
