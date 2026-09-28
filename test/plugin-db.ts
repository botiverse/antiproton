/**
 * The plugin database: idb's calling convention over rows in the agent's own
 * SQLite, one database per (mount, plugin). What this file pins:
 *
 * - keys order as IndexedDB orders them (numbers before strings), ranges use
 *   `IDBKeyRange`'s names, `getAll` and `getAllFromIndex` come back in key order;
 * - the declaration is the boundary: an undeclared store, index or key path is
 *   refused by name, and a plugin with no `database` is refused on every call;
 * - isolation is by plugin id as well as by alias, so an alias re-pointed to
 *   another plugin opens an empty database and never hands old rows over;
 * - the version rule from `DbSpec`: `upgrade` runs once with the stored version
 *   (0 when fresh), inside the transaction that records the new one, and a
 *   throw undoes both and runs again next time; a stored version above the
 *   declared one is never lowered;
 * - a `transaction` callback is atomic, a readonly one cannot write, and a
 *   read-only opening (a diagnosis) neither writes nor upgrades;
 * - no plugin in the tree lists a credential-class key name: `listed` names
 *   what a diagnosis may show exists, and a name is the only thing it shows.
 */
import { PluginDbTables } from "../src/store/plugin-db.ts";
import { sqliteHost } from "../src/store/sqlite-host.ts";
import { openPluginDatabase } from "../src/runtime/plugin-db.ts";
import { KeyRange, type DbSpec, type Plugin } from "../src/plugins/types.ts";
import { sandboxPlugin } from "../src/plugins/sandbox.ts";
import { githubPlugin } from "../src/plugins/github.ts";
import { raftPlugin } from "../src/plugins/raft.ts";
import { demoPlugin } from "../src/plugins/demo.ts";
import { appworldPlugins } from "../src/plugins/appworld.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }
async function refused(fn: () => Promise<unknown>, pattern: RegExp, what: string) {
  try { await fn(); } catch (e) {
    const m = String((e as Error)?.message ?? e);
    must(pattern.test(m), `${what}: refused for another reason: ${m}`);
    return;
  }
  throw new Error(`${what}: was not refused`);
}

const SPEC: DbSpec = {
  version: 1,
  stores: {
    items: { keyPath: "id", indexes: { byOwner: "owner" }, listed: ["a"] },
    notes: {},
  },
};
const scope = (over: Partial<{ alias: string; plugin: string }> = {}) =>
  ({ tenantId: "t", agentId: "a", alias: "m", plugin: "p", ...over });
/** `null` for a plugin that declares no database; the default parameter would swallow `undefined`. */
function fresh(spec: DbSpec | null = SPEC, over: Partial<{ alias: string; plugin: string }> = {}) {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  return { tables, db: openPluginDatabase(tables, scope(over), spec ?? undefined) };
}

await check("keys order as IndexedDB orders them: every number before every string, and getAll follows that order", async () => {
  const { db } = fresh();
  for (const k of ["b", 10, "a", 2, "10", -1]) await db.put("notes", { k }, k);
  const all = (await db.getAll("notes")).map((v: any) => v.k);
  must(JSON.stringify(all) === JSON.stringify([-1, 2, 10, "10", "a", "b"]), `order: ${JSON.stringify(all)}`);
  must((await db.get("notes", 2) as any).k === 2 && (await db.get("notes", "2")) === undefined,
    "a number key and its string spelling are different keys");
  must((await db.get("notes", "missing")) === undefined, "a missing key reads as undefined, as in IndexedDB");
});

await check("ranges use IDBKeyRange's names, open bounds excluded, and count/delete take the same query", async () => {
  const { db } = fresh();
  for (const k of [1, 2, 3, 4, 5]) await db.put("notes", k * 10, k);
  const keys = async (q: any, count?: number) => (await db.getAll("notes", q, count)) as number[];
  must(JSON.stringify(await keys(KeyRange.bound(2, 4))) === "[20,30,40]", "bound, closed");
  must(JSON.stringify(await keys(KeyRange.bound(2, 4, true, true))) === "[30]", "bound, open both ends");
  must(JSON.stringify(await keys(KeyRange.lowerBound(4))) === "[40,50]", "lowerBound");
  must(JSON.stringify(await keys(KeyRange.upperBound(2, true))) === "[10]", "upperBound, open");
  must(JSON.stringify(await keys(KeyRange.only(3))) === "[30]", "only");
  must(JSON.stringify(await keys(3)) === "[30]", "a bare key is a query for that key");
  must(JSON.stringify(await keys(null, 2)) === "[10,20]", "count limits in key order");
  must((await db.count("notes", KeyRange.lowerBound(3))) === 3, "count over a range");
  await db.delete("notes", KeyRange.bound(1, 2));
  must((await db.count("notes")) === 3 && (await db.get("notes", 1)) === undefined, "delete over a range");
  await db.delete("notes", 5);
  must((await db.count("notes")) === 2, "delete of one key");
});

