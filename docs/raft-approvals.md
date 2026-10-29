# Approvals for Raft-hosted agents

This is the contract between antiproton and Raft for held calls of agents that Raft provisioned
(raft-agent-provider.v1). A Raft implementer should be able to build Raft's side from this page alone.

Decided 2026-10-29 (#raft-antiproton):

- Raft shows each held call to the person who decides, as an existing Raft action card in that person's DM.
- A click calls Raft's server. Raft's server checks who clicked, then decides through antiproton.
- A hold that nobody decides within the TTL (24 hours by default) is denied as `expired`.
- The agent is told every outcome.

## The flow

1. **The call is held.** The agent calls a tool that its mount's policy holds, or it asks for a person itself
   (`confirm: true`). Antiproton records a hold with an `operationId` and a deadline, `expiresAt`. The model is
   answered `pending` at once and its turn goes on. That answer tells it:
   - that Raft sends its owner a card;
   - when the hold expires;
   - that it will be woken with the outcome;
   - the operation id and the tool to refer to it by.

   An identical call made while the hold is pending returns the same hold. It does not create a second one.
2. **Raft is told.** Antiproton writes the hold to its provider-wide copy. If hints are configured, it also sends
   Raft a signed hint, `approval.requested`. The hint carries ids only.
3. **The card is posted.** Raft fetches the hold with its provider token (`GET …/approvals`), finds who may
   decide, and posts the action card to that person's DM.
4. **The person decides.** Raft's server checks that the clicking user may decide for this agent, then calls
   `POST …/approvals/{operationId}/decide`.
5. **The decision is recorded.** Antiproton records it once and answers at once:
   - on deny, the hold is `denied` and nothing runs;
   - on approve, the hold is `approved`.

   Antiproton then sends the hint `approval.decided`.
6. **An approved call runs.** The agent's own object runs it in its next alarm pass, exactly as recorded. It
   first reads the mount's current policy: a `deny` set since the hold was made wins. The run ends the hold
   `executed` or `failed`, and antiproton sends `approval.executed` or `approval.failed`.
7. **The agent is told.** Once a hold has ended (denied, executed, failed or expired), the agent is woken with a
   notice of the outcome.
8. **Undecided holds expire.** If no decision arrives by `expiresAt`, antiproton denies the hold as `expired`,
   wakes the agent and sends `approval.expired`.
9. **Raft keeps its cards current.** Raft updates or retires the card after every hint. It also runs a periodic
   reconcile (`GET /provision/approvals?updatedSince=…`), so a lost hint never leaves a card stale.

## Authentication and trust

Every route below is under `/provision` and takes the provider token as `Authorization: Bearer <token>`. These
are the same tokens and the same check as every other raft-agent-provider.v1 route (`cf/src/index.ts`
`provision`). Nothing new is issued for approvals.

### The provider token

- **What it is.** A token is `pt-` followed by 32 random bytes, base64url. Antiproton stores only its SHA-256.
  When the token is minted it is bound to one Raft origin (`raftOrigin`) and to a scope:
  - `tenant`: the token is one tenant, and requests never name a tenant.
  - `platform`: one token for a whole Raft deployment. The tenant is derived from the Raft server, so per-agent
    routes need `?raftServerId=<server>`.
- **What Raft uses.** Raft uses a **platform-scoped** token for these routes.
- **Where Raft keeps it.** Raft keeps the token in its server-side secret configuration, together with the hint
  HMAC secret below.
  - The token is never passed to, through or into any agent. That includes an agent's `sk_agent` credential, its
    environment and its messages.
  - An agent cannot read it.
- **How Raft gets it.** The antiproton operator issues it with `POST /admin/provider-tokens`, using the operator's
  header and giving `label`, `scope: "platform"` and `raftOrigin`. The plaintext appears in that answer only. The
  operator hands it to Raft out of band.
- **Rotation.**
  1. Issue a new token.
  2. Switch Raft to it.
  3. Revoke the old one with `DELETE /admin/provider-tokens`, giving the old token's hash.

  Both tokens work in between. A revoked token answers `401` at once.

### Scope

A per-agent route answers only for an agent whose provisioning record matches **both** of these:

- the token's tenant (for a platform token, the tenant derived from `?raftServerId=`);
- the token's Raft origin.

A token minted for another Raft origin that names this server's id is answered `404`, exactly as for an agent
that does not exist. The provider-wide list is scoped the same way.

### The trust anchor for decisions

The trust anchor is the provider: antiproton trusts a decision because it arrives with the provider token, and
for no other reason. `decidedBy` is a **claim relayed by the provider**.

- **What antiproton does.** It records `decidedBy` on the hold exactly as sent and audit-logs it
  (`provision.approval_decide`, with the token's hash). It does **not** verify the person independently, because
  Raft re-checks the approver server-side on every decision (see "Who may decide").
- **What that means.** Anyone holding the provider token can decide, within its scope, as any user. Keep the token
  as secret as that allows.
- **Why there is no owner check.** The provisioning request does not carry the agent's Raft owner, so antiproton
  has no owner of its own to compare `raftUserId` with, and it does not invent one.
- **Follow-up.** Raft signs a decider assertion over
  `{operationId, providerAgentId, decision, raftUserId, role, iat, jti}`. Antiproton verifies it, records the
  `jti` once, and keeps the assertion. With that, antiproton could answer "who approved this?" from its own data.

### Errors common to all three routes

| Status | Code | When |
|---|---|---|
| `401` | `unauthorized` | There is no token, it is malformed, it is unknown, or it was revoked. |
| `422` | `missing` (`param: raftServerId`) | A platform token was sent on a per-agent route without `?raftServerId=`. |
| `404` | `not_found` | One of these: the agent is not this token's tenant's; it was made at another Raft origin; it was deleted. All answer the same, so "not yours" and "does not exist" look alike. |

An agent is addressed by its antiproton id (`raft_<raftAgentId>`, returned as `providerAgentId` when it was
created) or by Raft's own id, as `/provision/agents/by-raft-agent/{raftAgentId}/…`.

## The approval item

All three read routes answer items in this shape. Antiproton builds every field. Raft displays them and never
needs the raw arguments.

```json
{
  "operationId": "op_3e84183cd11f4a3dbb31",
  "providerAgentId": "raft_01JAPPROVE",
  "raftAgentId": "01JAPPROVE",
  "raftServerId": "srv-1",
  "status": "pending",
  "mount": "gh",
  "plugin": "github",
  "tool": "create_pull_request",
  "service": null,
  "action": null,
  "args": { "summary": "repo: botiverse/antiproton\ntitle: fix the parser\nbody: …", "truncated": false, "redactions": 0, "withheld": false },
  "outcome": null,
  "heldBy": "policy",
  "policyKey": null,
  "route": null,
  "description": "Approving runs gh.create_pull_request once, exactly as shown, with this agent's gh mount; denying runs nothing. Either way the agent is told. Undecided at 2026-10-30T06:20:00.000Z, it is denied as expired.",
  "createdAt": "2026-10-29T06:20:00.000Z",
  "expiresAt": "2026-10-30T06:20:00.000Z",
  "decidedAt": null,
  "decidedBy": null
}
```

| Field | Meaning |
|---|---|
| `operationId` | The hold's id, and what `decide` takes. It is unique within the agent. |
| `providerAgentId`, `raftAgentId`, `raftServerId` | The agent, in antiproton's ids and in Raft's, from the provisioning record. |
| `status` | One of the states below. |
| `mount`, `plugin`, `tool` | The mount alias the call goes through, the plugin behind that mount (`null` if the mount was removed since), and the tool. |
| `service`, `action` | The plugin's own service and action, when the call names them (Raft Agent Login's `invoke`); otherwise `null`. |
| `args.summary` | What is being approved, display-ready. A bridged request is `METHOD path (repo #pr)` and its body. Any other call is one `name: value` line per field: at most 12 fields, each value at most 200 characters, the whole at most 800. |
| `args.redactions` | How many credential-looking values were replaced with `<redacted:KIND>`. This is the transcript exports' redaction, using the agent's own sealed values and the known credential shapes. |
| `args.truncated` | The summary was cut. |
| `args.withheld` | The agent's sealed values could not be opened. The summary is empty and `route` is `null`: nothing is shown rather than something unredacted. |
| `outcome` | Once an approved call's run has ended (`executed` or `failed`): `{summary, truncated, redactions, withheld}`, the run's result or error, redacted and bounded like `args`. Otherwise `null`. The full result goes to the agent only. |
| `heldBy` | `policy`: the mount's policy holds this tool. `agent`: the agent asked for a person itself. |
| `policyKey` | For a bridged call, the second policy name the call was decided under, or `null`. |
| `route` | For a bridged request: `method`, `path`, `repo` and `pr` when known, `contentType`, and `body`, redacted and cut at the card limit (with `bodyTruncated` and `bodySize`). Otherwise `null`. |
| `description` | One line built by antiproton. For a pending hold it says what approving does and when the hold expires; after that, what happened. |
| `createdAt`, `expiresAt`, `decidedAt` | ISO 8601. `expiresAt` is `null` only if the deployment turned expiry off. |
| `decidedBy` | `null` while pending. Then one of: `{ "via": "raft", "raftUserId", "role" }`; `{ "via": "console", "approver" }` for a decision on the antiproton console; or `{ "via": "expiry" }`. |

### States

| `status` | Meaning | Final |
|---|---|---|
| `pending` | Waiting for a decision. | no |
| `approved` | Approved; the call has not finished running yet (the card says "approved, executing"). | no |
| `executed` | Approved, and the run succeeded (or went to the background). | yes |
| `failed` | Approved, but the run did not succeed. That includes a mount whose current policy now denies the call (`policy_denied`, in `outcome`). | yes |
| `denied` | Denied. Nothing ran. | yes |
| `expired` | Nobody decided by `expiresAt`. Nothing ran. | yes |

An `approved` hold never expires. Its decision was in time, and only its run is still to happen.

## Endpoints

### `GET /provision/agents/{agentId}/approvals`

This lists one agent's holds, oldest first, read from the agent's own object, which is the source of truth.

- Before answering, the route expires any pending hold past its deadline. A hold listed as `pending` can therefore
  still be decided.
- `?status=pending|approved|executed|failed|denied|expired` narrows the list. With no `status`, or `any`, every
  state is listed.
- A platform token also sends `?raftServerId=`.

`200`:

```json
{ "providerAgentId": "raft_01JAPPROVE", "raftAgentId": "01JAPPROVE", "approvals": [ /* items */ ] }
```

An unknown status is `400 invalid` (`param: status`).

### `POST /provision/agents/{agentId}/approvals/{operationId}/decide`

The request body:

```json
{ "decision": "approve", "decidedBy": { "raftUserId": "u_123", "role": "agent_owner" } }
```

- `decision` is `approve` or `deny`.
- `decidedBy.raftUserId` is the Raft user who clicked (`[A-Za-z0-9._:-]{1,64}`).
- `decidedBy.role` is the grounds on which Raft let that user decide. It must be one of:
  - `agent_owner`: the agent's creator;
  - `server_owner`: only when the agent's owner has left the server;
  - `server_admin`: only when the agent's owner has left the server.

  Any other value, including the old `owner`, is `400 invalid_role` (`param: decidedBy.role`). Nothing is
  decided.
- Any other field, at either level, is `422`.

The answer comes **as soon as the decision is recorded**, without waiting for an approved call to run:

| Status | Body | When |
|---|---|---|
| `200` | `{ "approval": item, "replay": false }`, item `status: "approved"` | Approved now. The call runs in the agent's next alarm pass, normally within seconds. Follow it through the hints or the list: `approved` becomes `executed` or `failed`. |
| `200` | `{ "approval": item, "replay": false }`, item `status: "denied"` | Denied now. Nothing runs. |
| `200` | `{ "approval": item, "replay": true }` | The hold already has this decision. An approval counts as the same decision while it runs and after (`approved`, `executed`, `failed`). The item shows the current status and the first `decidedBy`. Nothing runs again. |
| `409` | `{ "error": { "code": "approval_already_decided", "message", "decision": "approved", "status": "executed", "decidedBy": {…}, "decidedAt": "…" }, "approval": item }` | The hold was already decided the other way. `decision` is what was decided; `status` is where the hold is now. |
| `409` | `{ "error": { "code": "approval_expired", "message", "decision": "expired", "status": "expired", "decidedBy": { "via": "expiry" }, "decidedAt": "…" }, "approval": item }` | The hold expired. A decision on a hold past its deadline expires it then and there, even before the sweep has run, so a late click never runs the call. |
| `404` | `{ "error": { "code": "approval_not_found" } }` | This agent holds no call with that id. That includes another agent's hold in the same tenant. |
| `400` | `{ "error": { "code": "invalid_role", "param": "decidedBy.role" } }` | The role is not one of the three above. |
| `422` | `{ "error": { "code": "invalid" \| "missing", "param" } }` | The body is not the shape above. |

**Idempotency.** Decisions travel from Raft to antiproton with the provider token, and they are idempotent per
operation id. Deciding is one atomic step in the agent's object.

- One approval runs the call at most once. Its run is claimed durably (`run_at`) before it starts. A run that was
  claimed but never ended, because the object stopped during it, is never started again: 15 minutes after the
  claim it is ended `failed`, outcome "not known".
- If a request times out, retry the same decision. The retry answers `replay: true` with the recorded outcome.
- If two people decide at once, one wins. The other gets `replay` if they made the same decision, or
  `409 approval_already_decided` if they made the opposite one, and either way sees who decided first.

### `GET /provision/approvals`

This lists every hold of the provider's agents from antiproton's provider-wide copy (D1 `provider_approvals`).
This is the reconcile. Rows come oldest change first.

- **Who sees what.**
  - A platform token sees every tenant's holds for agents made at its origin, which is every server of that Raft
    deployment. `?raftServerId=` narrows it to one server.
  - A tenant token sees its own tenant only, at its origin.
  - No token sees holds of agents made at another origin, or the holds of a deleted agent.
- **Filters and paging.**
  - `?status=` works as on the per-agent route. With no `status`, every state is listed, which is what a
    reconcile wants.
  - `?updatedSince=` is an ISO 8601 time or milliseconds since the epoch. It returns rows whose last change is at
    or after that time.
  - `?limit=` is 1 to 200 (default 50).
  - `?cursor=` takes the `nextCursor` of the previous page, unchanged.

`200`:

```json
{ "approvals": [ { /* item */, "updatedAt": "2026-10-29T06:21:00.000Z" } ], "nextCursor": "eyJ1Ijo…" }
```

**How to page.**

- `nextCursor` is `null` on the last page.
- A row that changes while you page moves to the end of the order, so a later page still returns it.
- To reconcile, keep the largest `updatedAt` seen, and next time ask with `updatedSince` a little before it.
- Rows are idempotent by `operationId`.

**How current the copy is.**

- The copy only moves forward: pending, then approved, then a final state.
- It can lag the agent by one alarm pass, normally seconds, and by longer while D1 is unreachable. The per-agent
  route is always current.
- When an agent is deleted, its rows are no longer listed, but they are kept as the record of who decided what for
  it: ids, status, tool, route (method, path, repository), outcome, `decidedBy` and timestamps, without the
  arguments' text (`args`, a bridged request's body), which stays in the agent's own object. A decision or expiry
  that lands after the delete still reaches the kept row. They are dropped a year after the delete.
