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
import { FAVICON_DATA_URI, LOCKUP_SVG, MARK_OUTLINED_SVG } from "./brand.ts";
import { RUI_TOKENS } from "./rui-tokens.ts";
import { ICONS } from "./icons.ts";
import { md } from "./md.ts";

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const CSS = `

.mount{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:8px 0;background:var(--layer-card)}
.mount-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.problems{border-left:2px solid var(--bad);padding:4px 0 4px 8px;margin:6px 0;font-size:12px;color:var(--bad)}
.plug{border:1px solid var(--line);border-radius:8px;padding:8px 14px;margin:6px 0;background:var(--layer-card)}
.plug summary{cursor:pointer;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
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
   their surfaces. Which columns exist depends on the section: the inbox is
   one wide column, a conversation has all four. */
body.shell{display:grid;grid-template-columns:56px 264px minmax(0,1fr) 420px;grid-template-areas:"rail side main insp";
height:100vh;overflow:hidden}
body.shell[data-view=inbox],body.shell[data-view=runtime]{grid-template-columns:56px 0 minmax(0,1fr) 0}
body.shell[data-view=plugins]{grid-template-columns:56px 264px minmax(0,1fr) 0}
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
font-size:11px;display:flex;align-items:center;justify-content:center;text-transform:uppercase}
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
.new-conv{width:100%;justify-content:center;margin:0 0 10px;gap:6px}
.new-conv svg{width:14px;height:14px}
.new-conv-err{font-size:11px;color:var(--bad);margin:-4px 0 10px}
.new-conv-err[hidden]{display:none}
.sidebar h3.later{margin-top:16px}
/* --- agents: an avatar drawn from the agent's seed, a name, one line of
   what it is for. The create form sits in the sidebar, no dialog. */
.avatar{display:inline-block;width:22px;height:22px;flex:none;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:var(--sunk);vertical-align:middle}
.avatar svg{width:100%;height:100%;display:block}
.avatar.lg{width:28px;height:28px}
.avatar[hidden]{display:none}
/* Scoped to the sidebar list: the transcript's model turns are `.step.agent`
   too, and an unscoped `.agent{display:flex}` laid every turn out as a row. */
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
.new-agent-form .err[hidden]{display:none}
.new-agent-form .hint{padding:0;font-size:10.5px}
textarea{background:var(--layer-panel);border:1px solid var(--line-field);border-radius:6px;color:var(--ink);font:inherit;font-size:12px;padding:6px 8px;resize:vertical;min-height:56px;width:100%}
textarea:hover{border-color:var(--line-field-hover)}
textarea:focus{outline:0;box-shadow:0 0 0 1px var(--primary-400)}
.view-head #agent-avatar{margin-right:2px}
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
.banner{display:flex;align-items:center;gap:10px;padding:9px 12px;border:1px solid var(--accent);border-radius:8px;
background:var(--sunk);color:var(--accent);font-size:12px}
.banner[hidden]{display:none}
.banner .dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.banner .text{flex:1}
.banner a{color:var(--accent);font-weight:600}
.inbox-card .inbox-head{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap;margin-bottom:6px}
.inbox-card .meta{color:var(--dim);font-size:11px}
.inbox-card .row{align-items:center}
.inbox-card .open{margin-left:auto;color:var(--dim);font-size:12px}
.conv{background:var(--panel);border:1px solid var(--line);border-radius:8px;display:flex;flex-direction:column;
flex:1;min-height:0}
.conv .body{flex:1;min-height:0;max-height:none;overflow:auto}
.held{border-top:1px solid var(--line);padding:0 13px}
.held:empty{display:none}
.held .card{margin:10px 0}
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
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12px}
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
[data-theme="brutal"] .badge,[data-theme="brutal"] .tag,[data-theme="brutal"] .inbox-card{border-radius:0}
[data-theme="brutal"] button{border:2px solid var(--line-strong);box-shadow:var(--theme-shadow-sm)}
[data-theme="brutal"] button:hover{box-shadow:var(--theme-shadow-md)}
[data-theme="brutal"] button.ghost{border-color:var(--line-strong);box-shadow:none}
[data-theme="brutal"] button:disabled{box-shadow:none}
[data-theme="brutal"] input[type=text],[data-theme="brutal"] input[type=password]{border:2px solid var(--line-strong);background:var(--layer-panel);box-shadow:var(--theme-shadow-sm)}
[data-theme="brutal"] input[type=text]:focus,[data-theme="brutal"] input[type=password]:focus{box-shadow:var(--theme-shadow-md)}
[data-theme="brutal"] .card,[data-theme="brutal"] .mount,[data-theme="brutal"] .plug,[data-theme="brutal"] .conv,[data-theme="brutal"] .view>.body,[data-theme="brutal"] .banner{border:2px solid var(--line-strong);box-shadow:var(--theme-shadow-md)}
[data-theme="brutal"] .card{border-left-width:2px}
[data-theme="brutal"] .task,[data-theme="brutal"] .mount-link{border:2px solid var(--line-strong)}
[data-theme="brutal"] .task.on,[data-theme="brutal"] .mount-link.on{background:var(--primary-soft)}
[data-theme="brutal"] .rail-item.on{border:2px solid var(--line-strong);background:var(--primary-400);color:var(--primary-950);box-shadow:var(--theme-shadow-sm)}
[data-theme="brutal"] .rail,[data-theme="brutal"] .sidebar,[data-theme="brutal"] .inspector{border-color:var(--line-strong)}
[data-theme="brutal"] .badge,[data-theme="brutal"] .tag{border:1px solid var(--line-strong)}
[data-theme="brutal"] .mode{border:2px solid var(--line-strong)}
[data-theme="brutal"] .mode button{border:0;box-shadow:none}
[data-theme="brutal"] .mode button.on{background:var(--primary-400);color:var(--primary-950)}
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
  .rail-item{width:auto;min-width:60px;padding:6px 4px 5px;font-size:10px}
  .sidebar,.inspector{grid-area:main;display:none;border:0}
  body[data-pane=side] .sidebar,body[data-pane=insp] .inspector{display:block}
  body[data-pane=side] main.main,body[data-pane=insp] main.main{display:none}
  main.main{padding:12px}
  .pane-btn{display:inline-flex}
  button,.inbox-card .row button{min-height:40px;padding:9px 14px;font-size:13px}
  input[type=text],input[type=password]{min-height:40px;font-size:15px}
  .inbox-card .row{flex-wrap:wrap;gap:8px}
  .inbox-card .open{margin-left:0;width:100%;padding-top:4px}
  .view-head h2{font-size:14px}
  .conv .body{max-height:none}
  .banner{font-size:12px;padding:8px 10px}
}
@media(max-width:760px){.sidebar .pane-close,.inspector .pane-close{display:inline-flex;margin:10px 12px 0}}
`;

