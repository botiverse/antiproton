/**
 * The `ap` namespace (src/store/ap-store.ts) and `PiDurableSqlite.exclusive`.
 * Run over node:sqlite by test/ap-store.ts and inside workerd, on a real Durable
 * Object's storage, by cf/src/conformance.ts (test/ap-store-do.sh) — the run that
 * reads `exclusive` against the savepoint semantics it exists for.
 */
import { applySqliteMigrations, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ApStore, AP_INDEXES, AP_OBJECTS, AP_TABLES } from "../../src/store/ap-store.ts";
import { PiDurableSqlite } from "../../src/store/pi-durable-sqlite.ts";
import { prefixedNamespace, qualifySql, type SqlNamespace } from "../../src/store/sql-namespace.ts";
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import { vitestLikeAssertions as is, type PiDurableCase, type WithHost } from "./pi-durable-spec.ts";

const AP = prefixedNamespace("ap");
const PD = prefixedNamespace("pd");

function check(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };
const master = (host: { sql: { exec(q: string): { toArray(): unknown[] } } }) =>
  host.sql.exec("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").toArray() as MasterRow[];
const key = (r: MasterRow) => `${r.type} ${r.name}`;

export function apStoreCases(withHost: WithHost): PiDurableCase[] {
  const cases: PiDurableCase[] = [];
  const add = (group: string, name: string, run: () => Promise<void>) => cases.push({ group, name, run });

  add("ap namespace", "ensure creates only ap_ objects, and AgentDO's and pi-durable's tables and rows are as they were", () => withHost(async (host) => {
    await new DurableObjectStore({ storage: host }).init();
    host.sql.exec(`INSERT INTO tasks (tenant_id, task_id, agent_id, status, generation, checkpoint_version, checkpoint, updated_at)
                   VALUES ('t', 'ours', 'a', 'running', 1, 1, '{}', 1)`);
    const storage = await SqliteStorage.open(new PiDurableSqlite(host, PD));
    await storage.commit([{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } }], BACKGROUND_CONTEXT);
    await storage.close(BACKGROUND_CONTEXT);
    const before = master(host);
    const rows = () => [
      host.sql.exec("SELECT * FROM tasks ORDER BY task_id").toArray(),
      host.sql.exec("SELECT * FROM pd_conversations ORDER BY id").toArray(),
    ];
    const rowsBefore = show(rows());

    const ap = new ApStore(host.sql, new PiDurableSqlite(host, PD), AP);
    await ap.ensure();
    await ap.ensure();
    const after = master(host);
    const beforeKeys = new Set(before.map(key));
    const fresh = after.filter((r) => !beforeKeys.has(key(r)));
    const automatic = fresh.filter((r) => r.name.startsWith("sqlite_autoindex_"));
    const tables = new Set(AP_TABLES.map((t) => AP.qualify(t, "table")));
    for (const r of automatic) check(tables.has(r.tbl_name), `${r.name} serves ${r.tbl_name}, which is not an ap table`);
    const added = fresh.filter((r) => !automatic.includes(r)).map(key).sort();
    const expected = [...AP_TABLES.map((t) => `table ap_${t}`), ...AP_INDEXES.map((i) => `index ap_${i}`)].sort();
    check(show(added) === show(expected), `ensure added ${show(added)}; expected exactly ${show(expected)}`);
    for (const r of fresh) check(r.name.startsWith("ap_") || r.name.startsWith("sqlite_autoindex_ap_"), `${key(r)} is outside ap_`);
    for (const row of before) {
      const now = after.find((r) => key(r) === key(row));
      check(now !== undefined && show(now) === show(row), `${key(row)} changed: ${show(row)} -> ${show(now)}`);
    }
    check(show(rows()) === rowsBefore, "AgentDO's or pi-durable's rows changed");
  }));

  add("ap namespace", "a schema-style namespace gets every statement the store runs qualified as ap.<name>", () => withHost(async (host) => {
    // A store with real schemas: tables `ap.meta`, indexes left bare as Postgres wants them in CREATE
    // INDEX. Durable Object SQLite has no schemas, so each statement is recorded as qualified for the
    // schema store, then run with `ap.` written `ap_` so the store's reads still have rows to read.
    const schema: SqlNamespace = { name: "ap", qualify: (o, kind) => (kind === "table" ? `ap.${o}` : o) };
    const seen: string[] = [];
    const recording = {
      exec(q: string, ...b: Array<string | number | null>) {
        seen.push(q);
        return host.sql.exec(q.replace(/\bap\.(\w+)/g, "ap_$1").replace(/INDEX IF NOT EXISTS (\w+)/, "INDEX IF NOT EXISTS ap_$1"), ...b);
      },
    };
    const ap = new ApStore(recording, new PiDurableSqlite(host, PD), schema);
    await ap.ensure();
    is.strictEqual(await ap.setEngineOnce("pd"), "pd");
    await ap.openConversation({ taskId: "t_a", tenantId: "t", agentId: "a", conversationId: 1, createdAt: 1 });
    is.strictEqual(ap.conversation("t_a")?.conversationId, 1);
    check(seen.length >= 10, `only ${seen.length} statements were recorded`);
    for (const q of seen) {
      const code = q.replace(/'(?:[^']|'')*'/g, "''");
      for (const name of AP_TABLES) {
        check(!new RegExp(`(?<![\\w.])${name}\\b`).test(code), `"${name}" is left unqualified in: ${q.slice(0, 160)}`);
      }
      check(/\bap\.\w+/.test(code), `no ap.<name> in: ${q.slice(0, 160)}`);
    }
    const one = (s: string) => qualifySql(s, AP_OBJECTS, schema);
    is.strictEqual(one("SELECT v FROM meta WHERE k = 'meta'"), "SELECT v FROM ap.meta WHERE k = 'meta'");
    is.strictEqual(one("CREATE INDEX IF NOT EXISTS model_jobs_open ON model_jobs (answered_at)"),
      "CREATE INDEX IF NOT EXISTS model_jobs_open ON ap.model_jobs (answered_at)");
  }));

  add("ap namespace", "a name not on the list throws and touches nothing: pd's, AgentDO's, the catalogue", () => withHost(async (host) => {
    await new DurableObjectStore({ storage: host }).init();
    await applySqliteMigrations(new PiDurableSqlite(host, PD));
    const ap = new ApStore(host.sql, new PiDurableSqlite(host, PD), AP);
    await ap.ensure();
    const before = master(host);
    const outside = "is not on the namespace's list";
    const throws = (sql: string, why: string) => is.rejects(ap.query(sql), why);
    await throws("SELECT * FROM tasks", outside);
    await throws("SELECT * FROM pd_tasks", outside);
    await throws("DELETE FROM ap_meta", outside);
    await throws("SELECT name FROM sqlite_master", outside);
    await throws("UPDATE events SET kind = 'x'", outside);
    await throws("INSERT INTO meta (k, v) SELECT task_id, status FROM tasks", outside);
    await throws("CREATE TABLE extra (x INTEGER)", `would create "extra"`);
    await throws("CREATE INDEX meta_v ON meta (v)", `would create "meta_v"`);
    await throws("SELECT meta FROM conversations", "not a table or index name");
    // A comma continues a FROM list after an alias, a subquery or a JOIN constraint, and statements
    // that address the database rather than a listed object are refused whatever they name.
    await throws("SELECT * FROM meta m, pd_tasks", outside);
    await throws("SELECT * FROM meta AS m, tasks", outside);
    await throws("SELECT * FROM meta, (SELECT 1), sqlite_master", outside);
    await throws("DELETE FROM meta WHERE EXISTS (SELECT 1 FROM meta m, tasks)", outside);
    await throws("SELECT * FROM meta JOIN conversations c ON c.task_id = 'x', pd_tasks", outside);
    await throws("SELECT * FROM (sqlite_master)", outside);
    await throws("PRAGMA table_info(pd_tasks)", "are admitted");
    await throws("PRAGMA table_info(meta)", "are admitted");
    await throws("VACUUM", "are admitted");
    await throws("ATTACH DATABASE ':memory:' AS other", "are admitted");
    await throws("DETACH other", "are admitted");
    await throws("SELECT 1 FROM meta; DROP TABLE tasks", outside);
    await throws("SELECT * FROM meta do, sqlite_master", outside);
    await throws("SELECT * FROM meta AS window, sqlite_master s", outside);
    await throws("UPDATE meta SET v = 1 FROM meta do, pd_tasks", outside);
    await throws("SELECT k, v FROM meta WHERE $a(') IS NULL UNION SELECT type, name FROM sqlite_master WHERE $b(') IS NULL", "only ? and ?NNN are admitted");
    await throws("SELECT v FROM meta WHERE k = :k", "only ? and ?NNN are admitted");
    check(show(master(host)) === show(before), "a refused statement changed the schema");
  }));

  add("ap store", "the engine is written once: the second write is ignored and the first stays in force", () => withHost(async (host) => {
    const ap = new ApStore(host.sql, new PiDurableSqlite(host, PD), AP);
    await ap.ensure();
    is.strictEqual(ap.engine(), null);
    is.strictEqual(await ap.setEngineOnce("pd"), "pd");
    is.strictEqual(await ap.setEngineOnce("pi085"), "pd");
    is.strictEqual(ap.engine(), "pd");
    is.deepEqual(host.sql.exec("SELECT k, v FROM ap_meta").toArray(), [{ k: "engine", v: "pd" }]);
    await is.rejects(ap.setEngineOnce("pi999" as never), "unknown engine");
    host.sql.exec("UPDATE ap_meta SET v = 'bogus' WHERE k = 'engine'");
    await is.rejects(Promise.resolve().then(() => ap.engine()), "unknown engine recorded");
  }));

  add("ap store", "the conversation directory keeps the first row for a task id and refuses a second id for one conversation", () => withHost(async (host) => {
    const ap = new ApStore(host.sql, new PiDurableSqlite(host, PD), AP);
    await ap.ensure();
    is.strictEqual(ap.conversation("t_a"), null);
    const first = { taskId: "t_a", tenantId: "t", agentId: "a", conversationId: ROOT_CONVERSATION_ID as number, createdAt: 10 };
    is.deepEqual(await ap.openConversation(first), first);
    is.deepEqual(await ap.openConversation({ ...first, conversationId: 7, createdAt: 20 }), first);
    await is.rejects(ap.openConversation({ ...first, taskId: "s_other" }), "already listed under another task id");
    is.strictEqual(ap.conversation("s_other"), null);
  }));

  add("ap store", "openConversation refuses a field that is not a non-empty string or a safe integer, and writes nothing", () => withHost(async (host) => {
    const ap = new ApStore(host.sql, new PiDurableSqlite(host, PD), AP);
    await ap.ensure();
    const good = { taskId: "t_a", tenantId: "t", agentId: "a", conversationId: 3, createdAt: 10 };
    // NaN binds as NULL, and OR IGNORE skips the NOT NULL violation: unchecked, each of these came
    // back as "already listed under another task id".
    const bad: Array<[Partial<Record<keyof typeof good, unknown>>, string]> = [
      [{ conversationId: NaN }, "conversationId must be a safe integer, not NaN"],
      [{ conversationId: null }, "conversationId must be a safe integer, not null"],
      [{ conversationId: 1.5 }, "conversationId must be a safe integer, not 1.5"],
      [{ conversationId: 2 ** 53 }, "conversationId must be a safe integer"],
      [{ createdAt: NaN }, "createdAt must be a safe integer, not NaN"],
      [{ createdAt: undefined }, "createdAt must be a safe integer, not undefined"],
      [{ taskId: "" }, `taskId must be a non-empty string, not ""`],
      [{ tenantId: null }, "tenantId must be a non-empty string, not null"],
      [{ agentId: 7 }, "agentId must be a non-empty string, not 7"],
    ];
    for (const [patch, why] of bad) await is.rejects(ap.openConversation({ ...good, ...patch } as never), why);
    is.deepEqual(host.sql.exec("SELECT * FROM ap_conversations").toArray(), []);
    is.deepEqual(await ap.openConversation(good), good);
  }));

  add("ap store", "a write issued while a pi-durable transaction is open waits for it, and survives its rollback", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    await applySqliteMigrations(db);
    const ap = new ApStore(host.sql, db, AP);
    await ap.ensure();
    const boom = new Error("boom");
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => { opened = r; });
    const order: string[] = [];
    const txn = db.transaction(async (tx) => {
      await tx.run("INSERT INTO record_ids (id, record_type) VALUES (?, 'task')", 100);
      opened();
      await sleep(20);
      order.push("transaction throws");
      throw boom;
    }).catch((e: unknown) => { order.push(e === boom ? "transaction rejected" : `rejected with ${String(e)}`); });
    await isOpen;
    const engine = ap.setEngineOnce("pd").then((v) => { order.push("engine written"); return v; });
    const listed = ap.openConversation({ taskId: "t_a", tenantId: "t", agentId: "a", conversationId: 1, createdAt: 1 });
    // Read while the transaction is open, asserted once everything has settled (see above).
    const whileOpen = { order: [...order], engine: ap.engine() };
    await Promise.allSettled([txn, engine, listed]);
    is.deepEqual(whileOpen, { order: [], engine: null });
    is.deepEqual(order, ["transaction throws", "transaction rejected", "engine written"]);
    is.strictEqual(await engine, "pd");
    is.strictEqual(ap.engine(), "pd");
    is.strictEqual(ap.conversation("t_a")?.conversationId, 1);
    is.deepEqual(await db.all("SELECT id FROM record_ids"), []);
  }));

  add("PiDurableSqlite.exclusive", "waits for an open pi-durable transaction, then commits even though that transaction rolls back", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    await applySqliteMigrations(db);
    const ap = new ApStore(host.sql, db, AP);
    await ap.ensure();
    const boom = new Error("boom");
    const order: string[] = [];
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => { opened = r; });
    const txn = db.transaction(async (tx) => {
      await tx.run("INSERT INTO record_ids (id, record_type) VALUES (?, 'task')", 100);
      opened();
      await sleep(20);
      order.push("transaction throws");
      throw boom;
    }).then(() => { order.push("transaction resolved"); }, (e: unknown) => { order.push(e === boom ? "transaction rejected" : `rejected with ${String(e)}`); });
    await isOpen;
    const ours = db.exclusive(() => { order.push("exclusive runs"); return host.sql.exec("INSERT INTO ap_meta (k, v) VALUES ('engine', 'pd') RETURNING v").toArray()[0]?.v; });
    // Queued, not run: the transaction is still open. Read now, asserted once both have settled, so
    // a failure here cannot leave the transaction open under the next case (on a Durable Object
    // that wedges the object instead of naming the assertion).
    const whileOpen = [...order];
    await Promise.allSettled([txn, ours]);
    is.deepEqual(whileOpen, []);
    is.deepEqual(order, ["transaction throws", "transaction rejected", "exclusive runs"]);
    is.strictEqual(await ours, "pd");
    is.strictEqual(ap.engine(), "pd");
    is.deepEqual(await db.all("SELECT id FROM record_ids"), []);
  }));

  add("PiDurableSqlite.exclusive", "control: the same write issued straight to the host while the transaction is open is rolled back with it", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    await applySqliteMigrations(db);
    const ap = new ApStore(host.sql, db, AP);
    await ap.ensure();
    await db.transaction(async () => {
      host.sql.exec("INSERT INTO ap_meta (k, v) VALUES ('engine', 'pd')");
      await sleep(5);
      throw new Error("boom");
    }).catch(() => {});
    is.strictEqual(ap.engine(), null);
  }));

  add("PiDurableSqlite.exclusive", "is atomic: a throw inside leaves nothing written, and a function that returns a thenable is refused and rolled back", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    const ap = new ApStore(host.sql, db, AP);
    await ap.ensure();
    const setEngine = (v: string) => host.sql.exec("INSERT OR IGNORE INTO ap_meta (k, v) VALUES ('engine', ?)", v);
    const boom = new Error("inside");
    let error: unknown;
    try {
      await db.exclusive(() => {
        setEngine("pd");
        host.sql.exec("INSERT INTO ap_conversations VALUES ('t_a', 't', 'a', 1, 1)");
        throw boom;
      });
    } catch (e) { error = e; }
    check(error === boom, `exclusive rejected with ${String(error)}, not the closure's error`);
    is.strictEqual(ap.engine(), null);
    is.strictEqual(ap.conversation("t_a"), null);
    // A plain function that returns a thenable: its synchronous part is rolled back.
    await is.rejects(db.exclusive(() => { setEngine("pd"); return Promise.resolve(); }), "returned a thenable");
    is.strictEqual(ap.engine(), null);
    // And one that returns commits.
    is.strictEqual(await db.exclusive(() => { setEngine("pi085"); return ap.engine(); }), "pi085");
    is.strictEqual(ap.engine(), "pi085");
  }));

  add("PiDurableSqlite.exclusive", "refuses an async or generator function before calling it, so nothing after its first await lands, not even inside a later transaction", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    await applySqliteMigrations(db);
    const ap = new ApStore(host.sql, db, AP);
    await ap.ensure();
    const ran: string[] = [];
    const write = (v: string) => { ran.push(v); host.sql.exec("INSERT OR IGNORE INTO ap_meta (k, v) VALUES ('engine', ?)", v); };
    // Without the up-front check this one ran: rejected after the fact, and its write landed after
    // the await, once inside the pi-durable transaction opened below and rolled back with it.
    await is.rejects(db.exclusive((async () => { await null; write("pd"); }) as () => unknown), "is not called");
    await is.rejects(db.exclusive((async function () { write("pd"); }) as () => unknown), "is not called");
    await is.rejects(db.exclusive((async function* () { write("pd"); }) as unknown as () => unknown), "is not called");
    await is.rejects(db.exclusive((function* () { write("pd"); }) as unknown as () => unknown), "is not called");
    await db.transaction(async (tx) => {
      await tx.run("INSERT INTO record_ids (id, record_type) VALUES (1, 'task')");
      await sleep(5);
    });
    await sleep(5);
    is.deepEqual(ran, []);
    is.strictEqual(ap.engine(), null);
  }));

  add("PiDurableSqlite.exclusive", "inTransaction is true only while a pi-durable transaction is open", () => withHost(async (host) => {
    const db = new PiDurableSqlite(host, PD);
    await applySqliteMigrations(db);
    const seen: boolean[] = [db.inTransaction];
    let opened!: () => void;
    const isOpen = new Promise<void>((r) => { opened = r; });
    const committed = db.transaction(async (tx) => {
      seen.push(db.inTransaction);
      await tx.run("INSERT INTO record_ids (id, record_type) VALUES (1, 'task')");
      opened();
      await sleep(5);
    });
    await isOpen;
    seen.push(db.inTransaction);
    await committed;
    seen.push(db.inTransaction);
    await db.transaction(async () => { seen.push(db.inTransaction); throw new Error("x"); }).catch(() => {});
    seen.push(db.inTransaction);
    await db.exclusive(() => { seen.push(db.inTransaction); });
    is.deepEqual(seen, [false, true, true, false, true, false, false]);
  }));

  return cases;
}