- A live agent's row in a final state is dropped 30 days after its last change.

## How Raft learns of changes: a signed hint, then a pull

Antiproton pushes a **hint**, and Raft **pulls** the details with its token. Hints carry only ids, so a hint is
safe to replay: the worst a replayed or forged hint can do is cause a pull. Raft never trusts a hint's body for
anything except deciding what to fetch.

Antiproton had no outbound channel to Raft as a provider. Its only calls to Raft use each agent's own `sk_agent`
credential, through the agent's `raft` mount. This contract adds one.

- **Where it goes.** To the agent's own `raftOrigin` (from its provisioning record) plus antiproton's
  `RAFT_APPROVAL_CALLBACK_PATH`, for example `/api/integrations/antiproton/approvals`.
  - The origin is never configured separately, so a hint about one Raft's agents cannot go anywhere else.
  - If either `RAFT_APPROVAL_CALLBACK_PATH` or `RAFT_APPROVAL_CALLBACK_SECRET` is unset, no hints are sent, and
    Raft relies on the reconcile alone.
- **When it is sent.** After every change of a hold's state, whichever path made the change: this API, the
  antiproton console, the run, or expiry.

  | `type` | Sent when |
  |---|---|
  | `approval.requested` | a new hold |
  | `approval.decided` | approved or denied |
  | `approval.executed` | an approved call's run succeeded |
  | `approval.failed` | an approved call's run failed |
  | `approval.expired` | the hold expired |

  A decision is published before its run starts. Raft therefore normally sees `approval.decided` (`approved`)
  and then `approval.executed` or `approval.failed`.
