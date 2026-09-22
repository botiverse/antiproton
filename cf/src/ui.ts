/**
 * A small HTMX front end, so the thing can be tried rather than described.
 *
 * Server-rendered fragments on purpose: there is no client state to get out of
 * sync with the runtime, and every panel is a plain GET that shows exactly what
 * the store holds. The flow it exists to demonstrate is the one the design is
 * built around — the agent asks to change production, the gateway holds the
 * call, a person sees the request verbatim and signs it, and the agent resumes
 * having never seen a credential.
 */
import type { ApprovalRecord } from "../../src/core/types.ts";
import { credentialForm, type CredentialSpec } from "../../src/plugins/types.ts";
import { WORKING_SET } from "../../src/plugins/state.ts";
import { FAVICON_DATA_URI, LOCKUP_SVG, MARK_OUTLINED_SVG } from "./brand.ts";
import { RUI_TOKENS } from "./rui-tokens.ts";
import { ICONS } from "./icons.ts";
import { md } from "./md.ts";
import { asMountReports, type MountReports } from "./mount-reports.ts";
import { FONT_CSS, HEAD_ASSETS } from "./static.ts";
import { USAGE_CSS } from "./usage.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const CSS = `

.mount{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:8px 0;background:var(--layer-card)}
.mount-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.problems{border-left:2px solid var(--bad);padding:4px 0 4px 8px;margin:6px 0;font-size:12px;color:var(--bad)}
/* A seed change the console refused to apply: the mount kept its previous,
   valid settings, so nothing else on the block shows it. The line is present
   only while the refusal stands; a later reconcile that succeeds clears it. */
.problems.warn{border-color:var(--warn);color:var(--warn)}
.problems.warn .when{color:var(--dim)}
.plug{border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin:6px 0;background:var(--layer-card)}
.plug summary{cursor:pointer;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.plug-choice{display:flex;align-items:baseline;gap:8px;margin:4px 0 2px}
.plug-choice select{background:var(--layer-card);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:1px 4px;font:inherit;font-size:12px}
.plug h4{margin:10px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim)}
code.hot{color:var(--ok);border-color:var(--ok)}

.step{border-left:2px solid var(--line);padding:8px 0 8px 12px;margin:0 0 10px}
.step.user{border-color:var(--accent)}
.step.agent{border-color:var(--model)}
.step.run{border-color:var(--dim)}
.step.held{border-color:var(--warn)}
.step.decided{border-color:var(--ok)}
.step.fail{border-color:var(--bad)}
.lbl{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.07em;
display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.t{color:var(--faint);text-transform:none;letter-spacing:0}
.badge,.tag{display:inline-block;border:1px solid var(--line-muted);border-radius:99px;padding:1px 8px;font-size:10.5px;
line-height:1.5;text-transform:none;letter-spacing:0;color:var(--dim);background:var(--fill-muted);vertical-align:middle}
.badge.ok,.tag.ok{color:var(--success-strong);background:var(--success-soft);border-color:var(--success-muted)}
.badge.bad,.tag.bad{color:var(--danger-strong);background:var(--danger-soft);border-color:var(--danger-muted)}
.badge.warn,.tag.warn{color:var(--warning-strong);background:var(--warning-soft);border-color:var(--warning-muted)}
.code{background:var(--sunk);border-left:2px solid var(--model);color:var(--strong)}
.chip{border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:11px;
color:var(--ink);text-transform:none;letter-spacing:0}
.calls{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
details summary{cursor:pointer;color:var(--dim);font-size:12px;margin-top:5px}
.live .lbl{color:var(--accent)}
.dots::after{content:"";animation:d 1.4s steps(4,end) infinite}
@keyframes d{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
details[open] summary{color:var(--ink)}

/* The console's own names, aliased onto rUI's Elegant dark tokens (the scope
   itself is RUI_TOKENS, prepended below). Two roles split what was one
   blue: --accent is the expressive one (the active tab, the user's turn, the
   live label) and is rUI's primary, Source Yellow; --action is what buttons
   are, rUI's accent. --js keeps the JS sandbox's own colour, rUI's info. */
:root{--bg:var(--layer-canvas);--panel:var(--layer-panel);--sunk:var(--layer-canvas-muted);
--line:var(--line-muted);--hairline:var(--line-hairline);--ink:var(--foreground);
--strong:var(--foreground-strong);--dim:var(--foreground-hint);--faint:var(--foreground-placeholder);
--accent:var(--primary-strong);--action:var(--accent-strong);--action-ink:var(--foreground-inverse);
--model:var(--accent-strong);--js:var(--info-strong);--js-soft:var(--info-muted);
--warn:var(--warning-strong);--ok:var(--success-strong);--bad:var(--danger-strong);color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.55 var(--mono-font)}
/* --- the shell: rail · sidebar · main · inspector ------------------------
   rUI's AppShell, as CSS. Slots own placement only; the panels inside own
   their surfaces. Which columns exist depends on the section: a conversation
   has all four, while plugins and runtime leave the inspector and sidebar out. */
body.shell{display:grid;grid-template-columns:56px 264px minmax(0,1fr) 420px;grid-template-areas:"rail side main insp";
height:100vh;overflow:hidden}
body.shell[data-view=keys],body.shell[data-view=usage]{grid-template-columns:56px 0 minmax(0,1fr) 0}
body.shell[data-view=plugins]{grid-template-columns:56px 264px minmax(0,1fr) 0}
/* A zero-width column still paints its padding and border: without this the
   inspector showed as a sliver of text beside every view but agents. */
body.shell[data-view]:not([data-view=agents]) .inspector{display:none}
@media(max-width:1100px){body.shell[data-view=agents]{grid-template-columns:56px 0 minmax(0,1fr) 0}}

.rail{grid-area:rail;display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 0;
background:var(--panel);border-right:1px solid var(--line)}
/* The brand in the rail is the outlined cut in every theme: it carries its
   own colours (ink line, cream body, yellow bar, hard shadow), so it reads the
   same on light and dark. */
.rail-brand{display:block;width:30px;margin:0 0 12px}
.rail-brand svg{width:100%;height:auto;display:block}
.rail-item{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;width:52px;padding:7px 0 6px;
color:var(--dim);text-decoration:none;font-size:9.5px;letter-spacing:.04em;border-radius:8px;border:1px solid transparent}
.rail-item .ico{width:22px;height:22px;display:flex;align-items:center;justify-content:center;opacity:.85}
.rail-item .ico svg{width:21px;height:21px}
.rail-item:hover{color:var(--ink)}
.rail-item.on{color:var(--accent);border-color:var(--accent);background:var(--sunk)}
.rail-item.on .ico{opacity:1}
.rail-item .count{position:absolute;top:2px;right:6px;min-width:15px;height:15px;padding:0 4px;border-radius:8px;
background:var(--primary-400);color:var(--primary-950);font-size:9px;font-weight:600;line-height:15px;text-align:center}
.rail-foot{margin-top:auto;display:flex;flex-direction:column;align-items:center;gap:8px}
.mode{display:flex;flex-direction:column;gap:2px;border:1px solid var(--line);border-radius:7px;padding:2px}
.mode button{background:none;border:0;color:var(--dim);font:inherit;padding:5px;border-radius:5px;cursor:pointer;display:flex;box-shadow:none}
.mode button svg{width:14px;height:14px}
.mode button:hover{background:var(--fill-muted)}
.mode button.on{background:var(--sunk);color:var(--ink)}
.viewer{width:26px;height:26px;border-radius:50%;background:var(--sunk);border:1px solid var(--line);color:var(--dim);
font-size:11px;display:flex;align-items:center;justify-content:center;text-transform:uppercase;position:relative;overflow:hidden}
.viewer img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
/* who is signed in, and the way out: a card off the rail's corner */
.me{position:relative}
.me>summary{list-style:none;cursor:pointer;display:block;border-radius:50%}
.me>summary::-webkit-details-marker{display:none}
.me[open]>summary .viewer,.me>summary:hover .viewer{border-color:var(--ink)}
.me-card{position:absolute;left:36px;bottom:-2px;min-width:190px;max-width:280px;z-index:6;background:var(--panel);border:1px solid var(--line);
border-radius:8px;padding:10px 12px;box-shadow:var(--theme-shadow-md);font-size:12px;text-align:left}
.me-card b{display:block;color:var(--strong);font-weight:600;word-break:break-word}
.me-card .sub{display:block;color:var(--dim);word-break:break-all}
.me-card form{margin:8px 0 0;padding-top:8px;border-top:1px solid var(--hairline)}
.me-card button{width:100%;justify-content:flex-start;padding:5px 6px;font-size:12px}
.me-card button svg{width:13px;height:13px}
.sidebar{grid-area:side;overflow:auto;background:var(--panel);border-right:1px solid var(--line);min-width:0}
.sidebar .side-view{display:none;padding:14px 12px}
.sidebar .side-view.on{display:block}
.sidebar h3{margin:0 0 2px;font-size:12px;color:var(--ink);text-transform:none;letter-spacing:0}
.sidebar .sub{color:var(--dim);font-size:11px;margin-bottom:12px}
.task{display:block;padding:10px 12px;border:1px solid var(--line);border-radius:7px;margin:0 0 8px;color:var(--ink);text-decoration:none}
.task.on{border-color:var(--accent);background:var(--sunk)}
.task .id{font-size:12px}
.task .meta{color:var(--dim);font-size:10.5px;margin-top:3px}
.task .title{font-size:12px;color:var(--ink)}
.task .tid{font-family:var(--mono-font)}
/* --- agents: an avatar drawn from the agent's seed, a name, one line of
   what it is for. The create form sits in the sidebar, no dialog. */
.avatar{display:inline-block;width:22px;height:22px;flex:none;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--sunk);vertical-align:middle}
.avatar svg{width:100%;height:100%;display:block}
.avatar.lg{width:28px;height:28px}
.avatar[hidden]{display:none}
/* Scoped to the sidebar list: the transcript's model turns are .step.agent
   too, and an unscoped .agent rule laid every turn out as a row. */
#agents .agent{display:flex;align-items:center;gap:9px;padding:8px 10px}
#agents .agent .who{min-width:0;display:flex;flex-direction:column;gap:1px}
#agents .agent .name{font-size:12px;color:var(--ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#agents .agent .desc{font-size:10.5px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#agents .agent .desc.faint{color:var(--faint)}
.new-agent{width:100%;justify-content:center;margin:0 0 10px;gap:6px}
.new-agent svg{width:14px;height:14px}
.new-agent[hidden]{display:none}
.new-agent-form{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--line);border-radius:7px;margin:0 0 10px;background:var(--panel)}
.new-agent-form[hidden]{display:none}
.new-agent-form label{display:flex;flex-direction:column;gap:4px;color:var(--dim);font-size:11.5px}
.new-agent-form label i{color:var(--faint);font-style:normal}
.new-agent-form .pick,.new-agent-form .row{display:flex;align-items:center;gap:8px}
.new-agent-form .err{font-size:11px;color:var(--bad)}
.err.write-err{color:var(--bad);font-size:11px;margin-top:6px}
.new-agent-form .err[hidden]{display:none}
.new-agent-form .hint{padding:0;font-size:10.5px}
textarea{background:var(--layer-panel);border:1px solid var(--line-field);border-radius:6px;color:var(--ink);font:inherit;font-size:12px;padding:6px 8px;resize:vertical;min-height:56px;width:100%}
textarea:hover{border-color:var(--line-field-hover)}
textarea:focus{outline:0;box-shadow:0 0 0 1px var(--primary-400)}
.view-head #agent-avatar{margin-right:2px}
.send-err{font-size:11.5px;color:var(--bad);padding:0 13px 10px}
.send-err[hidden]{display:none}
.view-head .sub.faint{color:var(--faint)}
.mount-link{display:block;padding:9px 12px;border:1px solid var(--line);border-radius:7px;margin:0 0 8px;color:var(--ink);text-decoration:none}
.mount-link.on{border-color:var(--accent);background:var(--sunk)}
.mount-link .id{font-size:12px}.mount-link .id .sub{color:var(--dim);font-size:11px}
.mount-link .meta{margin-top:4px}
.side-link{display:block;color:var(--dim);font-size:11px;margin-top:12px;text-decoration:none}
.side-link:hover{color:var(--ink)}
main.main{grid-area:main;overflow:auto;padding:14px 16px;min-width:0;display:flex;flex-direction:column}
section.view{display:none;flex-direction:column;gap:12px;flex:1;min-height:0;background:none;border:0;border-radius:0;overflow:visible}
section.view[data-view=agents].on{height:100%}
.view>.body{background:var(--panel);border:1px solid var(--line);border-radius:8px;max-height:none}
.view.on{display:flex}
.view-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.view-head h2{border:0;padding:0;font-size:15px;color:var(--ink);text-transform:none;letter-spacing:0;font-weight:600}
.view-head .sub{color:var(--dim);font-size:11px}
.view-head .spacer{flex:1}
.conv{background:var(--panel);border:1px solid var(--line);border-radius:8px;display:flex;flex-direction:column;
flex:1;min-height:0}
.conv .body{flex:1;min-height:0;max-height:none;overflow:auto}
/* Held calls append as plain flow next to the turns, at most a card taller
   than a long argument block (tygg, 2026-09-13: the strip nobody used is gone).
   A card's argument block wraps rather than running off the edge. */
.held:has(>.empty){display:none}
.held:empty{display:none}
.card pre{white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere}
.inspector{grid-area:insp;overflow:auto;background:var(--panel);border-left:1px solid var(--line);padding:12px;min-width:0}
/* the inspector's tabs, on rUI's Tabs recipe: Elegant is an underline strip
   over a hairline, Brutal a bordered bar with dividers and the active tab
   in Source Yellow */
.inspector .tabs{display:flex;gap:2px;border-bottom:1px solid var(--line-hairline);margin:0 0 10px;overflow-x:auto;scrollbar-width:none}
.inspector .tabs::-webkit-scrollbar{display:none}
.inspector .tabs [role=tab]{background:none;border:0;border-bottom:2px solid transparent;border-radius:0;box-shadow:none;
color:var(--faint);font-size:11px;font-weight:500;padding:8px 6px 9px;margin-bottom:-1px;white-space:nowrap;letter-spacing:0}
.inspector .tabs [role=tab]:hover{color:var(--dim);background:none}
.inspector .tabs [role=tab].on{color:var(--ink);border-bottom-color:var(--primary-400)}
[data-theme="brutal"] .inspector .tabs{gap:0;border:2px solid var(--line-strong);background:var(--layer-panel);padding:0;width:max-content;max-width:100%}
[data-theme="brutal"] .inspector .tabs [role=tab]{padding:6px 6px;font-size:11px;font-weight:600;border:0;border-left:2px solid var(--line-strong);margin:0;color:var(--ink)}
[data-theme="brutal"] .inspector .tabs [role=tab]:first-child{border-left:0}
[data-theme="brutal"] .inspector .tabs [role=tab]:hover{background:color-mix(in oklch,var(--line-strong) 6%,var(--layer-panel))}
[data-theme="brutal"] .inspector .tabs [role=tab].on{background:var(--primary-400);color:var(--primary-950)}
.inspector #insp{max-height:none;padding:6px 2px}
header .sub{color:var(--dim);font-size:12px}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
h2{font-size:12px;margin:0;padding:9px 13px;border-bottom:1px solid var(--line);
color:var(--dim);text-transform:uppercase;letter-spacing:.09em;font-weight:600}
.body{padding:13px;max-height:62vh;overflow:auto}
.ev{padding:7px 0;border-bottom:1px solid var(--line)}
.ev:last-child{border-bottom:0}
.k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.msg{white-space:pre-wrap;word-break:break-word;margin-top:3px}
form{display:flex;gap:8px;padding:13px;border-top:1px solid var(--line)}
/* --- primitives, on rUI's Elegant recipes ---------------------------------
   Input: layer-card on dark with inset shadows and no visible border, a field
   border on light, a one-pixel primary ring on focus. Button: the accent
   family for a core action (send, approve, attach), outline for the quiet
   ones, danger solid for the destructive one; all bordered with line-strong,
   rounded 6, a hairline shadow. Badge: a soft wash with the strong text. */
input[type=text],input[type=password]{flex:1;min-width:0;background:var(--layer-panel);border:1px solid var(--line-field);
color:var(--ink);padding:8px 12px;border-radius:6px;font:inherit;font-size:13px;transition:border-color .2s ease-out,background .2s ease-out}
.dark input[type=text],.dark input[type=password]{background:var(--layer-card);border-color:transparent;color:var(--strong);
box-shadow:inset 0 1px 2px oklch(0 0 0/.3),inset 0 0 0 1px oklch(0 0 0/.35),0 1px 0 oklch(0.985 0.004 106.42/.04)}
input::placeholder{color:var(--faint);opacity:.7}
input[type=text]:hover,input[type=password]:hover{border-color:var(--line-field-hover)}
.dark input[type=text]:hover,.dark input[type=password]:hover{border-color:var(--ink-8)}
input[type=text]:focus,input[type=password]:focus{outline:0;box-shadow:0 0 0 1px var(--primary-400)}
button{display:inline-flex;align-items:center;gap:6px;background:var(--accent-400);border:1px solid var(--line-strong);
color:var(--accent-950);padding:7px 12px;border-radius:6px;font:inherit;font-size:12.5px;font-weight:600;
line-height:1.2;cursor:pointer;box-shadow:var(--theme-shadow-xs);transition:background .15s ease-out,border-color .15s ease-out}
button:hover{background:var(--accent-500)}
button.ghost{background:transparent;color:var(--ink);box-shadow:none}
button.ghost:hover{background:var(--fill-muted)}
button.bad{background:var(--danger);color:var(--danger-foreground)}
button.bad:hover{background:var(--danger);border-color:var(--danger)}
button.primary{background:var(--primary-400);color:var(--primary-950)}
button:disabled{opacity:.45;cursor:not-allowed;box-shadow:none}
:focus-visible{outline:2px solid var(--primary-400);outline-offset:2px}
/* a mount's credential: what is attached, never what it is */
.cred{margin-top:8px;padding-top:8px;border-top:1px dashed var(--line);font-size:12px}
.cred .state{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.cred .state b{color:var(--ok)}
.cred .state b.unverified{color:var(--warn)}
.cred .when{color:var(--dim)}
.cred form{display:flex;flex-direction:column;gap:7px;padding:6px 0 0;border:0}
.cred label{display:flex;flex-direction:column;gap:4px;color:var(--dim);font-size:11.5px}
.cred label i{color:var(--faint);font-style:normal}
.cred .row{display:flex;gap:8px;align-items:center}
.cred .err{color:var(--bad)}
.cred details{margin-top:4px}
.cred details summary{margin-top:0}
.cred form.inline{flex-direction:row;padding:0}
.card{border:1px solid var(--warning-muted);border-left:3px solid var(--warn);background:var(--layer-card);
border-radius:8px;padding:12px 14px;margin-bottom:11px}
.card .tool{color:var(--warn);font-weight:600}
pre{background:var(--sunk);border:1px solid var(--line);border-radius:6px;
padding:9px;overflow:auto;margin:8px 0;font-size:12px}
.row{display:flex;gap:8px;margin-top:9px}
.empty{color:var(--dim);padding:6px 0}

.hint{color:var(--dim);font-size:12px;padding:0 13px 13px}

/* --- rendered markdown ------------------------------------------------- */
/* white-space is normal here: the renderer produced real blocks, so keeping
   pre-wrap would double every gap the markup already makes. */
.md{white-space:normal}
.md p{margin:0 0 7px}
.md p:last-child{margin-bottom:0}
.md .mdh{font-weight:600;margin:12px 0 5px;line-height:1.35}
.md .mdh:first-child{margin-top:0}
.md .h1{font-size:16px}.md .h2{font-size:14px}
.md .h3,.md .h4{font-size:13px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.md ul,.md ol{margin:0 0 7px;padding-left:20px}
.md li{margin:1px 0}
.md code{background:var(--sunk);border:1px solid var(--line);border-radius:4px;
padding:0 4px;font-size:12px;color:var(--ok)}
.md pre{white-space:pre-wrap;word-break:break-word}
.md pre code{background:0;border:0;padding:0;color:inherit}
.md table{margin:6px 0 9px}
.md th,.md td{padding:3px 10px 3px 0}
.md blockquote{margin:6px 0;padding-left:10px;border-left:2px solid var(--line);color:var(--dim)}
.md hr{border:0;border-top:1px solid var(--line);margin:10px 0}
.md a{color:var(--accent)}
.md strong{color:var(--strong);font-weight:600}
/* The model's own reasoning: present, and folded away, because it is context
   for a person debugging rather than part of what the agent said. */
.think{margin:0 0 7px}
.think summary{color:var(--faint);font-size:11px;text-transform:uppercase;letter-spacing:.07em}
.think[open] summary{color:var(--dim);margin-bottom:5px}
.think>.md{border-left:2px solid var(--line);padding-left:10px;color:var(--dim);font-size:13px}

/* --- debugging console ------------------------------------------------- */
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--dim);font-weight:600;padding:4px 8px 4px 0;
border-bottom:1px solid var(--line);text-transform:uppercase;font-size:10px;letter-spacing:.06em}
td{padding:4px 8px 4px 0;border-bottom:1px solid var(--hairline);vertical-align:top;
word-break:break-word}
tr:last-child td{border-bottom:0}
.num{text-align:right;color:var(--dim);font-variant-numeric:tabular-nums}
h3{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;
margin:16px 0 6px;font-weight:600}
h3:first-child{margin-top:0}
/* timeline: one tick per event, placed by time, so a gap looks like a gap */
.tl{position:relative;height:34px;background:var(--sunk);border:1px solid var(--line);
border-radius:6px;margin:4px 0 2px;overflow:hidden}
.tl i{position:absolute;top:4px;width:2px;height:26px;background:var(--dim);border-radius:1px}
.tl i.model{background:var(--model)}.tl i.js{background:var(--js)}
.tl i.msg{background:var(--ok)}.tl i.op{background:var(--fill-strong)}
.tl i.bad{background:var(--bad);width:3px}
.axis{display:flex;justify-content:space-between;color:var(--faint);font-size:10px}
/* stacked bars for prompt cache and completion, per model call */
.bars{display:flex;flex-direction:column;gap:3px;margin-top:4px}
.bar{display:flex;align-items:center;gap:6px;font-size:11px}
.bar .n{color:var(--faint);width:22px;text-align:right;flex:none}
.bar .t2{flex:1;display:flex;height:12px;border-radius:3px;overflow:hidden;background:var(--sunk)}
.bar .cached{background:var(--js-soft)}.bar .fresh{background:var(--js)}
.bar .out{background:var(--model)}
.bar .v{color:var(--dim);flex:none;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:12px;color:var(--dim);font-size:11px;margin-top:6px;flex-wrap:wrap}
.legend b{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
/* The events trace: a waterfall of turns and calls, then call rows in the turn cards. */
.wf{display:flex;flex-direction:column;gap:2px;background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:6px 8px}
.wf-row{display:grid;grid-template-columns:minmax(88px,26%) 1fr 52px;align-items:center;gap:8px;color:inherit;text-decoration:none;font-size:11px;min-height:16px}
.wf-row:hover .wf-label{color:var(--strong)}
.wf-label{color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wf-label.sub{padding-left:12px}
.wf-track{position:relative;height:10px;background:var(--panel);border-radius:2px;overflow:hidden}
.wf-track i{position:absolute;top:0;height:10px;border-radius:2px;background:var(--fill-strong);min-width:2px}
.wf-track i.model{background:var(--model)}.wf-track i.js{background:var(--js)}.wf-track i.op{background:var(--fill-strong)}.wf-track i.bad{background:var(--bad)}
.wf-dur{color:var(--faint);font-size:10px;text-align:right;white-space:nowrap}
.call{margin:8px 0 0;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--panel)}
.call.js{border-left:3px solid var(--js)}.call.tool{border-left:3px solid var(--fill-strong)}
.call .k{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px}
.call .k b{color:var(--strong);font-weight:600;text-transform:none;letter-spacing:0}
.call .kind{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);border:1px solid var(--line);border-radius:3px;padding:0 4px}
.call details{margin-top:4px}.call pre{margin:4px 0 0;max-height:320px;overflow:auto}
.step.note{border-color:var(--line);color:var(--dim)}
.chip.bad{color:var(--danger-strong);border-color:var(--danger-muted);background:var(--danger-soft)}
details.raw{margin-top:14px;color:var(--dim)}details.raw>summary{cursor:pointer}
[data-theme="brutal"] .wf,[data-theme="brutal"] .call{border-radius:0;border-width:2px;border-color:var(--line-strong)}
[data-theme="brutal"] .call.js,[data-theme="brutal"] .call.tool{border-left-width:4px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12px}
.issued{border:1px solid var(--line-strong);padding:10px;margin:0 0 12px}.issued pre.key{user-select:all;overflow-x:auto;margin:8px 0}
form.new-key{display:flex;gap:8px;align-items:end;padding:0;border:0}
table.keys{width:100%;border-collapse:collapse;font-size:12px;margin-top:12px}table.keys th,table.keys td{text-align:left;padding:4px 8px;border-bottom:1px solid var(--line)}
table.keys form{padding:0;border:0}
.kv div:nth-child(odd){color:var(--dim)}
.doc{background:var(--sunk);border:1px solid var(--line);border-radius:6px;padding:8px;
white-space:pre-wrap;word-break:break-word;font-size:12px;margin:4px 0 10px}
/* --- scrollbars, on rUI's ScrollArea recipe ------------------------------
   A six-pixel rounded thumb inside a twelve-pixel transparent track, black
   at 35% under Brutal and foreground-muted at 35% under Elegant, darker on
   hover, no buttons. Native scrollbars styled to the same recipe, since a
   server-rendered page has no ScrollArea component to wrap its regions in.
   Applies to every region that scrolls: the panes, the panel bodies, the
   transcript and code blocks. */
/* Chromium ignores the ::-webkit-scrollbar rules once the standard properties
   are set, so those go only to engines without the pseudo-elements. */
@supports not selector(::-webkit-scrollbar){*{scrollbar-width:thin;scrollbar-color:var(--scroll-thumb) transparent}}
:root{--scroll-thumb:color-mix(in oklab,var(--foreground-muted) 35%,transparent);--scroll-thumb-hover:color-mix(in oklab,var(--foreground-muted) 55%,transparent)}
[data-theme="brutal"]{--scroll-thumb:oklch(0 0 0/.35);--scroll-thumb-hover:oklch(0 0 0/.55)}
::-webkit-scrollbar{width:12px;height:12px;background:transparent}
::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}
::-webkit-scrollbar-thumb{background-color:var(--scroll-thumb);background-clip:padding-box;border:3px solid transparent;border-radius:999px;min-height:28px}
::-webkit-scrollbar-thumb:hover{background-color:var(--scroll-thumb-hover)}
::-webkit-scrollbar-button{display:none;width:0;height:0}
/* --- Brutal: square corners, two-pixel line-strong borders, hard offset
   shadows, the family's own recipe. Elegant keeps the rounded, shadowed
   treatment above. Applied by attribute so switching themes changes shape
   as well as colour, which is what makes them two themes and not two
   palettes. */
