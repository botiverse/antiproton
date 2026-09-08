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

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

const CSS = `
:root{--bg:#0f1115;--panel:#161a21;--line:#252b36;--ink:#d8dee9;--dim:#8b95a6;
--accent:#7aa2f7;--warn:#e0af68;--ok:#9ece6a;--bad:#f7768e;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}
header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;
gap:14px;align-items:baseline;flex-wrap:wrap}
h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.01em}
header .sub{color:var(--dim);font-size:12px}
main{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(320px,1fr);
gap:16px;padding:16px 20px;align-items:start}
@media(max-width:900px){main{grid-template-columns:1fr}}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
h2{font-size:12px;margin:0;padding:9px 13px;border-bottom:1px solid var(--line);
color:var(--dim);text-transform:uppercase;letter-spacing:.09em;font-weight:600}
.body{padding:13px;max-height:62vh;overflow:auto}
.ev{padding:7px 0;border-bottom:1px solid var(--line)}
.ev:last-child{border-bottom:0}
.k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.msg{white-space:pre-wrap;word-break:break-word;margin-top:3px}
form{display:flex;gap:8px;padding:13px;border-top:1px solid var(--line)}
input[type=text]{flex:1;background:#0c0e12;border:1px solid var(--line);
color:var(--ink);padding:9px 11px;border-radius:6px;font:inherit}
button{background:var(--accent);border:0;color:#0c0e12;padding:9px 15px;
border-radius:6px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
button.bad{background:var(--bad)}
.card{border:1px solid var(--warn);border-radius:7px;padding:11px;margin-bottom:11px}
.card .tool{color:var(--warn);font-weight:600}
pre{background:#0c0e12;border:1px solid var(--line);border-radius:6px;
padding:9px;overflow:auto;margin:8px 0;font-size:12px}
.row{display:flex;gap:8px;margin-top:9px}
.empty{color:var(--dim);padding:6px 0}
.tag{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;
border:1px solid var(--line);color:var(--dim)}
.tag.ok{color:var(--ok);border-color:var(--ok)}
.tag.bad{color:var(--bad);border-color:var(--bad)}
.hint{color:var(--dim);font-size:12px;padding:0 13px 13px}
`;

export function page(taskId: string, who: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agent-harness</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/htmx/1.9.12/htmx.min.js"></script>
<style>${CSS}</style></head><body>
<header>
  <h1>agent-harness</h1>
  <span class="sub">durable · multi-tenant · the agent never holds a credential</span>
  <span class="sub" style="margin-left:auto">${esc(who)}</span>
</header>
<main>
  <section>
    <h2>conversation</h2>
    <div class="body" id="transcript"
         hx-get="/ui/transcript?taskId=${esc(taskId)}"
         hx-trigger="load, every 2s" hx-swap="innerHTML">loading…</div>
    <form hx-post="/ui/message" hx-target="#transcript" hx-swap="innerHTML"
          hx-on::after-request="this.reset()">
      <input type="hidden" name="taskId" value="${esc(taskId)}">
      <input type="text" name="text" placeholder="ask it to deploy something to production…"
             autocomplete="off" required>
      <button type="submit">send</button>
    </form>
    <div class="hint">Try: <em>deploy version 1.5.0 to web-01</em> — reads run freely,
      writes stop at the gate below.</div>
  </section>
  <section>
    <h2>awaiting approval</h2>
    <div class="body" id="approvals"
         hx-get="/ui/approvals?taskId=${esc(taskId)}"
         hx-trigger="load, every 2s" hx-swap="innerHTML">loading…</div>
  </section>
</main></body></html>`;
}

export function transcript(events: Array<{ sequence: number; kind: string; payload: any }>): string {
  const shown = events.filter((e) =>
    ["message", "model.response", "tool.result", "js.result", "operation.completed", "model.failed"].includes(e.kind));
  if (!shown.length) return `<div class="empty">nothing yet — say something below.</div>`;
  return shown.map((e) => {
    const p = e.payload ?? {};
    let text = "";
    if (e.kind === "message") text = p.text ?? "";
    else if (e.kind === "model.response") text = p.text || (p.toolCalls ? `→ ${p.toolCalls.map((c: any) => c.name).join(", ")}` : "");
    else if (e.kind === "tool.result") text = `${p.tool ?? ""} ${String(p.content ?? "").slice(0, 400)}`;
    else if (e.kind === "js.result") text = `${p.status} ${JSON.stringify(p.outputs ?? []).slice(0, 400)}`;
    else if (e.kind === "operation.completed") text = `${p.operationId} ${p.status}`;
    else if (e.kind === "model.failed") text = String(p.error ?? "");
    const who = e.kind === "message" ? "you" : e.kind === "model.response" ? "agent" : e.kind;
    return `<div class="ev"><div class="k">${esc(who)}</div><div class="msg">${esc(text)}</div></div>`;
  }).join("");
}

export function approvals(rows: ApprovalRecord[]): string {
  const pending = rows.filter((r) => r.state === "pending");
  const decided = rows.filter((r) => r.state !== "pending").slice(-4);
  const head = pending.length
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
  const tail = decided.length
    ? `<div class="k" style="margin-top:12px">decided</div>` +
      decided.map((a) => `<div class="ev"><div class="msg">
        <span class="tag ${a.state === "approved" ? "ok" : "bad"}">${esc(a.state)}</span>
        ${esc(a.mountAlias)}.${esc(a.tool)} — ${esc(a.approver ?? "")}</div></div>`).join("")
    : "";
  return head + tail;
}
