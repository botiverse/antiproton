# Metering model calls

What a model call costs, where that cost is recorded, and how the record is
checked; and, for every resource the ledger counts, what it is priced at, who
paid for it, what a day of it may cost before model calls are refused, and how
long its hours are kept (the last four sections). This is the contract for the `pd` engine (pi-durable). pi 0.85
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
as an estimated dollar amount. Nothing is charged because of it; what is
refused because of it is said in "Daily limits" below.

The first prices are seeded by `cf/migrations/0016_usage_prices_seed.sql`, all
effective from 2026-10-09T00:00:00Z; usage before that reads as unpriced. Later
migrations add rows with later dates (`0017_luna_cache_read_price.sql`). Every
row is **rough, to be refined**, and the migration names each one's source. A
better number is a new row with a later `effective_from`, never an edit of an
old one, because cost is worked out when read.

| resource | key | unit | $ per unit | source |
|---|---|---|---|---|
| `model.tokens` | `deepseek-flash:input` | tokens | 0.30 / 1M | DeepSeek's pricing page, cache miss, peak rate (off-peak is half) |
| | `deepseek-flash:cache_read` | tokens | (0.006 − 0.30) / 1M | cache hit $0.006/1M, as a difference (below) |
| | `deepseek-flash:output` | tokens | 1.20 / 1M | DeepSeek, peak |
| | `openai/gpt-5.6-luna:input` | tokens | 0.20 / 1M | OpenAI's pricing page, Standard, ≤272K context (checked 2026-10-11, `0017`) |
| | `openai/gpt-5.6-luna:output` | tokens | 1.20 / 1M | the same |
| | `openai/gpt-5.6-luna:cache_read` | tokens | (0.02 − 0.20) / 1M from 2026-10-12T00:00Z; 0 extra before | OpenAI, cached input $0.02/1M (`cf/migrations/0017_luna_cache_read_price.sql`); before it, priced as input |
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
  total leaves out unpriced. Two callers may read it, as `/admin/spend-limits`:
  a script whose `x-harness-token` header equals `AUTOMATION_TOKEN` (with no
  token configured, no script passes), and a signed-in admin (`isAdmin`,
  `ADMIN_IDENTITIES`), on the admin host (`ADMIN_ORIGIN`,
  `cf/src/admin-host.ts`) or the console's. Someone signed in who is not an
  admin gets 404, as there; with no identity at all the console's host answers
  401 and the admin host sends the browser to sign in. Read-only: any other
  method is 405.
