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
 *
 * /control-plane runs the control plane's queries against a real local D1
 * database the same way (test/control-plane-d1.sh prepares it).
 */
import { DurableObject } from "cloudflare:workers";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { PiSqliteStorage } from "../../src/store/pi-storage.ts";
import { controlPlaneCases } from "../../test/spec/control-plane-spec.ts";

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
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }
}

async function runControlPlaneSpec(db: D1Database) {
  const t0 = Date.now();
  const results: Array<{ group: string; name: string; ok: boolean; error?: string }> = [];
  for (const c of controlPlaneCases(db)) {
    try { await c.run(); results.push({ group: "control plane", name: c.name, ok: true }); }
    catch (e: any) { results.push({ group: "control plane", name: c.name, ok: false, error: String(e?.message ?? e) }); }
  }
  return {
    backend: "d1",
    ms: Date.now() - t0,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

export default {
  async fetch(request: Request, env: { PROBE: DurableObjectNamespace<StorageProbe>; CONTROL_DB: D1Database }) {
    if (new URL(request.url).pathname === "/control-plane") return Response.json(await runControlPlaneSpec(env.CONTROL_DB));
    const stub = env.PROBE.get(env.PROBE.idFromName("pi-storage"));
    return Response.json(await stub.runPiStorageSpec());
  },
};
