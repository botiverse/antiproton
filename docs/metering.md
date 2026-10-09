# Metering model calls

What a model call costs, where that cost is recorded, and how the record is
checked; and, for every resource the ledger counts, what it is priced at, who
paid for it, and how long its hours are kept (the last three sections). This is the contract for the `pd` engine (pi-durable). pi 0.85
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

## Prices

**One credit is one US dollar.** `usage_prices.credits_per_unit`
(`cf/migrations/0005_usage.sql`) is dollars per unit, and every reader shows it
as an estimated dollar amount. This is accounting only: nothing is charged,
limited or refused because of it.

The first prices are seeded by `cf/migrations/0016_usage_prices_seed.sql`, all
effective from 2026-10-09T00:00:00Z; usage before that reads as unpriced. Every
row is **rough, to be refined**, and the migration names each one's source. A
better number is a new row with a later `effective_from`, never an edit of an
old one, because cost is worked out when read.

| resource | key | unit | $ per unit | source |
|---|---|---|---|---|
| `model.tokens` | `deepseek-flash:input` | tokens | 0.30 / 1M | DeepSeek's pricing page, cache miss, peak rate (off-peak is half) |
| | `deepseek-flash:cache_read` | tokens | (0.006 − 0.30) / 1M | cache hit $0.006/1M, as a difference (below) |
| | `deepseek-flash:output` | tokens | 1.20 / 1M | DeepSeek, peak |
| | `openai/gpt-5.6-luna:input` | tokens | 0.20 / 1M | third-party aggregators after OpenAI's August 2026 cut; to verify |
| | `openai/gpt-5.6-luna:output` | tokens | 1.20 / 1M | the same; to verify |
| | `openai/gpt-5.6-luna:cache_read` | tokens | 0 extra | unknown, priced as input |
| | `…:reasoning`, `…:cache_write`, `…:cache_write_1h` | tokens | 0 extra | already inside output / input / cache_write |
| `model.tokens.unaccepted` | the same keys | tokens | the same | our cost; never in a tenant's view |
| `object.active` | `*` | ms | 0.0000000015625 | Cloudflare Durable Objects, $12.50 per 1M GB-s at 128 MB |
| `sandbox.container` | `*` | seconds | 0.00004 | an estimate: run9 publishes no prices |
| | `*` | execs, unreadable | 0 | in the seconds; a marker, not usage |
| `tool.call` | `exa.search` | calls | 0.007 | Exa's per-search rate; to verify |
| | `exa.search` | failed, ms | 0 extra | in the call |

Anything else — other tools, `js.run`, a model not in the table — is
unpriced: its cost reads `null`, and the views say what they left out rather
than counting it as free.

**A subset is priced at its difference.** The ledger keeps three keys that
are part of another one: `reasoning` of `output`, `cache_write_1h` of
`cache_write`, and — because the clients put the provider's whole prompt into
`input` (`usageOf` in `src/model/pi-bridge.ts`; `prompt_tokens` and
`input_tokens` both count cache hits) — `cache_read` of `input`. A per-row
`price × quantity` sum is right only if each subset row carries the difference
between its rate and its parent's, so `cache_read` for DeepSeek is negative:
`input × miss + cache_read × (hit − miss)` is `(input − cache_read) × miss +
cache_read × hit`. Each subset has an explicit row, so no `*` can price one at
full rate, and `model.tokens` has no `*` at all.

Where cost is shown:

- **The console's usage view** (`/ui/usage`, `cf/src/usage.ts`): "≈$" amounts,
  "estimated cost … at rough prices", a "$ (estimated)" column.
- **`/v1/agents/{id}/usage`** and its provider binding: every row gains a `cost`
  (docs/agent-surface.md). Rows there are split so no kind contains another
  except `input`, so each row's cost is its kind's whole rate, and `input`'s is
  for its uncached part; the costs add up to the ledger's.
- **`GET /admin/usage-costs?from=&to=&bucket=day|month`**
  (`cf/src/admin-usage-costs.ts`), the operator's: every tenant's cost by
  period and resource, `model.tokens.unaccepted` included, with the keys each
  total leaves out unpriced. The `x-harness-token` header must equal
  `AUTOMATION_TOKEN`, and with no token configured it refuses everyone.

## Who pays

Usage the tenant paid for with **their own credential** is still their usage —
it is counted, in the same resource, and every view totals it — but it is
never priced: its key starts with `own:` (`OWN_KEY_PREFIX`,
`src/usage/outbox.ts`), and `priceFor` returns 0 for such a key whatever the
table holds, so a `*` meant for our account cannot reach it.

- **A container** on a sandbox mount whose credential is the agent's own
  sealed one (`secretRefKind` "agent") is `sandbox.container` / `own:sandbox`;
  the operator's (`operator:run9`) stays `sandbox`.
- **A tool call** through a mount holding the agent's own key is
  `tool.call` / `own:<plugin>.<tool>` — an Exa search on the tenant's own key
  is `own:exa.search` and costs 0; the seeded `search` mount on
  `operator:exa` is `exa.search` and is priced. This also renames the calls
  of a GitHub mount with the person's own token (`own:github.…`): those were
  unpriced before and are 0 now.
- **A model call has no own-credential case.** Every call is a queued job made
  on the operator's account (`callQueuedModel`); an agent bound to a
  credential of its own is called on the deployment's default model with the
  operator's key (`takeJob`, `cf/src/runtime.ts`). So all `model.tokens` are
  ours to pay and are priced.

## Retention

A daily Cron Trigger (`17 3 * * *`, `triggers.crons` in `cf/wrangler.jsonc`
and the preview's) runs the Worker's `scheduled` handler, which folds whole
days of `usage_hourly` older than `KEEP_HOURLY_DAYS` (35) into `usage_daily`
and deletes the hours it folded, in one batch per day (`retainUsage` and
`foldUsage`, `cf/src/usage-d1.ts`). A second run finds nothing to move. Every
reader sums both tables, so a total — quantity or cost — does not change when
a day is folded. The hours are kept for 35 days rather than fewer because the
views promise hourly buckets that far back: a folded day would sit in an
hourly bucket at 00:00Z as if it had happened at midnight.