[data-theme="brutal"] button,[data-theme="brutal"] input[type=text],[data-theme="brutal"] input[type=password],
[data-theme="brutal"] .card,[data-theme="brutal"] .mount,[data-theme="brutal"] .plug,[data-theme="brutal"] .conv,
[data-theme="brutal"] .view>.body,[data-theme="brutal"] .task,[data-theme="brutal"] .mount-link,
[data-theme="brutal"] .banner,[data-theme="brutal"] .rail-item,[data-theme="brutal"] .mode,[data-theme="brutal"] pre,
[data-theme="brutal"] .badge,[data-theme="brutal"] .tag{border-radius:0}
[data-theme="brutal"] button{border:2px solid var(--line-strong);box-shadow:var(--theme-shadow-sm)}
[data-theme="brutal"] button:hover{box-shadow:var(--theme-shadow-md)}
[data-theme="brutal"] button.ghost{border-color:var(--line-strong);box-shadow:none}
[data-theme="brutal"] button:disabled{box-shadow:none}
[data-theme="brutal"] input[type=text],[data-theme="brutal"] input[type=password]{border:2px solid var(--line-strong);background:var(--layer-panel);box-shadow:var(--theme-shadow-sm)}
[data-theme="brutal"] input[type=text]:focus,[data-theme="brutal"] input[type=password]:focus{box-shadow:var(--theme-shadow-md)}
[data-theme="brutal"] .conv,[data-theme="brutal"] .view>.body{border:2px solid var(--line-strong);box-shadow:var(--theme-shadow-md)}
[data-theme="brutal"] .card,[data-theme="brutal"] .mount,[data-theme="brutal"] .plug{border:1px solid var(--line-strong);margin:8px 0;box-shadow:none}
/* A card inside a framed panel keeps a hairline, not the offset shadow:
   stacked 2px borders + shadows read as black boxes overlapping each other. */
[data-theme="brutal"] .card{border-left-width:2px}
[data-theme="brutal"] .task,[data-theme="brutal"] .mount-link{border:2px solid var(--line-strong)}
[data-theme="brutal"] .task.on,[data-theme="brutal"] .mount-link.on{background:var(--primary-soft)}
[data-theme="brutal"] .rail-item.on{border:2px solid var(--line-strong);background:var(--primary-400);color:var(--primary-950);box-shadow:var(--theme-shadow-sm)}
[data-theme="brutal"] .rail,[data-theme="brutal"] .sidebar,[data-theme="brutal"] .inspector{border-color:var(--line-strong)}
[data-theme="brutal"] .badge,[data-theme="brutal"] .tag{border:1px solid var(--line-strong)}
[data-theme="brutal"] .mode{border:2px solid var(--line-strong)}
[data-theme="brutal"] .mode button{border:0;box-shadow:none}
[data-theme="brutal"] .mode button.on{background:var(--primary-400);color:var(--primary-950)}
[data-theme="brutal"] .me-card{border:2px solid var(--line-strong);border-radius:0}
[data-theme="brutal"] .avatar,[data-theme="brutal"] textarea,[data-theme="brutal"] .new-agent-form{border-radius:0;border:2px solid var(--line-strong)}
[data-theme="brutal"] textarea{background:var(--layer-panel);box-shadow:var(--theme-shadow-sm)}
[data-theme="brutal"] textarea:focus{box-shadow:var(--theme-shadow-md)}
[data-theme="brutal"] h1.brand .bar{fill:var(--primary-400);stroke:var(--primary-400)}
.pane-btn{display:none;background:transparent;border:1px solid var(--line);color:var(--dim);box-shadow:none;padding:6px 10px;font-size:11.5px;gap:5px}
.pane-btn svg,.pane-close svg{width:14px;height:14px}
.pane-btn.on{color:var(--accent);border-color:var(--accent)}
.sidebar .pane-close,.inspector .pane-close{display:none}
/* --- phone: one pane at a time, the rail as a bottom nav ------------------
   rUI's MobileNav shape. body[data-pane] chooses which pane fills the
   screen; the conversation head carries the two buttons that switch to the
   sidebar and the inspector, and either one returns to main. */
