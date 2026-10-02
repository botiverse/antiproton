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
 *
 * /pi-durable runs pi-durable's conformance and our facade's cases
 * (test/spec/pi-durable-spec.ts) on this object's storage, through the async
 * `transaction` node can only imitate (test/pi-durable-do.sh).
 *
 * /ap-store runs the `ap` namespace's cases and `PiDurableSqlite.exclusive`'s
 * (test/spec/ap-store-spec.ts) on this object's storage (test/ap-store-do.sh).
 *
 * /durable-drive runs the park contract's cases (test/spec/durable-drive-spec.ts):
 * a pi-durable harness on that facade, closed while it sleeps and reopened, on
 * this object's storage (test/durable-drive-do.sh).
 *
 * /durable-agent runs the pd engine's cases (test/spec/durable-agent-spec.ts): DurableAgent over
 * PdHost, a turn through `ap_model_jobs`, parked and reopened, on this object's storage
 * (test/durable-agent-do.sh).
 *
 * /pd-outbox runs the pd engine's commit-hook cases (test/spec/pd-outbox-spec.ts): usage, trace and
 * model job rows written inside pi-durable's commit, compared field for field with PiAgent's on the
 * same storage, and the jobs' crash, cancel and rollback cases (test/pd-outbox-do.sh).
 *
 * /pd-writes runs the runtime's writes on a pd object (test/spec/pd-writes-spec.ts): an approval, an
 * expired question, a model binding, a background pass and the idle lease, each started inside an open
 * pi-durable commit, none joining it (test/pd-writes-do.sh).
 *
 * /pd-tools runs the tool parity cases (test/spec/pd-tools-spec.ts): the same scripted model against
 * PiAgent and DurableAgent, each over the real gateway on this object's storage (test/pd-tools-do.sh).
 *
 * /pd-cancel runs the cancel and client-call parity cases (test/spec/pd-cancel-spec.ts) the same way
 * (test/pd-cancel-do.sh).
 */
import { DurableObject } from "cloudflare:workers";
import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import { PiSqliteStorage } from "../../src/store/pi-storage.ts";
import { controlPlaneCases } from "../../test/spec/control-plane-spec.ts";
import { usageCases } from "../../test/spec/usage-spec.ts";
import { piDurableCases, runPiDurableCases, type PiDurableHost } from "../../test/spec/pi-durable-spec.ts";
import { apStoreCases } from "../../test/spec/ap-store-spec.ts";
import { durableDriveCases, runDriveCases } from "../../test/spec/durable-drive-spec.ts";
import { pdToolsCases } from "../../test/spec/pd-tools-spec.ts";
import { pdCancelCases } from "../../test/spec/pd-cancel-spec.ts";
import { durableAgentCases } from "../../test/spec/durable-agent-spec.ts";
import { pdOutboxCases } from "../../test/spec/pd-outbox-spec.ts";
import { pdWritesCases } from "../../test/spec/pd-writes-spec.ts";

const TABLES = ["pi_entries", "pi_usage", "pi_values", "pi_list", "pi_meta"];

export class StorageProbe extends DurableObject<{ CONTROL_DB: D1Database }> {
  /** Usage needs both: D1 for the tenant's table, this object's SQLite for the agent's outbox. */
  async runUsageSpec() {
    const results: Array<{ group: string; name: string; ok: boolean; error?: string }> = [];
    for (const c of usageCases(this.env.CONTROL_DB, (this.ctx.storage as any).sql)) {
      try { await c.run(); results.push({ group: "usage", name: c.name, ok: true }); }
      catch (e: any) { results.push({ group: "usage", name: c.name, ok: false, error: String(e?.message ?? e) }); }
    }
    return results;
  }

