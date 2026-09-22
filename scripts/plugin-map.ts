/**
 * The plugin contract, drawn from the plugin contract.
 *
 * A page that describes an interface is a copy of it, and copies drift — which
 * is the defect this repository spent today removing from its own comments. So
 * nothing here is written twice: every member, every explanation and every
 * declaration is read out of the source at generation time. The prose is the
 * JSDoc that already stands above each member; if the page disagrees with the
 * code, the generator is wrong, which is a bug someone fixes, rather than a
 * document being stale, which is a thing nobody notices.
 *
 *   node scripts/plugin-map.ts > plugin-contract.html
 */
import { readFileSync } from "node:fs";
import { githubPlugin } from "../src/plugins/github.ts";
import { demoPlugin } from "../src/plugins/demo.ts";
import { httpPlugin } from "../src/plugins/http.ts";
import { sandboxPlugin } from "../src/plugins/sandbox.ts";
import { statePlugin } from "../src/plugins/state.ts";
import { artifactsPlugin } from "../src/plugins/artifacts.ts";
import { builtinToolsPlugin } from "../src/plugins/builtin.ts";
import { appworldPlugins } from "../src/plugins/appworld.ts";
import { backgroundOf, credentialForm, holdingOf, isExclusive } from "../src/plugins/types.ts";
import type { Plugin } from "../src/plugins/types.ts";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url).pathname, "utf8");
const TYPES = read("src/plugins/types.ts");
const PITOOLS = read("src/runtime/pi-tools.ts");
const APPWORLD = read("src/plugins/appworld.ts");

/** The JSDoc immediately above a position: only whitespace may separate them. */
function docBefore(src: string, at: number): string {
  const before = src.slice(0, at);
  const close = before.lastIndexOf("*/");
  if (close < 0 || before.slice(close + 2).trim() !== "") return "";
  const open = before.lastIndexOf("/**", close);
  if (open < 0) return "";
  return before.slice(open + 3, close)
    .split("\n").map((l) => l.replace(/^\s*\*\s?/, "").trimEnd()).join("\n")
    .replace(/\n{3,}/g, "\n\n").trim();
}

