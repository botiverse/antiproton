/**
 * Stamp, as a mount: the control plane of an agent's pull requests.
 *
 * Stamp is the Git gateway Raft agents push through: an agent pushes, gets a
 * receipt, opens the pull request from that receipt, and a person reviews and
 * merges in Stamp. `stamp` (the Go CLI) is the interface a Node agent uses;
 * this plugin is the same surface for an agent running in antiproton, whose
 * container may never exist.
 *
 * **The control plane needs no container.** Measured 2026-10-23 by pointing the
 * CLI at a local server and recording what it sent: every command below is
 * plain HTTPS + JSON, carrying the agent's session as `Authorization: Bearer …`.
 * So this is a `fetch` plugin like `github.ts`, not a sandbox tool like
 * `sandbox.ts`.
 *
 * **The session rotates, and that decides the shape of this file.** Stamp's
 * agent access token lives 15 minutes and every refresh rotates both tokens
 * (botiverse/stamp `internal/store/crypto.go`, `agentAccessTTL`, as of server-v0.1.191), so a mount that sends one fixed credential stops
 * working a quarter of an hour after it is supplied. The session is therefore
 * kept sealed in this mount's own database, refreshed here, and written back
 * before it is used — the same rule `@botiverse/stamp-sdk/client`'s
 * `injectedAgentAuth` enforces, done here because the sealing key is
 * `raft-agent-login.ts`'s and the rotation has to survive the mount.
 *
 * **A refresh token is single-use, and reusing a rotated one is destructive:**
 * the gateway answers `refresh_reused` and revokes *every* refresh token that
 * agent holds for that service, on every machine. So the session a person gives
 * this mount must be a dedicated login that no CLI keeps using, and those two
 * codes are reported as what they are rather than retried.
 *
 * **Push is not here.** It needs a working tree; `sandboxForm` below gives the
 * container `git` over Stamp's HTTPS endpoint, with the session swapped in by
 * the egress proxy, so the container never holds it.
 */
import type { Json } from "../core/types.ts";
import { openText, sealText } from "./raft-agent-login.ts";
import type { CredentialCheck, Plugin, PluginContext, ToolSchema } from "./types.ts";
import { credentialState, identityNote, markIdentity } from "./types.ts";

/** The one host this plugin talks to. See `sandboxForm` for why it is not a setting. */
const ORIGIN = "https://stamp.build";
/** Stamp caps page size itself; clamping makes the limit visible in the schema. */
const MAX_LIMIT = 100;
/** Where a mount keeps its rotating session: one row, sealed, never listed. */
export const SESSION_STORE = "stampSession";
const SESSION_KEY = "session";
/** Separates this mount's seal from the Connected App sessions the same key seals. */
const SEAL_INFO = "antiproton stamp agent session v1";
/** An access token this close to expiry is refreshed before it is sent, as the SDK does. */
export const REFRESH_SKEW_MS = 60_000;

/**
 * `raft-cli-agent-session.v1`: what `stamp login` keeps, and what a person hands
 * this mount. Only the fields this plugin reads are named; anything else the
 * gateway adds is carried through untouched, because a refresh replaces the
 * whole object.
 */
export interface AgentSession {
  schema?: string;
  access_token: string;
  refresh_token: string;
  token_type?: string;
  access_expires_at?: string;
  refresh_expires_at?: string;
  [k: string]: unknown;
}

/** The session in a value a person supplied, or null when it is not one. */
export function parseSession(value: unknown): AgentSession | null {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.access_token !== "string" || s.access_token === "") return null;
  if (typeof s.refresh_token !== "string" || s.refresh_token === "") return null;
  return s as AgentSession;
}

/** Whether a session's access token is close enough to expiry to refresh first. */
function needsRefresh(session: AgentSession, now: number, skewMs: number): boolean {
  const at = Date.parse(String(session.access_expires_at ?? ""));
  // No expiry named: use it. A wrong guess costs one refused call, and that call
  // already retries through a rotation.
  if (!Number.isFinite(at)) return false;
  return at - now <= skewMs;
}

/**
 * Rotations in flight, one per mount. A refresh token is single-use, so two
 * concurrent calls that both rotated would make one of them `refresh_reused` —
 * which revokes every token that agent holds. Keyed by the mount's place rather
 * than by the object, because the same plugin serves every mount in the isolate.
 */
