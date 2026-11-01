/**
 * The canary's Worker config (cf/wrangler.canary.jsonc) against every other deployment's.
 *
 * The canary runs an unmerged commit, so the one thing it must never do is bind something another deployment
 * owns: production's database or bucket, or preview's queues. Every name and id those configs declare is collected
 * from the files themselves (not from a list here that could go stale) and looked for in the canary's values.
 * Then the canary is mapped back onto preview, name for name, and must come out as preview exactly: it is
 * modelled on preview, and a difference that is not a resource name is a decision someone should have written down.
 * Last, wrangler parses and bundles it with --dry-run, with no credentials in the environment (no network write
 * is possible), and the deploy script's own argument check is asked to refuse.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const root = new URL("..", import.meta.url).pathname;
/** A wrangler config, with whole-line comments dropped (the files carry no other kind). */
function configOf(file: string): Record<string, any> {
  const text = readFileSync(join(root, "cf", file), "utf8");
  return JSON.parse(text.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n"));
}
/** Every string value in a config, with the path it sits at. */
function strings(v: unknown, at = ""): Array<[string, string]> {
  if (typeof v === "string") return [[at, v]];
  if (Array.isArray(v)) return v.flatMap((x, i) => strings(x, `${at}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => strings(x, at ? `${at}.${k}` : k));
  return [];
}
const GATEWAY = /^https:\/\/gateway\.ai\.cloudflare\.com\/v1\/[0-9a-f]{32}\/([^/]+)\//;
/** The names and ids of what a config binds or serves: the resources a deploy with it would touch. */
function resourcesOf(c: Record<string, any>): string[] {
  const out = [c.name];
  for (const r of c.routes ?? []) out.push(r.pattern);
  for (const d of c.d1_databases ?? []) out.push(d.database_name, d.database_id);
  for (const b of c.r2_buckets ?? []) out.push(b.bucket_name);
  for (const q of [...(c.queues?.producers ?? []), ...(c.queues?.consumers ?? [])]) out.push(q.queue, q.dead_letter_queue);
  const vars = c.vars ?? {};
  for (const k of ["HOOK_ORIGIN", "UI_ORIGIN", "ADMIN_ORIGIN"]) if (vars[k]) out.push(new URL(vars[k]).host);
  if (vars.ARTIFACT_BUCKET) out.push(vars.ARTIFACT_BUCKET);
  for (const [, s] of strings(vars)) { const g = GATEWAY.exec(s); if (g) out.push(g[1]); }
  return out.filter((x): x is string => typeof x === "string" && x.length > 0);
}
/** Where `name` occurs in `value` as a whole name: `antiproton.ai` is in `https://antiproton.ai/x`, not in `canary.antiproton.ai`. */
function names(value: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9.-])${esc}($|[^A-Za-z0-9.-])`).test(value);
}
/** Each value in `config` that names one of `forbidden`, as "path = value (names x)". */
function collisions(config: Record<string, any>, forbidden: string[]): string[] {
  const hits: string[] = [];
  for (const [at, s] of strings(config)) {
    if (/preview/i.test(s)) hits.push(`${at} = ${s} (says preview)`);
    for (const f of forbidden) if (names(s, f)) hits.push(`${at} = ${s} (names ${f})`);
  }
  return hits;
}

const canary = configOf("wrangler.canary.jsonc");
const preview = configOf("wrangler.preview.jsonc");
const others = { "wrangler.jsonc": configOf("wrangler.jsonc"), "wrangler.preview.jsonc": preview, "wrangler.conformance.jsonc": configOf("wrangler.conformance.jsonc") };
const forbidden = [...new Set(Object.values(others).flatMap(resourcesOf))];

await check("the canary names no resource, host, id or gateway of production, preview or conformance", () => {
  // Read from the configs: production's database id, preview's queues, every custom domain, both gateways.
  for (const must_have of ["antiproton", "antiproton.ai", "admin.antiproton.ai", "726e14d9-261f-4712-a7a5-b011db179598", "antiproton-preview-model", "antiproton-preview-control"]) {
    must(forbidden.includes(must_have), `the collected names miss ${must_have}: ${forbidden.join(", ")}`);
  }
  const hits = collisions(canary, forbidden);
  must(hits.length === 0, `cf/wrangler.canary.jsonc: ${hits.join("; ")}`);
});

await check("the check is not vacuous: run on preview's own config it finds preview's names", () => {
  // A detector that cannot fire would pass any config; preview against production's and its own names must hit.
  const hits = collisions(preview, forbidden);
  for (const want of ["name = antiproton-preview", "d1_databases[0].database_id = a0e85fd1", "vars.HOOK_ORIGIN = https://preview.antiproton.ai"]) {
    must(hits.some((h) => h.startsWith(want)), `no hit for ${want}: ${hits.join("; ")}`);
  }
});

await check("every resource the canary binds is its own: antiproton-canary-*, canary.antiproton.ai, its own gateway", () => {
  must(canary.name === "antiproton-canary", `name ${canary.name}`);
  must(isDeepStrictEqual(canary.routes, [{ pattern: "canary.antiproton.ai", custom_domain: true }]), `routes ${JSON.stringify(canary.routes)}`);
  must(canary.vars.HOOK_ORIGIN === "https://canary.antiproton.ai", `HOOK_ORIGIN ${canary.vars.HOOK_ORIGIN}`);
  must(canary.vars.ARTIFACT_BUCKET === canary.r2_buckets[0].bucket_name, "ARTIFACT_BUCKET is not the bound bucket");
  const own = resourcesOf(canary).filter((r) => r !== canary.d1_databases[0].database_id);
  const stray = own.filter((r) => !/^antiproton-canary(-|$)/.test(r) && r !== "canary.antiproton.ai");
  must(stray.length === 0, `not canary-scoped: ${stray.join(", ")}`);
  // The id is either the marked placeholder or a real one; deploy-canary.sh refuses the placeholder.
  const id = canary.d1_databases[0].database_id;
  must(/^PLACEHOLDER/.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id), `database_id ${id}`);
});

await check("mapped back name for name, the canary is preview exactly (bindings, DO classes, migrations, queues, vars, cron)", () => {
  const back = (v: unknown): unknown =>
    typeof v === "string" ? v.replaceAll("antiproton-canary", "antiproton-preview").replaceAll("canary.antiproton.ai", "preview.antiproton.ai")
    : Array.isArray(v) ? v.map(back)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, back(x)])) : v;
  const a = back(canary) as Record<string, any>, b = structuredClone(preview);
  a.d1_databases[0].database_id = b.d1_databases[0].database_id = "<id>";
  if (!isDeepStrictEqual(a, b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !isDeepStrictEqual(a[k], b[k]));
    throw new Error(`differs from preview beyond resource names, at: ${keys.join(", ")}`);
  }
});

await check("wrangler parses and bundles it (deploy --dry-run, no credentials in the environment) and lists only canary resources", () => {
  const out = mkdtempSync(join(tmpdir(), "canary-dry-"));
  try {
    const env: Record<string, string | undefined> = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };
    for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) delete env[k];
    const r = spawnSync("npx", ["wrangler", "deploy", "--dry-run", "--outdir", out, "--config", "wrangler.canary.jsonc"],
      { cwd: join(root, "cf"), env, encoding: "utf8", timeout: 240_000 });
    const text = `${r.stdout}\n${r.stderr}`;
    must(r.status === 0, `exit ${r.status}: ${text.slice(-800)}`);
    must(/--dry-run: exiting now/.test(text), `no dry-run exit line: ${text.slice(-400)}`);
    for (const want of ["antiproton-canary-control", "antiproton-canary-artifacts", "antiproton-canary-model", "https://canary.antiproton.ai"]) {
      must(text.includes(want), `bindings do not list ${want}`);
    }
    must(!/preview/i.test(text), "the dry run mentions preview");
  } finally { rmSync(out, { recursive: true, force: true }); }
});

await check("deploy-canary.sh refuses a missing or malformed sha before it fetches or builds anything", () => {
  const run = (...args: string[]) => spawnSync("bash", [join(root, "cf/scripts/deploy-canary.sh"), ...args], { encoding: "utf8", timeout: 20_000 });
  const none = run();
  must(none.status === 2 && /usage:/.test(none.stderr), `no argument: ${none.status} ${none.stderr}`);
  for (const bad of ["master", "HEAD", "abc", "ABCDEF1", "1234567; rm -rf /"]) {
    const r = run(bad);
    must(r.status === 1 && /^STEP refused: .*not a commit sha/m.test(r.stdout), `${bad}: ${r.status} ${r.stdout}${r.stderr}`);
  }
  must(run("a", "b").status === 2, "two arguments were taken");
});

await check("the deploy script parses (`bash -n`)", () => {
  execFileSync("bash", ["-n", join(root, "cf/scripts/deploy-canary.sh")]);
});

console.log(`\n  Canary config\n  ${"─".repeat(56)}`);
for (const r of results) console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(results.length > 0 && pass === results.length ? 0 : 1);
