/**
 * The storage panels stay loyal to the plugin, not to their own copies of it.
 *
 * Two places the console used to recite a name the plugin owns. The memory
 * panel hardcoded which documents are read back into the prompt, so a change
 * to the state plugin's working set would silently drift the tag. The sandbox
 * panel now asks the mount (`mountReports`) instead of reading the sandbox
 * plugin's private connection state — a mount with nothing to report is
 * simply absent, and `kept` unions across sessions because each usage entry
 * only carries what that one session saved out.
 */
import { memoryPanel, sandboxPanel } from "../cf/src/ui.ts";
import { WORKING_SET } from "../src/plugins/state.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const ws = WORKING_SET[0]!.key;
const helper = memoryPanel;

check("the prompt tag on a document follows the plugin's working set", () => {
  const html = helper({
    stateDocs: [
      { key: ws, value: "x", bytes: 1, updated_at: 0, ref: null },
      { key: "not-in-the-set", value: "x", bytes: 1, updated_at: 0, ref: null },
    ],
    state: [],
  });
  const h3s = html.match(/<h3>[\s\S]*?<\/h3>/g) ?? [];
  const wsHead = h3s.find((h) => h.includes(`>${ws} `)) ?? "";
  const otherHead = h3s.find((h) => h.includes("not-in-the-set")) ?? "";
  must(wsHead.includes('class="tag ok">in the prompt'), "the working-set document lost its tag");
  must(otherHead && !otherHead.includes("tag ok"), "an outside document got tagged");
});

const report = {
  activity: { live: { id: "b1", startedAt: Date.now() - 1000, lastUsedAt: Date.now() - 200 },
    quietUntil: null, billing: "billed for every second it exists, not per call" },
  usage: [],
};


check("a live container offers release now — one form, alias in body, confirmation that warns about the refusal", () => {
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "holder", provides: ["container"] }],
    mountReports: { box: report },
  });
  const forms = html.match(/<form[^>]*hx-post="\/ui\/sandbox\/release"[^>]*>[\s\S]*?<\/form>/g) ?? [];
  must(forms.length === 1, `release forms: ${forms.length}`);
  must(forms[0]!.includes('name="alias" value="box"'), "the alias rides in the body, not the query");
  must(/hx-confirm="[^"]*refused/.test(forms[0]!), "the confirmation must warn that a working agent makes the request refused");
  must(/hx-target="closest \.body"/.test(forms[0]!), "it must repaint whichever panel shows the sandbox fragment (rail #sandbox or inspector #insp)");
});

check("the sandbox panel asks the mount, under any alias", () => {
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "holder", provides: ["container"] }],
    mountReports: { box: report },
  });
  must(html.includes("a container is running"), "a live container from a mount report did not render");
  must(html.includes("billed for every second it exists"), "the billing sentence from the plugin did not show");
});

check("a container mount is picked by what it provides, not its plugin's name", () => {
  // The fixture cannot borrow the name under test: one mount's plugin is not
  // "sandbox" but declares a container, another is named "sandbox" and declares
  // nothing. Asking the name picks the second — red before this change; asking
  // what the mount provides picks the first.
  const html = sandboxPanel({
    mounts: [
      { alias: "mybox", plugin: "holder", provides: ["container"] },
      { alias: "sb", plugin: "sandbox" },
    ],
    mountReports: { mybox: report },
  });
  must(html.includes("a container is running"),
    "a container-providing mount under another plugin's name did not reach the panel");
  must(html.includes('name="alias" value="mybox"'),
    "the release form did not target the container-providing mount");
  must(!html.includes('name="alias" value="sb"'),
    "the release form targeted the mount that only shares the old plugin's name");
});

check("a mount with no report is not a container, whatever its connection says", () => {
  // A report is written only when something runs or ran; a stale connection row
  // in the old shape must not reach the panel at all.
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "holder", provides: ["container"] }],
    connections: [{ alias: "box", state: JSON.stringify({ boxId: "b1", createdAt: Date.now() - 1000 }), expires_at: null, updated_at: 0 }],
  });
  must(html.includes("no container has ever been started"), "the old connection shape leaked through");
});

check("an idle-but-present sandbox mount is named in the empty state", () => {
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "holder", provides: ["container"] }],
  });
  must(html.includes("no container has ever been started"), "wrong empty branch");
  must(html.includes("<span class=\"chip\">box</span>"), "the hint did not name the mount it has");
});

check("the quiet-until notice shows when the agent postponed, and artifacts union across sessions", () => {
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "holder", provides: ["container"] }],
    mountReports: { box: {
      activity: { live: { id: "b1", startedAt: Date.now() - 60_000, lastUsedAt: Date.now() - 5_000 },
        quietUntil: Date.now() + 3_600_000, billing: "billed" },
      usage: [
        { id: "b0", startedAt: 1, endedAt: 2, lastUsedAt: 2, uses: 3, kept: ["r2://a", "r2://b"] },
        { id: "b-1", startedAt: 3, endedAt: 4, lastUsedAt: 4, uses: 1, kept: ["r2://c"] },
      ],
    } },
  });
  must(html.includes("kept until") && html.includes("postponed its release"), "the postponed release did not render");
  must(html.includes("3 artifact(s)"), "kept was not unioned across sessions");
});

check("a report that does not read draws less, never NaN or undefined", () => {
  // The payload crosses a Durable Object boundary as JSON; a bad row is dropped on the way in (mount-reports.ts).
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "holder", provides: ["container"] }],
    mountReports: { box: {
      activity: { live: null, billing: "billed" },
      usage: [
        null,
        { id: "b0", startedAt: "yesterday", endedAt: 2, lastUsedAt: 2 },
        { id: "b1", startedAt: 1000, endedAt: 61_000, lastUsedAt: 60_000, uses: 2, kept: ["r2://x/sandbox/b1/work/out.txt"] },
      ],
    } },
  });
  must(!/NaN|undefined/.test(html), `a malformed row reached the page: ${html.match(/.{0,60}(NaN|undefined).{0,60}/)?.[0]}`);
  must(html.includes("1 artifact(s)"), "the readable row was dropped along with the bad ones");
});

let failures = 0;
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name}`);
  else { failures++; console.log(`✗ ${r.name} — ${r.error}`); }
}
console.log(`\n${results.length - failures} passed, ${failures} failed`);
if (failures) process.exit(1);
