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
  seal, open, admit, resolveViewer, sessionCookieFor, verifyIdToken, b64url, unb64url,
  readCookie, constantTimeEqual, SESSION_COOKIE, QA_VIEWER,
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
  const viewer = { email: "tygg@example.com", name: "tygg", username: "tygg", picture: null, source: "raft" as const };
  const setCookie = await sessionCookieFor(SECRET, viewer, "sub-1", now);
  assert(/HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Lax/.test(setCookie), "cookie attributes");
  const value = setCookie.split(";")[0].split("=")[1];
  const v = await resolveViewer(req(`${SESSION_COOKIE}=${value}`), env, { now });
  assert(v?.email === "tygg@example.com" && v.source === "raft" && v.name === "tygg", `resolved ${JSON.stringify(v)}`);
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

await check("admission: humans with a verified email on our server; everyone else refused by reason", async () => {
  const base = { sub: "s", type: "human", email: "a@b.c", email_verified: true, server_id: "srv", name: "A", preferred_username: "a", picture: null };
  const ok = admit(base, "srv");
  assert(ok.ok && ok.viewer.email === "a@b.c" && ok.viewer.source === "raft", "human admitted");
  assert(!admit({ ...base, type: "agent" }, "srv").ok, "agent admitted");
  assert((admit({ ...base, type: "agent" }, "srv") as any).reason === "not-human", "agent reason");
  assert((admit({ ...base, email_verified: false }, "srv") as any).reason === "no-email", "unverified email");
  assert((admit({ ...base, email: null }, "srv") as any).reason === "no-email", "missing email");
  assert((admit({ ...base, server_id: "other" }, "srv") as any).reason === "wrong-server", "other server");
  assert((admit({ ...base, server_id: undefined }, "srv") as any).reason === "wrong-server", "no server");
});

await check("id_token: ES256 signature, issuer, audience, expiry and nonce all checked", async () => {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  const jwks = { keys: [{ ...pub, kid: "k1", alg: "ES256" }] };
  const mk = async (claims: object, key = kp.privateKey, header: object = { alg: "ES256", kid: "k1" }) => {
    const h = b64url(new TextEncoder().encode(JSON.stringify(header)));
    const p = b64url(new TextEncoder().encode(JSON.stringify(claims)));
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${h}.${p}`));
    return `${h}.${p}.${b64url(sig)}`;
  };
  const good = { iss: "https://api.raft.build", aud: "antiproton", exp: now / 1000 + 60, nonce: "n1", sub: "u1", type: "human", email: "a@b.c", email_verified: true, server_id: "srv" };
  const expect = { issuer: "https://api.raft.build", clientId: "antiproton", nonce: "n1", jwks, now };
  const c = await verifyIdToken(await mk(good), expect);
  assert(c.sub === "u1" && c.type === "human", "claims returned");
  const fails = async (t: string, why: string) => {
    try { await verifyIdToken(t, expect); } catch (e) { assert(String((e as Error).message).includes(why), `expected ${why}, got ${(e as Error).message}`); return; }
    throw new Error(`accepted: ${why}`);
  };
  const other = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  await fails(await mk(good, other.privateKey), "bad signature");
  await fails(await mk({ ...good, iss: "https://evil" }), "issuer");
  await fails(await mk({ ...good, aud: "someone-else" }), "audience");
  await fails(await mk({ ...good, exp: now / 1000 - 1 }), "expired");
  await fails(await mk({ ...good, nonce: "n2" }), "nonce");
  await fails(await mk(good, kp.privateKey, { alg: "HS256", kid: "k1" }), "alg");
  await fails(await mk(good, kp.privateKey, { alg: "ES256", kid: "unknown" }), "no matching key");
  // Tampered payload under a valid signature.
  const t = await mk(good);
  const [h, , s] = t.split(".");
  const p2 = b64url(new TextEncoder().encode(JSON.stringify({ ...good, type: "agent", email: "x@y.z" })));
  await fails(`${h}.${p2}.${s}`, "bad signature");
});

await check("small helpers", async () => {
  assert(readCookie(req("a=1; ap_session=abc; b=2"), "ap_session") === "abc", "readCookie");
  assert(readCookie(req("a=1"), "ap_session") === null, "readCookie missing");
  assert(constantTimeEqual("abc", "abc") && !constantTimeEqual("abc", "abd") && !constantTimeEqual("abc", "ab"), "constantTimeEqual");
  const bytes = new Uint8Array([0, 255, 1, 2, 3, 250]);
  assert(unb64url(b64url(bytes)).join(",") === bytes.join(","), "b64url round trip");
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