await check("a keyPath store takes its key from the value and refuses an explicit one; a keyless store needs one", async () => {
  const { db } = fresh();
  must((await db.put("items", { id: "x", owner: "o" })) === "x", "put returns the key it used");
  await refused(() => db.put("items", { id: "y" }, "y"), /takes its key from id/, "explicit key with a keyPath");
  await refused(() => db.put("items", { owner: "o" }), /no key at id/, "value without its key path");
  await refused(() => db.put("items", { id: true }), /no key at id/, "a boolean at the key path");
  await refused(() => db.put("notes", "v"), /needs a key/, "keyless store without a key");
  await refused(() => db.put("notes", "v", NaN as any), /needs a key/, "NaN is not a key");
  await refused(() => db.get("notes", {} as any), /string or a finite number/, "an object is not a key");
  await refused(() => db.put("notes", undefined as any, "k"), /must be JSON/, "undefined is not a value");
});

await check("an index orders by the indexed field then by key, skips values without the field, and must be declared", async () => {
  const { db } = fresh();
  await db.put("items", { id: "c", owner: "bob" });
  await db.put("items", { id: "a", owner: "bob" });
  await db.put("items", { id: "b", owner: "alice" });
  await db.put("items", { id: "d" });
  await db.put("items", { id: "e", owner: 7 });
  const ids = (await db.getAllFromIndex("items", "byOwner")).map((v: any) => v.id);
  must(JSON.stringify(ids) === JSON.stringify(["e", "b", "a", "c"]), `index order: ${JSON.stringify(ids)}`);
  const bobs = (await db.getAllFromIndex("items", "byOwner", "bob")).map((v: any) => v.id);
  must(JSON.stringify(bobs) === JSON.stringify(["a", "c"]), `by one index value: ${JSON.stringify(bobs)}`);
  const some = (await db.getAllFromIndex("items", "byOwner", KeyRange.lowerBound("b"), 1)).map((v: any) => v.id);
  must(JSON.stringify(some) === JSON.stringify(["a"]), `range and count over an index: ${JSON.stringify(some)}`);
  await db.put("items", { id: "a", owner: "zed" });
  must((await db.getAllFromIndex("items", "byOwner", "bob") as any[]).length === 1, "a re-put moves the row in the index");
  await refused(() => db.getAllFromIndex("items", "byName"), /no index named byName on store items/, "an undeclared index");
  must((() => { try { openPluginDatabase(new PluginDbTables(sqliteHost()).ensure(), scope(), { version: 1, stores: { s: { indexes: { a: "a", b: "b" } } } }); return false; } catch (e) { return /allows one/.test(String((e as Error).message)); } })(),
    "two indexes on one store are refused at open");
});

await check("the declaration is the boundary: an undeclared store is refused by name, and no declaration refuses everything", async () => {
  const { db } = fresh();
  await refused(() => db.get("other", "k"), /plugin p declares no store named other/, "undeclared store");
  await refused(() => db.transaction(["notes", "other"], "readonly", () => 0), /no store named other/, "undeclared store in a transaction");
  const { db: none } = fresh(null);
  await refused(() => none.get("notes", "k"), /plugin p declares no database/, "no database declared");
  must((() => { try { fresh({ version: 0, stores: {} }); return false; } catch (e) { return /positive integer/.test(String((e as Error).message)); } })(),
    "version 0 is refused at open");
});

