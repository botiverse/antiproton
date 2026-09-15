/**
 * cf/src/secret-shape.ts: what counts as credential-shaped text.
 *
 * The values below are built at run time from repeated characters, so nothing
 * in this file is itself shaped like a real secret for a scanner to flag.
 */
import { secretShape } from "../cf/src/secret-shape.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function assert(cond: unknown, msg: string) { if (!cond) throw new Error(msg); }

const r = (c: string, n: number) => c.repeat(n);

check("each credential shape is recognised by kind, wherever it sits in a message", () => {
  const cases: Array<[string, string]> = [
    ["github-token", `here is my token ${"gh" + "p_" + r("a", 36)} use it`],
    ["github-token", `${"github" + "_pat_" + r("B", 60)}`],
    ["api-key", `key: ${"sk" + "-" + r("x", 40)}`],
    ["api-key", `${"sk" + "-ant-api03-" + r("y", 40)}`],
    ["aws-access-key", `${"AK" + "IA" + r("Q", 16)}`],
    ["private-key", `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----\nabc`],
    ["slack-token", `${"xo" + "xb-" + r("1", 20)}`],
    ["url-with-password", `read replica ${"postgresql://owner:" + r("p", 12) + "@db.example.com/app?sslmode=require"}`],
    ["neon-password", `password ${"np" + "g_" + r("Z", 16)}`],
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
  ];
  for (const text of plain) assert(secretShape(text) === null, `ordinary text was refused as ${secretShape(text)}: ${JSON.stringify(text.slice(0, 40))}`);
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
  const clean = body && body.secret === true && body.kind === "github-token" && !JSON.stringify(body).includes("ddd");
  const allowed = refuseSecret(`use ${token} please`, true) === null && refuseSecret("hello", false) === null;
  results.push({ name: "the console's refusal is 422 with the kind and none of the text, and a deliberate resend passes",
    ok: Boolean(ok && clean && allowed), ...(ok && clean && allowed ? {} : { error: `status ${res?.status} body ${JSON.stringify(body)} allowed ${allowed}` }) });
})());
await Promise.all(pending);

for (const x of results) console.log(`${x.ok ? "ok " : "FAIL"} ${x.name}${x.error ? ` — ${x.error}` : ""}`);
const failed = results.filter((x) => !x.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
