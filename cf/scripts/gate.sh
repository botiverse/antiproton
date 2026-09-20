#!/usr/bin/env bash
# The branch gate: every suite and the typecheck, with no production read and
# no deploy. What `verify-and-deploy.sh` runs before it ships, minus the
# shipping — so a PR can be checked with the same instrument that guards a
# release, by anyone, rather than by each of us reading our own copy.
#
# Three things it is careful about, each of which has cost this repo a day:
#
#   1. A suite that ran and asserted NOTHING is a failure, not a pass. The
#      count comes from the suite's own output (cf/scripts/suite-verdict.sh),
#      and an empty or zero count is refused: "nothing ran" must not read like
#      "all passed".
#   2. The typecheck's verdict is the LINE, not its exit status. It exits
#      non-zero exactly when it has something to say, and a broken program
#      boundary prints deliberately WITHOUT ", 0 new" because the counts above
#      it then mean nothing. So the line is captured, printed, and tested.
#   3. The result leaves through the EXIT CODE. A gate that prints FAILS=2 and
#      exits 0 is, to anything that calls it, a gate that passed.
set -u
cd "$(dirname "$0")/../.."
. cf/scripts/suite-verdict.sh

# Suites that need something this script will not start (a local server, a
# live account). Named, so that "did not run" is visible rather than absent.
NEEDS_SERVICE=" appworld live-e2e live-github "

fails=0
run_suite() {
  local name="$1"; shift; printf "%-22s" "$name"; local out n
  if ! out=$("$@" 2>&1); then echo FAIL; printf '%s\n' "$out" | tail -15; fails=$((fails+1)); return; fi
  n=$(printf '%s\n' "$out" | suite_passed_count)
  if [ -z "$n" ] || [ "$n" -eq 0 ]; then echo "FAIL (asserted nothing)"; fails=$((fails+1)); return; fi
  echo "ok ($n)"
}

for f in test/*.ts; do
  t=$(basename "$f" .ts)
  case "$NEEDS_SERVICE" in *" $t "*) printf "%-22sskipped (needs a live service)\n" "$t"; continue;; esac
  run_suite "$t" node "$f"
done
run_suite pi-storage-do bash test/pi-storage-do.sh
run_suite control-plane-d1 bash test/control-plane-d1.sh

# `|| true`: see (2). Under `set -e` a failing assignment would stop the script
# before the line is printed, and the line is what a reader needs.
tc=$(npm run typecheck 2>&1 | tail -1) || true
echo "typecheck: $tc"
case "$tc" in *", 0 new"*) ;; *) echo "typecheck: NOT CLEAN"; fails=$((fails+1));; esac

echo "FAILS=$fails"
[ "$fails" -eq 0 ]
