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

## Running the tests

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

- **`npx tsx test/<name>.ts` is not the way.** It fails in two different ways,
  neither of which is about the code under test. The `pi-*` suites resolve their
  imports through node and die with `ERR_MODULE_NOT_FOUND`; and a case that
  **evaluates source text** — `new Function(someSourceString)`, which is how a
  test checks JavaScript the shell ships to the browser as a string — dies with
  `__name is not defined`, because `tsx` compiles named functions to call a
  helper that exists in its own scope and not inside a bare `new Function`.
  That second one is worth knowing by name: the message reads like a typo in the
  code under test, and the same file is green under `node test/<name>.ts`.
- **A fresh `git worktree` has no `node_modules`**, so the `pi-*` suites fail on
  `@earendil-works/pi-agent-core` — a package you have probably never heard of,
  failing for a reason that is about a directory and not about the branch. Link
  the main checkout's copy before you run anything there:

      ln -s "$(git rev-parse --git-common-dir)/../node_modules" node_modules

  Not `--show-toplevel`: inside a linked worktree that prints the worktree, which
  is the directory that has no `node_modules`, and the symlink would point at
  itself.

If you report a branch as green, **name the set you ran**. The suites nearest a
change answer "is this change sound"; only the full fifteen answer "is this
branch sound", and the two are different questions.

## Which document is authoritative

[`README.md`](README.md) describes the system as it is; its numbers are measured
and it is the only doc kept in step with the code. Everything else is history or
reference:

- [`docs/pi-upstream.md`](docs/pi-upstream.md) — how to stay in sync with pi.
- [`docs/服务端Antiproton-完整计划书.md`](docs/服务端Antiproton-完整计划书.md) and
  [`docs/本地自托管Antiproton-计划书.md`](docs/本地自托管Antiproton-计划书.md) —
  the pre-implementation design docs, **frozen on purpose**. They record the
  reasoning and the evidence of their moment, including mechanisms since
  deleted (the self-built kernel's leases, fencing and outbox). Do not read them
  as the current design, and do not update them to match: their value is that
  they were written before the code, and current facts belong in the README.
