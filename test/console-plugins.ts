/**
 * The plugin page's credential region, checked where a person would read it.
 *
 * The page is the first production code that reads a credential declaration
 * through `credentialForm`, and it is the one surface where a value would
 * naturally be rendered. So the checks are about what appears on screen: a
 * sign-in declaration draws a disabled control rather than throwing, secrets
 * are masked and identifiers are not, nothing renders as "undefined" before
 * the store produces its metadata, and no value the read block might carry
 * ever reaches the markup.
 */
import { plugins, mountFragment, mountBlockId } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

// Declarations in the shape the plugins actually use: github (a bare token, the
// mount works without one), appworld (an identifier and a password), run9 (two
// secret keys), and a synthetic sign-in, which no plugin declares yet.
//
// appworld's `password` and run9's `ak`/`sk` deliberately carry no `secret`
// flag. That is how the real plugins declare them, and an omitted flag is the
// case that once rendered a password in clear: a page reading it truthily
// inverts the documented default. `credentialForm` resolves it now (#31), and
// these fixtures are the page-side regression test for that: reverting the
// resolution fails them. The coverage lives in appworld's pair, where an
// explicit `secret: false` sits beside an omission. Adding `secret: true` to
// the password would not weaken it (resolution makes the flag redundant);
// removing the omission would.
const installed = [
  { id: "github", version: "1", tools: [], config: [],
    credential: { required: false, summary: "A GitHub personal access token, or a GitHub App installation token", shape: "token", grants: "writing to repositories" } },
  { id: "appworld", version: "1", tools: [], config: [],
    credential: { required: true, summary: "The supervisor's account", shape: { keys: [
      { name: "username", summary: "The account name", secret: false },
      { name: "password", summary: "The account password" } ] } } },
  { id: "run9", version: "1", tools: [], config: [],
    credential: { required: true, summary: "run9 access key and secret key", shape: { keys: [
      { name: "ak", summary: "Access key" }, { name: "sk", summary: "Secret key" } ] } } },
  { id: "somewhere", version: "1", tools: [], config: [{ name: "workspace", type: "string", summary: "Which workspace to act in." }],
    credential: { required: true, summary: "Connect the account at the provider; there is nothing to paste here.",
      shape: { signIn: { provider: "Somewhere" } } } },
  { id: "http", version: "1", tools: [], config: [], credential: null },
];
const mount = (alias: string, plugin: string, extra: Record<string, unknown> = {}) => ({
  alias, plugin, version: "1", connected: false, needsAccount: false, optionalAccount: false,
  policy: null, config: {}, session: null, problems: [], tools: [`${alias}.x`], ...extra,
});
const render = (m: any) => mountFragment({ installed, mounts: [m], used: {} }, m.alias);

check("a sign-in declaration renders a disabled Connect button and no input, and does not throw", () => {
  const html = render(mount("sw", "somewhere"));
  must(/<button[^>]*disabled[^>]*>Connect with Somewhere<\/button>/.test(html), "no disabled Connect button");
  must(!/<input/.test(html), "a sign-in must have nothing to paste");
  must(!/undefined/.test(html), "grants is optional and must not render as undefined");
});

check("a sign-in with grants says what connecting grants", () => {
  const d = { installed: [{ ...installed[3], credential: { ...installed[3]!.credential, shape: { signIn: { provider: "Somewhere", grants: "reading and posting as that account" } } } }], mounts: [mount("sw", "somewhere")], used: {} };
  must(/connecting grants reading and posting/.test(mountFragment(d, "sw")), "grants missing");
});

check("github, not attached: one password box labelled in the plugin's own words, optional on the mount, required in the box", () => {
  const html = render(mount("gh", "github", { optionalAccount: true }));
  must(count(html, /<input type="password"/g) === 1, "expected exactly one password input");
  must(/name="token"[^>]* required/.test(html), "the token box must be required once someone chooses to attach");
  must(/A GitHub personal access token, or a GitHub App installation token/.test(html), "label must be the summary");
  must(/optional: without an account this mount works public-only/.test(html), "an optional mount must say so");
  must(/hx-post="\/ui\/credential"/.test(html), "the form must post to the credential route");
  must(/name="alias" value="gh"/.test(html), "the form must carry the alias");
  must(/hx-target="#mount-gh" hx-swap="outerHTML"/.test(html), "the swap must replace the mount block");
  must(new RegExp(`id="${mountBlockId("gh")}"`).test(html), "the block must carry the id the routes target");
  must(!/<input[^>]*value="[^"]/.test(html.replace(/name="alias" value="gh"/g, "")), "no input may be prefilled");
  must(/>attach</.test(html), "the button says attach");
});

check("an identifier is shown in clear and a password is masked", () => {
  const html = render(mount("aw", "appworld", { needsAccount: true }));
  must(/<input type="text" name="username"/.test(html), "username must be a text box");
  must(/<input type="password" name="password"/.test(html), "password must be masked");
  must(!/optional:/.test(html), "a required mount must not be called optional");
});

check("a secret key with no explicit flag is masked", () => {
  const html = render(mount("r9", "run9", { needsAccount: true }));
  must(count(html, /<input type="password"/g) === 2, "ak and sk must both be masked");
  must(!/<input type="text"/.test(html), "nothing in run9's credential is an identifier");
});

