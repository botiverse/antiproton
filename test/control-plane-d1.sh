#!/usr/bin/env bash
# The control plane's queries (cf/src/control-plane.ts) against real D1 SQLite:
# the migrations in cf/migrations applied to a fresh local database, then
# test/spec/control-plane-spec.ts run inside workerd by the conformance worker.
# Never deployed, no network. See test/pi-storage-do.sh for the same shape.
set -euo pipefail
PORT="${PORT:-8792}"
cd "$(dirname "$0")/../cf"
state=$(mktemp -d)
dev=""
# The whole tree `npx wrangler dev` started, children first: killing only what listens on the port stopped
# workerd and left npm and wrangler running, and every run left another orphan on the port (2026-09-15).
kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$child"; done
  kill "$pid" 2>/dev/null || true
}
cleanup() {
  [ -n "$dev" ] && kill_tree "$dev"
  for p in $(lsof -ti "tcp:$PORT" 2>/dev/null || true); do kill "$p" 2>/dev/null || true; done
  rm -rf "$state"
}
trap cleanup EXIT

# The schema comes from the migration files, as it does in production, never
# from a CREATE in the test: a column the migration lacks fails here.
if ! CI=1 npx wrangler d1 migrations apply CONTROL_DB --local --persist-to "$state/d1" \
  --config wrangler.conformance.jsonc >"$state/migrate.log" 2>&1; then
  cat "$state/migrate.log"
  exit 1
fi
npx wrangler dev --config wrangler.conformance.jsonc --local --persist-to "$state/d1" \
  --port "$PORT" --inspector-port 0 >"$state/dev.log" 2>&1 &
dev=$!
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
