/**
 * The identity boundary, exercised without a network.
 *
 * Every path from "something on the request" to "a viewer" is here, and the
 * failing paths matter more than the passing ones: a forged, tampered or
 * expired session must resolve to nobody, an agent principal must be turned
 * away, and the anonymous branch must be unreachable unless the deployment
 * says otherwise.
 */
import {
  seal, open, resolveViewer, sessionCookieFor, b64url, unb64url,
  readCookie, constantTimeEqual, SESSION_COOKIE, QA_VIEWER,
  githubAuthorizeUrl, githubExchangeCode, githubFetchProfile, githubIdentityKey, githubViewer, githubDefaultAgentId,
  GITHUB_TOKEN, GITHUB_API,
} from "../cf/src/auth.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const SECRET = "test-secret-not-for-production";
const now = 1_800_000_000_000;

const req = (cookie?: string, headers: Record<string, string> = {}) =>
  new Request("https://antiproton.ai/ui", { headers: { ...(cookie ? { cookie } : {}), ...headers } });

await check("seal/open round-trips and rejects tampering, wrong secret, expiry", async () => {
  const token = await seal(SECRET, { hello: "world", exp: now + 1000 });
  const back = await open<{ hello: string; exp: number }>(SECRET, token, now);
  assert(back?.hello === "world", "round trip");
  assert((await open(SECRET, token, now + 1000)) === null, "expired accepted");
  assert((await open("other-secret", token, now)) === null, "wrong secret accepted");
  const [body, sig] = token.split(".");
  const forged = b64url(new TextEncoder().encode(JSON.stringify({ hello: "evil", exp: now + 1000 })));
  assert((await open(SECRET, `${forged}.${sig}`, now)) === null, "tampered body accepted");
  assert((await open(SECRET, `${body}.${sig.slice(0, -2)}AA`, now)) === null, "tampered sig accepted");
  assert((await open(SECRET, "garbage", now)) === null, "garbage accepted");
  assert((await open(SECRET, null, now)) === null, "null accepted");
});

await check("a sealed session resolves; forged / tampered / expired sessions resolve to nobody", async () => {
  const env = { SESSION_SECRET: SECRET };
  const viewer = { email: "tygg@example.com", name: "tygg", username: "tygg", picture: null, source: "github" as const, agentId: "u-tygg_example.com" };
  const setCookie = await sessionCookieFor(SECRET, viewer, "sub-1", now);
  assert(/HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie), "cookie attributes");
  const value = setCookie.split(";")[0].split("=")[1];
  const v = await resolveViewer(req(`${SESSION_COOKIE}=${value}`), env, { now });
  assert(v?.email === "tygg@example.com" && v.source === "github" && v.name === "tygg" && v.agentId === "u-tygg_example.com", `resolved ${JSON.stringify(v)}`);
  // Forged: signed under a secret the attacker chose.
  const forgedSet = await sessionCookieFor("attacker", viewer, "sub-1", now);
  const forged = forgedSet.split(";")[0].split("=")[1];
  assert((await resolveViewer(req(`${SESSION_COOKIE}=${forged}`), env, { now })) === null, "forged session accepted");
  // Tampered: valid signature, edited body.
  const [, sig] = value.split(".");
  const edited = b64url(new TextEncoder().encode(JSON.stringify({ v: 1, who: "admin@example.com", source: "raft", exp: now + 1e9 })));
  assert((await resolveViewer(req(`${SESSION_COOKIE}=${edited}.${sig}`), env, { now })) === null, "tampered session accepted");
  // Expired.
  assert((await resolveViewer(req(`${SESSION_COOKIE}=${value}`), env, { now: now + 8 * 24 * 3600_000 })) === null, "expired session accepted");
  // No secret configured: sessions cannot exist at all.
  assert((await resolveViewer(req(`${SESSION_COOKIE}=${value}`), {}, { now })) === null, "session accepted without a secret");
  // The other shapes a stranger can send: empty, two-part garbage, overlong,
  // and well-formed JSON under a wrong signature.
  for (const bad of ["", "a.b", "x".repeat(200), `${b64url(new TextEncoder().encode('{"v":1,"who":"a@b.c","source":"raft","exp":9e15}'))}.fake`]) {
    assert((await resolveViewer(req(`${SESSION_COOKIE}=${bad}`), env, { now })) === null, `accepted cookie shape: ${bad.slice(0, 20)}`);
  }
});

