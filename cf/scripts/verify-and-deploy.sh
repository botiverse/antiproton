#!/usr/bin/env bash
# Deploy only if the suites pass. The tests and the deploy used to be two
# commands on one line separated by `;`, which is how a red run reached
# production on 2026-09-12: nothing was gating, only sequencing.
set -euo pipefail
# The tree this script belongs to, not a fixed checkout. `cd ~/antiproton` made
# every run test the shared checkout, so a run from a worktree tested master
# instead of the change beside it, and read as a verdict on the wrong tree
# (Rex, 2026-09-13).
cd "$(dirname "$0")/../.."

# Production deploys merged code only. Once this script tests the tree it lives
# in, running it from a worktree would otherwise also deploy that worktree —
# and on 2026-09-13 a verification run of an unmerged branch did exactly that:
# green suites, then a production deploy stamped with a head master did not
# have. A preview deploy (--config wrangler.preview.jsonc) may ship a branch.
# Checked first, so a refusal costs nothing.
case " $* " in
  *wrangler.preview.jsonc*) ;;
  *)
    git fetch -q origin master
    if ! git merge-base --is-ancestor HEAD origin/master; then
      echo "refusing to deploy: HEAD $(git rev-parse --short HEAD) is not on origin/master."
      echo "Production ships merged code only; use --config wrangler.preview.jsonc for a branch."
      exit 1
    fi
    ;;
esac
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
# Captured, then printed, then tested. It used to be piped through
# \`tee /dev/stderr\`, and when the run is redirected to a log file, /dev/stderr
# reopens that file with truncation: every suite line above was erased and the
# log read as one typecheck line followed by NUL bytes, so a deploy's own record
# could not show which suites had run (2026-09-13).
# `|| true`: typecheck exits non-zero exactly when it has something to say, and
# under `set -e` a failing assignment would stop the script here, silently —
# the verdict belongs to the `case` below, after the line has been printed.
tc=$(npm run typecheck 2>&1 | tail -1) || true
echo "$tc"
case "$tc" in *", 0 new"*) ;; *) echo "typecheck: new errors"; exit 1;; esac
echo "--- all green; deploying ---"
set -a; . ~/.secrets/antiproton.env; set +a
bash cf/scripts/deploy.sh "$@"
