# Run logs, 2026-09-10

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
over-tasks figure, so a run labelled `pass^1 75 %` will also show a line reading
`pass^1 = 19/24 = 79.2 %`. Same name, different denominator — the report keeps
them in separate columns for exactly this reason.

| file | run | object | result |
|---|---|---|---|
| `tau2-run-C-verado1.log` | τ² run C | `bench-verado1` | pass^1 62.5 %, failures in tasks 2, 5, 6, 7 |
| `tau2-run-D-veratools1.log` | τ² run D | `bench-veratools1` | pass^1 75 %, task 2 failing on the grader bug since fixed in `c7aa888` |
| `tau2-run-E-verafixed1.log` | τ² run E | `bench-verafixed1` | pass^1 87.5 %, fixed grader, zero ordering-artifact failures |
| `swebench-bench-swe2.log` | SWE-bench | `bench-swe2` | 9/10, ten instances, inside the deployed object |

These are the terminal logs, not the per-task transcripts. The transcripts for
each τ² run are archived in the object itself and read back through
`/bench/trajectory`; while the read path on `master` still expects the prefixed
form, pass the listing's `agent_id` **without** its `b_` prefix (the fix that
accepts either form is on `tau2-fidelity`).

Run A, the 08:25Z matrix, is deliberately absent: it ran in process, before the
on-object runner existed, so it is not part of any on-object comparison.