/** Every member of an interface, in source order, with the doc above it. */
function membersOf(src: string, iface: string) {
  const start = src.indexOf(`export interface ${iface} {`);
  const body = src.slice(start, start + src.slice(start).indexOf("\n}"));
  const out: Array<{ name: string; sig: string; optional: boolean; doc: string }> = [];
  for (const m of body.matchAll(/\n  ([a-zA-Z][A-Za-z0-9_]*)(\??)([:(][^\n]*)/g)) {
    out.push({
      name: m[1]!, optional: m[2] === "?", sig: m[3]!.replace(/;$/, "").trim(),
      doc: docBefore(body, m.index! + 1),
    });
  }
  return out;
}

/** The doc above a top-level declaration, found by the text that declares it. */
const docOf = (src: string, decl: string) => docBefore(src, src.indexOf(decl));

/* The registry, built the way cf/src/runtime.ts builds it. Four of the eight
 * are factories taking runtime dependencies, so the page cannot read them as
 * values; stubs stand in, and nothing here calls a plugin. */
const bucket: any = { put: async () => ({}), get: async () => null };
const store: any = new Proxy({}, { get: () => async () => null });
const plugins: Plugin[] = [];
plugins.push(
  githubPlugin, demoPlugin, httpPlugin,
  sandboxPlugin(bucket, "artifacts"),
  statePlugin(store, bucket, "artifacts"),
  artifactsPlugin(bucket, "artifacts"),
  builtinToolsPlugin(store, () => plugins),
);

/* `appworldPlugins` is a family, not a plugin: it returns one plugin per app in
 * a catalogue, and the catalogue is AppWorld's data rather than ours, so it is
 * not in this tree. The page cannot list its apps and must not quietly drop it
 * — a count that skips what it could not build is how "eight" got written above
 * a table of seven. So it is constructed from a one-API stand-in, which is
 * enough to read the shape every app of it has, and the row says so. */
const STANDIN = {
  "«app»": {
    description: "one app of the catalogue",
    apis: [{
      app_name: "«app»", api_name: "«api»", path: "/", method: "GET", description: "",
      parameters: [{ name: "access_token", type: "string", required: true, description: "", default: null, constraints: [] }],
    }],
  },
};
const family = appworldPlugins(STANDIN as any, { apiBaseUrl: "http://localhost:8800" })[0]!;

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
/** JSDoc is markdown-ish: paragraphs, `code`, **bold**. Render that much. */
const md = (s: string) => s.split(/\n\n+/).map((p) =>
  `<p>${esc(p).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, " ")}</p>`).join("");

/** Declarations are written as sentences or as fragments; only one needs a stop. */
const dot = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

const OPTIONAL = ["config", "credential", "checkCredential", "promptContribution"] as const;
const has = (p: Plugin, k: string) => (p as any)[k] !== undefined && (p as any)[k] !== false;

/**
 * The capability groups, asked through their adapters rather than by name.
 *
 * This column list used to say `"exclusive"` and `"release"`, and `has()` looks
 * a member up by STRING — so when the 2026-09 refactor moved both inside
 * `holds`, every mark and both tags went blank and the page began saying that
 * nothing in the registry holds anything. Nothing broke, because a string key
 * cannot be wrong at compile time. Measured on 2026-09-22: zero "one call at a
 * time" and zero "holds something releasable" over a registry whose sandbox
 * plugin holds a container.
 *
 * A function per column fixes the class, not the instance: rename or regroup a
 * capability again and this file stops compiling instead of quietly emptying a
 * column. Same reason the runtime reads through these adapters and not through
 * the members.
 */
const CAPABILITIES: ReadonlyArray<{ label: string | null; tag: string | null; of: (p: Plugin) => boolean }> = [
  { label: "holds", tag: "holds something releasable", of: (p) => !!holdingOf(p) },
  { label: "background", tag: "can work in the background", of: (p) => !!backgroundOf(p) },
  { label: "provides", tag: null, of: (p) => !!(p.provides?.length) },
  // A tag and no column: serialisation is DERIVED from `holds` (`isExclusive`
  // is `!!p.holds`), so a column for it would be the `holds` column drawn
  // twice, and two identical columns invite a reader to look for the case
  // where they differ. The tag stays, because "one call at a time" is a
  // consequence worth naming where a reader is looking at one plugin.
  { label: null, tag: "one call at a time", of: isExclusive },
];
const COLUMNS = CAPABILITIES.filter((c) => c.label);

const credCell = (p: Plugin) => {
  const form = credentialForm((p as any).credential);
  if (form.kind === "none") return '<span class="dim">none</span>';
  const what = form.kind === "signIn"
    ? `sign in at ${esc(form.signIn.provider)}`
    : form.fields.map((f) => `<code>${esc(f.name)}</code>${f.secret ? "" : ' <span class="dim">(shown in clear)</span>'}`).join(", ");
  return `${what}<br><span class="dim">${form.accountRequired ? "account required" : "account optional"}</span>`;
};

const overview = plugins.map((p) => `<tr>
    <th scope="row"><code>${esc(p.id)}</code><span class="v">${esc(p.version)}</span></th>
    <td class="num">${p.tools.length}</td>
    <td>${credCell(p)}</td>
    ${OPTIONAL.map((k) => `<td class="mark ${has(p, k) ? "yes" : "no"}">${has(p, k) ? "●" : "·"}</td>`).join("")}
    ${COLUMNS.map((c) => `<td class="mark ${c.of(p) ? "yes" : "no"}">${c.of(p) ? "●" : "·"}</td>`).join("")}
  </tr>`).join("\n");

const detail = plugins.map((p) => {
  const spec: any = (p as any).credential;
  const cfg: any[] = (p as any).config ?? [];
  return `
  <section class="plugin">
    <h3><code>${esc(p.id)}</code><span class="v">${esc(p.version)}</span>
      ${CAPABILITIES.filter((c) => c.tag && c.of(p)).map((c) => `<span class="tag">${esc(c.tag!)}</span>`).join("\n      ")}
      ${has(p, "promptContribution") ? '<span class="tag">adds a prompt paragraph</span>' : ""}
      ${has(p, "checkCredential") ? '<span class="tag">can test its credential</span>' : ""}</h3>
    <table>
      <thead><tr><th>tool</th><th>effect</th><th>repeat</th><th>what it does</th></tr></thead>
      <tbody>${p.tools.map((t) => `<tr>
        <td><code>${esc(t.name)}</code></td>
        <td class="${t.sideEffects === "write" ? "w" : "r"}">${esc(t.sideEffects ?? "read")}</td>
        <td>${esc(t.idempotency ?? "—")}</td>
        <td>${esc(t.summary)}</td></tr>`).join("")
      || '<tr><td colspan="4" class="dim">no tools — this mount exists for what it holds</td></tr>'}</tbody>
    </table>
    ${spec ? `<p class="note"><strong>Credential.</strong> ${esc(dot(spec.summary))}${spec.grants ? ` <span class="dim">Having one buys ${esc(dot(spec.grants))}</span>` : ""}${spec.docs ? ` <a href="${esc(spec.docs)}">where to get one</a>` : ""}</p>` : ""}
    ${cfg.length ? `<table><thead><tr><th>setting</th><th>type</th><th>default</th><th>meaning</th></tr></thead><tbody>${
      cfg.map((c) => `<tr><td><code>${esc(c.name)}</code>${c.required ? ' <span class="dim">required</span>' : ""}</td><td>${esc(c.type)}</td><td>${c.default === undefined ? "—" : `<code>${esc(JSON.stringify(c.default))}</code>`}</td><td>${esc(c.summary)}</td></tr>`).join("")
    }</tbody></table>` : ""}
  </section>`;
}).join("\n");

const memberList = (src: string, iface: string) => membersOf(src, iface).map((m) => `
  <div class="member">
    <div class="sig"><code>${esc(m.name)}${m.optional ? "?" : ""}${esc(m.sig)}</code>
      <span class="${m.optional ? "opt" : "req"}">${m.optional ? "optional" : "required"}</span>
      ${iface === "Plugin" && m.optional ? `<span class="who">${plugins.filter((p) => has(p, m.name)).map((p) => esc(p.id)).join(" ") || "no plugin declares it"}</span>` : ""}
    </div>
    ${m.doc ? md(m.doc) : ""}
  </div>`).join("\n");

const ctxRows = membersOf(TYPES, "PluginContext").map((m) =>
  `<tr><td><code>${esc(m.name)}${m.optional ? "?" : ""}</code></td><td><code class="t">${esc(m.sig.replace(/^:\s*/, ""))}</code></td><td>${m.doc ? md(m.doc) : ""}</td></tr>`).join("");

const commit = process.env.GIT_COMMIT ?? "";

process.stdout.write(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>antiproton — the plugin contract</title>
<style>
  :root { --ink:#16181d; --dim:#606877; --line:#e1e5ec; --bg:#fff; --soft:#f7f8fa; --w:#8a4b00; --r:#25603a; --acc:#2b4f9e }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#e6e9ef; --dim:#98a1b1; --line:#282d37; --bg:#131519; --soft:#191c22; --w:#e0a76a; --r:#7fc79b; --acc:#89a9ee }
  }
  * { box-sizing:border-box }
  body { margin:0 auto; padding:48px 24px 120px; max-width:980px; background:var(--bg); color:var(--ink);
         font:15px/1.65 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif }
  h1 { font-size:27px; margin:0 0 10px; letter-spacing:-.01em }
  h2 { font-size:19px; margin:52px 0 6px; padding-bottom:6px; border-bottom:1px solid var(--line) }
  h3 { font-size:15px; margin:22px 0 8px }
  p { margin:8px 0 }
  code { font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace }
  code.t { color:var(--dim) }
  .lede { color:var(--dim); max-width:74ch }
  .from { color:var(--dim); font-size:13px; border-left:2px solid var(--line); padding-left:12px; margin-top:18px }
  table { border-collapse:collapse; width:100%; margin:12px 0 16px; font-size:14px }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top }
  thead th { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); font-weight:600 }
  tbody th { font-weight:600; white-space:nowrap }
  td p { margin:0 } td p + p { margin-top:6px }
  .num,.mark { text-align:center }
  .mark.yes { color:var(--acc) } .mark.no { color:var(--line) }
  .dim { color:var(--dim) }
  .v { color:var(--dim); font-size:12px; font-weight:400; margin-left:7px }
  .tag { font-size:11px; color:var(--dim); border:1px solid var(--line); border-radius:99px; padding:2px 9px; margin-left:6px; font-weight:400; white-space:nowrap }
  .member { border-top:1px solid var(--line); padding:14px 0 }
  .member p { color:var(--dim); max-width:80ch }
  .member p:first-of-type { color:var(--ink) }
  .sig { display:flex; gap:10px; align-items:baseline; flex-wrap:wrap }
  .opt,.req,.who { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--dim) }
  .req { color:var(--acc) }
  .who { margin-left:auto; text-transform:none; letter-spacing:0; font-family:ui-monospace,Menlo,monospace }
  .w { color:var(--w) } .r { color:var(--r) }
  .plugin { background:var(--soft); border:1px solid var(--line); border-radius:10px; padding:2px 16px 10px; margin:14px 0 }
  .plugin table { margin-bottom:8px } .plugin tbody tr:last-child td { border-bottom:0 }
  .note { font-size:14px; margin:0 0 12px }
  .rot { writing-mode:vertical-rl; transform:rotate(180deg); font-size:11px; letter-spacing:.03em }
  .cols { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-top:12px }
  .card { border:1px solid var(--line); border-radius:10px; padding:12px 14px }
  .card h4 { margin:0 0 6px; font-size:13px; font-family:ui-monospace,Menlo,monospace }
  .card p { font-size:13.5px; color:var(--dim); margin:0 }
  a { color:var(--acc) }
  tr.family th, tr.family td { background:var(--soft) }
  section.family { border-style:dashed }
