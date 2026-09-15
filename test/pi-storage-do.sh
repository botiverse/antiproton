#!/usr/bin/env bash
# Runs the same conformance suite against real Durable Object SQLite, in a
# worker that is never deployed. See cf/src/conformance.ts for why it is separate.
# The port and the server it starts are this run's own (test/local-worker.sh).
set -euo pipefail
. "$(dirname "$0")/local-worker.sh"
cd "$(dirname "$0")/../cf"
state=$(mktemp -d)
trap 'stop_worker; rm -rf "$state"' EXIT
start_worker "$state/dev.log"
answered=""
for _ in $(seq 1 60); do
  sleep 1
  if curl -sf -m 300 "http://127.0.0.1:$PORT/" -o "$state/result.json"; then answered=1; break; fi
done
stop_worker
if [ -z "$answered" ]; then
  echo "the conformance worker did not answer on :$PORT"
  tail -20 "$state/dev.log"
  exit 1
fi
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(`\n  pi Storage conformance — ${r.backend}\n  ${"─".repeat(56)}`);
let g = "";
for (const c of r.results) {
  if (c.group !== g) { g = c.group; console.log(`  ${g}`); }
  console.log(c.ok ? `    \x1b[32m✓\x1b[0m ${c.name}`
                   : `    \x1b[31m✗\x1b[0m ${c.name}\n        \x1b[31m${c.error}\x1b[0m`);
}
console.log(`  ${"─".repeat(56)}\n  ${r.passed} passed, ${r.failed} failed  (${r.ms} ms)\n`);
process.exit(r.failed === 0 ? 0 : 1);
' "$state/result.json"
