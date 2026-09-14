# docs

| file | what it is | authoritative? |
|---|---|---|
| [`philosophy.md`](philosophy.md) | the core philosophy, engineering invariants, and distributed systems rationale behind antiproton | yes — design manifesto |
| [`pi-upstream.md`](pi-upstream.md) | how to stay in sync with pi — the seams, the copied source, the contracts no type expresses, the deliberate divergences, and the upgrade checklist | yes, for anything pi-related |
| [`server-plan-archive.md`](server-plan-archive.md) | the original server-side (Cloudflare) pre-implementation plan doc, v1.1 | **no — frozen history** |
| [`self-hosted-plan-archive.md`](self-hosted-plan-archive.md) | the companion design doc for the local, self-hosted deployment, v1.0 | **no — frozen history** |

[`../README.md`](../README.md) describes the system as it is, and is the only
document kept in step with the code.

## Why the plan docs are frozen

They were written before the implementation, and they are kept that way on
purpose. Their value is the reasoning: which options were weighed, what was
measured, and what was believed at the time. Editing them to match the code
would destroy exactly the record worth keeping, and would leave two documents
that disagree the moment either moves.

So they are **not** updated. Where they conflict with `README.md`, the README
wins. In particular, the server doc's §13 roadmap and §14 acceptance matrix
still name the self-built kernel's leases, fencing tokens, generations and
transactional outbox as deliverables — all of which were deleted when the loop
became pi's. That text stays as written, because it records how those mechanisms
were argued for, not because they exist.
