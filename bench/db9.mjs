import pg from "pg";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
for (const l of readFileSync(`${homedir()}/.secrets/agent-harness.env`, "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()); if (m) process.env[m[1]] = m[2];
}
const pool = new pg.Pool({ connectionString: process.env.DB9_DSN, max: 12, ssl: { rejectUnauthorized: false } });
const c = await pool.connect();
await c.query("DROP TABLE IF EXISTS bench");
await c.query("CREATE TABLE bench(id bigint primary key, v int, payload text)");
const p = (a) => { a.sort((x,y)=>x-y); return { p50: a[Math.floor(a.length*0.5)]|0, p95: a[Math.floor(a.length*0.95)]|0 }; };

const rt = [];
for (let i = 0; i < 20; i++) { const t = performance.now(); await c.query("SELECT 1"); rt.push(performance.now()-t); }
console.log("  SELECT 1 round trip        ", JSON.stringify(p(rt)), "ms");

const ins = [];
for (let i = 0; i < 20; i++) { const t = performance.now(); await c.query("INSERT INTO bench VALUES ($1,$2,$3)", [i, i, "x".repeat(200)]); ins.push(performance.now()-t); }
console.log("  single-row INSERT          ", JSON.stringify(p(ins)), "ms");

const tx = [];
for (let i = 0; i < 15; i++) {
  const t = performance.now();
  await c.query("BEGIN");
  await c.query("UPDATE bench SET v=v+1 WHERE id=$1", [i]);
  await c.query("INSERT INTO bench VALUES ($1,$2,$3)", [1000+i, i, "y"]);
  await c.query("COMMIT");
  tx.push(performance.now()-t);
}
console.log("  2-statement TRANSACTION    ", JSON.stringify(p(tx)), "ms   <- the runtime's advance shape");
c.release();

let uid = 200000;
for (const conc of [1, 4, 8, 16]) {
  const N = 48, t0 = performance.now();
  let n = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (n++ < N) { await pool.query("INSERT INTO bench VALUES ($1,$2,$3)", [uid++, 0, "z"]); }
  }));
  const secs = (performance.now()-t0)/1000;
  console.log(`  throughput conc=${conc}        ${(N/secs).toFixed(1)} ops/s  (${secs.toFixed(1)}s for ${N})`);
}
await pool.end();
