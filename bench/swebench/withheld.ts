/**
 * The sandbox tools a SWE-bench agent is never offered, and is refused if it names them anyway
 * (cf/src/runtime.ts `withholdTools`). Both runners use this list: cf/src/index.ts `#benchRt` and
 * bench/swebench/run.ts.
 *
 * The grader runs after the agent, in the agent's container, so anything that hands that container back
 * before grading turns the agent's work into a fresh box from the base image: no diff, every test still
 * failing, a zero that looks like the model being wrong.
 *   - `release` destroys the container.
 *   - `start_from` with a name releases the current container too, and the next command starts a new one
 *     from a kept snapshot (src/plugins/sandbox.ts, the `start_from` tool).
 * `keep` stays: it stops the box to snapshot it, and the next command wakes the same box with its disk.
 */
import { SANDBOX_ALIAS } from "../../src/plugins/sandbox.ts";

export const BENCH_SWE_WITHHELD: readonly string[] = [`${SANDBOX_ALIAS}.release`, `${SANDBOX_ALIAS}.start_from`];
