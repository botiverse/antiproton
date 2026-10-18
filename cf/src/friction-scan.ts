/**
 * The daily friction scan: where hosted agents got stuck on one UTC day, as a report in the private ARTIFACTS bucket
 * under `friction/<day>.{json,md}` (docs/runbook.md, "Where agents get stuck").
 *
 * It runs in the daily Cron Trigger after the usage retention (`dailyCron`, called from `scheduled` in
 * cf/src/index.ts) and on demand at `POST /admin/friction-scan`. Both read through two things only: the day index the
 * trace flush writes (cf/src/trace-r2.ts `noteTraceDays`), and each agent's own object (`frictionWindow`,
 * cf/src/friction-read.ts), which is a SELECT-only read like /admin/transcript's. No API token, no other Worker.
 *
 * Whose conversations are read is decided by `FRICTION_SCAN_TENANTS` and nothing else: a comma-separated list of
 * tenant ids, or `*` for every hosted (`raft_`) tenant. Unset or empty reads nobody. The bench tenant is never read,
 * whatever the list says: its transcripts are reset by design and it is not a hosted user.
 *
 * Bounded and fail-soft: at most `maxAgents` agents, a wall-clock budget, a cap per conversation in the object, and
 * a step that can neither throw into the cron nor outlive its budget (`dailyCron`).
 *
 * Public issues are a separate, stricter boundary (`issueBody`): the repository is public, so an issue carries an
 * error text only when the key is one of our own fixed product messages (`KNOWN_TEMPLATES`), and then our text, not
 * the key; counts, agent ids as a keyed HMAC, the build and the window. Never an excerpt, a command, a raw id or a
 * conversation id. Off unless `FRICTION_ISSUES=1` and both secrets `FRICTION_GITHUB_TOKEN` and `FRICTION_HASH_KEY`
 * are set (`issuesFrom`).
 */
import {
  agentHash, episodes, excerpt, fingerprint, HARD, scanConversation, score,
  type Episode, type FrictionClass, type Signal,
} from "./friction.ts";
import { FRICTION_LIMITS, type FrictionLimits, type FrictionWindow } from "./friction-read.ts";
import { TRACE_INDEX_PREFIX, utcDay } from "./trace-r2.ts";

// ---------- what it needs ----------

/** The part of an R2 bucket the scan uses. */
export interface FrictionBucket {
  list(o: { prefix: string; delimiter?: string; cursor?: string; limit?: number }): Promise<{
    objects: Array<{ key: string }>; delimitedPrefixes: string[]; truncated: boolean; cursor?: string;
  }>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, body: string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(keys: string | string[]): Promise<unknown>;
}

/** One agent's object, asked for its window (`frictionWindow` on the agent's Durable Object). */
export type WindowReader = (tenantId: string, agentId: string, from: number, to: number, limits: FrictionLimits) => Promise<FrictionWindow | null>;

export interface FrictionEnv {
  FRICTION_SCAN_DISABLED?: string;
  FRICTION_SCAN_TENANTS?: string;
  FRICTION_ISSUES?: string;
  FRICTION_GITHUB_TOKEN?: string;
  FRICTION_HASH_KEY?: string;
  FRICTION_ISSUES_REPO?: string;
  GIT_COMMIT?: string;
}

export interface ScanOptions {
  maxAgents: number;
  budgetMs: number;
  concurrency: number;
  limits: FrictionLimits;
}
export const SCAN_DEFAULTS: ScanOptions = { maxAgents: 40, budgetMs: 120_000, concurrency: 4, limits: FRICTION_LIMITS };
/** How long a report is kept. */
export const REPORT_KEEP_DAYS = 30;
/** How long the day index is kept: the scan reads yesterday's, an on-demand run a recent one. */
export const INDEX_KEEP_DAYS = 14;
export const REPORT_PREFIX = "friction/";
const ISSUE_STATE_KEY = "friction-state/issues.json";

// ---------- whose conversations ----------

export type TenantScope = { kind: "none" } | { kind: "hosted" } | { kind: "list"; ids: string[] };

