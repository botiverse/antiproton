/**
 * pi's transcript, in the shape the console already renders.
 *
 * The console reads an event log: `{ sequence, kind, payload }`, with kinds
 * like `message` and `model.response`. pi keeps entries instead — a message
 * per row, with tool calls inside the assistant message and tool results as
 * their own rows. Rather than rewrite six panels, the entries are projected
 * into the shape the panels already know, which also keeps one honest
 * property: the projection is a view, so nothing about it can be load-bearing.
 *
 * The mapping is not one-to-one and the interesting case is why. An assistant
 * turn that both says something and calls a tool was two events before (a
 * `model.response` and a `tool.call`) and is one entry now. It is projected as
 * one `model.response` carrying its tool calls, because that is what actually
 * happened — the split was an artefact of the old loop emitting commands.
 */
import type { Entry } from "@earendil-works/pi-agent-core/harness/session";

export interface ViewEvent {
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("");
};

const thinkingOf = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => c?.type === "thinking")
    .map((c: any) => String(c.thinking ?? "")).join("\n");
};

export function entriesToEvents(entries: Entry[]): ViewEvent[] {
  const out: ViewEvent[] = [];
  for (const e of entries) {
    if (e.type === "compaction") {
      out.push({
        sequence: e.seq, kind: "compaction",
        payload: { summary: e.summary, tokensBefore: e.tokensBefore, at: e.timestamp },
      });
      continue;
    }
    // A reset starts the model's context over at this entry, and nothing else in the transcript says so: the entries
    // before it are all still here. Its handoff, when one was given, is the first thing the model reads. Only pd writes
    // one (src/runtime/pd-transcript.ts). Other custom entries stay out: the only one written today is the Agents API's
    // cancel marker, which pi 0.85 writes too, and its console has never shown it (test/pd-transcript.ts pins that).
    if (e.type === "custom" && (e as { customType?: string }).customType === "pi.reset") {
      const handoff = ((e as { data?: unknown }).data as { handoff?: unknown } | undefined)?.handoff;
      out.push({ sequence: e.seq, kind: "reset", payload: { ...(typeof handoff === "string" ? { handoff } : {}), at: e.timestamp } });
      continue;
    }
    if (e.type !== "message") continue;
    const m: any = (e as any).message;

    if (m.role === "user") {
      out.push({ sequence: e.seq, kind: "message", payload: { text: textOf(m.content), at: e.timestamp } });
      continue;
    }

    if (m.role === "toolResult") {
      // run_js is a tool here, but the console has a panel for it, so it keeps
      // its own kind rather than being flattened into every other call.
      const kind = m.toolName === "run_js" ? "js.result" : "tool.result";
      out.push({
        sequence: e.seq, kind,
        payload: {
          tool: m.toolName, callId: m.toolCallId, isError: !!m.isError,
          status: m.isError ? "rejected" : "succeeded",
          ...(kind === "js.result"
            ? { outputs: safeJson(textOf(m.content)) }
            : { result: safeJson(textOf(m.content)) }),
          at: e.timestamp,
        },
      });
      continue;
    }

    if (m.role === "assistant") {
      if (m.stopReason === "error") {
        out.push({
          sequence: e.seq, kind: "model.failed",
          payload: { error: m.errorMessage ?? "the model call failed", at: e.timestamp },
        });
        continue;
      }
      // A response still on its way carries no content worth showing.
      if (m.stopReason === "deferred") continue;
      const calls = (m.content ?? []).filter((c: any) => c?.type === "toolCall")
        .map((c: any) => ({ id: c.id, name: c.name, arguments: c.arguments }));
      out.push({
        sequence: e.seq, kind: "model.response",
        payload: {
          text: textOf(m.content),
          ...(thinkingOf(m.content) ? { reasoning: thinkingOf(m.content) } : {}),
          ...(calls.length ? { toolCalls: calls } : {}),
          usage: m.usage
            ? {
                promptTokens: m.usage.input, completionTokens: m.usage.output,
                cachedPromptTokens: m.usage.cacheRead, reasoningTokens: m.usage.reasoning ?? 0,
              }
            : undefined,
          finishReason: m.stopReason,
          at: e.timestamp,
        },
      });
    }
  }
  return out;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return text; }
}
