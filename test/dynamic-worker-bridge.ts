/**
 * The SDK bridge in the box (botiverse/antiproton#1092), against the Dynamic Worker executor in node: the program
 * imports `sdk:<alias>`, the module's `fetch` makes each request one host call of `<alias>.request`, and what comes
 * back is a real `Response`. The loader is spec/worker-stand-in.ts, which evaluates the generated modules for real
 * from the module map the executor hands it, so the shim and the runner are the shipped code.
 */
import { DynamicWorkerExecutor } from "../src/runtime/dynamic-worker-executor.ts";
import { DEFAULT_LIMITS } from "../src/core/execution.ts";
import type { BridgeModule } from "../src/core/execution.ts";
import { standInLoader } from "./spec/worker-stand-in.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const standIn = standInLoader({ callHopMs: 2 });
const exec = new DynamicWorkerExecutor({ loader: standIn.loader, makeToolBinding: standIn.makeToolBinding });

// A small SDK in the shape a real one takes: a client over an injected fetch, and an error class built from the
// response's text and `x-request-id`. Two files, so the relative import between them is exercised.
const FILES = {
  "index.js": `import { ApiError } from "./errors.js";
export default function make(fetchImpl) {
  const svc = {
    async get(path) {
      const res = await fetchImpl("https://svc.example" + path, { headers: { accept: "application/json" } });
      if (!res.ok) throw new ApiError(res.status, await res.text(), res.headers.get("x-request-id"));
      return res.json();
    },
    async post(path, body) {
      const res = await fetchImpl("https://svc.example" + path, {
        method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", authorization: "Bearer box" },
      });
      return { status: res.status, ok: res.ok, text: await res.text(), id: res.headers.get("x-request-id") };
    },
    raw: fetchImpl,
  };
  return { svc, ApiError };
}`,
  "errors.js": `export class ApiError extends Error {
  constructor(status, text, requestId) { super("api " + status); this.status = status; this.text = text; this.requestId = requestId; }
}`,
};
const bridge: BridgeModule = { specifiers: ["sdk:svc"], alias: "svc", plugin: "svcplug", files: FILES, entry: "index.js", exports: ["svc", "ApiError"] };

function host(answer: (call: any) => any, calls: any[] = []) {
  return {
    bridges: [bridge],
    async invoke(call: any) { calls.push(call); return answer(call); },
  } as any;
}
const ok = (status: number, text: string, headers: Record<string, string> = {}) =>
  ({ status: "succeeded", operationId: `op_${Math.random().toString(36).slice(2, 8)}`, result: { status, headers, text } });

await check("each fetch the SDK makes is exactly one host call of <alias>.request, carrying method, path, body and headers", async () => {
  const calls: any[] = [];
  const r = await exec.execute(`const { svc } = await import("sdk:svc");
    output(await svc.get("/v1/things/7?x=1"));
    output(await svc.post("/v1/things", { a: 1 }));`,
  host((c) => (c.args.method === "GET" ? ok(200, '{"id":7}', { "content-type": "application/json" }) : ok(201, "made", { "x-request-id": "rq" })), calls));
  must(r.status === "completed", `the run did not complete: ${JSON.stringify(r)}`);
  must(calls.length === 2 && r.hostCalls === 2, `two fetches made ${calls.length} host calls (counted ${r.hostCalls})`);
  must(calls.every((c) => c.tool === "svc.request"), `calls named ${calls.map((c) => c.tool)}`);
  must(calls[0].args.method === "GET" && calls[0].args.path === "/v1/things/7?x=1" && calls[0].args.body === null,
    `the GET reached the host as ${JSON.stringify(calls[0].args)}`);
  must(calls[1].args.method === "POST" && calls[1].args.body === '{"a":1}' && calls[1].args.headers["content-type"] === "application/json",
    `the POST reached the host as ${JSON.stringify(calls[1].args)}`);
  must(JSON.stringify(r.outputs[0]) === '{"id":7}', `the GET's answer read as ${JSON.stringify(r.outputs[0])}`);
});

await check("the answer is a real Response: status, ok, text() and headers.get(), a 4xx shaped by the SDK itself", async () => {
  const r = await exec.execute(`const { svc, ApiError } = await import("sdk:svc");
    const made = await svc.post("/v1/x", {});
    output(made);
    try { await svc.get("/v1/missing"); } catch (e) { output([e instanceof ApiError, e.status, e.text, e.requestId]); }
    const res = await svc.raw("https://svc.example/v1/none", { method: "DELETE" });
    output([res instanceof Response, res.status, res.ok, await res.text()]);`,
  host((c) => c.args.method === "POST" ? ok(201, "made", { "x-request-id": "rq-1" })
    : c.args.method === "GET" ? ok(404, '{"error":"no"}', { "x-request-id": "rq-2" }) : ok(204, "")));
  must(r.status === "completed", `the run did not complete: ${JSON.stringify(r)}`);
  must(JSON.stringify(r.outputs[0]) === '{"status":201,"ok":true,"text":"made","id":"rq-1"}', `the 201 read as ${JSON.stringify(r.outputs[0])}`);
  must(JSON.stringify(r.outputs[1]) === '[true,404,"{\\"error\\":\\"no\\"}","rq-2"]', `the 404 read as ${JSON.stringify(r.outputs[1])}`);
  must(JSON.stringify(r.outputs[2]) === '[true,204,true,""]', `the 204 read as ${JSON.stringify(r.outputs[2])}`);
});