</style></head><body>

<h1>The plugin contract</h1>
<p class="lede">What a plugin is, what it must provide, and what the eight in the tree actually declare.</p>
<p class="from">Generated by <code>scripts/plugin-map.ts</code>${commit ? ` from <code>${esc(commit)}</code>` : ""} at ${new Date().toISOString().slice(0, 16).replace("T", " ")}Z.
Nothing on this page is written twice: the members and their explanations are read from <code>src/plugins/types.ts</code>,
and the tools, settings and credential shapes from the plugin modules, constructed as the runtime constructs them.
If it disagrees with the code, the generator is wrong.</p>

<h2>What a plugin provides</h2>
<p class="lede">${membersOf(TYPES, "Plugin").filter((m) => !m.optional).length} members are required;
${membersOf(TYPES, "Plugin").filter((m) => m.optional).length} are how a mount says it needs something more than a
function call. The right-hand column names the plugins that declare each optional one.</p>
${memberList(TYPES, "Plugin")}

<h2>${plugins.length} registered, and one family, at a glance</h2>
<table>
  <thead><tr><th>plugin</th><th class="num">tools</th><th>credential</th>
    ${OPTIONAL.map((k) => `<th class="mark"><span class="rot">${esc(k)}</span></th>`).join("")}
    ${COLUMNS.map((c) => `<th class="mark"><span class="rot">${esc(c.label!)}</span></th>`).join("")}</tr></thead>
  <tbody>${overview}
    <tr class="family">
      <th scope="row"><code>appworld</code><span class="v">id is the app's name</span></th>
      <td class="num">per app</td>
      <td>${credCell(family)}</td>
      ${OPTIONAL.map((k) => `<td class="mark ${has(family, k) ? "yes" : "no"}">${has(family, k) ? "●" : "·"}</td>`).join("")}
      ${COLUMNS.map((c) => `<td class="mark ${c.of(family) ? "yes" : "no"}">${c.of(family) ? "●" : "·"}</td>`).join("")}
    </tr>
  </tbody>
