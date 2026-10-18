/**
 * The operator's storage scan (cf/src/storage-scan.ts, `POST /admin/storage-scan`): where a string is stored for one
 * agent, in its object's SQLite and its R2 prefixes, answered as table names and a count of objects, never the needle
 * or a row. Through the Worker's own `fetch` for the route, with the object's half run on a real SQLite.
 */
import { register } from "node:module";
import { sqliteHost } from "../src/store/sqlite-host.ts";

const STAND_IN = "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }" +
  " export class RpcTarget {} export const env = {};";
register("data:text/javascript," + encodeURIComponent(
  `export async function resolve(s, c, next) { if (s.startsWith("cloudflare:")) return { url: ${JSON.stringify("data:text/javascript," + encodeURIComponent(STAND_IN))}, shortCircuit: true }; return next(s, c); }`));
const { default: worker } = await import("../cf/src/index.ts");
const { scanObjects, scanTables, SCAN_LIMITS } = await import("../cf/src/storage-scan.ts");
const { setLogSink } = await import("../src/core/log.ts");

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.stack ?? e).split("\n").slice(0, 3).join("\n      ") }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const logs: string[] = [];
setLogSink((line) => logs.push(line));
const realLog = console.log, realWarn = console.warn, realError = console.error;
for (const k of ["log", "warn", "error"] as const) (console as any)[k] = (...a: unknown[]) => logs.push(a.map(String).join(" "));

const NEEDLE = "Zq-Needle-3301";
const TOKEN = "operator-token-scan";

/** An agent's object: a few tables, the needle in one as plain text and in another only as escaped JSON. */
function storage() {
  const host = sqliteHost();
  host.sql.exec("CREATE TABLE notes (id INTEGER, body TEXT)");
  host.sql.exec("CREATE TABLE plugin_db (k TEXT, value TEXT)");
  host.sql.exec("CREATE TABLE quiet (k TEXT, v BLOB)");
  host.sql.exec("INSERT INTO notes VALUES (1, ?)", `before ${NEEDLE.toUpperCase()} after`);
  // As JSON writes it: the needle's first letter escaped, so only the decoded string holds it.
  host.sql.exec("INSERT INTO plugin_db VALUES ('a', ?)", '{"text":"\\u005aq-Needle-3301"}');
  host.sql.exec("INSERT INTO quiet VALUES ('b', ?)", new TextEncoder().encode("nothing here"));
  return host;
}

function bucket(objects: Record<string, string>) {
  return {
    async list(o: { prefix: string }) { return { objects: Object.keys(objects).filter((k) => k.startsWith(o.prefix)).map((key) => ({ key, size: objects[key]!.length })), truncated: false }; },
    async get(key: string) { const v = objects[key]; return v === undefined ? null : { text: async () => v }; },
  };
}

await check("tables: found case-insensitively, as plain text and inside a JSON-escaped string; a table without it is not named", () => {
  const out = scanTables(storage().sql as never, NEEDLE.toLowerCase());
  must(show(out.tables.sort()) === show(["notes", "plugin_db"]) && out.scanned.tables === 3 && out.scanned.rows === 3 && !out.truncated, show(out));
  const none = scanTables(storage().sql as never, "not-stored-anywhere");
  must(none.tables.length === 0 && none.scanned.rows === 3, show(none));
});

await check("tables: past the row cap the answer says truncated", () => {
  const host = sqliteHost();
  host.sql.exec("CREATE TABLE many (v TEXT)");
  for (let i = 0; i < 50; i++) host.sql.exec("INSERT INTO many VALUES (?)", `row ${i}`);
  const out = scanTables(host.sql as never, "row 49", { ...SCAN_LIMITS, maxRows: 10 });
  must(out.truncated && out.scanned.rows === 10 && out.tables.length === 0, show(out));
});

