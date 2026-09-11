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

async function call(method: string, path: string, ctx: PluginContext, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "antiproton/0.1",
  };
  // Credential injection happens here, at dispatch, never in the JS sandbox.
  if (ctx.credential) headers.authorization = `Bearer ${ctx.credential}`;
  if (body !== undefined) headers["content-type"] = "application/json";

  const res = await fetch(API + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const remaining = res.headers.get("x-ratelimit-remaining");
    const reset = res.headers.get("x-ratelimit-reset");
    // A 403 here is nearly always the rate limit rather than permission, and
    // the two want completely different reactions from the agent.
    const rate = remaining === "0" && reset
      ? ` — rate limit exhausted, resets ${new Date(Number(reset) * 1000).toISOString()}`
      : "";
    const err = new Error(
      `github ${res.status}: ${parsed?.message ?? res.statusText}${rate}`,
    ) as Error & { retryable?: boolean };
    err.retryable = res.status === 429 || (res.status === 403 && remaining === "0") || res.status >= 500;
    throw err;
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
  version: "2.0.0",
  credential: {
    // Optional, not absent: without a token this mount still reads public
    // repositories, which is what the `gh_public` mount is for. Declaring it
    // optional is what lets a console show "connected" against one mount and
    // "public only" against another instead of showing both the same.
    required: false,
    summary: "A GitHub personal access token, or a GitHub App installation token.",
    shape: "token",
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

    t("api", "Any GitHub REST endpoint, the way `gh api` works — for what the tools above do not cover. Path only, no host. Non-GET methods need an account and are not idempotent.", {
      path: { type: "string", description: '"/repos/owner/name/labels" — leading slash, no host' },
      method: { type: "string", enum: ["GET", "POST", "PATCH", "PUT", "DELETE"] },
      body: { type: "object", description: "JSON body for non-GET methods" },
    }, ["path"], "write"),
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

  async invoke(name, args, ctx): Promise<Json> {
    const a = (args ?? {}) as Record<string, any>;
    switch (name) {
      case "auth_status": {
        requireAccount(ctx, "auth_status");
        const u = await call("GET", "/user", ctx);
        return { login: u.login, name: u.name, type: u.type, id: u.id };
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

      case "api": {
        const method = String(a.method ?? "GET").toUpperCase();
        if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) {
          throw new Error("method must be one of GET, POST, PATCH, PUT, DELETE");
        }
        if (method !== "GET") requireAccount(ctx, "api");
        const path = String(a.path ?? "");
        // A path, not a URL: the host is ours to decide, so no amount of
        // creativity in this argument reaches another origin.
        if (!path.startsWith("/") || path.startsWith("//")) {
          throw new Error(
            `path must begin with a single "/" and carry no host, got ${JSON.stringify(path).slice(0, 60)}`,
          );
        }
        return (await call(method, path, ctx, method === "GET" ? undefined : (a.body ?? {}))) as Json;
      }

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  },
};
