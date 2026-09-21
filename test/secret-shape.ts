/**
 * cf/src/secret-shape.ts: what counts as credential-shaped text.
 *
 * The values below are built at run time from repeated characters, so nothing
 * in this file is itself shaped like a real secret for a scanner to flag.
 */
import { secretShape, secretMatch, SHAPE_DECLARING_PLUGINS } from "../cf/src/secret-shape.ts";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const r = (c: string, n: number) => c.repeat(n);
/** A bare UUID: what an Exa key looks like, and what every id this system prints looks like. */
const UUID = "3f2a1b4c-5d6e-7f80-9a1b-2c3d4e5f6071";

check("each credential shape is recognised by kind, wherever it sits in a message", () => {
  const cases: Array<[string, string]> = [
    ["github-token", `here is my token ${"gh" + "p_" + r("a", 36)} use it`],
    ["github-token", `${"github" + "_pat_" + r("B", 60)}`],
    ["Raft agent credential", `${"sk" + "_agent_" + r("R", 24)}`],
    ["api-key", `key: ${"sk" + "-" + r("x", 40)}`],
    ["api-key", `${"sk" + "-ant-api03-" + r("y", 40)}`],
    ["aws-access-key", `${"AK" + "IA" + r("Q", 16)}`],
    ["private-key", `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----\nabc`],
    ["slack-token", `${"xo" + "xb-" + r("1", 20)}`],
    ["url-with-password", `read replica ${"postgresql://owner:" + r("p", 12) + "@db.example.com/app?sslmode=require"}`],
    ["neon-password", `password ${"np" + "g_" + r("Z", 16)}`],
    // Recognised by the label beside it, because the value alone is a UUID —
    // the shape of every id this system prints. See the comment on the shape.
    ["labelled-api-key", `"x-api-key": "${UUID}"`],
    ["labelled-api-key", `EXA_${"API_KEY"}=${UUID}`],
    ["labelled-api-key", `export EXA_${"API_KEY"}="${UUID}"`],
    ["labelled-api-key", `apiKey: ${"sk" + "-live-" + r("m", 20)}`],
  ];
  for (const [kind, text] of cases) {
    assert(secretShape(text) === kind, `expected ${kind}, got ${secretShape(text)} for a ${kind} case`);
  }
});

check("ordinary text that only resembles part of a shape is not refused", () => {
  const plain = [
    "",
    "please look at https://github.com/botiverse/slock/pulls",
    "git clone git@github.com:botiverse/antiproton.git",
    "https://user@example.com/path has a user but no password",
    "the prefix ghp_ alone, or ghp_short, is not a token",
    "sk-learn is a library; sk-123 is too short",
    "AKIA is four letters",
    "BEGIN PUBLIC KEY is not a private key",
    "postgres://localhost:5432/app has a port, not a password",
    "a long hash 3f9a1c2b7e4d8f60a1b2c3d4e5f60718293a4b5c is not refused",
    // The other half of the labelled shape: the same UUID, with every label
    // this system actually prints beside its ids. If these were refused, the
    // check would fire on ordinary traffic and teach people to send anyway.
    `msg=${UUID}`,
    `agent ${UUID} started`,
    `tenant ${UUID} was migrated`,
    `{"requestId":"${UUID}"}`,
    "the api key is in the Exa dashboard",
    "api_key: ask whoever set the mount up",
    "the x-api-key header carries it",
  ];
  for (const text of plain) assert(secretShape(text) === null, `ordinary text was refused as ${secretShape(text)}: ${JSON.stringify(text.slice(0, 40))}`);
});

check("a GitHub token is recognised by the github plugin's own declaration and names it; what no plugin takes names none", () => {
  // One shape per credential, beside the form that takes it (#349): the generic list has no GitHub row to drift.
  const token = "gh" + "p_" + r("f", 36);
  const gh = secretMatch(`token ${token}`);
  assert(gh?.kind === "github-token" && JSON.stringify(gh.plugins) === '["github"]', `github token: ${JSON.stringify(gh)}`);
  const dsn = secretMatch("postgresql://owner:" + r("p", 12) + "@db.example.com/app");
  assert(dsn?.kind === "url-with-password" && dsn.plugins.length === 0, `connection string: ${JSON.stringify(dsn)}`);
});

