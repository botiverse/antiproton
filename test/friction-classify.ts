/**
 * The friction classifier (cf/src/friction.ts) on synthetic transcripts built from the two calibration days.
 *
 * The two episodes are redacted reconstructions of what was read on 2026-10-17 and 2026-10-18: the same tools, the
 * same error texts with their ids and names changed, the same order and spacing in time. Each must come out with the
 * root cause a fix would target and the classes the agent went through. The noise cases are the two the calibration
 * left (a descriptive sentence read as inability, a polling loop read as a repeated call), each beside a positive
 * control, so a "no signal" cannot be a classifier that sees nothing.
 */
import {
  episodes, excerpt, fingerprint, inabilityPhrase, redact, scanConversation, template, type Signal,
} from "../cf/src/friction.ts";
import { attachmentEpisode, ghEpisode, transcript, SECRET_TOKEN } from "./spec/friction-fixtures.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
function must(cond: unknown, msg: string): asserts cond { if (!cond) throw new Error(msg); }

await check("10-18 attachment episode: one episode, rooted in attachments_view's px limit, through every class the agent went through", () => {
  const sig = scanConversation("main.1", attachmentEpisode());
  const eps = episodes(sig);
  must(eps.length === 1, `episodes ${JSON.stringify(eps.map((e) => e.root))}`);
  const e = eps[0]!;
  must(e.root.cls === "tool_error", `root ${JSON.stringify(e.root)}`);
  must(e.root.key === "raft: attachment <uuid> (<q>) is too large to view: <n>×<n>px, over the <n>px limit on a side. Images are not resized here. It was kept as <artifact-ref>", `root key ${e.root.key}`);
  for (const c of ["tool_error", "env_probe", "binary_as_text", "auth_failure", "guessed_endpoint_404", "inability_text"] as const) {
    must(e.classes.includes(c), `missing ${c}: ${e.classes}`);
  }
  must(sig.some((s) => s.cls === "binary_as_text" && /magic: JFIF/.test(s.evidence)), "the JPEG read as text was not named by its magic");
  must(sig.some((s) => s.cls === "auth_failure" && s.key === "HTTP 401 api.raft.build"), "the 401 from api.raft.build is missing");
  must(sig.filter((s) => s.cls === "guessed_endpoint_404").length === 3, "three guessed 404s expected");
  must(sig.some((s) => s.cls === "inability_text" && s.key === "做不到"), "the agent's 这步我做不到 was not read");
});

await check("10-17 gh episode: rooted in the gh mount's refused credential, with the auth failures, repeated failure, binary text and the last words", () => {
  const sig = scanConversation("sub_8a4f448c39e2623b", ghEpisode());
  const eps = episodes(sig);
  must(eps.length === 1, `episodes ${eps.length}`);
  const e = eps[0]!;
  must(e.root.cls === "tool_error" && e.root.key.startsWith("gh: github <n>: Bad credentials — the <q> mount's account was used"), `root ${JSON.stringify(e.root)}`);
  for (const c of ["tool_error", "auth_failure", "repeated_failure", "binary_as_text", "inability_text"] as const) must(e.classes.includes(c), `missing ${c}: ${e.classes}`);
  must(sig.some((s) => s.cls === "auth_failure" && s.key === "HTTP 403 api.github.com"), "the raw 403 from api.github.com is missing");
  must(sig.some((s) => s.cls === "auth_failure" && s.key.startsWith("gh mount 401")), "the mount's own 401 is missing");
});

await check("noise: a descriptive sentence mid-turn, or sent with nothing failed before it, is not inability", () => {
  const t = transcript(Date.parse("2026-10-17T23:24:03Z"));
  t.call(0, "subagents__spawn", { task: "read the repo" }, "要点：它是我这个模型的另一份副本，有我的只读工具，但看不到这段对话。");
  t.call(10, "raft__messages_send", { content: "它是我这个模型的另一份副本，有我的只读工具，但看不到这段对话，所以任务描述得自带全部上下文。" });
  t.call(20, "subagents__spawn", { task: "x" }, "The subagent is not able to see this conversation, so the brief carries everything.");
  const sig = scanConversation("main.1", t.events);
  must(!sig.some((s) => s.cls === "inability_text"), `read as inability: ${JSON.stringify(sig.filter((s) => s.cls === "inability_text"))}`);
  // Positive controls: the same lexical rule fires on the agent's own inability, as last words and after a failure.
  must(inabilityPhrase("这步我做不到，因为原始字节到不了我手上")?.phrase === "做不到", "the lexical rule lost 这步我做不到");
  must(inabilityPhrase("有我的只读工具，但看不到这段对话") === null, "a 我 in another clause still counts");
  const c = transcript(Date.parse("2026-10-17T23:24:03Z"));
  c.call(0, "subagents__spawn", { task: "x" }, "I cannot see the attachment.");
  c.say(5, "I cannot see the attachment.");
  const csig = scanConversation("main.1", c.events);
  must(csig.filter((s) => s.cls === "inability_text").length === 1, `control: ${JSON.stringify(csig)}`);
});