- **The request.** `POST`, `content-type: application/json`, with this body:

  ```json
  { "type": "approval.requested", "operationId": "op_…", "providerAgentId": "raft_…", "raftAgentId": "…", "raftServerId": "…", "status": "pending" }
  ```

  And these headers:

  | Header | Value |
  |---|---|
  | `X-Antiproton-Timestamp` | Unix seconds |
  | `X-Antiproton-Signature-256` | `sha256=` followed by the lowercase hex of HMAC-SHA256(secret, `"<timestamp>.<body>"`) |
  | `X-Antiproton-Delivery-Id` | a fresh UUID for each attempt |

- **Verification on Raft's side.**
  1. Read the raw body bytes.
  2. Reject the hint if the timestamp is more than **300 seconds** from Raft's clock, either way.
  3. Compute the HMAC over `timestamp + "." + body` with the shared secret.
  4. Compare it with the hex after `sha256=`, in constant time.
  5. Answer `401` on any mismatch.
  6. Otherwise answer `2xx` quickly. Then fetch with `GET /provision/agents/{providerAgentId}/approvals`, adding
     `?raftServerId=` because the token is platform-scoped. Create, update or retire the card from the item's
     `status`.

  `cf/src/approvals.ts` `verifyHint` is the same check as code.
- **The secret.** `RAFT_APPROVAL_CALLBACK_SECRET` is a Worker secret on antiproton's side. Raft keeps the same
  value in its server-side secret configuration, next to the provider token. To rotate it, set the new value on
  both sides. Hints signed with the old value fail in between, and the reconcile recovers them.
