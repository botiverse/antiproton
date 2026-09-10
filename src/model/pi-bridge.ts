/**
 * pi's request shape, in the terms our own provider client already speaks.
 *
 * The model call happens in a Worker, not in the object, and the Worker must
 * stay small: importing pi-ai's provider implementations there would drag the
 * OpenAI, Anthropic, Google and Bedrock SDKs into a binary that is already
 * shipped to every tenant. Our OpenAiCompatibleModel is a few hundred lines and
 * has been answering DeepSeek for months, so the conversion happens here and the
 * client stays.
 *
 * Both directions are lossy in one place each, and deliberately. Images are
 * dropped on the way out because this provider has never accepted them. The
 * reasoning trace is kept on the way back but not replayed on the way out: the
 * next request carries the reply, not the thinking behind it.
 */
import type { AssistantMessage, Context as PiContext, Message as PiMessage, Usage } from "@earendil-works/pi-ai";
import type { ModelMessage, ModelResponse, ToolDefinition } from "./types.ts";

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => String(c.text ?? ""))
    .join("");
};

export function toRequest(context: PiContext): {
  messages: ModelMessage[];
  tools?: ToolDefinition[];
} {
  const messages: ModelMessage[] = [];
  if (context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });

  for (const m of context.messages as PiMessage[]) {
    if (m.role === "user") {
      messages.push({ role: "user", content: textOf(m.content) });
      continue;
    }
    if (m.role === "toolResult") {
      messages.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: textOf(m.content),
      });
      continue;
    }
    // assistant
    const calls = (m.content ?? []).filter((c: any) => c?.type === "toolCall") as any[];
    messages.push({
      role: "assistant",
      content: textOf(m.content),
      ...(calls.length
        ? {
            tool_calls: calls.map((c) => ({
              id: c.id, type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
            })),
          }
        : {}),
    });
  }

  const tools = context.tools?.map((t) => ({
    name: t.name, description: t.description, parameters: t.parameters as unknown,
  })) as ToolDefinition[] | undefined;

  return { messages, ...(tools?.length ? { tools } : {}) };
}

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** Cost is left at zero: this deployment prices per tenant elsewhere, and a
 *  wrong number in the transcript is worse than an absent one. */
function usageOf(res: ModelResponse): Usage {
  const u = res.usage ?? { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 };
  return {
    input: u.promptTokens ?? 0,
    output: u.completionTokens ?? 0,
    cacheRead: u.cachedPromptTokens ?? 0,
    cacheWrite: 0,
    ...(u.reasoningTokens ? { reasoning: u.reasoningTokens } : {}),
    totalTokens: (u.promptTokens ?? 0) + (u.completionTokens ?? 0),
    cost: { ...NO_COST },
  };
}

export function fromResponse(
  res: ModelResponse,
  model: { api: string; provider: string; id: string },
): AssistantMessage {
  const content: AssistantMessage["content"] = [];
  if (res.reasoning) content.push({ type: "thinking", thinking: res.reasoning } as any);
  if (res.text) content.push({ type: "text", text: res.text });
  for (const c of res.toolCalls ?? []) {
    content.push({
      type: "toolCall", id: c.id, name: c.name,
      arguments: (c.arguments ?? {}) as Record<string, unknown>,
    } as any);
  }

  // A truncated reply that still says something is usable, and `length` is how
  // the harness is told it was cut off. A truncated reply that says nothing at
  // all is not a turn — it is a failed call wearing the shape of one, and
  // recording it as an assistant message ends the run with an empty answer that
  // no caller can distinguish from silence. That is what happened: the object
  // was idle, the transcript was complete, and the answer was "".
  if (res.truncated && !res.text && !(res.toolCalls?.length)) {
    return {
      ...errorMessage(
        "the model reached its output limit before writing an answer" +
        (res.usage?.reasoningTokens ? ` (${res.usage.reasoningTokens} tokens of reasoning)` : ""),
        model),
      usage: usageOf(res),
      rawStopReason: res.finishReason,
    };
  }

  const stopReason: AssistantMessage["stopReason"] =
    res.truncated ? "length"
      : (res.toolCalls?.length ? "toolUse" : "stop");

  return {
    role: "assistant",
    content,
    api: model.api as any,
    provider: model.provider,
    model: model.id,
    usage: usageOf(res),
    stopReason,
    rawStopReason: res.finishReason,
    timestamp: Date.now(),
  };
}

export function errorMessage(
  error: string,
  model: { api: string; provider: string; id: string },
): AssistantMessage {
  return {
    role: "assistant", content: [], api: model.api as any, provider: model.provider,
    model: model.id, usage: usageOf({} as ModelResponse), stopReason: "error",
    errorMessage: error, timestamp: Date.now(),
  };
}