const inflight = new Map<string, Promise<AgentSession>>();
const inlineKey = (ctx: PluginContext) => `${ctx.caller.tenantId}\u0000${ctx.caller.agentId}\u0000${ctx.alias}`;

/**
 * The session this mount acts with: the rotated one it keeps, else the one its
 * credential carries.
 *
 * The stored row is sealed under a key derived from the *credential*, so a
 * credential replaced or removed opens none of the rows kept under it and the
 * mount falls back to the new value — which is right: the old session belonged
 * to the identity the old credential named.
 */
export async function loadSession(ctx: PluginContext): Promise<AgentSession | null> {
  const row = await ctx.db.get(SESSION_STORE, SESSION_KEY).catch(() => null);
  const sealed = row && typeof row === "object" ? row as Record<string, unknown> : null;
  if (sealed && typeof sealed.iv === "string" && typeof sealed.ciphertext === "string") {
    const plain = await openText(ctx, SEAL_INFO, { iv: sealed.iv, ciphertext: sealed.ciphertext }, SESSION_KEY);
    const s = plain === null ? null : parseSession(plain);
    if (s) return s;
  }
  return parseSession(ctx.credential);
}

/** Keep a rotated session, or refuse to go on: it is never used unstored. */
async function storeSession(ctx: PluginContext, session: AgentSession): Promise<void> {
  const sealed = await sealText(ctx, SEAL_INFO, JSON.stringify(session), SESSION_KEY);
  await ctx.db.put(SESSION_STORE, sealed as unknown as Json, SESSION_KEY);
}

/**
 * One rotation, shared by every call that needs it.
 *
 * `POST /api/auth/agent/refresh` is a closed body — no session header, no Raft
 * credential (`agentRefresh` in botiverse/stamp `internal/gateway/agent_cli_login.go`, as of server-v0.1.191) — so a
 * mount that holds a refresh token can rotate without a person present.
 */
