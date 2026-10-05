/**
 * What one τ² retail episode is, for every on-object runner: the customer the simulator plays, how its reply
 * ends the conversation, and the database the annotated solution leaves behind.
 *
 * Two runners drive the same episode against the deployment — bench/tau2/cf.ts over the `/bench` routes and
 * bench/tau2/api.ts over the public Agents API — and the comparison between them is only a comparison of
 * runners if everything else is the same code. A copy of the simulator's prompt in each would be a second
 * place for the customer to change, which is how the two graders drifted before bench/tau2/grade.ts.
 */
import { createHash } from "node:crypto";
import { applyRetailAction, WRITE_TOOLS, type RetailDB } from "./retail.ts";
import { canonJson as canon } from "./grade.ts";

/**
 * How the user simulator is called; written into every record so a series can be split where it changed.
 *
 * The simulator plays a customer from a script, and two things went wrong in turn. Thinking at the
 * provider's default effort, a 2000 cap was a budget for the trace and the reply together, and three rounds
 * in three days the trace spent it all and the reply came back empty. Thinking off, the reply always came,
 * but a script with a condition in it ("if the agent asks for confirmation, only exchange the desk lamp")
 * was never applied: the simulator repeated "keep everything on hold" verbatim until the turn limit
 * (2026-09-25 18:53Z, task 6), and at that point a replay with any reasoning at all decided the lamp, three
 * times out of three. So the script needs a little judgement, and the cap needs to be one a little judgement
 * cannot exhaust: low effort, and four times the reply's budget. The record carries the condition, since
 * rounds before it were run each of the other two ways.
 */
export const SIM = { maxTokens: 8192, reasoning: "low" } as const;

/** The agent's first line, which the customer answers first. */
export const OPENING = "Hi! How can I help you today?";

/**
 * How much of the simulator's last reply a row keeps (`simLast`): verbatim, so a failed row can be re-decided
 * without the object's transcript, and capped so a runaway reply cannot bloat the record; scripted lines are
 * far under it.
 */
export const SIM_LAST_MAX = 1000;

/** How many customer turns a conversation may take before it ends as `max_turns`. */
export const MAX_TURNS = 14;

/** The simulator's system message: the guidelines, then this task's scenario. */
export function simSystem(task: any, guidelines: string): string {
  const instr = task.user_scenario?.instructions ?? {};
  const scenario = [
    instr.task_instructions && `Style: ${instr.task_instructions}`,
    instr.reason_for_call && `Why you are contacting support: ${instr.reason_for_call}`,
    instr.known_info && `What you know: ${instr.known_info}`,
    instr.unknown_info && `What you do NOT know: ${instr.unknown_info}`,
  ].filter(Boolean).join("\n");
  return `${guidelines}\n\n# Your scenario\n${scenario}`;
}

/**
 * How the simulator's reply ends the conversation, or null when it goes on.
 *
 * Empty is the simulator, not the agent, running out of words: a reasoning model that spends its budget
 * before the reply returns empty content (twice on 2026-09-22). Posting "" asked the object a question it
 * refused, and the refusal was filed as a stall of the agent. Named for whose turn it was.
 */
export function simEnding(reply: { text: string; finishReason?: string }): string | null {
  const stop = /###(STOP|TRANSFER|OUT-OF-SCOPE)###/.exec(reply.text);
  if (stop) return stop[1]!.toLowerCase();
  if (reply.text.trim() === "") return `sim_empty (${reply.finishReason})`;
  return null;
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * The database the annotated solution leaves behind, hashed the same way the object hashes its own — the
 * comparison is a hash because the database is 2.8 MB and no part of it needs to travel.
 */
export function gold(task: any, base: RetailDB): { hash: string; expected: Array<{ name: string; args: any }> } {
  const db = structuredClone(base);
  const applied: Array<{ name: string; args: any }> = [];
  for (const a of task.evaluation_criteria?.actions ?? []) {
    if (!WRITE_TOOLS.has(a.name)) continue;
    applyRetailAction(db, a.name, a.arguments);
    applied.push({ name: a.name, args: a.arguments });
  }
  return { hash: sha256(canon(db)), expected: applied };
}
