/**
 * /admin/diagnose, the route half (cf/src/admin-diagnose.ts), without a network.
 *
 * It shares /admin/transcript's gate (cf/src/admin-read.ts), so the same
 * refusals come before any object is opened, and every answer carries no-store.
 * It used to open when no token was configured, take a missing agentId as
 * "null", and answer POST like GET.
 */
import { adminDiagnose, type DiagnosisSource } from "../cf/src/admin-diagnose.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const TOKEN = "operator-token-for-tests";

function objects(answer: unknown | null = { owner: { tenantId: "demo", agentId: "u-a" } }) {
  const opened: string[] = [], asked: string[] = [];
  const open = (tenantId: string, agentId: string): DiagnosisSource => {
    opened.push(`${tenantId}/${agentId}`);
    return { async diagnose(t, a, k) { asked.push(`${t}/${a} ${k}`); return answer; } };
  };
  return { open, opened, asked };
}
const request = (query: string, headers: Record<string, string> = { "x-harness-token": TOKEN }, method = "GET") =>
  new Request(`https://antiproton.ai/admin/diagnose${query}`, { method, headers });

await check("refused before any object is opened: no token configured, a wrong token, POST, a missing or malformed agent", async () => {
  const cases: Array<[string, Request, string | undefined, number]> = [
    ["no token configured", request("?agentId=u-a"), undefined, 401],
    ["a wrong token", request("?agentId=u-a", { "x-harness-token": "nope" }), TOKEN, 401],
    ["POST", request("?agentId=u-a", undefined, "POST"), TOKEN, 405],
    ["no agentId", request(""), TOKEN, 400],
    ["a malformed agentId", request("?agentId=a%2Fb"), TOKEN, 400],
  ];
  for (const [label, req, token, status] of cases) {
    const o = objects();
    const res = await adminDiagnose(req, token, o.open);
    assert(res.status === status, `${label}: ${res.status}, not ${status}`);
    assert(o.opened.length === 0, `${label}: an object was opened`);
    assert(res.headers.get("cache-control") === "no-store", `${label}: cache-control ${res.headers.get("cache-control")}`);
  }
});

await check("an agent the object does not hold is 404; one it holds is 200 with the report, for the conversation named", async () => {
  const missing = objects(null);
  const r404 = await adminDiagnose(request("?agentId=null"), TOKEN, missing.open);
  assert(r404.status === 404 && missing.asked.join() === "demo/null t_null", `404: ${r404.status} ${missing.asked}`);
  const held = objects();
  const r200 = await adminDiagnose(request("?tenantId=demo&agentId=u-a&taskId=task_x"), TOKEN, held.open);
  assert(r200.status === 200 && held.asked.join() === "demo/u-a task_x", `200: ${r200.status} ${held.asked}`);
  assert(r200.headers.get("cache-control") === "no-store", "the report can be cached");
  assert(((await r200.json()) as any).owner?.agentId === "u-a", "the report is not the object's answer");
});

await check("the object's half reads through readDiagnosis and opens no runtime, agent or conversation", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../cf/src/index.ts", import.meta.url), "utf8");
  const start = src.indexOf("  async diagnose(tenantId: string, agentId: string, taskId: string) {");
  const end = src.indexOf("\n  }\n", start);
  assert(start >= 0 && end > start, "diagnose was not found in cf/src/index.ts");
  const body = src.slice(start, end);
  assert(body.includes("return readDiagnosis(this.sql,"), "diagnose no longer reads through readDiagnosis");
  for (const call of [".agent(", "ready(", "uiTranscript(", "#conversation(", "#claim(", "CREATE TABLE"]) {
    assert(!body.includes(call), `diagnose calls ${call}`);
  }
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
