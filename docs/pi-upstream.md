# Staying in sync with pi

pi is pre-1.0 and moves. We depend on it in three ways that fail *differently*
on an upgrade, and only the first one fails loudly. This file exists so the
other two are not discovered in production.

Upstream: [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi),
MIT, © 2025 Mario Zechner.

## The pin is exact, on purpose

`package.json` pins `0.85.1`, not `^0.85.1`. A caret on a `0.x` package still
allows every patch release, and a patch can change any of the behavioural
contracts below — none of which TypeScript would catch, because none of them is
expressed in a type.

Check for movement with `npm view @earendil-works/pi-agent-core version`.

## What we depend on

### 1. Imported symbols — these break loudly

The authoritative list is a command, not a table, because a table rots:

```bash
grep -rhoE 'from "@earendil-works/[^"]+"' src cf/src test bench --include='*.ts' | sort -u
```

At the time of writing that is four entry points: the package root
(`AgentHarness`, `LaneBusy`), `harness/session` (`StorageBackedSession`),
`harness/context` (`BACKGROUND_CONTEXT`), `harness/session/testing`
(`createStorageConformance`, tests only), plus `@earendil-works/pi-ai` for the
provider contract (`createProvider`, `createAssistantMessageEventStream`) and
the faux provider in tests.

### 2. Copied source — this breaks silently

| what | from | where it lives here |
|---|---|---|
| `emptyUsage`, `addUsage` | `harness/utils/usage.js` | `src/store/pi-storage.ts` |
| scan, cursor and stop-order semantics | `harness/session/in-memory-storage-state.js` | `src/store/pi-storage.ts` |

The usage arithmetic is copied because pi's export map does not publish it. The
scan semantics are re-implemented against a reference we can read; pi's own
conformance suite is what keeps them honest, which is the whole reason we run
upstream's suite rather than ours.

**Re-diff both on every upgrade.** They will not fail to compile.

### 3. Behavioural contracts — these break silently and worst

Nothing imports these. Nothing types them. Everything rests on them:

- `drive()` returns `waiting` rather than blocking when a response carries
  `stopReason: "deferred"`. If it ever awaited instead, the object would be
  billed for the provider's latency and the cost model would be gone.
- A `fetchDeferred` that is not ready answers by returning **the same handle**.
- The inbox (`steer` / `followUp` / `nextRun`) drains at `accept()`, not on a
  timer and not on `drive()`.
- `AgentHarness.create` starts no provider, tool, hook or timer work, and
  reports operations left open by the previous process in `open[]`. This is our
  entire crash-recovery mechanism; there is no sweeper any more.
- `Storage.commit` is all-or-nothing across entries, values, lists and usage.

Each has a test. That is deliberate: an upgrade that quietly changes one of
these should fail here, not on a tenant.

## Where we deliberately differ from pi

These are not bugs and must survive an upgrade:

| divergence | why | pinned by |
|---|---|---|
| the provider has **no non-deferred path** | Cloudflare bills Durable Objects for wall clock with no exemption for network I/O; a completion is ~94% waiting | `test/pi-offload.ts` |
| `step()` polls only when an answer already exists | pi records what the provider says, and "not ready" is something it said — correct for a batch API, but our provider is a table in the same object, so asking costs a transcript row for nothing | `test/pi-agent.ts` |
| a `steer` on an idle lane **starts a run** | pi keeps the three gestures separate because its front end is a TUI that knows the lane's state; an HTTP request does not, and the page sends every message as a steer | `test/pi-agent.ts` |

If an upgrade makes one of these unnecessary, delete it deliberately and strike
the row — do not leave it as a divergence nobody can explain.

## Changing upstream files

Prefer not to. If it is necessary, it is allowed, but:

- **Never edit `node_modules` in place.** It is not tracked; the change vanishes
  on the next install and takes the reason with it.
- Vendor the patched file under `src/vendor/pi/`, mirroring its upstream path,
  with a header naming the upstream path, the version it was taken from, and
  what was changed and why.
- Record it in the table below and in `NOTICE` — MIT requires the notice, and a
  modified file has to say it was modified.
- Open the issue or PR upstream and link it here, so the patch has an end rather
  than becoming a fork by accident.

| vendored file | upstream path | taken from | why | upstream link |
|---|---|---|---|---|
| *(none yet)* | | | | |

## Upgrading

In order. Each step gates the next; the point is that the cheap checks run
before the expensive one.

1. Read what changed: the export maps, and the `.d.ts` of the four entry points
   we import.
2. Bump the pin to an exact version.
3. `npm run pi-storage` and `npm run pi-storage:do` — pi's own 21 conformance
   cases, on node:sqlite and on real Durable Object storage. This is the canary
   for the `Storage` contract, and it is upstream's suite rather than ours.
4. `npm run pi-loop`, `pi-offload`, `pi-tools`, `pi-agent`, `pi-bridge` — the
   behavioural contracts and every divergence above.
5. Re-diff the copied source in the table in §2.
6. The remaining suites.
7. **SWE-bench before deploying.** Every contract above can hold while the agent
   simply gets worse, and nothing in §1–3 would notice.

## Credit

`NOTICE` records copied source; the README's *What was taken from elsewhere*
records design borrowings. Keep them apart and keep them true — a wrong credit
is as bad as a missing one.
