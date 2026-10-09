/**
 * The trace export's reader (cf/src/eval-read.ts `readTraceWindow`) over a stand-in object and bucket: the object read
 * before the bucket, batches ordered by their seq range rather than their key's text, a row in both read once, the
 * window and limit applied in seq order, and a page that stops at a bound naming where to go on, so paging reaches
 * every row exactly once. And `redactCredentials` walking whatever it is given.
 *
 * Through the Worker and a real object, with a real alarm pass exporting the batches: test/eval-seed-object.ts.
 */
import { readTraceWindow, redactCredentials, TRACE_OBJECTS_SCAN, type TraceSource } from "../cf/src/eval-read.ts";
import { traceBody, traceKey, traceKeyRange, tracePrefix } from "../cf/src/trace-r2.ts";
import type { TraceOutboxRow } from "../src/trace/outbox.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }
const show = (v: unknown) => JSON.stringify(v);

const T = "t-raft", A = "raft_01JEVAL", T0 = 1_800_000_000_000;
const row = (seq: number, at = T0 + seq * 1000, who: { t?: string; a?: string } = {}): TraceOutboxRow =>
  ({ seq, at, tenantId: who.t ?? T, agentId: who.a ?? A, kind: "tool.call", spanId: `op_${seq}`, status: "succeeded", verdict: "ok", attrs: { tool: "noop" } });

/** A bucket of batches and an object's outbox, with the order they were asked in. */
function source(batches: TraceOutboxRow[][], local: TraceOutboxRow[], opts: { uploaded?: number; pageSize?: number; agent?: boolean } = {}) {
  const asked: string[] = [];
  const objects = batches.map((b) => ({ key: traceKey(T, A, b[0]!.seq, b[b.length - 1]!.seq), body: new TextDecoder().decode(traceBody(b)) }));
  // A foreign agent's batch under a neighbouring prefix, and a key this scheme never makes.
  objects.push({ key: traceKey(T, `${A}x`, 1, 1), body: new TextDecoder().decode(traceBody([row(1, T0, { a: `${A}x` })])) });
  objects.push({ key: `${tracePrefix(T, A)}notes.txt`, body: "not a batch" });
  objects.sort((a, b) => a.key.localeCompare(b.key));
  const size = opts.pageSize ?? 1000;
  const src: TraceSource = {
    async local(afterSeq, limit) { asked.push("local"); return opts.agent === false ? null : local.filter((r) => r.seq > afterSeq).slice(0, limit); },
    async list(prefix, cursor) {
      asked.push(`list:${cursor ?? ""}`);
      const all = objects.filter((o) => o.key.startsWith(prefix));
      const start = cursor ? Number(cursor) : 0;
      const page = all.slice(start, start + size);
      const truncated = start + size < all.length;
      return { objects: page.map((o) => ({ key: o.key, uploaded: new Date(opts.uploaded ?? T0 + 10_000_000) })), truncated, ...(truncated ? { cursor: String(start + size) } : {}) };
    },
    async get(key) { asked.push(`get:${key}`); return objects.find((o) => o.key === key)?.body ?? null; },
  };
  return { src, asked };
}
const ALL = { from: T0, to: T0 + 86_400_000, afterSeq: 0, limit: 1000 };
const seqs = (rows: TraceOutboxRow[]) => rows.map((r) => r.seq);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const batch = (a: number, b: number) => range(a, b).map((s) => row(s));

await check("the object is read before the bucket is listed; a row in both is one row; batches go by seq, not by key text", async () => {
  // Keys "10-19" sort before "2-9" as text.
  const { src, asked } = source([batch(2, 9), batch(10, 19)], [...batch(15, 19), ...batch(20, 22)]);
  const r = await readTraceWindow(src, T, A, ALL);
  must(r.ok, show(r));
  must(show(seqs(r.rows)) === show(range(2, 22)), `rows: ${show(seqs(r.rows))}`);
  must(asked[0] === "local" && asked[1] === "list:", `order: ${show(asked)}`);
  must(r.nextCursor === null && r.scanned.objects === 2, show(r));
  must(r.rows.every((x) => x.agentId === A), "a neighbouring agent's row came through its prefix");
});