@media(max-width:760px){
  body.shell,body.shell[data-view]{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(0,1fr) 58px;grid-template-areas:"main" "rail"}
  .rail{flex-direction:row;justify-content:space-around;align-items:center;gap:0;padding:0 4px;border-right:0;border-top:1px solid var(--line)}
  .rail-brand,.rail-foot .mode,.rail-item[href^="https"]{display:none}
  .rail-foot{margin:0}
  .me-card{left:auto;right:0;bottom:40px}
  .rail-item{width:auto;min-width:60px;padding:6px 4px 5px;font-size:10px}
  .sidebar,.inspector{grid-area:main;display:none;border:0}
  body[data-pane=side] .sidebar,body[data-pane=insp] .inspector{display:block}
  body[data-pane=side] main.main,body[data-pane=insp] main.main{display:none}
  main.main{padding:12px}
  .pane-btn{display:inline-flex}
  button{min-height:40px;padding:9px 14px;font-size:13px}
  input[type=text],input[type=password]{min-height:40px;font-size:15px}
  .view-head h2{font-size:14px}
  .conv .body{max-height:none}
  /* The composer hint explains steer/after; on a phone that legend costs the
     conversation real space it already is short of. */
  .send-hint{display:none}
}
@media(max-width:760px){.sidebar .pane-close,.inspector .pane-close{display:inline-flex;margin:10px 12px 0}}
`;

/**
 * The console, as a product rather than a debugging page.
 *
 * Three sections on a rail. A conversation shows the transcript with any
 * held call above the composer — approve or refuse it right there; beside
 * it the inspector opens what is hard to see from outside — the events,
 * the plugins, what the agent believes, where the time went — one tab at a
 * time. Plugins is its own section.
 * Every panel is still a plain GET that renders the store directly; the
 * shell keeps only which section is showing and which mode the viewer chose.
 */
/**
 * Who is looking, as the rail shows it. Every field is optional: the QA
 * identity is a name alone, and a GitHub login carries all four with
 * `picture` possibly null and `email` possibly a placeholder, so the card
 * prefers the handle for its second line. `who` stays the identity string
 * the routes key on; this is only what is drawn.
 */
export type Viewer = { email?: string | null; name?: string | null; username?: string | null; picture?: string | null };

/** The rail's corner: an avatar, and behind it who that is and the way out. */
export function viewerBadge(who: string, viewer?: Viewer): string {
  const label = (viewer?.name || viewer?.email || who || "?").trim();
  const initial = label.slice(0, 1) || "?";
  const pic = viewer?.picture
    ? `<img src="${esc(viewer.picture)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">`
    : "";
  const face = `<span class="viewer" title="${esc(label)}">${esc(initial)}${pic}</span>`;
  // Without a viewer object there is no session to end (the identity came
  // from the edge, or from a header), so the face is all there is.
  if (!viewer) return face;
  const sub = viewer.username ? `@${viewer.username}` : viewer.email && viewer.email !== viewer.name ? viewer.email : "";
  return `<details class="me"><summary aria-label="signed in as ${esc(label)}">${face}</summary>
      <div class="me-card"><b>${esc(label)}</b>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}
        <form method="post" action="/logout"><button type="submit" class="ghost">${ICONS.logout}sign out</button></form></div></details>`;
}

export function page(_taskId: string, who: string, agentId: string, viewer?: Viewer): string {
  // The first argument is the conversation id the route used to pass. An
  // agent has one conversation now, so the page carries no task id; the
  // routes default to the agent's own. The parameter stays so the call site
  // in index.ts does not change. `viewer` is what the rail draws for the
  // person; when the route has only a string, the face is their initial.
  // A lazily loaded, polled fragment: loads when its view or section is shown,
  // then re-reads the store every few seconds while it stays shown. The
  // condition is evaluated by htmx against the element, so a hidden view
  // costs nothing, and neither does a tab nobody is looking at: every poll
  // on the page starts with `awake`, and the visibilitychange listener at
  // the bottom catches the panels up the moment the tab is shown again.
  const awake = "!document.hidden";
  const inView = "this.closest('.view').classList.contains('on')";
  const inspTab = (name: string) => `<button type="button" role="tab" data-insp="${name}" onclick="ap.insp('${name}')">${name}</button>`;
  const a = encodeURIComponent(agentId);
  const rail = (view: string, label: string) =>
    `<a class="rail-item" data-view="${view}" href="/ui?view=${view}&agentId=${a}" onclick="ap.show('${view}');return false"><span class="ico">${ICONS[view]}</span><span>${label}</span></a>`;
  return `<!doctype html><html lang="en" data-theme="brutal"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>antiproton</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
<script>(function(){var t='brutal';try{t=localStorage.getItem('ap-theme')||'brutal'}catch(e){}var h=document.documentElement;if(t==='elegant'){h.setAttribute('data-theme','elegant');h.classList.add('light')}else if(t==='elegant-dark'){h.setAttribute('data-theme','elegant');h.classList.add('dark')}else{h.setAttribute('data-theme','brutal')}})()</script>
${HEAD_ASSETS}
<style>${FONT_CSS}${RUI_TOKENS}${CSS}${USAGE_CSS}</style></head><body class="shell" data-view="agents" data-agent="${esc(agentId)}">
<nav class="rail" aria-label="sections">
  <a class="rail-brand" href="/ui" title="antiproton">${MARK_OUTLINED_SVG}</a>
  ${rail("agents", "agents")}
  ${rail("plugins", "plugins")}
  ${rail("usage", "usage")}
  ${rail("keys", "api keys")}
  <a class="rail-item" href="https://report.antiproton.ai/" target="_blank" rel="noopener"><span class="ico">${ICONS.report}</span><span>report</span></a>
  <div class="rail-foot">
    <div class="mode" role="group" aria-label="theme">
      <button type="button" data-theme-choice="brutal" onclick="ap.theme('brutal')" aria-label="Brutal" title="Brutal">${ICONS.brutal}</button>
      <button type="button" data-theme-choice="elegant" onclick="ap.theme('elegant')" aria-label="Elegant" title="Elegant">${ICONS.light}</button>
      <button type="button" data-theme-choice="elegant-dark" onclick="ap.theme('elegant-dark')" aria-label="Elegant dark" title="Elegant dark">${ICONS.dark}</button>
    </div>
    ${viewerBadge(who, viewer)}
  </div>
</nav>
<aside class="sidebar" id="sidebar">
  <button type="button" class="ghost pane-close" onclick="ap.pane('main')">${ICONS.back}back</button>
  <div class="side-view" data-for="agents">
    <h3>agents</h3>
    <div class="sub">yours, newest first</div>
    <button type="button" class="ghost new-agent" id="new-agent-btn" onclick="ap.newAgentForm(true)">${ICONS.plus}new agent</button>
    <form class="new-agent-form" id="new-agent" hidden onsubmit="ap.createAgent(event)">
      <div class="pick"><span class="avatar lg" id="new-agent-avatar"></span>
        <button type="button" class="ghost" onclick="ap.reroll()" title="another avatar">another</button>
        <input type="hidden" name="avatar" id="new-agent-seed"></div>
      <label><span>name</span><input type="text" name="name" maxlength="60" required autocomplete="off" spellcheck="false" placeholder="what to call it"></label>
      <label><span>description <i>(optional)</i></span><textarea name="description" maxlength="2000" rows="3" placeholder="what this agent is for. It goes into the agent's instructions, word for word."></textarea></label>
      <div class="err" id="new-agent-err" hidden></div>
      <div class="row"><button type="submit">create</button><button type="button" class="ghost" onclick="ap.newAgentForm(false)">cancel</button></div>
      <div class="hint">Each agent starts with its own mounts, credentials and memory. Nothing is copied from another agent.</div>
    </form>
    <div id="agents" data-lazy hx-get="/ui/agents" hx-swap="innerHTML" hx-trigger="ap:show, every 5s[${awake} && document.body.dataset.view==='agents']"
         hx-on::after-swap="ap.markAgent()"></div>
  </div>
  <div class="side-view" data-for="plugins">
    <h3>mounts</h3>
    <div class="sub">this agent's authorities</div>
    <div id="mounts" data-lazy hx-get="/ui/plugins?part=mounts" hx-swap="innerHTML"
         hx-trigger="ap:show, every 5s[${awake} && document.body.dataset.view==='plugins']" hx-on::after-swap="ap.markMount()"></div>
    <a class="side-link" href="/ui?view=plugins&alias=" onclick="ap.mount('');return false">installed on this deployment →</a>
  </div>
</aside>
<main class="main" id="main">
  <section class="view" data-view="agents">
    <div class="view-head"><span class="avatar lg" id="agent-avatar" hidden></span><h2 id="agent-name">${esc(agentId)}</h2>
      <span class="spacer"></span>
      <button type="button" class="pane-btn" onclick="ap.pane('side')">${ICONS.tasks}agents</button>
      <button type="button" class="pane-btn" onclick="ap.pane('insp')">${ICONS.inspector}inspector</button>
      <form hx-post="/ui/compact" hx-target="#transcript" hx-swap="innerHTML"
            hx-on::before-request="ap.busy(this, true)" hx-on::after-request="ap.busy(this, false)" style="padding:0;border:0">
        <button type="submit" class="ghost" title="Summarise the older part of this conversation now, keeping the recent part">compact</button>
      </form></div>
    <div class="conv">
      <div class="body" id="transcript" data-lazy
           hx-get="/ui/chat?held=1" hx-swap="innerHTML"
           hx-trigger="ap:show, every 2s[${awake} && ${inView}]"
           hx-on::after-swap="if(this.dataset.pin!=='0')this.scrollTop=this.scrollHeight"
           onscroll="this.dataset.pin=(this.scrollHeight-this.scrollTop-this.clientHeight<40)?'1':'0'"
           >loading…</div>
      <form id="composer" hx-post="/ui/message" hx-target="#transcript" hx-swap="innerHTML" hx-vals='{"held":"1"}' hx-on::after-request="ap.sent(this, event)">
        <input type="text" name="text" placeholder="ask it something…" autocomplete="off" required>
        <button type="submit" name="mode" value="steer">send</button>
        <button type="submit" name="mode" value="followUp" class="ghost"
                title="Held back until the agent has finished everything it is doing">after</button>
      </form>
      <div class="err send-err" id="send-err" hidden></div>
    </div>
    <div class="hint send-hint" style="padding:0"><b>send</b> steers it mid-flight; <b>after</b> holds until it finishes.
      A held call shows in the flow until you sign it.</div>
  </section>
  <section class="view" data-view="plugins">
    <div class="view-head"><h2 id="plugins-title">Plugins</h2><span class="sub">what is mounted, what it may do, and what it acts as</span></div>
    <div class="body plugins-root" id="plugins" data-lazy hx-get="/ui/plugins" hx-swap="innerHTML"
         hx-trigger="ap:show, every 3s[${awake} && ${inView} && !ap.editing('#plugins')]">loading…</div>
  </section>
  <section class="view" data-view="usage">
    <div class="view-head"><h2>Usage</h2><span class="sub">what every agent in this account used, and what it would cost</span></div>
    <!-- Tenant-wide: the route reads the account's ledger, never an agent, so showing this view wakes nobody.
         Read when shown and not polled: the ledger moves once per finished turn, and showing the view again
         or returning to the tab (both send ap:show) reads it fresh. -->
    <div class="body" id="usage" data-lazy hx-get="/ui/usage" hx-swap="innerHTML" hx-trigger="ap:show">loading…</div>
  </section>
  <section class="view" data-view="keys">
    <div class="view-head"><h2>API keys</h2><span class="sub">for the OpenAI Agents SDK; the agents a key makes are yours</span></div>
    <!-- Read when shown and not polled: a poll would take a new key off the page before it is copied.
         Any re-read (showing this view again, or the tab becoming visible, both send ap:show) also takes
         the new key off the page. That is the shape of "shown once", not a bug: do not keep it around. -->
    <div class="body" id="api-keys" data-lazy hx-get="/ui/api-keys" hx-swap="innerHTML" hx-trigger="ap:show">loading…</div>
  </section>
</main>
<aside class="inspector" id="inspector">
  <button type="button" class="ghost pane-close" onclick="ap.pane('main')">${ICONS.back}back</button>
  <div class="tabs" role="tablist" aria-label="inspector">
    ${inspTab("events")}${inspTab("plugins")}${inspTab("memory")}${inspTab("runtime")}
  </div>
  <div class="body plugins-root" id="insp" role="tabpanel" data-lazy hx-get="/ui/events" hx-swap="innerHTML"
       hx-trigger="ap:show, every 3s[${awake} && document.body.dataset.view==='agents' && !ap.editing('#insp')]">loading…</div>
  <div class="hint" style="padding:8px 0 0">Every tab re-reads the store while it is showing; nothing is cached client-side.</div>
