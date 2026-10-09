/**
 * An evaluation's two read-only exports (cf/src/provision/handlers.ts, behind EVAL_SEED_ROUTES): an agent's whole
 * conversation, and its trace rows over a bounded window. Both are reads of what already exists, through the readers
 * that already exist, so neither is a second derivation that could drift from the first:
 *
 * - the transcript is `readTranscript` (cf/src/transcript-read.ts), the operator's `/admin/transcript` reader, which
 *   issues SELECTs and nothing else; this adds which main conversation (`main`, `main.<n>`, cf/src/fresh-context.ts)
 *   and a page of it;
 * - the trace is the agent's `trace_outbox` (`pendingTrace`, src/trace/outbox.ts) for rows not yet exported and
 *   pruned, and the R2 batches `flushTrace` wrote (`trace/<tenant>/<agent>/<from>-<to>.ndjson`, cf/src/trace-r2.ts)
 *   for the rest. The object is read FIRST and the bucket second: a flush between the two puts its batch before it
 *   prunes, so the bucket then holds every row the object no longer does. The other order could miss that batch.
 *
 * Whatever either returns is walked whole before it leaves (`redactCredentials`): every string, at any depth, and
 * every key, because a tool result is whatever the tool returned and nothing about its path says where a key may sit.
 * The walk runs in the agent's object (cf/src/index.ts `evalTranscript`, `evalRedact`) with the agent's own sealed
 * values (`agentSecretValues`), which are opened there and never returned; docs/agent-surface.md "Redaction" lists
 * what it catches.
 */
import { secretShape } from "./secret-shape.ts";
import { replaceSecrets } from "../../src/plugins/http.ts";
import { importKek, open } from "../../src/runtime/secrets.ts";
import { hasTable, readTranscript, type TranscriptEvents } from "./transcript-read.ts";
import { currentMainId, mainSessions } from "./fresh-context.ts";
import { pendingTrace, type TraceOutboxRow } from "../../src/trace/outbox.ts";
import { tracePrefix, traceKeyRange } from "./trace-r2.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

/** A walked value and how many replacements the walk made in it. */
export interface Redacted { value: unknown; redactions: number }

export interface RedactOptions {
  /**
   * The agent's own sealed values (`agentSecretValues`): every exact appearance of one of at least EXACT_MIN
   * characters, and of its JSON-escaped, URL-encoded and base64 forms, is replaced wherever it is.
   */
  secrets?: ReadonlyArray<string>;
}

/** The shortest sealed value scrubbed by exact match: shorter ones would match ordinary text. */
export const EXACT_MIN = 8;
/** Deeper than this a subtree is replaced whole: a walk that recursed without bound would crash the export. */
export const REDACT_MAX_DEPTH = 100;
/** The longest base64 run decoded to be checked again; a longer one is left as it is. */
export const BASE64_DECODE_MAX = 64 * 1024;

