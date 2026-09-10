/**
 * The conversion between pi's request shape and our provider client.
 *
 * This runs in the Worker that does the waiting, so it is the one place where a
 * mistake is silent: a dropped tool result or a mis-mapped stop reason does not
 * throw, it just makes the agent behave oddly one turn later.
 */
import { toRequest, fromResponse } from "../src/model/pi-bridge.ts";

const results: Array<{ name: string; ok: boolean; error?: string }> = [];
function check(name: string, fn: () => void) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: String((e as Error)?.message ?? e) }); }
}
const eq = (a: unknown, b: unknown, what: string) => {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what}\n  got  ${JSON.stringify(a)}\n  want ${JSON.stringify(b)}`);
  }
};

check("system、user、assistant 的 tool_calls、tool 结果都过得去", () => {
  const { messages, tools } = toRequest({
    systemPrompt: "be brief",
    messages: [
      { role: "user", content: "hi", timestamp: 1 } as any,
      { role: "assistant", content: [
        { type: "text", text: "looking" },
        { type: "toolCall", id: "c1", name: "read", arguments: { url: "u" } },
      ] } as any,
      { role: "toolResult", toolCallId: "c1", toolName: "read",
        content: [{ type: "text", text: "page" }], isError: false } as any,
    ],
    tools: [{ name: "read", description: "d", parameters: { type: "object" } as any }],
  });
  eq(messages[0], { role: "system", content: "be brief" }, "system prompt");
  eq(messages[1], { role: "user", content: "hi" }, "user");
  eq(messages[2], {
    role: "assistant", content: "looking",
    tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"url":"u"}' } }],
  }, "assistant with a call");
  eq(messages[3], { role: "tool", tool_call_id: "c1", content: "page" }, "tool result");
  eq(tools, [{ name: "read", description: "d", parameters: { type: "object" } }], "tools");
});

check("没有工具调用的助手回合不带 tool_calls 键", () => {
  const { messages } = toRequest({
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] } as any],
  });
  if ("tool_calls" in (messages[0] as any)) throw new Error("an empty tool_calls key was sent");
});

const model = { api: "offloaded", provider: "queue", id: "m" };

check("停止原因:工具调用、截断、普通结束", () => {
  const base = { text: "", finishReason: "stop", truncated: false,
    usage: { promptTokens: 3, completionTokens: 4, reasoningTokens: 1, cachedPromptTokens: 2 } };
  const withCall = fromResponse(
    { ...base, toolCalls: [{ id: "a", name: "t", arguments: { x: 1 } }] } as any, model);
  if (withCall.stopReason !== "toolUse") throw new Error(`tool call → ${withCall.stopReason}`);
  const cut = fromResponse({ ...base, truncated: true, text: "half" } as any, model);
  if (cut.stopReason !== "length") throw new Error(`truncated → ${cut.stopReason}`);
  const plain = fromResponse({ ...base, text: "answer" } as any, model);
  if (plain.stopReason !== "stop") throw new Error(`plain → ${plain.stopReason}`);
  eq(plain.usage.input, 3, "prompt tokens");
  eq(plain.usage.cacheRead, 2, "cached prompt tokens");
  eq((plain.usage as any).reasoning, 1, "reasoning tokens");
  eq(plain.usage.totalTokens, 7, "total");
});

check("推理痕迹被记下来,但不会当成回答文本", () => {
  const m = fromResponse(
    { text: "the answer", reasoning: "because", finishReason: "stop", truncated: false,
      usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 } } as any,
    model);
  const kinds = m.content.map((c: any) => c.type);
  eq(kinds, ["thinking", "text"], "content blocks");
  // And it is not replayed on the way back out.
  const { messages } = toRequest({ messages: [m as any] });
  eq(messages[0], { role: "assistant", content: "the answer" }, "reasoning is not sent back");
});

console.log(`\n  pi request bridge\n  ${"─".repeat(56)}`);
for (const r of results) {
  console.log(r.ok ? `  \x1b[32m✓\x1b[0m ${r.name}` : `  \x1b[31m✗\x1b[0m ${r.name}\n      \x1b[31m${r.error}\x1b[0m`);
}
const pass = results.filter((r) => r.ok).length;
console.log(`  ${"─".repeat(56)}\n  ${pass} passed, ${results.length - pass} failed\n`);
process.exit(pass === results.length ? 0 : 1);
