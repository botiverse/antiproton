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
 * The reasoning trace is kept on the way back but not replayed on the way out:
 * the next request carries the reply, not the thinking behind it. The exception
 * is an OpenAI reasoning model, called through the Responses API, whose
 * reasoning comes back as opaque items the next request must carry
 * (`toResponsesInput`).
 *
 * Images go out only to a model that can see them (`images: true`, which the
 * consumer sets from src/model/context-windows.ts `acceptsImages`), and by then
 * the consumer has replaced each stored reference with its bytes
 * (src/model/images.ts). For any other model each image is replaced by a sentence
 * saying the model cannot see it, never dropped without a word. A request with
 * no image is built exactly as it was before images existed: every branch below
 * that is new is taken only for a message that holds one.
 */
import type { AssistantMessage, Context as PiContext, Message as PiMessage, Tool as PiTool, Usage } from "@earendil-works/pi-ai";
import type { ChatContentPart, ModelMessage, ModelResponse, ToolDefinition } from "./types.ts";
import { IMAGE_REF_PREFIX, NO_VISION_SENTENCE } from "./images.ts";

/**
 * The job wire format, version 2: a system message keeps its place in the conversation.
 *
 * Version 1 is pi-ai 0.85's `Context` as it is — `{ systemPrompt?, messages, tools? }`, no tag —
 * and it is what the live runtime (src/model/pi-offloaded.ts) writes. It has one system prompt,
 * at the top. pi-ai 1.0 writes the prompt as system messages in the transcript, each where it
 * took effect: pi-durable writes the first one after the first input and a patch after a later
 * input whenever a section or the tool set changed. Folded into one top prompt, every one of
 * them lost its position.
 *
 * Version 2 carries the tag and has no `systemPrompt`: every system message is an entry of
 * `messages`, sent where the writer placed it — the prompt at the top, each later one where it
 * stands. The writer renders each to its text first
 * (src/model/durable-offloaded.ts `jobContext`), so the consumer needs no pi-ai 1.0 code and the
 * Worker stays small. `tools` is the tool set current at the end of the conversation, because our
 * provider client sends one top-level tool list per request.
 */
export const JOB_WIRE_V2 = 2;

/** A system message at its position in the conversation, already rendered to its text. */
export type InlineSystemMessage = { role: "system"; content: string };

/** `M` and `T` are the writer's message and tool types; the shape is all the consumer reads. */
export interface JobContextV2<M = PiMessage, T = PiTool> {
  version: typeof JOB_WIRE_V2;
  messages: Array<M | InlineSystemMessage>;
  tools?: T[];
}

/** What a `pi_model_jobs` row's `context` may hold: version 1 (untagged) or version 2. */
export type JobContext = PiContext | JobContextV2;

/**
 * The version a stored context declares. Untagged is version 1. Any other tag is refused rather
 * than read as the nearest known one: a format this consumer does not know may carry turns it
 * would drop, and a request built without them is a wrong conversation that fails nowhere.
 */
function wireVersion(context: JobContext): 1 | 2 {
  const version: unknown = Reflect.get(context, "version");
  if (version === undefined) return 1;
  if (version === JOB_WIRE_V2) return 2;
  throw new Error(`a model job's context declares wire version ${JSON.stringify(version)}, which this consumer cannot read`);
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => String(c.text ?? ""))
    .join("");
};

/** The image blocks of a message's content, in order; none for a string. */
const imagesOf = (content: unknown): Array<{ data: string; mimeType: string }> =>
  Array.isArray(content) ? content.filter((c: any) => c?.type === "image") as any[] : [];

/**
 * An image as a data URL. Its `data` must be bytes by now: a reference still in place is a consumer that did not
 * resolve it (src/model/images.ts `resolveImages`), and sending it would be an image no provider can decode.
 */
function dataUrl(image: { data: string; mimeType: string }): string {
  if (typeof image.data !== "string" || !image.data || image.data.startsWith(IMAGE_REF_PREFIX)) {
    throw new Error("an image in a model request was never resolved to its bytes");
  }
  return `data:${image.mimeType};base64,${image.data}`;
}

/** Text with the no-vision sentence after it, once per message, in place of the message's images. */
const withNoVision = (text: string) => (text ? `${text}\n\n${NO_VISION_SENTENCE}` : NO_VISION_SENTENCE);

