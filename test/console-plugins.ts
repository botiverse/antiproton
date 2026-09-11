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
import { page, plugins, mountFragment, mountBlockId, inbox, taskList, mountList, catalogue, approvals } from "../cf/src/ui.ts";

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

check("a paste rejected over an operator reference still says why", () => {
  const hostile = `<b>run9 rejected these keys</b>`;
  const html = render(mount("node", "run9", { connected: true, credential: { attached: true, operator: true, verified: false, account: null, error: hostile } }));
  must(/attached by the operator/.test(html), "the operator reference stays attached");
  must(html.includes("&lt;b&gt;run9 rejected these keys&lt;/b&gt;"), "the reason must show, escaped");
  must(!html.includes(hostile), "the reason must not render as markup");
  must(!/<input|<form/.test(html), "still no controls on an operator reference");
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

check("a key kept during an outage: attached, unverified, and the line says why rather than 'not yet tried'", () => {
  const html = render(mount("gh", "github", { connected: true, credential: { attached: true, verified: false, account: null, error: "kept, could not be checked: fetch failed" } }));
  must(/attached · unverified/.test(html), "still unverified");
  must(/kept, could not be checked: fetch failed/.test(html), "the reason must show");
  must(!/not yet tried/.test(html), "a key that was tried and could not be judged is not 'not yet tried'");
  must(/<details><summary>replace<\/summary>/.test(html), "replace stays available so a re-check is one paste away");
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

check("a hostile error string cannot break out of the markup, attached or not", () => {
  // `error` is the one string in the block a third party can influence: it is
  // composed from the plugin's check, which for run9 lifts text out of the
  // provider's HTTP response. It renders in two places; both must escape it.
  const hostile = `<img src=x onerror=1>`;
  const open = render(mount("gh", "github", { optionalAccount: true, credential: { attached: false, error: hostile } }));
  const kept = render(mount("gh", "github", { connected: true, credential: { attached: true, verified: false, error: hostile } }));
  for (const html of [open, kept]) {
    must(!html.includes(hostile), "error must be escaped");
    must(html.includes("&lt;img src=x onerror=1&gt;"), "the escaped text must still be shown, so the person reads the reason");
  }
});

check("a hostile alias or summary cannot break out of the markup", () => {
  const d = { installed: [{ ...installed[0], credential: { ...installed[0]!.credential, summary: `<script>alert(1)</script>` } }],
    mounts: [mount(`x" onmouseover="1`, "github")], used: {} };
  const html = mountFragment(d, `x" onmouseover="1`);
  must(!/<script>/.test(html), "summary must be escaped");
  must(!/alias" value="x" onmouseover/.test(html), "alias must be escaped in attributes");
});


// ---- the shell's inbox and task list ----------------------------------------
check("the inbox renders each held call with the request verbatim, escaped, and its own count", () => {
  const html = inbox({ viewer: "someone", pending: [
    { operationId: "op-1", taskId: "t_a", agentId: "u-x", tool: "gh.issues.create", args: { title: `<img src=x onerror=1>` }, requestedAt: new Date(Date.now() - 120000).toISOString(), heldBy: "gh policy" },
    { operationId: "op-2", taskId: "t_b", agentId: "u-x", tool: "node.exec", args: { cmd: "ls" }, requestedAt: new Date().toISOString(), heldBy: "node policy" },
  ], tasks: { total: 3, running: 2 } });
  must(/data-pending="2"/.test(html), "the root must carry the pending count");
  must(/gh\.issues\.create/.test(html) && /node\.exec/.test(html), "both calls render");
  must(!html.includes("<img src=x"), "arguments must be escaped");
  must(html.includes("&lt;img src=x onerror=1&gt;"), "the escaped text must still be shown verbatim");
  must(/waiting 2 min/.test(html), "how long it has waited");
  must(/held by gh policy/.test(html), "who is holding it");
  must(/hx-post="\/ui\/decide"[^>]*hx-target="#inbox"/.test(html.replace(/\n/g, " ")), "decisions re-render the inbox");
  must(/t_a/.test(html) && /open the conversation/.test(html), "each card links to its conversation");
});

check("an empty inbox says nothing needs you and what is running", () => {
  const html = inbox({ viewer: "someone", pending: [], tasks: { total: 3, running: 1 } });
  must(/data-pending="0"/.test(html), "count is zero");
  must(/Nothing is waiting on you\. 1 of 3 tasks running\./.test(html), "the empty state names the running count");
});

check("the task list shows status, activity, held count and busy, and never a turn count of zero", () => {
  const html = taskList({ agentId: "u-x", tasks: [
    { taskId: "t_a", status: "open", lastActivityAt: "2026-09-11T05:00:00Z", pending: 2, turns: null, busy: true },
    { taskId: "t_b", status: "completed", lastActivityAt: "2026-09-10T05:00:00Z", pending: 0, turns: null, busy: false },
  ] });
  must(/data-task="t_a"/.test(html) && /data-task="t_b"/.test(html), "both tasks render");
  must(/2 held/.test(html), "held count shows");
  must(/working/.test(html), "busy shows");
  must(!/turns/.test(html), "a null turn count is not rendered at all");
  must(/2026-09-11 05:00Z/.test(html), "last activity renders");
  must(!/undefined|null/.test(html), "nothing renders as undefined or null");
});

check("a hostile task id cannot break out of the task list", () => {
  const html = taskList({ agentId: "u-x", tasks: [{ taskId: `t" onmouseover="1`, status: "open", lastActivityAt: null, pending: 0, turns: null, busy: false }] });
  must(!/data-task="t" onmouseover/.test(html), "the id must be escaped in attributes");
});

check("the mount list names each mount, its plugin and its credential state, and the catalogue lists what is installed", () => {
  const d = { installed, mounts: [
    mount("gh", "github", { connected: true, credential: { attached: true, verified: true, account: "botiverse" } }),
    mount("node", "run9", { connected: true, credential: { attached: true, operator: true } }),
    mount("lab", "run9", { needsAccount: true }),
    mount("h", "http"),
  ], used: {} };
  const list = mountList(d);
  must(/data-alias="gh"/.test(list) && /data-alias="lab"/.test(list), "every mount is listed");
  must(/verified/.test(list) && /operator/.test(list) && /needs an account/.test(list) && /no account/.test(list), "each state is named");
  must(!/<input|acting as|botiverse/.test(list), "the list carries no credential detail, only the state");
  const cat = catalogue(d);
  must(/<details class="plug">/.test(cat) && /somewhere/.test(cat), "the catalogue lists the installed plugins");
  must(/Mounting one is a separate, deliberate act/.test(cat), "and says mounting is separate");
  must(plugins(d).includes(cat.slice(0, 60)), "the whole page still composes the catalogue");
});

check("an unknown mount alias is said back, escaped", () => {
  const html = mountFragment({ installed: [], mounts: [], used: {} }, `<img src=x onerror=1>`);
  must(!html.includes("<img src=x"), "the alias must be escaped");
  must(html.includes("no mount named &lt;img src=x onerror=1&gt;"), "and still named");
  // the alias also renders as the block's id, which is made safe by replacement rather than escaping;
  // both mechanisms are asserted so a refactor that drops either one fails here
  must(/id="mount-_img_src_x_onerror_1_"/.test(html), "the id must be the whitelisted form of the alias");
  must(!/id="[^"]*<[^"]*"/.test(html), "no id may carry markup");
});

check("a conversation row shows its title, or a dash, and never the id dressed as a title", () => {
  const html = taskList({ agentId: "u-x", tasks: [
    { taskId: "t_u-x_abc", title: "Open an issue on the repo about the flaky test.\nsecond line", status: "open", lastActivityAt: "2026-09-11T05:00:00Z", pending: 0, turns: null, busy: false },
    { taskId: "t_u-x", title: null, status: "open", lastActivityAt: "2026-09-11T04:00:00Z", pending: 0, turns: null, busy: false },
    { taskId: "t_u-x_xss", title: `<img src=x onerror=1>`, status: "open", lastActivityAt: null, pending: 0, turns: null, busy: false },
  ] });
  must(/<span class="title">Open an issue on the repo about the flaky test\.\nsecond line<\/span>/.test(html) || /<span class="title">Open an issue on the repo about the flaky test\./.test(html), "the title is shown");
  must(/data-title="—"/.test(html) && /<span class="title">—<\/span>/.test(html), "a missing title is a dash");
  must(/<span class="tid">t_u-x<\/span>/.test(html), "the id stays in the meta line");
  must(!html.includes("<img src=x"), "titles are escaped");
});

// The credential form lives inside a panel that polls, and a poll that swaps
// the panel empties the form under the person's cursor (#86). The guard is one
// attribute on the shell; this keeps a later edit to that attribute honest.
check("the plugins panel's poll waits while a person is typing in it", () => {
  const html = page("t_u-x", "someone", "u-x");
  const panel = html.match(/<div class="body" id="plugins"[^>]*>/)?.[0] ?? "";
  must(panel, "the plugins panel is in the shell");
  must(/hx-trigger="[^"]*every \d+s\[[^\]]*!ap\.editing\('#plugins'\)/.test(panel), "the every-Ns trigger is gated on ap.editing('#plugins')");
  const fn = html.match(/editing\(sel\) \{[\s\S]*?\n    \},/)?.[0] ?? "";
  must(/document\.activeElement/.test(fn), "ap.editing looks at focus");
  // The value half is the load-bearing one: a person who fills the box,
  // clicks away to check the token, and comes back must still find it.
  must(/el\.value/.test(fn), "ap.editing also looks at a non-empty value, not only focus");
  must(/type !== 'hidden'/.test(fn), "the hidden alias field does not count as typing");
});

// task #7: a decided call leaves the approvals panel; only pending ones show.
check("the approvals panel shows pending calls only; decided ones are gone", () => {
  const rows: any[] = [
    { operationId: "op-1", mountAlias: "gh", tool: "issues.create", state: "pending", request: { args: { title: "x" } } },
    { operationId: "op-0", mountAlias: "gh", tool: "issues.list", state: "approved", approver: "someone", request: { args: {} } },
    { operationId: "op-9", mountAlias: "node", tool: "exec", state: "denied", approver: "someone", request: { args: {} } },
  ];
  const html = approvals(rows);
  must(count(html, /class="card"/g) === 1 && html.includes("op-1"), "the pending call is the only card");
  must(!/>decided<|class="tag ok"|class="tag bad"|op-0|op-9/.test(html), "no decided call, no decided heading");
  must(/nothing waiting/.test(approvals(rows.slice(1))), "with nothing pending the panel says so, and lists nothing");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
