/**
 * pi-durable's storage conformance through our SQLite facade, and the four
 * things about that facade the upstream suite cannot see. Run over node:sqlite
 * by test/pi-durable.ts and inside workerd, on a real Durable Object's storage,
 * by cf/src/conformance.ts (test/pi-durable-do.sh).
 *
 * Upstream's 23 cases do check that a failed commit leaves nothing behind, but
 * through pi-durable's own memory of what it wrote, on a host it assumes has
 * real transactions. Ours has a savepoint over a shared connection instead
 * (src/store/pi-durable-sqlite.ts), so the cases below check the host side:
 * rows written across an await and then thrown away are gone, a write issued
 * meanwhile is not thrown away with them, our own tables are where they were,
 * and values the object cannot represent the way pi-durable hands them over
 * arrive as the same value.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type StorageWrite } from "@earendil-works/pi-durable";
import {
  SqliteStorage, SQLITE_MIGRATIONS, applySqliteMigrations, type SqliteDatabase, type SqliteExecutor,
} from "@earendil-works/pi-durable/storage/sqlite";
import { createStorageConformance, type StorageConformanceAssertions } from "@earendil-works/pi-durable/testing";
import {
  PiDurableSqlite, PI_DURABLE_INDEXES, PI_DURABLE_OBJECTS, PI_DURABLE_TABLES, type DurableSqlHost,
} from "../../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace, qualifySql, type SqlNamespace } from "../../src/store/sql-namespace.ts";
import { DurableObjectStore } from "../../src/store/durable-object.ts";

/** A Durable Object's storage, or node's stand-in for it: AgentDO's own schema needs `transactionSync` too. */
export type PiDurableHost = DurableSqlHost & { transactionSync<T>(cb: () => T): T };
/** Hands each case a host with no tables of ours or pi-durable's, and cleans up after it. */
export type WithHost = (use: (host: PiDurableHost) => Promise<void>) => Promise<void>;
export type PiDurableCase = { group: string; name: string; run(): Promise<void> };

const context = BACKGROUND_CONTEXT;
const PD = prefixedNamespace("pd");
type StoredTask = Extract<StorageWrite, { type: "task" }>["value"];

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => {
  try { return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x instanceof Uint8Array ? `bytes[${[...x]}]` : x)); }
  catch { return String(v); }
};

/**
 * Vitest's `toEqual` and `toMatchObject`, which the upstream cases are written against: an own
 * property holding `undefined` counts as absent. node:assert's deep equality does not, and would
 * fail cases the implementation passes.
 */
function equal(a: unknown, b: unknown, partial: boolean): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i], partial));
  const ra = a as Record<string, unknown>, rb = b as Record<string, unknown>;
  const keysB = Object.keys(rb).filter((k) => rb[k] !== undefined);
  if (!partial && Object.keys(ra).filter((k) => ra[k] !== undefined).length !== keysB.length) return false;
  return keysB.every((k) => Object.hasOwn(ra, k) && equal(ra[k], rb[k], partial));
}

export const vitestLikeAssertions: StorageConformanceAssertions = {
  ok(value, message) { check(value, message ?? `expected truthy, got ${show(value)}`); },
  strictEqual(actual, expected) { check(Object.is(actual, expected), `expected ${show(expected)}, got ${show(actual)}`); },
  deepEqual(actual, expected) { check(equal(actual, expected, false), `expected ${show(expected)}, got ${show(actual)}`); },
  partialDeepEqual(actual, expected) { check(equal(actual, expected, true), `expected to contain ${show(expected)}, got ${show(actual)}`); },
  greaterThan(actual, expected) { check(actual > expected, `expected ${actual} > ${expected}`); },
  async rejects(operation, messageIncludes) {
    let error: unknown;
    try { await operation; } catch (e) { error = e; }
    check(error !== undefined, `expected a rejection including ${show(messageIncludes)}, but it resolved`);
    const message = String((error as Error)?.message ?? error);
    check(message.includes(messageIncludes), `rejection ${show(message)} does not include ${show(messageIncludes)}`);
  },
};

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };
const master = (host: PiDurableHost) =>
  host.sql.exec("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").toArray() as unknown as MasterRow[];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const recordIds = async (db: PiDurableSqlite) =>
  (await db.all<{ id: number }>("SELECT id FROM record_ids ORDER BY id")).map((r) => r.id);

