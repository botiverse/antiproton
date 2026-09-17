/**
 * GitHub, shaped like `gh`.
 *
 * The credential never reaches the model. It is dereferenced from the mount's
 * `secret_ref` at dispatch and attached here, so an agent can act as an account
 * without ever being able to read, log or exfiltrate the token that makes it
 * possible. The same plugin mounted twice against two accounts stays two
 * separate authorities, because a mount is the unit of authority, not a plugin.
 *
 * Three things are taken from the `gh` CLI, which has had years of people
 * finding out what they actually reach for:
 *
 * **Noun-verb naming.** `issue_list`, `pr_view`, `repo_view` — the same shape
 * as `gh issue list`, so an agent that knows the CLI can guess the tool. Dots
 * are not available: providers restrict tool names to `^[a-zA-Z0-9_-]+$`, and
 * one bad name makes the provider reject the entire request with a 400 rather
 * than just that tool. The previous version of this file shipped `repos.get`
 * and `issues.list`, and that is exactly what happened.
 *
 * **`status` verbs.** `gh pr status` answers "what is waiting on me", which is
 * usually the question, and listing everything and filtering is a poor
 * substitute for asking it.
 *
 * **An escape hatch.** `gh api` is why the CLI is never a dead end, and `api`
 * here is the same: any endpoint, with the mount's credential attached. It
 * grants nothing the other tools do not already have — same token, same host —
 * it only stops our coverage from being the agent's ceiling.
 *
 * Responses are projected rather than forwarded. A repository object is over a
 * hundred fields and an issue is forty, most of them URLs the agent cannot use;
 * returning them whole is how a context fills up with `events_url`.
 */
import type { Json } from "../core/types.ts";
import type { Plugin, PluginContext, ToolSchema } from "./types.ts";

const API = "https://api.github.com";
/** GitHub caps this itself; clamping makes the limit visible in the schema. */
const MAX_PER_PAGE = 100;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/**
 * A null byte means binary whatever the declared encoding says.
 *
 * Written as an escape rather than the character itself: a literal NUL makes
 * the whole source file binary to grep, which then silently skips it.
 */
const NUL = "\u0000";

function repoOf(args: Record<string, any>): string {
  const repo = String(args.repo ?? "");
  // A path segment the caller controls is how a "repo" becomes `../../user`.
  if (!REPO.test(repo)) {
    throw new Error(`repo must be "owner/name", got ${JSON.stringify(repo).slice(0, 40)}`);
  }
  return repo;
}

/**
 * What a mount with no account should say when GitHub's answer may be about the
 * account rather than the request. The seeded mount has none, and without this
 * an agent read a private repository's 404 as "the repository cannot be
 * reached" and a shared anonymous limit's 403 as a dead end, and the person had
 * to work out that an account was missing (trajectory read by cody, 2026-09-15).
 */
function noAccountHint(status: number): string {
  if (status === 404) {
    return " — this mount has no account, so a private repository answers exactly like a missing one;" +
      " a person can attach a token to the mount";
  }
  if (status === 403) {
    return " — this mount has no account, so it shares GitHub's low anonymous rate limit with everything" +
      " else calling from this server; a person can attach a token to the mount to raise it";
  }
  return "";
}

