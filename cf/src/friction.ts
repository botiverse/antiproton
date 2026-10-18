/**
 * Where hosted agents get stuck: the classifier the daily friction scan (cf/src/friction-scan.ts) runs over one
 * conversation's events, as /admin/transcript shapes them (cf/src/transcript-read.ts). Pure functions only, so every
 * rule is testable from a synthetic transcript (test/friction-classify.ts).
 *
 * The rules were calibrated by hand on two real days of hosted traffic, 2026-10-17 and 2026-10-18: an agent sent a
 * 1449×2048 px JPEG, `attachments_view` refused it, and the agent spent three minutes probing the sandbox, reading
 * the bytes as U+FFFD text and guessing raft.build endpoints before saying it could not see the image; the day before,
 * a `gh` mount whose credential GitHub refused sent another agent and its subagent to raw `web__get` mirrors. The trace
 * export alone cannot see most of that: the read of the JPEG and the 401/404s from web__get all "succeeded". Content
 * has to be read, which is why this runs over the transcript and not over the R2 rows.
 *
 * Two kinds of noise the calibration left, and what is done about each here:
 * - descriptive sentences ("it has my read-only tools but cannot see this conversation") matched inability text. Such
 *   a phrase now counts only in the turn's final words or shortly after a hard failure, and a Chinese one only with
 *   我 in the same clause.
 * - polling a job or an event stream looked like a repeated call. Polling tools are left out of `repeated_call`, and
 *   a call's arguments are normalised value by value, so two different shell commands are no longer "the same call".
 *
 * Nothing here keeps content. A signal carries a templated key (ids, quotes, paths, urls but their host, numbers out)
 * and an evidence line that is either a template or a short redacted excerpt of the agent's OWN text or command.
 * User messages are never read, and a tool's raw output is never excerpted.
 */

export interface FrictionEvent { sequence: number; kind: string; payload: any; createdAt: number }

export type FrictionClass =
  | "tool_error" | "auth_failure" | "guessed_endpoint_404" | "binary_as_text" | "env_probe" | "inability_text"
  | "repeated_call" | "repeated_failure" | "model_failed" | "model_stop_abnormal";

export interface Signal {
  cls: FrictionClass;
  /** What signals group on: id-free, so it is the same across agents and days. */
  key: string;
  at: number;
  seq: number;
  conv: string;
  /** A template, a count, or a redacted excerpt of the agent's own words; never user text or raw tool output. */
  evidence: string;
  tool?: string;
}

export interface Episode {
  conv: string; from: number; to: number;
  /** The first hard failure: what a fix targets. The rest of the episode is the agent looking for a way around it. */
  root: { cls: FrictionClass; key: string };
  classes: FrictionClass[];
  seqs: number[];
  evidence: string[];
}

/** Failures that something outside the agent did to it; the root of an episode is the first of these. */
export const HARD: readonly FrictionClass[] = ["tool_error", "auth_failure", "binary_as_text", "model_failed", "guessed_endpoint_404"];

/** How much one occurrence of a class says about a product problem; distinct agents multiply it (`score`). */
export const WEIGHT: Record<FrictionClass, number> = {
  auth_failure: 5, binary_as_text: 5, inability_text: 4, tool_error: 3, guessed_endpoint_404: 3, model_failed: 3,
  repeated_failure: 3, env_probe: 2, model_stop_abnormal: 2, repeated_call: 1,
};

const WINDOW_MS = 600_000;

// ---------- redaction and normalisation ----------