- **Retries.** A hint not answered `2xx` within 5 seconds is retried by the agent's alarm after 30 s, then 1, 2, 4
  and 8 minutes: six attempts in all.
  - After the sixth it is dropped, and a log line `approval.hint_given_up` is written.
  - Dropping it loses nothing: the provider-wide copy is written before the hint is sent, so the reconcile finds
    the change.
  - A failed hint never delays, blocks or changes the hold, the decision, the run, or the agent's notice.

## What the Raft action card shows

Build the card from the item, never from raw arguments.

**While the hold is pending:**

- the agent: its Raft name, looked up by `raftAgentId`;
- the call: `service` and `action` when both are set, otherwise `mount`.`tool`, with `plugin` as context;
- the main arguments: `args.summary` verbatim, in a monospace block. Add "(truncated)" when `args.truncated` is
  set, and say "arguments withheld" when `args.withheld` is set;
- for a bridged call, `route.method`, `route.path` and `route.repo`/`route.pr`. The summary already contains them;
- what approving does: `description` verbatim;
- the expiry: `expiresAt`, as a local time and as "expires in N h";
- whether the agent itself asked for a person (`heldBy: "agent"`) or a policy held the call;
- two actions, **Approve** and **Deny**.

**After a decision:** replace the actions with the state.

