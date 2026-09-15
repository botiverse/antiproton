/**
 * The shell's polling schedule, checked as markup.
 *
 * There is no global poller: every one polls only while its view shows, and
 * every poll stops while the tab is hidden, so a console left open in a
 * background tab must not keep an object awake to answer a page nobody is
 * reading. The inbox (which once polled in every view to feed a rail badge)
 * is gone — the held calls were already beside the conversation.
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
  for (const t of polls) for (const clause of t.match(/every \d+s\[[^\]]*\]/g) ?? []) must(/every \d+s\[!document\.hidden( &&|\])/.test(clause), `poll without a visibility guard: ${clause}`);
});

check("the inbox is gone — no view, rail badge, route or pollers named by it", () => {
  // tygg (2026-09-13, #design): the page was useless — the same held calls
  // render above the composer in the agents view. All of it goes, route
  // included.
  must(!/id="inbox"|data-view="inbox"|inbox-count|ui\/inbox/.test(html), "no inbox element, badge or route in the shell");
  must(/<body[^>]*data-view="agents"/.test(html), "the shell lands on agents");
});

check("the page catches up when the tab is shown again", () => {
  must(/addEventListener\('visibilitychange'/.test(html), "no visibilitychange listener");
  must(/if \(document\.hidden\) return;/.test(html), "the listener must act only on becoming visible");
  must(/'\.view\.on \[data-lazy\], \.side-view\.on \[data-lazy\]'/.test(html), "the shown panels must be re-triggered — the old always-on inbox gone");
});

  check("a panel's version lives on the panel, not in a map keyed by path", () => {
    must(!/__ver/.test(html), "the path-keyed map is gone: its read and store keys never matched for a URL with a query");
    must(/htmx:configRequest[\s\S]{0,120}const v = e\.detail\.elt\.dataset\.ver;\s*if \(v\) e\.detail\.headers\['x-ap-version'\] = v;/.test(html), "the request must send the element's own version");
    must(/htmx:afterRequest[\s\S]{0,200}if \(v\) e\.detail\.elt\.dataset\.ver = v;/.test(html), "the response's version must be stored on the element");
    const reassigned = [...html.matchAll(/setAttribute\('hx-get', [^;]*\);([^\n]*)/g)];
    must(reassigned.length === 3, `expected 3 URL reassignments, found ${reassigned.length}`);
    for (const m of reassigned) must(/delete panel\.dataset\.ver;/.test(m[1]), `a reassigned URL must forget the old version: ${m[0].slice(0, 80)}`);
  });

check("the held cards append as plain flow, in the same fragment under the same version", () => {
  must(!/hx-get="\/ui\/approvals"/.test(html), "no element may poll /ui/approvals on its own");
  // Scope: they are in the chat fragment (chat.ts); test/console-chat.ts
  // holds what it may be there. Looking for them on /ui and not finding them
  // is the intended state. The strip was deleted (tygg, 2026-09-13 #design,
  // task #6): cards follow the turns as ordinary flow, and mobile loses its
  // one region-duplicating panel.
  must(!/\.held\{position:sticky/.test(html), "the sticky strip is gone: the cards append after the turns");
  must(/id="transcript"[^>]*\s+hx-get="\/ui\/chat\?held=1"/.test(html), "the transcript must ask for the held cards");
  must(/hx-post="\/ui\/message"[^>]*hx-vals='\{"held":"1"\}'/.test(html), "a sent message must redraw the transcript with the held cards too");
  must(/\.held:has\(>\.empty\)\{display:none\}/.test(html), "with nothing waiting the wrapper must not draw; the hint under the composer already says a held call shows next to it");
});

check("the inspector holds the merged tabs: events, plugins, memory, runtime", () => {
  // tygg (2026-09-13, #design): some tabs can be merged. trajectory was
  // entirely covered by events (waterfall over the timeline strip, raw
  // records over the list), and storage/sandbox/runtime were three slices
  // of one uiStorage answer — so the merge made room for the plugins tab
  // this agent asks for next.
  const tabs = [...html.matchAll(/role="tab" data-insp="([^"]+)"/g)].map((m) => m[1]);
  must(tabs.join(",") === "events,plugins,memory,runtime", `expected the merged set, found ${tabs.join(",")}`);
  must(/id="insp"[^>]*hx-get="\/ui\/events"/.test(html), "the panel must open on events, not the removed trajectory");
  must(/paths = \{ events: '\/ui\/events', plugins: '\/ui\/plugins', memory: '\/ui\/memory', runtime: '\/ui\/runtime\?stack=1' \}/.test(html),
    "each tab must name its fragment (runtime is stacked, the rest are plain routes)");
  must(/if \(!paths\[name\]\) name = 'events';/.test(html), "a stale deep link, e.g. insp=trajectory, must land on events");
  must(/id="insp"[\s\S]*?hx-trigger="ap:show, every 3s\[[\s\S]*?!ap\.editing\('#insp'\)\]"/.test(html),
    "the whole panel must pause while a form in it is being edited, or the plugins tab empties a credential form like the rail once did");
  must(/class="body plugins-root" id="insp"/.test(html) && /class="body plugins-root" id="plugins"/.test(html),
    "both panels that host the catalogue must let the enable/disable select find their root");
});

check("the compact button marks its flight: label flips for the request, flips back on any answer", () => {
  // tygg (2026-09-13, #design): clicking compact said nothing — no in-flight
  // state, and a transcript that looked unchanged. The form now asks the
  // shell to mark the button busy before the request and to free it after,
  // pending or refused either way.
  must(/hx-post="\/ui\/compact"[^>]*hx-on::before-request="ap\.busy\(this, true\)"/.test(html), "the compact form must mark the button before the request");
  must(/hx-post="\/ui\/compact"[^>]*hx-on::after-request="ap\.busy\(this, false\)"/.test(html), "and free it on any answer, refused included");
  must(/busy\(form, on\) \{[\s\S]*?b\.disabled = true[\s\S]*?b\.disabled = false/.test(html), "busy() disables and re-enables; label round-trips through data-label");
});

check("the composer hint is one breath and steps aside on mobile", () => {
  // tygg (2026-09-13, #design): the legend under the composer filled a phone's
  // bottom third. It now reads one short line, and the phone hides it.
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  must(/class="hint send-hint"[\s\S]*?<b>send<\/b> steers it mid-flight; <b>after<\/b> holds until it finishes\./.test(html),
    "the hint names both buttons in one sentence, and a held call shows in the flow");
  must(/@media\(max-width:760px\)[\s\S]*?\.send-hint\{display:none\}/.test(css), "the hint is hidden at phone width");
});

check("a refused write says so under the form; the composer owns its own error", () => {
  // cody/Vera (2026-09-15, #core): a write the server 500s on swaps nothing,
  // so "clicked" and "not saved" looked the same. One shared handler now
  // speaks the failure next to any htmx write form, except the composer,
  // which already owns its #send-err line through ap.sent.
  must(/htmx:afterRequest'[\s\S]*?closest\('form\[hx-post\]'\)[\s\S]*?write-err/.test(html),
    "the listener, the form lookup and the slot must all be in the same handler");
  must(/xhr\.status >= 200 && xhr\.status < 400/.test(html), "status 0 (network cut, aborted) must not pass for success");
  must(/content-type'[\s\S]*?includes\('json'\)[\s\S]*?\.error/.test(html), "a JSON error answers only its .error field — never the stack");
  must(/hx-post'\) === '\/ui\/message'\) return/.test(html), "the composer must stay owned by ap.sent, not get a second error slot");
  must(/slot\.textContent = 'not saved'/.test(html), "the failure must be spoken, with the server's status");
  must(/slot\.hidden = ok/.test(html), "on success the line hides again");
});

check("a 422 with secret:true names the mount and offers send-anyway as a second click", () => {
  // cody (#350/#351, 2026-09-15): a credential-shaped message is refused
  // before it enters history or reaches the model. The composer must say
  // where it belongs (the plugin's mount when the server knows it) and offer
  // an explicit override — never send it by default.
  must(/id="composer" hx-post="\/ui\/message"/.test(html), "the composer needs an id so the override button can resubmit it");
  must(/xhr\.status === 422[\s\S]*?d\.secret === true/.test(html), "ap.sent must recognise the credential intercept, not print it as a generic failure");
  must(/d\.plugins\[0\][\s\S]*?mount on the plugins page/.test(html), "when the server names a plugin, the hint points at its mount");
  must(/No mount here takes this kind/.test(html), "when nothing takes it, the hint says so instead of guessing");
  must(/type="submit" form="composer" name="allowSecret" value="1"/.test(html), "send-anyway resubmits the same text with allowSecret=1 — an explicit second click");
  must(/htmx\.process\(err\)/.test(html), "the injected button must be htmx-processed, or it submits natively and allowSecret never reaches the request");
  must(/esc\(String\(d\.plugins\[0\]\)\)/.test(html), "the plugin name is server data — it must be escaped like kind");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"}  ${r.name}${r.error ? ` — ${r.error}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);