check("a Raft agent credential is recognised by the raft plugin's declaration and names its mount", () => {
  const token = "sk" + "_agent_" + r("r", 24);
  const match = secretMatch(`credential ${token}`);
  assert(match?.kind === "Raft agent credential" && JSON.stringify(match.plugins) === '["raft"]',
    `raft credential: ${JSON.stringify(match)}`);
});

check("every plugin that declares what its credential looks like is one the Worker recognises", () => {
  // Recognition runs where the runtime's plugin list is not at hand, so the list is explicit; this keeps it whole.
  const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
  const dir = new URL("../src/plugins/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "types.ts");
  assert(files.length >= 5, `read only ${files.length} plugin files, so this checked nothing`);
  const declaring = files.filter((f) => /\blooksLike\s*:/.test(readFileSync(new URL(f, dir), "utf8")));
  assert(declaring.length >= 1, "no plugin declares looksLike, so this checked nothing");
  const listed = new Set(SHAPE_DECLARING_PLUGINS.map((p) => p.id));
  for (const f of declaring) {
    const id = /\bid:\s*"([^"]+)"/.exec(readFileSync(new URL(f, dir), "utf8"))?.[1];
    assert(id && listed.has(id), `${f} declares looksLike but plugin ${id} is not in SHAPE_DECLARING_PLUGINS`);
  }
});

check("the answer is a kind name and carries none of the text", () => {
  const token = "gh" + "p_" + r("c", 36);
  const kind = secretShape(`token ${token}`);
  assert(kind !== null && !String(kind).includes("ccc"), `the kind leaks the text: ${kind}`);
});

const pending: Promise<void>[] = [];
pending.push((async () => {
  const { refuseSecret } = await import("../cf/src/secret-shape.ts");
  const token = "gh" + "p_" + r("d", 36);
  const res = refuseSecret(`use ${token} please`, false);
  const ok = res !== null && res.status === 422 && res.headers.get("cache-control") === "no-store";
  const body: any = res ? await res.json() : null;
  const clean = body && body.secret === true && body.kind === "github-token" && JSON.stringify(body.plugins) === '["github"]' && !JSON.stringify(body).includes("ddd");
  const allowed = refuseSecret(`use ${token} please`, true) === null && refuseSecret("hello", false) === null;
  results.push({ name: "the console's refusal is 422 with the kind and none of the text, and a deliberate resend passes",
    ok: Boolean(ok && clean && allowed), ...(ok && clean && allowed ? {} : { error: `status ${res?.status} body ${JSON.stringify(body)} allowed ${allowed}` }) });
})());
await Promise.all(pending);

check("every route that takes a person's text for an agent refuses a credential before it reaches the agent", () => {
  // /ui/message and /agent/message both accept a signed-in person (Vera found the second); each must call
  // refuseSecret before it hands the text on. The Agents API has its own check in handlers.ts.
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const src = readFileSync(new URL("../cf/src/index.ts", import.meta.url), "utf8");
  const routes: Array<[string, string]> = [["/ui/message", "stub.uiSay("], ["/agent/message", "stub.startTask("]];
  for (const [route, send] of routes) {
    const start = src.indexOf(`case "${route}": {`);
    assert(start >= 0, `${route} was not found in cf/src/index.ts, so this checked nothing`);
    const body = src.slice(start, src.indexOf("\n        case ", start + 10));
    const refuse = body.indexOf("refuseSecret("), hand = body.indexOf(send);
    assert(hand >= 0, `${route} no longer calls ${send}, so this check describes nothing`);
    assert(refuse >= 0 && refuse < hand, `${route} hands the text on before refusing a credential`);
  }
});

for (const x of results) console.log(`${x.ok ? "ok " : "FAIL"} ${x.name}${x.error ? ` — ${x.error}` : ""}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