/** What the text of a tool result says when the result is only images: pi's own words for it. */
const IMAGE_ONLY_TOOL_TEXT = "(see attached image)";

/** The user message that carries a tool result's images, after the results: DeepSeek takes an image in a user message only. */
const TOOL_IMAGES_LEAD = "Attached image(s) from tool result:";

/** Options of both serializers. */
export interface SerializeOptions {
  /** Whether the model called can see images (src/model/context-windows.ts `acceptsImages`). Absent is no. */
  images?: boolean;
}

/**
 * A stored job's context as our provider client's request. A version 1 context builds exactly
 * the request it always did. A version 2 context's inline system message becomes an inline
 * `role: "system"` message at the same position: OpenAiCompatibleModel sends `messages` as
 * given, and DeepSeek's chat completions (deepseek-flash, deepseek-v4-pro) accepted and followed
 * one between turns, after a user turn as the last message, and after a tool result (probed
 * 2026-10-02 through OpenAiCompatibleModel; pi-ai 1.0's catalog marks only deepseek-v4-pro as
 * verified, which is why the reading is cited rather than the catalog). No other provider was
 * probed. One that refuses a mid-conversation system message needs these folded into the leading
 * message, as pi-ai's `collapseSystemMessages` does, for that provider only.
 */
export function toRequest(context: JobContext, opts: SerializeOptions = {}): {
  messages: ModelMessage[];
  tools?: ToolDefinition[];
} {
  const inline = wireVersion(context) === 2;
  const messages: ModelMessage[] = [];
  // Images from the tool results since the last other message: sent in one user message after the run of results,
  // as pi sends them (pi-ai-1 dist/api/openai-completions.js), since a user message between the results of one
  // turn's calls would split the run of tool messages the provider expects after the call.
  let toolImages: ChatContentPart[] = [];
  const flushToolImages = () => {
    if (!toolImages.length) return;
    messages.push({ role: "user", content: [{ type: "text", text: TOOL_IMAGES_LEAD }, ...toolImages] });
    toolImages = [];
  };
  if ("systemPrompt" in context && context.systemPrompt) messages.push({ role: "system", content: context.systemPrompt });

  for (const m of context.messages) {
    if (m.role !== "toolResult") flushToolImages();
    if (m.role === "system") {
      // Only version 2 may carry one. In version 1 it was never written, and passing it on would
      // put an instruction into a request whose format says it has none.
      if (!inline) throw new Error("a version 1 model job carries a system message in its conversation");
      messages.push({ role: "system", content: m.content });
      continue;
    }
    if (m.role === "user") {
      const images = imagesOf(m.content);
      if (!images.length) messages.push({ role: "user", content: textOf(m.content) });
      else if (!opts.images) messages.push({ role: "user", content: withNoVision(textOf(m.content)) });
      else {
        // In the order the user wrote them: text and images interleaved as they were.
        const parts: ChatContentPart[] = [];
        for (const c of m.content as any[]) {
          if (c?.type === "text" && c.text) parts.push({ type: "text", text: String(c.text) });
          else if (c?.type === "image") parts.push({ type: "image_url", image_url: { url: dataUrl(c) } });
        }
        messages.push({ role: "user", content: parts });
      }
      continue;
    }
    if (m.role === "toolResult") {
      const images = imagesOf(m.content);
      const text = textOf(m.content);
      messages.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: !images.length ? text : !opts.images ? withNoVision(text) : text || IMAGE_ONLY_TOOL_TEXT,
      });
      if (images.length && opts.images) toolImages.push(...images.map((i) => ({ type: "image_url" as const, image_url: { url: dataUrl(i) } })));
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

  flushToolImages();

  const tools = context.tools?.map((t) => ({
    name: t.name, description: t.description, parameters: t.parameters as unknown,
  })) as ToolDefinition[] | undefined;

  return { messages, ...(tools?.length ? { tools } : {}) };
}