await check("the window is from <= at < to, and the cursor is a seq: only rows after it", async () => {
  const { src } = source([batch(1, 10)], batch(11, 12));
  const r = await readTraceWindow(src, T, A, { ...ALL, from: T0 + 3000, to: T0 + 11_000, afterSeq: 4 });
  must(r.ok && show(seqs(r.rows)) === show(range(5, 10)), show(r.ok && seqs(r.rows)));
});

await check("paging by nextCursor reaches every row exactly once, whether a page stops at its limit or at the batch bound", async () => {
  const batches = range(0, TRACE_OBJECTS_SCAN + 4).map((i) => batch(i * 5 + 1, i * 5 + 5));
  const last = (TRACE_OBJECTS_SCAN + 5) * 5;
  const { src } = source(batches, batch(last - 2, last + 3), { pageSize: 7 });
  for (const limit of [1, 3, 7, 1000]) {
    const got: number[] = [];
    let afterSeq = 0, pages = 0;
    for (;;) {
      const r = await readTraceWindow(src, T, A, { ...ALL, afterSeq, limit });
      must(r.ok, show(r));
      must(r.rows.length <= limit, `page over its limit: ${r.rows.length}`);
      got.push(...seqs(r.rows));
      pages++;
      if (r.nextCursor === null) break;
      must(Number(r.nextCursor) > afterSeq, `limit ${limit}: the cursor did not move (${afterSeq} -> ${r.nextCursor})`);
      afterSeq = Number(r.nextCursor);
      must(pages < 1000, "paging does not end");
    }
    must(show(got) === show(range(1, last + 3)), `limit ${limit}: ${got.length} rows, ${show(got.slice(0, 12))}…`);
  }
  // The bound itself: one page with no limit to hit still stops after TRACE_OBJECTS_SCAN batches and says where.
  const first = await readTraceWindow(src, T, A, ALL);
  must(first.ok && first.scanned.objects === TRACE_OBJECTS_SCAN && first.nextCursor === String(TRACE_OBJECTS_SCAN * 5), show(first.ok && [first.scanned, first.nextCursor]));
});

await check("a batch uploaded well before the window opens is not read; one uploaded after is", async () => {
  const early = source([batch(1, 5)], [], { uploaded: T0 - 2 * 3_600_000 });
  const r = await readTraceWindow(early.src, T, A, { ...ALL, from: T0 });
  must(r.ok && r.rows.length === 0 && !early.asked.some((a) => a.startsWith("get:")), show(early.asked));
  const late = source([batch(1, 5)], [], { uploaded: T0 });
  const s = await readTraceWindow(late.src, T, A, { ...ALL, from: T0 });
  must(s.ok && s.rows.length === 5, show(s));
});

await check("an object that is not the agent's is 404 and the bucket is never listed", async () => {
  const { src, asked } = source([batch(1, 2)], [], { agent: false });
  const r = await readTraceWindow(src, T, A, ALL);
  must(!r.ok && r.status === 404 && show(asked) === show(["local"]), show([r, asked]));
});

await check("traceKeyRange reads back exactly what traceKey wrote under that prefix, and nothing else", () => {
  const p = tracePrefix(T, A);
  must(show(traceKeyRange(p, traceKey(T, A, 12, 340))) === show({ fromSeq: 12, toSeq: 340 }), "round trip");
  for (const k of [traceKey(T, `${A}x`, 1, 2), `${p}1-2.json`, `${p}x-2.ndjson`, `${p}sub/1-2.ndjson`]) must(traceKeyRange(p, k) === null, k);
});

await check("redactCredentials walks every depth of arrays and objects, keys included, and leaves everything else as it was", () => {
  const key = "sk-" + "ant-api03-" + "k".repeat(40);
  const input = { n: 1, b: true, z: null, s: "fine", deep: [[[{ x: [{ y: key }] }]]], [`${key}`]: 2 };
  const r = redactCredentials(input);
  must(r.redactions === 2 && !show(r.value).includes(key), show(r));
  must(show(r.value) === show({ n: 1, b: true, z: null, s: "fine", deep: [[[{ x: [{ y: "<redacted:api-key>" }] }]]], "<redacted:api-key>": 2 }), show(r.value));
  must(show(input.deep) !== show((r.value as any).deep), "the input was changed in place");
  const two = redactCredentials({ [key]: 1, [key + "b"]: 2 });
  must(two.redactions === 2 && Object.keys(two.value as object).length === 2, `two keys of one kind collided: ${show(two)}`);
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
