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
