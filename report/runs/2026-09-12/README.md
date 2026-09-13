# Run logs, 2026-09-12

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
over-tasks figure, so a run labelled `pass^1 0 %` will also show a line reading
`pass^1 = 0/24 = 0 %`. Same name, different denominator — the report keeps them
in separate columns for exactly this reason.

| file | run | object | result |
|---|---|---|---|
| `tau2-v1-mtyf1jlz.log` | τ², 1 task × 1 trial, first run against the deployment | `bench-v1` | pass^1 0 %, task 0 `out-of-scope` |
| `tau2-v2-mtyfiod0.log` | τ², 8 tasks × 3 trials, same code as v1 | `bench-v2` | pass^1 0 %, 0/24 trials, 23 `out-of-scope` + 1 `transfer` |

**Both of these are a broken measurement, kept because the pair below is only
readable against them.** The agent called no domain tool at all — 258
`tools__search` against 339 calls total, zero `retail__*` — because
`pluginEnabled` reads `defaultForAllAgents` and treats absence as *no*, and the
τ² `retail` plugin is built at runtime and did not declare it, so `enabledMounts`
filtered the mount out of the catalogue. The model was offered three
`tools` meta-tools and spent every turn looking for a tool it could not be given.
The regression arrived with `a58832b` ("A plugin says whether every agent gets
it"), whose diff does not include `cf/src/bench.ts`.

These runs were taken from driver `2fe3c94` (`dirty: false`) against build
`2fe3c94`, and are the last before the fix. The record for v2 is the one that
made the cause findable: it prints `performed: (nothing by that name)` on every
failure, which says the agent never reached the domain rather than reached it
and chose wrongly.