const TOKEN_SHAPES = /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}|rmc\.[A-Za-z0-9._-]{10,})/g;
const KEY_VALUE = /(bearer|token|secret|password|passwd|api[_-]?key|authorization|cookie|x-harness-token)(["'\s:=]+)[^\s"',;]{6,}/gi;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@"']+@/gi;
const URL_QUERY = /(\b[a-z][a-z0-9+.-]*:\/\/[^\s?"'#]+)\?[^\s"'#]*/gi;
const BLOB = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

/** Credential shapes out of a string the agent wrote: token shapes, `key=value` secrets, url userinfo and queries, long opaque blobs. */
export function redact(s: unknown): string {
  return String(s ?? "")
    .replace(/__AP_[A-Za-z0-9_]+/g, "<placeholder>")
    .replace(TOKEN_SHAPES, "<secret>")
    .replace(KEY_VALUE, (_m, k: string, sep: string) => `${k}${sep}<redacted>`)
    .replace(URL_CREDENTIALS, "$1<cred>@")
    .replace(URL_QUERY, "$1?<query>")
    .replace(BLOB, "<blob>");
}

/** A short excerpt of the agent's own words: whitespace folded, redacted, capped. */
export function excerpt(s: unknown, n = 140): string {
  const t = redact(String(s ?? "").replace(/\s+/g, " ").trim());
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/**
 * An error message as a template: ids, quoted strings, paths, urls (their host kept), emails and numbers out, so the
 * same failure groups across agents and days, and the key carries none of what the agent was working on.
 */
export function template(msg: unknown): string {
  return String(msg ?? "")
    .replace(/^[a-z0-9_]+__[a-z0-9_]+:\s*/i, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b(op|mj|call|sub|rb|t)_[A-Za-z0-9_]+/g, "<$1_id>")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/https?:\/\/([^/\s"'`)<>]+)[^\s"'`)<>]*/g, (_m, h: string) => `<url:${h.replace(/^[^@]*@/, "").toLowerCase()}>`)
    .replace(/artifact:\/\/[^\s"'`)]+/g, "<artifact-ref>")
    .replace(/"[^"]{1,80}"|“[^”]{1,80}”|‘[^’]{1,80}’|`[^`]{1,80}`/g, "<q>")
    // A single-quoted string only where a quote can open one, so the apostrophe in "mount's" is left alone.
    .replace(/(^|[\s(=:,\[])'[^'\n]{1,80}'(?=$|[\s),.;:\]])/g, "$1<q>")
    .replace(/(^|[\s(=:,])(~|\.{1,2})?(\/[\w.@%+-]+)+\/?/g, "$1<path>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\b\d+(\.\d+)?\s*(ms|s|px|bytes|KB|MB|MiB|KiB|GB)?\b/g, (_m, _a, u?: string) => "<n>" + (u ?? ""))
    // Long enough for the longest product message whole (the background-job limit lists every running job), so a
    // known message is never cut where the public allowlist (cf/src/friction-scan.ts `KNOWN_TEMPLATES`) must match it.
    .replace(/\s+/g, " ").trim().slice(0, TEMPLATE_MAX);
}
export const TEMPLATE_MAX = 400;

export const OWN_HOSTS = /(^|\.)(raft\.build|antiproton\.ai|botiverse\.dev|workers\.dev)$/;
const hostOf = (u: unknown): string => { try { return new URL(String(u)).host.toLowerCase(); } catch { return "?"; } };

/** A call's arguments with each string value templated: the shape of the call, not its content. */
function normArgs(args: unknown): string {
  return JSON.stringify(args ?? {}, (_k, v) => typeof v === "string" ? template(v) : v) ?? "{}";
}

// ---------- detectors ----------

const INABILITY_EN: readonly RegExp[] = [
  /\bI (can(no|')t|am unable to|was unable to|couldn't|could not)\b/i, /\bunable to\b/i, /\bno way to\b/i,
  /\bnot (possible|able) to\b/i, /\bblocked (on|by)\b/i, /\bstuck\b/i, /\bdon't have (access|a way|permission)\b/i,
];
export const INABILITY_ZH: readonly string[] = ["做不到", "卡在", "卡住", "拿不到", "无法", "没办法", "看不到", "进不了", "没有权限", "不支持", "失败了"];
const CLAUSE_END = /[，。；！？,.;!?\n]/;

/** An inability phrase in the agent's text, or null. A Chinese one needs 我 earlier in the SAME clause. */
export function inabilityPhrase(text: string): { phrase: string; index: number } | null {
  for (const re of INABILITY_EN) {
    const m = re.exec(text);
    if (m) return { phrase: m[0].toLowerCase(), index: m.index };
  }
  for (const p of INABILITY_ZH) {
    for (let i = text.indexOf(p); i >= 0; i = text.indexOf(p, i + 1)) {
      const before = text.slice(Math.max(0, i - 20), i);
      const clause = before.split(CLAUSE_END).at(-1) ?? "";
      if (clause.includes("我")) return { phrase: p, index: i };
    }
  }
  return null;
}

const PROBE: ReadonlyArray<[RegExp, string]> = [
  [/(^|[;&|]\s*)ls\s+(-\w+\s+)*\/(\s|$|;|mnt|media|opt|srv|run|var)/, "ls system path"],
  [/\bfind\s+\/(\s|$)/, "find /"],
  [/\bfind\s+\/(mnt|media|opt|srv|run|var|etc|home|root)\b/, "find system path"],
  [/(^|[;&|]\s*)(which|command -v)\s+[\w-]+/, "which <bin>"],
  [/\benv\b\s*\|\s*(grep|sort)|\bprintenv\b/, "env dump/grep"],
  [/\b(mount|df -h|lsblk)\b/, "mount/df"],
  [/\bcurl\b[^|;]*(raft\.build|antiproton\.ai|botiverse)/, "curl own API"],
  [/\bcat\s+\/(proc|etc)\//, "cat /proc|/etc"],
];

/** Tools that are polled by design: calling one again is waiting, not being stuck. */
export const POLLING_TOOL = /(^|__)(jobs?|job_status|jobs_\w+|status|\w+_status|receive_events|events|wait\w*|poll\w*|sleep)$/i;
const MESSAGE_TOOL = /(^|__)(messages_send|send_message|reply)$/;
const SHELL_TOOL = /(^|__)shell$|sandbox__shell/;
const WEB_TOOL = /web__get|(^|__)http/;

const FFFD = /�/g;
const MAGIC = /^[\s\S]{0,12}(JFIF|Exif\u0000|�PNG|PNG\r\n|GIF8[79]a|%PDF-|PK\u0003\u0004)/;
const BINARY_NAME = /\.(jpe?g|png|gif|webp|pdf|zip|gz|tar|mp[34]|mov|wasm|bin)$/i;

function resultText(p: any): string {
  const r = p?.result ?? p?.error ?? "";
  return typeof r === "string" ? r : JSON.stringify(r) ?? "";
}

/** Every friction signal in one conversation's events, oldest first. */
export function scanConversation(conv: string, events: readonly FrictionEvent[]): Signal[] {
  const sig: Signal[] = [];
  const calls = new Map<string, { name: string; args: any }>();
  const recent: Array<{ norm: string; at: number; seq: number; name: string }> = [];
  let lastHardAt = -Infinity;
  const add = (cls: FrictionClass, key: string, e: FrictionEvent, evidence: string, tool?: string) => {
    sig.push({ cls, key, at: e.createdAt, seq: e.sequence, conv, evidence, ...(tool ? { tool } : {}) });
    if (HARD.includes(cls)) lastHardAt = e.createdAt;
  };
  for (const e of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const p = e.payload ?? {};
    if (e.kind === "model.response") {
      const toolCalls: any[] = Array.isArray(p.toolCalls) ? p.toolCalls : [];
      for (const c of toolCalls) {
        const name = String(c?.name ?? "?");
        calls.set(String(c?.id), { name, args: c?.arguments });
        if (!POLLING_TOOL.test(name) && !MESSAGE_TOOL.test(name)) {
          recent.push({ norm: `${name} ${normArgs(c?.arguments)}`, at: e.createdAt, seq: e.sequence, name });
        }
        if (SHELL_TOOL.test(name)) {
          const cmd = String(c?.arguments?.command ?? "");
          const hits = PROBE.filter(([re]) => re.test(cmd)).map(([, n]) => n);
          if (hits.length) add("env_probe", hits.sort().join("+"), e, "cmd: " + excerpt(cmd, 110), name);
        }
        if (WEB_TOOL.test(name) && c?.arguments?.url) {
          const h = hostOf(c.arguments.url);
          if (OWN_HOSTS.test(h)) add("env_probe", "raw HTTP to own API " + h, e, `${String(c.arguments.method ?? "GET").slice(0, 8)} ${template(c.arguments.url)}`, name);
        }
      }
      // The agent's own words: its text, and what it sent as a message. Its reasoning is left out.
      const sent = toolCalls.filter((c) => MESSAGE_TOOL.test(String(c?.name))).map((c) => c?.arguments?.content ?? c?.arguments?.text);
      const text = [p.text, ...sent].filter((t) => typeof t === "string" && t).join("\n");
      const found = text ? inabilityPhrase(text) : null;
      if (found) {
        // Counted where it says something about this turn: as its last words, or soon after something failed.
        const final = toolCalls.every((c) => MESSAGE_TOOL.test(String(c?.name)));
        if (final || e.createdAt - lastHardAt <= WINDOW_MS) {
          const i = Math.max(0, found.index - 50);
          add("inability_text", found.phrase, e, "agent: " + excerpt(text.slice(i, i + 160), 140));
        }
      }
      if (p.finishReason && !["toolUse", "stop"].includes(p.finishReason)) {
        add("model_stop_abnormal", String(p.finishReason).slice(0, 40), e, "finishReason=" + String(p.finishReason).slice(0, 40));
      }
    } else if (e.kind === "model.failed") {
      const t = template(p.error ?? p.message ?? "model.failed");
      add("model_failed", t, e, "err: " + t);
    } else if (e.kind === "tool.result") {
      const call = calls.get(String(p.callId));
      const tool = String(p.tool || call?.name || "?");
      const txt = resultText(p);
      const failed = !!p.isError || /^(rejected|failed|error|cancelled|timeout)/.test(String(p.status ?? ""));
      const mount = tool.split("__")[0]!;
      if (failed) add("tool_error", `${mount}: ${template(txt)}`, e, "err: " + template(txt), tool);
      const obj = typeof p.result === "object" && p.result ? p.result : null;
      const st = obj ? Number(obj.status) : NaN;
      if (st === 401 || st === 403) add("auth_failure", `HTTP ${st} ${hostOf(obj!.url)}`, e, `HTTP ${st} ${template(obj!.url)}`, tool);
      else if (st === 404 && obj?.url && OWN_HOSTS.test(hostOf(obj.url))) add("guessed_endpoint_404", `${tool} 404 ${hostOf(obj.url)}`, e, `HTTP 404 ${template(obj.url)}`, tool);
      // Auth wording inside a tool's own error, never inside shell output: a grep of source code printed
      // `status: 401` in calibration and was a false positive.
      if (failed && !SHELL_TOOL.test(tool) && /\b(401|403)\b|unauthori[sz]ed|forbidden|bad credentials|permission denied/i.test(txt)) {
        const code = (txt.match(/\b(401|403)\b/) ?? [])[0] ?? "auth";
        add("auth_failure", `${mount} mount ${code} ${template(txt).slice(0, 60)}`, e, "err: " + template(txt), tool);
      }
      const nF = (txt.match(FFFD) ?? []).length;
      const ref = String(call?.args?.ref ?? call?.args?.path ?? "");
      const binName = BINARY_NAME.test(ref);
      const head = String(obj?.text ?? txt).slice(0, 80);
      // Three ways in, each one calibration needed: a dense run of U+FFFD; a few U+FFFD after a binary magic (a
      // `limit` kept the JPEG's text short, so density alone missed it); a binary-named ref that came back as text.
      if ((nF >= 3 && nF / Math.max(1, txt.length) > 0.01) || (nF >= 1 && (binName || MAGIC.test(head))) || (binName && obj?.kind === "text")) {
        const mm = head.match(MAGIC);
        const magic = mm ? ` (binary magic: ${mm[1]!.replace(/[^\x20-\x7e]/g, "")})` : "";
        add("binary_as_text", `${tool} kind=${obj?.kind ?? "?"}`, e, `${nF}×U+FFFD in ${txt.length} chars${magic}`, tool);
      }
    }
  }
  // The same tool with the same shape of arguments, 3 or more times within 10 minutes.
  const groups = new Map<string, typeof recent>();
  for (const r of recent) groups.set(r.norm, [...(groups.get(r.norm) ?? []), r]);
  for (const [norm, g] of groups) {
    for (let i = 0; i + 2 < g.length; i++) {
      if (g[i + 2]!.at - g[i]!.at < WINDOW_MS) {
        sig.push({ cls: "repeated_call", key: g[0]!.name, at: g[i]!.at, seq: g[i]!.seq, conv, evidence: `${g.length}× ${excerpt(norm, 100)}`, tool: g[0]!.name });
        break;
      }
    }
  }
  // The same tool failing 3 or more times within 10 minutes, whatever it was asked.
  const errs = new Map<string, Signal[]>();
  for (const s of sig) if (s.cls === "tool_error") errs.set(s.tool!, [...(errs.get(s.tool!) ?? []), s]);
  for (const [tool, g] of errs) {
    for (let i = 0; i + 2 < g.length; i++) {
      if (g[i + 2]!.at - g[i]!.at < WINDOW_MS) {
        sig.push({ cls: "repeated_failure", key: tool, at: g[i]!.at, seq: g[i]!.seq, conv, evidence: `${g.length} errors on ${tool}`, tool });
        break;
      }
    }
  }
  return sig.sort((a, b) => a.at - b.at || a.seq - b.seq);
}

/**
 * Stuck episodes in one conversation's signals: signals less than 10 minutes apart form a cluster, and a cluster is
 * an episode when it has 3 or more distinct classes AND either inability text or 3 or more hard failures.
 */
export function episodes(signals: readonly Signal[]): Episode[] {
  const out: Episode[] = [];
  const sorted = [...signals].sort((a, b) => a.at - b.at || a.seq - b.seq);
  let cur: Signal[] = [];
  const close = () => {
    if (!cur.length) return;
    const classes = new Set(cur.map((x) => x.cls));
    const hard = cur.filter((x) => HARD.includes(x.cls));
    if (classes.size >= 3 && (classes.has("inability_text") || hard.length >= 3)) {
      const first = hard[0] ?? cur[0]!;
      out.push({
        conv: first.conv, from: cur[0]!.at, to: cur.at(-1)!.at, root: { cls: first.cls, key: first.key },
        classes: [...classes].sort(), seqs: cur.map((x) => x.seq), evidence: cur.map((x) => `[${x.cls}] ${x.evidence}`),
      });
    }
    cur = [];
  };
  for (const x of sorted) {
    if (cur.length && x.at - cur.at(-1)!.at > WINDOW_MS) close();
    cur.push(x);
  }
  close();
  return out;
}

/** A group's rank: class weight × distinct agents × log2(1 + count), so one noisy agent cannot bury what several hit. */
export function score(cls: FrictionClass, agents: number, count: number): number {
  return +(WEIGHT[cls] * agents * Math.log2(1 + count)).toFixed(2);
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One root cause's name across days and agents: the class and the id-free key, hashed. */
export async function fingerprint(cls: FrictionClass, key: string): Promise<string> {
  return "fr_" + (await sha256Hex(`${cls}\u0000${key}`)).slice(0, 16);
}

/**
 * An agent as a public issue may name it: an HMAC keyed with a secret (`FRICTION_HASH_KEY`), so neither its id nor a
 * guess at it can be checked against an issue by anyone without the key. A plain hash would let whoever knows an id
 * confirm that agent is in a public issue.
 */
export async function agentHash(agentId: string, key: string): Promise<string> {
  if (!key) throw new Error("agentHash needs a key");
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(agentId)));
  return "ag_" + [...mac.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
