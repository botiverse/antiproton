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

# typecheck_result FILE: prints the last line of `npm run typecheck`'s output
# that scripts/typecheck.mjs wrote as its verdict ("typecheck: ..."), or nothing.
# Not the file's last line: npm writes into the same stream, and its update
# notice is printed at exit, after the script's output, ending in a bare
# "npm notice" line that read as "new errors" and stopped a deploy whose
# typecheck said 0 new (2026-10-27). Whether it appears depends on npm's
# registry check finishing before the script does. The per-program lines
# ("typecheck node: ...") also say ", 0 new" and do not match: only the total
# speaks for both programs.
typecheck_result() {
  grep '^typecheck: ' "$1" | tail -1 || true
}

# typecheck_clean LINE: succeeds when LINE, typecheck_result's verdict, says
# ", 0 new". The test is the line, not the exit status: the typecheck exits
# non-zero exactly when it has something to say, and a broken program boundary
# prints deliberately WITHOUT ", 0 new" because the counts above it then mean
# nothing. One definition, read by both gates and so by CI (which runs
# cf/scripts/gate.sh), so the three cannot disagree about what "clean" means.
typecheck_clean() {
  case "$1" in *", 0 new"*) return 0;; esac
  return 1
}

# The suites no gate runs, each because it needs something a gate will not
# start: a live AppWorld server (appworld), the real deployment and GitHub
# (live-e2e, live-github). Named, so "did not run" is printed rather than
# absent, and named ONCE: the deploy gate, the branch gate and CI (which runs
# the branch gate) all skip exactly these.
GATE_NEEDS_SERVICE=" appworld live-e2e live-github "

# suite_needs_service NAME: succeeds when NAME is one of GATE_NEEDS_SERVICE.
suite_needs_service() {
  case "$GATE_NEEDS_SERVICE" in *" $1 "*) return 0;; esac
  return 1
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
#
# Each line carries the time it was read (UTC): a gate prints it first and
# last, and the two times are what show a log's readings bracket the run, or
# the deploy, they describe.
gate_provenance() {
  local sha tree
  sha=$(git rev-parse --verify --quiet HEAD) || { echo "gate: not a git worktree"; return; }
  tree=$(git rev-parse --verify --quiet "HEAD^{tree}")
  if ! gate_tree_clean; then
    echo "gate: $sha + UNCOMMITTED CHANGES (so this run is of no stored tree; HEAD's is $tree) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    gate_dirty_files
  else
    echo "gate: $sha (tree $tree) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  fi
}

# gate_tree_clean: succeeds when the working copy is exactly HEAD's tree, the
# one condition under which HEAD's tree names what a gate ran on. Untracked
# files count: the loops pick up an untracked test/*.ts, and an untracked source
# file is bundled if tracked code imports it. Ignored files do not (node_modules,
# build output). A status that cannot be read is not clean. One definition, so
# the provenance line and the deploy gate's refusal cannot disagree about it.
gate_tree_clean() {
  local s
  s=$(git status --porcelain 2>/dev/null) || return 1
  [ -z "$s" ]
}

# gate_dirty_files: the status lines that make the tree dirty, at most 20 and
# then a count. Every refusal on gate_tree_clean prints them: the check covers
# the whole repository (bench/, docs/, report/ as well as cf/, src/, test/), so
# a reader looking only where the code is would find nothing to explain it.
# The listing stops at 20 on purpose: a checkout with thousands of stray files
# would otherwise bury the refusal it explains; the count says how many more.
gate_dirty_files() {
  local s n
  s=$(git status --porcelain 2>&1) || { echo "  (git status failed: $s)"; return; }
  # sed reads to the end rather than `head` closing the pipe early, which under
  # a caller's `set -o pipefail` would fail the refusal before it is printed.
  n=$(printf '%s\n' "$s" | grep -c . || true)
  printf '%s\n' "$s" | sed -n '1,20s/^/  /p'
  if [ "$n" -gt 20 ]; then echo "  and $((n - 20)) more"; fi
}

# gate_dirty_advice: the next step after a refusal on gate_tree_clean. It
# names no cleaning command: the ignored files in a checkout include
# credentials (.dev.vars, .secrets), and the cleaning that also removes
# ignored files would delete them.
gate_dirty_advice() {
  echo "Deploy with cf/scripts/deploy-pinned.sh (a fresh worktree), or commit or move the listed files."
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

# suite_limits_problem: prints a line for every GATE_SUITE_LIMIT* setting that
# is not a whole number of seconds above zero, and returns non-zero if there was
# one. A limit `sleep` cannot read used to end the watchdog at once, which left
# the suite running with no limit at all — the one failure this exists to
# prevent, produced by a typo. Both gates ask before running anything, and
# suite_run_bounded refuses such a limit again, for any caller that did not.
suite_limits_problem() {
  local v bad=0
  for v in $(compgen -v GATE_SUITE_LIMIT); do
    if ! suite_limit_valid "${!v}"; then
      echo "refusing: $v=${!v} is not a whole number of seconds above zero, so it would not limit anything."
      bad=1
    fi
  done
  return "$bad"
}
suite_limit_valid() { [[ "$1" =~ ^[1-9][0-9]{0,6}$ ]]; }

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
# suite_live PGID: the pids in the group that have not ended. A process that has exited but whose
# parent has not reaped it keeps its pid, and `pgrep -g` keeps listing it, so a group in which every
# process is dead can still read as busy. In a container whose pid 1 does not reap — `docker run` with
# a shell as pid 1 is the default, and that shell does not call wait — a suite that spawned anything
# leaves zombies behind, and `suite_stop` then says "left processes running that could not be killed"
# about processes that ended. On 2026-10-18 that is how every DO suite in this repository read in such
# a container (184 zombies, pid 1 = /bin/sh, every assertion green). The state is what to ask; the test
# file already says why: "a zombie has ended and only waits to be reaped" (test/suite-timeout.ts).
suite_live() {
  local p stat
  for p in $(pgrep -g "$1" 2>/dev/null); do
    stat=$(ps -o stat= -p "$p" 2>/dev/null) || continue
    case "$stat" in Z*) continue ;; esac
    echo "$p"
  done
}

