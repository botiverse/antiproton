# Working in this repository

## The agent loop is pi's

`src/runtime/`, `src/store/pi-storage.ts` and `src/model/pi-offloaded.ts` are
built on [pi](https://github.com/earendil-works/pi), which is pre-1.0 and moves.

Before upgrading it, changing anything that imports it, or patching one of its
files, read **[`docs/pi-upstream.md`](docs/pi-upstream.md)**. It records the
seams we depend on, the parts that were copied rather than imported, the
behavioural contracts that no type expresses, and the three places we
deliberately differ from upstream and why.

The short version: the pin is exact on purpose, `node_modules` is never edited
in place, and an upgrade is not finished until pi's own conformance suite and a
benchmark have both run.

## Conventions

Anything named `…Bytes` counts `String.length` — UTF-16 code units — wherever
what it bounds is a string, which is everywhere except binary payloads. They are
coherent because they all count the same unit, and `src/store/artifacts.ts`
measures real bytes on binary via `byteLength`.

## Contribution Guidelines

To keep the repository sound, maintainable, and aligned with core principles:

- **Open for direct pull requests:** Plugins located under `src/plugins/`. Community contributions adding new external tool connectors, data adapters, or plugin integrations are warmly welcomed with accompanying tests in `test/`.
- **Require an issue first:** Core runtime, state management, and Durable Objects under `src/runtime/`, `src/core/`, `src/store/`, and `cf/`. Please open an issue to discuss invariants and architecture before writing code.
- **Evidence over assertion:** Benchmarks, measurable telemetry, and positive control tests decide proposals. Every PR should verify its claims through testable entry points.
- **Documentation standards:** All public documentation is in English, focused on external readability and factual fidelity. When code changes public behavior, keep `README.md` and related docs updated in the same PR.

## Running the tests

**`npm run typecheck` first**, before the suites. It is a ratchet rather than a
gate: the tree carries type errors that predate any check, so `tsc` on its own
never passes, and `scripts/typecheck.mjs` fails only on a signature that is not in
its program's baseline. There are two programs, because node and the worker have
different globals: `tsconfig.node.json` against `typecheck-baseline.node.txt`, and
`tsconfig.worker.json` (cf/src, the src/** it imports, and the tests that import
cf/src) against `typecheck-baseline.worker.txt`. **An entry in that baseline is a finding still owed a
reading, not one agreed to be harmless** — the first one read turned out to be a
tool that had never once done what its own summary promised — so the file shrinks
by somebody understanding an entry, and `--update` means understood, never
ignored. That is also what would have caught the use-before-declare that emptied
three console routes: a class no test could see, since the fixtures exercise each
function once and the defect was in how the functions were reached.

The suites in `test/` run with no external services; run them with
`node test/<name>.ts`. How many there are and how many cases each holds moves as
work lands, so **count rather than trust a number in a document, including this
one** — a suite added in the afternoon makes any figure here stale by evening,
which has already happened once. Three files in `test/` are not part of that set
and are meant to be skipped unless you have the services: `appworld` needs both
AppWorld servers running locally
(`appworld serve apis --port 8800`, `environment --port 8799`), and `live-e2e`
and `live-github` reach out to live endpoints. **A skipped suite still rots.** One
of these called a tool name the plugin no longer answered, and nothing said so,
because a file that exists and is named for the right thing reads as coverage
whether or not it runs. Run them when you have the services, and treat "it is in
`test/`" as a fact about the directory rather than about the code.

Two ways this goes wrong, both of which produce an error that points at the code
rather than at the setup:

- **`npx tsx test/<name>.ts` is not the way.** The `pi-*` suites resolve their
  imports through node and die with `ERR_MODULE_NOT_FOUND`, which is about the
  runner and nothing else.

- **`__name is not defined` is not a runner artefact, and do not dismiss it.**
  It means a test is evaluating a function's **source text** —
  `new Function(fn.toString())`, which is how a test runs JavaScript the shell
  ships to the browser as a string — and the text came from a **bundler**, which
  rewrites function bodies and adds a `__name` helper that does not exist inside
  a bare `new Function`. `tsx` does it and so does wrangler's esbuild, so the
  same failure reaches the browser with nothing to do with the test: the shipped
  source throws. The fix is not to change the runner but to write the page's copy
  out as plain source rather than deriving it from a compiled function, and to
  assert that string carries no bundler helper.
- **A fresh `git worktree` has no `node_modules`**, so the `pi-*` suites fail on
  `@earendil-works/pi-agent-core` — a package you have probably never heard of,
  failing for a reason that is about a directory and not about the branch. Link
  the main checkout's copy before you run anything there:

      ln -s "$(git rev-parse --git-common-dir)/../node_modules" node_modules

  Not `--show-toplevel`: inside a linked worktree that prints the worktree, which
  is the directory that has no `node_modules`, and the symlink would point at
  itself.

If you report a branch as green, **name the set you ran**. The suites nearest a
change answer "is this change sound"; only the whole set — every file in `test/`
except the ones that need a live service — answers "is this branch sound", and the
two are different questions. Name the second one without a count, for the reason
two paragraphs up.

**A change a test is meant to certify needs two readings, and they are separate.**
First, a reading that the change *moved the behaviour under test* — without it a
green cannot be told from a change that did nothing at all. Second, when the guard
is deliberately broken, a reading that the failure *names the assertion you meant*,
not one that happened to run first. A green or a red can both be true for a
reason unrelated to the claim being made, so the reading is part of the claim: what
shows this changed the behaviour, and which assertion reddens if the guard breaks.

## Which document is authoritative

[`README.md`](README.md) describes the system as it is; its numbers are measured
and it is the only doc kept in step with the code. Everything else is history or
reference:

- [`docs/philosophy.md`](docs/philosophy.md) — the engineering philosophy, architectural rationale, and verification principles.
- [`docs/pi-upstream.md`](docs/pi-upstream.md) — how to stay in sync with pi.
- [`docs/server-plan-archive.md`](docs/server-plan-archive.md) and
  [`docs/self-hosted-plan-archive.md`](docs/self-hosted-plan-archive.md) —
  the pre-implementation design docs (historical archives, frozen on purpose).
  They record early architectural reasoning and benchmark evidence (including mechanisms
  since replaced by pi's loop). Do not read them as the active design; active reality
  belongs exclusively in [`README.md`](README.md).