await check("a database is filed by plugin as well as by alias: another plugin under the same alias sees nothing, and vice versa", async () => {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const a = openPluginDatabase(tables, scope(), SPEC);
  await a.put("notes", "mine", "k");
  const otherPlugin = openPluginDatabase(tables, scope({ plugin: "q" }), SPEC);
  must((await otherPlugin.get("notes", "k")) === undefined && (await otherPlugin.count("notes")) === 0,
    "an alias re-pointed to another plugin handed the old rows over");
  await otherPlugin.put("notes", "theirs", "k");
  must((await a.get("notes", "k")) === "mine", "the other plugin's write reached the first plugin's database");
  const otherAlias = openPluginDatabase(tables, scope({ alias: "n" }), SPEC);
  must((await otherAlias.get("notes", "k")) === undefined, "a second mount of the same plugin shares a database");
  must(tables.version(scope()) === 1 && tables.version(scope({ plugin: "q" })) === 1 && tables.version(scope({ alias: "n" })) === 1,
    "each database records its own version");
});

await check("upgrade runs once with the stored version, 0 when fresh, in the transaction that records the new version", async () => {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  const seen: number[] = [];
  const v1: DbSpec = { version: 1, stores: { notes: {} }, upgrade(db, old) { seen.push(old); db.put("notes", "seeded", "seed"); } };
  const first = openPluginDatabase(tables, scope(), v1);
  must(tables.version(scope()) === null, "opening alone wrote a version; the rule runs on first use");
  must((await first.get("notes", "seed")) === "seeded", "a fresh database was not seeded by upgrade(0)");
  await first.get("notes", "seed");
  must(JSON.stringify(seen) === "[0]" && tables.version(scope()) === 1, `upgrade ran ${JSON.stringify(seen)}; version ${tables.version(scope())}`);
  const again = openPluginDatabase(tables, scope(), v1);
  await again.get("notes", "seed");
  must(JSON.stringify(seen) === "[0]", "a second opening at the same version ran upgrade again");
  const v3: DbSpec = { version: 3, stores: { notes: {} }, upgrade(db, old) { seen.push(old); db.put("notes", `from ${old}`, "migrated"); } };
  const later = openPluginDatabase(tables, scope(), v3);
  must((await later.get("notes", "migrated")) === "from 1", "upgrade did not see the version the data was written under");
  must(JSON.stringify(seen) === "[0,1]" && tables.version(scope()) === 3, `after 1→3: ${JSON.stringify(seen)}, version ${tables.version(scope())}`);
});

await check("an upgrade that throws advances nothing, refuses this use with the reason, and runs again on the next", async () => {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  await openPluginDatabase(tables, scope(), { version: 1, stores: { notes: {} } }).put("notes", "old", "k");
  let attempts = 0;
  const v2: DbSpec = {
    version: 2, stores: { notes: {} },
    upgrade(db) { attempts++; db.put("notes", "half", "k"); if (attempts === 1) throw new Error("disk on fire"); },
  };
  const db = openPluginDatabase(tables, scope(), v2);
  await refused(() => db.get("notes", "k"), /plugin p database upgrade from 1 to 2 failed: disk on fire/, "the first use after a failed upgrade");
  must(tables.version(scope()) === 1, "the version advanced past a failed upgrade");
  must(tables.get(scope(), "notes", "k") === "old", "a half-migrated row survived the failed upgrade");
  must((await db.get("notes", "k")) === "half" && tables.version(scope()) === 2 && attempts === 2,
    `the next use did not run upgrade again: attempts ${attempts}, version ${tables.version(scope())}`);
});

await check("a stored version above the declared one opens as is: no upgrade, never lowered, reads still answer", async () => {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  await openPluginDatabase(tables, scope(), { version: 5, stores: { notes: {} } }).put("notes", { newer: true }, "k");
  let ran = false;
  const older = openPluginDatabase(tables, scope(), { version: 2, stores: { notes: {} }, upgrade() { ran = true; } });
  must(JSON.stringify(await older.get("notes", "k")) === JSON.stringify({ newer: true }), "old code could not read new data");
  await older.put("notes", "written by old code", "j");
  must(!ran && tables.version(scope()) === 5, `after a rollback: upgrade ran ${ran}, version ${tables.version(scope())}`);
});

await check("a transaction is atomic — a throw undoes its writes — and a readonly one cannot write", async () => {
  const { db, tables } = fresh();
  await db.put("notes", 1, "n");
  const bumped = await db.transaction("notes", "readwrite", (tx) => {
    const n = tx.get("notes", "n") as number;
    tx.put("notes", n + 1, "n");
    return tx.get("notes", "n");
  });
  must(bumped === 2 && (await db.get("notes", "n")) === 2, "a read-decide-write did not land");
  await refused(() => db.transaction(["notes", "items"], "readwrite", (tx) => {
    tx.put("notes", 99, "n");
    tx.put("items", { id: "z" });
    throw new Error("changed my mind");
  }), /changed my mind/, "a throwing callback");
  must((await db.get("notes", "n")) === 2 && (await db.get("items", "z")) === undefined, "writes before the throw survived");
  await refused(() => db.transaction("notes", "readonly", (tx) => tx.put("notes", 0, "n")), /put in a readonly transaction/, "a write in a readonly transaction");
  must(tables.get(scope(), "notes", "n") === 2, "the readonly transaction wrote");
});