await check("a refused call reaches the SDK as a 403 carrying the gateway's code; a failed one as a rejected fetch", async () => {
  const r = await exec.execute(`const { svc } = await import("sdk:svc");
    const refused = await svc.raw("https://svc.example/v1/merge", { method: "POST" });
    output([refused.status, JSON.parse(await refused.text()).error.code]);
    try { await svc.raw("https://svc.example/v1/x"); output("no throw"); } catch (e) { output([e.name, e.message]); }`,
  host((c) => c.args.path === "/v1/merge"
    ? { status: "rejected", error: { code: "route_refused", message: "use pr_merge" } }
    : { status: "failed", operationId: "op_f", error: { code: "tool_error", message: "upstream unreachable" } }));
  must(JSON.stringify(r.outputs[0]) === '[403,"route_refused"]', `the refusal read as ${JSON.stringify(r.outputs[0])}`);
  must(JSON.stringify(r.outputs[1]) === '["TypeError","upstream unreachable"]', `the failure read as ${JSON.stringify(r.outputs[1])}`);
});

await check("the host-call budget counts bridged requests: the one past maxHostCalls is refused with host_call_budget_exceeded", async () => {
  const calls: any[] = [];
  const r = await exec.execute(`const { svc } = await import("sdk:svc");
    let codes = [];
    for (let i = 0; i < 5; i++) {
      const res = await svc.raw("https://svc.example/v1/n/" + i);
      codes.push(res.status === 403 ? JSON.parse(await res.text()).error.code : res.status);
    }
    output(codes);`,
  host(() => ok(200, "{}"), calls), { ...DEFAULT_LIMITS, maxHostCalls: 3 });
  must(calls.length === 3, `${calls.length} calls reached the host under a budget of 3`);
  must(JSON.stringify(r.outputs[0]) === '[200,200,200,"host_call_budget_exceeded","host_call_budget_exceeded"]',
    `the program saw ${JSON.stringify(r.outputs[0])}`);
});

await check("a held request ends the run paused even when the SDK's caller catches the throw and goes on", async () => {
  const calls: any[] = [];
  const r = await exec.execute(`const { svc } = await import("sdk:svc");
    output("before");
    try { await svc.post("/v1/write", { a: 1 }); } catch (e) { output("caught " + e.name); }
    output("after");
    try { await svc.get("/v1/read"); } catch (e) {}
    return "finished";`,
  host((c) => c.args.method === "POST"
    ? { status: "pending", operationId: "op_held", error: { code: "awaiting_approval", message: "held" } }
    : ok(200, "{}"), calls));
  must(r.status === "paused", `the run ended ${r.status}, not paused: ${JSON.stringify(r)}`);
  must(r.pause?.cause === "hold" && r.held?.length === 1 && r.held[0]!.operationId === "op_held",
    `the pause does not name the held request: ${JSON.stringify(r.pause)} ${JSON.stringify(r.held)}`);
  must(JSON.stringify(r.outputs) === '["before"]', `outputs after the hold were kept: ${JSON.stringify(r.outputs)}`);
  must(calls.length === 1, `a request after the hold reached the host: ${calls.map((c) => c.args.path)}`);
});

await check("without a bridge the box loads main.js alone, and an sdk: import fails", async () => {
  const r = await exec.execute(`try { await import("sdk:svc"); output("loaded"); } catch (e) { output("refused"); }`,
    { async invoke() { return ok(200, ""); } } as any);
  must(JSON.stringify(r.outputs) === '["refused"]', `a box with no bridge imported one: ${JSON.stringify(r)}`);
});

await check("bridgeModulesFor: offered mounts with a bridge only; sdk:<plugin> where it names one mount alone", async () => {
  const { bridgeModulesFor } = await import("../src/runtime/pi-tools.ts");
  const box = { files: FILES, entry: "index.js", exports: ["svc"] };
  const plugins: Record<string, any> = { svcplug: { bridge: { box } }, plain: {} };
  const tool = (address: string) => ({ name: address.replace(".", "__"), description: "", parameters: {}, address, sideEffects: "read" as const });
  const one = bridgeModulesFor([{ alias: "work", plugin: "svcplug" }, { alias: "p", plugin: "plain" }, { alias: "quiet", plugin: "svcplug" }],
    [tool("work.list"), tool("p.x")], (id) => plugins[id]);
  must(one.length === 1 && JSON.stringify(one[0]!.specifiers) === '["sdk:work","sdk:svcplug"]',
    `one offered bridge mount: ${JSON.stringify(one.map((b) => b.specifiers))}`);
  const two = bridgeModulesFor([{ alias: "a", plugin: "svcplug" }, { alias: "b", plugin: "svcplug" }], [tool("a.list"), tool("b.list")], (id) => plugins[id]);
  must(JSON.stringify(two.map((b) => b.specifiers)) === '[["sdk:a"],["sdk:b"]]', `two mounts of one plugin: ${JSON.stringify(two.map((b) => b.specifiers))}`);
});

await check("run_js hands its bridges to the executor's host, and the program's request is a host call with fromProgram set", async () => {
  const { runJsTool } = await import("../src/runtime/pi-tools.ts");
  const calls: any[] = [];
  const toolHost = { async invoke(c: any) { calls.push(c); return ok(200, '{"n":1}'); } };
  const t: any = runJsTool(exec as any, toolHost as any, { bridges: [bridge] });
  const res = await t.execute("toolu_b", { source: `const { svc } = await import("sdk:svc"); output(await svc.get("/v1/n"));` });
  must(res.content[0].text === '[{"n":1}]', `the program's output: ${JSON.stringify(res)}`);
  must(calls.length === 1 && calls[0].tool === "svc.request" && calls[0].opts?.fromProgram === true && calls[0].callId === "toolu_b",
    `the host call: ${JSON.stringify(calls)}`);
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
