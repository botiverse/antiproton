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

check("the sandbox panel asks the mount, under any alias", () => {
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "sandbox" }],
    mountReports: { box: report },
  });
  must(html.includes("a container is running"), "a live container from a mount report did not render");
  must(html.includes("billed for every second it exists"), "the billing sentence from the plugin did not show");
});

check("a mount with no report is not a container, whatever its connection says", () => {
  // A report is written only when something runs or ran; a stale connection row
  // in the old shape must not reach the panel at all.
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "sandbox" }],
    connections: [{ alias: "box", state: JSON.stringify({ boxId: "b1", createdAt: Date.now() - 1000 }), expires_at: null, updated_at: 0 }],
  });
  must(html.includes("no container has ever been started"), "the old connection shape leaked through");
});

check("an idle-but-present sandbox mount is named in the empty state", () => {
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "sandbox" }],
  });
  must(html.includes("no container has ever been started"), "wrong empty branch");
  must(html.includes("<span class=\"chip\">box</span>"), "the hint did not name the mount it has");
});

check("the quiet-until notice shows when the agent postponed, and artifacts union across sessions", () => {
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "sandbox" }],
    mountReports: { box: {
      activity: { live: { id: "b1", startedAt: Date.now() - 60_000, lastUsedAt: Date.now() - 5_000 },
        quietUntil: Date.now() + 3_600_000, billing: "billed" },
      usage: [
        { id: "b0", startedAt: 1, endedAt: 2, lastUsedAt: 2, uses: 3, kept: ["r2://a", "r2://b"] },
        { id: "b-1", startedAt: 3, endedAt: 4, lastUsedAt: 4, uses: 1, kept: ["r2://c"] },
      ],
    } },
  });
  must(html.includes("quiet until"), "the postponed notice did not render");
  must(html.includes("3 artifact(s)"), "kept was not unioned across sessions");
});

let failures = 0;
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name}`);
  else { failures++; console.log(`✗ ${r.name} — ${r.error}`); }
}
console.log(`\n${results.length - failures} passed, ${failures} failed`);
if (failures) process.exit(1);
