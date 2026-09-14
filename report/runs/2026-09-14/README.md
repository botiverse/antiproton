# Run logs, 2026-09-14

The raw console output of the runs whose results the status report publishes.
They are here because the report's evidence column says so, and a claim of
evidence should be checkable by someone who was not present.

Each file names the object it ran against in its first three lines. They are
the runner's own stdout, byte-for-byte: the ANSI colour codes the runner emits
are still in them; nothing has been stripped or reformatted. No credentials
appear in any of them.

**Each τ² log prints two lines both called `pass^1`, and they are not the same
number:** one is over *tasks* (a task passing the first trial, out of 8), the
other over *trials* (out of 24). The table below and the report page use the
over-tasks figure, so a run labelled `pass^1 87.5 %` will also show a line reading
`pass^1 = 19/24 = 79.2 %`. Same name, different denominator — the report keeps
them in separate columns for exactly this reason.

| file | run | object | result |
|---|---|---|---|
| `tau2-20260914-poll-0927-mu1aqf0n.log` | τ², 8 tasks × 3 trials | `bench-20260914-poll-0927` | pass^1 87.5 %, pass^2 75.0 %, pass^3 62.5 %, 19/24 trials |

**This run was taken on the `poll` channel, not the default `push` one, and that
is part of the reading rather than a footnote to it.** The runner defaults to
`push` (`WAIT` unset), which opens a WebSocket to `/bench/events`. Every such
socket carried no `x-harness-token`, and `a98026c` had made that route require
one, so the upgrade was refused; a refused upgrade reaches the client as close
code 1006 with an empty reason, and the runner turned the missing answer into
`agent_stalled` at `bench/tau2/run.ts:143`. Every task in a `push` run therefore
ended at 0 turns and ~303 s.

The `poll` channel reads the same object over plain HTTP, which does carry the
token, so it was unaffected. This run is the day's only reading of the agent for
that reason: it measures the agent, where a `push` run of the same day would have
measured the transport. `wait` is recorded in the JSON beside it.

cody fixed the transport the same day (`#309`, `866f7ae`, runner-only and so not
deployed). The fix is verified with a control on a single already-started task —
without the header the socket closes `1006`, with it the socket opens — and by a
default-channel run that passed at 4 turns / 83 s where the pre-fix channel gave
0 turns / 303 s. Those verification runs are not published runs and live in
`evidence/bench/`.