async function call(
  method: string, path: string, ctx: PluginContext, body?: unknown,
  opts: { text?: boolean } = {},
): Promise<any> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "antiproton/0.1",
  };
  // Credential injection happens here, at dispatch, never in the JS sandbox.
  if (ctx.credential) headers.authorization = `Bearer ${ctx.credential}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  // Redirects are followed here rather than by fetch. A job's logs answer 302
  // to signed storage (*.blob.core.windows.net), and storage refuses a request
  // carrying GitHub's Authorization with 401 (measured 2026-09-15). Node's fetch
  // drops that header on a cross-origin hop; a Worker's was not measured. So a
  // hop within the API keeps the headers (a renamed repository redirects there
  // and needs them), and any other host gets none: its URL is its credential.
  let url = new URL(API + path);
  let res = await fetch(url, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000), redirect: "manual",
  });
  for (let hop = 0; hop < 3 && res.status >= 300 && res.status < 400 && res.headers.get("location"); hop++) {
    url = new URL(res.headers.get("location")!, url);
    const sameApi = url.origin === new URL(API).origin;
    // 303 means "go and GET this"; 307 and 308 repeat the request as it was.
    const asGet = res.status === 303 || method === "GET";
    res = await fetch(url, {
      ...(sameApi ? {
        method: asGet ? "GET" : method, headers,
        body: asGet || body === undefined ? undefined : JSON.stringify(body),
      } : {}),
      signal: AbortSignal.timeout(30_000), redirect: "manual",
    });
  }
  // Who answered, for errors: GitHub, or the storage host it sent us to. The
  // host only, never the signed query string.
  const who = url.origin === new URL(API).origin ? "github" : `${url.host} (where github redirected)`;
  const text = await res.text();
  // Parsed only when it is JSON. Actions logs are plain text and an error page
  // can be HTML; parsing those threw a SyntaxError that named neither the status
  // nor the endpoint, and the agent went to curl with the token in the command.
  const type = res.headers.get("content-type") ?? "";
  const isJson = /json/i.test(type) || (!type && /^\s*[[{]/.test(text));
  let parsed: any = null;
  if (text && isJson) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    // A 403 here is nearly always the rate limit rather than permission, and
    // the two want completely different reactions from the agent.
    const rate = remaining === "0" && reset
      ? ` — rate limit exhausted, resets ${new Date(Number(reset) * 1000).toISOString()}`
      : "";
    const err = new Error(
      `${who} ${res.status}: ${parsed?.message ?? res.statusText}${rate}${ctx.credential ? "" : noAccountHint(res.status)}`,
    ) as Error & { retryable?: boolean };
    err.retryable = res.status === 429 || (res.status === 403 && remaining === "0") || res.status >= 500;
    throw err;
  }
  if (text && !isJson) {
    if (!opts.text) throw new Error(`github answered ${type || "an unlabelled body"} rather than JSON for ${path}`);
    if (/zip|gzip|octet-stream|image\/|pdf/i.test(type) || text.includes(NUL)) {
      throw new Error(
        `github answered binary content (${type || "unlabelled"}) for ${path}, which this tool cannot return as text` +
        (/\/actions\/runs\/\d+\/logs/.test(path) ? "; a run's logs are a zip, and each job's logs are text at /repos/{owner}/{repo}/actions/jobs/{job_id}/logs" : ""),
      );
    }
    return { contentType: type, text };
  }
  return parsed;
}

/** A write without an account is a configuration mistake, not a 401 to retry. */
function requireAccount(ctx: PluginContext, tool: string) {
  if (!ctx.credential) {
    throw new Error(
      `${tool} needs an account: this mount has no secret_ref, so it can only read public data`,
    );
  }
}

/** A path, not a URL: the host is ours to decide, so no amount of creativity in
 *  this argument reaches another origin. */
function apiPath(raw: unknown): string {
  const path = String(raw ?? "");
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error(
      `path must begin with a single "/" and carry no host, got ${JSON.stringify(path).slice(0, 60)}`,
    );
  }
  return path;
}

const paging = (a: Record<string, any>) => new URLSearchParams({
  per_page: String(Math.min(Math.max(Number(a.perPage ?? 20), 1), MAX_PER_PAGE)),
  page: String(Math.max(Number(a.page ?? 1), 1)),
});

// ---- projections ----------------------------------------------------------

const repoOut = (r: any) => ({
  fullName: r.full_name, description: r.description, private: r.private,
  defaultBranch: r.default_branch, language: r.language, stars: r.stargazers_count,
  openIssues: r.open_issues_count, archived: r.archived, pushedAt: r.pushed_at,
  topics: r.topics, permissions: r.permissions, url: r.html_url,
});

const issueOut = (i: any) => ({
  number: i.number, title: i.title, state: i.state, author: i.user?.login,
  labels: (i.labels ?? []).map((l: any) => l?.name ?? l),
  assignees: (i.assignees ?? []).map((u: any) => u.login),
  comments: i.comments, createdAt: i.created_at, updatedAt: i.updated_at,
  isPullRequest: !!i.pull_request, repo: i.repository_url?.split("/repos/")[1],
  url: i.html_url,
});

const prOut = (p: any) => ({
  number: p.number, title: p.title, state: p.state, draft: p.draft,
  author: p.user?.login, base: p.base?.ref, head: p.head?.ref,
  merged: p.merged ?? p.merged_at !== null, mergeable: p.mergeable,
  additions: p.additions, deletions: p.deletions, changedFiles: p.changed_files,
  createdAt: p.created_at, url: p.html_url,
});

const commentOut = (c: any) => ({
  id: c.id, author: c.user?.login, body: c.body, createdAt: c.created_at, url: c.html_url,
});

const commitOut = (c: any) => ({
  sha: String(c.sha ?? "").slice(0, 12),
  message: String(c.commit?.message ?? "").split("\n")[0],
  author: c.commit?.author?.name, date: c.commit?.author?.date, url: c.html_url,
});

const runOut = (r: any) => ({
  id: r.id, name: r.name, event: r.event, status: r.status, conclusion: r.conclusion,
  branch: r.head_branch, sha: String(r.head_sha ?? "").slice(0, 12),
  createdAt: r.created_at, url: r.html_url,
});

// ---- inbound events ---------------------------------------------------------

/**
 * What this mount has asked to hear about, kept in its connection state.
 *
 * `login` is the account the mount acts as, recorded when a subscription is
 * made so that `receive` can drop the mount's own comments without calling
 * GitHub — it has ten seconds to answer. Null means the mount had no account
 * then, so it could not have written anything to hear back.
 */
interface Inbound {
  login: string | null;
  subscriptions: Array<{ repo: string; number: number | null }>;
  /** The last signed delivery of any kind: proof the webhook reaches this mount. */
  lastReached?: { at: number; event: string };
}

const MAX_SUBSCRIPTIONS = 50;
/** How much of a stranger's text reaches the agent. Enough to decide whether to look. */
const QUOTE_CHARS = 500;
const TITLE_CHARS = 200;
/** What is worth waking an agent for. Labels and assignments are not, yet. */
const ISSUE_ACTIONS = new Set(["opened", "edited", "closed", "reopened", "deleted", "transferred"]);
const COMMENT_ACTIONS = new Set(["created", "edited", "deleted"]);

async function inboundOf(ctx: PluginContext): Promise<Inbound> {
  const state = (await ctx.connection.get()) as { inbound?: Inbound } | null;
  const i = state?.inbound;
  return { login: i?.login ?? null, subscriptions: i?.subscriptions ?? [], ...(i?.lastReached ? { lastReached: i.lastReached } : {}) };
}

async function saveInbound(ctx: PluginContext, inbound: Inbound) {
  const state = ((await ctx.connection.get()) ?? {}) as Record<string, Json>;
  await ctx.connection.set({ ...state, inbound: inbound as unknown as Json });
}

function issueNumberOf(a: Record<string, any>): number | null {
  if (a.number === undefined || a.number === null) return null;
  const n = Number(a.number);
  if (!Number.isInteger(n) || n < 1) throw new Error(`number must be a positive integer, got ${JSON.stringify(a.number)}`);
  return n;
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Whether `header` is GitHub's signature of `body` under `secret`.
 *
 * `crypto.subtle.verify` compares in constant time, which a string comparison
 * of two hex digests does not. Anything not shaped like `sha256=<64 hex>` is
 * false rather than an exception: a malformed header is a refusal, not a crash.
 */
export async function validGithubSignature(body: Uint8Array, header: string, secret: string): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!m || !secret) return false;
  const sig = new Uint8Array(32);
  for (let i = 0; i < 32; i++) sig[i] = parseInt(m[1]!.slice(i * 2, i * 2 + 2), 16);
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, sig, body);
}

/**
 * The payload, from either of the two content types a GitHub webhook can be
 * configured with. `application/x-www-form-urlencoded` carries the JSON in a
 * `payload` field, and an operator picking it in the settings page is not a
 * mistake worth losing events over.
 */
function payloadOf(event: { headers: Record<string, string>; body: Uint8Array }): any {
  const text = new TextDecoder().decode(event.body);
  const type = event.headers["content-type"] ?? "";
  const json = /x-www-form-urlencoded/i.test(type) ? new URLSearchParams(text).get("payload") ?? "" : text;
  return JSON.parse(json);
}

const clip = (s: unknown, n: number) => {
  const text = String(s ?? "").trim();
  return text.length > n ? `${text.slice(0, n)}…` : text;
};
const quote = (s: unknown) => clip(s, QUOTE_CHARS).split("\n").map((l) => `> ${l}`).join("\n");

const t = (
  name: string, summary: string, properties: Record<string, unknown>,
  required: string[], sideEffects: "read" | "write",
  idempotency: "native" | "key" | "none" = sideEffects === "read" ? "native" : "none",
): ToolSchema => ({
  name, summary, parameters: { type: "object", properties, required } as Json,
  sideEffects, idempotency,
});

const REPO_ARG = { repo: { type: "string", description: 'owner/name, e.g. "cloudflare/workerd"' } };
const PAGE_ARGS = {
  perPage: { type: "integer", description: `max ${MAX_PER_PAGE}` },
  page: { type: "integer" },
};

export const githubPlugin: Plugin = {
  id: "github",
  // Useful with no credential at all — public repositories are most of what
  // an agent is asked to look at.
  defaultForAllAgents: true,
  version: "2.0.0",
  credential: {
    // Optional, not absent: without a token this mount still reads public
    // repositories, which is what the `gh_public` mount is for. Declaring it
    // optional is what lets a console show "connected" against one mount and
    // "public only" against another instead of showing both the same.
    required: false,
    summary: "A GitHub personal access token, or a GitHub App installation token.",
    shape: "token",
    // Classic tokens and the OAuth, user, server and refresh tokens share one
    // prefix scheme; fine-grained tokens have their own. Bounded below so a
    // prefix mentioned in prose is not a token.
    looksLike: [
      { kind: "github-token", pattern: "\\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\\b" },
    ],
    grants: "private repositories, code search, and every write tool: opening issues, commenting, closing.",
    docs: "https://github.com/settings/tokens",
  },
  config: [],
  tools: [
    t("auth_status", "Which account this mount acts as. Check it before a write, the way `gh auth status` does.", {}, [], "read"),

    t("repo_view", "A repository's metadata, and what this account may do to it.", REPO_ARG, ["repo"], "read"),

    t("issue_list", "Issues in a repository, newest first. GitHub includes pull requests here; they are marked isPullRequest.", {
      ...REPO_ARG,
      state: { type: "string", enum: ["open", "closed", "all"] },
      labels: { type: "string", description: "comma-separated" },
      assignee: { type: "string" },
      ...PAGE_ARGS,
    }, ["repo"], "read"),
    t("issue_view", "One issue with its body.", { ...REPO_ARG, number: { type: "integer" } }, ["repo", "number"], "read"),
    t("issue_comments", "Comments on an issue or pull request.", { ...REPO_ARG, number: { type: "integer" }, ...PAGE_ARGS }, ["repo", "number"], "read"),
    t("issue_create", "Open an issue. Not idempotent — calling twice opens two.", {
      ...REPO_ARG, title: { type: "string" }, body: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
    }, ["repo", "title"], "write"),
    t("issue_comment", "Add a comment to an issue or pull request. Not idempotent.", {
      ...REPO_ARG, number: { type: "integer" }, body: { type: "string" },
    }, ["repo", "number", "body"], "write"),
    t("issue_close", "Close an issue, optionally as not planned.", {
      ...REPO_ARG, number: { type: "integer" },
      reason: { type: "string", enum: ["completed", "not_planned"] },
    }, ["repo", "number"], "write"),

    // Subscriptions choose which webhook events wake the agent. They do not
    // create the webhook: that needs admin rights on the repository, so for now
    // a person adds it in the repository's settings with this mount's inbound
    // URL and secret. Both are writes, so a mount's policy can hold them.
    t("issue_subscribe", "Be told when something happens on an issue, or on any issue or pull request in a repository if number is omitted: opened, edited, closed, reopened, commented. Events arrive as messages, with no need to poll. Needs a webhook on the repository pointing at this mount, which a person adds; issue_subscriptions shows whether one has reached it.", {
      ...REPO_ARG, number: { type: "integer", description: "omit to hear about every issue and pull request in the repository" },
    }, ["repo"], "write", "native"),
    t("issue_unsubscribe", "Stop being told about an issue, or about a repository if number is omitted. Removes exactly the subscription named.", {
      ...REPO_ARG, number: { type: "integer" },
    }, ["repo"], "write", "native"),
    t("issue_subscriptions", "What this mount is subscribed to, and when GitHub last reached it.", {}, [], "read"),

    t("pr_list", "Pull requests in a repository.", {
      ...REPO_ARG, state: { type: "string", enum: ["open", "closed", "all"] }, ...PAGE_ARGS,
    }, ["repo"], "read"),
    t("pr_view", "One pull request: body, merge state, and how large the diff is.", { ...REPO_ARG, number: { type: "integer" } }, ["repo", "number"], "read"),
    t("pr_diff", "The files a pull request touches, with per-file line counts. Patch text is omitted unless asked for, because it is large.", {
      ...REPO_ARG, number: { type: "integer" },
      patch: { type: "boolean", description: "include the diff text for each file" },
      ...PAGE_ARGS,
    }, ["repo", "number"], "read"),
    t("pr_checks", "CI status for a pull request's head commit — what `gh pr checks` answers.", { ...REPO_ARG, number: { type: "integer" } }, ["repo", "number"], "read"),
    t("pr_status", "Pull requests involving this account across GitHub: authored, review-requested, assigned.", {}, [], "read"),

    t("file_view", "A file's contents at a ref. Text only; a binary is refused rather than returned as base64 noise. A directory lists its entries.", {
      ...REPO_ARG, path: { type: "string" },
      ref: { type: "string", description: "branch, tag or sha; defaults to the default branch" },
    }, ["repo", "path"], "read"),
    t("commit_list", "Recent commits on a branch or path.", {
      ...REPO_ARG, sha: { type: "string", description: "branch or sha" }, path: { type: "string" }, ...PAGE_ARGS,
    }, ["repo"], "read"),
    t("run_list", "Recent Actions workflow runs.", {
      ...REPO_ARG, branch: { type: "string" },
      status: { type: "string", enum: ["queued", "in_progress", "completed", "failure", "success"] },
      ...PAGE_ARGS,
    }, ["repo"], "read"),

    t("search_code", "Search code across GitHub. Needs an account.", {
      query: { type: "string", description: 'code-search syntax, e.g. "repo:owner/name addEventListener"' }, ...PAGE_ARGS,
    }, ["query"], "read"),
    t("search_issues", "Search issues and pull requests across GitHub.", {
      query: { type: "string", description: 'e.g. "repo:owner/name is:open label:bug"' }, ...PAGE_ARGS,
    }, ["query"], "read"),

    // Two tools rather than one, because `sideEffects` is a property of the
    // tool and the gateway reads it to decide whether a call waits for a
    // person. One `api` that could GET or POST had to declare the wider of the
    // two, so reading a label through it was held for approval exactly as
    // deleting one was — which is a gate nobody wants and everybody learns to
    // wave through. Splitting them lets each declare what it actually is.
    t("api_get", "Read any GitHub REST endpoint, the way `gh api` does — for what the read tools above do not cover. Path only, no host, no body. Works without an account on public data. A text answer, such as a job's logs, comes back as { contentType, text }.", {
      path: { type: "string", description: '"/repos/owner/name/labels" — leading slash, no host' },
    }, ["path"], "read"),
    t("api", "Write to any GitHub REST endpoint — POST, PATCH, PUT or DELETE, for what the write tools above do not cover. Path only, no host. Needs an account, is not idempotent, and a mount may hold it for a person. To read, use api_get.", {
      path: { type: "string", description: '"/repos/owner/name/labels" — leading slash, no host' },
      method: { type: "string", enum: ["POST", "PATCH", "PUT", "DELETE"] },
      body: { type: "object", description: "JSON body" },
    }, ["path", "method"], "write"),
  ],

  /**
   * The same question `auth_status` answers, asked by the person configuring
   * the mount rather than by the agent using it. A token that is expired,
   * revoked, or simply the wrong one of several is indistinguishable from a
   * working one until something is called with it; here it costs one request
   * while the person still remembers which key they pasted.
   */
  async checkCredential(ctx) {
    if (!ctx.credential) {
      return { ok: false as const, kind: "rejected" as const, reason: "no token — this mount can only read public data" };
    }
    try {
      const u = await call("GET", "/user", ctx);
      return { ok: true as const, account: u.login };
    } catch (e) {
      const reason = String((e as Error)?.message ?? e);
      // Only an answer counts as a rejection. `call` puts the status in the
      // message, so 401 and 403 are GitHub saying no; a 500, a rate limit or a
      // fetch that never arrived are no verdict at all, and the token is not
      // the thing at fault in any of them.
      const status = Number(/^github (\d{3}):/.exec(reason)?.[1] ?? 0);
      const rejected = status === 401 || (status === 403 && !/rate limit/i.test(reason));
      return { ok: false as const, kind: rejected ? "rejected" as const : "unreachable" as const, reason };
    }
  },

  /**
   * A repository webhook delivery. See `receive` in `types.ts` for the rules;
   * what is GitHub's own is below.
   */
  async receive(event, secret, ctx) {
    const signature = event.headers["x-hub-signature-256"];
    // A webhook saved without a secret sends no signature at all, and then
    // anyone who learns the URL can speak for GitHub.
    if (!signature) {
      return { deliver: false, rejected: true, reason: "unsigned: the webhook has no secret set, so the sender cannot be checked" };
    }
    if (!(await validGithubSignature(event.body, signature, secret))) {
      return { deliver: false, rejected: true, reason: "the signature does not match this mount's inbound secret" };
    }
    let p: any;
    try { p = payloadOf(event); } catch {
      return { deliver: false, rejected: true, reason: "signed, but the body is not a GitHub payload" };
    }

    const kind = event.headers["x-github-event"] ?? "";
    const inbound = await inboundOf(ctx);
    // Any signed delivery proves the webhook reaches this mount, which is the
    // thing a person setting one up needs to know; a ping is only the first.
    inbound.lastReached = { at: Date.now(), event: kind };
    await saveInbound(ctx, inbound);
    if (kind === "ping") return { deliver: false, reason: "ping: the webhook reaches this mount" };

    const actions = kind === "issues" ? ISSUE_ACTIONS : kind === "issue_comment" ? COMMENT_ACTIONS : null;
    if (!actions) return { deliver: false, reason: `${kind || "an unnamed"} event: not one this plugin delivers` };
    if (!actions.has(p?.action)) return { deliver: false, reason: `${kind} ${p?.action}: not an action worth waking the agent for` };

    const repo = String(p?.repository?.full_name ?? "");
    const issue = p?.issue ?? {};
    const number = Number(issue.number);
    const sender = String(p?.sender?.login ?? "");
    if (!inbound.subscriptions.some((s) => sameRepo(s.repo, repo) && (s.number === null || s.number === number))) {
      return { deliver: false, reason: `${repo}#${number}: not subscribed` };
    }
    if (ctx.credential && inbound.login === null) {
      // An account was attached after the subscription was made, so this
      // mount can now write and does not know under which name. Delivering
      // would let its own comments wake it.
      return { deliver: false, reason: "an account was attached after subscribing; subscribe again so the mount knows its own name" };
    }
    if (inbound.login && sender.toLowerCase() === inbound.login.toLowerCase()) {
      return { deliver: false, reason: `${repo}#${number}: caused by this mount's own account` };
    }

    const what = issue.pull_request ? "pull request" : "issue";
    const head = `GitHub ${repo}#${number} (${what} "${clip(issue.title, TITLE_CHARS)}")`;
    const lines = kind === "issues"
      ? [`${head}: ${what} ${p.action} by @${sender}`, ...(p.action === "opened" || p.action === "edited" ? [quote(issue.body)] : [])]
      : [`${head}: comment ${p.action} by @${sender}`, ...(p.action === "deleted" ? [] : [quote(p?.comment?.body)])];
    const url = kind === "issue_comment" ? p?.comment?.html_url : issue.html_url;
    if (url) lines.push(String(url));
    const dedupeKey = event.headers["x-github-delivery"];
    return { deliver: true, text: lines.filter(Boolean).join("\n"), ...(dedupeKey ? { dedupeKey } : {}) };
  },

  async invoke(name, args, ctx): Promise<Json> {
    const a = (args ?? {}) as Record<string, any>;
    switch (name) {
      case "auth_status": {
        // The one tool whose subject is the identity itself, so having none is
        // an answer rather than a failure — `gh auth status`, which this names,
        // prints "not logged in" instead of refusing. Under `requireAccount` an
        // agent asking "who am I here?" was told its question was invalid, and
        // could not tell that apart from a call it had got wrong (a fresh agent
        // via Vera, 2026-09-13).
        if (!ctx.credential) {
          return {
            authenticated: false,
            account: null,
            note: "no account is attached to this mount, so it reads public data only; a person attaches one",
          };
        }
        const u = await call("GET", "/user", ctx);
        return { authenticated: true, login: u.login, name: u.name, type: u.type, id: u.id };
      }

      case "repo_view":
        return repoOut(await call("GET", `/repos/${repoOf(a)}`, ctx)) as Json;

      case "issue_list": {
        const q = paging(a);
        q.set("state", a.state ?? "open");
        if (a.labels) q.set("labels", String(a.labels));
        if (a.assignee) q.set("assignee", String(a.assignee));
        return ((await call("GET", `/repos/${repoOf(a)}/issues?${q}`, ctx)) ?? []).map(issueOut) as Json;
      }
      case "issue_view": {
        const i = await call("GET", `/repos/${repoOf(a)}/issues/${Number(a.number)}`, ctx);
        return { ...issueOut(i), body: i.body } as Json;
      }
      case "issue_comments":
        return ((await call("GET",
          `/repos/${repoOf(a)}/issues/${Number(a.number)}/comments?${paging(a)}`, ctx)) ?? [])
          .map(commentOut) as Json;
      case "issue_create": {
        requireAccount(ctx, "issue_create");
        const i = await call("POST", `/repos/${repoOf(a)}/issues`, ctx, {
          title: String(a.title), body: a.body ?? undefined,
          labels: Array.isArray(a.labels) ? a.labels : undefined,
        });
        return { number: i.number, url: i.html_url } as Json;
      }
      case "issue_comment": {
        requireAccount(ctx, "issue_comment");
        const c = await call("POST", `/repos/${repoOf(a)}/issues/${Number(a.number)}/comments`,
          ctx, { body: String(a.body) });
        return { id: c.id, url: c.html_url } as Json;
      }
      case "issue_close": {
        requireAccount(ctx, "issue_close");
        const i = await call("PATCH", `/repos/${repoOf(a)}/issues/${Number(a.number)}`, ctx, {
          state: "closed",
          state_reason: a.reason === "not_planned" ? "not_planned" : "completed",
        });
        return { number: i.number, state: i.state } as Json;
      }

      case "issue_subscribe": {
        const repo = repoOf(a);
        const number = issueNumberOf(a);
        const inbound = await inboundOf(ctx);
        // Re-read on every subscription: the account attached to a mount can
        // change, and the loop guard is only as good as this name. If it
        // cannot be learnt, nothing is subscribed — a subscription that cannot
        // recognise the mount's own comments would answer them for ever.
        inbound.login = ctx.credential ? (await call("GET", "/user", ctx)).login : null;
        const exists = inbound.subscriptions.some((s) => sameRepo(s.repo, repo) && s.number === number);
        if (!exists) {
          if (inbound.subscriptions.length >= MAX_SUBSCRIPTIONS) {
            throw new Error(`this mount already has ${MAX_SUBSCRIPTIONS} subscriptions; remove one with issue_unsubscribe first`);
          }
          inbound.subscriptions.push({ repo, number });
        }
        await saveInbound(ctx, inbound);
        return {
          subscribed: { repo, number },
          alreadySubscribed: exists,
          lastReached: inbound.lastReached ? new Date(inbound.lastReached.at).toISOString() : null,
          note: inbound.lastReached
            ? "events arrive as messages; nothing to poll"
            : "no webhook has reached this mount yet — a person adds one on the repository with this mount's inbound URL and secret, and until then nothing arrives",
        } as Json;
      }
      case "issue_unsubscribe": {
        const repo = repoOf(a);
        const number = issueNumberOf(a);
        const inbound = await inboundOf(ctx);
        const before = inbound.subscriptions.length;
        inbound.subscriptions = inbound.subscriptions.filter((s) => !(sameRepo(s.repo, repo) && s.number === number));
        await saveInbound(ctx, inbound);
        return {
          removed: before !== inbound.subscriptions.length,
          remaining: inbound.subscriptions as unknown as Json,
        } as Json;
      }
      case "issue_subscriptions": {
        const inbound = await inboundOf(ctx);
        return {
          subscriptions: inbound.subscriptions as unknown as Json,
          account: inbound.login,
          lastReached: inbound.lastReached ? new Date(inbound.lastReached.at).toISOString() : null,
        } as Json;
      }

      case "pr_list": {
        const q = paging(a);
        q.set("state", a.state ?? "open");
        return ((await call("GET", `/repos/${repoOf(a)}/pulls?${q}`, ctx)) ?? []).map(prOut) as Json;
      }
      case "pr_view": {
        const p = await call("GET", `/repos/${repoOf(a)}/pulls/${Number(a.number)}`, ctx);
        return { ...prOut(p), body: p.body } as Json;
      }
      case "pr_diff": {
        const files = await call("GET",
          `/repos/${repoOf(a)}/pulls/${Number(a.number)}/files?${paging(a)}`, ctx);
        return (files ?? []).map((f: any) => ({
          path: f.filename, status: f.status,
          additions: f.additions, deletions: f.deletions,
          ...(a.patch ? { patch: f.patch } : {}),
        })) as Json;
      }
      case "pr_checks": {
        const p = await call("GET", `/repos/${repoOf(a)}/pulls/${Number(a.number)}`, ctx);
        const r = await call("GET",
          `/repos/${repoOf(a)}/commits/${p.head?.sha}/check-runs?per_page=${MAX_PER_PAGE}`, ctx);
        const runs = (r?.check_runs ?? []).map((c: any) => ({
          name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url,
        }));
        return {
          sha: String(p.head?.sha ?? "").slice(0, 12),
          // The summary first: an agent asking about checks wants to know
          // whether it can merge, not to read forty rows to find out.
          failing: runs.filter((c: any) =>
            c.conclusion && c.conclusion !== "success" && c.conclusion !== "neutral").length,
          pending: runs.filter((c: any) => c.status !== "completed").length,
          total: runs.length, runs,
        } as Json;
      }
      case "pr_status": {
        requireAccount(ctx, "pr_status");
        const me = (await call("GET", "/user", ctx)).login;
        const search = async (q: string) =>
          ((await call("GET", `/search/issues?q=${encodeURIComponent(q)}&per_page=20`, ctx))?.items ?? [])
            .map(issueOut);
        return {
          login: me,
          authored: await search(`is:open is:pr author:${me}`),
          reviewRequested: await search(`is:open is:pr review-requested:${me}`),
          assigned: await search(`is:open is:pr assignee:${me}`),
        } as Json;
      }

      case "file_view": {
        const q = a.ref ? `?ref=${encodeURIComponent(String(a.ref))}` : "";
        const path = String(a.path ?? "").replace(/^\/+/, "");
        const f = await call("GET",
          `/repos/${repoOf(a)}/contents/${path.split("/").map(encodeURIComponent).join("/")}${q}`, ctx);
        if (Array.isArray(f)) {
          return { directory: f.map((e: any) => ({ name: e.name, type: e.type, size: e.size })) } as Json;
        }
        if (f.encoding !== "base64" || typeof f.content !== "string") {
          throw new Error(`${a.path} is not a text file this tool can return`);
        }
        const text = Buffer.from(f.content, "base64").toString("utf8");
        if (text.includes(NUL)) throw new Error(`${a.path} is binary`);
        return { path: f.path, sha: String(f.sha ?? "").slice(0, 12), size: f.size, text } as Json;
      }
      case "commit_list": {
        const q = paging(a);
        if (a.sha) q.set("sha", String(a.sha));
        if (a.path) q.set("path", String(a.path));
        return ((await call("GET", `/repos/${repoOf(a)}/commits?${q}`, ctx)) ?? []).map(commitOut) as Json;
      }
      case "run_list": {
        const q = paging(a);
        if (a.branch) q.set("branch", String(a.branch));
        if (a.status) q.set("status", String(a.status));
        const r = await call("GET", `/repos/${repoOf(a)}/actions/runs?${q}`, ctx);
        return { total: r?.total_count, runs: (r?.workflow_runs ?? []).map(runOut) } as Json;
      }

      case "search_code": {
        requireAccount(ctx, "search_code");
        const q = paging(a);
        q.set("q", String(a.query ?? ""));
        const r = await call("GET", `/search/code?${q}`, ctx);
        return {
          total: r.total_count,
          items: (r.items ?? []).map((i: any) => ({
            repo: i.repository?.full_name, path: i.path, url: i.html_url,
          })),
        } as Json;
      }
      case "search_issues": {
        const q = paging(a);
        q.set("q", String(a.query ?? ""));
        const r = await call("GET", `/search/issues?${q}`, ctx);
        return { total: r.total_count, items: (r.items ?? []).map(issueOut) } as Json;
      }

      case "api_get":
        return (await call("GET", apiPath(a.path), ctx, undefined, { text: true })) as Json;

      case "api": {
        const method = String(a.method ?? "").toUpperCase();
        // GET is refused rather than quietly served, because serving it here
        // would run a read under this tool's `write` declaration and hold it
        // for a person — the thing the split exists to stop.
        if (method === "GET" || method === "HEAD") {
          throw new Error(`api is for writes; read with api_get { path: ${JSON.stringify(String(a.path ?? "/…"))} }`);
        }
        if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
          throw new Error("method must be one of POST, PATCH, PUT, DELETE");
        }
        requireAccount(ctx, "api");
        return (await call(method, apiPath(a.path), ctx, a.body ?? {})) as Json;
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  },
};