- `approved`: "approved, executing".
- `executed`: "approved, executed", with `outcome.summary`.
- `failed`: "approved, failed", with `outcome.summary`.
- `denied` or `expired`: that state.

In every case also show who decided (from `decidedBy`) and when (`decidedAt`).

## Who may decide (Raft's job)

- The agent's **Raft owner**, its creator, decides. Use `role: "agent_owner"`.
- If the owner has left the server, the server's **owner** or its **admins** decide. Use
  `role: "server_owner"` or `"server_admin"`. Raft posts the card to them, and only in that case.
- Raft's server re-checks the clicking user on **every** decision, at the moment of the click. It does not rely
  on the card having been posted to that user. Only then does it call `decide`, with that user in `decidedBy`.
- Antiproton does not see Raft's membership and does not re-check it. See "The trust anchor for decisions".

## Expiry

- **The deadline.** Every hold gets `expiresAt = createdAt + TTL`. The TTL is written with the hold, in the same
  transaction.
  - The default TTL is 24 hours. It assumes an owner checks Raft about once a day.
  - Change it with antiproton's `APPROVAL_TTL_HOURS`. A change applies to new holds; an existing hold keeps its
    deadline.
- **At the deadline.** The agent's alarm is armed for the soonest deadline, so an idle agent's hold still expires
  on time. When it fires:
  - a pending hold becomes `expired`, which is a state of its own, not `denied`;
  - the operation ends `rejected` with code `approval_expired`, and nothing runs;
  - the agent is woken and told;
  - the hint `approval.expired` is sent.
