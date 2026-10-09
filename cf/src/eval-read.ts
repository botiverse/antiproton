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
 * values and the operator credentials its mounts name (`agentSecretValues`), which are opened there and never returned; docs/agent-surface.md "Redaction" lists
 * what it catches.
 */
import { secretShape } from "./secret-shape.ts";
import { importKek, open, secretRefKind } from "../../src/runtime/secrets.ts";
import { operatorCredentials, resolveOperatorRef } from "./operator-ref.ts";
import { hasTable, readTranscript, type TranscriptEvents } from "./transcript-read.ts";
import { currentMainId, mainSessions } from "./fresh-context.ts";
import { pendingTrace, type TraceOutboxRow } from "../../src/trace/outbox.ts";
import { tracePrefix, traceKeyRange } from "./trace-r2.ts";

type Sql = { exec(query: string, ...bindings: unknown[]): { toArray(): any[] } };

/** A walked value and how many replacements the walk made in it. */
export interface Redacted { value: unknown; redactions: number }

export interface RedactOptions {
  /**
   * The values this agent's mounts and tools can be handed (`agentSecretValues`): every appearance of one of at least
   * EXACT_MIN characters, in any spelling `secretForms` lists, is replaced wherever it is; so is a %-encoded or base64
   * run that decodes to text holding one.
   */
  secrets?: ReadonlyArray<string>;
}

/** The shortest sealed value scrubbed by exact match: shorter ones would match ordinary text. */
export const EXACT_MIN = 8;
/** The shortest sealed value matched in any letter case: a shorter one in another case is too likely an ordinary word. */
export const EXACT_ANY_CASE_MIN = 16;
/** How many times a %-encoded run is decoded, looking for a sealed value under encodings stacked that deep. */
export const PERCENT_ROUNDS = 3;
/** Deeper than this a subtree is replaced whole: a walk that recursed without bound would crash the export. */
export const REDACT_MAX_DEPTH = 100;
/** The longest base64 or %-encoded run decoded to be checked again; a longer one is left as it is. */
export const BASE64_DECODE_MAX = 64 * 1024;