suite_stop() {
  local pgid="$1" grace
  [ -n "$(suite_live "$pgid")" ] || return 0
  kill -TERM -- "-$pgid" 2>/dev/null || true
  grace=$((SECONDS + 5))
  while [ "$SECONDS" -lt "$grace" ]; do [ -n "$(suite_live "$pgid")" ] || return 0; sleep 0.1; done
  kill -KILL -- "-$pgid" 2>/dev/null || true
  grace=$((SECONDS + 2))
  while [ "$SECONDS" -lt "$grace" ]; do [ -n "$(suite_live "$pgid")" ] || return 0; sleep 0.1; done
  [ -z "$(suite_live "$pgid")" ]
}

# The watchdog: `suite_watchdog LIMIT MARKER PGID`, run as a script of its own
# (below). It sleeps out the limit, writes MARKER, then ends the suite: its tree
# by pid, walked while it is still whole, and its group; TERM, up to 5 s, KILL.
SUITE_WATCHDOG='
  sleep "$1" || exit 1
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
  exit 0'

# suite_run_bounded LIMIT OUT COMMAND...: runs COMMAND with stdout and stderr
# in the file OUT and returns its status. Afterwards:
#   SUITE_TIMED_OUT=1  it was still running after LIMIT seconds, and was killed;
#   SUITE_ERROR=<why>  no verdict can be trusted: the limit was not a number,
#                      the watchdog was lost while the suite ran, or the suite's
#                      processes could not be ended. A caller refuses on it.
#
# COMMAND gets a session, and so a process group, of its own (`setsid`). That
# needs it NOT to lead a group already, or setsid forks, returns at once, and
# what is waited for is not the suite: so job control is turned off for the
# length of this function (`local -`), whatever the caller inherited — under
# `set -m` every background job leads its own group. Afterwards the group is
# ended whatever the verdict, so a suite that passed but left its server
# behind does not leave it to the next run either.
#
# What this cannot end: a process that left the session AND was not in the
# suite's tree when the limit came — a double fork into a new session, or a
# setsid'd child of a suite that then passed. No suite in test/ detaches.
#
# The limit is kept by a watchdog in its own group, so a suite that ends costs
# no wait. A watchdog that ends without having fired, while the suite still
# runs, is a lost limit, and the suite is ended and refused rather than left
# to run unbounded.
suite_run_bounded() {
  local -
  set +m
  local limit="$1" out="$2"; shift 2
  local pid watchdog status=0 dir done_pid
  SUITE_TIMED_OUT="" SUITE_ERROR=""
  if ! suite_limit_valid "$limit"; then
    SUITE_ERROR="limit '$limit' is not a whole number of seconds above zero; not run"
    : >"$out"; return 2
  fi
  dir=$(mktemp -d)
  setsid "$@" >"$out" 2>&1 </dev/null &
  pid=$!
  setsid bash -c "$(declare -f suite_descendants)$SUITE_WATCHDOG" watchdog "$limit" "$dir/timed-out" "$pid" \
    </dev/null >/dev/null 2>&1 &
  watchdog=$!
  # Interrupting the gate must not leave the suite running: in a session of its
  # own it no longer receives the terminal's ^C, nor the hangup.
  trap 'suite_interrupted 130' INT
  trap 'suite_interrupted 143' TERM
  trap 'suite_interrupted 129' HUP
  wait -n -p done_pid "$pid" "$watchdog" || true
  if [ "${done_pid:-}" = "$watchdog" ] && [ ! -e "$dir/timed-out" ]; then
    SUITE_ERROR="its time limit was lost (the watchdog ended without firing); stopped"
    kill -KILL $(suite_descendants "$pid") 2>/dev/null || true
    suite_stop "$pid" || true
  fi
  wait "$pid" 2>/dev/null || status=$?
  # A watchdog that has fired is left to finish its KILL round, which covers the
  # pids it found while the tree was whole; one that has not is cancelled — by
  # pid as well as by group, since one that has not yet reached setsid has no
  # group of its own and `wait` would sleep out its whole limit.
  if [ -e "$dir/timed-out" ]; then SUITE_TIMED_OUT=1; else
    kill -KILL -- "-$watchdog" 2>/dev/null || true; kill -KILL "$watchdog" 2>/dev/null || true
  fi
  # Reaped here, with stderr closed: reaped later, bash reports the KILL by
  # printing the watchdog's whole script into the gate's output.
  wait "$watchdog" 2>/dev/null || true
  trap - INT TERM HUP
  rm -rf "$dir"
  if ! suite_stop "$pid" && [ -z "$SUITE_ERROR" ]; then SUITE_ERROR="left processes running that could not be killed"; fi
  if [ -n "$SUITE_ERROR" ] && [ "$status" -eq 0 ]; then status=1; fi
  return "$status"
}

# The INT/TERM/HUP trap of suite_run_bounded, which runs in its scope: ends the
# watchdog and the suite, and exits with the signal's status.
suite_interrupted() {
  kill -KILL -- "-$watchdog" "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  kill -KILL $(suite_descendants "$pid") 2>/dev/null
  suite_stop "$pid"
  rm -rf "$dir"
  exit "$1"
}
