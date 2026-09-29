/**
 * Connect GitHub (cf/src/provision/connect.ts): the one-time signed link, the start that spends it
 * and sends the browser to GitHub with the smallest scopes, and the callback that exchanges the
 * code, seals the token on the agent's mount, records the connection and sends the browser back to
 * Raft with only the outcome and the initiator. No step may carry a credential back out.
 */
import { connectCallback, connectLink, connectStart, CONNECT_CALLBACK_PATH, type ConnectDeps } from "../cf/src/provision/connect.ts";

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
  const used = new Set<string>(); const puts: any[] = []; const attached: any[] = []; const exchanged: string[] = [];
  let clock = 1_800_000_000_000;
  const d: ConnectDeps = {
    origin: ORIGIN, secret: SECRET, github: { clientId: "cid", clientSecret: "csecret" },
    registry: {
      async consumeLink(nonce) { if (used.has(nonce)) return false; used.add(nonce); return true; },
      async put(c) { puts.push(c); },
    },
    async attach(tenantId, agentId, alias, token) { attached.push({ tenantId, agentId, alias, token }); return { ok: true, account: "octocat" }; },
    async exchange(code, redirectUri) { exchanged.push(`${code}@${redirectUri}`); return TOKEN; },
    now: () => clock,
    ...over,
  };
  return { d, puts, attached, exchanged, tick: (ms: number) => { clock += ms; } };
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
  must(/Path=\/login\/github\/callback\/connect/.test(start.headers.get("set-cookie") ?? ""), "the flow cookie is not scoped to the callback");
  const again = await connectStart(new URL(url), x.d);
  must(again.status === 409, `a used link started again: ${again.status}`);
});

await check("an expired or forged link starts nothing", async () => {
  const x = deps();
  const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
  x.tick(11 * 60_000);
  must((await connectStart(new URL(url), x.d)).status === 400, "an expired link started");
  const forged = new URL(url); forged.searchParams.set("t", forged.searchParams.get("t")!.replace(/.$/, (c) => (c === "A" ? "B" : "A")));
  must((await connectStart(forged, deps().d)).status === 400, "a forged link started");
});

await check("the callback seals the token on the agent's GitHub mount, records who connected it, and returns only the outcome", async () => {
  const x = deps();
  const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
  const start = await connectStart(new URL(url), x.d);
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const cb = new URL(`${ORIGIN}${CONNECT_CALLBACK_PATH}?code=c0de&state=${state}`);
  const res = await connectCallback(new Request(cb, { headers: { cookie: cookieFrom(start) } }), cb, x.d);
  must(res.status === 302, `callback ${res.status}`);
  const back = new URL(res.headers.get("location")!);
  must(back.origin === "https://raft.example" && back.searchParams.get("status") === "connected" && back.searchParams.get("by") === "u_owner" &&
    back.searchParams.get("connection") === "github", back.toString());
  must(!res.headers.get("location")!.includes(TOKEN), "the token went back to Raft");
  must(x.attached.length === 1 && x.attached[0].alias === "gh" && x.attached[0].token === TOKEN && x.attached[0].agentId === "raft_a1", JSON.stringify(x.attached));
  must(x.exchanged[0] === `c0de@${ORIGIN}${CONNECT_CALLBACK_PATH}`, `exchanged with ${x.exchanged[0]}`);
  must(x.puts.length === 1 && x.puts[0].account === "octocat" && x.puts[0].connectedBy === "u_owner" && !JSON.stringify(x.puts).includes(TOKEN), JSON.stringify(x.puts));
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
  must(x.attached.length === 0 && x.exchanged.length === 0, "something was exchanged or attached");
});

await check("a person who declines, and an attach the plugin refuses, go back to Raft as denied and failed, with nothing recorded", async () => {
  for (const [over, query, status] of [
    [{}, "error=access_denied", "denied"],
    [{ async attach() { return { ok: false as const, error: "no mount named gh" }; } }, "code=c", "failed"],
  ] as const) {
    const x = deps(over as Partial<ConnectDeps>);
    const { url } = await connectLink(ORIGIN, SECRET, spec, x.d.now());
    const start = await connectStart(new URL(url), x.d);
    const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
    const cb = new URL(`${ORIGIN}${CONNECT_CALLBACK_PATH}?${query}&state=${state}`);
    const res = await connectCallback(new Request(cb, { headers: { cookie: cookieFrom(start) } }), cb, x.d);
    must(new URL(res.headers.get("location")!).searchParams.get("status") === status, `${status}: ${res.headers.get("location")}`);
    must(x.puts.length === 0, `${status} recorded a connection`);
  }
});

for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
