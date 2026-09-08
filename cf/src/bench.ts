/**
 * τ²-bench retail, hosted inside the Durable Object.
 *
 * The point is to be able to run harness ablations on Cloudflare with the same
 * tasks, the same scoring and the same user simulator we already use in Node —
 * so a claim about a Cloudflare change is measured on the bench, not argued
 * from a pricing page.
 *
 * Per-task domain state is stored as the list of write actions performed, not
 * as a copy of the 2.8 MB database: the state is base + replay, so an evicted
 * object rebuilds it exactly instead of carrying a blob per task.
 */
import { retailPlugin, applyRetailAction, WRITE_TOOLS, type RetailDB } from "../../bench/tau2/retail.ts";
import type { Plugin } from "../../src/plugins/types.ts";

const BASE_DB_KEY = "bench/tau2-db.json";

export interface BenchTaskState {
  db: RetailDB;
  performed: Array<{ name: string; args: unknown }>;
}

export class BenchState {
  #bucket: R2Bucket;
  #sql: SqlStorage;
  #base: RetailDB | null = null;
  #live = new Map<string, BenchTaskState>();

  constructor(bucket: R2Bucket, sql: SqlStorage) {
    this.#bucket = bucket;
    this.#sql = sql;
    this.#sql.exec("CREATE TABLE IF NOT EXISTS bench_tasks(task_id TEXT PRIMARY KEY, performed TEXT)");
  }

  /** Loaded once per object instance; the base database is immutable. */
  async base(): Promise<RetailDB> {
    if (this.#base) return this.#base;
    const obj = await this.#bucket.get(BASE_DB_KEY);
    if (!obj) throw new Error(`bench base db missing: ${BASE_DB_KEY} (upload it first)`);
    this.#base = JSON.parse(await obj.text()) as RetailDB;
    return this.#base;
  }

  async reset(taskId: string) {
    this.#live.delete(taskId);
    this.#sql.exec("DELETE FROM bench_tasks WHERE task_id=?", taskId);
    await this.state(taskId);
  }

  async state(taskId: string): Promise<BenchTaskState> {
    const cached = this.#live.get(taskId);
    if (cached) return cached;
    const base = await this.base();
    const row = this.#sql.exec("SELECT performed FROM bench_tasks WHERE task_id=?", taskId).toArray()[0] as any;
    const performed = row ? (JSON.parse(row.performed) as BenchTaskState["performed"]) : [];
    // Replay rather than store: identical result, and no per-task megabytes.
    const db = structuredClone(base);
    for (const a of performed) {
      if (WRITE_TOOLS.has(a.name)) {
        try { applyRetailAction(db, a.name, a.args); } catch { /* replay of a rejected call */ }
      }
    }
    const st: BenchTaskState = { db, performed };
    this.#live.set(taskId, st);
    return st;
  }

  #persist(taskId: string, st: BenchTaskState) {
    this.#sql.exec(
      "INSERT INTO bench_tasks(task_id, performed) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET performed=excluded.performed",
      taskId, JSON.stringify(st.performed),
    );
  }

  /** The domain plugin, resolved per task from the caller's identity. */
  plugin(): Plugin {
    const shape = retailPlugin({ products: {}, users: {}, orders: {} } as RetailDB, []);
    return {
      id: shape.id,
      version: shape.version,
      tools: shape.tools,
      invoke: async (tool, args, ctx) => {
        const st = await this.state(ctx.caller.taskId);
        const before = st.performed.length;
        const out = await retailPlugin(st.db, st.performed).invoke(tool, args, ctx);
        if (st.performed.length !== before) this.#persist(ctx.caller.taskId, st);
        return out;
      },
    };
  }

  async result(taskId: string) {
    const st = await this.state(taskId);
    return {
      performed: st.performed,
      writes: st.performed.filter((p) => WRITE_TOOLS.has(p.name)),
      db: st.db,
    };
  }
}
