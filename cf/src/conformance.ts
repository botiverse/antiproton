/**
 * A Worker that exists only to run specs against real Durable Object storage.
 *
 * It is never deployed. The reason it is a separate worker rather than another
 * route on the real one is measured: bundling pi's conformance suite into
 * `cf/src/index.ts` grew the production binary from 342,089 to 400,131 bytes,
 * and all but 500 of those bytes are test code. A multi-tenant Worker that pays
 * for a test suite on every cold start is the wrong trade, and marking the
 * import dynamic makes it worse — esbuild inlines it and adds the async
 * machinery on top (448,080 bytes).
 *
 * So: `npm run pi-storage:do`. Same PiSqliteStorage class as production, same
 * `sql` and `transactionSync` the real object hands it — what differs is only
 * which worker is asking.
 */
import { DurableObject } from "cloudflare:workers";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { PiSqliteStorage } from "../../src/store/pi-storage.ts";
import { DurableObjectStore } from "../../src/store/durable-object.ts";
import { Ledger, intervals } from "../../src/store/ledger.ts";

const TABLES = ["pi_entries", "pi_usage", "pi_values", "pi_list", "pi_meta"];

export class StorageProbe extends DurableObject {
  async runPiStorageSpec() {
    const sql = (this.ctx.storage as any).sql;
    const t0 = Date.now();
    const wipe = () => { for (const t of TABLES) sql.exec(`DROP TABLE IF EXISTS ${t}`); };

    const cases = createStorageConformance(async () => {
      wipe();
      return {
        storage: new PiSqliteStorage(this.ctx.storage as any),
        async [Symbol.asyncDispose]() { wipe(); },
      };
    });

    const results: Array<{ group: string; name: string; ok: boolean; error?: string }> = [];
    for (const c of cases) {
      try { await c.run(); results.push({ group: c.group, name: c.name, ok: true }); }
      catch (e: any) {
        results.push({ group: c.group, name: c.name, ok: false, error: String(e?.message ?? e) });
      }
    }
    wipe();
    results.push(...(await this.#usageCases(sql)));
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /**
   * The ledger and the kept-event trace, on real Durable Object SQLite.
   *
   * node:sqlite accepts both schemas; these run them where production does,
   * because a partial unique index and `ON CONFLICT DO NOTHING` without a
   * target are exactly the SQL two SQLite builds can disagree about.
   */
  async #usageCases(sql: any) {
    const group = "usage ledger (durable-object)";
    const out: Array<{ group: string; name: string; ok: boolean; error?: string }> = [];
    const wipe = () => { for (const t of ["usage_events", "usage_lost"]) sql.exec(`DROP TABLE IF EXISTS ${t}`); };
    const run = async (name: string, fn: () => Promise<void>) => {
      wipe();
      try { await fn(); out.push({ group, name, ok: true }); }
      catch (e: any) { out.push({ group, name, ok: false, error: String(e?.message ?? e) }); }
    };
    const at = { tenantId: "t", agentId: "a", alias: "sandbox" };

    await run("a retried opened is one row, and a closed pairs with it", async () => {
      const l = new Ledger(sql);
      l.append(at, { kind: "container", event: "opened", ref: "b-1" });
      l.append(at, { kind: "container", event: "opened", ref: "b-1" });
      l.append(at, { kind: "container", event: "closed", ref: "b-1" });
      const rows = l.since(0);
      if (rows.length !== 2) throw new Error(`${rows.length} rows, not 2`);
      const [i] = intervals(rows);
      if (!i || i.openedAt === null || i.closedAt === null) throw new Error(`not paired: ${JSON.stringify(i)}`);
    });

    await run("one-shot quantities are not deduplicated", async () => {
      const l = new Ledger(sql);
      l.append(at, { kind: "tokens", event: "closed", ref: "m", quantity: 1, unit: "token" });
      l.append(at, { kind: "tokens", event: "closed", ref: "m", quantity: 1, unit: "token" });
      if (l.since(0).length !== 2) throw new Error("two requests with one ref became one row");
    });

    await run("a kept event flags its operation, in the agent's store", async () => {
      const store = new DurableObjectStore(this.ctx as any);
      await store.init();
      const op = `op-${Date.now()}`;
      await store.recordOperation({ operationId: op, tenantId: "t", agentId: "a", taskId: "k",
        mountAlias: "sandbox", tool: "sandbox.open", toolVersion: "1" });
      await store.noteUsageLost({ ...at, operationId: op }, { kind: "container", event: "opened", ref: "b-2" });
      await store.noteUsageLost({ ...at, operationId: null }, { kind: "container", event: "closed", ref: "b-2" });
      const row = await store.getOperation("t", op);
      if (row?.usageLost !== 1) throw new Error(`operation row: ${JSON.stringify(row)}`);
      const lost = await store.listUsageLost("t", "a");
      if (lost.length !== 2 || lost[0]!.operationId !== op || lost[1]!.operationId !== null) {
        throw new Error(`kept events: ${JSON.stringify(lost)}`);
      }
    });
    wipe();
    return out;
  }
}


export default {
  async fetch(_request: Request, env: { PROBE: DurableObjectNamespace<StorageProbe> }) {
    const stub = env.PROBE.get(env.PROBE.idFromName("pi-storage"));
    return Response.json(await stub.runPiStorageSpec());
  },
};