check("attached and verified: the account, the dates, a remove that asks first, and a replace that is folded away", () => {
  const html = render(mount("gh", "github", { connected: true,
    credential: { attached: true, verified: true, account: "botiverse", setAt: "2026-09-11T04:00:00Z", lastUsedAt: "2026-09-11T04:30:00Z", last4: "wxyz", error: null } }));
  must(/attached · verified/.test(html), "must say verified");
  must(/acting as <code>botiverse<\/code>/.test(html), "must name the account");
  must(!/wxyz/.test(html), "the suffix must never render");
  must(/set 2026-09-11 04:00Z/.test(html) && /last used 2026-09-11 04:30Z/.test(html), "dates must render when present");
  must(/hx-post="\/ui\/credential\/remove"[^>]*hx-confirm=/.test(html.replace(/\n/g, " ")), "remove must confirm");
  must(/<details><summary>replace<\/summary>/.test(html), "replace must be folded away");
  must(/account attached/.test(html), "the head tag must say attached");
});

check("verified is the store's fact, not an inference: a check that returned no name is still verified", () => {
  const html = render(mount("gh", "github", { connected: true, credential: { attached: true, verified: true, account: null, last4: "wxyz" } }));
  must(/attached · verified/.test(html), "verified without a name is still verified");
  must(!/acting as/.test(html), "no name means no acting-as");
  must(!/wxyz/.test(html), "the suffix must never render");
});

check("an account without verified is not promoted to verified", () => {
  const html = render(mount("gh", "github", { connected: true, credential: { attached: true, verified: false, account: "someone" } }));
  must(/attached · unverified/.test(html), "the state comes from verified alone");
  must(/as <code>someone<\/code>/.test(html), "the name still shows");
});

check("a reference the operator configured is attached by the operator, with no controls", () => {
  const html = render(mount("node", "run9", { connected: true, credential: { attached: true, operator: true, verified: false, account: null } }));
  must(/attached by the operator/.test(html), "must say who attached it");
  must(/configured at deploy time/.test(html), "must say when");
  must(!/unverified|not yet tried/.test(html), "an operator reference is not an untried paste");
  must(!/<input|<form|<details/.test(html), "nothing on the page can replace or remove an operator reference");
  must(!/undefined|null/.test(html), "nothing may render as undefined");
});

check("attached and unverified: says so, shows no fragment of the key, and never the word undefined", () => {
  const html = render(mount("r9", "run9", { connected: true, credential: { attached: true, account: null, last4: "wxyz", setAt: null, lastUsedAt: null, error: null } }));
  must(/attached · unverified/.test(html), "must say unverified");
  must(/stored, not yet tried/.test(html), "must explain what unverified means");
  must(!/wxyz|ends in/.test(html), "the last four characters are part of the key and must never render");
  must(!/undefined|null|Invalid Date/.test(html), "nothing may render as undefined, null or an invalid date");
});

check("before the store exists, the read block is absent and the page still renders whole", () => {
  const html = render(mount("gh", "github", { connected: true }));
  must(/attached · unverified/.test(html), "connected without a read block is attached, unverified");
  must(!/undefined|null|Invalid Date|set |last used /.test(html), "no metadata may be invented");
});

check("a rejected paste: the reason shows, the form stays open, nothing is attached", () => {
  const html = render(mount("gh", "github", { optionalAccount: true, credential: { attached: false, account: null, error: "GitHub answered 401 for that token" } }));
  must(/<div class="err">GitHub answered 401 for that token<\/div>/.test(html), "the reason must show");
  must(/<input type="password" name="token"/.test(html), "the form must stay open");
  must(!/attached ·/.test(html), "a rejected paste is not attached");
});

check("a plugin with no credential draws no region", () => {
  const html = render(mount("h", "http"));
  must(!/class="cred"/.test(html), "no credential region for a plugin that never uses one");
  must(/no account needed/.test(html), "the head tag stays");
});

check("a value that somehow reaches the read block never reaches the page", () => {
  const leak = "ghp_THISMUSTNEVERRENDER";
  const html = render(mount("gh", "github", { connected: true,
    credential: { attached: true, verified: true, account: "botiverse", value: leak, token: leak, secret: leak, ciphertext: leak } }));
  must(!html.includes(leak), "the renderer must ignore any field it was not told about");
});

check("the whole page renders every mount through the same block, and a missing mount is said rather than thrown", () => {
  const html = plugins({ installed, mounts: [mount("gh", "github"), mount("sw", "somewhere")], used: {} });
  must(/id="mount-gh"/.test(html) && /id="mount-sw"/.test(html), "both blocks must carry ids");
  must(/no mount named nope/.test(mountFragment({ installed, mounts: [], used: {} }, "nope")), "a missing mount must be said");
  must(mountBlockId("a b/c") === "mount-a_b_c", "the id must be a usable selector");
});

check("a hostile alias or summary cannot break out of the markup", () => {
  const d = { installed: [{ ...installed[0], credential: { ...installed[0]!.credential, summary: `<script>alert(1)</script>` } }],
    mounts: [mount(`x" onmouseover="1`, "github")], used: {} };
  const html = mountFragment(d, `x" onmouseover="1`);
  must(!/<script>/.test(html), "summary must be escaped");
  must(!/alias" value="x" onmouseover/.test(html), "alias must be escaped in attributes");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
