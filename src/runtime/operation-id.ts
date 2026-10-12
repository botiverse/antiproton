/**
 * The operation id a keyed tool call gets, and the key a `run_js` program's calls are made under. Kept in one place
 * because the id is also derived again outside the gateway: the rebuild briefing finds a program's own calls by
 * recomputing their ids (src/runtime/overflow-backstop.ts `programSendCounter`), since the transcript keeps only the
 * program's output, never the calls it made.
 */
import { createHash } from "node:crypto";

/** An operation's id when its call carries an idempotency key: the same key in the same task is the same operation. */
export const keyedOperationId = (tenantId: string, taskId: string, idempotencyKey: string) =>
  `op_${createHash("sha256").update(`${tenantId}|${taskId}|${idempotencyKey}`).digest("hex").slice(0, 20)}`;

/** The idempotency key of a program's `n`th host call (from 0), `toolCallId` being the model's `run_js` call. */
export const programCallKey = (toolCallId: string, n: number) => `${toolCallId}:${n}`;
