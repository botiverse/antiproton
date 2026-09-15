# Run logs, 2026-09-15

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
over-tasks figure, so a run labelled `pass^1 100 %` will also show a line reading
`pass^1 = 23/24 = 95.8 %`. Same name, different denominator — the report keeps
them in separate columns for exactly this reason.

| file | run | object | result |
|---|---|---|---|
| `tau2-20260914-push-2053-mu1z3jc2.log` | τ², 8 tasks × 3 trials | `bench-20260914-push-2053` | pass^1 100 %, pass^2 100 %, pass^3 87.5 %, 23/24 trials |

**This run took the default `push` channel, and that is the point of it.** The
previous day's record (`../2026-09-14/`) had to use `poll`, because every
WebSocket the runner opened carried no `x-harness-token` after `a98026c` made
`/bench/events` require one: the upgrade was refused, a refused upgrade reaches
the client as close code 1006 with an empty reason, and the runner turned the
missing answer into `agent_stalled` (`bench/tau2/run.ts:143`). Every task in such
a run ended at 0 turns and ~303 s.

cody's `#309` (`866f7ae`, runner-only and so not deployed) sends the token on both
runners' sockets. This run is the first full suite on the restored channel, and
it is also the fix's verification at full load rather than at N=1:
**`agent_stalled` appears zero times here**, where the same channel produced it on
every task before the fix.

**The object is named `...-push-2053` because it ran on 2026-09-14 by the
triggering six-hourly task and completed after UTC midnight**, which is when the
runner dates a record. Whether these two readings belong together by trigger day
or apart by the runner's own dating is Dora's call; nothing has been moved.

**One tool call errored and its task passed anyway** (task 6, trial 1,
`toolErrors: 1`, `reward: 1`), so it is a recovered error rather than a failure.
Recorded here because the previous run had none, and an unexplained 0-versus-1 in
that column invites the next reader to assume one of them was missed.