- **Only pending holds expire.** An `approved` hold whose run has not finished is not expired.
- **Late decisions.** Deciding a hold that is past its deadline expires it first, and so does reading it through
  the per-agent route. An expired hold can never be approved, even between the deadline and the alarm.
- **Identical calls.** An identical call made while a hold is pending returns that hold, unless the hold is past
  its deadline. In that case the call gets a new hold.
- **Holds from before this change.** Pending holds that existed before this change were given
  `expiresAt = createdAt + 24 h` when the agent's object next opened. On an object that does not open again, such
  a hold expires at the object's next wake: a message, a push, or a provider read of its approvals.

## What the agent is told

**When the call is held**, the pending answer says the following, with the deadline given as an ISO time:

> This call is held for approval (operation op_…). An approval card for it goes to your owner in Raft (or a server
> admin if your owner has left), and they approve or deny it there; if approved, it runs on its own exactly as
> written. If nobody decides by … (24 hours after it was held), it expires and is not run. You will be woken with
> the outcome in a notice: executed (with its result), failed, denied, expired, or policy_denied (approved, but the
> mount's policy now refuses it); your turn does not wait for it. If you tell your owner about it, give the
> operation id (op_…) and the tool (gh.create_pull_request). Do not retry it. Calling this tool again with the same
> arguments while it waits returns this same pending approval; it does not create another.

The hours are the deployment's TTL. A call identical to one already pending is told it was merged into that hold,
and gets that hold's deadline.

The structured fields carry `expires`, the deadline in milliseconds since the epoch.

**When the hold ends**, whether denied, executed, failed or expired, the agent is told with a message at its next
step, in the conversation that made the call, the way a background job's ending is posted.

- A held call made by a subagent is told to the main conversation.
- The agent never polls.
- **When.** A denial is told at the pass that its decision starts, and an expiry at the pass that records it. An
  approval is told when its run ends, with the result; that is normally the pass the decision starts. The
  15-minute window under "Idempotency" applies only to a run that was claimed and never ended. It does not delay
  a run that ends.
- Each notice is posted once. That is recorded on the hold itself (`told_at`), and set at the moment of posting.
  Text the agent wrote earlier cannot suppress it.

Approved and run:

```
[approval op_… — gh.create_pull_request — approved by your owner in Raft and run: succeeded; a notice from the harness, not a message from the user]
{"number":1234,"url":"…"}
```

- The result is cut at 1,500 characters.
- A failed run gives its error code and message instead.
- A call refused because the mount now denies it reads "approved by …, but not run: rejected", followed by
  `policy_denied: …`.
- A run that went to the background says so, and its result arrives in the job's own notice.

Denied:

```
[approval op_… — gh.create_pull_request — denied by a Raft server admin; a notice from the harness, not a message from the user]
Nothing was run. Do not call it again unless the person asks you to.
```

Expired:

```
[approval op_… — gh.create_pull_request — expired; a notice from the harness, not a message from the user]
Nobody decided within 24 hours, so it was denied as expired and nothing was run. If it still matters you may call it again, which asks for a new approval.
```

The decider is named by role: "your owner in Raft", "the Raft server's owner" or "a Raft server admin". A
decision made on the antiproton console is named by its console sign-in. Raft user ids are never shown to the
agent.

## Failure modes

| What fails | What happens |
|---|---|
| A hint is lost, or Raft is down | Six retries over about 15 minutes, then the hint is dropped. The reconcile finds the change. The hold is unaffected. |
| D1 is unreachable when the copy is written | That change, and its hint, are retried with the same backoff, every 15 minutes at most, until D1 answers. The per-agent route stays correct. |
| Raft's `decide` call times out | The decision may have landed. Retry the same decision: the answer is `replay` with the current status. |
| Two people decide at once | One wins. The other gets `replay` (same decision) or `409 approval_already_decided` with the first decision and who made it. |
| A click arrives after the deadline | `409 approval_expired`. Nothing runs. Retire the card. |
| The owner switches the mount to `deny` after the hold | The approved call is not run. The hold ends `failed` with `policy_denied` in `outcome`, and the agent is told. |
| The object stops while an approved call runs | The run is never started again. 15 minutes after it was claimed, the hold ends `failed` with outcome "not known", and the agent is told to check before calling it again. |
| The agent's sealed values cannot be opened | `args.withheld: true` with an empty summary, and likewise for `outcome`. The hold can still be decided. |
| The agent is deleted | Its holds are no longer listed (`404`, and left out of the provider-wide list; the copy keeps them as a record for a year). No more hints are sent for it. Raft retires its cards with the agent. |
| A hold from before this change, on an idle object | It expires at the object's next wake rather than exactly at the deadline. |

## Follow-ups (not in this version)

- **A signed decider assertion from Raft.** See "The trust anchor for decisions".
- **A hint secret per Raft origin, with two-key rotation.** Today every origin shares one
  `RAFT_APPROVAL_CALLBACK_SECRET`, and the hint body does not name its destination. A forged hint can therefore
  cause a pull at another origin that shares the secret. This is low impact: a pull only reads.
- **The length of the result excerpt in the approved notice.** It is up to 1,500 characters of the tool's own
  result inside harness-framed text. Whether to shorten it, or to frame it differently, is still open.

## Where it lives

- `cf/src/provision/handlers.ts`: the three routes.
- `cf/src/approvals.ts`: the item, the D1 copy and its retention, the hint and its signature.
- `cf/src/index.ts` (`AgentDO`):
  - `provisionApprovals`;
  - `provisionDecide`;
  - publishing from the alarm, before and after the step.
- `src/runtime/gateway.ts`:
  - `heldMessage`;
  - `applyApproval` (`run: "later"` for this API, `"now"` for the console);
  - `runApproved`, `settleApproved`;
  - `expireApproval`, `expireDue`.
- `cf/src/runtime.ts`: `#approvalPass` (it expires, runs and tells) and `#tellApprovals`.
- `src/runtime/approval-notice.ts`: the notice text and the run's outcome.
- `src/store/approvals-schema.ts`: the columns and their migration.
- `cf/migrations/0028_provider_approvals.sql`: the provider-wide copy.
- `cf/migrations/0029_provider_approvals_audit.sql`: a deleted agent's rows kept as a record, and the prunes' indexes.
- `test/raft-approvals.ts`, `test/held-result.ts`: the tests.
