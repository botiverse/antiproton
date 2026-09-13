# Run logs, 2026-09-13

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
`pass^1 = 20/24 = 83.3 %`. Same name, different denominator — the report keeps
them in separate columns for exactly this reason.

| file | run | object | result |
|---|---|---|---|
| `tau2-v5-mtz6ecej.log` | τ², 8 tasks × 3 trials, after the fix was deployed | `bench-v5` | pass^1 100 %, pass^2 62.5 %, pass^3 62.5 %, 20/24 trials |

**This run is the other half of the pair in `../2026-09-12/`, and the two differ
by one field.** PR #240 declared `defaultForAllAgents: true` on the τ² `retail`
plugin (`bench/tau2/retail.ts`) and had `BenchState.plugin()` forward it rather
than restate it (`cf/src/bench.ts`); nothing else changed. The same runner, on
the same benchmark, went from 0 of 8 tasks to 8 of 8, and the tool distribution
moved from no domain tool at all to ten distinct ones:

```
retail__get_order_details ×76   retail__get_product_details ×39
retail__find_user_id_by_name_zip ×24   retail__get_user_details ×24
retail__exchange_delivered_order_items ×14   retail__modify_pending_order_items ×9
retail__list_all_product_types ×8   retail__return_delivered_order_items ×4
retail__calculate ×3   retail__transfer_to_human_agents ×2
```

The cheap form of the same check needs no model call: `POST /bench/start` then
`GET /bench/debug` reports the catalogue the harness hands the provider, and it
reads `toolCount: 3` before the fix and `toolCount: 19` after (3 meta-tools + all
16 `retail` tools).

The four failures are not the failures above: every one of them *does* act and
some choose wrongly (task 5 exchanges an item that should have been returned),
where the pre-fix runs performed nothing at all. Recorded here so the two kinds
are not confused: the pair is about **reach**, and what remains is about
**choice** — and the pass^1-to-pass^2 drop (100 % → 62.5 %) is a stability
question that this change neither caused nor addresses.