</table>
<p class="note dim"><strong>Why that last row is different.</strong> <code>appworldPlugins(catalogue, cfg)</code>
returns one plugin per app, and the catalogue is AppWorld's data rather than ours, so it is not in this tree
and this page cannot name the apps or count the tools. The marks on that row are real — they are read from a
plugin built with a one-API stand-in, and every app of the family has that same shape. Skipping it silently is
how the heading above this table used to say "eight" over a list of seven.</p>

<h2>Two names for one tool</h2>
<div class="cols">
  <div class="card"><h4>alias.tool</h4>${md((membersOf(PITOOLS, "MountedTool").find((m) => m.name === "address")?.doc ?? "").replace(/^`alias\.tool` — /, ""))}</div>
  <div class="card"><h4>alias__tool</h4><p>What the model is offered, produced by <code>qualifyMountedTools</code>.</p></div>
</div>
${md(docOf(PITOOLS, "const modelName ="))}
${md(docOf(PITOOLS, "export function qualifyMountedTools"))}

<h2>Credentials</h2>
${md(docOf(TYPES, "export interface CredentialSpec {"))}
${memberList(TYPES, "CredentialSpec")}
<h3>What a page has to render</h3>
${md(docOf(TYPES, "export type CredentialForm ="))}

<h2>What a call is handed</h2>
<p class="lede">Every method above receives the same context — one mount's view of the world.</p>
<table><thead><tr><th>field</th><th>type</th><th>what it is</th></tr></thead><tbody>${ctxRows}</tbody></table>

<h2>What each plugin declares</h2>
${detail}
<section class="plugin family">
  <h3><code>appworld</code><span class="v">${esc(family.version)}, one id per app</span>
    <span class="tag">one plugin per app</span>
    <span class="tag">not expanded here</span></h3>
  ${/* the module's own doc, which sits above the first declaration in the file */
    md(docOf(APPWORLD, "export interface ApiDoc {"))}
  <p class="note"><strong>Credential.</strong> ${esc(dot((family as any).credential.summary))}
    <span class="dim">Having one buys ${esc(dot((family as any).credential.grants))}</span></p>
  <p class="note dim">Its tools are the catalogue's APIs, minus the ones the harness owns — the token
    endpoint and the withheld list. A deployment with the catalogue gets that count; this page cannot.</p>
</section>

</body></html>
`);
