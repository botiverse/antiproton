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
