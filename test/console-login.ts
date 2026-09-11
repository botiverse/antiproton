/**
 * The door and the rail's corner, checked where a person would read them.
 *
 * The sign-in page is the one page an unknown visitor sees, so the checks
 * are about what it offers and what it withholds: one way in (Login with
 * Raft), no mention of the mechanism it replaces, and no trace of the QA
 * entrance, which is a secret rather than a choice. A refused sign-in says
 * what happened and what to do, and an unknown reason is shown escaped
 * rather than trusted. In the console, a signed-in person sees their name
 * and a way out; a viewer the routes only know as a string sees what they
 * saw before, because there is no session behind it to end.
 */
import { loginPage, refusedPage, REFUSALS } from "../cf/src/login.ts";
import { page, viewerBadge } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

check("the sign-in page offers one way in, to /login/raft, and says so in Raft's words", () => {
  const h = loginPage();
  must(/<a class="btn" href="\/login\/raft"[^>]*>[\s\S]*?Login with Raft<\/a>/.test(h), "the button goes to /login/raft and reads 'Login with Raft'");
  must(count(h, /href="\/login\//g) === 1, "exactly one sign-in link");
  must(/Human accounts only/.test(h), "it says humans only before the round trip");
  must(/name and email/.test(h), "it says what Raft shares");
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
  must("not-human" in REFUSALS && "no-email" in REFUSALS && "wrong-server" in REFUSALS && "state" in REFUSALS, "the four reasons the callback redirects with are covered");
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
  must(/<span class="sub">alex@example.com<\/span>/.test(b), "the email under it");
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
