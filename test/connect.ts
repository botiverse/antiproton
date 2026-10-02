/**
 * Connect GitHub (cf/src/provision/connect.ts): the one-time signed link, the start that spends it
 * and sends the browser to GitHub with the smallest scopes, and the callback that exchanges the
 * code, holds the token in the agent's own object under a random id, and sends the browser back to
 * Raft as pending, with the id and the initiator — never the credential, and never yet on the mount.
 */
import { connectCallback, connectLink, connectStart, CONNECT_CALLBACK_PATH, isConnectCallback, type ConnectDeps } from "../cf/src/provision/connect.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

const ORIGIN = "https://ap.example";
const SECRET = "session-secret-for-tests-0123456789";
const TOKEN = "gho_realtoken_never_leaves";

function deps(over: Partial<ConnectDeps> = {}) {
  const used = new Set<string>(); const held: any[] = []; const exchanged: string[] = [];
  let clock = 1_800_000_000_000;
  const d: ConnectDeps = {
    origin: ORIGIN, secret: SECRET, github: { clientId: "cid", clientSecret: "csecret" },
    registry: {
      async consumeLink(nonce) { if (used.has(nonce)) return false; used.add(nonce); return true; },
    },
    async hold(tenantId, agentId, plugin, token, id, exp, raftUserId) { held.push({ tenantId, agentId, plugin, token, id, exp, raftUserId }); return { ok: true }; },
    async exchange(code, redirectUri) { exchanged.push(`${code}@${redirectUri}`); return TOKEN; },
    now: () => clock,
    ...over,
  };
  return { d, held, exchanged, tick: (ms: number) => { clock += ms; } };
}
const spec = { tenantId: "raft_srv", agentId: "raft_a1", raftAgentId: "a1", provider: "github" as const,
  returnUrl: "https://raft.example/agents/a1", raftUserId: "u_owner", scopes: ["public_repo"] };
const cookieFrom = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;

await check("a link starts one flow: to GitHub with the smallest scopes and the connect callback; used again, it starts nothing", async () => {
  const x = deps();
  const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
  const start = await connectStart(new URL(url), x.d);
  must(start.status === 302, `start ${start.status}`);
  const to = new URL(start.headers.get("location")!);
  must(to.origin === "https://github.com" && to.searchParams.get("scope") === "public_repo" &&
    to.searchParams.get("redirect_uri") === `${ORIGIN}${CONNECT_CALLBACK_PATH}` && to.searchParams.get("state"), to.toString());
  // The registered callback itself: the preview App refused a path under it (2026-09-29).
  must(to.searchParams.get("redirect_uri") === `${ORIGIN}/login/github/callback`, `redirect_uri ${to.searchParams.get("redirect_uri")}`);
  must(/Path=\/login\/github\/callback(;|$)/.test(start.headers.get("set-cookie") ?? ""), "the flow cookie is not scoped to the callback");
  const again = await connectStart(new URL(url), x.d);
  must(again.status === 409, `a used link started again: ${again.status}`);
});

await check("an expired or forged link starts nothing", async () => {
  const x = deps();
  const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
  x.tick(11 * 60_000);
  must((await connectStart(new URL(url), x.d)).status === 400, "an expired link started");
  // The FIRST signature character: all six of its bits are signature bits. The last one carries
  // two unused bits, so changing it there could spell the same signature (#658).
  const [body, sig] = new URL(url).searchParams.get("t")!.split(".") as [string, string];
  const forged = new URL(url); forged.searchParams.set("t", `${body}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`);
  must((await connectStart(forged, deps().d)).status === 400, "a forged link started");
});

await check("a link spelled differently from how it was signed starts nothing (#658)", async () => {
  const x = deps();
  const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
  const [body, sig] = new URL(url).searchParams.get("t")!.split(".") as [string, string];
  // A 32-byte HMAC is 43 characters; the last holds 4 signature bits and 2 unused zero bits.
  // Setting the lowest unused bit names the same bytes in a form seal() never writes.
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  must(sig.length === 43 && A.indexOf(sig.at(-1)!) % 4 === 0, `signature shape ${sig}`);
  const respelled = new URL(url); respelled.searchParams.set("t", `${body}.${sig.slice(0, -1)}${A[A.indexOf(sig.at(-1)!) + 1]}`);
  must((await connectStart(respelled, x.d)).status === 400, "a respelled link started");
  must((await connectStart(new URL(url), x.d)).status === 302, "the link as signed no longer starts");
});

