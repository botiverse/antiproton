/**
 * The agent model selector: what runs, whose choice it is, and what the owner may
 * change. The deployment lists the selectable models; the owner picks one or goes
 * back to the default; an admin's override reads as locked. Everything the block
 * renders comes from the route's answer — the page never invents a model name and
 * never writes a price.
 */
import { page, agentModelBlock } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const OPTIONS = [
  { id: "deepseek-flash", label: "DeepSeek Flash" },
  { id: "openai/gpt-5.6-luna", label: "GPT-5.6 Luna" },
];
const base = { options: OPTIONS, selected: null as string | null, locked: false };

check("the agents sidebar carries a block that reads the current agent's model on show", () => {
  const html = page("t", "Op", "a1");
  must(/<div id="agent-model"[^>]*hx-get="\/ui\/agent\/model"[^>]*hx-trigger="ap:show"/.test(html.replace(/\n/g, " ")),
    "the model block lazy-reads /ui/agent/model when the agents view shows");
});

check("the block names what runs and says whose choice it is", () => {
  const dflt = agentModelBlock({ ...base, effective: { label: "DeepSeek Flash", provider: "deepseek", model: "deepseek-flash", source: "default" } });
  must(/<b>DeepSeek Flash<\/b>/.test(dflt) && /the deployment default/.test(dflt), "the default is named as the default");
  const own = agentModelBlock({ ...base, selected: "openai/gpt-5.6-luna",
    effective: { label: "GPT-5.6 Luna", provider: "openai", model: "gpt-5.6-luna", source: "owner" } });
  must(/<b>GPT-5\.6 Luna<\/b>/.test(own) && /<span class="tag ok">your choice<\/span>/.test(own), "an owner pick wears its tag");
  const admin = agentModelBlock({ ...base, locked: true,
    effective: { label: "GPT-5.6 Luna", provider: "openai", model: "gpt-5.6-luna", source: "admin" } });
  must(/set by an admin — an admin choice wins/.test(admin), "an admin override says it wins");
});

check("the selector posts the choice on change, and default is the way back", () => {
  const html = agentModelBlock({ ...base, selected: "openai/gpt-5.6-luna",
    effective: { label: "GPT-5.6 Luna", provider: "openai", model: "gpt-5.6-luna", source: "owner" } });
  must(/<select name="choice" hx-post="\/ui\/agent\/model"[^>]*hx-trigger="change"/.test(html.replace(/\n/g, " ")),
    "choosing posts the choice");
  must(/<option value="default">deployment default<\/option>/.test(html), "the default is an explicit option — going back is a choice, not a deletion");
  must(/<option value="openai\/gpt-5\.6-luna" selected>GPT-5\.6 Luna<\/option>/.test(html), "the owner pick is the selected one");
  const none = agentModelBlock({ ...base, effective: { label: "DeepSeek Flash", provider: "deepseek", model: "deepseek-flash", source: "default" } });
  must(/<option value="default" selected>deployment default<\/option>/.test(none), "no pick yet, the default is selected");
});

check("an admin's lock disables the selector and says what lifts it", () => {
  const html = agentModelBlock({ ...base, locked: true,
    effective: { label: "GPT-5.6 Luna", provider: "openai", model: "gpt-5.6-luna", source: "admin" } });
  must(/<select name="choice"[^>]*disabled/.test(html.replace(/\n/g, " ")), "the selector is disabled");
  must(/it changes here only when the admin lifts the override/.test(html), "and the block says who can change it");
});

check("labels and providers render escaped — they come from deployment config", () => {
  const html = agentModelBlock({ ...base, options: [{ id: "x", label: `L<na>"me" ` }],
    effective: { label: `L<na>"me"`, provider: `o"pen<ai`, model: "x", source: "default" } });
  must(/L&lt;na&gt;&quot;me&quot;/.test(html), "a hostile label renders as text");
  must(/o&quot;pen&lt;ai/.test(html), "and a hostile provider too");
  must(!/<na>|o"pen/.test(html), "no raw markup from either");
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