/** `FRICTION_SCAN_TENANTS`: `*` is every hosted tenant, a list is those tenants, anything else nobody. */
export function tenantScope(v: string | undefined): TenantScope {
  const parts = String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.includes("*")) return { kind: "hosted" };
  const ids = parts.filter((t) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t));
  return ids.length ? { kind: "list", ids } : { kind: "none" };
}

const isBench = (tenantId: string, agentId = "") => /^bench/i.test(tenantId) || /^bench/i.test(agentId);

export function inScope(scope: TenantScope, tenantId: string, agentId = ""): boolean {
  if (isBench(tenantId, agentId)) return false;
  if (scope.kind === "hosted") return tenantId.startsWith("raft_");
  if (scope.kind === "list") return scope.ids.includes(tenantId);
  return false;
}

async function listAll(bucket: FrictionBucket, prefix: string, delimiter: string | undefined, max: number) {
  const keys: string[] = []; const prefixes: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await bucket.list({ prefix, ...(delimiter ? { delimiter } : {}), ...(cursor ? { cursor } : {}), limit: 1000 });
    keys.push(...r.objects.map((o) => o.key)); prefixes.push(...(r.delimitedPrefixes ?? []));
    if (!r.truncated || keys.length + prefixes.length >= max) return { keys, prefixes, truncated: !!r.truncated };
    cursor = r.cursor;
  }
  return { keys, prefixes, truncated: true };
}

export interface ActiveAgents { agents: Array<{ tenantId: string; agentId: string }>; source: "index" | "listing" | "none"; truncated: boolean }

/**
 * The in-scope agents active on `day`: from the day index, or, for a day with no index at all (before the index was
 * deployed, or a day its writes all failed), from listing the in-scope tenants' trace prefixes. A listing names every
 * agent that ever exported, active that day or not; the object's window read answers an idle one with nothing.
 */
export async function activeAgents(bucket: FrictionBucket, day: string, scope: TenantScope, maxAgents: number): Promise<ActiveAgents> {
  if (scope.kind === "none") return { agents: [], source: "none", truncated: false };
  const take = (pairs: Array<[string, string]>, truncated: boolean, source: ActiveAgents["source"]): ActiveAgents => {
    const seen = new Set<string>(); const agents: ActiveAgents["agents"] = [];
    for (const [tenantId, agentId] of pairs) {
      if (!tenantId || !agentId || !inScope(scope, tenantId, agentId) || seen.has(`${tenantId}/${agentId}`)) continue;
      seen.add(`${tenantId}/${agentId}`); agents.push({ tenantId, agentId });
    }
    return { agents: agents.slice(0, maxAgents), source, truncated: truncated || agents.length > maxAgents };
  };
  const dayPrefix = `${TRACE_INDEX_PREFIX}${day}/`;
  const indexed = (await bucket.list({ prefix: dayPrefix, limit: 1 })).objects.length > 0;
  const tenantPrefixes = scope.kind === "hosted" ? ["raft_"] : scope.ids.map((t) => `${t}/`);
  if (indexed) {
    const pairs: Array<[string, string]> = []; let truncated = false;
    for (const tp of tenantPrefixes) {
      const r = await listAll(bucket, dayPrefix + tp, undefined, maxAgents * 4);
      truncated ||= r.truncated;
      for (const k of r.keys) { const [t, a] = k.slice(dayPrefix.length).split("/"); pairs.push([t!, a!]); }
    }
    return take(pairs, truncated, "index");
  }
  const pairs: Array<[string, string]> = []; let truncated = false;
  const tenants = scope.kind === "hosted"
    ? (await listAll(bucket, "trace/raft_", "/", 1000)).prefixes.map((p) => p.slice("trace/".length, -1))
    : scope.ids;
  for (const t of tenants) {
    if (!inScope(scope, t) || pairs.length >= maxAgents * 2) { truncated ||= pairs.length >= maxAgents * 2; continue; }
    const r = await listAll(bucket, `trace/${t}/`, "/", maxAgents * 2);
    truncated ||= r.truncated;
    for (const p of r.prefixes) pairs.push([t, p.slice(`trace/${t}/`.length, -1)]);
  }
  return take(pairs, truncated, "listing");
}

// ---------- the report ----------

