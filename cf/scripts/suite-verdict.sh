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

# suite_name: the name column of a gate's output line.
#
# `printf "%-22s"` PADS but does not TRUNCATE, so a name of 22 characters or
# more filled the field exactly and the verdict was printed hard against it:
# `identity-in-the-recordok (5)`. Five suites are that long today, all of them
# recent, so the lines had silently stopped being parseable — and @Vera, re-
# running the gate after my pkill, nearly reported "the gate is missing four
# suites" from `grep "^<name> "` finding nothing. A false accusation, produced
# by a formatting choice.
#
# The trailing space is OUTSIDE the field width, so it cannot be eaten by a
# long name: every line has at least one space between the two, whatever
# anybody names a suite next.
suite_name() { printf "%-22s " "$1"; }

# 3. Did a suite FINISH? Both gates read only an exit status, so a suite that
#    never exits produced no verdict at all: nothing went red, the gate simply
#    did not end, and the deploy window passed. test/*-do.sh waited up to 60
#    times on a `curl -m 300`, so one hung worker could hold a gate for five
#    hours (#766). Every suite now runs under a limit, and running out of it is
#    its own verdict, TIMEOUT: not a FAIL, because nothing was asserted false
#    and the remedy differs (find what hangs, not what broke), but a refusal
#    all the same.
#
#    The limit is a backstop against a hang, not a performance budget, so it
#    is a generous multiple of the slowest suite's normal time. Measured
#    2026-10-14, one suite at a time as the gate runs them, on a 12-core host
#    at load ~7: the slowest suite was control-plane-d1 at 31 s, the other DO
#    suites 7-17 s, the slowest node suite 20 s, the typecheck 8 s. 600 s is
#    about twenty times the slowest, and above the 360 s a DO suite allows its
#    worker to answer (test/local-worker.sh, await_answer), so a hung worker
#    is reported by the suite's own message and log before the gate's limit.
#    GATE_SUITE_LIMIT changes it for every suite; GATE_SUITE_LIMIT_<name>
#    (dashes as underscores) for one, for a suite that legitimately needs
#    longer.

# suite_limit NAME: the seconds NAME may run before it is a TIMEOUT.
suite_limit() {
  local var="GATE_SUITE_LIMIT_$(printf '%s' "$1" | tr -c 'A-Za-z0-9_' '_')"
  printf '%s\n' "${!var:-${GATE_SUITE_LIMIT:-600}}"
}

# suite_descendants PID: every live descendant of PID, deepest last.
suite_descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do echo "$child"; suite_descendants "$child"; done
}

# suite_stop PGID: ends the process group PGID — TERM, a grace period, then
# KILL — and returns non-zero if anything in it survived even that.
#
# A GROUP, not the suite's pid: by the time anyone asks, the suite's shell may
# be gone, and what it started (`npx wrangler dev`, then workerd) has been
# re-parented and can no longer be found by walking children. Left running,
# that server keeps its port, and a later run can read its answer.
suite_stop() {
  local pgid="$1" grace
  pgrep -g "$pgid" >/dev/null 2>&1 || return 0
  kill -TERM -- "-$pgid" 2>/dev/null || true
  grace=$((SECONDS + 5))
  while [ "$SECONDS" -lt "$grace" ]; do pgrep -g "$pgid" >/dev/null 2>&1 || return 0; sleep 0.1; done
  kill -KILL -- "-$pgid" 2>/dev/null || true
  grace=$((SECONDS + 2))
  while [ "$SECONDS" -lt "$grace" ]; do pgrep -g "$pgid" >/dev/null 2>&1 || return 0; sleep 0.1; done
  ! pgrep -g "$pgid" >/dev/null 2>&1
}

# suite_run_bounded LIMIT OUT COMMAND...: runs COMMAND with stdout and stderr
# in the file OUT and returns its status. SUITE_TIMED_OUT is set to 1 if it was
# still running after LIMIT seconds, in which case it has been killed.
# SUITE_LEFTOVER is set to 1 if its process group could not be ended.
#
# COMMAND gets a session, and so a process group, of its own (`setsid`; a
# background job of a non-interactive shell is never a group leader, so setsid
# execs in place and the pid it leaves in $! is the group's id). Afterwards the
# group is ended whatever the verdict, so a suite that passed but left its
# server behind does not leave it to the next run either. The descendants are
# also killed by pid at the limit, while the tree can still be walked, in case
# something in it moved to a session of its own.
#
# The limit is kept by a watchdog in its own group rather than by polling, so a
# suite that ends costs no wait.
suite_run_bounded() {
  local limit="$1" out="$2"; shift 2
  local pid watchdog status=0 dir
  SUITE_TIMED_OUT="" SUITE_LEFTOVER=""
  dir=$(mktemp -d)
  setsid "$@" >"$out" 2>&1 </dev/null &
  pid=$!
  setsid bash -c "$(declare -f suite_descendants)"'
    sleep "$1" || exit 0
    : >"$2"
    tree=$(suite_descendants "$3")
    kill -TERM $tree 2>/dev/null; kill -TERM -- "-$3" 2>/dev/null
    grace=$((SECONDS + 5))
    while [ "$SECONDS" -lt "$grace" ]; do
      left=$(pgrep -g "$3"; for p in $tree; do kill -0 "$p" 2>/dev/null && echo "$p"; done)
      [ -n "$left" ] || exit 0
      sleep 0.1
    done
    kill -KILL $tree 2>/dev/null; kill -KILL -- "-$3" 2>/dev/null
    exit 0' watchdog "$limit" "$dir/timed-out" "$pid" </dev/null >/dev/null 2>&1 &
  watchdog=$!
  # Interrupting the gate must not leave the suite running: in a session of its
  # own it no longer receives the terminal's ^C.
  trap 'kill -KILL -- "-$watchdog" "$watchdog" 2>/dev/null; suite_stop "$pid"; rm -rf "$dir"; exit 130' INT TERM
  wait "$pid" || status=$?
  # A watchdog that has fired is left to finish its KILL round, which covers the
  # pids it found while the tree was whole; one that has not is cancelled.
  # By pid as well as by group: a watchdog that has not yet reached setsid has
  # no group of its own, and would sleep out the whole limit with `wait` below
  # waiting for it.
  if [ -e "$dir/timed-out" ]; then SUITE_TIMED_OUT=1; else
    kill -KILL -- "-$watchdog" 2>/dev/null || true; kill -KILL "$watchdog" 2>/dev/null || true
  fi
  wait "$watchdog" 2>/dev/null || true
  trap - INT TERM
  rm -rf "$dir"
  if ! suite_stop "$pid"; then SUITE_LEFTOVER=1; fi
  return "$status"
}