await check("objects: only the agent's prefixes are read; found ones are counted; an object over the cap is not read and says so", async () => {
  const b = bucket({ "t/t1/a1/x.json": `{"q":"${NEEDLE}"}`, "trace/t1/a1/b1.json": "clean", "t/t1/other/y.json": NEEDLE, "t/t1/a1/big.bin": "x".repeat(100) });
  const out = await scanObjects(b, ["t/t1/a1/", "trace/t1/a1/"], NEEDLE, { ...SCAN_LIMITS, maxObjectBytes: 50 });
  must(out.objects === 1 && out.scanned === 2 && out.truncated, show(out));
});

// ---- the route ------------------------------------------------------------------------------------------------

function env(token: string | undefined, objects: Record<string, string>) {
  const host = storage();
  const calls: string[] = [];
  const stub = {
    adminStorageScan: async (t: string, a: string, needle: string) => { calls.push("object.adminStorageScan"); return t === "t1" && a === "a1" ? scanTables(host.sql as never, needle) : null; },
  };
  return {
    calls,
    env: {
      AGENT: { idFromName: (n: string) => n, get: () => stub },
      ARTIFACTS: bucket(objects), CONTROL_DB: { prepare: () => ({ bind: () => ({}) }) },
      ...(token === undefined ? {} : { AUTOMATION_TOKEN: token }),
    },
  };
}
async function scan(token: string | undefined, presented: string | null, body: unknown, objects: Record<string, string> = {}) {
  const w = env(token, objects);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (presented !== null) headers["x-harness-token"] = presented;
  const res = await worker.fetch(new Request("https://x/admin/storage-scan", { method: "POST", headers, body: JSON.stringify(body) }), w.env as never,
    { waitUntil() {}, passThroughOnException() {} } as never);
  return { status: res.status, text: await res.text(), calls: w.calls };
}

await check("route: found and not found, the needle in neither the answer nor any log line", async () => {
  logs.length = 0;
  const found = await scan(TOKEN, TOKEN, { tenantId: "t1", agentId: "a1", needle: NEEDLE }, { "trace/t1/a1/b.json": `x ${NEEDLE} y` });
  const body = JSON.parse(found.text);
  must(found.status === 200 && body.found === true && show(body.tables.sort()) === show(["notes", "plugin_db"]) && body.objects === 1, found.text);
  must(show(Object.keys(body).sort()) === show(["found", "objects", "scanned", "tables", "truncated"]), found.text);
  const missing = await scan(TOKEN, TOKEN, { tenantId: "t1", agentId: "a1", needle: "Zq-Nowhere-0000" });
  must(missing.status === 200 && JSON.parse(missing.text).found === false, missing.text);
  for (const text of [found.text, missing.text, ...logs]) {
    must(!text.toLowerCase().includes(NEEDLE.toLowerCase()) && !text.toLowerCase().includes("zq-nowhere"), `the needle leaked: ${text.slice(0, 200)}`);
  }
  must(logs.some((l) => l.includes("admin.storage_scan") && l.includes('"found":true')), logs.join("\n"));
});

await check("route: refused without the operator's token, before the object is asked; bad requests are 400, an unknown agent 404", async () => {
  for (const [token, presented] of [[undefined, null], [undefined, "x"], [TOKEN, null], [TOKEN, "wrong"]] as Array<[string | undefined, string | null]>) {
    const r = await scan(token, presented, { tenantId: "t1", agentId: "a1", needle: NEEDLE });
    must(r.status === 401 && r.calls.length === 0, `${token}/${presented}: ${r.status} ${show(r.calls)}`);
  }
  for (const body of [{ agentId: "a1", needle: NEEDLE }, { tenantId: "t1", agentId: "a1" }, { tenantId: "t1", agentId: "a1", needle: "ab" }]) {
    const r = await scan(TOKEN, TOKEN, body);
    must(r.status === 400 && r.calls.length === 0, `${show(body)}: ${r.status}`);
  }
  const unknown = await scan(TOKEN, TOKEN, { tenantId: "t1", agentId: "nobody", needle: NEEDLE });
  must(unknown.status === 404, unknown.text);
});

console.log = realLog; console.warn = realWarn; console.error = realError;
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const passed = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${passed} passed, ${results.length - passed} failed\n`);
process.exit(results.length > 0 && passed === results.length ? 0 : 1);
