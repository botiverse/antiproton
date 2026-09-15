#!/usr/bin/env bash
# The control plane's queries (cf/src/control-plane.ts) against real D1 SQLite:
# the migrations in cf/migrations applied to a fresh local database, then
# test/spec/control-plane-spec.ts run inside workerd by the conformance worker.
# Never deployed, no network. See test/pi-storage-do.sh for the same shape.
# The port and the server it starts are this run's own (test/local-worker.sh).
set -euo pipefail
. "$(dirname "$0")/local-worker.sh"
cd "$(dirname "$0")/../cf"
state=$(mktemp -d)
trap 'stop_worker; rm -rf "$state"' EXIT

# The schema comes from the migration files, as it does in production, never
# from a CREATE in the test: a column the migration lacks fails here.
if ! CI=1 npx wrangler d1 migrations apply CONTROL_DB --local --persist-to "$state/d1" \
  --config wrangler.conformance.jsonc >"$state/migrate.log" 2>&1; then
  cat "$state/migrate.log"
  exit 1
fi
start_worker "$state/dev.log" --persist-to "$state/d1"
answered=""
for _ in $(seq 1 60); do
  sleep 1
  if curl -sf -m 120 "http://127.0.0.1:$PORT/control-plane" -o "$state/result.json"; then answered=1; break; fi
done
if [ -z "$answered" ]; then
  echo "the conformance worker did not answer on :$PORT"
  tail -20 "$state/dev.log"
  exit 1
fi
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(`\n  control plane on ${r.backend}\n  ${"─".repeat(56)}`);
for (const c of r.results) {
  console.log(c.ok ? `    \x1b[32m✓\x1b[0m ${c.name}`
                   : `    \x1b[31m✗\x1b[0m ${c.name}\n        \x1b[31m${c.error}\x1b[0m`);
}
console.log(`  ${"─".repeat(56)}\n  ${r.passed} passed, ${r.failed} failed  (${r.ms} ms)\n`);
process.exit(r.failed === 0 && r.passed > 0 ? 0 : 1);
' "$state/result.json"