/**
 * A stored job's context as Responses API input (src/model/openai-responses.ts), for `model`, the model the call
 * reaches.
 *
 * The conversation is `toRequest`'s, item for item, in the Responses API's form (pi's own conversion is
 * `convertResponsesMessages`, pi-ai-1 dist/api/openai-responses-shared.js): a system message, the leading prompt
 * or a later one in place, is a `developer` message, as pi sends instructions to a reasoning model; a tool call is a
 * `function_call` item and its result a `function_call_output`. Images, for a model that can see them, are
 * `input_image` parts: in a user message, and in a tool result's `output` beside its text as pi sends them
 * (`convertToolResultOutput` there), or, with `toolImages: "user"`, in a user message after the results, the way
 * `toRequest` must send them to DeepSeek. Both were answered correctly by gpt-5.6-luna through Cloudflare AI
 * Gateway's /compat/responses (measured 2026-10-12); `"output"` is the default because it is pi's.
 *
 * The one difference is reasoning. An assistant turn's thinking block that carries a `thinkingSignature` is
 * replayed as the reasoning item it holds, in its place before the text and calls it led to, so the model sees
 * its own reasoning again across the tool calls of a turn instead of starting each call from the visible
 * transcript alone. Only an answer from `model` itself is replayed (its `model`, which `fromResponse` sets to the
 * model called): encrypted reasoning is the model's own, and pi drops it for any other model too
 * (`transformMessages`, pi-ai-1 dist/api/transform-messages.js). A thinking block with no signature — DeepSeek's
 * trace, or one written before this existed — is dropped, as `toRequest` drops it.
 */
export function toResponsesInput(context: JobContext, model: string, opts: SerializeOptions & {
  /** Where a tool result's images go: in its `function_call_output` (pi's way, the default), or a user message after the results. */
  toolImages?: "output" | "user";
} = {}): {
  input: Array<Record<string, unknown>>;
  tools?: ToolDefinition[];
} {
  const inline = wireVersion(context) === 2;
  const input: Array<Record<string, unknown>> = [];
  const inputImage = (i: { data: string; mimeType: string }) => ({ type: "input_image", image_url: dataUrl(i), detail: "auto" });
  let toolImages: Array<Record<string, unknown>> = [];
  const flushToolImages = () => {
    if (!toolImages.length) return;
    input.push({ role: "user", content: [{ type: "input_text", text: TOOL_IMAGES_LEAD }, ...toolImages] });
    toolImages = [];
  };
  if ("systemPrompt" in context && context.systemPrompt) input.push({ role: "developer", content: context.systemPrompt });

  for (const m of context.messages) {
    if (m.role !== "toolResult") flushToolImages();
    if (m.role === "system") {
      if (!inline) throw new Error("a version 1 model job carries a system message in its conversation");
      input.push({ role: "developer", content: m.content });
      continue;
    }
    if (m.role === "user") {
      const images = imagesOf(m.content);
      if (!images.length) input.push({ role: "user", content: textOf(m.content) });
      else if (!opts.images) input.push({ role: "user", content: withNoVision(textOf(m.content)) });
      else {
        const parts: Array<Record<string, unknown>> = [];
        for (const c of m.content as any[]) {
          if (c?.type === "text" && c.text) parts.push({ type: "input_text", text: String(c.text) });
          else if (c?.type === "image") parts.push(inputImage(c));
        }
        input.push({ role: "user", content: parts });
      }
      continue;
    }
    if (m.role === "toolResult") {
      const images = imagesOf(m.content);
      const text = textOf(m.content);
      if (!images.length) input.push({ type: "function_call_output", call_id: m.toolCallId, output: text });
      else if (!opts.images) input.push({ type: "function_call_output", call_id: m.toolCallId, output: withNoVision(text) });
      else if (opts.toolImages === "user") {
        input.push({ type: "function_call_output", call_id: m.toolCallId, output: text || IMAGE_ONLY_TOOL_TEXT });
        toolImages.push(...images.map(inputImage));
      } else {
        input.push({
          type: "function_call_output", call_id: m.toolCallId,
          output: [...(text ? [{ type: "input_text", text }] : []), ...images.map(inputImage)],
        });
      }
      continue;
    }
    // assistant: its blocks in order, as pi replays them
    const own = m.model === model;
    for (const c of (m.content ?? []) as any[]) {
      if (c?.type === "thinking") {
        if (!own || typeof c.thinkingSignature !== "string" || !c.thinkingSignature) continue;
        let item: unknown;
        try { item = JSON.parse(c.thinkingSignature); } catch { continue; }
        if (item && typeof item === "object" && (item as { type?: unknown }).type === "reasoning") input.push(item as Record<string, unknown>);
      } else if (c?.type === "text") {
        if (c.text) input.push({ role: "assistant", content: String(c.text) });
      } else if (c?.type === "toolCall") {
        input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) });
      }
    }
  }

  flushToolImages();

  const tools = context.tools?.map((t) => ({
    name: t.name, description: t.description, parameters: t.parameters as unknown,
  })) as ToolDefinition[] | undefined;

  return { input, ...(tools?.length ? { tools } : {}) };
}

