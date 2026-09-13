/**
 * The enable/disable/inherit control, and what a closed mount looks like.
 *
 * Two rules the page keeps, both agreed in #plugins: a switched-off mount
 * still renders — as a "closed" chip, not an absence — because the switch is
 * "put away, not deleted" and a row that vanished would read as a bug. And
 * the inherit option must say what it currently resolves to, because in the
 * store it is "no row", so only the page can say which way the inheritance
 * goes.
 */
import { catalogue, mountFragment, mountList } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const plugin = (id: string, def: boolean, choice: string, enabled: boolean) => ({
  id, version: "1.0.0", defaultForAllAgents: def, choice, enabled,
  credential: null, config: [], tools: [],
});

check("inherit says what it resolves to, and why", () => {
  const on = catalogue({ installed: [plugin("demo", true, "inherit", true)] });
  must(on.includes("on by inheritance"), "resolved-on inherit did not say so");
  must(on.includes("default for all agents"), "the reason was not named");
  const off = catalogue({ installed: [plugin("appworld", false, "inherit", false)] });
  must(off.includes("off by inheritance"), "resolved-off inherit did not say so");
  must(off.includes("opt-in"), "the reason was not named");
});

check("an explicit answer is named, not left as a plain select", () => {
  const off = catalogue({ installed: [plugin("demo", true, "disable", false)] });
  must(off.includes('answer'), "rendering must attribute the answer to this agent");
  must(!off.includes("inheritance"), "an explicit 'disable' must not read as inherit");
  const on = catalogue({ installed: [plugin("appworld", false, "enable", true)] });
  must(on.includes("on — this agent answered"), "explicit 'enable' did not say so");
});

check("the control posts plugin/choice and rounds back to the panel", () => {
  const html = catalogue({ installed: [plugin("demo", true, "inherit", true)] });
  must(html.includes('hx-post="/ui/plugin/choice"'), "no route");
  must(html.includes('name="plugin" value="demo"'), "no plugin id");
  must(html.includes('hx-target="closest .plugins-root"'), "the swap must repaint whichever panel shows the catalogue — the rail's plugins view or the inspector tab, not a hard-coded id");
});

const d: any = {
  installed: [{ id: "sandbox", tools: [] }],
  mounts: [{ alias: "node", plugin: "sandbox", enabled: false, config: {}, tools: [], problems: [] }],
  used: {},
};

check("a closed mount is still listed and says so", () => {
  const frag = mountFragment(d, "node");
  must(frag.includes("closed"), "the closed chip was not rendered");
  must(!frag.includes("account attached") && !frag.includes("needs an account"),
    "account state drowned out the switch state");
  const list = mountList(d);
  must(list.includes("closed"), "the sidebar row was not marked");
});

let failures = 0;
for (const r of results) {
  if (r.ok) console.log(`✓ ${r.name}`);
  else { failures++; console.log(`✗ ${r.name} — ${r.error}`); }
}
console.log(`\n${results.length - failures} passed, ${failures} failed`);
if (failures) process.exit(1);