export interface ReportExample { tenant: string; agent: string; conv: string; seq: number; at: string; evidence: string }
export interface ReportGroup {
  fingerprint: string; cls: FrictionClass; key: string; count: number; agents: string[]; conversations: number;
  tools: string[]; score: number; examples: ReportExample[];
}
export interface ReportRoot {
  fingerprint: string; cls: FrictionClass; key: string; episodes: number; agents: string[];
  examples: Array<{ tenant: string; agent: string; conv: string; from: string; to: string; seqs: number[]; classes: FrictionClass[]; evidence: string[] }>;
}
export interface FrictionReport {
  day: string; generatedAt: string; build: string | null; runtimeMs: number;
  scope: TenantScope["kind"]; source: ActiveAgents["source"];
  coverage: {
    agents: number; agentsRead: number; agentsNotHeld: number; agentsFailed: number; conversations: number; events: number;
    truncated: { agents: boolean; conversations: number; events: number; budget: boolean };
  };
  roots: ReportRoot[];
  groups: ReportGroup[];
  errors: string[];
}

const iso = (at: number) => new Date(at).toISOString().slice(0, 19) + "Z";

async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
    while (i < items.length) await fn(items[i++]!);
  }));
}

/** Scan one UTC day. Never throws for one agent's failure: that agent is counted in `agentsFailed` and named in `errors`. */
export async function scanDay(
  deps: { bucket: FrictionBucket; window: WindowReader; now?: () => number; build?: string | null },
  scope: TenantScope, day: string, opts: ScanOptions = SCAN_DEFAULTS,
): Promise<FrictionReport> {
  const now = deps.now ?? Date.now;
  const t0 = now();
  const from = Date.parse(day + "T00:00:00Z"), to = from + 86_400_000;
  const found = await activeAgents(deps.bucket, day, scope, opts.maxAgents);
  const coverage: FrictionReport["coverage"] = {
    agents: found.agents.length, agentsRead: 0, agentsNotHeld: 0, agentsFailed: 0, conversations: 0, events: 0,
    truncated: { agents: found.truncated, conversations: 0, events: 0, budget: false },
  };
  const errors: string[] = [];
  const signals: Array<Signal & { tenant: string; agent: string }> = [];
  const eps: Array<Episode & { tenant: string; agent: string }> = [];
  await pool(found.agents, opts.concurrency, async ({ tenantId, agentId }) => {
    // Re-checked per agent: a listing is filtered too, but the read is where the boundary has to hold.
    if (!inScope(scope, tenantId, agentId)) return;
    if (now() - t0 > opts.budgetMs) { coverage.truncated.budget = true; return; }
    let w: FrictionWindow | null;
    try { w = await deps.window(tenantId, agentId, from, to, opts.limits); }
    catch (e) { coverage.agentsFailed++; errors.push(`${tenantId}/${agentId}: ${String((e as Error)?.message ?? e).slice(0, 160)}`); return; }
    if (w === null) { coverage.agentsNotHeld++; return; }
    coverage.agentsRead++;
    if (w.truncated) coverage.truncated.conversations++;
    for (const c of w.conversations) {
      coverage.conversations++; coverage.events += c.events.length;
      if (c.truncated) coverage.truncated.events++;
      const sig = scanConversation(c.id, c.events);
      signals.push(...sig.map((s) => ({ ...s, tenant: tenantId, agent: agentId })));
      eps.push(...episodes(sig).map((x) => ({ ...x, tenant: tenantId, agent: agentId })));
    }
  });

  const byGroup = new Map<string, { cls: FrictionClass; key: string; count: number; agents: Set<string>; convs: Set<string>; tools: Set<string>; examples: ReportExample[] }>();
  for (const s of signals) {
    const k = `${s.cls}\u0000${s.key}`;
    const g = byGroup.get(k) ?? { cls: s.cls, key: s.key, count: 0, agents: new Set(), convs: new Set(), tools: new Set(), examples: [] };
    g.count++; g.agents.add(s.agent); g.convs.add(`${s.agent}/${s.conv}`); if (s.tool) g.tools.add(s.tool);
    if (g.examples.length < 3) g.examples.push({ tenant: s.tenant, agent: s.agent, conv: s.conv, seq: s.seq, at: iso(s.at), evidence: s.evidence });
    byGroup.set(k, g);
  }
  const groups: ReportGroup[] = await Promise.all([...byGroup.values()].map(async (g) => ({
    fingerprint: await fingerprint(g.cls, g.key), cls: g.cls, key: g.key, count: g.count, agents: [...g.agents],
    conversations: g.convs.size, tools: [...g.tools], score: score(g.cls, g.agents.size, g.count), examples: g.examples,
  })));
  groups.sort((a, b) => b.score - a.score || a.fingerprint.localeCompare(b.fingerprint));

  const byRoot = new Map<string, { cls: FrictionClass; key: string; episodes: number; agents: Set<string>; examples: ReportRoot["examples"] }>();
  for (const e of eps) {
    const k = `${e.root.cls}\u0000${e.root.key}`;
    const r = byRoot.get(k) ?? { cls: e.root.cls, key: e.root.key, episodes: 0, agents: new Set(), examples: [] };
    r.episodes++; r.agents.add(e.agent);
    if (r.examples.length < 2) {
      r.examples.push({ tenant: e.tenant, agent: e.agent, conv: e.conv, from: iso(e.from), to: iso(e.to), seqs: e.seqs, classes: e.classes, evidence: e.evidence.slice(0, 16) });
    }
    byRoot.set(k, r);
  }
  const roots: ReportRoot[] = await Promise.all([...byRoot.values()].map(async (r) => ({
    fingerprint: await fingerprint(r.cls, r.key), cls: r.cls, key: r.key, episodes: r.episodes, agents: [...r.agents], examples: r.examples,
  })));
  roots.sort((a, b) => b.agents.length - a.agents.length || b.episodes - a.episodes || a.fingerprint.localeCompare(b.fingerprint));

  return {
    day, generatedAt: new Date(now()).toISOString(), build: deps.build ?? null, runtimeMs: now() - t0,
    scope: scope.kind, source: found.source, coverage, roots, groups: groups.slice(0, 200), errors: errors.slice(0, 20),
  };
}