await check("noise: polling a job or an event stream is not a repeated call; the same non-polling call is", () => {
  const t = transcript(Date.parse("2026-10-17T13:30:00Z"));
  for (let i = 0; i < 10; i++) { const id = t.call(i * 20, "jobs", { op: "op_77" }); t.ok(i * 20 + 1, id, "jobs", { running: 1 }); }
  for (let i = 0; i < 5; i++) { const id = t.call(i * 20 + 5, "raft__receive_events", { since: i }); t.ok(i * 20 + 6, id, "raft__receive_events", { events: [] }); }
  for (let i = 0; i < 4; i++) { const id = t.call(i * 20 + 9, "sandbox__shell", { command: `cd /work && npm test -- --grep case${i}x${i}` }); t.ok(i * 20 + 10, id, "sandbox__shell", { exitCode: 0 }); }
  const sig = scanConversation("main", t.events);
  must(!sig.some((s) => s.cls === "repeated_call"), `repeated: ${JSON.stringify(sig.filter((s) => s.cls === "repeated_call"))}`);
  const c = transcript(Date.parse("2026-10-17T13:30:00Z"));
  for (let i = 0; i < 3; i++) { const id = c.call(i * 20, "artifacts__read", { ref: "artifact://out/report.txt" }); c.ok(i * 20 + 1, id, "artifacts__read", { kind: "text" }); }
  must(scanConversation("main", c.events).some((s) => s.cls === "repeated_call" && s.key === "artifacts__read"), "control: the same read 3 times is not a repeated call");
});

await check("noise: a 401 printed by a shell is a tool error, not an auth failure", () => {
  const t = transcript(0);
  const id = t.call(0, "sandbox__shell", { command: "grep -rn status cf/src" });
  t.err(1, id, "sandbox__shell", "exit 1: cf/src/index.ts:12: status: 401");
  const sig = scanConversation("main", t.events);
  must(sig.some((s) => s.cls === "tool_error") && !sig.some((s) => s.cls === "auth_failure"), JSON.stringify(sig));
});

await check("user messages are never read, and no signal's evidence carries a token or url credentials", () => {
  const sig = scanConversation("main.1", attachmentEpisode());
  const all = JSON.stringify(sig);
  must(!all.includes("bank PIN") && !all.includes("4471"), "a user message reached a signal");
  must(!all.includes(SECRET_TOKEN) && !all.includes("hunter2") && !all.includes("token=abc"), `a credential reached a signal: ${all.match(/.{40}(ghp_|hunter2|token=abc).{20}/)?.[0]}`);
  must(!all.includes("IMG_2214"), "a file name quoted in an error reached a key");
  must(redact(`Authorization: Bearer ${SECRET_TOKEN}`).indexOf(SECRET_TOKEN) < 0, "redact kept the token");
  must(excerpt("x".repeat(500)).length <= 141, "excerpt is not capped");
});

await check("template: quotes, paths, urls, emails, ids and numbers go; the host stays", () => {
  const t = template(`fs__read: cannot open /work/acme-secret/plan.md for "Alice" (ann@acme.io) at https://files.acme.io/x/y?k=1 after 3 tries, op_1234abcd`);
  must(t === "cannot open <path> for <q> (<email>) at <url:files.acme.io> after <n>tries, <op_id>", t);
  must(template("the 'gh' mount's account") === "the <q> mount's account", template("the 'gh' mount's account"));
});

await check("fingerprint: the same failure across agents, ids and sizes is one fingerprint, and it does not drift", async () => {
  const a = episodes(scanConversation("main.1", attachmentEpisode(Date.parse("2026-10-18T00:29:52Z"), "1b2c3d4e-0000-4000-8000-00000000abcd")))[0]!;
  const b = episodes(scanConversation("main.7", attachmentEpisode(Date.parse("2026-10-20T09:00:00Z"), "99999999-1111-4222-8333-444444444444")))[0]!;
  const fa = await fingerprint(a.root.cls, a.root.key), fb = await fingerprint(b.root.cls, b.root.key);
  must(fa === fb, `${fa} != ${fb}`);
  // Pinned: a change to the hashing or the template would rename every known finding and reopen its issue.
  must(fa === "fr_59860ecbc77a28a9", `the attachment fingerprint moved: ${fa}`);
  const g = episodes(scanConversation("sub_x", ghEpisode()))[0]!;
  must(await fingerprint(g.root.cls, g.root.key) !== fa, "two root causes share a fingerprint");
});

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `\n      ${r.error}`}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