</aside>
<script>
  // The shell's own state: which section is showing and which mode the
  // viewer chose. Both are on the URL or in localStorage, never in the
  // server; every panel is still a plain GET that reads the store.
  ${AVATAR_JS}
  window.ap = {
    // A panel that polls replaces its own form under the person's cursor:
    // the credential box was emptied every three seconds. While any field
    // in the panel is focused or holds text, the poll waits.
    editing(sel) {
      const root = document.querySelector(sel);
      if (!root) return false;
      return [...root.querySelectorAll('input, textarea, select')].some(
        (el) => el === document.activeElement || (el.type !== 'hidden' && el.value));
    },
    show(view) {
      document.body.dataset.view = view; delete document.body.dataset.pane;
      document.querySelectorAll('.rail-item[data-view]').forEach(a => a.classList.toggle('on', a.dataset.view === view));
      document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.dataset.view === view));
      document.querySelectorAll('.side-view').forEach(v => v.classList.toggle('on', v.dataset.for === view));
      const u = new URL(location.href); u.searchParams.set('view', view); history.replaceState(null, '', u);
      document.querySelectorAll('.view.on [data-lazy], .side-view.on [data-lazy]').forEach(el => htmx.trigger(el, 'ap:show'));
    },
    // A send that the server refused must not vanish: htmx swaps nothing on
    // a non-2xx, and a form that resets regardless would eat the text and say
    // nothing. Keep what was typed and say why, under the composer.
    // A 422 with secret:true is the credential intercept (cody, #350/#351):
    // the message never entered history and never reached the model. The
    // answer names the kind and, when the server knows it, the plugins that
    // take it; "send anyway" is an explicit second click, not the default.
    sent(form, ev) {
      const err = document.getElementById('send-err');
      if (ev.detail.successful) { form.reset(); err.hidden = true; return; }
      const xhr = ev.detail.xhr;
      if (xhr && xhr.status === 422) {
        let d = null;
        try { d = JSON.parse(xhr.responseText); } catch { d = null; }
        if (d && d.secret === true) {
          // textContent, not innerHTML: kind and plugins are server data, and
          // this script has no esc() (that is a module-scope helper).
          err.textContent = 'This looks like a credential (' + String(d.kind || 'secret') + ') — it was not sent, and it is not in the conversation. ' +
            (Array.isArray(d.plugins) && d.plugins.length
              ? 'Fill it under the ' + String(d.plugins[0]) + ' mount on the plugins page. '
              : 'No mount here takes this kind — please do not paste it. ');
          const btn = document.createElement('button');
          btn.type = 'submit'; btn.setAttribute('form', 'composer'); btn.name = 'allowSecret'; btn.value = '1';
          btn.className = 'ghost'; btn.textContent = 'send anyway';
          err.appendChild(btn);
          // The button was created after htmx wired the page; without this it
          // submits natively and allowSecret never reaches the request.
          htmx.process(err);
          err.hidden = false;
          return;
        }
      }
      const body = xhr && xhr.responseText ? String(xhr.responseText).replace(/<[^>]*>/g, '').trim().slice(0, 200) : '';
      err.textContent = 'not sent: ' + (xhr ? xhr.status + ' ' : '') + (body || (xhr && xhr.status ? '' : 'could not reach the server'));
      err.hidden = false;
    },
    // A one-shot action like compact must say on the button itself that the
    // request went out; tygg (2026-09-13 #design): the compact button answered
    // with nothing. Its label flips for the flight and flips back on any
    // answer — an empty-looking click was what made it feel unresponsive.
    busy(form, on) {
      const b = form.querySelector('button[title]');
      if (!b) return;
      if (on) { b.dataset.label = b.textContent; b.textContent = '…'; b.disabled = true; }
      else { b.disabled = false; if (b.dataset.label) b.textContent = b.dataset.label; }
    },
    // Switching agents: the agent id goes on the URL and every panel
    // request carries it from there (the configRequest hook below).
    agent(id) {
      const u = new URL(location.href); u.searchParams.set('agentId', id); u.searchParams.set('view', 'agents');
      location.href = u.toString();
    },
    markAgent() {
      const id = document.body.dataset.agent;
      document.querySelectorAll('#agents .agent').forEach(a => a.classList.toggle('on', a.dataset.agent === id));
      const row = document.querySelector('#agents .agent.on');
      if (!row) return;
      document.getElementById('agent-name').textContent = row.dataset.name || id;
      const av = document.getElementById('agent-avatar'), src = row.querySelector('.avatar');
      if (src) { av.innerHTML = src.innerHTML; av.hidden = false; }
    },
    newAgentForm(show) {
      const f = document.getElementById('new-agent'); f.hidden = !show;
      document.getElementById('new-agent-btn').hidden = show;
      if (show) { if (!document.getElementById('new-agent-seed').value) ap.reroll(); f.querySelector('[name=name]').focus(); }
    },
    // The seed is eight hex characters, minted here, kept by the server on
    // the agent. Drawing from it is the same function on both sides.
    reroll() {
      const b = new Uint8Array(4); crypto.getRandomValues(b);
      const seed = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
      document.getElementById('new-agent-seed').value = seed;
      document.getElementById('new-agent-avatar').innerHTML = apAvatar(seed);
    },
    // A refusal is said under the form and what was typed stays; only a
    // created agent leaves the page.
    async createAgent(ev) {
      ev.preventDefault();
      const f = ev.target, err = document.getElementById('new-agent-err'), btn = f.querySelector('[type=submit]');
      err.hidden = true; btn.disabled = true;
      try {
        const r = await fetch('/ui/agent', { method: 'POST', headers: { 'accept': 'application/json' }, body: new URLSearchParams(new FormData(f)) });
        if (!r.ok) { err.textContent = 'could not create the agent: ' + r.status + ' ' + (await r.text()).slice(0, 160); err.hidden = false; return; }
        const d = await r.json(); if (d && d.agentId) ap.agent(d.agentId); else { err.textContent = 'the server returned no agent id'; err.hidden = false; }
      } catch (e) { err.textContent = 'could not reach the server'; err.hidden = false; }
      finally { btn.disabled = false; }
    },
    mount(alias) {
      const u = new URL(location.href); u.searchParams.set('view', 'plugins');
      if (alias) u.searchParams.set('alias', alias); else u.searchParams.delete('alias');
      history.replaceState(null, '', u);
      const panel = document.getElementById('plugins');
      panel.setAttribute('hx-get', alias ? '/ui/plugins?part=mount&alias=' + encodeURIComponent(alias) : '/ui/plugins?part=catalogue'); delete panel.dataset.ver;
      htmx.process(panel); htmx.trigger(panel, 'ap:show');
      document.getElementById('plugins-title').textContent = alias || 'Installed';
      ap.markMount();
    },
    // The usage controls: the choice lives in the URL (a link to this view
    // reopens the same window and split) and in the panel's hx-get, so a
    // re-read when the tab comes back keeps it. A long window reads by day.
    usage(form, changed) {
      if (changed && changed.name === 'window') form.bucket.value = /d$/.test(form.window.value) ? '1d' : '1h';
      const q = new URLSearchParams(new FormData(form));
      const u = new URL(location.href); q.forEach((v, k) => u.searchParams.set(k, v)); history.replaceState(null, '', u);
      const panel = document.getElementById('usage');
      panel.setAttribute('hx-get', '/ui/usage?' + q); delete panel.dataset.ver;
      htmx.process(panel); htmx.trigger(panel, 'ap:show');
    },
    markMount() {
      const a = new URL(location.href).searchParams.get('alias') || '';
      document.querySelectorAll('#mounts .mount-link').forEach(el => el.classList.toggle('on', el.dataset.alias === a));
    },
    // The inspector's tabs: one panel, re-pointed at the chosen fragment. The
    // choice lives on the URL, so a reload and a deep link land on the same tab.
    insp(name) {
      // Three tabs, one question each: what it did (events), what it may do
      // (plugins: the same fragment the rail's plugins view shows), what it
      // believes (memory), what it is billed for and holding (runtime,
      // stacked).
      const paths = { events: '/ui/events', plugins: '/ui/plugins', memory: '/ui/memory', runtime: '/ui/runtime?stack=1' };
      if (!paths[name]) name = 'events';
      document.querySelectorAll('.inspector [role=tab]').forEach(b => { const on = b.dataset.insp === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      const panel = document.getElementById('insp');
      panel.setAttribute('hx-get', paths[name]); delete panel.dataset.ver;
      htmx.process(panel); htmx.trigger(panel, 'ap:show');
      const u = new URL(location.href); u.searchParams.set('insp', name); history.replaceState(null, '', u);
    },
    pane(name) {
      if (name === 'main') delete document.body.dataset.pane; else document.body.dataset.pane = name;
      if (name === 'insp') htmx.trigger(document.getElementById('insp'), 'ap:show');
      if (name === 'side') document.querySelectorAll('.side-view.on [data-lazy]').forEach(el => htmx.trigger(el, 'ap:show'));
    },
    // rUI's three themes: Brutal, Elegant, Elegant dark. The family goes on
    // data-theme; Elegant's mode is a class; Brutal has no dark mode.
    theme(t) {
      const h = document.documentElement; h.classList.remove('light', 'dark');
      if (t === 'elegant') { h.setAttribute('data-theme', 'elegant'); h.classList.add('light'); }
      else if (t === 'elegant-dark') { h.setAttribute('data-theme', 'elegant'); h.classList.add('dark'); }
      else { t = 'brutal'; h.setAttribute('data-theme', 'brutal'); }
      try { localStorage.setItem('ap-theme', t); } catch (e) {}
      document.querySelectorAll('.mode button').forEach(b => b.classList.toggle('on', b.dataset.themeChoice === t));
    },
  };
  // htmx wires the page on DOMContentLoaded, after this script has run, so
  // the first section-show must wait for it or its fetch fires into elements
  // nobody is listening on yet; the next poll would catch up, seconds later.
  document.addEventListener('DOMContentLoaded', function () {
    let t = 'brutal'; try { t = localStorage.getItem('ap-theme') || 'brutal'; } catch (e) {}
    document.querySelectorAll('.mode button').forEach(b => b.classList.toggle('on', b.dataset.themeChoice === t));
    const url = new URL(location.href), v = url.searchParams.get('view');
    if (url.searchParams.has('alias')) {
      const panel = document.getElementById('plugins'), a = url.searchParams.get('alias');
      // htmx read the old URL when it processed the page, before this ran: re-process, or a link to one mount opens the whole page.
      panel.setAttribute('hx-get', a ? '/ui/plugins?part=mount&alias=' + encodeURIComponent(a) : '/ui/plugins?part=catalogue'); delete panel.dataset.ver; htmx.process(panel);
      document.getElementById('plugins-title').textContent = a || 'Installed';
    }
    if (v === 'usage') {
      const q = new URLSearchParams();
      ['window', 'bucket', 'by'].forEach(k => url.searchParams.has(k) && q.set(k, url.searchParams.get(k)));
      const panel = document.getElementById('usage');
      if ([...q].length) { panel.setAttribute('hx-get', '/ui/usage?' + q); delete panel.dataset.ver; htmx.process(panel); }
    }
    ap.show(['agents', 'plugins', 'usage', 'keys'].includes(v) ? v : 'agents');
    ap.insp(url.searchParams.get('insp') || 'trajectory');
  });
  // Poll without re-rendering. Each panel remembers the version it last drew;
  // the server answers 304 when nothing has moved. htmx 1.9 swaps any 2xx or
  // 3xx but 204, so a 304's empty body would empty the panel: the whole
  // conversation went blank the moment polling went quiet.
  // The swap is refused here, explicitly, so a 304 leaves the DOM alone.
  //
  // The version lives on the element that made the request, not in a map
  // keyed by path: the path htmx reports before a request (the hx-get value)
  // and after it (with the query and the agentId it appended) are not the
  // same string, and a map keyed by one and read by the other never hit for
  // a URL with a query, so ?part=mounts re-rendered every poll. One panel,
  // one URL, one version; a panel whose URL is
  // reassigned forgets its version there.
  document.body.addEventListener('htmx:beforeSwap', (e) => {
    if (e.detail.xhr && e.detail.xhr.status === 304) e.detail.shouldSwap = false;
  });
  document.body.addEventListener('htmx:configRequest', (e) => {
    const v = e.detail.elt.dataset.ver;
    if (v) e.detail.headers['x-ap-version'] = v;
    // Every panel reads or writes the current agent. One place, not forty.
    if (!('agentId' in e.detail.parameters)) e.detail.parameters.agentId = document.body.dataset.agent;
  });
  document.body.addEventListener('htmx:afterRequest', (e) => {
    const v = e.detail.xhr && e.detail.xhr.getResponseHeader('x-ap-version');
    if (v) e.detail.elt.dataset.ver = v;
  });
  // A write the server refused swaps nothing (htmx leaves the panel alone),
  // so the failure must be spoken: one line under the form, the server's own
  // reason. Without it a click is indistinguishable from "did not save" —
  // the shape Vera and cody named on 2026-09-15. The composer owns its error
  // (ap.sent), so it is excluded here.
  document.body.addEventListener('htmx:afterRequest', (e) => {
    const elt = e.target;
    const f = elt && elt.closest ? elt.closest('form[hx-post]') : null;
    if (!f || f.getAttribute('hx-post') === '/ui/message') return;
    const xhr = e.detail.xhr;
    let slot = f.querySelector('.write-err');
    if (!slot) { slot = document.createElement('div'); slot.className = 'err write-err'; f.appendChild(slot); }
    // status 0 is "it never left": a network cut or an aborted request is the
    // most ordinary not-saved there is, so it must not pass for success.
    const ok = !!xhr && xhr.status >= 200 && xhr.status < 400;
    slot.hidden = ok;
    if (ok) return;
    // The outer catch answers JSON with an error and a stack: show the error,
    // never the stack. A plain-text reason keeps its own words.
    let reason = '';
    if (xhr && xhr.responseText) {
      const ct = String(xhr.getResponseHeader('content-type') || '');
      if (ct.includes('json')) { try { reason = String((JSON.parse(xhr.responseText) ?? {}).error ?? ''); } catch { reason = ''; } }
      if (!reason) reason = String(xhr.responseText).replace(/<[^>]*>/g, '').trim().slice(0, 160);
    }
    slot.textContent = 'not saved' + (xhr && xhr.status ? ' (' + xhr.status + ')' : '') + (reason ? ': ' + reason : '');
  });
  // Polling stops while the tab is hidden (every trigger tests document.hidden);
  // on return, the shown panels refresh at once rather than waiting out the
  // rest of their interval.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    document.querySelectorAll('.view.on [data-lazy], .side-view.on [data-lazy]').forEach(el => htmx.trigger(el, 'ap:show'));
  });
