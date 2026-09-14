/**
 * A session's pi entries as the Agents API's items and turns (task #17).
 *
 * A turn is everything from one user message to the next: pi runs one prompt
 * to its end, so that is the unit whose status, timestamps and usage the SDK
 * asks about. Items are what happened inside it, in order. The projection is a
 * view over the entries, like the console's (pi-view.ts), so ids are derived
 * from entry sequence numbers and stay the same on every read — which is what
 * lets `after` cursors walk a list that is still growing.
 */

type Json = Record<string, unknown>;

/**
 * The custom entry written right after a turn is cancelled. pi's abort ends the
 * run and drops its model call but appends nothing (measured 2026-09-14), so
 * without this a cancelled turn reads as a prompt never picked up. Custom
 * entries are not projected into the model's context.
 */
export const TURN_CANCELLED = "agents_api.turn_cancelled";
type TurnStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled";

export interface ApiTurn {
  id: string; object: "agent.session.turn"; agent_id: string; session_id: string; subagent_id: null;
  status: TurnStatus; created_at: number; started_at: number | null; completed_at: number | null;
  error: { code: "server_error"; message: string } | null;
  usage: {
    input_tokens: number; input_tokens_details: { cached_tokens: number };
    output_tokens: number; output_tokens_details: { reasoning_tokens: number }; total_tokens: number;
  } | null;
}
export type ApiItem = Json & { id: string; type: string; turn_id: string };

const seconds = (ms: number) => Math.floor(ms / 1000);

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((c: any) => c?.type === "text").map((c: any) => String(c.text ?? "")).join("");
};

/** Stop reasons after which pi does not continue the turn on its own. */
const FINAL = new Set(["stop", "length", "error", "aborted"]);

export function sessionTranscript(
  source: { entries: unknown[]; running: boolean },
  ids: { sessionId: string; agentId: string },
): { items: ApiItem[]; turns: ApiTurn[] } {
  // A cancel marker rides along as a pseudo-message so it lands in the turn it ends.
  const messages = source.entries
    .filter((e: any) => (e?.type === "message" && e.message) || (e?.type === "custom" && e.customType === TURN_CANCELLED))
    .map((e: any) => ({ seq: Number(e.seq), at: Number(e.timestamp), m: (e.type === "custom" ? { role: "cancelled" } : e.message) as any }));

  // Group into turns at each user message; anything before the first is not a turn.
  const groups: Array<typeof messages> = [];
  for (const x of messages) {
    if (x.m.role === "user") groups.push([x]);
    else groups[groups.length - 1]?.push(x);
  }

  const items: ApiItem[] = [];
  const turns: ApiTurn[] = [];
  const answered = new Set(messages.filter((x) => x.m.role === "toolResult").map((x) => String(x.m.toolCallId)));

  groups.forEach((group, gi) => {
    const first = group[0]!;
    const turnId = `turn_${first.seq}`;
    const last = gi === groups.length - 1;
    const replies = group.filter((x) => x.m.role === "assistant" && x.m.stopReason !== "deferred");
    const final = replies[replies.length - 1];
    const cancelled = group.some((x) => x.m.role === "cancelled");
    const ended = cancelled || (!!final && FINAL.has(String(final.m.stopReason)) && !(last && source.running));

    let status: TurnStatus;
    if (cancelled || final?.m.stopReason === "aborted") status = "cancelled";
    else if (ended) status = final!.m.stopReason === "error" ? "failed" : "completed";
    else status = source.running || replies.length ? "in_progress" : "queued";

    let input = 0, output = 0, cached = 0, reasoning = 0;
    for (const r of replies) {
      const u = r.m.usage;
      if (!u) continue;
      input += Number(u.input ?? 0); output += Number(u.output ?? 0);
      cached += Number(u.cacheRead ?? 0); reasoning += Number(u.reasoning ?? 0);
    }
    const hasUsage = replies.some((r) => r.m.usage);

    turns.push({
      id: turnId, object: "agent.session.turn", agent_id: ids.agentId, session_id: ids.sessionId, subagent_id: null,
      status, created_at: seconds(first.at), started_at: status === "queued" ? null : seconds(first.at),
      completed_at: ended ? seconds(group[group.length - 1]!.at) : null,
      error: status === "failed" ? { code: "server_error", message: String(final!.m.errorMessage ?? "the model call failed") } : null,
      usage: hasUsage
        ? {
            input_tokens: input, input_tokens_details: { cached_tokens: cached },
            output_tokens: output, output_tokens_details: { reasoning_tokens: reasoning }, total_tokens: input + output,
          }
        : null,
    });

    for (const { seq, m } of group) {
      if (m.role === "user") {
        items.push({ id: `item_${seq}`, type: "message", role: "user", phase: null, status: "completed", turn_id: turnId,
          content: [{ type: "input_text", text: textOf(m.content) }] });
        continue;
      }
      if (m.role === "toolResult") {
        const text = textOf(m.content);
        items.push({ id: `item_${seq}`, type: "function_call_output", call_id: String(m.toolCallId), turn_id: turnId,
          status: m.isError ? "failed" : "completed", output: m.isError ? null : text, error: m.isError ? text : null });
        continue;
      }
      if (m.role !== "assistant" || m.stopReason === "deferred" || m.stopReason === "error") continue;
      const parts: any[] = Array.isArray(m.content) ? m.content : [];
      const thinking = parts.filter((c) => c?.type === "thinking").map((c) => String(c.thinking ?? "")).join("\n");
      const calls = parts.filter((c) => c?.type === "toolCall");
      const text = textOf(parts);
      if (thinking) {
        items.push({ id: `item_${seq}_r`, type: "reasoning", status: "completed", turn_id: turnId,
          summary: [{ type: "summary_text", text: thinking }] });
      }
      if (text) {
        items.push({ id: `item_${seq}_m`, type: "message", role: "assistant", status: "completed", turn_id: turnId,
          phase: calls.length ? "commentary" : "final_answer", content: [{ type: "output_text", text }] });
      }
      calls.forEach((c, i) => {
        const callId = String(c.id);
        items.push({ id: `item_${seq}_c${i}`, type: "function_call", call_id: callId, name: String(c.name), turn_id: turnId,
          arguments: JSON.stringify(c.arguments ?? {}),
          status: answered.has(callId) ? "completed" : ended ? "incomplete" : "in_progress" });
      });
    }
  });

  return { items, turns };
}