await check("the Cloudflare Access header is not an identity any more", async () => {
  const v = await resolveViewer(req(undefined, { "cf-access-authenticated-user-email": "someone@example.com" }), { SESSION_SECRET: SECRET }, { now });
  assert(v === null, `header resolved to ${JSON.stringify(v)}`);
});

await check("the QA key session is its own identity, not automation", async () => {
  const env = { SESSION_SECRET: SECRET, AUTOMATION_TOKEN: "tok" };
  const set = await sessionCookieFor(SECRET, QA_VIEWER, "qa", now);
  const value = set.split(";")[0].split("=")[1];
  const v = await resolveViewer(req(`${SESSION_COOKIE}=${value}`), env, { now });
  assert(v?.source === "qa" && v.email === "qa", `qa resolved ${JSON.stringify(v)}`);
  const a = await resolveViewer(req(undefined, { "x-harness-token": "tok" }), env, { now });
  assert(a?.source === "automation", "automation header");
  assert((await resolveViewer(req(undefined, { "x-harness-token": "wrong" }), env, { now })) === null, "wrong token accepted");
});

await check("the anonymous branch is unreachable unless the deployment opens it", async () => {
  assert((await resolveViewer(req(), { SESSION_SECRET: SECRET, UI_ALLOW_ANONYMOUS: "0" }, { allowAnonymous: true })) === null, "anonymous with flag 0");
  assert((await resolveViewer(req(), { SESSION_SECRET: SECRET }, { allowAnonymous: true })) === null, "anonymous with flag unset");
  assert((await resolveViewer(req(), { SESSION_SECRET: SECRET, UI_ALLOW_ANONYMOUS: "1" }, { allowAnonymous: false })) === null, "anonymous where the route forbids it");
  const v = await resolveViewer(req(), { SESSION_SECRET: SECRET, UI_ALLOW_ANONYMOUS: "1" }, { allowAnonymous: true });
  assert(v?.source === "anonymous", "anonymous where opened");
});

await check("small helpers", async () => {
  assert(readCookie(req("a=1; ap_session=abc; b=2"), "ap_session") === "abc", "readCookie");
  assert(readCookie(req("a=1"), "ap_session") === null, "readCookie missing");
  assert(constantTimeEqual("abc", "abc") && !constantTimeEqual("abc", "abd") && !constantTimeEqual("abc", "ab"), "constantTimeEqual");
  const bytes = new Uint8Array([0, 255, 1, 2, 3, 250]);
  assert(unb64url(b64url(bytes)).join(",") === bytes.join(","), "b64url round trip");
});


// ---- Login with GitHub -------------------------------------------------------

const GH = { clientId: "iv1.abc", clientSecret: "s3cret", redirectUri: "https://antiproton.ai/login/github/callback" };
const fakeFetch = (routes: Record<string, (init?: RequestInit) => Response>) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const h = routes[u];
    if (!h) throw new Error(`unexpected fetch ${u}`);
    return h(init);
  }) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

await check("github: the authorize URL carries client, callback, scopes, state and no sign-up", async () => {
  const u = new URL(githubAuthorizeUrl(GH, "st-1"));
  assert(u.origin + u.pathname === "https://github.com/login/oauth/authorize", "wrong endpoint");
  assert(u.searchParams.get("client_id") === "iv1.abc" && u.searchParams.get("redirect_uri") === GH.redirectUri, "client/callback");
  assert(u.searchParams.get("scope") === "read:user user:email" && u.searchParams.get("state") === "st-1", "scope/state");
  assert(u.searchParams.get("allow_signup") === "false", "the door must not create GitHub accounts");
});

await check("github: the code exchange sends the secret, and a 200 with an error body is a refusal", async () => {
  let seen: any = null;
  const ok = fakeFetch({ [GITHUB_TOKEN]: (init) => { seen = init; return json({ access_token: "gho_x", token_type: "bearer" }); } });
  assert(await githubExchangeCode(GH, "code-1", ok) === "gho_x", "token not returned");
  assert((seen.headers as any).accept === "application/json" && (seen.headers as any)["user-agent"], "accept json + user-agent required");
  const body = JSON.parse(String(seen.body));
  assert(body.client_secret === "s3cret" && body.code === "code-1" && body.redirect_uri === GH.redirectUri, "exchange body");
  const bad = fakeFetch({ [GITHUB_TOKEN]: () => json({ error: "bad_verification_code", error_description: "The code passed is incorrect or expired." }) });
  let threw = false;
  try { await githubExchangeCode(GH, "code-2", bad); } catch { threw = true; }
  assert(threw, "a 200 with an error body must not become a token");
});