/**
 * The console, as a product rather than a debugging page.
 *
 * Four sections on a rail. The inbox is home: every call the gateway is
 * holding for this viewer, the request verbatim, and the two buttons that
 * settle it — that flow is what antiproton is, so it is the first thing seen.
 * A conversation shows the transcript with any held call above the composer;
 * beside it the inspector opens what is hard to see from outside — the
 * trajectory, the raw events, what the object is holding, where the time
 * went — one section at a time. Plugins and runtime are their own sections.
 * Every panel is still a plain GET that renders the store directly; the
 * shell keeps only which section is showing and which mode the viewer chose.
 */
export function page(taskId: string, who: string, agentId: string): string {
  const t = esc(taskId);
  const initial = (who || "?").trim().slice(0, 1);
  // A lazily loaded, polled fragment: loads when its view or section is shown,
  // then re-reads the store every few seconds while it stays shown. The
  // condition is evaluated by htmx against the element, so a hidden view
  // costs nothing.
  const lazy = (id: string, path: string, every: string, cond: string) =>
    `<div class="body" id="${id}" data-lazy hx-get="${path}" hx-swap="innerHTML"
          hx-trigger="ap:show, every ${every}[${cond}]">loading…</div>`;
  const inView = "this.closest('.view').classList.contains('on')";
  const inspTab = (name: string) => `<button type="button" role="tab" data-insp="${name}" onclick="ap.insp('${name}')">${name}</button>`;
  const a = encodeURIComponent(agentId);
  const rail = (view: string, label: string) =>
    `<a class="rail-item" data-view="${view}" href="/ui?view=${view}&agentId=${a}&taskId=${t}" onclick="ap.show('${view}');return false"><span class="ico">${ICONS[view]}</span><span>${label}</span></a>`;
  return `<!doctype html><html lang="en" data-theme="brutal"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>antiproton</title>
<link rel="icon" type="image/svg+xml" href="${FAVICON_DATA_URI}">
<script>(function(){var t='brutal';try{t=localStorage.getItem('ap-theme')||'brutal'}catch(e){}var h=document.documentElement;if(t==='elegant'){h.setAttribute('data-theme','elegant');h.classList.add('light')}else if(t==='elegant-dark'){h.setAttribute('data-theme','elegant');h.classList.add('dark')}else{h.setAttribute('data-theme','brutal')}})()</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/htmx/1.9.12/htmx.min.js"></script>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&display=swap">
<style>${RUI_TOKENS}${CSS}</style></head><body class="shell" data-view="inbox" data-task="${t}" data-agent="${esc(agentId)}">
<nav class="rail" aria-label="sections">
  <a class="rail-brand" href="/ui" title="antiproton">${MARK_OUTLINED_SVG}</a>
  ${rail("inbox", "inbox").replace('</span><span>inbox', '</span><b class="count" id="inbox-count" hidden></b><span>inbox')}
  ${rail("agents", "agents")}
  ${rail("plugins", "plugins")}
  ${rail("runtime", "runtime")}
  <a class="rail-item" href="https://report.botiverse.dev/" target="_blank" rel="noopener"><span class="ico">${ICONS.report}</span><span>report</span></a>
  <div class="rail-foot">
    <div class="mode" role="group" aria-label="theme">
      <button type="button" data-theme-choice="brutal" onclick="ap.theme('brutal')" aria-label="Brutal" title="Brutal">${ICONS.brutal}</button>
      <button type="button" data-theme-choice="elegant" onclick="ap.theme('elegant')" aria-label="Elegant" title="Elegant">${ICONS.light}</button>
      <button type="button" data-theme-choice="elegant-dark" onclick="ap.theme('elegant-dark')" aria-label="Elegant dark" title="Elegant dark">${ICONS.dark}</button>
    </div>
    <span class="viewer" title="${esc(who)}">${esc(initial)}</span>
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
    <div id="agents" data-lazy hx-get="/ui/agents" hx-swap="innerHTML" hx-trigger="ap:show, every 5s[document.body.dataset.view==='agents']"
         hx-on::after-swap="ap.markAgent()"></div>
    <h3 class="later">conversations</h3>
    <div class="sub">of this agent, latest activity first</div>
    <button type="button" class="ghost new-conv" onclick="ap.newConversation(this)">${ICONS.plus}new conversation</button>
    <div class="err new-conv-err" id="new-conv-err" hidden></div>
    <div id="tasks" data-lazy hx-get="/ui/tasks" hx-swap="innerHTML" hx-trigger="ap:show, every 5s[document.body.dataset.view==='agents']"
         hx-on::after-swap="ap.markTask()"><a class="task on" data-task="${t}"><div class="id">${t}</div><div class="meta">this conversation</div></a></div>
  </div>
  <div class="side-view" data-for="plugins">
    <h3>mounts</h3>
    <div class="sub">this agent's authorities</div>
    <div id="mounts" data-lazy hx-get="/ui/plugins?part=mounts" hx-swap="innerHTML"
         hx-trigger="ap:show, every 5s[document.body.dataset.view==='plugins']" hx-on::after-swap="ap.markMount()"></div>
    <a class="side-link" href="/ui?view=plugins&alias=" onclick="ap.mount('');return false">installed on this deployment →</a>
  </div>
</aside>
<main class="main" id="main">
  <section class="view" data-view="inbox">
    <div class="view-head"><h2>Inbox</h2><span class="sub">calls held by the gateway, waiting for your signature</span></div>
    ${lazy("inbox", "/ui/inbox", "3s", inView)}
  </section>
  <section class="view" data-view="agents">
    <div class="view-head"><span class="avatar lg" id="agent-avatar" hidden></span><h2 id="agent-name">${esc(agentId)}</h2>
      <span class="sub" id="conv-title">${t}</span><span class="sub faint" id="conv-id"></span><span class="spacer"></span>
      <button type="button" class="pane-btn" onclick="ap.pane('side')">${ICONS.tasks}tasks</button>
      <button type="button" class="pane-btn" onclick="ap.pane('insp')">${ICONS.inspector}inspector</button>
      <form hx-post="/ui/compact" hx-target="#transcript" hx-swap="innerHTML" style="padding:0;border:0">
        <input type="hidden" name="taskId" value="${t}">
        <button type="submit" class="ghost" title="Summarise the older part of this conversation now, keeping the recent part">compact</button>
      </form></div>
    <div class="banner" id="banner" hidden><span class="dot"></span><span class="text"></span>
      <a href="/ui?view=inbox" onclick="ap.show('inbox');return false">review</a></div>
    <div class="conv">
      <div class="body" id="transcript" data-lazy
           hx-get="/ui/chat?taskId=${t}" hx-swap="innerHTML"
           hx-trigger="ap:show, every 2s[${inView}]"
           hx-on::after-swap="if(this.dataset.pin!=='0')this.scrollTop=this.scrollHeight"
           onscroll="this.dataset.pin=(this.scrollHeight-this.scrollTop-this.clientHeight<40)?'1':'0'"
           >loading…</div>
      <div class="held" id="approvals" data-lazy hx-get="/ui/approvals?taskId=${t}" hx-swap="innerHTML"
           hx-trigger="ap:show, every 2s[${inView}]"></div>
      <form hx-post="/ui/message" hx-target="#transcript" hx-swap="innerHTML" hx-on::after-request="this.reset()">
        <input type="hidden" name="taskId" value="${t}">
        <input type="text" name="text" placeholder="ask it something…" autocomplete="off" required>
        <button type="submit" name="mode" value="steer">send</button>
        <button type="submit" name="mode" value="followUp" class="ghost"
                title="Held back until the agent has finished everything it is doing">after</button>
      </form>
    </div>
    <div class="hint" style="padding:0">Sending while it works steers it: the message reaches the model before its next call.
      <b>after</b> holds the message until it has finished. A held call shows above the composer until you sign it.</div>
  </section>
  <section class="view" data-view="plugins">
    <div class="view-head"><h2 id="plugins-title">Plugins</h2><span class="sub">what is mounted, what it may do, and what it acts as</span></div>
    <div class="body" id="plugins" data-lazy hx-get="/ui/plugins" hx-swap="innerHTML"
         hx-trigger="ap:show, every 3s[${inView} && !ap.editing('#plugins')]">loading…</div>
  </section>
  <section class="view" data-view="runtime">
    <div class="view-head"><h2>Runtime</h2><span class="sub">what the object is billed for, and what it is holding</span></div>
    <h3>the object</h3>
    ${lazy("runtime", "/ui/runtime", "3s", inView)}
    <h3>containers</h3>
    ${lazy("sandbox", "/ui/sandbox", "3s", inView)}
    <h3>storage</h3>
    ${lazy("storage", "/ui/storage", "3s", inView)}
  </section>
</main>
<aside class="inspector" id="inspector">
  <button type="button" class="ghost pane-close" onclick="ap.pane('main')">${ICONS.back}back</button>
  <div class="tabs" role="tablist" aria-label="inspector">
    ${inspTab("trajectory")}${inspTab("events")}${inspTab("storage")}${inspTab("memory")}${inspTab("sandbox")}${inspTab("runtime")}
  </div>
  <div class="body" id="insp" role="tabpanel" data-lazy hx-get="/ui/transcript?taskId=${t}" hx-swap="innerHTML"
       hx-trigger="ap:show, every 3s[document.body.dataset.view==='agents']">loading…</div>
  <div class="hint" style="padding:8px 0 0">Every tab re-reads the store while it is showing; nothing is cached client-side.</div>
</aside>
<div hidden id="inbox-poll" hx-get="/ui/inbox" hx-swap="innerHTML" hx-trigger="load, every 5s"
     hx-on::after-swap="ap.count(this)"></div>
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
    count(el) {
      const list = el.querySelector('.inbox-list');
      const n = list ? Number(list.dataset.pending || 0) : el.querySelectorAll('.card').length;
      const b = document.getElementById('inbox-count'); b.textContent = String(n); b.hidden = n === 0;
      const banner = document.getElementById('banner');
      const first = el.querySelector('.inbox-card .tool');
      banner.hidden = n === 0;
      banner.querySelector('.text').textContent = n === 1
        ? '1 call is waiting for you: ' + (first ? first.textContent : '')
        : n + ' calls are waiting for you';
    },
    task(id) {
      const u = new URL(location.href); u.searchParams.set('taskId', id); u.searchParams.set('view', 'agents');
      location.href = u.toString();
    },
    // Switching agents drops the conversation: the server opens the agent's
    // default one. The agent id stays on the URL from here on, and every
    // panel request carries it (see the configRequest hook below).
    agent(id) {
      const u = new URL(location.href); u.searchParams.set('agentId', id); u.searchParams.delete('taskId'); u.searchParams.set('view', 'agents');
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
      panel.setAttribute('hx-get', alias ? '/ui/plugins?part=mount&alias=' + encodeURIComponent(alias) : '/ui/plugins?part=catalogue');
      htmx.process(panel); htmx.trigger(panel, 'ap:show');
      document.getElementById('plugins-title').textContent = alias || 'Installed';
      ap.markMount();
    },
    markMount() {
      const a = new URL(location.href).searchParams.get('alias') || '';
      document.querySelectorAll('#mounts .mount-link').forEach(el => el.classList.toggle('on', el.dataset.alias === a));
    },
    // The inspector's tabs: one panel, re-pointed at the chosen fragment. The
    // choice lives on the URL, so a reload and a deep link land on the same tab.
    insp(name) {
      const paths = { trajectory: '/ui/transcript', events: '/ui/events', storage: '/ui/storage', memory: '/ui/memory', sandbox: '/ui/sandbox', runtime: '/ui/runtime' };
      if (!paths[name]) name = 'trajectory';
      document.querySelectorAll('.inspector [role=tab]').forEach(b => { const on = b.dataset.insp === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      const panel = document.getElementById('insp');
      panel.setAttribute('hx-get', paths[name] + '?taskId=' + encodeURIComponent(document.body.dataset.task));
      htmx.process(panel); htmx.trigger(panel, 'ap:show');
      const u = new URL(location.href); u.searchParams.set('insp', name); history.replaceState(null, '', u);
    },
    pane(name) {
      if (name === 'main') delete document.body.dataset.pane; else document.body.dataset.pane = name;
      if (name === 'insp') htmx.trigger(document.getElementById('insp'), 'ap:show');
      if (name === 'side') document.querySelectorAll('.side-view.on [data-lazy]').forEach(el => htmx.trigger(el, 'ap:show'));
    },
    markTask() {
      const t = document.body.dataset.task;
      document.querySelectorAll('#tasks .task').forEach(a => a.classList.toggle('on', a.dataset.task === t));
      const row = document.querySelector('#tasks .task.on');
      if (row && row.dataset.title && row.dataset.title !== '—') {
        document.getElementById('conv-title').textContent = row.dataset.title;
        document.getElementById('conv-id').textContent = t;
      }
    },
    // Ids are minted by the server; the page never invents one. A refusal
    // (the preview's anonymous viewer, or a gate) is said beside the button.
    async newConversation(btn) {
      const err = document.getElementById('new-conv-err'); err.hidden = true; btn.disabled = true;
      try {
        const r = await fetch('/ui/conversation', { method: 'POST', headers: { 'accept': 'application/json' }, body: new URLSearchParams({ agentId: document.body.dataset.agent }) });
        if (!r.ok) { err.textContent = 'could not start a conversation: ' + r.status + ' ' + (await r.text()).slice(0, 120); err.hidden = false; return; }
        const d = await r.json(); if (d && d.taskId) ap.task(d.taskId); else { err.textContent = 'the server returned no conversation id'; err.hidden = false; }
      } catch (e) { err.textContent = 'could not reach the server'; err.hidden = false; }
      finally { btn.disabled = false; }
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
      panel.setAttribute('hx-get', a ? '/ui/plugins?part=mount&alias=' + encodeURIComponent(a) : '/ui/plugins?part=catalogue');
      document.getElementById('plugins-title').textContent = a || 'Installed';
    }
    ap.show(['inbox', 'agents', 'plugins', 'runtime'].includes(v) ? v : 'inbox');
    ap.insp(url.searchParams.get('insp') || 'trajectory');
  });
  // Poll without re-rendering. Each panel remembers the version it last drew;
  // the server answers 304 when nothing has moved, and htmx leaves the DOM
  // alone. Without this a long conversation re-parses megabytes every few
  // seconds and the page stops responding to scrolling.
  window.__ver = {};
  document.body.addEventListener('htmx:configRequest', (e) => {
    const v = window.__ver[e.detail.path];
    if (v) e.detail.headers['x-ap-version'] = v;
    // Every panel reads or writes the current agent. One place, not forty.
    if (!('agentId' in e.detail.parameters)) e.detail.parameters.agentId = document.body.dataset.agent;
  });
  document.body.addEventListener('htmx:afterRequest', (e) => {
    const v = e.detail.xhr && e.detail.xhr.getResponseHeader('x-ap-version');
    if (v) window.__ver[e.detail.pathInfo.requestPath.split('?')[0]] = v;
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
      const body = s.kind === "js.result" ? p.outputs : p.content;
      const bad = s.kind === "js.result" && p.status !== "completed";
      // A held call surfaces here as a pending result; show it as the gate it is.
      const heldText = typeof body === "string" ? body : JSON.stringify(body ?? "");
      const held = heldText.includes("awaiting_approval");
      out.push(`<div class="step ${held ? "held" : bad ? "fail" : "run"}">
        <div class="lbl">${esc(label)} ${rel}${held ? ` <span class="badge warn">held for approval</span>` : ""}</div>
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
      if (!a) continue; // ordinary completions are already visible as results
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
  <div><span class="tool">${esc(a.mountAlias)}.${esc(a.tool)}</span></div>
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
export function eventList(
  events: Array<{ sequence: number; kind: string; payload: any; createdAt: number }>,
): string {
  if (!events.length) return `<div class="empty">no events</div>`;
  const t0 = events[0]!.createdAt;
  return `<h3>timeline</h3>${timeline(events)}
    <h3>${events.length} events</h3>` + events.slice().reverse().map((e) =>
    `<div class="ev"><div class="k">#${e.sequence} · ${esc(e.kind)}
       <span class="t" title="${esc(clock(e.createdAt))}">+${esc(secs(e.createdAt - t0))}</span></div>
     <details><summary>${esc(pretty(e.payload, 160).replace(/\s+/g, " "))}</summary>
       <pre>${esc(pretty(e.payload, 6000))}</pre></details></div>`).join("");
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
      <span class="chip">state.remember</span>; <span class="chip">memory</span>,
      <span class="chip">todo</span> and <span class="chip">journal</span> are read back
      into the system prompt when the agent's harness opens, once for every conversation,
      since the working set belongs to the agent and not to any one conversation.</div>`;
  }
  const known = new Set(["memory", "todo", "journal"]);
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
  second — see the <b>sandbox</b> tab.</div>`;
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
  const conn = (d.connections ?? []).find((c: any) => c.alias === "node");
  let st: any = null;
  try { st = conn ? JSON.parse(conn.state) : null; } catch { st = null; }
  const sessions: Array<{ boxId: string; startedAt: number; endedAt: number; execs: number; saved: string[] }> =
    st?.sessions ?? [];
  const live = st?.boxId ? { boxId: st.boxId, since: Number(st.createdAt),
    execs: Number(st.execs ?? 0), saved: (st.saved ?? []) as string[] } : null;

  if (!sessions.length && !live) {
    return `<div class="empty">no container has ever been started for this agent</div>
      <div class="hint" style="padding:8px 0">The <span class="chip">node</span> mount is a real
      machine and the most expensive thing the agent can reach — billed for every second it
      exists, not per call. It is meant to stay unused.</div>`;
  }

  const liveMs = live ? Date.now() - live.since : 0;
  const total = sessions.reduce((a, x) => a + (x.endedAt - x.startedAt), 0) + liveMs;
  const widest = Math.max(liveMs, ...sessions.map((x) => x.endedAt - x.startedAt), 1);
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
  const allSaved = [...(live?.saved ?? []), ...sessions.flatMap((x) => x.saved ?? [])];

  return `
<h3>right now</h3>
${live
    ? `<div class="card"><div class="tool">a container is running</div>
       <div class="kv" style="margin-top:6px">
         <div>box</div><div>${esc(live.boxId)}</div>
         <div>alive for</div><div>${esc(secs(liveMs))} <span class="tag bad">still billing</span></div>
         <div>calls so far</div><div>${esc(live.execs)}</div>
         <div>saved so far</div><div>${esc(live.saved.length)}</div>
       </div>
       <div class="hint" style="padding:8px 0 0">It costs the same whether or not anything is
       running inside it. If the agent has finished with the machine and not released it,
       that is the bug to look at.</div></div>`
    : `<div class="empty">nothing is running — this costs nothing until the next box starts</div>`}

<h3>sessions — ${esc(secs(total))} of container time across ${sessions.length + (live ? 1 : 0)}</h3>
<div class="bars">
  ${live ? bar(liveMs, `<span class="tag bad">live</span> ${esc(live.execs)} call(s)`, "var(--bad)") : ""}
  ${sessions.map((x) => bar(x.endedAt - x.startedAt,
      `${x.execs} call(s)${x.saved?.length ? ` · ${x.saved.length} saved` : ""}`,
      "var(--ok)")).join("")}
</div>
${table(["started", "lived", "calls", "saved", "box"], sessions.map((x) =>
    [when(x.startedAt), secs(x.endedAt - x.startedAt), x.execs, (x.saved ?? []).length,
     String(x.boxId).slice(-14)]))}

<h3>what came out — ${allSaved.length} artifact(s)</h3>
${allSaved.length
    ? allSaved.map(artifact).join("") +
      `<div class="hint" style="padding:8px 0">Everything else in those boxes is gone. These
       survived because the agent called <span class="chip">node.save</span>; they are readable
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
 * The inbox: every call the gateway is holding for this viewer, across tasks.
 *
 * This is the product's moment — the agent asked, the gateway held, a person
 * reads the request verbatim and signs — so it is the home section. Oldest
 * first, because the one that has waited longest is the one to look at. The
 * root carries the pending count so the rail badge can read it without a
 * second request. The empty state says what is running, so an empty inbox
 * reads as "nothing needs you" rather than "nothing is happening".
 */
export function inbox(d: any): string {
  const pending: any[] = d?.pending ?? [];
  const tasks = d?.tasks ?? { total: 0, running: 0 };
  const ago = (iso: string) => {
    const t = Date.parse(iso); if (Number.isNaN(t)) return "";
    const m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? "just now" : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  };
  const card = (a: any) => {
    const req = a.args ?? {};
    return `<div class="card inbox-card">
  <div class="inbox-head"><span class="tool">${esc(a.tool)}</span>
    <span class="meta">${esc(a.taskId)}${a.heldBy ? ` · held by ${esc(a.heldBy)}` : ""}${a.requestedAt ? ` · waiting ${esc(ago(a.requestedAt))}` : ""}</span></div>
  <div class="k">the request, verbatim</div>
  <pre>${esc(JSON.stringify(req, null, 2))}</pre>
  <div class="row">
    <button hx-post="/ui/decide" hx-target="#inbox" hx-swap="innerHTML"
      hx-vals='${esc(JSON.stringify({ operationId: a.operationId, decision: "approved" }))}'>approve</button>
    <button class="bad" hx-post="/ui/decide" hx-target="#inbox" hx-swap="innerHTML"
      hx-vals='${esc(JSON.stringify({ operationId: a.operationId, decision: "denied" }))}'>deny</button>
    <a class="open" href="/ui?view=agents&taskId=${encodeURIComponent(a.taskId)}" onclick="ap.task('${esc(a.taskId)}');return false">open the conversation →</a>
  </div>
</div>`;
  };
  const body = pending.length
    ? pending.map(card).join("")
    : `<div class="empty">Nothing is waiting on you. ${tasks.running} of ${tasks.total} task${tasks.total === 1 ? "" : "s"} running.</div>`;
  return `<div class="inbox-list" data-pending="${pending.length}">${body}</div>`;
}

/**
 * The agent's tasks, latest activity first, for the sidebar.
 *
 * `turns` is null from the route because transcript entries carry no task id,
 * so it is not shown rather than shown as zero: a zero would say "this task
 * ran nothing", which is a different and false claim. The current task is
 * marked client-side from the URL, so the route stays a plain store read.
 * The title is the first line of the first user message when the route has
 * one, since a person recognises a conversation by what they asked; when it
 * has none the row shows a dash and the id stays in the meta line, so an id
 * is never dressed up as a title.
 */
export function taskList(d: any): string {
  const tasks: any[] = d?.tasks ?? [];
  const when = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? "" : new Date(t).toISOString().slice(0, 16).replace("T", " ") + "Z"; };
  if (!tasks.length) return `<div class="empty">no tasks yet</div>`;
  const title = (t: any) => typeof t.title === "string" && t.title.trim() ? esc(t.title.trim().slice(0, 80)) : "—";
  return tasks.map((t) => `<a class="task" data-task="${esc(t.taskId)}" data-title="${title(t)}" href="/ui?view=agents&taskId=${encodeURIComponent(t.taskId)}" onclick="ap.task('${esc(t.taskId)}');return false">
  <div class="id"><span class="title">${title(t)}</span>${t.busy ? ` <span class="tag ok">working</span>` : ""}${t.pending ? ` <span class="tag warn">${t.pending} held</span>` : ""}</div>
  <div class="meta"><span class="tid">${esc(t.taskId)}</span>${t.status ? ` · ${esc(t.status)}` : ""}${t.lastActivityAt ? ` · ${esc(when(t.lastActivityAt))}` : ""}${typeof t.turns === "number" ? ` · ${t.turns} turns` : ""}</div>
</a>`).join("");
}

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
  <span class="who"><span class="name">${name}</span><span class="desc${desc ? "" : " faint"}">${desc || "no description"}</span></span>
</a>`;
  }).join("");
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
  // replace or remove it. Say who attached it and offer no controls. A paste
  // rejected on top of it still reports its reason, or the person who pasted
  // wrong keys over the operator's is shown no change at all.
  if (c.operator === true) {
    return `<div class="cred">
      <div class="state"><b>attached by the operator</b>${account ? `<span>acting as <code>${esc(account)}</code></span>` : ""}<span class="when">configured at deploy time${times ? ` · ${times}` : ""}</span></div>
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
      ${settings()}
      ${credentialRegion(m, spec)}
      <div class="hint" style="padding-top:6px">${
        m.tools.length
          ? m.tools.map((t: string) => {
              const bare = t.split(".").slice(1).join(".");
              const n = used[bare] ?? 0;
              return `<code class="${n ? "hot" : ""}">${esc(t)}${n ? ` ×${n}` : ""}</code>`;
            }).join(" ")
          : "no tools"
      }</div>
    </div>`;
}

/** The sidebar's list of mounts: alias, plugin, and whether an account is attached. */
export function mountList(d: any): string {
  const mounts: any[] = d.mounts ?? [];
  if (!mounts.length) return `<div class="empty">nothing mounted</div>`;
  const state = (m: any) => {
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
  const pluginBlock = (p: any) => `
    <details class="plug">
      <summary><b>${esc(p.id)}</b> <span class="sub">${esc(p.version)} · ${p.tools.length} tools</span>
        ${p.credential
          ? `<span class="tag ${p.credential.required ? "bad" : ""}">${
              p.credential.required ? "account required" : "account optional"}</span>`
          : ""}</summary>
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
