#!/usr/bin/env bash
# Deploy only if the suites pass. The tests and the deploy used to be two
# commands on one line separated by `;`, which is how a red run reached
# production on 2026-09-12: nothing was gating, only sequencing.
set -euo pipefail
cd ~/antiproton
# Every suite, minus the ones named here with the reason they cannot run here.
# It used to be a list of 17 that someone had to remember to extend: 20 of the
# 37 suites were never gated, and the two of them that had gone red (confirm,
# secrets — their fixtures predated the plugin switch) stayed red unnoticed
# (Rex, 2026-09-13). A new suite is now gated by being written.
NEEDS_SERVICE=" appworld live-e2e live-github "  # a live AppWorld server; real GitHub
for f in test/*.ts; do
  t=$(basename "$f" .ts)
  case "$NEEDS_SERVICE" in *" $t "*) printf "%-22sskipped (needs a live service)\n" "$t"; continue;; esac
  printf "%-22s" "$t"
  if node "$f" >/dev/null 2>&1; then echo ok; else echo FAIL; exit 1; fi
done
# The storage conformance suite on real Durable Object SQLite (local workerd, no network).
printf "%-22s" "pi-storage-do"
if bash test/pi-storage-do.sh >/dev/null 2>&1; then echo ok; else echo FAIL; exit 1; fi
npm run typecheck 2>&1 | tail -1 | tee /dev/stderr | grep -q ", 0 new" || { echo "typecheck: new errors"; exit 1; }
echo "--- all green; deploying ---"
set -a; . ~/.secrets/antiproton.env; set +a
bash cf/scripts/deploy.sh "$@"
