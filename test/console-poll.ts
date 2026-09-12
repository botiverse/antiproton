/**
 * The shell's polling schedule, checked as markup.
 *
 * Two rules the page keeps. Every poll stops while the tab is hidden: a
 * console left open in a background tab must not keep an object awake to
 * answer a page nobody is reading. And the inbox is fetched by exactly one
 * element, which feeds both the list and the rail badge: two elements on the
 * same route at different intervals made the badge lag the list it counted
 * (Vera, 2026-09-12) and doubled the request rate on the inbox view.
 */
import { page } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const html = page("t_demo", "someone@botiverse", "agent-1");
const triggers = [...html.matchAll(/hx-trigger="([^"]*)"/g)].map((m) => m[1]);
const polls = triggers.filter((t) => /every \d+s/.test(t));

check("every poll pauses while the tab is hidden", () => {
  must(polls.length >= 8, `expected the panels' polls, found ${polls.length}`);
  for (const t of polls) must(/every \d+s\[!document\.hidden( &&|\])/.test(t), `poll without a visibility guard: ${t}`);
});

check("the inbox is fetched by exactly one element", () => {
  const els = [...html.matchAll(/<div[^>]*hx-get="\/ui\/inbox"[^>]*>/g)].map((m) => m[0]);
  must(els.length === 1, `expected one inbox fetcher, found ${els.length}`);
  const el = els[0];
  must(/id="inbox"/.test(el), "the fetcher must be the visible inbox panel");
  must(/hx-trigger="load, ap:show, every 5s\[!document\.hidden\]"/.test(el), `the inbox polls in every view, only the tab matters: ${el}`);
  must(/hx-on::after-swap="ap\.count\(this\)"/.test(el), "the same swap must update the badge");
  must(!/inbox-poll/.test(html), "the hidden conduit is gone");
});

check("the page catches up when the tab is shown again", () => {
  must(/addEventListener\('visibilitychange'/.test(html), "no visibilitychange listener");
  must(/if \(document\.hidden\) return;/.test(html), "the listener must act only on becoming visible");
  must(/'\.view\.on \[data-lazy\], \.side-view\.on \[data-lazy\], #inbox'/.test(html), "the shown panels and the inbox must be re-triggered");
});

  check("a panel's version lives on the panel, not in a map keyed by path", () => {
    must(!/__ver/.test(html), "the path-keyed map is gone: its read and store keys never matched for a URL with a query");
    must(/htmx:configRequest[\s\S]{0,120}const v = e\.detail\.elt\.dataset\.ver;\s*if \(v\) e\.detail\.headers\['x-ap-version'\] = v;/.test(html), "the request must send the element's own version");
    must(/htmx:afterRequest[\s\S]{0,200}if \(v\) e\.detail\.elt\.dataset\.ver = v;/.test(html), "the response's version must be stored on the element");
    const reassigned = [...html.matchAll(/setAttribute\('hx-get', [^;]*\);([^\n]*)/g)];
    must(reassigned.length === 3, `expected 3 URL reassignments, found ${reassigned.length}`);
    for (const m of reassigned) must(/delete panel\.dataset\.ver;/.test(m[1]), `a reassigned URL must forget the old version: ${m[0].slice(0, 80)}`);
  });

check("the held cards ride with the chat, in one fragment under one version", () => {
  must(!/hx-get="\/ui\/approvals"/.test(html), "no element may poll /ui/approvals on its own");
  // Scope: after this change the element is not in the shell at all. It is
  // in the chat fragment (chat.ts); test/console-chat.ts holds what it may
  // be there. Looking for it on /ui and not finding it is the intended state.
  must(!/id="approvals"/.test(html), "the wrapper the decide buttons target arrives inside the chat fragment, not in the shell");
  must(/id="transcript"[^>]*\s+hx-get="\/ui\/chat\?held=1"/.test(html), "the transcript must ask for the held cards");
  must(/hx-post="\/ui\/message"[^>]*hx-vals='\{"held":"1"\}'/.test(html), "a sent message must redraw the transcript with the held cards too");
  must(/\.held\{position:sticky;bottom:-13px;/.test(html), "inside the scrolling body the block must stick above the composer, as the old strip always showed");
  must(/\.held:has\(>\.empty\)\{display:none\}/.test(html), "with nothing waiting the block must not draw; the hint under the composer already says where a held call shows");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"}  ${r.name}${r.error ? ` — ${r.error}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);