- **`GET /provision/usage?from=&to=&bucket=day|month`**
  (`cf/src/provision/usage.ts`), the tenant's own, for Raft's panel: the same
  periods and resources for the provider token's tenant only, without
  `model.tokens.unaccepted` (`readTenantCosts`, `cf/src/usage-d1.ts`, which
  prices through the one fold `readUsageCosts` uses), each agent's total, and
  today against the daily limit below (docs/agent-surface.md, "The tenant's
  spend").

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

## Daily limits

Three limits per UTC day, in US dollars at the prices above (`cf/src/spend-limit.ts`,
`cf/migrations/0018_spend_limits.sql`, `cf/migrations/0021_onboarding_budget_and_plans.sql`):

| limit | default | set by | counts |
|---|---|---|---|
| per tenant, `free` plan or none | $3 | `DAILY_LIMIT_USD`; an admin's override per tenant (`/admin/spend-limits`) wins | the tenant's own agents' priced usage today, `model.tokens.unaccepted` left out (it is ours, not theirs) |
| per tenant, `pro` plan | $10 | `PRO_DAILY_LIMIT_USD`; an admin's override per tenant wins | as above |
| platform | $2000 | `PLATFORM_DAILY_LIMIT_USD` | every tenant's own agents' priced usage today, `model.tokens.unaccepted` and exempt tenants included |
| onboarding | $30 | `ONBOARDING_DAILY_LIMIT_USD`; an admin's override (`/admin/spend-limits`, `pool: "onboarding"`) wins | the priced usage today of every agent created with `budget: "onboarding"`, in any tenant, `model.tokens.unaccepted` included |

**A tenant's plan** is what Raft last said of its server (`plan` on `POST
/provision/agents`, `PUT /provision/servers/{raftServerId}/plan`; docs/agent-surface.md),
kept in `tenant_plans`; a tenant Raft never gave a plan is `free`. An admin's
override of the tenant beats either plan's default. Antiproton never asks Raft.

**The onboarding pool is separate from both others.** An agent created with
`budget: "onboarding"` (the hosted onboarding agent; `provisioned_agents.budget`,
fixed at creation) is paid by the platform: its spend is in neither its tenant's
figure nor the platform total, and its calls are judged by the onboarding limit
alone — not refused because its tenant or the platform is out of money, and
unable to spend the platform's budget either way. Every other agent (no
provisioned row, or `budget` absent) is its tenant's. There is no ceiling over
both pools: the most the operator pays in a day is the platform limit plus the
onboarding limit (plus the overshoot below, and exempt tenants). An onboarding
agent in an exempt tenant is not refused either; its spend still counts toward
the onboarding total.

Each var set to `off` is no limit; a value that is not a number at or above 0
is logged (`spend_limit.bad_config`) and read as the default, so a typo does not
lift a cap. No deployment sets any of them (`cf/wrangler.jsonc` has none, and
production has no such secret), so the defaults above are the live figures. A tenant in `DAILY_LIMIT_EXEMPT_TENANTS` (comma-separated; unset is
`bench`) is refused by neither limit but still counts toward the platform total.
No tenant is exempt by being the operator's: the code has no such marker (the
original `demo` tenant also holds invited people), so an operator's tenant is
exempted by naming it in the var.

**What is counted is what the ledger prices**, so what costs us money: model
tokens on the operator's provider accounts, object time, operator-paid
containers, and operator-paid tool calls (Exa). A key paid with the tenant's own
credential (`own:`, "Who pays" above) is priced 0 and counts nothing toward
either limit; an unpriced key counts nothing, as in every view. So spend on an
unpriced key — a model with no price row, which an admin's model choice can
name — is not limited at all; each unpriced key a reading meets is logged as
`spend_limit.unpriced`, once per key per isolate per UTC day, so a missing price
row is visible.

**Where it is checked.** In the queue consumer (`runModelCall`,
`cf/src/model-queue.ts`), after the job is taken and before the provider is
called. Every model call of both engines — a main conversation's turn, a
sub-session's or background job's, a retry, a compaction's summary — is a queued
job answered there ("The unit" above), so this is the one place. A given-up job
(the dead letter queue) calls no provider and is not asked.

**A refused call** is answered, not thrown: the job's answer is a failed turn
whose `errorMessage` is the fixed `usage limit reached (out of budget); see the
turn's error` and whose `providerError` — what the transcript, the console and the
Agents API show (`failureText`) — is:

- `Daily usage limit reached ($X of $Y); resets at 00:00 UTC.`, or
- `Platform daily usage limit reached; resets at 00:00 UTC.` (asked first: when
  it is reached no call of a tenant's own agents is made), or
- `Onboarding daily usage limit reached; resets at 00:00 UTC.`, for an
  onboarding agent, which is asked nothing else.

An agent Raft runs tells Raft the same sentence: the failed call's `model.call`
trace row carries it (`attrs.limit`, `modelCallRow` in `src/trace/seams.ts`), so
the turn's `BridgeFatal` has the `errorClass` `usage_limit_reached: <sentence>`
(Raft's activity log shows it, up to 120 characters) and the agent's `error`
status has the sentence as its `detail` (Raft's dot shows it). Any other failed
call is `model_call_failed` with no detail, as before. The model never reads the
sentence: both engines leave a failed turn out of the next request.

So the queue acks the message and does not retry it; neither engine's harness
retries it (the fixed text matches none of pi-ai's retryable patterns, and "out of
budget" is in its non-retryable ones); and neither pd's compaction nor pi085's
overflow backstop reads it as an overflow, so no rebuild runs and `needs_reset`
is not set. The run that asked ends there with that error. The answer carries no
usage, so nothing is metered for it. At 00:00 UTC the next reading is of a new
day and calls are made again; nobody acts.

**How fresh the reading is.** The consumer's isolate keeps each tenant's last
reading — one D1 round trip of five parallel reads: today's hours of every
tenant with each row's agent's budget, the prices, the tenant's override, the
tenant's plan, the onboarding override — for 30 s (`SPEND_CACHE_MS`), and for
5 s once a total that judges the calling agent is within 80 % of its limit
(`SPEND_CACHE_NEAR_MS`); a reading from an earlier UTC day is never used. An
admin's override, or a plan Raft sends, reaches a running isolate within those
30 s. Which pool an agent is in is read once per agent per isolate (it never
changes), beside the first reading. The ledger itself lags: an object sends its
usage at the end of the alarm pass that a delivered answer wakes, so a call's
tokens are usually in D1 within seconds of the answer.

**The overshoot is bounded by that lag, not by zero.** A call admitted under
the limit is made and paid for even if it crosses it; so is a call admitted on a
reading that does not yet show the crossing. So past the limit a tenant can spend,
per agent, the call in flight when it was crossed, plus any call that agent
starts within the reading's age (at most 5 s near the limit) and the ledger's
flush lag after it. An agent's calls follow one another (each waits for the last
answer and its tools), so that is one call per agent in the usual case, more only
when a flush is slow. Time the tenant keeps using without a model call is not
refused: a running container is not stopped and keeps counting, and so does the
object's own time; a new operator-paid container is not refused either, though no
new tool call reaches one without a model call first. Exempt tenants are never
refused, so the platform total can pass its limit by what they spend.

**A spend read that fails admits the call** (so does a failed read of the
agent's pool) and logs `spend_limit.read_failed`:
availability is worth more than a cap of a few dollars, and the ledger is
unchanged, so the next read that works refuses as it should. A failure is not
kept, so the next call reads again.

**Overrides**, for an admin (`isAdmin`, as `/admin/models`; on the admin host
too):

    GET    /admin/spend-limits                              → { defaults, overrides, events, pools, poolEvents, plans }
    PUT    /admin/spend-limits { tenantId, limitUsd }       → the row; limitUsd null: no per-tenant limit
    DELETE /admin/spend-limits { tenantId }                 → 204, or 404 when there was none
    PUT    /admin/spend-limits { pool: "onboarding", limitUsd } → the pool's row; limitUsd null: no onboarding limit
    DELETE /admin/spend-limits { pool: "onboarding" }       → 204, or 404 when there was none

Every set and clear is kept in `spend_limit_events` (a tenant's) or
`spend_pool_limit_events` (a pool's) with who, when, and the value it replaced.
A tenant with `limitUsd` null is still refused at the platform limit. `plans` is
each tenant's plan as Raft last said it, read only. The admin host's spend-limits
page shows each tenant against its plan's limit with its onboarding agents' spend
beside it, and the onboarding pool against its limit with a form to set or clear
it; `/admin/usage-costs` gives `onboarding.total` and each tenant's `onboarding`
part (already inside its figures), and its page has an "onboarding pool" line.

**Changing the platform and tenant defaults.** They are code defaults, so a
deploy changes them; nothing stored holds the old $30 / $5 (no row in
`spend_limits` or `spend_limit_events` in production, read 2026-10-14). An
admin's per-tenant override, where there is one, is left as it is.

**What a tenant is shown.** `GET /provision/usage` gives a Raft tenant its
`today`: its spend, its limit (`null` when it has none or is exempt), its plan,
its onboarding agents' spend (beside its own, counted against nothing of its
own), whether it is exempt, whether the platform limit is reached, and whether a
call of its own agents would be refused now — `standing` in `cf/src/spend-limit.ts`, over a fresh `readDaySpend`
and the same `judge` the consumer applies, so the two cannot disagree on the rule,
only on the reading's age: the answer is kept 15 s per isolate (`USAGE_CACHE_MS`,
never past its UTC day; windows of at most 62 days, at most 256 answers), the consumer's reading up to 30 s (above), so they can
differ for under a minute. The platform's total and limit are never shown to a
tenant, only the boolean.

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
