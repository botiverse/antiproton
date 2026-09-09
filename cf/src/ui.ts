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
import { md } from "./md.ts";

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
.live .lbl{color:var(--accent)}
.dots::after{content:"";animation:d 1.4s steps(4,end) infinite}
@keyframes d{0%{content:""}25%{content:"."}50%{content:".."}75%{content:"..."}}
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
.md code{background:#0a0c10;border:1px solid var(--line);border-radius:4px;
padding:0 4px;font-size:12px;color:#9ece6a}
.md pre{white-space:pre-wrap;word-break:break-word}
.md pre code{background:0;border:0;padding:0;color:inherit}
.md table{margin:6px 0 9px}
.md th,.md td{padding:3px 10px 3px 0}
.md blockquote{margin:6px 0;padding-left:10px;border-left:2px solid var(--line);color:var(--dim)}
.md hr{border:0;border-top:1px solid var(--line);margin:10px 0}
.md a{color:var(--accent)}
.md strong{color:#fff;font-weight:600}
/* The model's own reasoning: present, and folded away, because it is context
   for a person debugging rather than part of what the agent said. */
.think{margin:0 0 7px}
.think summary{color:#6b7690;font-size:11px;text-transform:uppercase;letter-spacing:.07em}
.think[open] summary{color:var(--dim);margin-bottom:5px}
.think>.md{border-left:2px solid #2a3142;padding-left:10px;color:#8b95a6;font-size:13px}

/* --- debugging console ------------------------------------------------- */
.tabs{display:flex;gap:2px;padding:0 8px;border-bottom:1px solid var(--line);flex-wrap:wrap}
.tabs a{padding:8px 11px;color:var(--dim);text-decoration:none;font-size:12px;
border-bottom:2px solid transparent;cursor:pointer}
.tabs a:hover{color:var(--ink)}
.tabs a.on{color:var(--accent);border-bottom-color:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--dim);font-weight:600;padding:4px 8px 4px 0;
border-bottom:1px solid var(--line);text-transform:uppercase;font-size:10px;letter-spacing:.06em}
td{padding:4px 8px 4px 0;border-bottom:1px solid #1c212a;vertical-align:top;
word-break:break-word}
tr:last-child td{border-bottom:0}
.num{text-align:right;color:var(--dim);font-variant-numeric:tabular-nums}
h3{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.08em;
margin:16px 0 6px;font-weight:600}
h3:first-child{margin-top:0}
/* timeline: one tick per event, placed by time, so a gap looks like a gap */
.tl{position:relative;height:34px;background:#0c0e12;border:1px solid var(--line);
border-radius:6px;margin:4px 0 2px;overflow:hidden}
.tl i{position:absolute;top:4px;width:2px;height:26px;background:var(--dim);border-radius:1px}
.tl i.model{background:#9d7cd8}.tl i.js{background:var(--accent)}
.tl i.msg{background:var(--ok)}.tl i.op{background:#3d4657}
.tl i.bad{background:var(--bad);width:3px}
.axis{display:flex;justify-content:space-between;color:#5c6472;font-size:10px}
/* stacked bars for prompt cache and completion, per model call */
.bars{display:flex;flex-direction:column;gap:3px;margin-top:4px}
.bar{display:flex;align-items:center;gap:6px;font-size:11px}
.bar .n{color:#5c6472;width:22px;text-align:right;flex:none}
.bar .t2{flex:1;display:flex;height:12px;border-radius:3px;overflow:hidden;background:#0c0e12}
.bar .cached{background:#2d4f6b}.bar .fresh{background:var(--accent)}
.bar .out{background:#9d7cd8}
.bar .v{color:var(--dim);flex:none;font-variant-numeric:tabular-nums}
.legend{display:flex;gap:12px;color:var(--dim);font-size:11px;margin-top:6px;flex-wrap:wrap}
.legend b{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:4px}
.kv{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:12px}
.kv div:nth-child(odd){color:var(--dim)}
.doc{background:#0c0e12;border:1px solid var(--line);border-radius:6px;padding:8px;
white-space:pre-wrap;word-break:break-word;font-size:12px;margin:4px 0 10px}
.split{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:1100px){.split{grid-template-columns:1fr}}
`;

/**
 * A debugging console, not a demo page.
 *
 * The chat is one panel among several because talking to the agent is the least
 * interesting thing you can do to it while working on the runtime. What is hard
 * to see from outside — what the object is holding, which commands are still
 * out, what the agent believes, where the time went — gets the other half of
 * the screen, and every panel is a plain GET that renders the store directly.
 */
export function page(taskId: string, who: string, agentId: string): string {
  const t = esc(taskId);
  const tab = (id: string, label: string, path: string) =>
    `<a id="tab-${id}" class="${id === "trajectory" ? "on" : ""}"
        hx-get="${path}?taskId=${t}" hx-target="#panel" hx-swap="innerHTML"
        hx-on::after-request="document.querySelectorAll('.tabs a').forEach(e=>e.classList.remove('on'));this.classList.add('on');window.__panel='${path}'"
      >${label}</a>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>antiproton</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/htmx/1.9.12/htmx.min.js"></script>
<style>${CSS}</style></head><body>
<header>
  <h1>antiproton</h1>
  <span class="sub">${esc(agentId)} · ${t}</span>
  <span class="sub" style="margin-left:auto">${esc(who)}</span>
</header>
<main>
  <section>
    <h2>interaction</h2>
    <div class="body" id="transcript" style="max-height:52vh"
         hx-get="/ui/chat?taskId=${t}"
         hx-trigger="load, every 2s" hx-swap="innerHTML"
         hx-on::after-swap="if(this.dataset.pin!=='0')this.scrollTop=this.scrollHeight"
         onscroll="this.dataset.pin=(this.scrollHeight-this.scrollTop-this.clientHeight<40)?'1':'0'"
         >loading…</div>
    <form hx-post="/ui/message" hx-target="#transcript" hx-swap="innerHTML"
          hx-on::after-request="this.reset()">
      <input type="hidden" name="taskId" value="${t}">
      <input type="text" name="text" placeholder="ask it something…" autocomplete="off" required>
      <button type="submit" name="mode" value="steer">send</button>
      <button type="submit" name="mode" value="followUp" class="ghost"
              title="Held back until the agent has finished everything it is doing">after</button>
    </form>
    <form hx-post="/ui/compact" hx-target="#transcript" hx-swap="innerHTML" style="padding-top:0">
      <input type="hidden" name="taskId" value="${t}">
      <button type="submit" class="ghost"
              title="Summarise the older part of this conversation now, keeping the recent part">compact now</button>
    </form>
    <div class="hint">Sending while it works steers it: the message reaches the model
      before its next call, and nothing in flight is stopped. <b>after</b> holds the message
      until it has finished.</div>
    <h2 style="border-top:1px solid var(--line)">awaiting approval</h2>
    <div class="body" id="approvals" style="max-height:22vh"
         hx-get="/ui/approvals?taskId=${t}"
         hx-trigger="load, every 2s" hx-swap="innerHTML">loading…</div>
  </section>
  <section>
    <div class="tabs">
      ${tab("trajectory", "trajectory", "/ui/transcript")}
      ${tab("events", "events", "/ui/events")}
      ${tab("storage", "storage", "/ui/storage")}
      ${tab("memory", "memory", "/ui/memory")}
      ${tab("sandbox", "sandbox", "/ui/sandbox")}
      ${tab("runtime", "runtime", "/ui/runtime")}
    </div>
    <div class="body" id="panel" style="max-height:78vh"
         hx-get="/ui/transcript?taskId=${t}"
         hx-trigger="load, every 3s[window.__panel===undefined||window.__panel==='/ui/transcript']"
         hx-swap="innerHTML">loading…</div>
    <div class="hint">Panels re-read the object on every request; nothing is cached
      client-side, so what you see is what the store holds.</div>
  </section>
</main>
<script>
  // Keep whichever panel is open refreshing, rather than snapping back.
  setInterval(() => {
    const p = window.__panel; if (!p) return;
    htmx.ajax('GET', p + '?taskId=${t}', { target: '#panel', swap: 'innerHTML' });
  }, 3000);
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
      <span><b style="background:#9ece6a"></b>message</span>
      <span><b style="background:#9d7cd8"></b>model</span>
      <span><b style="background:#7aa2f7"></b>execution</span>
      <span><b style="background:#3d4657"></b>operation</span>
      <span><b style="background:#f7768e"></b>failure</span>
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
      <span><b style="background:#2d4f6b"></b>cached prompt</span>
      <span><b style="background:#7aa2f7"></b>fresh prompt</span>
      <span><b style="background:#9d7cd8"></b>completion</span>
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
      into the system prompt when a task opens.</div>`;
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
  ${prov ? bar("of which the provider", Number(prov.ms), "#3d4657") : ""}
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
