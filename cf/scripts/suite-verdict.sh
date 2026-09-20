# Two questions the deploy gate asks of the test suites, kept apart from the loop
# that runs them so a suite (test/suite-verdict.ts) can make each go red.
#
# 1. Did a suite assert anything? A suite whose cases were all deleted prints
#    "0 passed, 0 failed" and exits 0 — the verdict every file computed was
#    "nothing failed", which an empty run satisfies (Piper, 2026-09-13). So the
#    gate also requires the last reported pass count to be above zero.
# 2. Is every suite that guards production still there? The loop walks
#    test/*.ts, so a deleted file is simply not visited. The gate compares the
#    suites in the commit production is running now with the ones present, and
#    refuses a missing one unless test/removed-suites.txt names it. There is no
#    list of suites to keep: a new suite costs nothing (the loop already runs
#    it), and only a deletion has to say "I meant this" (Piper, Rex, 2026-09-13).

# suite_passed_count: reads a suite's output on stdin, prints the last reported
# pass count from a line beginning with it ("58 passed, 0 failed" or "5/5 passed"),
# or nothing if it reported none.
suite_passed_count() {
  # Anchored to the start of a line (after colour codes): the summary is a line
  # of its own, and a case's text can contain "3 passed" mid-sentence, which an
  # unanchored match read as a pass count (Piper, 2026-09-13).
  sed 's/\x1b\[[0-9;]*m//g' | grep -oE '^[[:space:]]*[0-9]+(/[0-9]+)? passed' | tail -1 | grep -oE '[0-9]+' | head -1 || true
}

# suite_removals PREVIOUS_NAMES_FILE ACKNOWLEDGED_FILE WHERE CURRENT_NAMES...
# prints one line per suite in PREVIOUS that is not in CURRENT and not
# acknowledged, nothing otherwise. Blank lines and "#" comments are ignored.
# WHERE names the commit PREVIOUS was read from, because the two callers
# compare against different things — the deploy gate against what production
# runs, the branch gate against the base it would merge into — and a message
# that named only one of them was wrong wherever it was read by the other.
suite_removals() {
  local previous="$1" acknowledged="$2" where="$3"; shift 3
  local name
  while IFS= read -r name; do
    case "$name" in ""|\#*) continue;; esac
    case " $* " in *" $name "*) continue;; esac
    if [ -f "$acknowledged" ] && grep -v '^#' "$acknowledged" | grep -qxF "$name"; then continue; fi
    echo "suite removed: $name (it is in $where; name it in test/removed-suites.txt if that was meant)"
  done < "$previous"
}

# gate_provenance: prints the commit and tree the working copy is at, so the
# numbers a gate prints carry the name of the thing they are about.
#
# Every verdict a gate produces is a fact about ONE TREE, and until now none of
# them said which. That name then had to come from whoever copied the output
# into a PR or a message — from memory, minutes later, while the branch moved
# under them. On 2026-09-20 that cost two wrong readings in one afternoon: a
# gate was posted for a PR whose head had already advanced twice while the run
# was going (@Vera's diagnosis: not a discipline problem, the artifact never
# says).
#
# The TREE, not only the commit, because after a squash merge no commit in
# master is the reviewed one — its SHA covers the message, the author and the
# parents as well as the content. "Is what I gated what landed" is a question
# about content, and only the tree answers it.
#
# A dirty worktree is NAMED rather than given a hash. What actually ran is a
# tree git has never stored, so any hash printed for it would denote something
# else; and one could be synthesised through a temporary index, but then the
# line's accuracy would rest on .gitignore and on staging rules, which is more
# to get wrong than the case is worth. Saying "this run cannot be referred to
# again" is the whole content of the warning.
gate_provenance() {
  local sha tree
  sha=$(git rev-parse --verify --quiet HEAD) || { echo "gate: not a git worktree"; return; }
  tree=$(git rev-parse --verify --quiet "HEAD^{tree}")
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    echo "gate: $sha + UNCOMMITTED CHANGES (so this run is of no stored tree; HEAD's is $tree)"
  else
    echo "gate: $sha (tree $tree)"
  fi
}