async function rotate(ctx: PluginContext, used: AgentSession): Promise<AgentSession> {
  const key = inlineKey(ctx);
  const running = inflight.get(key);
  if (running) return running;

  const job = (async () => {
    const res = await fetch(new URL("/api/auth/agent/refresh", ORIGIN), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": "antiproton/0.1" },
      body: JSON.stringify({ schema: "raft-cli-agent-refresh.v1", refresh_token: used.refresh_token }),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { body = { text: text.slice(0, 500) }; }

    if (!res.ok) {
      const code = String(body.error ?? body.code ?? body.errorCode ?? "");
      // Not retried, and said in the only terms that help: somebody has to act.
      if (code === "refresh_reused" || code === "refresh_revoked") {
        throw new Error(
          `stamp: this session's refresh token was already used elsewhere or has been revoked (${code}), and the gateway ` +
          "revokes every token that agent holds for the service when that happens — including other machines. " +
          "A person needs to sign in again for this mount alone and give it that session; do not retry.",
        );
      }
      throw new Error(`stamp: could not refresh the session (${res.status}${code ? ` ${code}` : ""}) — ` +
        `${String(body.message ?? body.text ?? "").slice(0, 300)}`.trim());
    }

    const next = parseSession({ ...body, access_token: body.access_token ?? (body as any).accessToken,
      refresh_token: body.refresh_token ?? (body as any).refreshToken });
    if (!next) throw new Error("stamp: the refresh answered something that is not a session; nothing was stored");

    // Before it is used, always: a rotation that cannot be kept would leave the
    // caller holding a token the next call cannot rotate again.
    await storeSession(ctx, next);
    return next;
  })().finally(() => { inflight.delete(key); });

  inflight.set(key, job);
  return job;
}

/**
 * Why there is nothing to act as, in the terms the mount's own state calls for: the state goes in
 * the fields and the sentence together (markIdentity, identityNote), as every plugin with a
 * credential reports it. An attached credential that is not a session is told what it is not; a
 * missing one is told what to attach; an unreadable one gets no advice, since identityNote already
 * says who has to act.
 */
function noSession(ctx: PluginContext): Error {
  const state = credentialState(ctx);
  const what = state === "attached"
    ? "What it holds is not a Stamp agent session: this needs the JSON `stamp login` keeps " +
      "(access_token and refresh_token), not a cookie or a GitHub token"
    : state === "none" || state === "unreported"
      ? "Give it the JSON `stamp login` keeps (access_token and refresh_token), signed in for this mount alone — " +
        "a session shared with a CLI is revoked the first time both refresh"
      : "";
  return markIdentity(new Error(`stamp: nothing to act as — ${identityNote(ctx)}${what ? `. ${what}` : ""}`), ctx);
}

/** The access token to send now, rotating first when it is due. */
async function accessToken(ctx: PluginContext, fresh: boolean): Promise<{ token: string; session: AgentSession }> {
  const session = await loadSession(ctx);
  if (!session) {
    throw noSession(ctx);
  }
  if (!fresh && !needsRefresh(session, Date.now(), REFRESH_SKEW_MS)) {
    return { token: session.access_token, session };
  }
  const next = await rotate(ctx, session);
  return { token: next.access_token, session: next };
}

/**
 * Tools whose answer is a list of pull requests or receipts: the fields an
 * agent asks the next question with, and not the whole gateway object.
 *
 * The same reasoning as `github.ts`'s projections: a Stamp pull request carries
 * receipts, checks, verdicts and review state, most of which is not what a
 * caller needs to decide its next call, and returning it whole is how a context
 * fills up with fields nobody reads.
 */
function prOut(p: any): Record<string, Json> {
  return {
    number: p?.number,
    title: p?.title,
    state: p?.state,
    repository: p?.repository,
    headRef: p?.headRef ?? p?.head_ref,
    baseRef: p?.baseRef ?? p?.base_ref,
    headSha: p?.headSha ?? p?.head_sha,
    url: p?.url ?? p?.htmlUrl ?? p?.html_url,
    // Stamp's own page, which shows review state and receipts that github.com does not.
    stampUrl: p?.stampUrl ?? p?.stamp_url,
    verdict: p?.verdict ?? undefined,
    merged: p?.merged ?? undefined,
    author: p?.author ?? undefined,
  };
}

function receiptOut(r: any): Record<string, Json> {
  return {
    id: r?.id,
    status: r?.status,
    repository: r?.repository,
    branch: r?.branch,
    sha: r?.sha ?? r?.headSha,
    publishedSha: r?.publishedSha ?? r?.published_sha,
    createdAt: r?.createdAt ?? r?.created_at,
  };
}

/**
 * A path in this gateway, never a URL: the host is ours to decide, so no
 * argument can reach another origin. `stamp api` is the one tool that forwards
 * to GitHub's own API, and it is held to the same rule.
 */
function gatewayPath(raw: unknown, allowed: readonly string[]): string {
  const path = String(raw ?? "");
  if (!path.startsWith("/") || path.startsWith("//") || /^[a-z]+:/i.test(path)) {
    throw new Error(`path must start with ${allowed.join(" or ")} and carry no host, got ${JSON.stringify(path).slice(0, 60)}`);
  }
  if (!allowed.some((p) => path.startsWith(p))) {
    throw new Error(`path must start with ${allowed.join(" or ")}, got ${JSON.stringify(path).slice(0, 60)}`);
  }
  return path;
}

function repoOf(args: Record<string, any>): { owner: string; repo: string } {
  const full = String(args.repo ?? "");
  const m = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(full);
  if (!m) throw new Error(`repo must be "owner/name", got ${JSON.stringify(full).slice(0, 40)}`);
  return { owner: m[1], repo: m[2] };
}

const prBase = (a: Record<string, any>) => {
  const { owner, repo } = repoOf(a);
  const n = Number(a.number);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`number must be a pull request number, got ${JSON.stringify(a.number)}`);
  return `/v1/repositories/${owner}/${repo}/pulls/${n}`;
};

/**
 * One request to the gateway, with the mount's session attached here and never
 * in the JS sandbox. A 401 rotates once and retries once: the token may have
 * been rotated by another call between reading it and sending it.
 */