  async runPiDurableSpec() {
    const host: PiDurableHost = this.ctx.storage;
    const t0 = Date.now();
    // Every table but the runtime's own `_cf_` ones: each case starts from an object with none of
    // ours or pi-durable's, and some cases create AgentDO's whole schema.
    const wipe = () => {
      const names = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map((r) => String(r.name)).filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
      for (const n of names) host.sql.exec(`DROP TABLE IF EXISTS "${n}"`);
    };
    const results = await runPiDurableCases(piDurableCases(async (use) => {
      wipe();
      try { await use(host); } finally { wipe(); }
    }));
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  async runApStoreSpec() {
    const host: PiDurableHost = this.ctx.storage;
    const t0 = Date.now();
    const wipe = () => {
      const names = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map((r) => String(r.name)).filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
      for (const n of names) host.sql.exec(`DROP TABLE IF EXISTS "${n}"`);
    };
    const results = await runPiDurableCases(apStoreCases(async (use) => {
      wipe();
      try { await use(host); } finally { wipe(); }
    }));
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  async runDurableDriveSpec() {
    const host: PiDurableHost = this.ctx.storage;
    const t0 = Date.now();
    const wipe = () => {
      const names = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map((r) => String(r.name)).filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
      for (const n of names) host.sql.exec(`DROP TABLE IF EXISTS "${n}"`);
    };
    // No timer probe: workerd does not expose its live timers, so "no timer outlives close" is read
    // under node only.
    const results = await runDriveCases(durableDriveCases(async (use) => {
      wipe();
      try { await use(host); } finally { wipe(); }
    }, undefined));
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  async runDurableAgentSpec() {
    const host: PiDurableHost = this.ctx.storage;
    const t0 = Date.now();
    const wipe = () => {
      const names = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map((r) => String(r.name)).filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
      for (const n of names) host.sql.exec(`DROP TABLE IF EXISTS "${n}"`);
    };
    // No timer probe, as for /durable-drive: "no harness left open" is read here, live timers under node.
    const results = await runDriveCases(durableAgentCases(async (use) => {
      wipe();
      try { await use(host); } finally { wipe(); }
    }, undefined));
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  async runPdOutboxSpec() {
    const host: PiDurableHost = this.ctx.storage;
    const t0 = Date.now();
    const wipe = () => {
      const names = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map((r) => String(r.name)).filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
      for (const n of names) host.sql.exec(`DROP TABLE IF EXISTS "${n}"`);
    };
    const results = await runDriveCases(pdOutboxCases(async (use) => {
      wipe();
      try { await use(host); } finally { wipe(); }
    }));
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /** `only`: the cases whose name includes it, to run one at a time. */
  async runPdWritesSpec(only = "") {
    const host: PiDurableHost = this.ctx.storage;
    const t0 = Date.now();
    const wipe = () => {
      const names = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map((r) => String(r.name)).filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
      for (const n of names) host.sql.exec(`DROP TABLE IF EXISTS "${n}"`);
    };
    const results = await runDriveCases(pdWritesCases(async (use) => {
      wipe();
      try { await use(host); } finally { wipe(); }
    // No timer inside the commit: a sleep there intermittently never fired under `wrangler dev`, and the
    // object was reset after 30 s (measured 2026-10-02, 1 run in 3 of one case). The cases still start
    // their write inside the open commit, which is what each checks.
    }, { slowCommitMs: 0 }).filter((c) => c.name.includes(only)));
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  async runPdToolsSpec() {
    const host: PiDurableHost = this.ctx.storage;
    const t0 = Date.now();
    const wipe = () => {
      const names = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map((r) => String(r.name)).filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
      for (const n of names) host.sql.exec(`DROP TABLE IF EXISTS "${n}"`);
    };
    const results = await runDriveCases(pdToolsCases(async (use) => {
      wipe();
      try { await use(host); } finally { wipe(); }
    }, { slowCommitMs: 0 }));
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  async runPdCancelSpec() {
    const host: PiDurableHost = this.ctx.storage;
    const t0 = Date.now();
    const wipe = () => {
      const names = host.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray()
        .map((r) => String(r.name)).filter((n) => !n.startsWith("_cf_") && !n.startsWith("sqlite_"));
      for (const n of names) host.sql.exec(`DROP TABLE IF EXISTS "${n}"`);
    };
    const results = await runDriveCases(pdCancelCases(async (use) => {
      wipe();
      try { await use(host); } finally { wipe(); }
    }, { slowCommitMs: 0 }));
    return {
      backend: "durable-object",
      ms: Date.now() - t0,
      passed: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

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
    if (new URL(request.url).pathname === "/control-plane") {
      const cp = await runControlPlaneSpec(env.CONTROL_DB);
      const usage = await env.PROBE.get(env.PROBE.idFromName("usage")).runUsageSpec();
      const results = [...cp.results, ...usage];
      return Response.json({ ...cp, results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length });
    }
    if (new URL(request.url).pathname === "/durable-drive") {
      return Response.json(await env.PROBE.get(env.PROBE.idFromName("durable-drive")).runDurableDriveSpec());
    }
    if (new URL(request.url).pathname === "/durable-agent") {
      return Response.json(await env.PROBE.get(env.PROBE.idFromName("durable-agent")).runDurableAgentSpec());
    }
    if (new URL(request.url).pathname === "/pd-outbox") {
      return Response.json(await env.PROBE.get(env.PROBE.idFromName("pd-outbox")).runPdOutboxSpec());
    }
    if (new URL(request.url).pathname === "/pd-writes") {
      const only = new URL(request.url).searchParams.get("only") ?? "";
      return Response.json(await env.PROBE.get(env.PROBE.idFromName(`pd-writes${only}`)).runPdWritesSpec(only));
    }
    if (new URL(request.url).pathname === "/pd-tools") {
      return Response.json(await env.PROBE.get(env.PROBE.idFromName("pd-tools")).runPdToolsSpec());
    }
    if (new URL(request.url).pathname === "/pd-cancel") {
      return Response.json(await env.PROBE.get(env.PROBE.idFromName("pd-cancel")).runPdCancelSpec());
    }
    if (new URL(request.url).pathname === "/ap-store") {
      return Response.json(await env.PROBE.get(env.PROBE.idFromName("ap-store")).runApStoreSpec());
    }
    if (new URL(request.url).pathname === "/pi-durable") {
      return Response.json(await env.PROBE.get(env.PROBE.idFromName("pi-durable")).runPiDurableSpec());
    }
    const stub = env.PROBE.get(env.PROBE.idFromName("pi-storage"));
    return Response.json(await stub.runPiStorageSpec());
  },
};