const cell = (s: string, n: number) => excerpt(s, n).replace(/\|/g, "\\|");

export function renderMarkdown(r: FrictionReport): string {
  const c = r.coverage;
  const md: string[] = [
    `# Where agents got stuck, ${r.day} (UTC)`, "",
    `build ${r.build ?? "unknown"}, scope ${r.scope}, agents from the ${r.source}. ${c.agentsRead}/${c.agents} agents read ` +
    `(${c.agentsNotHeld} not held by their object, ${c.agentsFailed} failed), ${c.conversations} conversations, ${c.events} events.` +
    (c.truncated.agents || c.truncated.budget || c.truncated.conversations || c.truncated.events
      ? ` Truncated: agents ${c.truncated.agents ? "yes" : "no"}, budget ${c.truncated.budget ? "hit" : "no"}, ` +
        `agents with conversations cut ${c.truncated.conversations}, conversations with events cut ${c.truncated.events}.`
      : ""),
    "",
    "## 1. Stuck episodes, by root cause", "",
    "An episode is one conversation with 3 or more friction classes less than 10 minutes apart, ending in inability text " +
    "or 3 or more hard failures. Its root is its first hard failure.", "",
  ];
  if (!r.roots.length) md.push("(none)", "");
  for (const root of r.roots.slice(0, 15)) {
    md.push(`### ${root.cls} · ${cell(root.key, 160)}`, `\`${root.fingerprint}\`: ${root.episodes} episode(s), ${root.agents.length} agent(s)`);
    for (const e of root.examples) {
      md.push(`- ${e.tenant}/${e.agent} \`${e.conv}\` ${e.from.slice(11)}–${e.to.slice(11)}, seq ${e.seqs[0]}..${e.seqs.at(-1)}, classes ${e.classes.join(", ")}`);
      for (const ev of e.evidence.slice(0, 12)) md.push(`  - ${ev}`);
    }
    md.push("");
  }
  md.push("## 2. Signal groups", "", "Ranked by class weight × distinct agents × log2(1 + count).", "",
    "| score | class | key | count | agents | convs | fingerprint | example |", "|---|---|---|---|---|---|---|---|");
  for (const g of r.groups.slice(0, 40)) {
    const ex = g.examples[0]!;
    md.push(`| ${g.score} | ${g.cls} | ${cell(g.key, 80)} | ${g.count} | ${g.agents.length} | ${g.conversations} | \`${g.fingerprint}\` | ${ex.agent.slice(0, 13)}/${ex.conv} seq ${ex.seq}: ${cell(ex.evidence, 90)} |`);
  }
  if (r.errors.length) md.push("", "## Agents that could not be read", "", ...r.errors.map((e) => `- ${e}`));
  return md.join("\n") + "\n";
}

