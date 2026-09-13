#!/usr/bin/env bash
# Deploy only if the suites pass. The tests and the deploy used to be two
# commands on one line separated by `;`, which is how a red run reached
# production on 2026-09-12: nothing was gating, only sequencing.
set -euo pipefail
cd ~/antiproton
for t in ledger usage-record exclusive mount-config mount-reports plugin-enable rename-mount release \
         pi-tools pi-offload pi-agent pi-sessions console-storage console-plugins \
         console-choice console-version state auth prompt-contributions; do
  printf "%-22s" "$t"
  if node "test/$t.ts" >/dev/null 2>&1; then echo ok; else echo FAIL; exit 1; fi
done
npm run typecheck 2>&1 | tail -1 | tee /dev/stderr | grep -q ", 0 new" || { echo "typecheck: new errors"; exit 1; }
echo "--- all green; deploying ---"
set -a; . ~/.secrets/antiproton.env; set +a
bash cf/scripts/deploy.sh "$@"