</script>
</body></html>`;
}

/** One rendered step of the trajectory. */
interface Step {
  at: number;
  sequence: number;
  kind: string;
  payload: any;
}

const CODE = /```(?:js|javascript)?\n([\s\S]*?)```/g;

const pretty = (v: unknown, cap = 4000) => {
  try { return JSON.stringify(v, null, 2).slice(0, cap); }
  catch { return String(v).slice(0, cap); }
};

/**
 * A duration a person can read at a glance.
 *
 * It used to stop at seconds, so a conversation running for hours showed
 * "+9938.2s" — arithmetically right and unreadable, and it looked like a bug
 * rather than a long session.
 */
const secs = (ms: number) => {
  const s = ms / 1000;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  const h = Math.floor(s / 3600);
  return `${h}h ${Math.round((s % 3600) / 60)}m`;
};

const clock = (at: number) =>
  new Date(at).toISOString().slice(11, 19) + "Z";

/**
 * The trajectory, not a log dump.
 *
 * The events already are the trajectory — what was missing was structure. Each
 * model turn is shown with the code it wrote, each execution with what came
 * back, and any call the policy held is shown where it happened together with
 * who signed it. Timings are relative to the first event, so the gaps that
 * matter (waiting for a person) are visible as gaps.
 */
export function trajectory(
  events: Array<{ sequence: number; kind: string; payload: any; createdAt: number }>,
  approvalsByOp: Record<string, { state: string; approver: string | null; tool: string; request: any }>,
  /** Still working, or waiting on a person. A silent page and a dead page look
   *  the same from the outside, and a turn here can take minutes. */
  busy: "thinking" | "waiting-for-approval" | null = null,
): string {
  const who = identityByCall(events);
  const steps: Step[] = events
    .filter((e) => ["message", "model.response", "model.failed", "tool.result", "js.result", "operation.completed"].includes(e.kind))
    .map((e) => ({ at: e.createdAt, sequence: e.sequence, kind: e.kind, payload: e.payload ?? {} }));
  if (!steps.length) return `<div class="empty">nothing yet — say something below.</div>`;

  const t0 = steps[0]!.at;
  let prevAt = t0;
  const out: string[] = [];
  let turn = 0;

  for (const s of steps) {
    // The gap since the previous step, not the elapsed time since the task
    // began. Time-since-start is a number that only grows and answers nothing;
    // the gap is the thing worth seeing, because a stall is a large one. The
    // wall-clock time is on the hover, for orientation.
    const gap = s.at - prevAt;
    const rel = `<span class="t" title="${esc(clock(s.at))} · +${esc(secs(s.at - t0))} into the task">` +
      (gap >= 1000 ? `+${esc(secs(gap))}` : esc(clock(s.at))) + `</span>`;
    prevAt = s.at;
    const p = s.payload;

    if (s.kind === "message") {
      out.push(`<div class="step user"><div class="lbl">you ${rel}</div>
        <div class="msg md">${md(String(p.text ?? ""))}</div></div>`);
      continue;
    }

    if (s.kind === "model.response" && p.purpose === "compaction") {
      out.push(`<div class="step decided"><div class="lbl">compacted ${rel}
        <span class="badge">${esc(p.summarised ?? 0)} earlier step(s) summarised</span></div>
        <details><summary>the handover the agent kept</summary>
        <div class="msg md">${md(String(p.text ?? ""))}</div></details>
        <div class="hint" style="padding:6px 0 0">Only what the model is shown was shortened.
          Every event before this is still in the log and on the events tab.</div>
      </div>`);
      continue;
    }

    if (s.kind === "model.response") {
      turn++;
      const text = String(p.text ?? "");
      const blocks: string[] = [];
      let prose = text;
      for (const m of text.matchAll(CODE)) {
        blocks.push(m[1]!.trim());
        prose = prose.replace(m[0], "");
      }
      const u = p.usage ?? {};
      const badge = u.promptTokens
        ? `<span class="badge">${esc(u.promptTokens)} in · ${esc(u.completionTokens ?? 0)} out` +
          (u.cachedPromptTokens ? ` · ${esc(Math.round(100 * u.cachedPromptTokens / u.promptTokens))}% cached` : "") +
          `</span>`
        : "";
      const calls = (p.toolCalls ?? []) as any[];
      const think = String(p.reasoning ?? "");
      out.push(`<div class="step agent"><div class="lbl">turn ${turn} ${rel} ${badge}</div>
        ${think ? `<details class="think"><summary>thinking · ${esc(u.reasoningTokens ?? 0)} tokens</summary>
          <div class="msg md">${md(think)}</div></details>` : ""}
        ${prose.trim() ? `<div class="msg md">${md(prose.trim())}</div>` : ""}
        ${blocks.map((b) => `<pre class="code">${esc(b)}</pre>`).join("")}
        ${calls.length ? `<div class="calls">${calls.map((c) =>
          `<span class="chip">${esc(c.name)}</span>`).join("")}</div>` : ""}
      </div>`);
      continue;
    }

    if (s.kind === "model.failed") {
      out.push(`<div class="step fail"><div class="lbl">model failed ${rel}</div>
        <div class="msg">${esc(p.error ?? "")}</div></div>`);
      continue;
    }

    if (s.kind === "js.result" || s.kind === "tool.result") {
      const label = s.kind === "js.result" ? "sandbox" : `tool ${p.tool ?? ""}`;
      // `tool.result` carries the call's return under `result`, not `content`:
      // the field was renamed when the loop became pi's, and this reader kept
      // the old name, so every tool step here printed `undefined`. It also fed
      // the held check below, so a call waiting on approval drew no badge.
      // `callRow` has always read `result`; the two now agree.
      const body = s.kind === "js.result" ? p.outputs : p.result;
      const bad = s.kind === "js.result" && p.status !== "completed";
      // A held call surfaces here as a pending result; show it as the gate it is.
      const heldText = typeof body === "string" ? body : JSON.stringify(body ?? "");
      const held = heldText.includes("awaiting_approval");
      // Two reasons a call waits: a policy stopped it, or the agent asked
      // for a word first (confirm: true, recorded as heldBy "agent"). Say which.
      const heldRec = approvalsByOp[String(p.operationId ?? "")];
      const heldWhy = heldRec?.request?.heldBy === "agent" ? "the agent asked you to confirm" : "held for approval";
      out.push(`<div class="step ${held ? "held" : bad ? "fail" : "run"}">
        <div class="lbl">${esc(label)} ${rel}${held ? ` <span class="badge warn">${heldWhy}</span>` : ""}${
        identityBadge(who.get(String(p.callId ?? "")))}</div>
        ${p.source
          ? `<details><summary>what ran</summary><pre class="code">${esc(String(p.source))}</pre></details>`
          : ""}
        <details><summary>${esc(s.kind === "js.result" ? String(p.status ?? "") : "result")}</summary>
        <pre>${esc(typeof body === "string" ? body.slice(0, 4000) : pretty(body))}</pre></details>
      </div>`);
      continue;
    }

    if (s.kind === "operation.completed") {
      const a = approvalsByOp[String(p.operationId)];
      // Still skipped without an approval, and the reason has to keep up with
      // what these carry: a completion now also holds the identity its call was
      // made with, which is news nowhere else — so it is read above and drawn on
      // that call's own row. What is left here is the decision a person made.
      if (!a) continue;
      out.push(`<div class="step decided">
        <div class="lbl">${esc(a.tool)} ${rel}
          <span class="badge ${a.state === "approved" ? "ok" : "bad"}">${esc(a.state)}</span>
          ${a.approver ? `<span class="badge">by ${esc(a.approver)}</span>` : ""}</div>
        <pre>${esc(pretty(a.request?.args ?? {}, 800))}</pre>
      </div>`);
    }
  }
  if (busy) {
    const since = steps.length ? Date.now() - steps[steps.length - 1]!.at : 0;
    out.push(
      busy === "waiting-for-approval"
        ? `<div class="step held live"><div class="lbl">waiting for you to decide
             <span class="t">${esc(secs(since))}</span></div></div>`
        : `<div class="step agent live"><div class="lbl">working<span class="dots"></span>
             <span class="t">${esc(secs(since))}</span></div></div>`,
    );
  }
  return out.join("");
}

/**
 * The calls held in this conversation, waiting for a signature. Only those:
 * a decided call leaves the panel with the decision (task #7), since the
 * panel is for what needs the person now. The history of decisions is in
 * the trajectory and the events tab, where a record belongs.
 */
export function approvals(rows: ApprovalRecord[]): string {
  const pending = rows.filter((r) => r.state === "pending");
  return pending.length
    ? pending.map((a) => {
        const req = a.request as any;
        return `<div class="card">
  <div><span class="tool">${esc(a.mountAlias)}.${esc(a.tool)}</span>${req?.heldBy === "agent" ? ` <span class="badge warn">the agent asked you to confirm</span>` : ""}</div>
  <pre>${esc(JSON.stringify(req?.args ?? {}, null, 2))}</pre>
  <div class="row">
    <button hx-post="/ui/decide" hx-target="#approvals" hx-swap="innerHTML"
      hx-vals='${esc(JSON.stringify({ operationId: a.operationId, decision: "approved" }))}'>approve</button>
    <button class="bad" hx-post="/ui/decide" hx-target="#approvals" hx-swap="innerHTML"
      hx-vals='${esc(JSON.stringify({ operationId: a.operationId, decision: "denied" }))}'>deny</button>
  </div>
