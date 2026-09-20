import type { Json, OperationStatus } from "../core/types.ts";
import type { CompletedFacts } from "../core/store.ts";

export type { CompletedFacts };

/**
 * The payload of `operation.completed`, built ONCE for both backends.
 *
 * `src/store/sqlite.ts` and `src/store/durable-object.ts` used to spell this
 * object out separately, character for character. Two copies of a payload are
 * not a duplication a reader notices: each one reads as complete, and a field
 * added to the one under test passes while the one production runs on is
 * silently short — and the Durable Object is the one production runs on.
 *
 * The identity fields sit at the TOP LEVEL, beside `operationId`, not inside
 * `result`. `result` is spread only when there is one, and a failure has none,
 * so an identity living in there would vanish on exactly the calls whose
 * identity is worth reading. Worse, its absence would then read as "this call
 * produced nothing" rather than "nobody reported an identity" — two different
 * absences wearing the same shape.
 *
 * Both are spread only when present: a plugin that said nothing produces the
 * payload every existing reader already handles, byte for byte.
 */
export function completedPayload(
  operationId: string,
  status: OperationStatus,
  resultRef: string | null,
  result?: Json,
  facts?: CompletedFacts,
): Json {
  return {
    operationId,
    status,
    resultRef,
    ...(result === undefined ? {} : { result }),
    ...(facts?.callId === undefined ? {} : { callId: facts.callId }),
    ...(facts?.identity === undefined ? {} : { identity: facts.identity }),
    ...(facts?.credentialRef === undefined ? {} : { credentialRef: facts.credentialRef }),
  };
}
