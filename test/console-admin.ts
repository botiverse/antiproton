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
import { page, adminPanel, adminPage } from "../cf/src/ui.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };

const VIEWER = { email: "o@x.dev", name: "Op", source: "github", agentId: "a1", tenantId: "t1" };
const adminViewer = { ...VIEWER, admin: true };
const plainViewer = { ...VIEWER, admin: false };

check("the rail points admins at the deployment's admin origin — nothing hardcoded, nothing without it", () => {
  // The admin area lives on its own host now: the rail item is a link out, not an
  // embedded view. The href is the deployment's ADMIN_ORIGIN — hardcoding it sends
  // a preview viewer to production's admin (cody, reviewing #632). No origin named,
  // no link: the page renders what it is handed.
  const on = page("t", "Op", "a1", adminViewer as any, "https://admin.preview.example");
  must(/<a class="rail-item" href="https:\/\/admin\.preview\.example\/"/.test(on), "the link goes to the origin the deployment names");
  must(!/admin\.antiproton\.ai/.test(on), "no hardcoded production origin in the markup");
  must(!/<section class="view" data-view="admin">/.test(on), "no admin section is embedded in the console");
  const unconfigured = page("t", "Op", "a1", adminViewer as any);
  must(!/class="rail-item" href="[^"]*admin/.test(unconfigured), "no origin named, no link");
  const off = page("t", "Op", "a1", plainViewer as any, "https://admin.preview.example");
  must(!/admin\.preview\.example/.test(off), "a non-admin must see no trace of the admin area");
  const anon = page("t", "Op", "a1", undefined, "https://admin.preview.example");
  must(!/admin\.preview\.example/.test(anon), "no viewer object, no admin link");
});

check("rail labels are one word — a two-word label wraps inside the 56px rail", () => {
  // qizhi-wang's report: "api keys" broke onto two lines in the narrow rail. The
  // view keeps its full name at the top; the rail speaks in single words, like
  // every other label.
  const html = page("t", "Op", "a1", adminViewer as any);
  const labels = [...html.matchAll(/class="rail-item"[^>]*><span class="ico">.*?<\/span><span>([^<]*)<\/span>/g)].map((m) => m[1]);
  must(labels.length >= 5, `expected the rail items, found ${labels.length}`);
  for (const label of labels) must(!/\s/.test(label), `"${label}" wraps in the rail — one word, like the view it opens keeps its full name`);
});

check("the admin host's page is the console's shell around nothing but the panel", () => {
  const html = adminPage();
  must(/<title>antiproton admin<\/title>/.test(html), "its own title");
  must(/data-theme/.test(html) && /<style>/.test(html), "the console's theme and styles travel with it");
  must(/<div class="body" id="admin"[^>]*hx-get="\/ui\/admin"[^>]*hx-trigger="load"/.test(html.replace(/\n/g, " ")),
    "the panel loads the same fragment, same-origin, on arrival");
  must(!/class="rail"|id="sidebar"|id="inspector"/.test(html), "no rail, no sidebar, no inspector — this host is somewhere else");
  must(/<h1>Admin<\/h1>/.test(html), "the page names itself for a standalone document");
  must(/<form method="post" action="\/logout"[^>]*><button type="submit" class="ghost">sign out<\/button><\/form>/.test(html.replace(/\n/g, " ")),
    "a way out: the admin host's /logout only takes POST, so the page carries the form");
});

const PROVIDERS = [
  { id: "deepseek", endpoint: "api.deepseek.com", modelFormat: "model", available: true, missing: [] },
  { id: "cloudflare", endpoint: "gateway.ai.cloudflare.com", modelFormat: "vendor/model", available: true, missing: [] },
];
const DEFAULT = { provider: "deepseek", model: "m", endpoint: "e" };

check("the model block names the default, its provider and endpoint, and lists each provider with whether it can be chosen", () => {
  const html = adminPanel({ default: { provider: "deepseek", model: "deepseek-flash", endpoint: "api.deepseek.com" },
    providers: [PROVIDERS[0]!, { ...PROVIDERS[1]!, available: false, missing: ["AI_GATEWAY_TOKEN"] }], overrides: [] });
  must(/<b>deepseek-flash<\/b><span>api\.deepseek\.com<\/span>\s*<span class="tag">deepseek<\/span>/.test(html), "the default model, endpoint and provider must be named");
  must(/<td>cloudflare<\/td><td>gateway\.ai\.cloudflare\.com<\/td><td>vendor\/model<\/td>\s*<td>unavailable — AI_GATEWAY_TOKEN not set<\/td>/.test(html), "an unavailable provider must say what it lacks");
  const options = [...html.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
  must(options.length === 2 && options.every((o) => o === "deepseek"), `only an available provider may be offered, once per form: ${options}`);
  const both = adminPanel({ default: DEFAULT, providers: [PROVIDERS[1]!, PROVIDERS[0]!], overrides: [] });
  const first = both.match(/<select name="provider"[^>]*><option value="([^"]+)"/)?.[1];
  must(first === "deepseek", `the default provider must be what an untouched select sends: ${first}`);
  const placeholders = [...both.matchAll(/name="model"[^>]*placeholder="([^"]+)"/g)].map((m) => m[1]);
  must(placeholders.length === 2 && placeholders.every((p) => p === "deepseek-flash"), `the model example must fit the selected (default) provider, which refuses a vendor/ name: ${placeholders}`);
  must(/<option value="cloudflare" data-example="openai\/gpt-5">/.test(both) && /onchange="this\.form\.model\.placeholder=this\.selectedOptions\[0\]\.dataset\.example"/.test(both),
    "choosing a vendor/model provider must switch the example to a vendor/model name");
  must(/MODEL_PROVIDERS refused: bad/.test(adminPanel({ default: DEFAULT, providers: [], providersError: "bad", overrides: [] })), "a refused declaration must be shown");
});