await check("a read-only opening reads, refuses every write in the diagnosis's words, and never upgrades", async () => {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  tables.put(scope(), "notes", "k", "present", null);
  const ro = openPluginDatabase(tables, scope(), { version: 4, stores: { notes: {} }, upgrade() { throw new Error("must not run"); } }, { readOnly: true });
  must((await ro.get("notes", "k")) === "present" && (await ro.count("notes")) === 1, "a read-only opening could not read");
  for (const [what, fn] of [
    ["put", () => ro.put("notes", 1, "k")],
    ["delete", () => ro.delete("notes", "k")],
    ["readwrite transaction", () => ro.transaction("notes", "readwrite", () => 0)],
  ] as const) await refused(fn, /read-only: a diagnosis does not change a mount's state/, what);
  must(tables.version(scope()) === null, "a read-only opening recorded a version");
  must(await ro.transaction("notes", "readonly", (tx) => tx.count("notes")) === 1, "a readonly transaction on a read-only opening");
});

await check("renaming a mount moves its databases, plugin ids and versions included, and touches no other mount", async () => {
  const tables = new PluginDbTables(sqliteHost()).ensure();
  await openPluginDatabase(tables, scope(), SPEC).put("notes", "moved", "k");
  await openPluginDatabase(tables, scope({ plugin: "q" }), SPEC).put("notes", "also moved", "k");
  await openPluginDatabase(tables, scope({ alias: "other" }), SPEC).put("notes", "stays", "k");
  tables.rename("t", "a", "m", "renamed");
  must(tables.get(scope(), "notes", "k") === undefined && tables.version(scope()) === null, "rows stayed under the old alias");
  must(tables.get(scope({ alias: "renamed" }), "notes", "k") === "moved", "the rows did not arrive under the new alias");
  must(tables.get(scope({ alias: "renamed", plugin: "q" }), "notes", "k") === "also moved", "the second plugin's database did not travel");
  must(tables.version(scope({ alias: "renamed" })) === 1, "the version did not travel");
  must(tables.get(scope({ alias: "other" }), "notes", "k") === "stays", "another mount's rows were touched");
  const summary = tables.summary("t", "a");
  must(summary.length === 3 && summary.every((s) => s.keys === 1) && !JSON.stringify(summary).includes("moved"),
    `the summary names counts, never values: ${JSON.stringify(summary)}`);
});

/**
 * `listed` names keys a diagnosis may say exist. A key named like a credential
 * would put "this mount holds a token" on an operator's page, which is one
 * fact about a secret more than any page needs; the value itself is never at
 * stake here, because a listing carries names only. The classes are the same
 * words `cf/src/secret-shape.ts` refuses in chat.
 */
const CREDENTIAL_CLASS = /token|secret|password|passwd|apikey|api_key|credential|private/i;
await check("no plugin in the tree lists a credential-class key name, and every plugin that keeps state declares a database", async () => {
  const plugins: Plugin[] = [
    sandboxPlugin(null as any, "local"), githubPlugin, raftPlugin, demoPlugin,
    ...appworldPlugins([{ app: "spotify", apis: [] }] as any, { apiBaseUrl: "http://127.0.0.1:1" }),
  ];
  const declared = plugins.filter((p) => p.database);
  must(declared.length === plugins.length, `plugins that moved to ctx.db without a declaration: ${plugins.filter((p) => !p.database).map((p) => p.id).join(", ")}`);
  for (const p of declared) {
    for (const [store, s] of Object.entries(p.database!.stores)) {
      for (const key of s.listed ?? []) {
        must(!CREDENTIAL_CLASS.test(String(key)), `${p.id}.${store} lists a credential-class key name: ${String(key)}`);
      }
    }
  }
  // The guard reads: a listing that names a token is caught by name.
  must(CREDENTIAL_CLASS.test("accessToken"), "the credential-class pattern does not match a token name");
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