async function call(method: string, path: string, ctx: PluginContext, body?: unknown): Promise<any> {
  const send = async (token: string) => {
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "antiproton/0.1" };
    headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetch(new URL(ORIGIN + path), {
      method, headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
  };

  let { token } = await accessToken(ctx, false);
  let res = await send(token);
  if (res.status === 401) {
    const rotated = await accessToken(ctx, true);
    if (rotated.token !== token) {
      token = rotated.token;
      res = await send(token);
    }
  }

  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { text: text.slice(0, 2_000) }; }

  if (!res.ok) {
    // The gateway's own stable code (SESSION_REQUIRED, AGENT_PRINCIPAL_REQUIRED,
    // SELF_APPROVAL_NOT_ALLOWED …) is what a caller branches on, so it goes into
    // the message verbatim rather than being flattened into "HTTP 4xx".
    const code = parsed?.errorCode ?? parsed?.error ?? parsed?.code;
    const detail = typeof code === "string" ? `${code}: ` : "";
    const message = parsed?.message ?? parsed?.error_description ?? parsed?.text ?? "";
    throw new Error(`${method} ${path} refused ${res.status}: ${detail}${String(message).slice(0, 300)}`);
  }
  return parsed;
}

const t = (
  name: string, summary: string, properties: Record<string, unknown>,
  required: string[], sideEffects: "read" | "write",
  idempotency: "native" | "key" | "none" = sideEffects === "read" ? "native" : "none",
): ToolSchema => ({
  name, summary, parameters: { type: "object", properties, required } as Json,
  sideEffects, idempotency,
});

const REPO_ARG = { repo: { type: "string", description: 'owner/name, e.g. "botiverse/antiproton"' } };
const PR_NUMBER = { number: { type: "integer", description: "the pull request number in that repository" } };
const LIMIT_ARG = { limit: { type: "integer", description: `max ${MAX_LIMIT}` } };
const HEAD_ARG = {
  head: { type: "string", description: "the exact head SHA this answer is about; an approval counts for one commit" },
  base: { type: "string", description: "the exact base SHA" },
};