await check("the callback holds the token in the agent's object and sends Raft only a pending id and the initiator", async () => {
  const x = deps();
  const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
  const start = await connectStart(new URL(url), x.d);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cb = new URL(`${ORIGIN}${CONNECT_CALLBACK_PATH}?code=c0de&state=${state}`);
  const res = await connectCallback(new Request(cb, { headers: { cookie: cookieFrom(start) } }), cb, x.d);
  must(res.status === 302, `callback ${res.status}`);
  const back = new URL(res.headers.get("location")!);
  must(back.origin === "https://raft.example" && back.searchParams.get("status") === "pending" && back.searchParams.get("by") === "u_owner" &&
    back.searchParams.get("connection") === "github" && back.searchParams.get("pending") === x.held[0]?.id, back.toString());
  must(!res.headers.get("location")!.includes(TOKEN), "the token went back to Raft");
  must(x.held.length === 1 && x.held[0].plugin === "github" && x.held[0].token === TOKEN && x.held[0].agentId === "raft_a1" &&
    x.held[0].raftUserId === "u_owner" && x.held[0].exp > x.d.now(), JSON.stringify(x.held));
  must(x.exchanged[0] === `c0de@${ORIGIN}${CONNECT_CALLBACK_PATH}`, `exchanged with ${x.exchanged[0]}`);
});

await check("a callback without the flow's cookie or with another state is refused, and nothing is attached", async () => {
  const x = deps();
  const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
  const start = await connectStart(new URL(url), x.d);
  const cb = new URL(`${ORIGIN}${CONNECT_CALLBACK_PATH}?code=c&state=someone-elses`);
  must((await connectCallback(new Request(cb, { headers: { cookie: cookieFrom(start) } }), cb, x.d)).status === 400, "a wrong state was accepted");
  const good = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const noCookie = new URL(`${ORIGIN}${CONNECT_CALLBACK_PATH}?code=c&state=${good}`);
  must((await connectCallback(new Request(noCookie), noCookie, x.d)).status === 400, "a callback without the cookie was accepted");
  must(x.held.length === 0 && x.exchanged.length === 0, "something was exchanged or held");
});

await check("a person who declines, and a hold the agent cannot keep, go back to Raft as denied and failed, with no pending id", async () => {
  for (const [over, query, status] of [
    [{}, "error=access_denied", "denied"],
    [{ async hold() { return { ok: false as const, error: "no SECRET_KEK" }; } }, "code=c", "failed"],
  ] as const) {
    const x = deps(over as Partial<ConnectDeps>);
    const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
    const start = await connectStart(new URL(url), x.d);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = new URL(`${ORIGIN}${CONNECT_CALLBACK_PATH}?${query}&state=${state}`);
    const res = await connectCallback(new Request(cb, { headers: { cookie: cookieFrom(start) } }), cb, x.d);
    const loc = new URL(res.headers.get("location")!);
    must(loc.searchParams.get("status") === status && !loc.searchParams.has("pending"), `${status}: ${loc}`);
  }
});

await check("on the shared callback, only a matching connect cookie makes it a connect flow; a sign-in stays a sign-in", async () => {
  const x = deps();
  const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
  const start = await connectStart(new URL(url), x.d);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0]!;
  const at = (st: string, c?: string) => isConnectCallback(new Request(`${ORIGIN}/login/github/callback?code=c&state=${st}`, { headers: c ? { cookie: c } : {} }),
    new URL(`${ORIGIN}/login/github/callback?code=c&state=${st}`), x.d);
  must(await at(state, cookie), "a connect callback was not recognised");
  must(!(await at(state)), "a callback without the connect cookie was taken for a connect flow");
  must(!(await at("a-sign-in-state", cookie)), "a sign-in callback was taken for a connect flow because a connect cookie was also present");
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
