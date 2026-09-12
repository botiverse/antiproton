/**
 * The chat fragment carries the held cards only when asked, and then in the
 * block the decide buttons target.
 */
import { chatPanel } from "../cf/src/chat.ts";
import type { ApprovalRecord } from "../src/core/types.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const must = (cond: unknown, msg: string) => { if (!cond) throw new Error(msg); };
const held = (state: "pending" | "approved"): ApprovalRecord => ({
  tenantId: "demo", operationId: "op_1", agentId: "a", taskId: "t_a", mountAlias: "gh", tool: "issue_create",
  request: { tool: "gh.issue_create", args: { title: "x" } }, state, approver: null, decidedAt: null, createdAt: 1,
} as unknown as ApprovalRecord);

check("without held, the fragment is the turns alone", () => {
  must(chatPanel("<div class=step>hi</div>", null) === "<div class=step>hi</div>", "must be unchanged");
});

check("with held, the cards follow the turns inside the block the decide buttons target", () => {
  const html = chatPanel("<div class=step>hi</div>", [held("pending")]);
  must(html.startsWith("<div class=step>hi</div>"), "turns must come first");
  must(/<div class="held" id="approvals">/.test(html), "the wrapper must carry id=approvals");
  must(/hx-target="#approvals"/.test(html), "the decide buttons must target the wrapper");
  must(/gh\.issue_create/.test(html), "the pending card must render");
});

check("the wrapper is inert: the chat poll redraws it, it never fetches for itself", () => {
  // Before #169 the shell carried this element as a poller of its own
  // (data-lazy, hx-get, hx-trigger). It now arrives here, and a reader of
  // this file should learn that nothing may make it fetch again.
  for (const rows of [[held("pending")], []]) {
    const open = /<div class="held" id="approvals"([^>]*)>/.exec(chatPanel("t", rows));
    must(open, "the wrapper must be there, or the decide buttons have no target");
    must(!/\bhx-|data-lazy/.test(open![1]), `no hx- attribute and no data-lazy on the wrapper: <div${open![1]}>`);
  }
});

check("with held but nothing pending, the block says so rather than vanishing", () => {
  const html = chatPanel("t", [held("approved")]);
  must(/id="approvals"/.test(html) && /nothing waiting/.test(html), "the empty state must render inside the block");
});

const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "ok" : "FAIL"} - ${r.name}${r.error ? `\n    ${r.error}` : ""}`);
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
