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

# Production ships the current master and nothing else (cf/scripts/deploy-guard.sh
# says why). Checked first, so a refusal costs nothing. On 2026-09-13 a
# verification run of an unmerged branch reached production; the first version
# of this check then allowed any merged commit, including an older one (Piper).
. cf/scripts/deploy-guard.sh
git fetch -q origin master
refusal=$(deploy_refusal "$(git rev-parse HEAD)" "$(git rev-parse origin/master)" "$@")
if [ -n "$refusal" ]; then echo "$refusal"; exit 1; fi
# Every suite, minus the ones named here with the reason they cannot run here.
# It used to be a list of 17 that someone had to remember to extend: 20 of the
# 37 suites were never gated, and the two of them that had gone red (confirm,
# secrets — their fixtures predated the plugin switch) stayed red unnoticed
# (Rex, 2026-09-13). A new suite is gated by being written.
#
# A suite passes when it exits 0 AND reports at least one pass: an emptied suite
# exits 0 too. And every suite in the commit production runs now must still be
# here, unless test/removed-suites.txt names it, so a deleted one is refused
# instead of skipped (Piper, Rex, 2026-09-13; cf/scripts/suite-verdict.sh).
. cf/scripts/suite-verdict.sh
live=$(curl -fsS -m 20 https://antiproton.ai/ui/whoami 2>/dev/null | sed -n 's/.*"build":"\([0-9a-f]\{7,40\}\)".*/\1/p' || true)
if [ -z "$live" ] || ! git cat-file -e "${live}^{commit}" 2>/dev/null; then
  echo "refusing: cannot tell which commit production runs (${live:-no answer}), so a deleted suite could go unnoticed."
  exit 1
fi
git ls-tree --name-only "$live" test/ | sed -n 's#^test/\(.*\)\.ts$#\1#p' > /tmp/suites-in-production.txt
problems=$(suite_removals /tmp/suites-in-production.txt test/removed-suites.txt $(for f in test/*.ts; do basename "$f" .ts; done))
if [ -n "$problems" ]; then echo "$problems"; exit 1; fi
NEEDS_SERVICE=" appworld live-e2e live-github "  # a live AppWorld server; real GitHub
run_suite() {  # name, command...
  local name="$1"; shift
  printf "%-22s" "$name"
  local out n
  if ! out=$("$@" 2>&1); then echo FAIL; exit 1; fi
  n=$(printf '%s\n' "$out" | suite_passed_count)
  if [ -z "$n" ] || [ "$n" -eq 0 ]; then echo "FAIL (asserted nothing: ${n:-no pass count})"; exit 1; fi
  echo "ok ($n)"
}
for f in test/*.ts; do
  t=$(basename "$f" .ts)
  case "$NEEDS_SERVICE" in *" $t "*) printf "%-22sskipped (needs a live service)\n" "$t"; continue;; esac
  run_suite "$t" node "$f"
done
# The storage conformance suite on real Durable Object SQLite (local workerd, no network).
run_suite pi-storage-do bash test/pi-storage-do.sh
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
