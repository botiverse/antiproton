/**
 * The door and the rail's corner, checked where a person would read them.
 *
 * The sign-in page is the one page an unknown visitor sees, so the checks
 * are about what it offers and what it withholds: one way in (sign in with
 * GitHub), no mention of the mechanisms it replaces, and no trace of the QA
 * entrance, which is a secret rather than a choice. A refused sign-in says
 * what happened and what to do, and an unknown reason is shown escaped
 * rather than trusted. In the console, a signed-in person sees their name
 * and a way out; a viewer the routes only know as a string sees what they
 * saw before, because there is no session behind it to end.
 */
import { loginPage, refusedPage, keyPage, REFUSALS } from "../cf/src/login.ts";
import { page, viewerBadge } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

check("the sign-in page offers one way in, to /login/github, and says so in GitHub's words", () => {
  const h = loginPage();
  must(/<a class="btn" href="\/login\/github"[^>]*>[\s\S]*?Sign in with GitHub<\/a>/.test(h), "the button goes to /login/github and reads 'Sign in with GitHub'");
  must(count(h, /href="\/login\//g) === 1, "exactly one sign-in link");
  must(/Any GitHub account can sign in; your first sign-in creates an agent of your own/.test(h), "it says any account can sign in and what the first sign-in does, before the round trip");
  must(!/[Ii]nvited/.test(h), "the door no longer claims an invitation is needed");
  must(/username, name and avatar/.test(h), "it says what GitHub shares");
});

check("the login provider that came before is gone from every page a person sees", () => {
  // The design library the tokens come from is also called raft-ui; that
  // name lives in a TypeScript comment, never in the served markup, so the
  // pages can be held to zero mentions of the word.
  for (const [name, h] of [["login", loginPage()], ["refused", refusedPage("state")], ["key", keyPage()]] as const) {
    must(!/raft/i.test(h), `${name} page still names the old provider`);
  }
});

check("the sign-in page names neither the old door nor the secret one", () => {
  const h = loginPage();
  for (const word of [/cloudflare/i, /access[- ]protected/i, /UI_ALLOW_ANONYMOUS/, /login\/key/, /harness/i, /automation/i, /QA_ACCESS_KEY/, /x-harness-token/]) {
    must(!word.test(h), `the page must not mention ${word}`);
  }
  must(!/<form/.test(h), "no form: nothing to type, nothing to post");
  must(/name="robots" content="noindex"/.test(h), "the door is not for crawlers");
});

check("every refusal says what happened, what to do, and leads back to /login", () => {
  for (const reason of Object.keys(REFUSALS)) {
    const h = refusedPage(reason);
    must(h.includes(`<h1>${REFUSALS[reason].title}</h1>`), `${reason}: the title is the heading`);
    must(h.includes(REFUSALS[reason].next), `${reason}: the next step is on the page`);
    must(/href="\/login"/.test(h), `${reason}: a way back to sign in`);
    must(!/class="reason"/.test(h), `${reason}: a known reason is not echoed as a tag`);
    must(/You are not signed in/.test(h), `${reason}: it says no session exists`);
  }
  // Every reason index.ts's refuse() can redirect with (admit()'s three, plus
  // the three the routes name themselves) has words of its own.
  for (const r of ["not-invited", "state", "exchange", "unconfigured"]) must(r in REFUSALS, `reason "${r}" has a page`);
  for (const r of ["not-human", "no-email", "wrong-server"]) must(!(r in REFUSALS), `reason "${r}" belonged to the old provider`);
});

check("the key page is a form to /login/key and nothing else; the error is ours, escaped; no link leads to it", () => {
  const h = keyPage();
  must(/<form method="post" action="\/login\/key"/.test(h), "posts to /login/key");
  must(/<input type="password" name="key"/.test(h), "one password field named key");
  must(count(h, /<input/g) === 1, "and only that field");
  must(!/role="alert"/.test(h), "no error on first render");
  must(/href="\/login"/.test(h), "it points a person to the real door");
  const bad = keyPage('the key does not match <b>x</b>');
  must(/<p class="err" role="alert">the key does not match &lt;b&gt;x&lt;\/b&gt;<\/p>/.test(bad), "the error is shown, escaped");
  must(!/value=/.test(bad), "the key typed is never echoed back");
  must(!/login\/key/.test(loginPage()), "the sign-in page still does not lead here");
});

check("an unknown reason renders the generic page with the reason escaped, never as markup", () => {
  const h = refusedPage('<img src=x onerror=alert(1)> "quoted"');
  must(/Sign-in did not complete/.test(h), "generic title");
  must(!/<img src=x/.test(h), "the reason is not markup");
  must(/&lt;img src=x onerror=alert\(1\)&gt; &quot;quoted&quot;/.test(h), "the reason is shown, escaped");
  must(/href="\/login"/.test(h), "a way back");
  const empty = refusedPage("");
  must(/no reason given/.test(empty), "an empty reason says so rather than rendering nothing");
});

check("a viewer with a name, email and picture gets a face, a card and a way out", () => {
  const b = viewerBadge("alex@example.com", { email: "alex@example.com", name: "Alex Chen", username: "alex", picture: 'https://img.example/a.png?x="1"&y=2' });
  must(/<details class="me">/.test(b), "a card behind the face");
  must(/<b>Alex Chen<\/b>/.test(b), "the name, first");
  must(/<span class="sub">@alex<\/span>/.test(b), "the handle under it, ahead of the email");
  const emailOnly = viewerBadge("alex@example.com", { email: "alex@example.com", name: "Alex Chen", picture: null });
  must(/<span class="sub">alex@example.com<\/span>/.test(emailOnly), "without a handle, the email");
  must(/<img src="https:\/\/img.example\/a.png\?x=&quot;1&quot;&amp;y=2"/.test(b), "the picture, escaped");
  must(/title="Alex Chen">A/.test(b), "the initial sits under the picture as a fallback");
  must(/<form method="post" action="\/logout">/.test(b), "sign out posts to /logout");
  must(/sign out<\/button>/.test(b), "the button says sign out");
});

check("a picture of null draws the initial; a name-only viewer (QA) still has the way out", () => {
  const noPic = viewerBadge("alex@example.com", { email: "alex@example.com", name: "Alex Chen", picture: null });
  must(!/<img/.test(noPic), "no picture, no img");
  must(/title="Alex Chen">A<\/span>/.test(noPic), "the initial is the name's, not the email's");
  const qa = viewerBadge("qa", { name: "QA" });
  must(/<b>QA<\/b>/.test(qa) && !/class="sub"/.test(qa), "a name alone: no second line");
  must(/action="\/logout"/.test(qa), "a session is a session: it can be ended");
  const handle = viewerBadge("x", { name: "Alex", username: "alex" });
  must(/<span class="sub">@alex<\/span>/.test(handle), "without an email the handle is the second line");
});

check("without a viewer object the rail shows what it did before: an initial, no card, no /logout", () => {
  const b = viewerBadge("someone@botiverse");
  must(b === `<span class="viewer" title="someone@botiverse">s</span>`, `unchanged face, got: ${b}`);
  const full = page("t_demo", "someone@botiverse", "agent-1");
  must(!/\/logout/.test(full), "no sign-out without a session");
  must(count(full, /class="viewer"/g) === 1, "one face");
  const withViewer = page("t_demo", "alex@example.com", "agent-1", { email: "alex@example.com", name: "Alex Chen", picture: null });
  must(count(withViewer, /action="\/logout"/g) === 1, "with a viewer, one sign-out form in the shell");
  must(/<b>Alex Chen<\/b>/.test(withViewer), "and the name on it");
});

check("what the viewer typed as a name cannot break out of the card", () => {
  const b = viewerBadge("x", { name: '<script>alert(1)</script>', email: 'a"b@example.com' });
  must(!/<script>/.test(b), "no script tag");
  must(/&lt;script&gt;/.test(b), "escaped name");
  must(/title="&lt;script&gt;alert\(1\)&lt;\/script&gt;"/.test(b), "escaped in the title attribute too");
  must(/a&quot;b@example.com/.test(b), "escaped email");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (failed.length) process.exit(1);