export function piDurableCases(withHost: WithHost): PiDurableCase[] {
  const cases: PiDurableCase[] = [];

  for (const c of createStorageConformance({
    assertions: vitestLikeAssertions,
    withStorage: (use) => withHost(async (host) => {
      const storage = await SqliteStorage.open(new PiDurableSqlite(host, PD));
      try { await use(storage); } finally { await storage.close(context); }
    }),
  })) cases.push({ group: "pi-durable conformance", name: c.name, run: () => c.run() });

  const add = (name: string, run: () => Promise<void>) => cases.push({ group: "namespace facade", name, run });

  add("the list of names to namespace is exactly what pi-durable's migrations create", async () => {
    const created = new Set<string>();
    const statements = [
      // applySqliteMigrations creates this one itself, outside SQLITE_MIGRATIONS.
      "CREATE TABLE IF NOT EXISTS durable_schema (singleton INTEGER)",
      ...SQLITE_MIGRATIONS.flatMap((m) => m.statements),
    ];
    for (const s of statements) {
      const m = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i.exec(s);
      if (m) created.add(m[1]);
      else check(!/\bCREATE\b/i.test(s), `a CREATE this check cannot parse: ${s.slice(0, 80)}`);
    }
    const listed = [...PI_DURABLE_TABLES, ...PI_DURABLE_INDEXES].sort();
    check(PI_DURABLE_TABLES.length === 9 && PI_DURABLE_INDEXES.length === 16, "the lists changed size");
    check(show([...created].sort()) === show(listed), `migrations create ${show([...created].sort())}, the facade lists ${show(listed)}`);
  });

  add("opening creates only pd_ objects, and AgentDO's tables and rows are as they were", () => withHost(async (host) => {
    await new DurableObjectStore({ storage: host }).init();
    host.sql.exec(
      `INSERT INTO tasks (tenant_id, task_id, agent_id, status, generation, checkpoint_version, checkpoint, updated_at)
       VALUES ('t', 'ours', 'a', 'running', 1, 1, '{}', 1)`,
    );
    const before = master(host);
    const ourTasks = () => host.sql.exec("SELECT * FROM tasks ORDER BY task_id").toArray();
    const tasksBefore = ourTasks();

    const storage = await SqliteStorage.open(new PiDurableSqlite(host, PD));
    await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], context);
    const taskId: StoredTask["id"] = await storage.mintId();
    const task: StoredTask = {
      id: taskId, conversationId: ROOT_CONVERSATION_ID, kind: "test.task", version: 1, input: { value: 1 },
      state: { status: "pending", checkpoint: { phase: "ready" } }, background: false, abortRequested: false,
    };
    await storage.commit([{ type: "task", value: task }], context);
    vitestLikeAssertions.deepEqual(await storage.task(taskId, context), task);
    await storage.close(context);

    const after = master(host);
    const key = (r: MasterRow) => `${r.type} ${r.name}`;
    const beforeKeys = new Set(before.map(key));
    const fresh = after.filter((r) => !beforeKeys.has(key(r)));
    // SQLite names the index behind a composite primary key itself, after the table it serves.
    const automatic = fresh.filter((r) => r.name.startsWith("sqlite_autoindex_"));
    const ours = new Set(PI_DURABLE_TABLES.map((t) => PD.qualify(t, "table")));
    for (const r of automatic) check(ours.has(r.tbl_name), `${r.name} serves ${r.tbl_name}, which is not a namespaced table`);
    const added = fresh.filter((r) => !automatic.includes(r)).map(key).sort();
    const expected = [
      ...PI_DURABLE_TABLES.map((t) => `table ${PD.qualify(t, "table")}`),
      ...PI_DURABLE_INDEXES.map((i) => `index ${PD.qualify(i, "index")}`),
    ].sort();
    check(show(added) === show(expected), `opening added ${show(added)}; expected exactly ${show(expected)}`);
    for (const row of before) {
      const now = after.find((r) => key(r) === key(row));
      check(now !== undefined && equal(now, row, false), `${key(row)} changed: ${show(row)} -> ${show(now)}`);
    }
    vitestLikeAssertions.deepEqual(ourTasks(), tasksBefore);
    const theirs = host.sql.exec(`SELECT count(*) AS n FROM ${PD.qualify("tasks", "table")}`).toArray()[0];
    check(theirs?.n === 1, `pd_tasks holds ${show(theirs)}, expected the one task committed`);
  }));

  add("a statement that would create a name not on the list throws, and creates nothing", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    const before = master(host);
    // `agents` is one of ours; `tasks_tenant` is our index on our `tasks`.
    await vitestLikeAssertions.rejects(db.exec("CREATE TABLE agents (x INTEGER)"), `would create "agents"`);
    await vitestLikeAssertions.rejects(db.exec("CREATE INDEX IF NOT EXISTS tasks_tenant ON tasks (kind)"), `would create "tasks_tenant"`);
    await vitestLikeAssertions.rejects(db.exec("CREATE TABLE main.tasks (x INTEGER)"), `would create "main"`);
    await vitestLikeAssertions.rejects(db.exec("ALTER TABLE tasks RENAME TO agents"), `would create "agents"`);
    await vitestLikeAssertions.rejects(db.get("SELECT 1 AS tasks"), "alias");
    vitestLikeAssertions.deepEqual(master(host), before);
    // Data is never rewritten: a string literal that spells a table name comes back as written.
    vitestLikeAssertions.deepEqual(await db.get("SELECT 'tasks' AS v, ? AS w", "entries"), { v: "tasks", w: "entries" });
  }));

  add("a schema-style namespace gets every statement pi-durable runs qualified as pd.<name>", async () => {
    // A store with real schemas: tables addressed `pd.tasks`; indexes left bare, as Postgres wants
    // them in CREATE INDEX. Nothing runs against it — Durable Object SQLite has no schemas — so the
    // statements are the ones pi-durable issued through the prefixed facade during its own suite.
    const schema: SqlNamespace = { name: "pd", qualify: (o, kind) => (kind === "table" ? `pd.${o}` : o) };
    const seen = new Set<string>();
    const recording = (inner: SqliteExecutor): SqliteExecutor => ({
      exec: (sql) => { seen.add(sql); return inner.exec(sql); },
      run: (sql, ...p) => { seen.add(sql); return inner.run(sql, ...p); },
      get: <T extends object>(sql: string, ...p: Parameters<SqliteExecutor["get"]>[1][]) => { seen.add(sql); return inner.get<T>(sql, ...p); },
      all: <T extends object>(sql: string, ...p: Parameters<SqliteExecutor["all"]>[1][]) => { seen.add(sql); return inner.all<T>(sql, ...p); },
    });
    for (const c of createStorageConformance({
      assertions: vitestLikeAssertions,
      withStorage: (use) => withHost(async (host) => {
        const db = new PiDurableSqlite(host, PD);
        const recorder: SqliteDatabase = {
          ...recording(db),
          transaction: (cb) => db.transaction((tx) => cb(recording(tx))),
          close: () => db.close(),
        };
        const storage = await SqliteStorage.open(recorder);
        try { await use(storage); } finally { await storage.close(context); }
      }),
    })) await c.run();
    check(seen.size >= 40, `only ${seen.size} distinct statements were recorded`);

    // Every statement pi-durable issued in its whole suite rewrites under the fail-closed position
    // rule, in both namespaces: a listed name it uses outside a table or index position would throw here.
    for (const sql of seen) {
      const out = qualifySql(sql, PI_DURABLE_OBJECTS, schema);
      const code = out.replace(/'(?:[^']|'')*'/g, "''");
      for (const name of PI_DURABLE_TABLES) {
        const bare = new RegExp(`(?<![\\w.])${name}\\b`).exec(code);
        check(bare === null, `"${name}" is left unqualified in: ${out.slice(0, 160)}`);
      }
      // The two namespaces must have rewritten the same positions, so the prefixed text is the
      // schema text with each `pd.<table>` written `pd_<table>`, and nothing else differs.
      const prefixed = qualifySql(sql, PI_DURABLE_OBJECTS, PD);
      const fromSchema = qualifySql(sql, PI_DURABLE_OBJECTS, { name: "pd", qualify: (o) => `pd.${o}` })
        .replace(/\bpd\.(\w+)/g, (_m, o: string) => `pd_${o}`);
      check(prefixed === fromSchema, `the two namespaces rewrote different positions in: ${sql.slice(0, 160)}`);
    }
    const migration = SQLITE_MIGRATIONS[0]!.statements;
    const one = (s: string | undefined) => qualifySql(s ?? "", PI_DURABLE_OBJECTS, schema).replace(/\s+/g, " ").trim();
    vitestLikeAssertions.strictEqual(one(migration.find((s) => /CREATE TABLE tasks\b/.test(s))).slice(0, 26), "CREATE TABLE pd.tasks ( id");
    vitestLikeAssertions.strictEqual(one("CREATE INDEX tasks_by_status ON tasks (status, id)"), "CREATE INDEX tasks_by_status ON pd.tasks (status, id)");
    vitestLikeAssertions.strictEqual(
      one("INSERT INTO tasks (id, kind) VALUES (?, 'tasks') ON CONFLICT(id) DO UPDATE SET kind = excluded.kind"),
      "INSERT INTO pd.tasks (id, kind) VALUES (?, 'tasks') ON CONFLICT(id) DO UPDATE SET kind = excluded.kind",
    );
    await vitestLikeAssertions.rejects(Promise.resolve().then(() => qualifySql("CREATE TABLE events (x)", PI_DURABLE_OBJECTS, schema)), `would create "events"`);
  });

  add("a listed name is rewritten only where the grammar admits only a table or index name, and throws elsewhere", async () => {
    const q = (sql: string) => qualifySql(sql, PI_DURABLE_OBJECTS, PD);
    const throws = (sql: string, why: string) => vitestLikeAssertions.rejects(Promise.resolve().then(() => q(sql)), why);
    const notTable = "not a table or index name";
    // A column that shares a listed table's name would otherwise be renamed with it.
    await throws("SELECT tasks FROM entries", notTable);
    await throws("SELECT x, tasks FROM entries", notTable);
    await throws("UPDATE entries SET tasks = 1", notTable);
    await throws("INSERT INTO entries (tasks) VALUES (1)", notTable);
    await throws("SELECT count(tasks) FROM entries", notTable);
    await throws("SELECT id FROM entries WHERE tasks = 1 ORDER BY tasks", notTable);
    await throws("CREATE TABLE entries (tasks INTEGER)", notTable);
    await throws("SELECT 1 FROM entries JOIN documents ON tasks = 1", notTable);
    await throws("WITH tasks AS (SELECT 1) SELECT * FROM entries", notTable);
    await throws("SELECT * FROM entries tasks", notTable);
    await throws("SELECT a IS DISTINCT FROM tasks FROM entries", notTable);
    // Qualified either way round, quoted, an alias, a table-valued function, or the wrong kind.
    await throws("SELECT tasks.record FROM tasks", `before "."`);
    await throws("SELECT * FROM tasks.x", `before "."`);
    await throws("SELECT main.tasks.id FROM tasks", `after "."`);
    await throws('SELECT "tasks" FROM entries', "quoted");
    await throws("SELECT id AS tasks FROM entries", "alias");
    await throws("SELECT * FROM tasks(1)", "table-valued function");
    await throws("SELECT * FROM tasks_by_status", "where the grammar wants a table");
    await throws("SELECT * FROM tasks INDEXED BY entries", "where the grammar wants a index");

    // An unlisted name where a table or index belongs is outside the namespace, whether it is one of
    // ours, an index of ours, a table nobody has, or SQLite's own catalogue.
    const outside = "is not on the namespace's list";
    await throws("SELECT * FROM agents", outside);
    await throws("INSERT INTO tasks_tenant (x) VALUES (1)", outside);
    await throws("DROP TABLE outbox", outside);
    await throws("DROP INDEX IF EXISTS tasks_tenant", outside);
    await throws("UPDATE agents SET x = 1", outside);
    await throws("DELETE FROM agents", outside);
    await throws("SELECT 1 FROM tasks JOIN agents ON 1", outside);
    await throws("SELECT 1 FROM tasks, agents", outside);
    await throws("SELECT name FROM sqlite_master", outside);
    await throws("SELECT * FROM main.tasks", outside);
    await throws('SELECT * FROM "agents"', outside);
    await throws("SELECT * FROM json_each(?)", outside);
    await throws("CREATE TABLE entries (x INTEGER REFERENCES agents(id))", outside);
    await throws("SELECT 1 FROM tasks INDEXED BY tasks_tenant", outside);
    await throws("ANALYZE agents", outside);

    const rewrites: [string, string][] = [
      ["SELECT id FROM tasks WHERE id = ?", "SELECT id FROM pd_tasks WHERE id = ?"],
      ["SELECT 1 FROM tasks, entries , documents", "SELECT 1 FROM pd_tasks, pd_entries , pd_documents"],
      ["SELECT 1 FROM tasks LEFT JOIN entries ON entries_id = id", "SELECT 1 FROM pd_tasks LEFT JOIN pd_entries ON entries_id = id"],
      ["INSERT OR IGNORE INTO tasks (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind",
        "INSERT OR IGNORE INTO pd_tasks (id) VALUES (1) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind"],
      ["UPDATE tasks SET kind = 'tasks'", "UPDATE pd_tasks SET kind = 'tasks'"],
      ["UPDATE OR ROLLBACK tasks SET kind = 1", "UPDATE OR ROLLBACK pd_tasks SET kind = 1"],
      ["DELETE FROM tasks WHERE id = ?", "DELETE FROM pd_tasks WHERE id = ?"],
      ["CREATE TABLE IF NOT EXISTS tasks (id INTEGER)", "CREATE TABLE IF NOT EXISTS pd_tasks (id INTEGER)"],
      ["CREATE UNIQUE INDEX IF NOT EXISTS tasks_by_status ON tasks (status)", "CREATE UNIQUE INDEX IF NOT EXISTS pd_tasks_by_status ON pd_tasks (status)"],
      ["DROP TABLE IF EXISTS tasks", "DROP TABLE IF EXISTS pd_tasks"],
      ["DROP INDEX tasks_by_status", "DROP INDEX pd_tasks_by_status"],
      ["ALTER TABLE tasks RENAME TO entries", "ALTER TABLE pd_tasks RENAME TO pd_entries"],
      ["CREATE TABLE entries (task INTEGER REFERENCES tasks(id))", "CREATE TABLE pd_entries (task INTEGER REFERENCES pd_tasks(id))"],
      ["SELECT 1 FROM tasks INDEXED BY tasks_by_status", "SELECT 1 FROM pd_tasks INDEXED BY pd_tasks_by_status"],
      ["REINDEX tasks_by_status", "REINDEX pd_tasks_by_status"],
      ["ANALYZE tasks", "ANALYZE pd_tasks"],
    ];
    for (const [sql, want] of rewrites) vitestLikeAssertions.strictEqual(q(sql), want);
  });

  add("a transaction that throws after an await leaves no rows, and a write queued meanwhile survives", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    await applySqliteMigrations(db);
    const boom = new Error("boom");
    const order: string[] = [];
    let wrote!: () => void;
    const firstRowWritten = new Promise<void>((r) => { wrote = r; });
    const txn = db.transaction(async (tx) => {
      await tx.run("INSERT INTO record_ids (id, record_type) VALUES (?, 'task')", 100);
      wrote();
      await sleep(20);
      await tx.run("INSERT INTO record_ids (id, record_type) VALUES (?, 'task')", 101);
      order.push("transaction throws");
      throw boom;
    }).then(() => { order.push("transaction resolved"); }, (e: unknown) => { order.push(e === boom ? "transaction rejected with its error" : `rejected with ${String(e)}`); });
    await firstRowWritten;
    const outside = db.run("INSERT INTO record_ids (id, record_type) VALUES (?, 'entry')", 200).then(() => { order.push("outside write done"); });
    await Promise.all([txn, outside]);
    vitestLikeAssertions.deepEqual(await recordIds(db), [200]);
    vitestLikeAssertions.deepEqual(order, ["transaction throws", "transaction rejected with its error", "outside write done"]);
  }));

  add("a transaction that commits keeps writes made across awaits, and its handle dies with it", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    await applySqliteMigrations(db);
    const handle = await db.transaction(async (tx) => {
      await tx.run("INSERT INTO record_ids (id, record_type) VALUES (?, 'task')", 300);
      await sleep(5);
      await tx.run("INSERT INTO record_ids (id, record_type) VALUES (?, 'task')", 301);
      return tx;
    });
    vitestLikeAssertions.deepEqual(await recordIds(db), [300, 301]);
    await vitestLikeAssertions.rejects(handle.get("SELECT 1 AS one"), "no longer active");
  }));

  add("bigint binds as the same integer, an unsafe one is refused, and a blob comes back as bytes", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    await applySqliteMigrations(db);
    for (const id of [42n, BigInt(Number.MAX_SAFE_INTEGER)]) {
      await db.run("INSERT INTO record_ids (id, record_type) VALUES (?, 'task')", id);
      const row = await db.get<{ id: unknown; t: unknown }>("SELECT id, typeof(id) AS t FROM record_ids WHERE id = ?", id);
      vitestLikeAssertions.deepEqual(row, { id: Number(id), t: "integer" });
    }
    await vitestLikeAssertions.rejects(db.get("SELECT ? AS n", BigInt(Number.MAX_SAFE_INTEGER) + 1n), "cannot bind");
    const bytes = new Uint8Array([0, 1, 2, 254, 255]);
    const blob = await db.get<{ b: unknown; t: unknown }>("SELECT ? AS b, typeof(?) AS t", bytes, bytes);
    check(blob?.b instanceof Uint8Array, `a blob came back as ${Object.prototype.toString.call(blob?.b)}, not a Uint8Array`);
    vitestLikeAssertions.deepEqual(blob, { b: bytes, t: "blob" });
  }));

  return cases;
}

/** Runs the cases in order and reports each, for both runners to print the same way. */
export async function runPiDurableCases(cases: PiDurableCase[]) {
  const results: Array<{ group: string; name: string; ok: boolean; error?: string }> = [];
  for (const c of cases) {
    try { await c.run(); results.push({ group: c.group, name: c.name, ok: true }); }
    catch (e) { results.push({ group: c.group, name: c.name, ok: false, error: String((e as Error)?.message ?? e) }); }
  }
  return results;
}
