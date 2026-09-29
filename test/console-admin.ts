/**
 * The admin area: the rail item only an admin sees, and the model block it opens.
 *
 * Admin-ness is the server's answer (viewer.admin on /ui/whoami; /ui/admin and
 * /admin/models check again), so these checks are about what the page renders
 * for each answer, never about the page deciding who is an admin. The model
 * block renders what the handler hands it — the default, whether the endpoint
 * is the AI Gateway, and the overrides with their scope spelled out — and its
 * forms post back to the fragment for the same handler to apply.
 */
import { page, adminPanel } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const VIEWER = { email: "o@x.dev", name: "Op", source: "github", agentId: "a1", tenantId: "t1" };
const adminViewer = { ...VIEWER, admin: true };
const plainViewer = { ...VIEWER, admin: false };

check("the rail shows admin only when the viewer is one", () => {
  const on = page("t", "Op", "a1", adminViewer as any);
  must(/class="rail-item" data-view="admin"/.test(on), "an admin must see the admin rail item");
  must(/<section class="view" data-view="admin">/.test(on), "an admin must get the admin view");
  const off = page("t", "Op", "a1", plainViewer as any);
  must(!/data-view="admin"/.test(off), "a non-admin must see no trace of the admin area");
  const anon = page("t", "Op", "a1");
  must(!/data-view="admin"/.test(anon), "no viewer object, no admin item");
});

check("the admin view reads the fragment when shown, and show() accepts it", () => {
  const html = page("t", "Op", "a1", adminViewer as any);
  must(/<div class="body" id="admin"[^>]*hx-get="\/ui\/admin"[^>]*hx-trigger="ap:show"/.test(html.replace(/\n/g, " ")),
    "the admin body must lazy-read /ui/admin on show");
  must(/\['agents', 'plugins', 'usage', 'keys', 'admin'\]/.test(html), "ap.show must accept the admin view");
});

check("the model block names the default, the endpoint, and whether the Gateway serves it", () => {
  const via = adminPanel({ default: { model: "deepseek/deepseek-chat", endpoint: "gateway.ai.cloudflare.com" },
    gateway: true, overrides: [] });
  must(/<b>deepseek\/deepseek-chat<\/b>/.test(via), "the default model must be named");
  must(/gateway\.ai\.cloudflare\.com/.test(via), "the endpoint must be shown");
  must(/via AI Gateway/.test(via), "a Gateway endpoint must say so");
  const direct = adminPanel({ default: { model: "deepseek-chat", endpoint: "api.deepseek.com" }, gateway: false, overrides: [] });
  must(/<span class="tag">direct<\/span>/.test(direct), "a direct endpoint must not wear the Gateway badge");
  must(!/via AI Gateway/.test(direct), "a direct endpoint must not be called a Gateway one");
});

check("an override row spells its scope and carries a remove that names what falls back", () => {
  const html = adminPanel({ default: { model: "m", endpoint: "e" }, gateway: false, overrides: [
    { tenantId: "", agentId: "", model: "anthropic/claude-sonnet-5", setBy: "op@x.dev", setAt: 1_000 },
    { tenantId: "t9", agentId: "", model: "openai/gpt-5", setBy: "op@x.dev", setAt: 2_000 },
    { tenantId: "t9", agentId: "a9", model: "google/gemini-2", setBy: "op@x.dev", setAt: 3_000 },
  ] });
  must(/<td>deployment<\/td>/.test(html), "an override with no ids is the deployment");
  must(/<td>tenant t9<\/td>/.test(html), "an override with a tenant id says tenant");
  must(/<td>agent t9\/a9<\/td>/.test(html), "an override with both ids says agent");
  must(/agent t9\/a9 falls back to the default model/.test(html.replace(/\n/g, " ")),
    "removing an override must say the scope falls back, not that it loses the model");
  const removes = html.match(/name="action" value="remove"/g) ?? [];
  must(removes.length === 3, `one remove per override: ${removes.length}`);
  must(/<input type="hidden" name="agentId" value="a9">/.test(html), "the remove must carry the agent id it targets");
});

check("the set forms post to the fragment and the override form takes tenant and agent ids", () => {
  const html = adminPanel({ default: { model: "m", endpoint: "e" }, gateway: false, overrides: [] });
  must(/hx-post="\/ui\/admin"[^>]*hx-target="#admin"/.test(html.replace(/\n/g, " ")),
    "writes must post to the fragment and swap the panel back in");
  must(/name="action" value="set-default"/.test(html), "a form sets the default");
  must(/name="action" value="set-override"/.test(html), "a form adds an override");
  must(/name="tenantId"/.test(html) && /name="agentId"/.test(html), "the override form takes both ids");
  must(!/undefined|null|NaN/.test(html), "nothing may render as undefined, null or NaN");
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