const mark = (kind: string) => `<redacted:${kind}>`;
const MARKED = /^<redacted:[^<>]*>(?:#\d+)?$/;

/**
 * A tool that handles an agent's kept secrets (`<alias>__secret_get`, `secret_put`…, src/plugins/state.ts), as a model
 * call names it (`name`, or pi's `toolName` on a tool result), as a trace row (`state.secret_get`) and an approval
 * (`<alias>.secret_put`) do (`tool`). Any alias and any
 * plugin: a tool of another plugin with a name like that loses its arguments and result too, which is the safe side.
 */
const SECRET_TOOL = /(?:^|__|\.)secret_[A-Za-z0-9_]+$/;
/**
 * A call's fields that name the tool and say where and when it ran (ids, names, times, outcomes; a trace row's `task`,
 * src/trace/seams.ts; pi's `toolName` and `toolCallId`): walked as any other text is, where every string under any
 * other field of such a call is replaced whole.
 */
const SECRET_TOOL_KEEP = new Set([
  "id", "name", "tool", "toolName", "callId", "toolCallId", "isError", "status", "at", "createdAt", "timestamp", "sequence",
  "kind", "role", "spanId", "parentId", "verdict", "ms", "seq", "tenantId", "agentId", "task", "taskId", "sessionId",
  "contextId", "messageId", "jobId", "mount", "mountAlias", "alias", "plugin", "operationId", "state", "approver", "type",
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
 * `run` %-decoded up to PERCENT_ROUNDS times, each round both as a URL encodes (`+` is `+`) and as a form does
 * (`+` is a space): every text a decoder along the way could have read. Empty when there is nothing to decode.
 */
function percentDecodings(run: string): string[] {
  if (!/%[0-9A-Fa-f]{2}|\+/.test(run)) return [];
  const seen = new Set<string>([run]);
  let frontier = [run];
  for (let round = 0; round < PERCENT_ROUNDS && frontier.length; round++) {
    const next: string[] = [];
    for (const t of frontier) {
      for (const d of [percentDecode(t), percentDecode(t.replace(/\+/g, " "))]) if (!seen.has(d)) { seen.add(d); next.push(d); }
    }
    frontier = next;
  }
  seen.delete(run);
  return [...seen];
}

const utf8 = (v: string) => new TextEncoder().encode(v);
function base64Of(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
const base64url = (b64: string) => b64.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
/** `encodeURIComponent` with `!'()*` escaped too, as RFC 3986 strict encoders do. */
const strictUriEncode = (v: string) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
/** As an HTML form or `URLSearchParams` encodes a value: a space is `+`. */
const formEncode = (v: string) => new URLSearchParams([["", v]]).toString().slice(1);
const htmlEscape = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
/** Every UTF-16 unit as `\uXXXX`, the way an ASCII-only JSON writer spells text. */
const unicodeEscape = (v: string) => Array.from({ length: v.length }, (_, i) => "\\u" + v.charCodeAt(i).toString(16).padStart(4, "0")).join("");

/**
 * The spellings of sealed value `v` an export is scrubbed of, each with whether it is matched in any letter case: `v`
 * itself, JSON-escaped once and twice, `\uXXXX`-escaped, HTML-escaped; URL-encoded as `encodeURIComponent`, a strict
 * encoder, a form and `encodeURI` do, and each of the first three encoded again; base64 and base64url, whole and at each
 * of the three alignments the value can have inside a longer run (the characters encoding its bytes alone); and hex.
 * Any case for a value of EXACT_ANY_CASE_MIN or more, and always for hex and `\uXXXX`, whose letters are digits.
 */
export function secretForms(v: string): Array<{ text: string; anyCase: boolean }> {
  const anyCase = v.length >= EXACT_ANY_CASE_MIN;
  const json = JSON.stringify(v).slice(1, -1);
  const bytes = utf8(v);
  const texts = [
    v, json, JSON.stringify(json).slice(1, -1), htmlEscape(v),
    encodeURIComponent(v), strictUriEncode(v), formEncode(v), encodeURI(v),
    encodeURIComponent(encodeURIComponent(v)), encodeURIComponent(strictUriEncode(v)), encodeURIComponent(formEncode(v)),
  ];
  const whole = base64Of(bytes);
  texts.push(whole, base64url(whole));
  for (let k = 0; k < 3; k++) {
    const padded = new Uint8Array(k + bytes.length);
    padded.set(bytes, k);
    // A group of four characters encodes three bytes: the first holds the k bytes before the value when k > 0, and
    // the last holds the bytes after it unless the value ends a group. Only the groups between are the value's alone.
    const core = base64Of(padded).slice(k === 0 ? 0 : 4, Math.floor((k + bytes.length) / 3) * 4);
    texts.push(core, base64url(core));
  }
  const forms = new Map<string, boolean>();
  const add = (text: string, ci: boolean) => { if (text.length >= EXACT_MIN) forms.set(text, (forms.get(text) ?? true) && ci); };
  for (const t of texts) add(t, anyCase);
  add(Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""), true);
  add(unicodeEscape(v), true);
  return [...forms].map(([text, ci]) => ({ text, anyCase: ci }));
}

/** Alternatives per compiled pattern: a few thousand literals compile and scan quickly; far more stops paying. */
const EXACT_CHUNK = 1000;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/**
 * Every form of every value in `secrets` (`secretForms`), as patterns made once for a whole walk: the any-case forms,
 * then the exact-case ones, each list longest first, so a form that holds another is replaced before the shorter one
 * could split it. Null when no value is long enough to be scrubbed.
 */
function exactPatterns(secrets: ReadonlyArray<string>): RegExp[] | null {
  const anyCase = new Set<string>(), exactCase = new Set<string>();
  for (const v of secrets) {
    if (typeof v !== "string" || v.length < EXACT_MIN) continue;
    for (const f of secretForms(v)) (f.anyCase ? anyCase : exactCase).add(f.text);
  }
  const res: RegExp[] = [];
  for (const [set, flags] of [[anyCase, "gi"], [exactCase, "g"]] as const) {
    const sorted = [...set].sort((a, b) => b.length - a.length);
    for (let i = 0; i < sorted.length; i += EXACT_CHUNK) res.push(new RegExp(sorted.slice(i, i + EXACT_CHUNK).map(escapeRe).join("|"), flags));
  }
  return res.length ? res : null;
}

/** Each run of base64 characters in `text` (24 or more, at most BASE64_DECODE_MAX) given to `swap`; a string back replaces it. */
function eachBase64Run(text: string, swap: (run: string) => string | null): string {
  // Scanned by hand: a regex over one run of megabytes overflows the engine's backtracking stack.
  const out: string[] = [];
  let last = 0;
  for (let i = 0; i < text.length;) {
    if (!isB64(text.charCodeAt(i))) { i++; continue; }
    let j = i;
    while (j < text.length && isB64(text.charCodeAt(j))) j++;
    while (j < text.length && j - i < BASE64_DECODE_MAX + 2 && text.charCodeAt(j) === 61) j++;
    const run = text.slice(i, j);
    if (run.length >= 24 && run.length <= BASE64_DECODE_MAX) {
      const r = swap(run);
      if (r !== null) { out.push(text.slice(last, i), r); last = j; }
    }
    i = j;
  }
  return last === 0 ? text : out.join("") + text.slice(last);
}

/** A character that ends a %-encoded run: whitespace, a quote, an angle bracket. */
const RUN_END = /[\s"'`<>]/;
/** Each run between RUN_END characters holding a `%xx` escape given to `swap`; a string back replaces it. */
function eachPercentRun(text: string, swap: (run: string) => string | null): string {
  const out: string[] = [];
  let last = 0, from = 0;
  for (;;) {
    const p = text.indexOf("%", from);
    if (p < 0) break;
    let i = p, j = p + 1;
    while (i > from && !RUN_END.test(text[i - 1]!)) i--;
    while (j < text.length && !RUN_END.test(text[j]!)) j++;
    from = j;
    const run = text.slice(i, j);
    if (run.length > BASE64_DECODE_MAX || !/%[0-9A-Fa-f]{2}/.test(run)) continue;
    const r = swap(run);
    if (r !== null) { out.push(text.slice(last, i), r); last = j; }
  }
  return last === 0 ? text : out.join("") + text.slice(last);
}

/**
 * `value` walked whole, every string at any depth and every key, with what looks like a credential replaced by
 * `<redacted:KIND>`, and how many replacements were made. Walked, never addressed by path: a credential nested in a
 * tool's result is found where it is. In order, for each string:
 *
 * 1. with `opts.secrets`, a base64 run or a %-encoded run whose decoded text holds one of them, replaced whole
 *    (`holdsSecret`);
 * 2. each appearance of one of `opts.secrets` in any of its forms (`secretForms`);
 * 3. a string the console would refuse (cf/src/secret-shape.ts), replaced whole;
 * 4. JSON in the string, parsed and walked, and written back when anything in it was replaced;
 * 5. `%xx`-encoded text, decoded (up to PERCENT_ROUNDS times), and kept decoded when the decoded text held a credential;
 * 6. EXPORT_PATTERNS, each match's credential part;
 * 7. base64 runs of 24 characters or more (up to BASE64_DECODE_MAX) that decode to text holding any of the above.
 *
 * And by place rather than by shape: every string under a key named like a credential (CREDENTIAL_KEY), and every
 * string in a call to or result of a kept-secret tool (SECRET_TOOL) but its name. A subtree deeper than
 * REDACT_MAX_DEPTH is replaced whole.
 */
export function redactCredentials(value: unknown, opts: RedactOptions = {}): Redacted {
  return credentialRedactor(opts)(value);
}

/**
 * `redactCredentials` with `opts` prepared once, for many walks: the forms of every sealed value are made and sorted
 * here, not for each string or each walk. A page of a transcript walks each event on its own.
 */
export function credentialRedactor(opts: RedactOptions = {}): (value: unknown) => Redacted {
  const exact = exactPatterns(opts.secrets ?? []);
  return (value) => walkRedacting(value, exact);
}

function walkRedacting(value: unknown, exact: RegExp[] | null): Redacted {
  let redactions = 0;

  const holds = (t: string): boolean => exact!.some((re) => { re.lastIndex = 0; const hit = re.test(t); re.lastIndex = 0; return hit; });
  /** Whether text decoded from a run holds a sealed value, as it is or %-decoded (a form encodes it again). */
  const holdsSecret = (decoded: string): boolean => holds(decoded) || percentDecodings(decoded).some(holds);
  const scrubExact = (s: string): string => {
    let t = s;
    for (const re of exact!) t = t.replace(re, () => { redactions++; return mark("agent-secret"); });
    return t;
  };
  /** A %-encoded run decoding to a sealed value: the `&`/`?`/`=`-separated parts that do, or else the whole run. */
  const percentRun = (run: string): string | null => {
    if (!percentDecodings(run).some(holds)) return null;
    let hit = false;
    const parts = run.split(/([&?=])/).map((p, i) => {
      if (i % 2 === 1 || !percentDecodings(p).some(holds)) return p;
      hit = true;
      redactions++;
      return mark("agent-secret");
    });
    if (hit) return parts.join("");
    redactions++;
    return mark("agent-secret");
  };
  /** A base64 run whose decoded text, from any of its first four characters, holds a sealed value. */
  const base64Run = (run: string): string | null => {
    const body = run.replace(/=+$/, "");
    for (let k = 0; k < 4; k++) {
      let t = body.slice(k);
      if (t.length % 4 === 1) t = t.slice(0, -1);
      const d = b64decode(t);
      if (d !== null && holdsSecret(d)) { redactions++; return mark("agent-secret"); }
    }
    return null;
  };

  const patterns = (text: string): string => {
    let t = text;
    for (const p of EXPORT_PATTERNS) {
      t = t.replace(p.re, (whole: string, pre: string, secret: string) => {
        if (p.check && !p.check(secret)) return whole;
        redactions++;
        return pre + mark(p.kind);
      });
    }
    return eachBase64Run(t, (run) => {
      const d = b64decode(run);
      if (d === null || !printable(d) || !anyShape(d)) return null;
      redactions++;
      return mark("base64-credential");
    });
  };

  const text = (s: string, depth: number): string => {
    if (MARKED.test(s)) return s;
    let t = s;
    if (exact) {
      // The encoded runs first: a run is replaced whole, where a form found inside it first would leave the rest.
      t = eachBase64Run(t, base64Run);
      if (t.includes("%")) t = eachPercentRun(t, percentRun);
      t = scrubExact(t);
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
      const d = percentDecodings(t).find(anyShape);
      if (d !== undefined) return text(d, depth + 1);
    }
    return patterns(t);
  };

  const secretTool = (o: Record<string, unknown>) =>
    [o.name, o.tool, o.toolName].some((n) => typeof n === "string" && SECRET_TOOL.test(n));
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
    const isSecretTool = mode === "normal" && secretTool(o);
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(o)) {
      let child: Mode = mode;
      if (mode === "normal") {
        if (isSecretTool && !SECRET_TOOL_KEEP.has(key)) child = "tool";
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
 * credentials, its owner's and its hooks' secrets), the Worker environment value any of its mounts names (`env:NAME`),
 * and the operator's credential any of its mounts names (`operator:exa`, `operator:run9`…), resolved as the runtime
 * resolves it for the plugin's call (`resolveOperatorRef`), so the export can scrub an exact appearance of each
 * (`redactCredentials`'s `secrets`). A value that is a JSON object (the run9 account) adds each string in it too. Read
 * with SELECTs only: nothing is touched, unlike a resolver's read. Unreadable when a sealed value cannot be opened (no
 * key, or another key), or an operator credential a mount names cannot be read: the export is then refused rather
 * than sent without that scrub.
 */
export async function agentSecretValues(
  sql: Sql, tenantId: string, agentId: string, env: { SECRET_KEK?: string; RUN9?: string; EXA_API_KEY?: string },
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
    const envValue = (ref: string) => {
      const v = (env as Record<string, unknown>)[ref.replace(/^env:/, "")];
      return Promise.resolve(typeof v === "string" ? v : null);
    };
    for (const r of sql.exec("SELECT DISTINCT secret_ref FROM mounts WHERE tenant_id=? AND agent_id=?", tenantId, agentId).toArray()) {
      const ref = typeof r.secret_ref === "string" ? r.secret_ref : "";
      let v: string | null = null;
      if (ref.startsWith("env:")) v = await envValue(ref);
      else if (secretRefKind(ref) === "operator") {
        try { v = await resolveOperatorRef(ref, operatorCredentials(env), envValue); }
        catch { return { ok: false, message: `the operator credential a mount names (${ref}) cannot be read, so it cannot be scrubbed from an export` }; }
      }
      if (v === null) continue;
      values.push(v);
      try { const o = JSON.parse(v); if (o && typeof o === "object") for (const x of Object.values(o)) if (typeof x === "string") values.push(x); }
      catch { /* not JSON: the value alone */ }
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
