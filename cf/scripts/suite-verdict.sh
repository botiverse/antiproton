# Two questions the deploy gate asks of the test suites, kept apart from the loop
# that runs them so a suite (test/suite-verdict.ts) can make each go red.
#
# 1. Did a suite assert anything? A suite whose cases were all deleted prints
#    "0 passed, 0 failed" and exits 0 — the verdict every file computed was
#    "nothing failed", which an empty run satisfies (Piper, 2026-09-13). So the
#    gate also requires the last reported pass count to be above zero.
# 2. Is every suite still there? The loop walks test/*.ts, so a deleted file is
#    simply not visited. test/suites.txt names every suite; a file missing from
#    the tree, or present but unlisted, fails the gate until the list is changed
#    in the same commit — a deliberate removal says so, an accidental one is loud.

# suite_passed_count: reads a suite's output on stdin, prints the last reported
# pass count ("58 passed, 0 failed" or "5/5 passed"), or nothing if it reported none.
suite_passed_count() {
  sed 's/\x1b\[[0-9;]*m//g' | grep -oE '[0-9]+(/[0-9]+)? passed' | tail -1 | grep -oE '^[0-9]+' || true
}

# suite_list_problems LISTED_FILE ACTUAL_NAMES...: prints one line per mismatch
# between the committed list and the suites present, nothing when they agree.
suite_list_problems() {
  local listed="$1"; shift
  local name
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    case " $* " in *" $name "*) ;; *) echo "suite removed: $name (delete it from test/suites.txt in the same change if that was meant)";; esac
  done < "$listed"
  for name in "$@"; do
    grep -qxF "$name" "$listed" || echo "suite not listed: $name (add it to test/suites.txt)"
  done
}
