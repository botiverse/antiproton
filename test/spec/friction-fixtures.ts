/**
 * Synthetic transcripts for the friction suites (test/friction-classify.ts, test/friction-scan.ts): redacted
 * reconstructions of the two calibration episodes (cf/src/friction.ts names them), with a user message and a
 * credential planted where a leak would show.
 */
import type { FrictionEvent } from "../../cf/src/friction.ts";

/** A transcript under construction: calls and results with seqs and times in order. */
export function transcript(start: number) {
  const ev: FrictionEvent[] = [];
  let seq = 1, n = 0;
  const at = (s: number) => start + s * 1000;
  return {
    events: ev,
    user(s: number, text: string) { ev.push({ sequence: seq++, kind: "message", createdAt: at(s), payload: { text } }); },
    call(s: number, name: string, args: unknown, text = "") {
      const id = `call_${++n}`;
      ev.push({ sequence: seq++, kind: "model.response", createdAt: at(s), payload: { text, toolCalls: [{ id, name, arguments: args }], finishReason: "toolUse" } });
      return id;
    },
    calls(s: number, list: Array<[string, unknown]>) {
      const ids = list.map(() => `call_${++n}`);
      ev.push({ sequence: seq++, kind: "model.response", createdAt: at(s), payload: { text: "", toolCalls: list.map(([name, args], i) => ({ id: ids[i], name, arguments: args })), finishReason: "toolUse" } });
      return ids;
    },
    ok(s: number, id: string, tool: string, result: unknown) {
      ev.push({ sequence: seq++, kind: "tool.result", createdAt: at(s), payload: { tool, callId: id, isError: false, status: "succeeded", result } });
    },
    err(s: number, id: string, tool: string, result: string) {
      ev.push({ sequence: seq++, kind: "tool.result", createdAt: at(s), payload: { tool, callId: id, isError: true, status: "rejected", result } });
    },
    say(s: number, text: string) { ev.push({ sequence: seq++, kind: "model.response", createdAt: at(s), payload: { text, finishReason: "stop" } }); },
  };
}

export const SECRET_TOKEN = "ghp_" + "Zx9".repeat(12);
export const USER_SECRET = "my bank PIN is 4471 and my diary says hello";