const mark = (kind: string) => `<redacted:${kind}>`;
const MARKED = /^<redacted:[^<>]*>(?:#\d+)?$/;

/**
 * A tool that handles an agent's kept secrets (`<alias>__secret_get`, `secret_put`…, src/plugins/state.ts), as a model
 * call names it, as a trace row (`state.secret_get`) and an approval (`<alias>.secret_put`) do. Any alias and any
 * plugin: a tool of another plugin with a name like that loses its arguments and result too, which is the safe side.
 */
const SECRET_TOOL = /(?:^|__|\.)secret_[A-Za-z0-9_]+$/;
/** The fields of a call to such a tool kept as they are; every string under any other field is replaced. */
const SECRET_TOOL_KEEP = new Set([
  "id", "name", "tool", "callId", "isError", "status", "at", "createdAt", "sequence", "kind", "spanId", "parentId", "verdict",
  "ms", "seq", "tenantId", "agentId", "mount", "mountAlias", "operationId", "state", "approver", "taskId", "type",
]);
/** A key whose string values are credentials whatever they look like. */
const CREDENTIAL_KEY = /token|secret|passw(?:or)?d|passphrase|authorization|api[_-]?key|credential|private[_-]?key|cookie/i;

/**
 * Credential shapes the export replaces on top of the console's (cf/src/secret-shape.ts), which stays as it is because
 * it guards what a person sends and a loose shape there refuses ordinary text. Here only the credential part of a
 * match is replaced (`(prefix)(secret)`: the second group), not the whole string, so the text around it survives. A
 * secret part never takes a `<`, so walking a walked value again replaces nothing twice.
 */
const EXPORT_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp; check?: (secret: string) => boolean }> = [
  // Three base64url segments whose first decodes to a JSON object.
  { kind: "jwt", re: /()(\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*)/g, check: (t) => jsonObject(b64decode(t.split(".")[0]!)) },
  { kind: "authorization", re: /\b((?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?:[A-Za-z][A-Za-z0-9-]*[ \t]+)?)([^\s"'<>]{8,})/gi },
  // `Bearer <token>` anywhere; a digit in it, so "Bearer authentication" in prose stays.
  { kind: "bearer", re: /\b(Bearer[ \t]+)((?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{12,})/g },
  { kind: "basic-auth", re: /\b(Basic[ \t]+)([A-Za-z0-9+/]{8,}={0,2})/g, check: (t) => (b64decode(t) ?? "").includes(":") },
  {
    kind: "signed-url",
    re: /(?<![A-Za-z0-9_-])((?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|X-Goog-Signature|X-Goog-Credential|Signature|sig|token|access_token|refresh_token|id_token|client_secret|password|passwd|api_key|apikey)=)([^&\s"'#<>]+)/gi,
  },
  { kind: "cookie", re: /\b((?:Set-)?Cookie[ \t]*:[ \t]*)([^\s<][^\r\n]*)/gi },
  // `RUN9_TOKEN=…`, `X_API_KEY=…`, `PASSWORD=…`; not `$OTHER` (a reference) and no spaces round `=` (code, not env).
  { kind: "env-secret", re: /\b((?:[A-Z][A-Z0-9_]*_)?(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|PAT|CREDENTIALS?)=["']?)([^\s"'$`<]+)/g },
  { kind: "google-api-key", re: /()(\bAIza[0-9A-Za-z_-]{30,})/g },
  { kind: "stripe-key", re: /()(\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,})/g },
  { kind: "live-key", re: /()(\b[a-z0-9]{2,8}_live_[A-Za-z0-9_-]{16,})/g },
  { kind: "github-token", re: /()(\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}))/g },
  // Shorter than the console's shapes, and the tail takes + / = as an encoded key may: half a key is still one.
  { kind: "Raft agent credential", re: /()(\bsk_agent_[A-Za-z0-9_+/=-]{8,})/g },
  { kind: "api-key", re: /()(\bsk-(?:ant-[a-z0-9]+-|proj-)?[A-Za-z0-9_+/=-]{20,})/g },
];
/** A character of a base64 or base64url run: A-Z a-z 0-9 + / _ -. */
function isB64(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 47 || c === 95 || c === 45;
}

/** Base64 or base64url text decoded as UTF-8, or null when it is not base64. */
function b64decode(text: string): string | null {
  const t = text.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (t.length % 4 === 1) return null;
  try {
    const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch { return null; }
}
function jsonObject(text: string | null): boolean {
  if (text === null) return false;
  try { const v = JSON.parse(text); return v !== null && typeof v === "object"; } catch { return false; }
}
/** Mostly printable: what decoded base64 is when it held text rather than bytes. */
function printable(text: string): boolean {
  if (!text) return false;
  let n = 0;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); if ((c >= 0x20 && c < 0x7f) || c === 9 || c === 10 || c === 13) n++; }
  return n / text.length >= 0.9;
}
/** Whether text holds any shape at all, the console's or the export's. */
function anyShape(text: string): boolean {
  if (secretShape(text) !== null) return true;
  return EXPORT_PATTERNS.some((p) => { p.re.lastIndex = 0; const m = p.re.exec(text); p.re.lastIndex = 0; return m !== null && (!p.check || p.check(m[2]!)); });
}
/** `%xx` decoded where it decodes; a malformed escape is left as it is. */
function percentDecode(text: string): string {
  try { return decodeURIComponent(text); }
  catch { return text.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => { try { return decodeURIComponent(run); } catch { return run; } }); }
}

/**
 * `value` walked whole, every string at any depth and every key, with what looks like a credential replaced by
 * `<redacted:KIND>`, and how many replacements were made. Walked, never addressed by path: a credential nested in a
 * tool's result is found where it is. In order, for each string:
 *
 * 1. each exact appearance of one of `opts.secrets` (and its escaped, encoded and base64 forms);
 * 2. a string the console would refuse (cf/src/secret-shape.ts), replaced whole;
 * 3. JSON in the string, parsed and walked, and written back when anything in it was replaced;
 * 4. `%xx`-encoded text, decoded, and kept decoded when the decoded text held a credential;
 * 5. EXPORT_PATTERNS, each match's credential part;
 * 6. base64 runs of 24 characters or more (up to BASE64_DECODE_MAX) that decode to text holding any of the above.
 *
 * And by place rather than by shape: every string under a key named like a credential (CREDENTIAL_KEY), and every
 * string in a call to or result of a kept-secret tool (SECRET_TOOL) but its name. A subtree deeper than
 * REDACT_MAX_DEPTH is replaced whole.
 */
export function redactCredentials(value: unknown, opts: RedactOptions = {}): Redacted {
  let redactions = 0;
  const exact = new Map<string, string>();
  for (const [i, v] of (opts.secrets ?? []).entries()) {
    if (typeof v !== "string" || v.length < EXACT_MIN) continue;
    const forms = [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)];
    const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(v)));
    forms.push(b64, b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"));
    for (const [j, f] of forms.entries()) if (f.length >= EXACT_MIN) exact.set(`${i}.${j}`, f);
  }

  const patterns = (text: string): string => {
    let t = text;
    for (const p of EXPORT_PATTERNS) {
      t = t.replace(p.re, (whole: string, pre: string, secret: string) => {
        if (p.check && !p.check(secret)) return whole;
        redactions++;
        return pre + mark(p.kind);
      });
    }
    // Scanned by hand: a regex over one run of megabytes overflows the engine's backtracking stack.
    const out: string[] = [];
    let last = 0;
    for (let i = 0; i < t.length;) {
      if (!isB64(t.charCodeAt(i))) { i++; continue; }
      let j = i;
      while (j < t.length && isB64(t.charCodeAt(j))) j++;
      while (j < t.length && j - i < BASE64_DECODE_MAX + 2 && t.charCodeAt(j) === 61) j++;
      const run = t.slice(i, j);
      if (run.length >= 24 && run.length <= BASE64_DECODE_MAX) {
        const d = b64decode(run);
        if (d !== null && printable(d) && anyShape(d)) {
          redactions++;
          out.push(t.slice(last, i), mark("base64-credential"));
          last = j;
        }
      }
      i = j;
    }
    return last === 0 ? t : out.join("") + t.slice(last);
  };

  const text = (s: string, depth: number): string => {
    if (MARKED.test(s)) return s;
    let t = s;
    if (exact.size) {
      const r = replaceSecrets(t, exact, EXACT_MIN, () => mark("agent-secret"));
      redactions += r.count;
      t = r.text;
    }
    const kind = secretShape(t);
    if (kind !== null) { redactions++; return mark(kind); }
    if (depth < REDACT_MAX_DEPTH && /^\s*[[{"]/.test(t)) {
      let parsed: unknown, isJson = false;
      try { parsed = JSON.parse(t); isJson = true; } catch { /* not JSON: read as text */ }
      if (isJson) {
        const before = redactions;
        const walked = walk(parsed, depth + 1, "normal");
        if (redactions > before) return JSON.stringify(walked);
      }
    }
    if (depth < REDACT_MAX_DEPTH && /%[0-9A-Fa-f]{2}/.test(t)) {
      const d = percentDecode(t);
      if (d !== t && anyShape(d)) return text(d, depth + 1);
    }
    return patterns(t);
  };

  type Mode = "normal" | "tool" | "field";
  const walk = (v: unknown, depth: number, mode: Mode): unknown => {
    if (depth > REDACT_MAX_DEPTH && v !== null && typeof v === "object") { redactions++; return mark("too-deep"); }
    if (typeof v === "string") {
      if (mode === "normal" || v === "" || MARKED.test(v)) return text(v, depth);
      redactions++;
      if (mode === "tool") return mark("kept-secret");
      // Under a credential's key: replaced whole either way, as one replacement; by the kind it looks like if it does.
      const before = redactions;
      const t = text(v, depth);
      redactions = before;
      return MARKED.test(t) ? t : mark("credential-field");
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1, mode));
    if (v === null || typeof v !== "object") return v;
    const o = v as Record<string, unknown>;
    const secretTool = mode === "normal" &&
      ((typeof o.name === "string" && SECRET_TOOL.test(o.name)) || (typeof o.tool === "string" && SECRET_TOOL.test(o.tool)));
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(o)) {
      let child: Mode = mode;
      if (mode === "normal") {
        if (secretTool && !SECRET_TOOL_KEEP.has(key)) child = "tool";
        else if (!MARKED.test(key) && CREDENTIAL_KEY.test(key)) child = "field";
      } else if (mode === "tool" && key === "name") child = "normal";
      let name = text(key, depth);
      // A key replaced, or one already spelled like a replacement, never overwrites another.
      for (let i = 2; Object.prototype.hasOwnProperty.call(out, name); i++) name = `${name.replace(/#\d+$/, "")}#${i}`;
      // Defined, not assigned: a key `__proto__` stays a key rather than becoming the object's prototype.
      Object.defineProperty(out, name, { value: walk(inner, depth + 1, child), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  return { value: walk(value, 0, "normal"), redactions };
}

/**
 * Every value this agent's object holds sealed (`secrets`: what the agent kept with `secret_put`, its mounts' sealed
 * credentials, its owner's and its hooks' secrets) and the Worker environment value any of its mounts names
 * (`env:NAME`), so the export can scrub an exact appearance of each (`redactCredentials`'s `secrets`). Read with
 * SELECTs only: nothing is touched, unlike a resolver's read. Unreadable when a sealed value cannot be opened (no key,
 * or another key): the export is then refused rather than sent without that scrub.
 */
export async function agentSecretValues(
  sql: Sql, tenantId: string, agentId: string, env: { SECRET_KEK?: string },
): Promise<{ ok: true; values: string[] } | { ok: false; message: string }> {
  const values: string[] = [];
  if (hasTable(sql as never, "secrets")) {
    const rows = sql.exec("SELECT ciphertext, iv FROM secrets WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray();
    if (rows.length) {
      if (!env.SECRET_KEK) return { ok: false, message: "the agent holds sealed values and this deployment has no key to open them, so they cannot be scrubbed from an export" };
      const kek = await importKek(env.SECRET_KEK);
      for (const r of rows) {
        try { values.push(await open(kek, { ciphertext: String(r.ciphertext), iv: String(r.iv) })); }
        catch { return { ok: false, message: "a sealed value of the agent cannot be opened, so it cannot be scrubbed from an export" }; }
      }
    }
  }
  if (hasTable(sql as never, "mounts")) {
    for (const r of sql.exec("SELECT secret_ref FROM mounts WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()) {
      const ref = typeof r.secret_ref === "string" ? r.secret_ref : "";
      const v = ref.startsWith("env:") ? (env as Record<string, unknown>)[ref.slice(4)] : undefined;
      if (typeof v === "string") values.push(v);
    }
  }
  return { ok: true, values };
}

export const TRANSCRIPT_LIMIT_DEFAULT = 500;
export const TRANSCRIPT_LIMIT_MAX = 2000;
/** The most a page's events and approvals may take serialized, after redaction; past it the page stops early. */
export const TRANSCRIPT_PAGE_BYTES = 4 * 1024 * 1024;
/** The conversations the export reads: the agent's main ones (cf/src/fresh-context.ts), and nothing else of it. */
export const MAIN_SESSION_ID = /^main(?:\.[1-9]\d*)?$/;

export interface EvalTranscript {
  agentId: string;
  /** The conversation read: `main` or `main.<n>`. */
  sessionId: string;
  current: boolean;
  total: number;
  shown: number;
  cursor: string;
  nextCursor: string | null;
  events: TranscriptEvents["events"];
  byOp: TranscriptEvents["byOp"];
  /** How many replacements `redact` made in this page. */
  redactions: number;
}

/**
 * One page of main conversation `session` (null: the current one), as `/admin/transcript` reads it, each event and the
 * approvals walked by `redact` before they are counted toward TRANSCRIPT_PAGE_BYTES. The current main conversation goes
 * to that reader as `t_<agentId>`, the console's id for it: its own id `main` reads as no conversation while it is
 * current (`sessionFor`). The cursor is an offset into the reader's list, which is in sequence order and only grows at
 * its end. The reader has no range of its own (failed runs are merged into the entries by sequence), so the whole
 * conversation is read, and only the page's events are masked and walked. A page holds at least one event when any is
 * left, however large. Null when the object holds no such agent, or the agent no such main conversation.
 */
export function evalTranscript(
  sql: Sql, tenantId: string, agentId: string, session: string | null, offset: number, limit: number,
  redact: (v: unknown) => Redacted, maxBytes = TRANSCRIPT_PAGE_BYTES,
): EvalTranscript | null {
  const current = currentMainId(sql);
  const sessionId = session ?? current;
  if (!MAIN_SESSION_ID.test(sessionId) || !mainSessions(sql).some((m) => m.sessionId === sessionId)) return null;
  const all = readTranscript(sql as never, tenantId, agentId, sessionId === current ? `t_${agentId}` : sessionId, { offset, limit });
  if (all === null) return null;
  const size = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength;
  const byOp = redact(all.byOp);
  let redactions = byOp.redactions, bytes = size(byOp.value);
  const events: TranscriptEvents["events"] = [];
  for (const e of all.events) {
    const r = redact(e);
    const n = size(r.value);
    if (events.length > 0 && bytes + n > maxBytes) break;
    events.push(r.value as TranscriptEvents["events"][number]);
    redactions += r.redactions;
    bytes += n;
  }
  const end = offset + events.length;
  return {
    agentId, sessionId, current: sessionId === current, total: all.total, shown: events.length,
    cursor: String(offset), nextCursor: end < all.total ? String(end) : null, events,
    byOp: byOp.value as TranscriptEvents["byOp"], redactions,
  };
}

/** The object's own trace rows after `afterSeq`, oldest first, at most `limit`. A table never made reads as none and is not made. */
export function localTrace(sql: Sql, tenantId: string, agentId: string, afterSeq: number, limit: number): TraceOutboxRow[] {
  if (!hasTable(sql as never, "trace_outbox")) return [];
  return pendingTrace(sql as never, afterSeq, limit).rows.filter((r) => r.tenantId === tenantId && r.agentId === agentId);
}

/** The widest window one request may ask for. */
export const TRACE_WINDOW_MAX_MS = 24 * 60 * 60_000;
export const TRACE_LIMIT_DEFAULT = 200;
export const TRACE_LIMIT_MAX = 1000;
/** The most rows read from the object, and batches from the bucket, in one request; past them the answer pages. */
export const TRACE_LOCAL_SCAN = 5000;
export const TRACE_OBJECTS_SCAN = 20;
/** Listing pages read before the request is refused rather than ordered on a partial list. */
const TRACE_LIST_PAGES = 20;
/**
 * A batch uploaded this long before the window opens holds no row in it: it was written after every row in it ended.
 * The margin is for the two clocks (the object's and the bucket's).
 */
const UPLOAD_SLACK_MS = 60 * 60_000;

export interface TraceSource {
  /** Null when the object holds no such agent. Called before the bucket is listed (see the file's header). */
  local(afterSeq: number, limit: number): Promise<TraceOutboxRow[] | null>;
  list(prefix: string, cursor: string | undefined): Promise<{ objects: Array<{ key: string; uploaded: Date }>; truncated: boolean; cursor?: string }>;
  /** The batch's body, or null when it has gone. */
  get(key: string): Promise<string | null>;
}

export interface TraceQuery { from: number; to: number; afterSeq: number; limit: number }

export type TraceWindow =
  // `redactions`: made by the object's walk (cf/src/index.ts `evalRedact`), when the rows went through it.
  | { ok: true; rows: TraceOutboxRow[]; nextCursor: string | null; scanned: { local: number; objects: number }; redactions?: number }
  | { ok: false; status: 404 | 502 | 503; message: string };

/**
 * The agent's trace rows with `from <= at < to` and `seq > afterSeq`, in seq order, at most `limit`. The scan is
 * bounded (TRACE_LOCAL_SCAN rows, TRACE_OBJECTS_SCAN batches): a page that stopped at a bound, or at `limit`, says
 * where to go on in `nextCursor` (a seq), and may hold fewer than `limit` rows, none even; null means nothing is left.
 */
export async function readTraceWindow(src: TraceSource, tenantId: string, agentId: string, q: TraceQuery): Promise<TraceWindow> {
  const local = await src.local(q.afterSeq, TRACE_LOCAL_SCAN);
  if (local === null) return { ok: false, status: 404, message: `no agent ${agentId}` };
  const prefix = tracePrefix(tenantId, agentId);
  const batches: Array<{ key: string; fromSeq: number; toSeq: number; uploaded: number }> = [];
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page === TRACE_LIST_PAGES) return { ok: false, status: 502, message: `more than ${TRACE_LIST_PAGES} pages of trace batches for ${agentId}` };
    const listed = await src.list(prefix, cursor);
    for (const o of listed.objects) {
      const range = traceKeyRange(prefix, o.key);
      if (range) batches.push({ key: o.key, ...range, uploaded: new Date(o.uploaded).getTime() });
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  }
  // Keys sort as text ("10-…" before "9-…"); the seq range is the order.
  const due = batches.filter((b) => b.toSeq > q.afterSeq && !(b.uploaded < q.from - UPLOAD_SLACK_MS)).sort((a, b) => a.fromSeq - b.fromSeq);
  const bySeq = new Map<number, TraceOutboxRow>();
  // Past this seq nothing has been looked at yet: rows beyond it wait for the next page, so none is skipped.
  let frontier = local.length === TRACE_LOCAL_SCAN ? local[local.length - 1]!.seq : Infinity;
  let objects = 0;
  let inWindow = 0;
  // The highest seq a batch read so far covers; a stop is never placed below it, so a page always moves on.
  let readThrough = q.afterSeq;
  for (const b of due) {
    if (objects === TRACE_OBJECTS_SCAN || inWindow >= q.limit) { frontier = Math.min(frontier, Math.max(b.fromSeq - 1, readThrough)); break; }
    const body = await src.get(b.key);
    objects++;
    readThrough = Math.max(readThrough, b.toSeq);
    if (body === null) continue;
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as TraceOutboxRow;
      if (row.tenantId !== tenantId || row.agentId !== agentId || !(row.seq > q.afterSeq)) continue;
      if (!bySeq.has(row.seq) && row.at >= q.from && row.at < q.to) inWindow++;
      bySeq.set(row.seq, row);
    }
  }
  for (const row of local) if (!bySeq.has(row.seq)) bySeq.set(row.seq, row);
  const ordered = [...bySeq.values()].filter((r) => r.seq <= frontier).sort((a, b) => a.seq - b.seq);
  const rows = ordered.filter((r) => r.at >= q.from && r.at < q.to).slice(0, q.limit);
  const nextCursor = rows.length === q.limit ? String(rows[rows.length - 1]!.seq)
    : Number.isFinite(frontier) ? String(frontier) : null;
  return { ok: true, rows, nextCursor, scanned: { local: local.length, objects } };
}
