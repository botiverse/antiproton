/**
 * Every published τ² record, re-graded under the reward_basis rule (`rewardOf`, bench/tau2/grade.ts), read-only.
 *
 *   node bench/tau2/rescore.ts [extra-key ...]
 *
 * The keys come from report/runs/manifest.tsv; each record is fetched from the public bucket and checked against
 * the manifest's SHA-256 before it is read, so a figure here is about the bytes the report's figures were computed
 * from. An extra key (a record published to the bucket whose manifest line is not merged yet) is read unchecked
 * and marked so. Nothing is written anywhere.
 *
 * A row is re-graded from its own fields — `dbMatch` and `actionMatch` as the run recorded them — against its
 * task's `evaluation_criteria` in bench/tau2/data/tasks.json. A row whose recorded `reward` is not
 * `dbMatch && actionMatch` would mean the old rule was not what produced it, and is counted, not hidden.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { rewardOf } from "./grade.ts";

const BUCKET = "https://pub-212e604eb60944c6854033a8ee1b3cef.r2.dev/";
const root = new URL("../../", import.meta.url);
const tasks = new Map<string, any>(
  (JSON.parse(readFileSync(new URL("bench/tau2/data/tasks.json", root), "utf8")) as any[]).map((t) => [String(t.id), t]));
const manifest = readFileSync(new URL("report/runs/manifest.tsv", root), "utf8").trim().split("\n")
  .map((l) => l.split("\t")).filter(([k]) => k!.endsWith(".json")).map(([key, sha]) => ({ key: key!, sha: sha as string | null }));
const extra = process.argv.slice(2).filter((k) => !manifest.some((m) => m.key === k)).map((key) => ({ key, sha: null }));

async function get(key: string, sha: string | null): Promise<any> {
  const res = await fetch(BUCKET + key);
  // A 404 still has a body; only the status says whether this is the record.
  if (res.status !== 200) throw new Error(`${key}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const got = createHash("sha256").update(bytes).digest("hex");
  if (sha && got !== sha) throw new Error(`${key}: sha256 ${got} is not the manifest's ${sha}`);
  return JSON.parse(bytes.toString("utf8"));
}

type Tally = { records: number; rows: number; old: number; now: number; up: number; down: number; unjudged: number };
const zero = (): Tally => ({ records: 0, rows: 0, old: 0, now: 0, up: 0, down: 0, unjudged: 0 });
const add = (a: Tally, b: Tally) => { for (const k of Object.keys(a) as Array<keyof Tally>) a[k] += b[k]; };

const series = new Map<string, Tally>();
const all = zero();
let inconsistent = 0;
const lines: string[] = [];
const entries = [...manifest, ...extra];
// A few at a time: a hundred and more connections at once were refused.
const records: Array<{ key: string; sha: string | null; body: any }> = [];
for (let i = 0; i < entries.length; i += 8) {
  records.push(...await Promise.all(entries.slice(i, i + 8).map(async (e) => ({ ...e, body: await get(e.key, e.sha) }))));
}
for (const { key, sha, body } of records) {
  if (body?.bench !== "tau2-retail" || !Array.isArray(body.results)) continue;
  const t = zero();
  t.records = 1;
  for (const r of body.results) {
    const task = tasks.get(String(r.id));
    if (!task) throw new Error(`${key}: row for task ${r.id}, which tasks.json does not have`);
    if (Number(r.reward) !== (r.dbMatch && r.actionMatch ? 1 : 0)) inconsistent += 1;
    const g = rewardOf(task, { dbMatch: !!r.dbMatch, actionMatch: !!r.actionMatch });
    t.rows += 1; t.old += Number(r.reward); t.now += g.reward;
    if (g.reward > Number(r.reward)) t.up += 1;
    if (g.reward < Number(r.reward)) t.down += 1;
    if (g.unjudged) t.unjudged += 1;
  }
  const name = `${body.runnerMethod ?? "bench"} ${body.model ?? "?"}`;
  if (!series.has(name)) series.set(name, zero());
  add(series.get(name)!, t);
  add(all, t);
  lines.push([key.replace(/^runs\//, ""), name, `${t.old}/${t.rows}`, `${t.now}/${t.rows}`, t.up - t.down ? `${t.up - t.down > 0 ? "+" : ""}${t.up - t.down}` : "",
    sha ? "" : "(not in manifest)"].join("\t"));
}

console.log(["record", "series", "old", "new", "Δ", ""].join("\t"));
for (const l of lines) console.log(l);
const row = (n: string, t: Tally) => console.log(`${n}\t${t.records} records\t${t.rows} rows\told ${t.old}\tnew ${t.now}\t` +
  `+${t.up} -${t.down}\tunjudged component on ${t.unjudged} rows`);
console.log("");
for (const [n, t] of [...series].sort()) row(n, t);
row("all", all);
console.log(`rows whose recorded reward is not dbMatch && actionMatch: ${inconsistent}`);