</div>`;
      }).join("")
    : `<div class="empty">nothing waiting. Ask the agent to change something.</div>`;
}

// ---------------------------------------------------------------- console

const bytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;

const ago = (t: number) => {
  const d = Date.now() - t;
  return d < 1000 ? "just now" : d < 60_000 ? `${Math.round(d / 1000)}s ago`
    : d < 3_600_000 ? `${Math.round(d / 60_000)}m ago` : `${Math.round(d / 3_600_000)}h ago`;
};

const table = (cols: string[], rows: unknown[][]) =>
  !rows.length ? `<div class="empty">nothing</div>` : `<table><tr>${
    cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>${
    rows.map((r) => `<tr>${r.map((v, i) =>
      `<td class="${i && typeof v === "number" ? "num" : ""}">${esc(v)}</td>`).join("")}</tr>`).join("")
  }</table>`;

/**
 * Where the time went.
 *
 * Every event as a tick placed by when it happened, so a stall reads as an
 * empty stretch rather than as two adjacent rows with distant timestamps —
 * which is exactly how the stalls in this runtime kept hiding.
 */
export function timeline(
  events: Array<{ kind: string; createdAt: number }>,
): string {
  if (events.length < 2) return "";
  const t0 = events[0]!.createdAt;
  const span = Math.max(1, events[events.length - 1]!.createdAt - t0);
  const cls = (k: string) =>
    k.startsWith("model.f") ? "bad" : k.startsWith("model") ? "model"
      : k.startsWith("js") ? "js" : k === "message" ? "msg" : "op";
  const ticks = events.map((e) =>
    `<i class="${cls(e.kind)}" style="left:${((e.createdAt - t0) / span * 100).toFixed(3)}%"
        title="${esc(e.kind)} +${secs(e.createdAt - t0)}"></i>`).join("");
  return `<div class="tl">${ticks}</div>
    <div class="axis"><span>0</span><span>${esc(secs(span))}</span></div>
    <div class="legend">
      <span><b style="background:var(--ok)"></b>message</span>
      <span><b style="background:var(--model)"></b>model</span>
      <span><b style="background:var(--js)"></b>execution</span>
      <span><b style="background:var(--fill-strong)"></b>operation</span>
      <span><b style="background:var(--bad)"></b>failure</span>
    </div>`;
}

/**
 * Prompt cache behaviour, per model call.
 *
 * The single number that decides what a task costs here, and it is invisible
 * anywhere else: a change that breaks the cached prefix shows up as the blue
 * bar swallowing the dark one, turn after turn.
 */
export function tokens(
  events: Array<{ kind: string; payload: any }>,
): string {
  const calls = events.filter((e) => e.kind === "model.response" && e.payload?.usage)
    .map((e) => e.payload.usage as { promptTokens?: number; completionTokens?: number; cachedPromptTokens?: number });
  if (!calls.length) return `<div class="empty">no model calls yet</div>`;
  const widest = Math.max(...calls.map((u) => (u.promptTokens ?? 0) + (u.completionTokens ?? 0)), 1);
  const totals = calls.reduce((a, u) => ({
    p: a.p + (u.promptTokens ?? 0), c: a.c + (u.completionTokens ?? 0),
    cached: a.cached + (u.cachedPromptTokens ?? 0),
  }), { p: 0, c: 0, cached: 0 });
  const rows = calls.map((u, i) => {
    const p = u.promptTokens ?? 0, c = u.completionTokens ?? 0, hit = Math.min(u.cachedPromptTokens ?? 0, p);
    const pc = (n: number) => `${(n / widest * 100).toFixed(2)}%`;
    return `<div class="bar"><span class="n">${i + 1}</span><span class="t2">
      <span class="cached" style="width:${pc(hit)}" title="cached prompt ${hit}"></span>
      <span class="fresh" style="width:${pc(p - hit)}" title="uncached prompt ${p - hit}"></span>
      <span class="out" style="width:${pc(c)}" title="completion ${c}"></span>
    </span><span class="v">${p ? Math.round(hit / p * 100) : 0}%</span></div>`;
  }).join("");
  return `<div class="bars">${rows}</div>
    <div class="legend">
      <span><b style="background:var(--js-soft)"></b>cached prompt</span>
      <span><b style="background:var(--js)"></b>fresh prompt</span>
      <span><b style="background:var(--model)"></b>completion</span>
      <span style="margin-left:auto">${totals.p.toLocaleString()} in · ${totals.c.toLocaleString()} out ·
        ${totals.p ? Math.round(totals.cached / totals.p * 100) : 0}% cached overall</span>
    </div>`;
}

/**
 * The conversation: what a person said, and what the agent said back.
 *
 * The rule is not "does this reply contain a code fence". That was the first
 * attempt and it hid a real answer, because a reply written *to the user* may
 * quote code — the one that broke this quoted the error it was explaining. What
 * separates a working turn from a spoken one is whether it ran: a reply the
 * harness took code out of is followed by a `js.result` before the next reply.
 * That is in the log, so it does not have to be guessed from the prose.
 */
export function conversation(
  events: Array<{ sequence: number; kind: string; payload: any; createdAt: number }>,
): typeof events {
  const out: typeof events = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind === "message") { out.push(e); continue; }
    if (e.kind !== "model.response") continue;
    // A compaction is bookkeeping, not something the agent said.
    if ((e.payload as any)?.purpose === "compaction") continue;
    let executed = false;
    for (let j = i + 1; j < events.length; j++) {
      const n = events[j]!;
      if (n.kind === "model.response" || n.kind === "message") break;
      if (n.kind === "js.result") { executed = true; break; }
    }
    if (!executed) out.push(e);
  }
  return out;
}

/** The raw log. The trajectory is a reading of this; when they disagree, this wins. */
type Ev = { sequence: number; kind: string; payload: any; createdAt: number };

/** One thing the agent asked for: a tool call or a sandbox run, paired with its result when one arrived. */
type Call = {
  id: string; name: string; js: boolean; args: unknown;
  issuedAt: number; result?: Ev; turn: number;
};

/**
 * Pairs each model response's tool calls with the results that came back for
 * them, by call id. A result with no call (an older record, a call the model
 * did not log) becomes a call of its own so nothing is hidden.
 */
function pairCalls(events: Ev[]): { calls: Call[]; turns: Ev[] } {
  const calls: Call[] = []; const byId = new Map<string, Call>(); const turns: Ev[] = [];
  for (const e of events) {
    if (e.kind === "model.response") {
      turns.push(e);
      for (const c of (e.payload?.toolCalls ?? []) as Array<{ id: string; name: string; arguments: unknown }>) {
        const call: Call = { id: String(c.id), name: String(c.name), js: c.name === "run_js", args: c.arguments, issuedAt: e.createdAt, turn: turns.length };
        calls.push(call); byId.set(call.id, call);
      }
    } else if (e.kind === "tool.result" || e.kind === "js.result") {
      const id = String(e.payload?.callId ?? "");
      const call = byId.get(id);
      if (call && !call.result) call.result = e;
      else calls.push({ id, name: String(e.payload?.tool ?? e.kind), js: e.kind === "js.result", args: undefined, issuedAt: e.createdAt, result: e, turn: turns.length });
    }
  }
  return { calls, turns };
}

/**
 * Which identity each failed call was made with, by call id.
 *
 * The gateway records it on `operation.completed` (`src/store/operation-event.ts`)
 * and not on the result, because the envelope a tool returns is collapsed into a
 * string before it reaches the transcript (`src/runtime/pi-tools.ts`): by the time
 * a result becomes an event, only prose is left. `callId` is the one key the two
 * events share, which is why it is the join.
 *
 * The two sides carry the same value because they carry the same id, not because
 * anyone agreed to a name: it is the id pi hands to `execute(toolCallId, …)`,
 * which is `model.response.toolCalls[].id` — the one `pairCalls` above already
 * pairs a result to its call with. A convention could drift; a shared origin
 * cannot.
 *
 * Only failures carry an identity — the gateway sets it where a call threw — so a
 * badge appears exactly where knowing it changes what a person does next, and
 * never on the successful public reads that make up most of a trace.
 *
 * `callId` is not unique: every host call a `run_js` script makes is recorded
 * under the id of the one tool call the model issued (`CompletedFacts`,
 * src/core/store.ts), so one id can carry several operations against several
 * mounts. An identity belongs to a mount, so a row can only claim one when
 * every operation under that id reports the same one — two mounts disagreeing
 * is not a state a single badge can say truthfully, and saying the last one to
 * arrive would be a lie the reader cannot see.
 */
type Who = { identity?: string; credentialRef?: string };
function identityByCall(events: Ev[]): Map<string, Who> {
  const by = new Map<string, Who | null>();
  for (const e of events) {
    if (e.kind !== "operation.completed") continue;
    const p = e.payload ?? {};
    const id = typeof p.callId === "string" ? p.callId : "";
    if (!id || typeof p.identity !== "string") continue;
    const who: Who = { identity: p.identity, ...(typeof p.credentialRef === "string" ? { credentialRef: p.credentialRef } : {}) };
    if (!by.has(id)) { by.set(id, who); continue; }
    const seen = by.get(id);
    // Disagreement is kept as a null rather than dropped, so a later operation
    // that happens to agree with the first cannot revive a claim two others
    // have already broken.
    if (!seen || seen.identity !== who.identity || seen.credentialRef !== who.credentialRef) by.set(id, null);
  }
  // The map above holds three states in two: a `null` is only ever written by
  // the clash branch, never as a first value, so it means "they disagreed" and
  // not "nothing seen". The declared return type is honest because of this
  // filter and nothing else — `who !== undefined` in its place would let a
  // clash out as a `Who` whose `identity` reads `undefined`, which is the
  // page saying "nobody reported one" about a row where two mounts did, and
  // that is the lie this whole function exists to avoid. The guard is the type:
  // `agreed.set` refuses a `Who | null`, so the filter is what makes the call
  // compile (@Rex located it at the return rather than at the collapse where it
  // was written, and broke it to show the error, #plugins:770a1824).
  const agreed = new Map<string, Who>();
  for (const [id, who] of by) if (who) agreed.set(id, who);
  return agreed;
}

/**
 * The identity as a badge, and who can fix it on the hover.
 *
 * `unreported` gets no badge: it means nobody said, and a badge reading
 * "unknown" would claim the page looked into it. That state is already answered
 * in the failure's own words ("either this mount has no account, or the
 * credential it names could not be read"), which names an action a badge cannot.
 *
 * The two anonymous states are one word apart and want opposite actions —
 * attach an account, versus write again the credential of the account already
 * attached — so the badge says which, and the title says who (`credentialRef`).
 *
 * The wording is the page's own, deliberately. The identity crosses from the
 * plugin as fields and not as words (`src/runtime/gateway.ts`, #434), and the
 * two texts have different jobs: a title is read at a glance beside a label,
 * while `identityNote`'s sentence is read inside a failure. A string serving
 * both would be pulled toward one length or the other. What may not diverge is
 * the ACTION each names for a state — a badge that says "attach one" where the
 * failure says "write it again" sends the reader to the wrong person, and
 * `test/console-identity-record.ts` pins that pair (@Rex argued the split,
 * 2026-09-20).
 *
 * None of them is coloured. The row's status badge already carries the alarm,
 * and a second red one beside it competes for the same glance while saying a
 * different kind of thing: `rejected` is what happened, the identity is why.
 * Colour would also have to lie about `account used`, which is the same kind of
 * fact and no warning at all.
 */
function identityBadge(who: Who | undefined): string {
  if (!who) return "";
  if (who.identity === "attached") {
    return ` <span class="badge" title="this mount's account was used, so the answer is about that account, not a missing one">account used</span>`;
  }
  if (who.identity === "none") {
    return ` <span class="badge" title="nothing is attached here: a person attaches an account to this mount">anonymous · no account</span>`;
  }
  if (who.identity === "unreadable") {
    const deployed = who.credentialRef === "operator" || who.credentialRef === "env";
    const title = deployed
      ? "the credential named here belongs to the deployment, which does not hold it: whoever deploys configures it there, and attaching an account to the mount will not help"
      : "a credential is named here but did not arrive: whoever holds it has to write it again, and attaching another account will not help";
    return ` <span class="badge" title="${esc(title)}">anonymous · credential unreadable</span>`;
  }
  return "";
}

const callStatus = (c: Call): { cls: string; word: string } => {
  if (!c.result) return { cls: "warn", word: "no result" };
  const p = c.result.payload ?? {};
  const bad = p.isError || (p.status && p.status !== "succeeded" && p.status !== "completed");
  return bad ? { cls: "bad", word: String(p.status ?? "failed") } : { cls: "ok", word: c.js ? "ran" : "ok" };
};

/** One call, as a row: what, how long, how it ended, and the two things worth opening. */
function callRow(c: Call, t0: number, who?: Who): string {
  const st = callStatus(c);
  const dur = c.result ? secs(c.result.createdAt - c.issuedAt) : "";
  const src = c.js ? (c.args as any)?.source : undefined;
  const argsBlock = c.args === undefined ? ""
    : c.js && typeof src === "string"
      ? `<details open><summary>source</summary><pre class="code">${esc(src)}</pre></details>`
      : `<details><summary>arguments</summary><pre>${esc(pretty(c.args, 4000))}</pre></details>`;
  const rp = c.result?.payload ?? {};
  const body = c.js ? rp.outputs : rp.result;
  const resultBlock = !c.result ? ""
    : `<details${st.cls === "bad" ? " open" : ""}><summary>${c.js ? "outputs" : "result"}${rp.error ? ` · ${esc(String(rp.error?.message ?? rp.error))}` : ""}</summary>
        <pre>${esc(typeof body === "string" ? body.slice(0, 6000) : pretty(body, 6000))}</pre></details>`;
  return `<div class="call ${c.js ? "js" : "tool"}" id="call-${esc(c.id)}">
      <div class="k"><span class="kind">${c.js ? "js" : "tool"}</span> <b>${esc(c.js ? "run_js" : c.name)}</b>
        <span class="badge ${st.cls}">${esc(st.word)}</span>${identityBadge(who)}
        <span class="t" title="issued ${esc(clock(c.issuedAt))}">+${esc(secs(c.issuedAt - t0))}${dur ? ` · ${esc(dur)}` : ""}</span></div>
      ${argsBlock}${resultBlock}</div>`;
}

/**
 * The waterfall: every model turn and every call as a bar on one time axis,
 * so where the seconds went is visible before any card is opened. A model
 * turn's bar runs from the event before it (the moment the model was asked)
 * to its response; a call's bar from the response that issued it to its
 * result. Clicking a bar jumps to the card.
 */
function waterfall(events: Ev[], calls: Call[], turns: Ev[]): string {
  const t0 = events[0]!.createdAt;
  const end = Math.max(events[events.length - 1]!.createdAt, ...calls.map((c) => c.result?.createdAt ?? 0));
  const span = Math.max(1, end - t0);
  const pct = (ms: number) => `${(ms / span * 100).toFixed(2)}%`;
  const rows: string[] = [];
  const prevAt = new Map<Ev, number>();
  for (let i = 0; i < events.length; i++) prevAt.set(events[i]!, i ? events[i - 1]!.createdAt : events[i]!.createdAt);
  turns.forEach((t, i) => {
    const from = prevAt.get(t) ?? t.createdAt, to = t.createdAt;
    const u = t.payload?.usage;
    rows.push(`<a class="wf-row" href="#turn-${i + 1}"><span class="wf-label">turn ${i + 1}</span>
      <span class="wf-track"><i class="model" style="left:${pct(from - t0)};width:${pct(Math.max(to - from, span / 400))}"
        title="model · ${esc(secs(to - from))}${u ? ` · ${u.promptTokens ?? 0} in / ${u.completionTokens ?? 0} out` : ""}"></i></span>
      <span class="wf-dur">${esc(secs(to - from))}</span></a>`);
    for (const c of calls.filter((c) => c.turn === i + 1)) {
      const to2 = c.result?.createdAt ?? end;
      const st = callStatus(c);
      rows.push(`<a class="wf-row" href="#call-${esc(c.id)}"><span class="wf-label sub">${esc(c.js ? "run_js" : c.name)}</span>
        <span class="wf-track"><i class="${c.js ? "js" : "op"}${st.cls === "bad" ? " bad" : ""}" style="left:${pct(c.issuedAt - t0)};width:${pct(Math.max(to2 - c.issuedAt, span / 400))}"
          title="${esc(c.name)} · ${esc(secs(to2 - c.issuedAt))} · ${esc(st.word)}"></i></span>
        <span class="wf-dur">${esc(secs(to2 - c.issuedAt))}</span></a>`);
    }
  });
  return `<div class="wf">${rows.join("")}</div>
    <div class="axis"><span>0</span><span>${esc(secs(span))}</span></div>`;
}

/**
 * The events tab. What the agent did, as calls rather than as payloads: a
 * waterfall of turns and calls on one time axis, then a card per model turn
 * with the calls it made under it, each paired with its result, its
 * duration and how it ended. The JavaScript the agent ran is shown as code,
 * open by default, because it is the thing a person reading a trace most
 * wants to see. The raw records stay at the bottom, closed, for the day the
 * cards hide something.
 */
export function eventList(events: Ev[]): string {
  if (!events.length) return `<div class="empty">no events</div>`;
  const t0 = events[0]!.createdAt;
  const { calls, turns } = pairCalls(events);
  const who = identityByCall(events);
  const js = calls.filter((c) => c.js), tools = calls.filter((c) => !c.js);
  const failed = events.filter((e) => e.kind === "model.failed").length + calls.filter((c) => callStatus(c).cls === "bad").length;
  const usage = turns.reduce((a, t) => {
    const u = t.payload?.usage ?? {};
    return { p: a.p + (u.promptTokens ?? 0), c: a.c + (u.completionTokens ?? 0), cached: a.cached + (u.cachedPromptTokens ?? 0) };
  }, { p: 0, c: 0, cached: 0 });
  const chips = [
    `<span class="chip">${turns.length} model turn${turns.length === 1 ? "" : "s"}</span>`,
    `<span class="chip">${tools.length} tool call${tools.length === 1 ? "" : "s"}</span>`,
    `<span class="chip">${js.length} js run${js.length === 1 ? "" : "s"}</span>`,
    failed ? `<span class="chip bad">${failed} failed</span>` : "",
    `<span class="chip">${esc(secs(events[events.length - 1]!.createdAt - t0))}</span>`,
    usage.p || usage.c ? `<span class="chip" title="prompt / completion / cached">${usage.p} in · ${usage.c} out${usage.cached ? ` · ${Math.round(usage.cached / Math.max(usage.p, 1) * 100)}% cached` : ""}</span>` : "",
  ].filter(Boolean).join(" ");

  // The cards, in order. A turn card owns the calls it issued; everything
  // else (what the person said, a failure, a compaction, an orphan result)
  // is its own row between them.
  const cards: string[] = []; let turnNo = 0;
  for (const e of events) {
    const rel = `<span class="t" title="${esc(clock(e.createdAt))}">+${esc(secs(e.createdAt - t0))}</span>`;
    const p = e.payload ?? {};
    if (e.kind === "message") {
      cards.push(`<div class="step user"><div class="lbl">you ${rel}</div><div class="msg">${esc(String(p.text ?? "")).slice(0, 2000)}</div></div>`);
    } else if (e.kind === "model.response") {
      turnNo++;
      const u = p.usage;
      const mine = calls.filter((c) => c.turn === turnNo && c.args !== undefined);
      cards.push(`<div class="step agent turn" id="turn-${turnNo}">
        <div class="lbl">turn ${turnNo} ${rel}
          ${u ? `<span class="badge">${u.promptTokens ?? 0} in · ${u.completionTokens ?? 0} out${u.cachedPromptTokens ? ` · ${Math.round((u.cachedPromptTokens / Math.max(u.promptTokens ?? 1, 1)) * 100)}% cached` : ""}${u.reasoningTokens ? ` · ${u.reasoningTokens} reasoning` : ""}</span>` : ""}
          ${p.finishReason && p.finishReason !== "stop" && p.finishReason !== "toolUse" ? `<span class="badge warn">${esc(String(p.finishReason))}</span>` : ""}</div>
        ${p.reasoning ? `<details class="think"><summary>thinking</summary><div class="msg">${esc(String(p.reasoning)).slice(0, 4000)}</div></details>` : ""}
        ${p.text ? `<div class="msg">${esc(String(p.text)).slice(0, 4000)}</div>` : ""}
        ${mine.map((c) => callRow(c, t0, who.get(c.id))).join("")}
      </div>`);
    } else if (e.kind === "tool.result" || e.kind === "js.result") {
      const orphan = calls.find((c) => c.result === e && c.args === undefined);
      if (orphan) cards.push(callRow(orphan, t0, who.get(orphan.id)));
    } else if (e.kind === "model.failed") {
      cards.push(`<div class="step fail"><div class="lbl">model failed ${rel}</div><div class="msg">${esc(String(p.error ?? ""))}</div></div>`);
    } else if (e.kind === "compaction") {
      cards.push(`<div class="step note"><div class="lbl">compaction ${rel} <span class="badge">${esc(String(p.tokensBefore ?? "?"))} tokens before</span></div>
        <details><summary>summary</summary><div class="msg">${esc(String(p.summary ?? "")).slice(0, 4000)}</div></details></div>`);
    } else {
      cards.push(`<div class="step note"><div class="lbl">${esc(e.kind)} ${rel}</div><details><summary>payload</summary><pre>${esc(pretty(p, 2000))}</pre></details></div>`);
    }
  }

  return `<div class="calls">${chips}</div>
    <h3>where the time went</h3>${waterfall(events, calls, turns)}
    <h3>what happened</h3>${cards.join("")}
    <details class="raw"><summary>raw records · ${events.length}</summary>${events.slice().reverse().map((e) =>
      `<div class="ev"><div class="k">#${e.sequence} · ${esc(e.kind)}
         <span class="t" title="${esc(clock(e.createdAt))}">+${esc(secs(e.createdAt - t0))}</span></div>
       <details><summary>${esc(pretty(e.payload, 160).replace(/\s+/g, " "))}</summary>
         <pre>${esc(pretty(e.payload, 6000))}</pre></details></div>`).join("")}</details>`;
}

/** Everything the object is holding for this agent and task. */
export function storage(d: any): string {
  const counts = Object.entries(d.counts ?? {})
    .filter(([, n]) => Number(n) > 0)
    .map(([k, n]) => `<span class="chip">${esc(k)} <span class="num">${esc(n)}</span></span>`)
    .join(" ");
  const cfg = (v: string) => { try { return JSON.stringify(JSON.parse(v)); } catch { return v; } };
  return `
<h3>tables</h3><div class="calls">${counts || '<span class="empty">empty</span>'}</div>

<h3>task</h3>
${table(["task", "status", "gen", "ckpt", "state v", "updated"],
    (d.tasks ?? []).map((t: any) => [t.task_id, t.status, t.generation,
      t.checkpoint_version, t.state_version, ago(Number(t.updated_at))]))}

<h3>outbox — what is still out</h3>
${table(["kind", "state", "age"], (d.outbox ?? []).map((o: any) =>
      [o.kind, o.state, ago(Number(o.dispatched_at ?? o.created_at))]))}

<div class="split">
<div><h3>waits</h3>${table(["kind", "operation", "resolved"],
      (d.waits ?? []).map((w: any) => [w.kind, w.operation_id ?? "—", w.resolved ? "yes" : "no"]))}</div>
<div><h3>lease &amp; cursor</h3>${table(["what", "value"], [
      ...(d.leases ?? []).map((l: any) => [`lease ${l.holder ?? ""}`, `fence ${l.fencing_token}`]),
      ...(d.cursors ?? []).map((c: any) => [`cursor ${c.consumer}`, c.consumed_through]),
    ])}</div>
</div>

<h3>mounts</h3>
${table(["alias", "plugin", "config", "credential", "policy"], (d.mounts ?? []).map((m: any) =>
      [m.alias, m.plugin, cfg(m.public_config), m.secret_ref ?? "—",
       m.policy ? cfg(m.policy) : "open"]))}

<h3>connections</h3>
${table(["alias", "state", "updated"], (d.connections ?? []).map((c: any) =>
      [c.alias, String(c.state).slice(0, 120), ago(Number(c.updated_at))]))}

<h3>operations</h3>
${table(["tool", "status", "parked to", "when"], (d.operations ?? []).map((o: any) =>
      [o.tool, o.status, o.result_ref ? "r2" : "—", ago(Number(o.created_at))]))}

<div class="split">
<div><h3>approvals</h3>${table(["tool", "state", "approver"], (d.approvals ?? []).map((a: any) =>
      [a.tool, a.state, a.approver ?? "—"]))}</div>
<div><h3>snapshots</h3>${table(["through", "bytes"], (d.snapshots ?? []).map((s: any) =>
      [s.through_sequence, bytes(Number(s.bytes))]))}</div>
</div>

<h3>model binding</h3>
${d.modelBinding
      ? `<div class="kv"><div>model</div><div>${esc(d.modelBinding.model)}</div>
         <div>endpoint</div><div>${esc(d.modelBinding.base_url)}</div>
         <div>credential</div><div>${esc(d.modelBinding.secret_ref)} <span class="tag ok">resolved server-side</span></div></div>`
      : `<div class="empty">none</div>`}

<h3>quota</h3>
${table(["resource", "used", "limit", "window"], (d.quotas ?? []).map((q: any) =>
      [q.resource, q.used, q.limit_value ?? "none", q.window_ms ? secs(Number(q.window_ms)) : "lifetime"]))}`;
}

/** What the agent believes, in the operator's own view. */
export function memoryPanel(d: any): string {
  const docs = (d.stateDocs ?? []) as any[];
  if (!docs.length) {
    return `<div class="empty">the agent has written nothing yet</div>
      <div class="hint" style="padding:8px 0">It writes here with
      <span class="chip">state.remember</span>; ${WORKING_SET.map((doc) => `<span class="chip">${esc(doc.key)}</span>`).join(" and ")}
      are read back into the system prompt when the agent's harness opens, once for every conversation,
      since the working set belongs to the agent and not to any one conversation.</div>`;
  }
  // The state plugin owns this list; the console imports it so a change on the
  // plugin side changes here too.
  const known = new Set(WORKING_SET.map((doc) => doc.key));
  const one = (r: any) => {
    let v: unknown = null;
    try { v = r.value === null || r.value === undefined ? null : JSON.parse(r.value); } catch { v = r.value; }
    const body = r.ref
      ? `<span class="tag">in object storage</span> ${esc(r.ref)}`
      : esc(typeof v === "string" ? v : pretty(v, 4000));
    return `<h3>${esc(r.key)} ${known.has(r.key) ? '<span class="tag ok">in the prompt</span>' : ""}
        <span class="t" style="text-transform:none">${esc(bytes(Number(r.bytes)))} · ${esc(ago(Number(r.updated_at)))}</span></h3>
      <div class="doc">${body}</div>`;
  };
  const total = (d.state ?? []).reduce((a: number, k: any) => a + Number(k.bytes ?? 0), 0);
  return `<div class="hint" style="padding:0 0 8px">${docs.length} document(s) · ${esc(bytes(total))}
    · written by the agent, editable by you</div>` + docs.map(one).join("");
}

/** Where the object's billed time goes, and whether it is awake when it should be. */
export function runtimePanel(d: any): string {
  const a = d.runtime?.activity ?? {};
  const byKind = (a.byKind ?? []) as Array<{ kind: string; n: number; ms: number }>;
  const rtt = byKind.find((k) => k.kind === "offload_rtt");
  const prov = byKind.find((k) => k.kind === "offload_provider");
  const active = Number(a.activeMs ?? 0);
  const outside = Number(rtt?.ms ?? 0);
  const widest = Math.max(active, outside, 1);
  const bar = (label: string, ms: number, colour: string) =>
    `<div class="bar"><span class="n"></span><span class="t2">
       <span style="width:${(ms / widest * 100).toFixed(2)}%;background:${colour}"></span>
     </span><span class="v">${esc(secs(ms))} ${esc(label)}</span></div>`;
  return `
<h3>is it awake when it should be</h3>
<div class="kv">
  <div>alarm</div><div>${d.runtime?.alarm
      ? `<span class="tag ok">armed</span> ${esc(ago(Number(d.runtime.alarm)))}`
      : `<span class="tag">none</span> — correct while it waits on the queue`}</div>
  <div>alarm failures</div><div>${esc(d.runtime?.alarmFailures ?? 0)}</div>
  <div>still out</div><div>${esc(d.runtime?.outstanding ?? 0)} command(s) awaiting a reply</div>
</div>

<h3>where the time goes</h3>
<div class="bars">
  ${bar("billed inside the object", active, "var(--warn)")}
  ${bar("waited outside it", outside, "var(--ok)")}
  ${prov ? bar("of which the provider", Number(prov.ms), "var(--fill-strong)") : ""}
</div>
<div class="hint" style="padding:6px 0">Durable Objects bill wall clock; Workers bill CPU.
  The green bar is the wait that was moved off the meter — if it collapses, the offload
  stopped working.</div>

<h3>invocations</h3>
${table(["kind", "count", "billed"], byKind.map((k) => [k.kind, k.n, secs(k.ms)]))}

<div class="hint" style="padding:10px 0 0">Container time is billed separately and by the
  second — see the <b>containers</b> section below.</div>`;
}


/**
 * The container, which is the only thing here billed for merely existing.
 *
 * It gets a panel rather than a row because three different questions are asked
 * of it and none is answered by a number: is one running right now (the
 * expensive mistake), how long did each one live, and what came out of it. The
 * last is the point of the sandbox at all — a box is destroyed with everything
 * in it, so the references saved out of it are the only thing that survived,
 * and they were invisible until now.
 */
export function sandboxPanel(d: any): string {
  // Ask the mount what it provides, never which plugin it is. The row carries
  // its plugin's provides declaration, and `mountReports[alias]` is written by
  // whoever can answer — so the page picks a container without learning the
  // plugin's name, and a mount with nothing to report is simply absent.
  const aliases = new Set(
    (d.mounts ?? []).filter((m: any) => (m.provides ?? []).includes("container")).map((m: any) => m.alias));
  // `name` is only read where a container mount exists, so no fallback is
  // needed: an agent with no container-providing mount renders the empty state,
  // which names nothing.
  const name = [...aliases][0];
  // Checked on the way in (mount-reports.ts): the payload crossed a Durable Object boundary as JSON, so it is
  // parsed into the contract types once, here, and what does not read is left out rather than drawn wrong.
  const reports: MountReports = asMountReports(d.mountReports) ?? {};
  const alias = [...aliases].find((a) => reports[a as string]);
  const rep = alias ? reports[alias as string] : null;
  const live = rep?.activity.live ?? null;
  const quietUntil = rep?.activity.quietUntil ?? null;
  const billing = rep?.activity.billing ?? null;
  const unreadable = rep?.activity.unreadable ?? 0;
  const sessions = rep?.usage ?? [];

  // The third case is not "nothing": when part of the mount's own record would
  // not read, whether anything is still running — and still billing — is
  // unknown, and this panel does not guess. The notice says neither "idle" nor
  // "running"; it says the record cannot say.
  const unknownNotice = (n: number) =>
    `<div class="empty">whether anything is still running cannot be determined from this mount's record</div>
     <div class="hint" style="padding:8px 0">${n} of the <span class="chip">${esc(name)}</span> mount's own
     record${n === 1 ? "" : "s"} would not read, so anything it was keeping alive may still be running —
     and still billing. Do not read this mount as idle.</div>`;

  if (!live && !sessions.length) {
    if (unreadable > 0) return unknownNotice(unreadable);
    return `<div class="empty">no container has ever been started for this agent</div>
      <div class="hint" style="padding:8px 0">${aliases.size
        ? `The <span class="chip">${esc(name)}</span> mount is a real machine and the
        most expensive thing the agent can reach — billed for every second it exists,
        not per call. It is meant to stay unused.`
        : `This agent has no container mount at all, so the one thing here billed
        for merely existing stays out of reach.`}</div>`;
  }

  const liveMs = live ? Date.now() - Number(live.startedAt) : 0;
  const total = sessions.reduce((a: number, x: any) => a + (x.endedAt - x.startedAt), 0) + liveMs;
  const widest = Math.max(liveMs, ...sessions.map((x: any) => x.endedAt - x.startedAt), 1);
  const when = (t: number) => new Date(t).toISOString().replace("T", " ").slice(0, 19) + "Z";

  const bar = (ms: number, right: string, colour: string) =>
    `<div class="bar"><span class="n"></span><span class="t2">
       <span style="width:${(ms / widest * 100).toFixed(2)}%;background:${colour}"></span>
     </span><span class="v">${esc(secs(ms))} ${right}</span></div>`;

  // A reference is only useful if you can see what it was.
  const artifact = (ref: string) => {
    const path = "/" + String(ref).split("/sandbox/").slice(1).join("/").split("/").slice(1).join("/");
    return `<div class="ev"><div class="k">${esc(path)}</div>
      <div class="msg" style="color:var(--dim);font-size:11px">${esc(ref)}</div></div>`;
  };
  // Each session's `kept` is only what that one carried out; the mount's whole
  // yield is the union.
  const allSaved: string[] = sessions.flatMap((x: any) => x.kept ?? []);

  return `
<h3>right now</h3>
${live
    ? `<div class="card"><div class="tool">a container is running
         <form hx-post="/ui/sandbox/release" hx-target="closest .body" hx-swap="innerHTML"
               hx-confirm="Release this container? If the agent is still working in it, the request is refused."
               style="padding:0;border:0">
           <input type="hidden" name="alias" value="${esc(name)}">
           <button type="submit" class="ghost" title="Release it now. The idle lease would get it anyway; this just does not wait.">release now</button>
         </form></div>
       <div class="kv" style="margin-top:6px">
         <div>box</div><div>${esc(live.id)}</div>
         <div>alive for</div><div>${esc(secs(liveMs))} <span class="tag bad">still billing</span></div>
         <div>last used</div><div>${esc(ago(Number(live.lastUsedAt)))}</div>
         ${quietUntil ? `<div>kept until</div><div>${esc(when(Number(quietUntil)))} — the agent postponed its release</div>` : ""}
       </div>
       <div class="hint" style="padding:8px 0 0">${billing ? esc(billing) + "." : "It costs the same whether or not anything is running inside it."} If the agent has finished with the machine and not released it, that is the bug to look at.</div></div>`
    : unreadable > 0
      ? unknownNotice(unreadable)
      : `<div class="empty">nothing is running — this costs nothing until the next box starts</div>`}

<h3>sessions — ${esc(secs(total))} of container time across ${sessions.length + (live ? 1 : 0)}</h3>
${live && unreadable > 0
  ? `<div class="hint" style="padding:0 0 6px">some of this mount's own record would not read —
     what is shown below may be incomplete.</div>`
  : ""}
<div class="bars">
  ${live ? bar(liveMs, `<span class="tag bad">live</span>`, "var(--bad)") : ""}
  ${sessions.map((x: any) => bar(x.endedAt - x.startedAt,
      `${x.uses ?? 0} call(s)${x.kept?.length ? ` · ${x.kept.length} saved` : ""}`,
      "var(--ok)")).join("")}
</div>
${table(["started", "lived", "calls", "saved", "box"], sessions.map((x: any) =>
    [when(x.startedAt), secs(x.endedAt - x.startedAt), x.uses ?? "—", (x.kept ?? []).length,
     String(x.id).slice(-14)]))}

<h3>what came out — ${allSaved.length} artifact(s)</h3>
${allSaved.length
    ? allSaved.map(artifact).join("") +
      `<div class="hint" style="padding:8px 0">Everything else in those boxes is gone. These
       survived because the agent called <span class="chip">${esc(name)}.save</span>; they are readable
       with <span class="chip">artifacts.read</span>.</div>`
    : `<div class="empty">nothing was saved out — everything those containers produced is gone</div>`}`;
}


/**
 * What is installed, and what this agent may actually do.
 *
 * Two questions the console used to blur together. A *plugin* is code that is
 * present on the deployment; a *mount* is an authority this agent has been
 * given. The same plugin mounted twice against two accounts is one plugin and
 * two mounts, with two credentials and two session states, and a page that
 * shows only the catalogue cannot explain why one call worked and another was
 * refused.
 *
 * Mounts come first because they are the answer to "why did that happen".
 * Nothing here shows a credential; only whether one is attached.
 */

/**
 * An agent's avatar, drawn from its seed.
 *
 * Eight hex characters, kept by the server on the agent, become a 5×5 block
 * pattern mirrored left to right (fifteen bits) in one of five theme colours
 * (three more bits). Colours are the shell's own variables, so the same
 * avatar follows the theme, and the corners follow it too: the CSS rounds
 * them in Elegant and squares them in Brutal. Sizes are the container's.
 *
 * The same drawing runs in the page, for the preview on the create form,
 * so it exists twice: `avatarSvg` here and `AVATAR_JS`, the same drawing as
 * plain page source. A test holds the two to the same output, seed by seed.
 */
export function avatarSvg(seed: unknown): string {
  let hex = String(seed == null ? "" : seed).toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 8);
  while (hex.length < 8) hex += "0";
  let n = parseInt(hex, 16) >>> 0, cells = "";
  const box = (c: number, r: number) => `<rect x="${c}" y="${r}" width="1" height="1"/>`;
  if ((n & 0x7fff) === 0) n |= 0x40;
  for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if ((n >>> (r * 3 + c)) & 1) { cells += box(c, r); if (c < 2) cells += box(4 - c, r); }
  const tone = ["--accent", "--action", "--ink", "--js", "--ok"][(n >>> 15) % 5];
  return `<svg viewBox="0 0 5 5" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect width="5" height="5" fill="var(--sunk)"/><g fill="var(${tone})">${cells}</g></svg>`;
}
// The page's copy, as plain source. Written out rather than taken from
// avatarSvg.toString(): a bundler rewrites a function's body (esbuild adds a
// __name helper), so the text of a compiled function is not shippable.
// Not new Function either: a Worker refuses code built from strings. The
// test holds this text to avatarSvg, seed by seed.
export const AVATAR_JS = `function apAvatar(seed) {
    var hex = String(seed == null ? '' : seed).toLowerCase().replace(/[^0-9a-f]/g, '').slice(0, 8);
    while (hex.length < 8) hex += '0';
    var n = parseInt(hex, 16) >>> 0, cells = '';
    var box = function (c, r) { return '<rect x="' + c + '" y="' + r + '" width="1" height="1"/>'; };
    if ((n & 0x7fff) === 0) n |= 0x40;
    for (var r = 0; r < 5; r++) for (var c = 0; c < 3; c++) if ((n >>> (r * 3 + c)) & 1) { cells += box(c, r); if (c < 2) cells += box(4 - c, r); }
    var tone = ['--accent', '--action', '--ink', '--js', '--ok'][(n >>> 15) % 5];
    return '<svg viewBox="0 0 5 5" shape-rendering="crispEdges" aria-hidden="true" focusable="false"><rect width="5" height="5" fill="var(--sunk)"/><g fill="var(' + tone + ')">' + cells + '</g></svg>';
  }`;

/**
 * The person's agents for the sidebar, newest first, as the route lists
 * them. The current one is marked by the route and again client-side from
 * the page's own agent id, so a stale list still highlights the right row.
 * A name is what the person typed, cut to the field's limit; an agent with
 * no name shows its id, never a blank. The description is one line here;
 * the whole of it belongs to the agent, not to the list.
 */
export function agentList(d: any): string {
  const agents: any[] = d?.agents ?? [];
  if (!agents.length) return `<div class="empty">no agents yet</div>`;
  const line = (v: unknown) => typeof v === "string" && v.trim() ? esc(v.trim().split("\n")[0].slice(0, 90)) : "";
  return agents.map((ag) => {
    const id = String(ag.agentId ?? "");
    const name = typeof ag.name === "string" && ag.name.trim() ? esc(ag.name.trim().slice(0, 60)) : esc(id);
    const desc = line(ag.description);
    return `<a class="task agent${ag.current ? " on" : ""}" data-agent="${esc(id)}" data-name="${name}" href="/ui?view=agents&agentId=${encodeURIComponent(id)}" onclick="ap.agent('${esc(id)}');return false">
  <span class="avatar">${avatarSvg(String(ag.avatar ?? ""))}</span>
  <span class="who"><span class="name">${name}${ag.api === true ? ` <span class="tag" title="made with one of your API keys">API</span>` : ""}</span><span class="desc${desc ? "" : " faint"}">${desc || "no description"}</span></span>
</a>`;
  }).join("");
}

/**
 * A person's Agents API keys (/ui/api-keys). `issued` is the key just made: it is on the page in that one
 * response and never again, since only its hash is kept. The list names keys by label and the start of the
 * hash, never by value. Revoking asks first: a program using the key stops at once and it cannot be undone.
 */
export function apiKeysPanel(d: {
  keys: Array<{ hash: string; label: string; createdAt: number; revokedAt: number | null }>;
  issued: { key: string; label: string } | null;
  error: string | null;
  baseUrl: string;
  max: number;
}): string {
  const live = d.keys.filter((k) => k.revokedAt === null).length;
  const issued = d.issued ? `<div class="issued" role="status">
  <div><b>${esc(d.issued.label)}</b>: copy this key now. This is the only time it is shown.</div>
  <pre class="key">${esc(d.issued.key)}</pre>
  <div class="hint">In the OpenAI SDK, set the base URL to <code>${esc(d.baseUrl)}</code> and the API key to the value above.</div>
</div>` : "";
  const row = (k: (typeof d.keys)[number]) => `<tr>
  <td>${esc(k.label)}</td><td><code>${esc(k.hash.slice(0, 8))}</code></td><td>${when(k.createdAt) ?? ""}</td>
  <td>${k.revokedAt === null ? "live" : `revoked ${when(k.revokedAt) ?? ""}`}</td>
  <td>${k.revokedAt === null ? `<form hx-post="/ui/api-keys/revoke" hx-target="#api-keys" hx-swap="innerHTML"
        hx-confirm="Revoke ${esc(k.label)}? Programs using this key stop working at once, and this cannot be undone.">
    <input type="hidden" name="hash" value="${esc(k.hash)}"><button type="submit" class="ghost">revoke</button></form>` : ""}</td>
</tr>`;
  return `${issued}${d.error ? `<div class="err">${esc(d.error)}</div>` : ""}
<form class="new-key" hx-post="/ui/api-keys/new" hx-target="#api-keys" hx-swap="innerHTML">
  <label><span>name</span><input type="text" name="label" maxlength="60" required autocomplete="off" spellcheck="false" placeholder="what this key is for"></label>
  <button type="submit"${live >= d.max ? ` disabled title="${d.max} live keys is the most; revoke one first"` : ""}>create key</button>
</form>
<div class="hint">${live} of ${d.max} live keys. Agents made with your keys are listed under agents, marked API.</div>
${d.keys.length
    ? `<table class="keys"><thead><tr><th>name</th><th>id</th><th>created</th><th>status</th><th></th></tr></thead><tbody>${d.keys.map(row).join("")}</tbody></table>`
    : `<div class="empty">no keys yet</div>`}`;
}

/** The element a credential route swaps: one mount, re-rendered. */
export const mountBlockId = (alias: string) => `mount-${String(alias).replace(/[^A-Za-z0-9_-]/g, "_")}`;

/** A time from the store, or nothing. Never "Invalid Date", never "undefined". */
const when = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  const t = typeof v === "number" ? new Date(v) : new Date(String(v));
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 16).replace("T", " ") + "Z";
};

/**
 * The credential region of one mount.
 *
 * Reads the plugin's declaration through `credentialForm` and nothing else, so
 * a sign-in shape (which has no fields) is a disabled button rather than a
 * TypeError, and every field's `secret` and `required` arrive as booleans. The
 * value itself is never here: inputs are never prefilled, the read block
 * carries only whether one is attached, who it acts as, and when. Each of
 * those renders only when the store actually produced it. The store also
 * keeps the value's last four characters; the page does not read them. An
 * account name is a label the provider chose, while a suffix is a fragment of
 * the secret, and nothing that is part of a key belongs on screen.
 *
 * Attached comes in two strengths — verified, when the plugin's check made a
 * call and returned who the key acts as, and unverified, when it was stored
 * and not judged — and the page keeps them apart. Unverified says why when
 * the store knows: a key kept during an outage reads "kept, could not be
 * checked", not "not yet tried", so the person knows the key is not the
 * suspect. A reference the operator
 * configured at deploy time is a third case: attached, but not by this page
 * and not changeable from it.
 */
function credentialRegion(m: any, spec: CredentialSpec | null | undefined): string {
  const form = credentialForm(spec);
  if (form.kind === "none") return "";
  const target = `hx-target="#${mountBlockId(m.alias)}" hx-swap="outerHTML"`;
  const c = m.credential ?? {};
  const attached = typeof c.attached === "boolean" ? c.attached : !!m.connected;
  const error = typeof c.error === "string" && c.error ? c.error : null;
  const optional = form.accountRequired === false;

  if (form.kind === "signIn") {
    return `<div class="cred">
      <div class="row"><button type="button" disabled>Connect with ${esc(form.signIn.provider)}</button>
        <span class="hint" style="padding:0">sign-in is not built yet${optional ? " · optional" : ""}</span></div>
      ${form.signIn.grants ? `<div class="hint" style="padding:4px 0 0">connecting grants ${esc(form.signIn.grants)}</div>` : ""}
    </div>`;
  }

  const inputs = form.fields.map((f) => `
      <label><span>${esc(f.summary)}${f.required ? "" : " <i>(optional)</i>"}</span>
        <input type="${f.secret ? "password" : "text"}" name="${esc(f.name)}"${f.required ? " required" : ""}
               autocomplete="off" spellcheck="false"></label>`).join("");
  const paste = (verb: string) => `
    <form hx-post="/ui/credential" ${target}>
      <input type="hidden" name="alias" value="${esc(m.alias)}">${inputs}
      ${error ? `<div class="err">${esc(error)}</div>` : ""}
      <div class="row"><button type="submit">${verb}</button></div>
    </form>`;

  if (!attached) {
    return `<div class="cred">
      ${optional ? `<div class="hint" style="padding:0">optional: without an account this mount works public-only</div>` : ""}
      ${paste("attach")}
    </div>`;
  }

  // Three states, not two. `verified` is a fact the store recorded: the plugin's
  // `checkCredential` made a real call and it succeeded. Without it the value
  // was stored and never tried — for a plugin without a check that is the only
  // state there is, and a typo'd key looks exactly like a good one until the
  // agent's first call fails. The page says which of the two it is rather than
  // letting one word carry both, and the account name, when the check returned
  // one, is shown rather than being what the state is inferred from.
  const account = typeof c.account === "string" && c.account ? c.account : null;
  const verified = c.verified === true;
  const setAt = when(c.setAt), usedAt = when(c.lastUsedAt);
  const times = [setAt ? `set ${setAt}` : "", usedAt ? `last used ${usedAt}` : ""].filter(Boolean).join(" · ");

  // A reference the operator configured at deploy time is attached, but it is
  // not in this agent's store: nothing here set it, and nothing here can
  // replace or remove it. Say it is included by the deployment and offer no
  // controls. A paste rejected on top of it still reports its reason, or the
  // person who pasted wrong keys over the operator's is shown no change at all.
  if (c.operator === true) {
    // "Included": an operator-attached credential means the deployment covers
    // this mount — there is nothing to configure, and nothing acting "as" an
    // account. "Limited Free" names the deployment's plan; it lives here and
    // nowhere else, because it is presentation, not a field.
    return `<div class="cred">
      <div class="state"><b>included</b><span class="tag">Limited Free</span><span class="when">configured at deploy time${times ? ` · ${times}` : ""}</span></div>
      ${error ? `<div class="err">${esc(error)}</div>` : ""}
    </div>`;
  }

  const state = verified
    ? `<b>attached · verified</b>${account ? `<span>acting as <code>${esc(account)}</code></span>` : ""}`
    : `<b class="unverified">attached · unverified</b>${account ? `<span>as <code>${esc(account)}</code></span>` : ""}<span class="when">${error ? esc(error) : "stored, not yet tried"}</span>`;
  return `<div class="cred">
      <div class="state">${state}${times ? `<span class="when">${times}</span>` : ""}
        <form class="inline" hx-post="/ui/credential/remove" ${target}
              hx-confirm="Remove the credential from ${esc(m.alias)}? The agent keeps the mount but loses the account.">
          <input type="hidden" name="alias" value="${esc(m.alias)}">
          <button type="submit" class="ghost">remove</button>
        </form></div>
      <details><summary>replace</summary>${paste("replace")}</details>
    </div>`;
}

/** One mount, rendered on its own: what the credential routes return. */
export function mountFragment(d: any, alias: string): string {
  const m = (d.mounts ?? []).find((x: any) => x.alias === alias);
  if (!m) return `<div class="mount" id="${mountBlockId(alias)}"><div class="empty">no mount named ${esc(alias)}</div></div>`;
  return mountBlock(d, m);
}

function mountBlock(d: any, m: any): string {
  const used: Record<string, number> = d.used ?? {};
  const installed: any[] = d.installed ?? [];
  const spec = installed.find((p) => p.id === m.plugin)?.credential ?? null;

  const account = () => {
    if (m.enabled === false) return `<span class="tag bad">closed</span>`;
    if (m.problems?.length) return `<span class="tag bad">misconfigured</span>`;
    const attached = typeof m.credential?.attached === "boolean" ? m.credential.attached : m.connected;
    if (attached) return `<span class="tag ok">account attached</span>`;
    if (m.needsAccount) return `<span class="tag bad">needs an account</span>`;
    if (m.optionalAccount) return `<span class="tag">public only</span>`;
    return `<span class="tag">no account needed</span>`;
  };

  const settings = () => {
    const rows = Object.entries(m.config ?? {}).filter(([k]) => k !== "account");
    if (!rows.length) return `<div class="hint">default settings</div>`;
    return `<div class="kv">${rows.map(([k, v]) =>
      `<div>${esc(k)}</div><div><code>${esc(
        typeof v === "string" ? v : JSON.stringify(v))}</code></div>`).join("")}</div>`;
  };

  return `
    <div class="mount" id="${mountBlockId(m.alias)}">
      <div class="mount-head">
        <b>${esc(m.alias)}</b>
        <span class="sub">${esc(m.plugin)} ${esc(m.version ?? "")}</span>
        ${account()}
        ${m.policy ? `<span class="tag">policy</span>` : ""}
      </div>
      ${(m.problems ?? []).length
        ? `<div class="problems">${(m.problems as string[]).map((p) =>
            `<div>${esc(p)}</div>`).join("")}</div>`
        : ""}
      ${m.reconcileRefused && typeof m.reconcileRefused.reason === "string"
        ? `<div class="problems warn">seed change not applied: ${esc(m.reconcileRefused.reason)}${when(m.reconcileRefused.at) ? ` <span class="when">${esc(when(m.reconcileRefused.at)!)}</span>` : ""}</div>`
        : ""}
      ${settings()}
      ${credentialRegion(m, spec)}
      <div class="hint" style="padding-top:6px">${
        m.tools.length
          ? m.tools.map((t: string) => {
              // The usage map is keyed by the name the transcript recorded,
              // which is the model-visible one, the same name this list
              // carries. Transcripts from before #118 recorded "alias.tool".
              // Never fall back to the bare name: two mounts of one plugin
              // share it, and one would wear the other's count.
              const n = used[t] ?? used[`${m.alias}.${bareTool(t, String(m.alias ?? ""))}`] ?? 0;
              return `<code class="${n ? "hot" : ""}">${esc(t)}${n ? ` ×${n}` : ""}</code>`;
            }).join(" ")
          : "no tools"
      }</div>
    </div>`;
}

/** A mount's tool name without its alias prefix, whether joined by "." or "__". */
export function bareTool(name: string, alias: string): string {
  for (const sep of ["__", "."]) if (alias && name.startsWith(alias + sep)) return name.slice(alias.length + sep.length);
  return name;
}

/** The sidebar's list of mounts: alias, plugin, and whether an account is attached. */
export function mountList(d: any): string {
  const mounts: any[] = d.mounts ?? [];
  if (!mounts.length) return `<div class="empty">nothing mounted</div>`;
  const state = (m: any) => {
    if (m.enabled === false) return `<span class="tag bad">closed</span>`;
    if (m.problems?.length) return `<span class="tag bad">misconfigured</span>`;
    const c = m.credential ?? {};
    const attached = typeof c.attached === "boolean" ? c.attached : m.connected;
    if (attached && c.operator === true) return `<span class="tag ok">operator</span>`;
    if (attached && c.verified === true) return `<span class="tag ok">verified</span>`;
    if (attached) return `<span class="tag warn">unverified</span>`;
    if (m.needsAccount) return `<span class="tag bad">needs an account</span>`;
    if (m.optionalAccount) return `<span class="tag">public only</span>`;
    return `<span class="tag">no account</span>`;
  };
  return mounts.map((m) => `<a class="mount-link" data-alias="${esc(m.alias)}" href="/ui?view=plugins&alias=${encodeURIComponent(m.alias)}" onclick="ap.mount('${esc(m.alias)}');return false">
  <div class="id"><b>${esc(m.alias)}</b> <span class="sub">${esc(m.plugin)}</span></div>
  <div class="meta">${state(m)}</div>
</a>`).join("");
}

/** What is installed on this deployment: the catalogue, mounting being a separate act. */
export function catalogue(d: any): string {
  const installed: any[] = d.installed ?? [];
  const toolRow = (t: any) => [t.name, t.sideEffects, t.idempotency, t.summary];
  // The switch belongs to the plugin, so it lives in the catalogue; the mount
  // rows only read the result back as a "closed" chip. `inherit` has to say
  // what it currently resolves to, or it is indistinguishable from "off".
  const switchChip = (p: any) =>
    (p.choice ?? "inherit") === "inherit"
      ? `<span class="tag ${p.enabled ? "ok" : ""}">${p.enabled ? "on" : "off"} by inheritance — the plugin is ${
          p.defaultForAllAgents ? "default for all agents" : "opt-in"}</span>`
      : p.enabled
        ? `<span class="tag ok">on — this agent answered "enable"</span>`
        : `<span class="tag bad">off — this agent answered "disable"</span>`;
  const pluginBlock = (p: any) => `
    <details class="plug">
      <summary><b>${esc(p.id)}</b> <span class="sub">${esc(p.version)} · ${p.tools.length} tools</span>
        ${p.credential
          ? `<span class="tag ${p.credential.required ? "bad" : ""}">${
              p.credential.required ? "account required" : "account optional"}</span>`
          : ""}</summary>
      // The catalogue is shown twice: in the rail's plugins view and in the
      // inspector's plugins tab. The select must repaint whichever panel is
      // showing it, not a fixed id that is half-hidden in the other view.
      <form class="plug-choice">
        <input type="hidden" name="plugin" value="${esc(p.id)}">
        <select name="choice" hx-post="/ui/plugin/choice" hx-target="closest .plugins-root" hx-swap="innerHTML" hx-trigger="change">
          ${["inherit", "enable", "disable"].map((c) =>
            `<option value="${c}"${(p.choice ?? "inherit") === c ? " selected" : ""}>${c}</option>`).join("")}
        </select>
        ${switchChip(p)}
      </form>
      ${p.credential ? `<div class="hint">${esc(p.credential.summary)}${
        p.credential.grants ? ` — an account adds ${esc(p.credential.grants)}` : ""}</div>` : ""}
      ${p.config.length ? `<h4>settings</h4>${table(
        ["name", "type", "default", "what it does"],
        p.config.map((c: any) => [c.name, c.type,
          c.default === undefined ? "—" : String(c.default), c.summary]))}` : ""}
      <h4>tools</h4>
      ${table(["tool", "effect", "replay", "what it does"], p.tools.map(toolRow))}
    </details>`;
  return `<div class="hint">Present in the code. Mounting one is a separate, deliberate act.</div>
${installed.length ? installed.map(pluginBlock).join("") : `<div class="empty">nothing installed</div>`}`;
}

export function plugins(d: any): string {
  const mounts: any[] = d.mounts ?? [];
  return `
<h3>this agent's mounts</h3>
<div class="hint">A mount is an authority, not a plugin. The same plugin mounted twice
  against two accounts is two mounts, with two credentials and two session states.
  No credential is shown here — only whether one is attached.</div>
${mounts.length ? mounts.map((m) => mountBlock(d, m)).join("") : `<div class="empty">nothing mounted</div>`}

<h3 style="margin-top:18px">installed on this deployment</h3>
${catalogue(d)}`;
}
