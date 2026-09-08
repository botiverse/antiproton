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
.step{border-left:2px solid var(--line);padding:8px 0 8px 12px;margin:0 0 10px}
.step.user{border-color:var(--accent)}
.step.agent{border-color:#9d7cd8}
.step.run{border-color:var(--dim)}
.step.held{border-color:var(--warn)}
.step.decided{border-color:var(--ok)}
.step.fail{border-color:var(--bad)}
.lbl{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.07em;
display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.t{color:#5c6472;text-transform:none;letter-spacing:0}
.badge{border:1px solid var(--line);border-radius:99px;padding:0 7px;font-size:10px;
text-transform:none;letter-spacing:0;color:var(--dim)}
.badge.ok{color:var(--ok);border-color:var(--ok)}
.badge.bad{color:var(--bad);border-color:var(--bad)}
.badge.warn{color:var(--warn);border-color:var(--warn)}
.code{background:#0a0c10;border-left:2px solid #9d7cd8;color:#c0caf5}
.chip{border:1px solid var(--line);border-radius:5px;padding:1px 6px;font-size:11px;
color:var(--ink);text-transform:none;letter-spacing:0}
.calls{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
details summary{cursor:pointer;color:var(--dim);font-size:12px;margin-top:5px}
details[open] summary{color:var(--ink)}

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
    <h2>trajectory</h2>
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

const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

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
): string {
  const steps: Step[] = events
    .filter((e) => ["message", "model.response", "model.failed", "tool.result", "js.result", "operation.completed"].includes(e.kind))
    .map((e) => ({ at: e.createdAt, sequence: e.sequence, kind: e.kind, payload: e.payload ?? {} }));
  if (!steps.length) return `<div class="empty">nothing yet — say something below.</div>`;

  const t0 = steps[0]!.at;
  const out: string[] = [];
  let turn = 0;

  for (const s of steps) {
    const rel = `<span class="t">+${esc(secs(s.at - t0))}</span>`;
    const p = s.payload;

    if (s.kind === "message") {
      out.push(`<div class="step user"><div class="lbl">you ${rel}</div>
        <div class="msg">${esc(p.text ?? "")}</div></div>`);
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
      out.push(`<div class="step agent"><div class="lbl">turn ${turn} ${rel} ${badge}</div>
        ${prose.trim() ? `<div class="msg">${esc(prose.trim())}</div>` : ""}
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
  return out.join("");
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
