#!/usr/bin/env bash
# Runs the same conformance suite against real Durable Object SQLite, in a
# worker that is never deployed. See cf/src/conformance.ts for why it is separate.
set -euo pipefail
PORT="${PORT:-8791}"
cd "$(dirname "$0")/../cf"
npx wrangler dev --config wrangler.conformance.jsonc --local \
  --port "$PORT" --inspector-port 0 >/tmp/antiproton-conformance.log 2>&1 &
for _ in $(seq 1 60); do
  sleep 1
  if curl -sf -m 300 "http://127.0.0.1:$PORT/" -o /tmp/antiproton-conformance.json; then break; fi
done
for p in $(lsof -ti "tcp:$PORT" 2>/dev/null || true); do kill "$p" 2>/dev/null || true; done
node -e '
const r = JSON.parse(require("fs").readFileSync("/tmp/antiproton-conformance.json", "utf8"));
console.log(`\n  pi Storage conformance — ${r.backend}\n  ${"─".repeat(56)}`);
let g = "";
for (const c of r.results) {
  if (c.group !== g) { g = c.group; console.log(`  ${g}`); }
  console.log(c.ok ? `    \x1b[32m✓\x1b[0m ${c.name}`
                   : `    \x1b[31m✗\x1b[0m ${c.name}\n        \x1b[31m${c.error}\x1b[0m`);
}
console.log(`  ${"─".repeat(56)}\n  ${r.passed} passed, ${r.failed} failed  (${r.ms} ms)\n`);
process.exit(r.failed === 0 ? 0 : 1);
'
