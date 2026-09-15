/**
 * /admin/transcript, the route half (cf/src/admin-transcript.ts), without a network.
 *
 * The route returns a person's whole conversation. What matters is what happens
 * before an object is opened: a refused request must never reach one, since
 * opening an object runs its constructor and writes its schema, and the object
 * is only ever asked, read-only, for exactly what the request named.
 */
import { adminTranscript, type TranscriptSource } from "../cf/src/admin-transcript.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const TOKEN = "operator-token-for-tests";
const TRANSCRIPT = { total: 1, shown: 1, events: [{ sequence: 1, kind: "message", payload: { text: "hi" }, createdAt: 0 }], byOp: {}, busy: null };

/** An object that records being opened and asked, and answers `answer`. */
function objects(answer: unknown | null = TRANSCRIPT) {
  const opened: string[] = [], asked: string[] = [];
  const open = (tenantId: string, agentId: string): TranscriptSource => {
    opened.push(`${tenantId}/${agentId}`);
    return {
      async adminTranscript(t, a, k) { asked.push(`${t}/${a} ${k}`); return answer; },
    };
  };
  return { open, opened, asked };
}
const request = (query: string, headers: Record<string, string> = { "x-harness-token": TOKEN }, method = "GET") =>
  new Request(`https://antiproton.ai/admin/transcript${query}`, { method, headers });

await check("refused with 401 before any object is opened: no token configured, no header, a wrong or empty one", async () => {
  const cases: Array<[string, string | undefined, Record<string, string>]> = [
    ["no token configured, a header", undefined, { "x-harness-token": TOKEN }],
    ["no token configured, an empty header", undefined, { "x-harness-token": "" }],
    ["an empty configured token, an empty header", "", { "x-harness-token": "" }],
    ["no header", TOKEN, {}],
    ["a wrong token", TOKEN, { "x-harness-token": TOKEN + "x" }],
    ["an empty header", TOKEN, { "x-harness-token": "" }],
  ];
  for (const [label, token, headers] of cases) {
    const o = objects();
    const res = await adminTranscript(request("?tenantId=demo&agentId=u-a", headers), token, o.open);
    assert(res.status === 401, `${label}: ${res.status}, not 401`);
    assert(o.opened.length === 0, `${label}: an object was opened (${o.opened.join(", ")})`);
  }
});

await check("only GET: POST and DELETE with the right token are 405, before any object is opened", async () => {
  for (const method of ["POST", "DELETE", "PUT"]) {
    const o = objects();
    const res = await adminTranscript(request("?agentId=u-a", undefined, method), TOKEN, o.open);
    assert(res.status === 405, `${method}: ${res.status}, not 405`);
    assert(o.opened.length === 0, `${method}: an object was opened`);
  }
});

await check("the agent is named and valid: missing, empty and malformed ids are 400 before any object is opened", async () => {
  for (const query of ["", "?tenantId=demo", "?agentId=", "?tenantId=demo&agentId=a%2Fb", "?tenantId=bad%20tenant&agentId=u-a", "?tenantId=&agentId=u-a"]) {
    const o = objects();
    const res = await adminTranscript(request(query), TOKEN, o.open);
    assert(res.status === 400, `"${query}": ${res.status}, not 400`);
    assert(o.opened.length === 0, `"${query}": an object was opened (${o.opened.join(", ")})`);
  }
});

await check("an agent or conversation the object does not hold is 404, and the object was asked for exactly that", async () => {
  // "null" is a legal id: it is what a missing agentId used to turn into, so it has to reach the object and be refused there.
  const o = objects(null);
  const res = await adminTranscript(request("?agentId=null"), TOKEN, o.open);
  assert(res.status === 404, `${res.status}, not 404`);
  assert(o.opened.join() === "demo/null", `opened ${o.opened.join(", ")}`);
  assert(o.asked.join() === "demo/null t_null", `asked ${o.asked.join(", ")}`);
});

await check("the right token and a named agent: 200 with the object's transcript, for the conversation named or the default", async () => {
  const o = objects();
  const res = await adminTranscript(request("?tenantId=demo&agentId=u-a"), TOKEN, o.open);
  assert(res.status === 200, `${res.status}, not 200`);
  const body = await res.json() as typeof TRANSCRIPT;
  assert(body.events?.[0]?.payload?.text === "hi", `body ${JSON.stringify(body).slice(0, 120)}`);
  const named = objects();
  await adminTranscript(request("?tenantId=demo&agentId=u-a&taskId=task_x"), TOKEN, named.open);
  assert(o.asked.join() === "demo/u-a t_u-a" && named.asked.join() === "demo/u-a task_x",
    `asked ${o.asked.join(", ")} and ${named.asked.join(", ")}`);
});

await check("the object's half only reads: adminTranscript opens no agent, runtime or store, and reads through readTranscript", async () => {
  // It runs inside the Durable Object, which this suite cannot start; uiTranscript, beside it, creates the
  // default conversation on first use (Ada, #336). So the body is read, and the read is checked to have found it.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../cf/src/index.ts", import.meta.url), "utf8");
  const start = src.indexOf("  async adminTranscript(");
  const end = src.indexOf("\n  }\n", start);
  assert(start >= 0 && end > start, "adminTranscript was not found in cf/src/index.ts");
  const body = src.slice(start, end);
  for (const call of ["#conversation(", "#claim(", "createTask(", "uiTranscript(", "uiEnsure(", "runtime(", ".agent(", "store.", "#transcript("]) {
    assert(!body.includes(call), `adminTranscript calls ${call}`);
  }
  // The read itself, and that it changes nothing, is test/transcript-read.ts, on a real database.
  assert(body.includes("return readTranscript(this.sql,"), "adminTranscript no longer reads through readTranscript");
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
