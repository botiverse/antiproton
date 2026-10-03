# Metering model calls

What a model call costs, where that cost is recorded, and how the record is
checked. This is the contract for the `pd` engine (pi-durable). pi 0.85
(`pi085`) still meters at commit, from its own `pi_usage` rows
(`src/store/pi-storage.ts`); the one thing it shares is the model name the
consumer stamps on an answer (below).

## The contract

1. **The metering boundary is the cost event: the provider answered.** A model
   call is metered when its answer is delivered to the agent's object, not when
   the agent reads that answer.
2. **Attribution is decided separately.** A paid call whose answer is refused,
   or arrives for a job we no longer have (a duplicate caused by our bug, or a
   lapsed take), is recorded with a verdict marker. It is neither dropped nor
   billed as tenant usage. Who pays for it is a pricing decision, not a
   metering one.
3. **Reconciliation uses two independent sources**: the sum of the usage of the
   answers the agent consumed, and pi-durable's own `pi.usage` documents. A
   drift between them is the invariant that is checked.

## The unit: one delivery attempt

Every pd model call is an `ap_model_jobs` job, taken by one queue attempt and
answered by `deliver` (`PdHost.deliver`, `src/runtime/durable-agent.ts`): a
turn's generation, a retried attempt, an overflow's retry and a compaction's
summary alike. The only call site that spends money is the queue consumer's
provider call (`OpenAiCompatibleModel.complete`, called from `modelQueueDeps` in
`cf/src/index.ts`), and every one of its answers reaches `deliver`.

So the unit is **one delivery attempt**, which is one paid call. `deliver`
writes the answer's `model.tokens` rows in the same transaction that decides
what happens to the answer, so a row exists exactly when the delivery was
recorded. Each row's `at` is the delivery's time, not the time a later commit
read the answer.

Each attempt is named by its taker, the fresh id the consumer takes the job
under (`withTake`, `cf/src/model-queue.ts`). The taker travels with the answer
(`deliverAnswer`), and `ap_deliveries` remembers each `(job, taker)` it has
metered for a day, so a replayed RPC for the same attempt returns the first
verdict and meters nothing.

The row names the model that was **actually called**. The consumer calls the
operator's model when the binding spends the operator's account and the
deployment's model otherwise, and it stamps that model on the answer, so the
ledger, the transcript and `pi.usage` all name it.

pi085 shares the consumer, and meters an answer under the model its entry
names (`#modelOf`, `src/store/pi-storage.ts`), so its key moves too, in one
narrow case: whenever the model called (`operatorModel ?? HARNESS_MODEL`)
differs from the model the job asked for. That happens when the binding's
model is changed or the binding removed while the call was queued, or when a
legacy binding does not use the operator's secret. pi085 then meters the
answer under the model called rather than the one the job asked for. When the
two agree, which is every binding left unchanged while its calls run, nothing
changes.

## Verdicts

| delivery | what it is | how it is recorded |
|---|---|---|
| accepted | the job's first answer, stored on its row | `model.tokens`: tenant usage. This includes an answer to a job that was already cancelled (the turn was cancelled, the model changed, the run was aborted, faulted or orphaned): the tenant's act ended the turn, and the call was paid for it. |
| refused | the job already has an answer: a second attempt for one job | `model.tokens.unaccepted` |
| unknown job | no row for the job id on a pd object | `model.tokens.unaccepted`, then `UnknownJob` as before |

`model.tokens.unaccepted` is the verdict marker. It is a resource of its own,
with the same keys (`<model>:<kind>`) and unit (`tokens`) as `model.tokens`, so
that:

- the tenant's usage endpoints (`readUsage` and `readAgentLedger`,
  `cf/src/usage-d1.ts`) leave it out with one predicate, and the `/ui/usage`
  tiles, which draw only the resources they list, never show it;
- no tenant price applies to it: a price is matched by its exact resource
  (`priceFor`), so neither a `model.tokens` price nor its `*` reaches it;
- it still travels the same outbox and the same D1 tables, so it is in
  `usage_hourly` beside the tenant's rows, visible to the operator as our cost.

An answer with no nonzero counter writes no row in either resource (a
given-up job's error answer, for one).

## Reconciliation: the drift check

`/admin/diagnose` reports `usageDrift` for a pd object (`pdUsageDrift`,
`src/runtime/pd-outbox.ts`): per `provider/model` key and per counter, the sum
of the usage on the answers of **consumed** jobs, minus the sum of every
conversation's `pi.usage` `models` bucket. Both are read with plain SQL on the
object, on demand, and nothing is written. On a healthy object every difference
is zero.

Its cost is on demand only, and grows with the object's age: SQLite reads the
usage out of every consumed job's stored answer (`json_extract`, no parse in
JavaScript), and nothing prunes `ap_model_jobs`. Nothing runs it on a
schedule.

What it compares and what it leaves out, on purpose:

- **Unaccepted deliveries** are never on a job's row, so they are in neither
  side.
- **Accepted answers that were never consumed** (the job was cancelled before
  a commit read the answer) are tenant usage but never reach `pi.usage`, so
  only consumed jobs are summed.
- **Tool-reported usage** is in `pi.usage`'s `tools` bucket and is not
  compared: see below.

A nonzero difference therefore means one of the two sources has something the
other does not: an answer that reached `pi.usage` without a consumed job (a
commit that appended an answer to a cancelled job), a `pi.usage` document that
is no longer stored, an answer metered under a name `pi.usage` does not use, or
a writer of `pi.usage` that is not a delivered answer.

## Tool-reported usage is not money we pay

A tool result may carry usage (`appendToolResult` in pi-durable's
`harness/tool.js` adds it to `pi.usage`'s `tools` bucket). That is what the
tool said it spent: a mirror of someone else's figure, not a call we paid a
provider for. The pd engine does not meter it. pi085 still writes it as
`model.tokens` rows under the model `unknown` (`#modelOf` in
`src/store/pi-storage.ts`), as a mirror; that is left as it is.

## What is known not to be metered

- **A call cut off at its deadline** (`MODEL_CALL_DEADLINE_MS`): the provider
  may have spent tokens, but no answer and no usage come back.
- **A 200 response that does not parse**: the call was paid, and the consumer
  has no usage to report.
- **A `deliverAnswer` RPC that fails before the object commits, and is
  retried**: the retry is a new attempt with a new taker and a second paid
  call, and at most one of the two answers is seen.
- **An answer for a job deleted by a revert to pi085**: the object is a pi085
  object by then, and pi085 meters at commit, so a delivery it cannot place is
  not metered there.