/** 2026-10-18 00:29:52Z: an image over the px limit, then three minutes of looking for its bytes. */
export function attachmentEpisode(start = Date.parse("2026-10-18T00:29:52Z"), att = "1b2c3d4e-0000-4000-8000-00000000abcd") {
  const t = transcript(start);
  t.user(0, `here is the screenshot. ${USER_SECRET}`);
  const v = t.call(5, "raft__attachments_view", { attachmentId: att });
  t.err(9, v, "raft__attachments_view", `raft__attachments_view: attachment ${att} ("IMG_2214.jpg") is too large to view: 1449×2048px, over the 2000px limit on a side. Images are not resized here. It was kept as artifact://raft/attachments/${att}.jpg`);
  const sh1 = t.call(18, "sandbox__shell", { command: 'ls / ; echo ---; ls /work; echo ---; env | grep -i "artifact\\|raft\\|r2" | head' });
  t.ok(19, sh1, "sandbox__shell", { exitCode: 0, stdout: "bin\nwork\n" });
  const rd = t.call(23, "artifacts__read", { ref: `artifact://raft/attachments/${att}.jpg`, limit: 60 });
  t.ok(24, rd, "artifacts__read", { kind: "text", bytes: 217302, text: "����\u0000\u0010JFIF\u0000\u0001\u0001\u0000\u0000H\u0000H\u0000\u0000��\u0000C\u0000\u0006\u0004\u0005\u0006" + "a".repeat(200) });
  t.call(31, "raft__messages_send", { content: "这一张看不到" });
  const sh2 = t.call(73, "sandbox__shell", { command: `ls -a / ; echo ---; ls /mnt /media /opt 2>/dev/null; echo ---; find / -maxdepth 2 -name "*artifact*"` });
  t.ok(74, sh2, "sandbox__shell", { exitCode: 0, stdout: "" });
  // Credentials at the head of a command, where an excerpt keeps them unless redaction removes them.
  const cu1 = t.call(74, "sandbox__shell", { command: `curl -sI -H "Authorization: Bearer ${SECRET_TOKEN}" https://api.raft.build/me` });
  t.ok(74, cu1, "sandbox__shell", { exitCode: 0, stdout: "" });
  const cu2 = t.call(74, "sandbox__shell", { command: "curl -sI https://ops:hunter2@api.raft.build/x?token=abc" });
  t.ok(74, cu2, "sandbox__shell", { exitCode: 0, stdout: "" });
  const w1 = t.call(75, "web__get", { url: `artifact://raft/attachments/${att}.jpg` });
  t.err(75, w1, "web__get", "web__get: refused scheme artifact:");
  const [h1, h2] = t.calls(133, [["web__get", { url: `https://api.raft.build/api/attachments/${att}/download`, method: "HEAD" }], ["web__get", { url: `https://api.raft.build/attachments/${att}`, method: "HEAD" }]]);
  t.ok(138, h1!, "web__get", { status: 401, url: `https://api.raft.build/api/attachments/${att}/download` });
  t.ok(138, h2!, "web__get", { status: 404, url: `https://api.raft.build/attachments/${att}` });
  const sh3 = t.call(145, "sandbox__shell", { command: 'which raft raft-cli 2>/dev/null; echo "---"; ls /usr/local/bin | head -30; echo "---"; env | sort | head -40' });
  t.ok(146, sh3, "sandbox__shell", { exitCode: 0, stdout: "" });
  const [c1, c2] = t.calls(153, [["web__get", { url: `https://content.raft.build/a/${att}`, method: "HEAD" }], ["web__get", { url: `https://content.raft.build/attachments/${att}.jpg`, method: "HEAD" }]]);
  t.ok(158, c1!, "web__get", { status: 404, url: `https://content.raft.build/a/${att}` });
  t.ok(158, c2!, "web__get", { status: 404, url: `https://content.raft.build/attachments/${att}.jpg` });
  t.call(160, "raft__messages_send", { content: "长边压到 ≤2000 px 再发（1449×2048 → 缩到 1415×2000 就够）。这步我做不到，因为原始字节到不了我手上。另外，`gh` 还是 401。" });
  t.say(164, "结论是**字节拿不到**");
  return t.events;
}

/** 2026-10-17 23:25Z, a subagent: a gh mount whose credential GitHub refused, then raw mirrors returning gzip as text. */
export function ghEpisode(start = Date.parse("2026-10-17T23:25:17Z")) {
  const t = transcript(start);
  const BAD = (tool: string) => `${tool}: github 401: Bad credentials — the "gh" mount's account was used, and GitHub refused that credential itself, so it has to be replaced rather than added to`;
  const a = t.call(0, "gh__repo_view", { repo: "botiverse/antiproton" }); t.err(1, a, "gh__repo_view", BAD("gh__repo_view"));
  for (const [i, path] of [[20, "cf/src/index.ts"], [40, "cf/src/trace-r2.ts"], [60, "README.md"]] as const) {
    const id = t.call(i, "gh__file_view", { repo: "botiverse/antiproton", path }); t.err(i + 1, id, "gh__file_view", BAD("gh__file_view"));
  }
  const g = t.call(120, "web__get", { url: "https://api.github.com/repos/botiverse/antiproton/contents/cf/src/index.ts" });
  t.ok(121, g, "web__get", { status: 403, url: "https://api.github.com/repos/botiverse/antiproton/contents/cf/src/index.ts" });
  const m = t.call(180, "web__get", { url: "https://cdn.statically.io/gh/botiverse/antiproton/master/cf/src/index.ts" });
  t.ok(181, m, "web__get", "\u001f�\u0008\u0000".repeat(15) + "x".repeat(705));
  t.say(300, "I could not read cf/src/index.ts through any route: the gh mount is refused and the mirrors return binary.");
  return t.events;
}