export const stampPlugin: Plugin = {
  id: "stamp",
  version: "1.0.0",
  /**
   * The rotating session. Not `listed`: it exists, and that it exists is
   * listable, never what is in it.
   */
  database: { version: 1, stores: { [SESSION_STORE]: {} } },
  credential: {
    required: true,
    summary: "A Stamp agent session: the JSON `stamp login` keeps (access_token, refresh_token, access_expires_at), signed in for this mount alone.",
    shape: "token",
    grants:
      "acting on the pull requests of this server under the agent's own Stamp identity: reading them, opening one from a " +
      "receipt, commenting. Merging and approving need a person, or an approval at the exact head.",
    docs: "https://docs.stamp.build/agents/setup.md",
  },
  config: [],
  /**
   * `git` in the agent's container, as this mount's agent, over Stamp's HTTPS
   * git endpoint.
   *
   * Measured on stamp.build 2026-10-23: `git ls-remote` with `credential.helper`
   * emptied and only `http.https://stamp.build/.extraHeader=Authorization:
   * Bearer <session>` succeeds, and `info/refs?service=git-receive-pack` answers
   * 200 with that header and 401 without it. The egress proxy substitutes the
   * session for the placeholder on the way out, so the container never holds it.
   *
   * The `_0` index below is not a claim on that slot: `sandbox.ts` numbers every
   * wired form's git settings again across the container, which is what lets
   * this form sit beside github's credential helper.
   *
   * **The host is fixed, and that is a limitation.** `sandboxForm` is static, so
   * a mount of a self-hosted Stamp would claim `stamp.build` and reach nothing.
   * Supporting one needs `sandboxForm` to be a function of the mount; until it
   * is, this plugin speaks to stamp.build only, which is why it has no `url`
   * setting (a setting the container form cannot honour is worse than none).
   */
  sandboxForm: {
    summary:
      "git over HTTPS to stamp.build works here as this agent's Stamp identity: `git clone https://stamp.build/github/OWNER/REPO.git`, " +
      "and `git push` from a checkout prepared with `stamp repo use --https` (install the CLI from https://stamp.build/install.sh if it is missing).",
    egress: [{
      name: "STAMP_SESSION",
      header: "authorization",
      hosts: ["stamp.build"],
      value: (session: string) => `Bearer ${session}`,
      placeholder: (p: string) => `Bearer ${p}`,
    }],
    env: (p) => ({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://stamp.build/.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Bearer ${p}`,
    }),
  },
  tools: [
    t("whoami", "Which agent this mount acts as on Stamp: handle, server, the commit email a push must be committed by, and whether this instance serves git over HTTPS.",
      {}, [], "read"),

    t("receipt_get", "One push receipt: whether the gateway accepted it and whether GitHub has published it. A pull request is opened from a published receipt.",
      { id: { type: "string" } }, ["id"], "read"),
    t("receipt_list", "This agent's own push receipts, newest first.",
      { ...REPO_ARG, ...LIMIT_ARG }, [], "read"),

    t("pr_list", "Pull requests in a repository, or with no repo the ones this agent has open, grouped by what each needs next.",
      { ...REPO_ARG, state: { type: "string", enum: ["open", "closed", "all"] }, ...LIMIT_ARG }, [], "read"),
    t("pr_view", "One pull request: body, state, verdict, and the exact head commit an approval would count for.",
      { ...REPO_ARG, ...PR_NUMBER }, ["repo", "number"], "read"),
    t("pr_diff", "The files a pull request touches, with per-file line counts. Patch text is omitted unless asked for, because it is large.",
      { ...REPO_ARG, ...PR_NUMBER, patch: { type: "boolean", description: "include the diff text for each file" } }, ["repo", "number"], "read"),
    t("pr_checks", "CI status for a pull request's head commit.",
      { ...REPO_ARG, ...PR_NUMBER }, ["repo", "number"], "read"),

    t("pr_create", "Open a pull request from one of this agent's published receipts. Stamp reads the repository, branch and exact SHA from the receipt, so the receipt is the only handle a caller needs. Not idempotent: an unclear answer means read the pull request, never resend.",
      {
        receipt: { type: "string", description: "the receipt id from a push" },
        base: { type: "string", description: "the branch to merge into, e.g. main" },
        title: { type: "string" },
        body: { type: "string" },
        idempotencyKey: { type: "string", description: "a name for this request; an identical retry returns the same pull request" },
      }, ["receipt", "base", "title"], "write", "key"),
    t("pr_comment", "Comment on a pull request. An agent comments as Stamp's App, signed with its name. Not idempotent.",
      { ...REPO_ARG, ...PR_NUMBER, body: { type: "string" } }, ["repo", "number", "body"], "write"),

    // The two tools whose misuse cannot be undone by trying again. Both name the
    // exact head and base they are about, so an approval cannot silently attach
    // to a commit that arrived after the review, and both are documented to sit
    // behind the mount's `approval` policy: a person signs each one.
    t("pr_approve", "Approve the exact head of a pull request, which is what lets it merge. An approval counts for one commit. Approving a pull request this agent opened is refused unless evidence is supplied, which this tool does not do — the refusal names why.",
      { ...REPO_ARG, ...PR_NUMBER, ...HEAD_ARG, note: { type: "string", description: "why, for the record" } },
      ["repo", "number", "head", "base"], "write", "native"),
    t("pr_unapprove", "Withdraw this agent's approval at the exact head.",
      { ...REPO_ARG, ...PR_NUMBER, ...HEAD_ARG }, ["repo", "number", "head", "base"], "write", "native"),
    t("pr_merge", "Merge a pull request that is approved at this exact head. `auto` (the default) registers auto-merge and returns at once, which is the usual path: Stamp merges when the head is approved and checks pass, so nothing polls. Otherwise the merge is attempted now.",
      {
        ...REPO_ARG, ...PR_NUMBER, ...HEAD_ARG,
        auto: { type: "boolean", description: "register auto-merge instead of merging now; default true" },
        method: { type: "string", enum: ["merge", "squash", "rebase"] },
      }, ["repo", "number", "head", "base"], "write", "none"),

    t("issue_list", "A repository's issues, most recently updated first. Pull requests are not among them.",
      { ...REPO_ARG, state: { type: "string", enum: ["open", "closed", "all"] }, ...LIMIT_ARG }, ["repo"], "read"),
    t("issue_create", "Open an issue. Not idempotent — calling twice opens two.",
      { ...REPO_ARG, title: { type: "string" }, body: { type: "string" } }, ["repo", "title"], "write"),
    t("issue_comment", "Comment on an issue. Not idempotent.",
      { ...REPO_ARG, number: { type: "integer" }, body: { type: "string" } }, ["repo", "number", "body"], "write"),

    t("inbox", "What Stamp wants to tell this agent, one item per subject: CI on its pull requests, reviews and comments, merge-queue state, failed pushes, workflow runs. Newest first.",
      { unread: { type: "boolean", description: "only items not yet read" }, ...LIMIT_ARG }, [], "read"),

    // Two tools rather than one, because the gateway reads `sideEffects` to
    // decide whether a call waits for a person; a single `api` would declare the
    // wider of the two and every read through it would be held.
    t("api_get", "Read any gateway endpoint under /v1/ or GitHub's API under /api/v3/ that the tools above do not cover. Path only, no host.",
      { path: { type: "string", description: '"/v1/repositories/owner/name/pulls"' } }, ["path"], "read"),
    t("api", "Write to any gateway or GitHub API endpoint the tools above do not cover: POST, PATCH, PUT or DELETE, under /v1/ or /api/v3/. Path only, no host, and not idempotent.",
      {
        path: { type: "string", description: '"/v1/repositories/owner/name/pulls/12/comments"' },
        method: { type: "string", enum: ["POST", "PATCH", "PUT", "DELETE"] },
        body: { type: "object", description: "JSON body" },
      }, ["path", "method"], "write"),
  ],

  /**
   * The question a console asks while a person is supplying the session: does it
   * work, and whose is it. A session that has expired or been revoked is
   * indistinguishable from a working one until something is called with it, and
   * here that costs one request while the person still has the terminal open.
   */
  async checkCredential(ctx): Promise<CredentialCheck> {
    if (!parseSession(ctx.credential)) {
      return {
        ok: false, kind: "rejected",
        reason: "not a Stamp agent session — this mount needs the JSON `stamp login` keeps, with access_token and refresh_token (a cookie or a GitHub token is not one)",
      };
    }
    try {
      const me = await call("GET", "/v1/me", ctx);
      const handle = me?.handle ?? me?.principal?.handle;
      return { ok: true, account: typeof handle === "string" ? `@${handle}` : undefined };
    } catch (e) {
      return { ok: false, kind: "rejected", reason: String((e as Error)?.message ?? e).slice(0, 300) };
    }
  },

  async invoke(name, args, ctx): Promise<Json> {
    const a = (args ?? {}) as Record<string, any>;
    switch (name) {
      case "whoami": {
        const me = await call("GET", "/v1/me", ctx);
        return {
          handle: me?.handle ?? null,
          principalType: me?.principalType ?? me?.principal_type ?? null,
          server: me?.serverName ?? me?.server ?? null,
          commitEmail: me?.commitEmail ?? me?.commit_email ?? null,
          // Whether this instance serves git over HTTPS at all: a self-hosted
          // Stamp may not, and assuming it does is how a push fails one step
          // after the clone worked.
          gitHTTPSURLTemplate: me?.gitHTTPSURLTemplate ?? null,
        } as Json;
      }

      case "receipt_get":
        return receiptOut(await call("GET", `/v1/receipts/${encodeURIComponent(String(a.id))}`, ctx));

      case "receipt_list": {
        const q = new URLSearchParams();
        if (a.repo) q.set("repo", String(a.repo));
        q.set("limit", String(Math.min(Number(a.limit) || 20, MAX_LIMIT)));
        const r = await call("GET", `/v1/receipts?${q}`, ctx);
        return ((r?.receipts ?? r) ?? []).map(receiptOut) as Json;
      }

      case "pr_list": {
        const q = new URLSearchParams();
        q.set("limit", String(Math.min(Number(a.limit) || 20, MAX_LIMIT)));
        if (a.state) q.set("state", String(a.state));
        if (a.repo) {
          const { owner, repo } = repoOf(a);
          return ((await call("GET", `/v1/repositories/${owner}/${repo}/pulls?${q}`, ctx)) ?? []).map(prOut) as Json;
        }
        return ((await call("GET", `/v1/inbox/pull-requests?${q}`, ctx)) ?? []).map(prOut) as Json;
      }

      case "pr_view": {
        const p = await call("GET", prBase(a), ctx);
        return { ...prOut(p), body: p?.body ?? null, approvals: p?.approvals ?? p?.approvalRule ?? null } as Json;
      }
      case "pr_diff": {
        const d = await call("GET", `${prBase(a)}/diff`, ctx);
        const files = (d?.files ?? d) ?? [];
        return (a.patch ? files : files.map((f: any) => ({
          path: f?.path, additions: f?.additions, deletions: f?.deletions, status: f?.status,
        }))) as Json;
      }
      case "pr_checks": {
        const p = await call("GET", prBase(a), ctx);
        return { headSha: p?.headSha ?? p?.head_sha ?? null, checks: p?.checks ?? null, verdict: p?.verdict ?? null } as Json;
      }

      case "pr_create": {
        const body: Record<string, unknown> = {
          receiptId: String(a.receipt),
          baseRef: String(a.base),
          title: String(a.title),
        };
        if (a.body !== undefined) body.body = String(a.body);
        // Stamp reuses the pull request an identical request already opened, so
        // a retry after an unclear answer is safe only with this key.
        if (a.idempotencyKey !== undefined) body.idempotencyKey = String(a.idempotencyKey);
        const p = await call("POST", "/v1/pull-requests", ctx, body);
        return { ...prOut(p), opened: true } as Json;
      }
      case "pr_comment":
        return (await call("POST", `${prBase(a)}/comments`, ctx, { body: String(a.body) })) as Json;

      case "pr_approve": {
        const body: Record<string, unknown> = { expectedHead: String(a.head), expectedBase: String(a.base) };
        if (a.note !== undefined) body.body = String(a.note);
        return (await call("POST", `${prBase(a)}/approve`, ctx, body)) as Json;
      }
      case "pr_unapprove":
        return (await call("POST", `${prBase(a)}/unapprove`, ctx,
          { expectedHead: String(a.head), expectedBase: String(a.base) })) as Json;
      case "pr_merge": {
        const body: Record<string, unknown> = { expectedHead: String(a.head), expectedBase: String(a.base) };
        if (a.method !== undefined) body.mergeMethod = String(a.method);
        // Auto-merge is the default because the alternative is polling: Stamp
        // merges when the head is approved and checks pass, whoever asks.
        const auto = a.auto !== false;
        return (await call("PUT", `${prBase(a)}${auto ? "/auto-merge" : "/merge"}`, ctx, body)) as Json;
      }

      case "issue_list": {
        const { owner, repo } = repoOf(a);
        const q = new URLSearchParams();
        q.set("state", String(a.state ?? "open"));
        q.set("limit", String(Math.min(Number(a.limit) || 20, MAX_LIMIT)));
        const r = await call("GET", `/v1/repositories/${owner}/${repo}/issues?${q}`, ctx);
        return ((r ?? []) as any[]).map((i) => ({
          number: i?.number, title: i?.title, state: i?.state, url: i?.url ?? i?.htmlUrl,
        })) as Json;
      }
      case "issue_create": {
        const { owner, repo } = repoOf(a);
        const i = await call("POST", `/v1/repositories/${owner}/${repo}/issues`, ctx, {
          title: String(a.title), body: a.body === undefined ? undefined : String(a.body),
        });
        return { number: i?.number ?? null, url: i?.url ?? i?.htmlUrl ?? null } as Json;
      }
      case "issue_comment": {
        const { owner, repo } = repoOf(a);
        const c = await call("POST", `/v1/repositories/${owner}/${repo}/issues/${Number(a.number)}/comments`, ctx,
          { body: String(a.body) });
        return { id: c?.id ?? null, url: c?.url ?? c?.htmlUrl ?? null } as Json;
      }

      case "inbox": {
        const q = new URLSearchParams();
        if (a.unread === true) q.set("unread", "true");
        q.set("limit", String(Math.min(Number(a.limit) || 20, MAX_LIMIT)));
        const r = await call("GET", `/v1/me/notifications?${q}`, ctx);
        return ((r?.items ?? r?.notifications ?? r) ?? []).map((n: any) => ({
          id: n?.id, kind: n?.kind, unread: n?.unread ?? null, title: n?.title ?? null, url: n?.url ?? null,
          at: n?.at ?? n?.createdAt ?? null,
        })) as Json;
      }

      case "api_get":
        return (await call("GET", gatewayPath(a.path, ["/v1/", "/api/v3/"]), ctx)) as Json;

      case "api": {
        const method = String(a.method ?? "");
        if (!["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
          throw new Error(`method must be one of POST, PATCH, PUT, DELETE, got ${JSON.stringify(method).slice(0, 20)}`);
        }
        return (await call(method, gatewayPath(a.path, ["/v1/", "/api/v3/"]), ctx, a.body)) as Json;
      }

      default:
        throw new Error(`stamp has no tool named ${JSON.stringify(String(name)).slice(0, 40)}`);
    }
  },
};
