/**
 * GitHub's user tokens, as the token endpoint hands them out: the access token and, for an App whose
 * user tokens expire, the refresh token and both lifetimes. Read in one place so the exchange (a code)
 * and the refresh (a refresh token) cannot disagree about which keys mean what.
 *
 * Expiring user tokens last 8 hours; the refresh token lasts about 6 months and is single-use: "Once
 * you use a refresh token, that refresh token and the old user access token will no longer work"
 * (docs.github.com, "Refreshing user access tokens", read 2026-10-17). A token answered without
 * `expires_in` does not expire, and nothing here touches it again.
 */

export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_UA = "antiproton-console";

/** What a token response grants. `refreshToken` and both times are null for a token that does not expire. */
export interface GithubGrant {
  accessToken: string;
  refreshToken: string | null;
  /** ms since the epoch; null: the access token does not expire. */
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

/** A response's grant, and the NAMES of the keys it carried (never a value), so a log can say which kind of token came back. */
export function grantOf(j: Record<string, unknown>, now: number): { grant: GithubGrant; keys: string[] } | null {
  if (typeof j.access_token !== "string" || !j.access_token) return null;
  const secs = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : typeof v === "string" && /^\d+$/.test(v) && Number(v) > 0 ? Number(v) : null);
  const exp = secs(j.expires_in);
  const rexp = secs(j.refresh_token_expires_in);
  const refresh = typeof j.refresh_token === "string" && j.refresh_token ? j.refresh_token : null;
  return {
    grant: {
      accessToken: j.access_token,
      // A refresh token is only kept with an expiry beside it: without one there is nothing to refresh before.
      refreshToken: exp !== null ? refresh : null,
      expiresAt: exp !== null ? now + exp * 1000 : null,
      refreshExpiresAt: exp !== null && rexp !== null ? now + rexp * 1000 : null,
    },
    keys: Object.keys(j).sort(),
  };
}

export type RefreshOutcome =
  | { ok: true; grant: GithubGrant; keys: string[] }
  /** `refused`: GitHub looked and said no (a spent, expired or revoked refresh token): only a reconnect helps.
   *  `unavailable`: nobody answered for it (an outage, a timeout, the App's own credentials): not a verdict. */
  | { ok: false; kind: "refused" | "unavailable"; reason: string };

/**
 * Trade a refresh token for a new pair. The reason carries GitHub's error code and description, which name
 * what went wrong and never the token.
 */
export async function refreshGithubToken(
  app: { clientId: string; clientSecret: string }, refreshToken: string, now: number, fetchImpl: typeof fetch = fetch,
): Promise<RefreshOutcome> {
  let r: Response;
  try {
    r = await fetchImpl(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", "user-agent": GITHUB_UA },
      body: JSON.stringify({ client_id: app.clientId, client_secret: app.clientSecret, grant_type: "refresh_token", refresh_token: refreshToken }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return { ok: false, kind: "unavailable", reason: `the token endpoint did not answer: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  if (r.status >= 500 || r.status === 429) return { ok: false, kind: "unavailable", reason: `the token endpoint answered ${r.status}` };
  let j: Record<string, unknown> = {};
  try { j = (await r.json()) as Record<string, unknown>; } catch { /* an empty or HTML body: judged by its status below */ }
  const got = r.ok ? grantOf(j, now) : null;
  if (got) return { ok: true, ...got };
  // GitHub answers 200 with an error body for a refused grant, as it does for a bad code.
  const code = typeof j.error === "string" ? j.error : `status ${r.status}`;
  const said = typeof j.error_description === "string" ? `: ${j.error_description.slice(0, 160)}` : "";
  // The App's own id or secret being wrong is the deployment's to fix; a reconnect would meet the same refusal.
  if (code === "incorrect_client_credentials") return { ok: false, kind: "unavailable", reason: `${code}${said}` };
  return { ok: false, kind: "refused", reason: `${code}${said}` };
}

/** How close to its expiry an access token is refreshed before use. */
export const REFRESH_SKEW_MS = 5 * 60_000;