const DAY_KEY = /^friction\/(\d{4}-\d{2}-\d{2})\.(json|md)$/;

/** Write the report and delete reports older than `REPORT_KEEP_DAYS` and day-index entries older than `INDEX_KEEP_DAYS`. */
export async function writeReport(bucket: FrictionBucket, r: FrictionReport, today: string): Promise<{ keys: string[]; deleted: number }> {
  const keys = [`${REPORT_PREFIX}${r.day}.json`, `${REPORT_PREFIX}${r.day}.md`];
  await bucket.put(keys[0]!, JSON.stringify(r, null, 1), { httpMetadata: { contentType: "application/json" } });
  await bucket.put(keys[1]!, renderMarkdown(r), { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  const base = Date.parse(today + "T00:00:00Z");
  const reportHorizon = utcDay(base - REPORT_KEEP_DAYS * 86_400_000);
  const old = (await listAll(bucket, REPORT_PREFIX, undefined, 2000)).keys.filter((k) => { const m = DAY_KEY.exec(k); return !!m && m[1]! < reportHorizon; });
  const indexHorizon = utcDay(base - INDEX_KEEP_DAYS * 86_400_000);
  const days = (await listAll(bucket, TRACE_INDEX_PREFIX, "/", 2000)).prefixes
    .map((p) => p.slice(TRACE_INDEX_PREFIX.length, -1)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d < indexHorizon).sort();
  // One old day per run is enough to keep up, and keeps the delete bounded.
  if (days[0]) old.push(...(await listAll(bucket, `${TRACE_INDEX_PREFIX}${days[0]}/`, undefined, 1000)).keys.slice(0, 1000));
  for (let i = 0; i < old.length; i += 1000) await bucket.delete(old.slice(i, i + 1000));
  return { keys, deleted: old.length };
}

// ---------- public issues ----------

/** Where findings are filed. GitHub in production (`githubTracker`), a fake in tests. */
export interface IssueTracker {
  /** The open or closed issue already filed for a fingerprint, if any. */
  find(fingerprint: string): Promise<number | null>;
  create(title: string, body: string, labels: string[]): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
}

export const ISSUE_LABEL = "agent-friction";

/** What filing needs, or why it is off. */
export type IssueConfig = { tracker: IssueTracker; hashKey: string } | { off: string };

/**
 * Filing is on only when it is asked for (`FRICTION_ISSUES=1`) AND both of its secrets are set: its own GitHub token
 * and the key agent ids are hashed under. Asked for with a secret missing is a misconfiguration, said in `off` (by
 * name, never by value) and logged by the caller.
 */
export function issuesFrom(env: FrictionEnv, fetcher: typeof fetch = fetch): IssueConfig {
  if (env.FRICTION_ISSUES !== "1") return { off: "issues off" };
  const missing = [env.FRICTION_GITHUB_TOKEN ? null : "FRICTION_GITHUB_TOKEN", env.FRICTION_HASH_KEY ? null : "FRICTION_HASH_KEY"].filter(Boolean);
  if (missing.length) return { off: `issues off: FRICTION_ISSUES=1 but ${missing.join(" and ")} not set` };
  return { tracker: githubTracker(env.FRICTION_GITHUB_TOKEN!, env.FRICTION_ISSUES_REPO || "botiverse/antiproton", fetcher), hashKey: env.FRICTION_HASH_KEY! };
}

export function githubTracker(token: string, repo: string, fetcher: typeof fetch = fetch): IssueTracker {
  const gh = async (path: string, init: RequestInit = {}) => {
    const r = await fetcher(`https://api.github.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "antiproton-friction", "content-type": "application/json" },
    });
    if (!r.ok) throw new Error(`github ${r.status} on ${path.split("?")[0]}`);
    return r.json() as Promise<any>;
  };
  return {
    async find(fp) {
      const q = encodeURIComponent(`repo:${repo} label:${ISSUE_LABEL} in:title ${fp}`);
      const r = await gh(`/search/issues?q=${q}&per_page=1`);
      return r.items?.[0]?.number ?? null;
    },
    async create(title, body, labels) { return (await gh(`/repos/${repo}/issues`, { method: "POST", body: JSON.stringify({ title, body, labels }) })).number; },
    async comment(issue, body) { await gh(`/repos/${repo}/issues/${issue}/comments`, { method: "POST", body: JSON.stringify({ body }) }); },
  };
}

/**
 * Our own product messages, as `template` (cf/src/friction.ts) leaves them, that a public issue may name. A closed list,
 * on purpose: an error text that is not ours can carry anything (an org, a repo, a path, a file name, in plain ASCII),
 * and no denylist can tell those from product words. A key is shown only when it matches one of these patterns
 * whole, and what is shown is the entry's own `shown` text, never the key: even the parts a pattern lets vary (a mount
 * alias, a tool name) stay out of the issue. Anything else is withheld, with the fingerprint to find it in the private
 * report. A new message belongs here only with its source (each entry names it) and a test.
 */
export interface KnownTemplate { id: string; cls: FrictionClass; pattern: RegExp; shown: string }
const SIZE = String.raw`<n>MiB \(<n>bytes\), over the <n>MiB \(<n>bytes\) limit`;
const SIDE = String.raw`<n>×<n>px, over the <n>px limit on a side`;
const MOUNT = String.raw`[a-z0-9_-]{1,40}`;
const JOB = String.raw`<op_id> \([a-z0-9_-]{1,80}, running <n>s\)`;
const GH_401 = "github <n>: Bad credentials — the <q> mount's account was used, and GitHub refused that credential itself, so it has to be replaced rather than added to";
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const OWN = String.raw`(?:[a-z0-9-]+\.)*(?:raft\.build|antiproton\.ai)`;
export const KNOWN_TEMPLATES: readonly KnownTemplate[] = [
  // src/plugins/raft.ts, the attachments_view size refusals: bytes, px, or both.
  { id: "attachment-too-large-bytes", cls: "tool_error",
    pattern: new RegExp(String.raw`^${MOUNT}: attachment <uuid> \(<q>\) is too large to view: ${SIZE}\. Images are not resized here\. It was kept as <artifact-ref>$`),
    shown: "attachment <uuid> (<q>) is too large to view: <n> MiB, over the <n> MiB limit. Images are not resized here." },
  { id: "attachment-too-large-px", cls: "tool_error",
    pattern: new RegExp(String.raw`^${MOUNT}: attachment <uuid> \(<q>\) is too large to view: ${SIDE}\. Images are not resized here\. It was kept as <artifact-ref>$`),
    shown: "attachment <uuid> (<q>) is too large to view: <n>×<n> px, over the <n> px limit on a side. Images are not resized here." },
  { id: "attachment-too-large-both", cls: "tool_error",
    pattern: new RegExp(String.raw`^${MOUNT}: attachment <uuid> \(<q>\) is too large to view: ${SIZE}; and ${SIDE}\. Images are not resized here\. It was kept as <artifact-ref>$`),
    shown: "attachment <uuid> (<q>) is too large to view: over the MiB limit and the px limit on a side. Images are not resized here." },
  // src/runtime/background-jobs.ts, the cap on running background jobs.
  { id: "background-job-limit", cls: "tool_error",
    pattern: new RegExp(String.raw`^${MOUNT}: <n>background jobs are already running, the most this agent may have at once: ${JOB}(?:, ${JOB}){0,9}\. Wait for one to finish \(its result arrives as a message\) or cancel one with jobs\.cancel\.$`),
    shown: "<n> background jobs are already running, the most this agent may have at once. Wait for one to finish or cancel one with jobs.cancel." },
  // src/plugins/github.ts `identityLine`, a 401 on an attached credential: as the tool's error, and as its auth reading.
  { id: "gh-bad-credentials", cls: "tool_error", pattern: new RegExp(`^${MOUNT}: ${esc(GH_401)}$`), shown: GH_401 },
  { id: "gh-bad-credentials", cls: "auth_failure", pattern: new RegExp(`^${MOUNT} mount 401 ${esc(GH_401.slice(0, 60))}$`), shown: GH_401 },
  // src/plugins/http.ts, a scheme web__get does not fetch (an artifact:// ref, in calibration).
  { id: "web-refused-scheme", cls: "tool_error", pattern: new RegExp(String.raw`^${MOUNT}: refused scheme [a-z][a-z0-9+.-]{0,20}:$`), shown: "refused scheme <scheme>:" },
  // cf/src/friction.ts `binary_as_text`: bytes a read tool returned as UTF-8 text.
  { id: "binary-as-text", cls: "binary_as_text", pattern: /^[a-z0-9_-]{1,40}__(read|get) kind=(text|\?)$/, shown: "binary bytes returned as text (U+FFFD) by a read tool" },
  // cf/src/friction.ts, our own API hosts refusing or not knowing a guessed endpoint.
  { id: "own-api-auth", cls: "auth_failure", pattern: new RegExp(`^HTTP (401|403) ${OWN}$`), shown: "HTTP 401/403 from an antiproton or Raft API host" },
  { id: "own-api-404", cls: "guessed_endpoint_404", pattern: new RegExp(`^${MOUNT}__get 404 ${OWN}$`), shown: "HTTP 404 from an antiproton or Raft API host (a guessed endpoint)" },
];

/** The text a public issue may show for a key: a known template's own text, or null (withheld). */
export function issueTemplate(cls: FrictionClass, key: string): string | null {
  return KNOWN_TEMPLATES.find((t) => t.cls === cls && t.pattern.test(key))?.shown ?? null;
}

export interface IssueCounts { occurrences: number; agents: number; conversations: number; episodes: number }

/** An issue's body: the fingerprint, the class, a safe template or none, counts, hashed agents, build and window. */
export async function issueBody(day: string, build: string | null, g: ReportGroup, episodesAsRoot: number, hashKey: string): Promise<string> {
  const tmpl = issueTemplate(g.cls, g.key);
  const hashes = await Promise.all(g.agents.slice(0, 20).map((a) => agentHash(a, hashKey)));
  return [
    `Fingerprint: \`${g.fingerprint}\``,
    `Class: \`${g.cls}\``,
    tmpl === null ? `Error template: withheld (see private report, fingerprint ${g.fingerprint})` : `Error template: \`${tmpl}\``,
    `Window: ${day}T00:00Z to ${utcDay(Date.parse(day + "T00:00:00Z") + 86_400_000)}T00:00Z`,
    `Counts: ${g.count} occurrence(s), ${g.agents.length} agent(s), ${g.conversations} conversation(s), ${episodesAsRoot} stuck episode(s) as root`,
    `Agents (hashed): ${hashes.join(", ")}`,
    `Build: ${build ?? "unknown"}`,
    "",
    `Evidence is in the private report \`friction/${day}.json\` under this fingerprint (docs/runbook.md, "Where agents get stuck").`,
  ].join("\n");
}

export function issueTitle(g: ReportGroup): string {
  const tmpl = issueTemplate(g.cls, g.key);
  return `${ISSUE_LABEL}: ${g.cls} ${g.fingerprint}${tmpl ? ` · ${tmpl.slice(0, 70)}` : ""}`;
}

type IssueState = Record<string, { issue: number; counts: IssueCounts }>;

/**
 * File the day's findings: one issue per new fingerprint that is an episode's root, an auth failure, or hit 2 or more
 * agents, among the hard classes and repeated failures; a comment on a known one only when its counts changed. At
 * most `maxNew` issues a run. State is the private bucket's `friction-state/issues.json`; when it is lost, `find`
 * keeps a known fingerprint from being filed twice.
 */
export async function fileIssues(bucket: FrictionBucket, tracker: IssueTracker, hashKey: string, r: FrictionReport, maxNew = 5): Promise<{ created: number; commented: number }> {
  if (!hashKey) throw new Error("no FRICTION_HASH_KEY: agent ids cannot be hashed, so nothing is filed");
  const raw = await bucket.get(ISSUE_STATE_KEY);
  const state: IssueState = raw ? JSON.parse(await raw.text()) : {};
  const rootEpisodes = new Map(r.roots.map((x) => [x.fingerprint, x.episodes]));
  let created = 0, commented = 0;
  for (const g of r.groups) {
    if (!HARD.includes(g.cls) && g.cls !== "repeated_failure") continue;
    const counts: IssueCounts = { occurrences: g.count, agents: g.agents.length, conversations: g.conversations, episodes: rootEpisodes.get(g.fingerprint) ?? 0 };
    const known = state[g.fingerprint];
    if (known) {
      if (JSON.stringify(known.counts) !== JSON.stringify(counts)) {
        await tracker.comment(known.issue, await issueBody(r.day, r.build, g, counts.episodes, hashKey));
        state[g.fingerprint] = { issue: known.issue, counts }; commented++;
      }
      continue;
    }
    if (!(counts.episodes > 0 || g.cls === "auth_failure" || counts.agents >= 2) || created >= maxNew) continue;
    const existing = await tracker.find(g.fingerprint);
    const issue = existing ?? await tracker.create(issueTitle(g), await issueBody(r.day, r.build, g, counts.episodes, hashKey), [ISSUE_LABEL]);
    if (existing === null) created++;
    state[g.fingerprint] = { issue, counts };
  }
  await bucket.put(ISSUE_STATE_KEY, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
  return { created, commented };
}

// ---------- the cron step ----------

/** The UTC day before a time. */
export const dayBefore = (at: number): string => utcDay(at - 86_400_000);

/**
 * The cron's friction step: yesterday's report, then issues when they are configured. Returns what it did, for the
 * log; the kill switch and an empty scope return before anything is read.
 */
export async function frictionDaily(
  env: FrictionEnv, deps: { bucket: FrictionBucket; window: WindowReader; now?: () => number; tracker?: IssueTracker },
  scheduledTime: number, opts: ScanOptions = SCAN_DEFAULTS,
): Promise<string> {
  if (env.FRICTION_SCAN_DISABLED === "1") return "disabled";
  const scope = tenantScope(env.FRICTION_SCAN_TENANTS);
  if (scope.kind === "none") return "no tenants in scope";
  const day = dayBefore(scheduledTime);
  const report = await scanDay({ bucket: deps.bucket, window: deps.window, now: deps.now, build: env.GIT_COMMIT ?? null }, scope, day, opts);
  const { keys } = await writeReport(deps.bucket, report, utcDay(scheduledTime));
  // A tracker handed in (a test's fake) stands in for GitHub only: the switch and both secrets are still the env's.
  const config = issuesFrom(env);
  let issues: string;
  if ("off" in config) {
    issues = config.off;
    if (config.off !== "issues off") console.warn(JSON.stringify({ evt: "friction.issues", error: config.off }));
  } else {
    try { const f = await fileIssues(deps.bucket, deps.tracker ?? config.tracker, config.hashKey, report); issues = `issues ${f.created} new, ${f.commented} updated`; }
    catch (e) { issues = `issues failed: ${String((e as Error)?.message ?? e).slice(0, 160)}`; console.warn(JSON.stringify({ evt: "friction.issues", error: issues })); }
  }
  return `${keys[0]}: ${report.roots.length} root cause(s), ${report.groups.length} group(s), ${report.coverage.agentsRead}/${report.coverage.agents} agents; ${issues}`;
}

/**
 * The daily cron's steps. Retention first and awaited, so its failure still marks the invocation failed in the
 * trigger's history; the friction step after it, whatever retention did, unable to throw and cut off at `limitMs`
 * so a slow scan cannot hold the invocation. Retention's error is rethrown last.
 */
export async function dailyCron(retain: () => Promise<void>, friction: () => Promise<string>, limitMs = SCAN_DEFAULTS.budgetMs + 60_000): Promise<void> {
  let retainError: unknown = null;
  try { await retain(); } catch (e) { retainError = e; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const out = await Promise.race([
      friction(),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve(`friction scan cut off after ${limitMs} ms`), limitMs); }),
    ]);
    console.log(JSON.stringify({ evt: "friction.scan", out }));
  } catch (e) {
    console.warn(JSON.stringify({ evt: "friction.scan", error: String((e as Error)?.message ?? e).slice(0, 300) }));
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (retainError) throw retainError;
}
