/**
 * The chat fragment, with the held cards beside the turns when asked for.
 *
 * The console used to fetch the conversation and the held calls as two polls
 * on the same cadence, the second never answering 304 (measured: every 2 s,
 * always a 200). The conversation's version now counts held calls and their
 * decisions, so one fragment can carry both and still go quiet when nothing
 * moves. The wrapper keeps the id the decide buttons target, so a decision
 * redraws the cards in place and the next poll redraws everything.
 *
 * Opt-in by the page (`?held=1`, or `held=1` in the message form): the panel
 * that still polls the two routes separately keeps working until it switches.
 */
import type { ApprovalRecord } from "../../src/core/types.ts";
import { approvals } from "./ui.ts";

export function chatPanel(turns: string, held: ApprovalRecord[] | null): string {
  return held === null ? turns : `${turns}<div class="held" id="approvals">${approvals(held)}</div>`;
}
