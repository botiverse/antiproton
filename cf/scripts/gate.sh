#!/usr/bin/env bash
# The branch gate: every suite, the removal guard and the typecheck, with no
# deploy — what `verify-and-deploy.sh` runs before it ships, minus the shipping,
# so a PR can be checked by anyone rather than by each of us reading our own
# copy of a script.
#
# It asks BOTH questions cf/scripts/suite-verdict.sh exists for, and one more:
#
#   1. A suite that ran and asserted NOTHING is a failure, not a pass. The
#      count comes from the suite's own output, and an empty or zero count is
#      refused: "nothing ran" must not read like "all passed".
#   2. A suite that is GONE is a failure too. The loop below walks test/*.ts,
#      so a deleted file is simply never visited and its absence is silent.
#      The suites in the base commit are compared with the ones present, and a
#      missing one must be named in test/removed-suites.txt.
#   3. The typecheck's verdict is the LINE, not its exit status. It exits
#      non-zero exactly when it has something to say, and a broken program
#      boundary prints deliberately WITHOUT ", 0 new" because the counts above
#      it then mean nothing. So the line is captured, printed, and tested.
#   4. Every line above is a fact about ONE TREE, so the run says which
#      (`gate_provenance`), first and last. A verdict copied into a PR without
#      it is a claim whose subject the reader has to supply from memory.
#   5. The result leaves through the EXIT CODE. A gate that prints FAILS=2 and
#      exits 0 is, to anything that calls it, a gate that passed.
#   6. A suite that never ENDS is refused too. An exit code is only read once
#      there is one, so a hung suite used to fail open: nothing turned red, the
#      gate just never finished (#766). Each suite runs under a limit
#      (`suite_limit`), and one that reaches it is killed with everything it
#      started and reported as TIMEOUT — counted on a line of its own and in
#      FAILS as well, so "FAILS=0" still means everything passed.
#
# ONE DIFFERENCE from the deploy gate, and it is deliberate: that one compares
# against the commit PRODUCTION IS RUNNING, because what it must not drop is a
# suite guarding live behaviour. A branch has no such commit to ask about, so
# this compares against the base it would be merged into (`origin/master`, or
# GATE_BASE). Both are git reads; neither touches production.
set -u
cd "$(dirname "$0")/../.."
. cf/scripts/suite-verdict.sh

# Suites that need something this script will not start (a local server, a
# live account). Named, so that "did not run" is visible rather than absent.
NEEDS_SERVICE=" appworld live-e2e live-github "

fails=0

# Said before the suites and again beside the verdict: the header scrolls past
# in a long run, and the tail is what gets copied.
gate_provenance

# (6) A limit that is not a number would limit nothing: refused before anything runs.
if ! problem=$(suite_limits_problem); then echo "$problem"; exit 1; fi

# (2) The removal guard. A base that cannot be resolved is refused rather than
# skipped: a guard that quietly does not run is the thing this whole script is
# about. `origin/master` is a local ref — no network, and no production read.
base=${GATE_BASE:-origin/master}
if ! base_sha=$(git rev-parse --verify --quiet "${base}^{commit}"); then
  echo "refusing: cannot resolve the base to compare suites against (${base}), so a deleted suite could go unnoticed."
  echo "Name one: GATE_BASE=<commit-ish> $0"
  exit 1
fi
in_base=$(mktemp)   # a file of its own: several trees may run this at once
git ls-tree --name-only "$base_sha" test/ | sed -n 's#^test/\(.*\)\.ts$#\1#p' > "$in_base"
removed=$(suite_removals "$in_base" test/removed-suites.txt "the base $base ($base_sha)" $(for f in test/*.ts; do basename "$f" .ts; done))
rm -f "$in_base"
if [ -n "$removed" ]; then echo "$removed"; fails=$((fails+1)); fi

# (6) The limit and the kill are cf/scripts/suite-verdict.sh's, question 3.
timeouts=0
run_suite() {
  local name="$1"; shift; suite_name "$name"; local out n limit status=0 file
  limit=$(suite_limit "$name"); file=$(mktemp)
  suite_run_bounded "$limit" "$file" "$@" || status=$?
  out=$(cat "$file")
  # A failing suite's whole output is kept and its path printed: the 15 lines
  # shown are the end of the report, and a case's error printed above them
  # (with its stack) was lost with the file.
  if [ -n "$SUITE_TIMED_OUT" ]; then
    echo "TIMEOUT (still running after ${limit}s; killed)"; printf '%s\n' "$out" | tail -15; echo "  full output: $file"
    timeouts=$((timeouts+1)); fails=$((fails+1)); return
  fi
  if [ -n "$SUITE_ERROR" ]; then echo "FAIL ($SUITE_ERROR)"; printf '%s\n' "$out" | tail -15; echo "  full output: $file"; fails=$((fails+1)); return; fi
  if [ "$status" -ne 0 ]; then echo FAIL; printf '%s\n' "$out" | tail -15; echo "  full output: $file"; fails=$((fails+1)); return; fi
  n=$(printf '%s\n' "$out" | suite_passed_count)
  if [ -z "$n" ] || [ "$n" -eq 0 ]; then echo "FAIL (asserted nothing)"; echo "  full output: $file"; fails=$((fails+1)); return; fi
  rm -f "$file"
  echo "ok ($n)"
}

for f in test/*.ts; do
  t=$(basename "$f" .ts)
  case "$NEEDS_SERVICE" in *" $t "*) suite_name "$t"; echo "skipped (needs a live service)"; continue;; esac
  run_suite "$t" node "$f"
done
run_suite pi-storage-do bash test/pi-storage-do.sh
run_suite pi-durable-do bash test/pi-durable-do.sh
run_suite ap-store-do bash test/ap-store-do.sh
run_suite durable-drive-do bash test/durable-drive-do.sh
run_suite durable-agent-do bash test/durable-agent-do.sh
run_suite pd-tools-do bash test/pd-tools-do.sh
run_suite pd-outbox-do bash test/pd-outbox-do.sh
run_suite pd-cancel-do bash test/pd-cancel-do.sh
run_suite pd-writes-do bash test/pd-writes-do.sh
run_suite pd-compaction-do bash test/pd-compaction-do.sh
run_suite pd-migrate-do bash test/pd-migrate-do.sh
run_suite control-plane-d1 bash test/control-plane-d1.sh

# `|| true`: see (2). Under `set -e` a failing assignment would stop the script
# before the line is printed, and the line is what a reader needs.
# Under the same limit as a suite, and for the same reason.
limit=$(suite_limit typecheck); file=$(mktemp)
suite_run_bounded "$limit" "$file" npm run typecheck || true
tc=$(tail -1 "$file") || true; rm -f "$file"
if [ -n "$SUITE_TIMED_OUT" ]; then tc="TIMEOUT (still running after ${limit}s; killed)"; timeouts=$((timeouts+1));
elif [ -n "$SUITE_ERROR" ]; then tc="FAIL ($SUITE_ERROR)"; fi
echo "typecheck: $tc"
case "$tc" in *", 0 new"*) ;; *) echo "typecheck: NOT CLEAN"; fails=$((fails+1));; esac

gate_provenance
echo "TIMEOUTS=$timeouts"
echo "FAILS=$fails"
[ "$fails" -eq 0 ]