await check("github: the profile is fetched under the token with a User-Agent; emails are optional", async () => {
  const withEmails = fakeFetch({
    [`${GITHUB_API}/user`]: (init) => {
      const h = init!.headers as any;
      assert(h.authorization === "Bearer gho_x" && h["user-agent"], "bearer + user-agent");
      return json({ id: 1024025, login: "torvalds", name: "Linus", avatar_url: "https://a/x.png", email: null });
    },
    [`${GITHUB_API}/user/emails`]: () => json([{ email: "old@x.test", primary: false, verified: true }, { email: "linus@x.test", primary: true, verified: true }]),
  });
  const r = await githubFetchProfile("gho_x", withEmails);
  assert(r.profile.id === 1024025 && r.emails.length === 2, "profile + emails");
  const noEmails = fakeFetch({
    [`${GITHUB_API}/user`]: () => json({ id: 7, login: "nobody" }),
    [`${GITHUB_API}/user/emails`]: () => json({ message: "Not Found" }, 404),
  });
  const r2 = await githubFetchProfile("gho_y", noEmails);
  assert(r2.profile.id === 7 && r2.emails.length === 0, "a 404 on emails is not a failure");
  const noId = fakeFetch({ [`${GITHUB_API}/user`]: () => json({ login: "ghost" }) });
  let threw = false;
  try { await githubFetchProfile("gho_z", noId); } catch { threw = true; }
  assert(threw, "a profile without a numeric id is not an identity");
});

await check("github: the identity key is the numeric id; the viewer shows the verified primary email or a non-email name", async () => {
  assert(githubIdentityKey({ id: 1024025 }) === "github:1024025", "key must be github:<id>");
  assert(githubDefaultAgentId({ id: 1024025 }) === "u-github_1024025" && /^u-[A-Za-z0-9._-]{1,48}$/.test(githubDefaultAgentId({ id: 1024025 })), "a self-registered agent id names the numeric id and passes the admin route's shape");
  const v = githubViewer({ id: 1024025, login: "torvalds", name: "Linus", avatar_url: "https://a/x.png" },
    [{ email: "old@x.test", primary: false, verified: true }, { email: "linus@x.test", primary: true, verified: true }, { email: "un@x.test", primary: false, verified: false }], "u-linus_x.test");
  assert(v.email === "linus@x.test" && v.username === "torvalds" && v.picture === "https://a/x.png" && v.source === "github" && v.agentId === "u-linus_x.test", "viewer fields");
  const v2 = githubViewer({ id: 7, login: "nobody" }, [], "u-someone");
  assert(v2.email === "github:nobody" && v2.name === null && v2.picture === null, "no email: a name that cannot be mistaken for one");
  const v3 = githubViewer({ id: 8, login: "x" }, [{ email: "only@x.test", primary: false, verified: true }], "u-x");
  assert(v3.email === "only@x.test", "a verified non-primary email still beats the placeholder");
});

await check("github: a session carries the mapped agent and resolves with it; one that lost it names nobody", async () => {
  const v = githubViewer({ id: 1024025, login: "torvalds" }, [], "u-tygg_example.test");
  const cookie = await sessionCookieFor(SECRET, v, "github:1024025", now);
  const r = await resolveViewer(req(cookie.split(";")[0]), { SESSION_SECRET: SECRET }, { now });
  assert(r && r.source === "github" && r.agentId === "u-tygg_example.test" && r.username === "torvalds", "github session must resolve with its agent");
  const claims = await open<any>(SECRET, cookie.split(";")[0].split("=")[1], now);
  assert(claims.agentId === "u-tygg_example.test" && claims.source === "github", "claims carry agentId + source");
  const lost = await seal(SECRET, { ...claims, agentId: undefined });
  assert(await resolveViewer(req(`${SESSION_COOKIE}=${lost}`), { SESSION_SECRET: SECRET }, { now }) === null, "a github session without an agent is nobody");
  // A session from the Raft login that once existed: well-formed, correctly
  // signed, and nobody — its holder signs in with GitHub instead.
  const legacy = await seal(SECRET, { v: 1, who: "a@b.test", name: null, username: null, picture: null, sub: "sub", source: "raft", iat: now, exp: now + 3600_000 });
  assert(await resolveViewer(req(`${SESSION_COOKIE}=${legacy}`), { SESSION_SECRET: SECRET }, { now }) === null, "a Raft-era session must resolve to nobody");
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
