/**
 * The storage panels stay loyal to the plugin, not to their own copies of it.
 *
 * Two places the console used to recite a name the plugin owns. The memory
 * panel hardcoded which documents are read back into the prompt, so a change
 * to the state plugin's working set would silently drift the tag. The sandbox
 * panel looked its container up by alias, so a run9 mount under any other name
 * read as "never started", and under two names showed only one.
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

const connState = JSON.stringify({ sessions: [], boxId: "b1", createdAt: Date.now() - 1000, execs: 3, saved: [] });

check("the sandbox panel finds the container by plugin, under any alias", () => {
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "sandbox" }],
    connections: [{ alias: "box", state: connState, expires_at: null, updated_at: 0 }],
  });
  must(html.includes("a container is running"), "run9 under a renamed alias went blind");
});

check("a node-named connection without a run9 mount is not a container", () => {
  const html = sandboxPanel({
    mounts: [],
    connections: [{ alias: "node", state: connState, expires_at: null, updated_at: 0 }],
  });
  must(html.includes("no container has ever been started"), "a foreign 'node' alias passed for the sandbox");
  must(!html.includes("<span class=\"chip\">node</span>"), "the empty state named a mount that is not there");
});

check("an idle-but-present run9 mount is named in the empty state", () => {
  const html = sandboxPanel({
    mounts: [{ alias: "box", plugin: "sandbox" }],
    connections: [],
  });
  must(html.includes("no container has ever been started"), "wrong empty branch");
  must(html.includes("<span class=\"chip\">box</span>"), "the hint did not name the mount it has");
});

let failures = 0;
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name}`);
  else { failures++; console.log(`✗ ${r.name} — ${r.error}`); }
}
console.log(`\n${results.length - failures} passed, ${failures} failed`);
if (failures) process.exit(1);