check("an override row spells its scope and carries a remove that names what falls back", () => {
  const html = adminPanel({ default: DEFAULT, providers: PROVIDERS, overrides: [
    { tenantId: "", agentId: "", provider: "cloudflare", model: "anthropic/claude-sonnet-5", setBy: "op@x.dev", setAt: 1_000 },
    { tenantId: "t9", agentId: "", provider: "cloudflare", model: "openai/gpt-5", setBy: "op@x.dev", setAt: 2_000 },
    { tenantId: "t9", agentId: "a9", provider: "cloudflare", model: "google/gemini-2", setBy: "op@x.dev", setAt: 3_000 },
  ] });
  must(/<td>deployment<\/td>/.test(html), "an override with no ids is the deployment");
  must(/<td>tenant t9<\/td>/.test(html), "an override with a tenant id says tenant");
  must(/<td>agent t9\/a9<\/td>/.test(html), "an override with both ids says agent");
  must(/<td>agent t9\/a9<\/td>\s*<td>cloudflare<\/td>\s*<td><code>google\/gemini-2<\/code>/.test(html), "an override row names its provider beside its model");
  must(/agent t9\/a9 falls back to the default model/.test(html.replace(/\n/g, " ")),
    "removing an override must say the scope falls back, not that it loses the model");
  const removes = html.match(/name="action" value="remove"/g) ?? [];
  must(removes.length === 3, `one remove per override: ${removes.length}`);
  must(/<input type="hidden" name="agentId" value="a9">/.test(html), "the remove must carry the agent id it targets");
});

check("the set forms post to the fragment and the override form takes tenant and agent ids", () => {
  const html = adminPanel({ default: DEFAULT, providers: PROVIDERS, overrides: [] });
  must(/hx-post="\/ui\/admin"[^>]*hx-target="#admin"/.test(html.replace(/\n/g, " ")),
    "writes must post to the fragment and swap the panel back in");
  must(/name="action" value="set-default"/.test(html), "a form sets the default");
  must(/name="action" value="set-override"/.test(html), "a form adds an override");
  must(/name="tenantId"/.test(html) && /name="agentId"/.test(html), "the override form takes both ids");
  must((html.match(/<select name="provider"[ >]/g) ?? []).length === 2, "both set forms take a provider");
  must(!/undefined|null|NaN/.test(html), "nothing may render as undefined, null or NaN");
});

check("a refused write says why, above the forms, and the table shows nothing new", () => {
  // The handler's reason comes back on the panel: a bad model name, or an agent named
  // without its tenant, is a 422 with a message — silent re-render would read as success.
  const reason = "a cloudflare model is named vendor/model, like openai/gpt-5";
  const html = adminPanel({ default: DEFAULT, providers: PROVIDERS,
    overrides: [{ tenantId: "t9", agentId: "", provider: "cloudflare", model: "openai/gpt-5", setBy: "op@x.dev", setAt: 1_000 }], error: reason });
  must(html.indexOf(`<div class="err">${reason}</div>`) < html.indexOf("<table"),
    "the reason must sit above the forms, where a returning person reads first");
  const overrides = html.slice(html.indexOf("<h3>overrides"));
  must((overrides.match(/<tr>/g) ?? []).length === 2, "only the header and the existing row — the refused one must not appear");
  const clean = adminPanel({ default: DEFAULT, providers: PROVIDERS,
    overrides: [{ tenantId: "t9", agentId: "", provider: "cloudflare", model: "openai/gpt-5", setBy: "op@x.dev", setAt: 1_000 }] });
  must(!/<div class="err">/.test(clean), "a panel without an error must not draw an error box");
});

for (const r of results) console.log(`${r.ok ? "ok " : "FAIL"} ${r.name}${r.error ? ` — ${r.error}` : ""}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
if (failed) process.exit(1);