const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/**
 * The `errorMessage` of an answer the provider ended with nothing in it (`ModelResponse.failure`): fixed text, since the
 * harness's retry check scans it; the provider's reason travels in `providerError`.
 */
export const FAILED_ANSWER = "the model ended its answer with nothing in it: see the turn's error";

/** Cost is left at zero: this deployment prices per tenant elsewhere, and a
 *  wrong number in the transcript is worse than an absent one. */
function usageOf(res: ModelResponse): Usage {
  const u = res.usage ?? { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, cachedPromptTokens: 0 };
  return {
    input: u.promptTokens ?? 0,
    output: u.completionTokens ?? 0,
    cacheRead: u.cachedPromptTokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? 0,
    ...(u.reasoningTokens ? { reasoning: u.reasoningTokens } : {}),
    totalTokens: (u.promptTokens ?? 0) + (u.completionTokens ?? 0),
    cost: { ...NO_COST },
  };
}

/**
 * An answer as it is delivered and read back: an assistant message that may
 * name the `pi_model_jobs` row it answered. Both ends use this type so that
 * "the field is still there when it is read back" is said by the type, not
 * only by the test that reads the stored entry.
 */
export type AnsweredMessage = AssistantMessage & { jobId?: string; providerError?: string };

/**
 * `jobId` is the trace spine's one durable link from an answer back to the
 * model call that produced it. It has to ride on the message because nothing
 * else can carry it: the final entry's id is generated by pi after the answer
 * is delivered, and the usage row is assembled upstream without the job
 * handle. The message is stored verbatim as the entry body, so the entry ends
 * up saying which `pi_model_jobs` row answered it. `toRequest` copies only
 * content and tool calls, so the field never reaches a provider.
 */
export function fromResponse(
  res: ModelResponse,
  model: { api: string; provider: string; id: string },
  jobId?: string,
): AnsweredMessage {
  const content: AssistantMessage["content"] = [];
  if (res.failure) {
    return { ...errorMessage(FAILED_ANSWER, model), usage: usageOf(res), rawStopReason: res.finishReason, providerError: res.failure, ...(jobId ? { jobId } : {}) };
  }
  // Blocks in the provider's order (Anthropic's), each raw block in its signature field: thinking's
  // `thinkingSignature`, text's `textSignature`, a call's `thoughtSignature`, which `toAnthropicRequest` replays.
  if (res.blocks?.length) {
    for (const b of res.blocks) {
      if (b.type === "thinking") content.push({ type: "thinking", thinking: b.text, thinkingSignature: b.raw } as any);
      else if (b.type === "text") content.push({ type: "text", text: b.text, textSignature: b.raw } as any);
      else content.push({ type: "toolCall", id: b.call.id, name: b.call.name, arguments: (b.call.arguments ?? {}) as Record<string, unknown>, thoughtSignature: b.raw } as any);
    }
  } else if (res.reasoningItems?.length) {
    // Reasoning to replay (the Responses API's items) is one thinking block per item, its item in
    // `thinkingSignature`; a trace that is only text is one block with no signature, as it always was.
    for (const r of res.reasoningItems) content.push({ type: "thinking", thinking: r.text, thinkingSignature: r.signature } as any);
  } else if (res.reasoning) content.push({ type: "thinking", thinking: res.reasoning } as any);
  if (!res.blocks?.length) {
    if (res.text) content.push({ type: "text", text: res.text });
    for (const c of res.toolCalls ?? []) {
      content.push({
        type: "toolCall", id: c.id, name: c.name,
        arguments: (c.arguments ?? {}) as Record<string, unknown>,
      } as any);
    }
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
      ...(jobId ? { jobId } : {}),
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
    ...(jobId ? { jobId } : {}),
  };
}

