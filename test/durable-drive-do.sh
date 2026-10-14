#!/usr/bin/env bash
# Runs the park contract's cases (test/spec/durable-drive-spec.ts) against real Durable Object SQLite,
# in the conformance worker, which is never deployed (cf/src/conformance.ts). test/durable-drive.ts
# runs them over node:sqlite; this is the run on the storage and runtime the object will have.
# The port and the server it starts are this run's own (test/local-worker.sh).
set -euo pipefail
. "$(dirname "$0")/local-worker.sh"
cd "$(dirname "$0")/../cf"
state=$(mktemp -d)
trap 'stop_worker; rm -rf "$state"' EXIT
start_worker "$state/dev.log"
answered=""
if await_answer /durable-drive "$state/result.json" 300; then answered=1; fi
stop_worker
if [ -z "$answered" ]; then
  echo "the conformance worker did not answer on :$PORT"
  tail -20 "$state/dev.log"
  exit 1
fi
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(`\n  durable drive: park contract + offloaded provider — ${r.backend}\n  ${"─".repeat(56)}`);
let g = "";
for (const c of r.results) {
  if (c.group !== g) { g = c.group; console.log(`  ${g}`); }
  console.log(c.ok ? `    \x1b[32m✓\x1b[0m ${c.name}`
                   : `    \x1b[31m✗\x1b[0m ${c.name}\n        \x1b[31m${c.error}\x1b[0m`);
}
console.log(`  ${"─".repeat(56)}\n  ${r.passed} passed, ${r.failed} failed  (${r.ms} ms)\n`);
process.exit(r.failed === 0 ? 0 : 1);
' "$state/result.json"