/**
 * The text a failed answer shows a reader: the provider's own refusal when it carries one (`providerError`,
 * set for a refused request by `callQueuedModel`, cf/src/model-request.ts), else its `errorMessage`. The two
 * are apart because the harness's retry check scans `errorMessage` and must never see provider text
 * (src/model/openai-compatible.ts, `ModelRequestRefused`); every reader that shows a failed turn reads this.
 */
export function failureText(m: { errorMessage?: unknown; providerError?: unknown } | undefined): string | undefined {
  if (typeof m?.providerError === "string" && m.providerError) return m.providerError;
  return typeof m?.errorMessage === "string" ? m.errorMessage : undefined;
}

/**
 * The answer for a provider call that threw, where no queue consumer stands between the client and the agent
 * (the bench runners' worker, bench/node-worker.ts). `errorMessage` is the error's own message, at most 300
 * characters, as it always was; a refusal (`ModelRequestRefused`, src/model/openai-compatible.ts) adds its
 * `turnError` as `providerError`, since its `errorMessage` is fixed text that says only the status. Read by
 * shape rather than `instanceof`, so this file does not import the client.
 */
export function failedAnswer(e: unknown, model: { api: string; provider: string; id: string }): AnsweredMessage {
  const err = e as { message?: unknown; permanent?: unknown; turnError?: unknown } | null;
  const answer: AnsweredMessage = errorMessage(String(err?.message ?? e).slice(0, 300), model);
  if (err?.permanent === true && typeof err.turnError === "string") answer.providerError = err.turnError;
  return answer;
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

/** What an input with no text is sent as (`toAnthropicRequest`). */
export const EMPTY_INPUT = "(no text)";

/**
 * A block the model wrote, from the JSON it was kept as, when it is one of `types`; null otherwise (no signature, one
 * from another provider, or not JSON). An empty text block is never sent back: the API refuses one in a request.
 */
function rawBlock(signature: unknown, types: string[]): AnthropicBlock | null {
  if (typeof signature !== "string" || !signature) return null;
  let b: unknown;
  try { b = JSON.parse(signature); } catch { return null; }
  if (!b || typeof b !== "object" || !types.includes(String((b as { type?: unknown }).type))) return null;
  if ((b as { type: string }).type === "text" && !(b as { text?: unknown }).text) return null;
  return b as AnthropicBlock;
}

/** An Anthropic Messages API content block or message, as sent. */
type AnthropicBlock = Record<string, unknown>;
export interface AnthropicMessage { role: "user" | "assistant"; content: AnthropicBlock[] }

/** A cache breakpoint: Anthropic's 5-minute cache, the default and the cheaper write (1.25x input, against 2x for an hour). */
export const CACHE_BREAKPOINT = { type: "ephemeral" } as const;

/**
 * A stored job's context as an Anthropic Messages API request (src/model/anthropic-messages.ts), for `model`, the model
 * the call reaches, with its prompt-cache breakpoints placed.
 *
 * The conversation is `toRequest`'s in Anthropic's form, as pi's own Anthropic provider converts it
 * (`convertMessages`, pi-ai-1 dist/api/anthropic-messages.js): the leading system prompt is the top-level `system`;
 * a tool call is a `tool_use` block of its assistant message and its result a `tool_result` block of the user
 * message after it, consecutive results in one message; images are dropped, as `toRequest` drops them.
 *
 * Two differences from `toRequest`, each forced by the API:
 * - A later system message (version 2) cannot be a message of its own: Anthropic takes `role: "system"` mid-
 *   conversation only for some models, and Haiku is not documented among them. It is sent as a text block,
 *   framed `<system-update>`, at the end of the user message before the next assistant turn (after any tool
 *   results there, which must open their message), which is where pi holds a later system message back to.
 *   The top-level `system` therefore never changes in a conversation, and neither does the cached prefix.
 * - Thinking. An answer from `model` itself carries its thinking blocks back, each whole as `fromResponse`
 *   stored it in `thinkingSignature`, in their place: a tool-use turn with thinking on must send them back.
 *   Another model's thinking, or a block with no signature, is dropped, as pi drops it.
 *
 * Breakpoints (at most four, Anthropic's limit): the last tool, the system prompt, the end of the last user message,
 * and the end of the user message before it. A request is the previous one plus what that call answered and what
 * came after, so the previous request's last breakpoint is this one's second-to-last: an exact hit however many
 * blocks the turn added, where a single moving breakpoint relies on Anthropic's 20-block lookback.
 */
export function toAnthropicRequest(context: JobContext, model: string): {
  system?: AnthropicBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicBlock[];
} {
  const inline = wireVersion(context) === 2;
  const all = context.messages as any[];
  let system: string | undefined = "systemPrompt" in context && context.systemPrompt ? context.systemPrompt : undefined;
  let start = 0;
  // Version 2 writes the prompt as its first message (`jobContext`, src/model/durable-offloaded.ts).
  if (system === undefined && inline && all[0]?.role === "system") { system = String(all[0].content ?? ""); start = 1; }

  const messages: AnthropicMessage[] = [];
  const pending: string[] = [];
  const userBlocks = (): AnthropicBlock[] => {
    const last = messages[messages.length - 1];
    if (last?.role === "user") return last.content;
    const m: AnthropicMessage = { role: "user", content: [] };
    messages.push(m);
    return m.content;
  };
  const flush = () => {
    if (!pending.length) return;
    const blocks = userBlocks();
    for (const t of pending) blocks.push({ type: "text", text: `<system-update>\n${t}\n</system-update>` });
    pending.length = 0;
  };

  for (const m of all.slice(start)) {
    if (m.role === "system") {
      if (!inline) throw new Error("a version 1 model job carries a system message in its conversation");
      if (m.content) pending.push(String(m.content));
      continue;
    }
    if (m.role === "user") {
      // An input with no text (an image alone, which this request does not carry, or only whitespace) still takes its
      // turn: dropped, the request could end on an assistant turn, which is a prefill these models refuse, or be empty.
      const text = textOf(m.content);
      userBlocks().push({ type: "text", text: text.trim() ? text : EMPTY_INPUT });
      continue;
    }
    if (m.role === "toolResult") {
      const blocks = userBlocks();
      // Results open their message, before any text in it (an input that came in while the calls ran): one message,
      // results first, since a user message after the one answering the calls would leave the calls unanswered.
      const at = blocks.findIndex((b) => b.type !== "tool_result");
      const result: AnthropicBlock = { type: "tool_result", tool_use_id: m.toolCallId, content: textOf(m.content) || "(no output)",
        ...(m.isError ? { is_error: true } : {}) };
      if (at < 0) blocks.push(result);
      else blocks.splice(at, 0, result);
      continue;
    }
    // assistant: this model's own answer exactly as it wrote it, every block raw and in order (`readMessage`,
    // src/model/anthropic-messages.ts, keeps each one in its block's signature field); anything else rebuilt.
    flush();
    const own = m.model === model;
    const blocks: AnthropicBlock[] = [];
    for (const c of (m.content ?? []) as any[]) {
      if (c?.type === "thinking") {
        const raw = own ? rawBlock(c.thinkingSignature, ["thinking", "redacted_thinking"]) : null;
        if (raw) blocks.push(raw);
      } else if (c?.type === "text") {
        const raw = own ? rawBlock(c.textSignature, ["text"]) : null;
        if (raw) blocks.push(raw);
        else if (String(c.text ?? "").trim()) blocks.push({ type: "text", text: String(c.text) });
      } else if (c?.type === "toolCall") {
        blocks.push((own ? rawBlock(c.thoughtSignature, ["tool_use"]) : null) ?? { type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
      }
    }
    if (blocks.length) messages.push({ role: "assistant", content: blocks });
  }
  flush();

  const tools = (context.tools ?? []).map((t: any) => ({
    name: t.name, description: t.description, input_schema: t.parameters ?? { type: "object", properties: {} },
  })) as AnthropicBlock[];
  if (tools.length) tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: CACHE_BREAKPOINT };

  // The last two user messages' last blocks. A user message always has one: every path above that makes one adds a block.
  let marked = 0;
  for (let i = messages.length - 1; i >= 0 && marked < 2; i--) {
    const msg = messages[i]!;
    if (msg.role !== "user") continue;
    const last = msg.content.length - 1;
    msg.content[last] = { ...msg.content[last], cache_control: CACHE_BREAKPOINT };
    marked++;
  }

  return {
    ...(system ? { system: [{ type: "text", text: system, cache_control: CACHE_BREAKPOINT }] } : {}),
    messages,
    ...(tools.length ? { tools } : {}),
  };
}
