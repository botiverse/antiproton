#!/usr/bin/env bash
# Gate and deploy the current origin/master from a worktree of its own.
#   cf/scripts/deploy-pinned.sh            production: the full gate (verify-and-deploy.sh), then the live build
#   cf/scripts/deploy-pinned.sh --preview  preview: deploy.sh --config wrangler.preview.jsonc, then the live build
#
# The way to deploy from a shared machine. A checkout several people use can be
# moved while the gate runs in it: on 2026-10-27 a `git pull` in one moved HEAD
# from d720378 to 0897622 during the suites, and the commit that shipped was
# not the one they ran on. verify-and-deploy.sh now refuses when that happens,
# and refuses a checkout with untracked files, which a shared one often has;
# a refusal is not a deploy. A worktree made here, at one SHA, under a fresh
# directory nobody else knows about, is never moved by anyone else, so the
# gate's verdict and the deploy are about the same tree by construction.
#
# Nothing here touches the checkout the script was run from: only fetch and
# the worktree commands, which change refs and the worktree list, never its
# files or its HEAD.
#
# Settings, all optional:
#   ANTIPROTON_ENV_FILE  the secrets file deploy needs (default ~/.secrets/antiproton.env)
#   DEPLOY_PINNED_ROOT   where the worktree is made (default ~/tmp; /tmp is often
#                        a small tmpfs, and the worktree holds a full node_modules)
#   DEPLOY_BELOW_FLOOR   an emergency rollback below a deploy floor: the full SHA of
#   DEPLOY_BELOW_FLOOR_REASON  every floor it crosses (space-separated), and why.
#                        Both or neither; see cf/deploy-floors.txt and
#                        docs/runbook.md, "Deploy floors".
set -uo pipefail
mode=prod
case "${1:-}" in
  "") ;;
  --preview) mode=preview ;;
  *) echo "usage: $0 [--preview]" >&2; exit 2 ;;
esac

# The repository by its common git dir, so the worktree joins the same
# repository whichever of its worktrees this script was run from.
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --path-format=absolute --git-common-dir) || { echo "STEP repo FAILED (not in a git repository: $here)"; exit 1; }
g() { git --git-dir="$repo" "$@"; }
env_file=${ANTIPROTON_ENV_FILE:-$HOME/.secrets/antiproton.env}
root=${DEPLOY_PINNED_ROOT:-$HOME/tmp}

# Before anything slow: a deploy that cannot read its credentials fails after
# the whole gate otherwise.
[ -r "$env_file" ] || { echo "STEP env FAILED (cannot read $env_file; set ANTIPROTON_ENV_FILE)"; exit 1; }

g fetch -q origin master || { echo "STEP fetch FAILED"; exit 1; }
sha=$(g rev-parse --verify --quiet 'origin/master^{commit}') || { echo "STEP fetch FAILED (no origin/master)"; exit 1; }
short=${sha:0:7}

# Deploy floors (cf/deploy-floors.txt): commits whose ancestry the deployed
# commit must contain, because something outside this repository already
# depends on what they changed. Read from the commit being deployed, so the
# answer is about that tree, and also from the copy beside this script, so a
# floor deleted in the target is still enforced by any checkout that has it.
# Checked before the worktree and npm ci: a refusal costs nothing.
floors_rel=cf/deploy-floors.txt
# stdin: a floors file; $1: where it came from. stdout: "<sha>\t<from>\t<reason>"
# per floor, or "BAD\t<from>\t<line>".
parse_floors() {
  local line reason="" entry
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%$'\r'}
    case "$line" in
      "") reason="" ;;
      \#*) line=${line#\#}; reason="${reason:+$reason }${line# }" ;;
      *)
        entry=${line%%#*}; entry=${entry//[[:space:]]/}
        case "$line" in *\#*) line=${line#*#}; reason="${reason:+$reason }${line# }" ;; esac
        if [[ "$entry" =~ ^[0-9a-f]{40}$ ]]; then printf '%s\t%s\t%s\n' "$entry" "$1" "$reason"
        else printf 'BAD\t%s\t%s\n' "$1" "$line"; fi
        reason="" ;;
    esac
  done
}
below=${DEPLOY_BELOW_FLOOR:-}
below_reason=${DEPLOY_BELOW_FLOOR_REASON:-}
if [ -n "$below" ] && [ -z "$below_reason" ]; then echo "STEP floor FAILED (DEPLOY_BELOW_FLOOR needs DEPLOY_BELOW_FLOOR_REASON: why production may run below it)"; exit 1; fi
if [ -z "$below" ] && [ -n "$below_reason" ]; then echo "STEP floor FAILED (DEPLOY_BELOW_FLOOR_REASON without DEPLOY_BELOW_FLOOR names no floor)"; exit 1; fi
floors=""
if target_floors=$(g show "$sha:$floors_rel" 2>/dev/null); then
  floors=$(printf '%s\n' "$target_floors" | parse_floors target)
elif [ -z "$below" ]; then
  # Every floor is listed in a commit at or after it, so a commit without the
  # file is older than all of them.
  echo "STEP floor FAILED ($short has no $floors_rel, so it predates every deploy floor; an emergency rollback below a floor is DEPLOY_BELOW_FLOOR, docs/runbook.md)"
  exit 1
fi
local_floors_file="$here/../deploy-floors.txt"
if [ -f "$local_floors_file" ]; then
  floors=$(printf '%s\n%s\n' "$floors" "$(parse_floors local < "$local_floors_file")")
fi
floors=$(printf '%s\n' "$floors" | awk -F'\t' 'NF && !seen[$1]++')
if [ -z "$floors" ]; then
  if [ -n "$below" ]; then echo "STEP floor FAILED (no $floors_rel in $short or beside this script, so there is no floor for DEPLOY_BELOW_FLOOR to cross)"; exit 1; fi
  echo "STEP floor FAILED ($floors_rel in $short lists no floor)"; exit 1
fi
bad=$(printf '%s\n' "$floors" | awk -F'\t' '$1 == "BAD" { print $3 }')
if [ -n "$bad" ]; then echo "STEP floor FAILED (not a full 40-character SHA in $floors_rel: $bad)"; exit 1; fi
crossed=""
while IFS=$'\t' read -r floor from reason; do
  # The SHA must be a commit here before ancestry can be asked; origin/master
  # was just fetched, and a floor is a master commit.
  if ! g cat-file -e "$floor^{commit}" 2>/dev/null; then
    echo "STEP floor FAILED (cannot check floor $floor: commit missing locally or git error — this is not a floor violation; fetch and retry)"
    exit 1
  fi
  g merge-base --is-ancestor "$floor" "$sha"
  rc=$?
  case $rc in
    0) ;;
    1)
      case " $below " in
        *" $floor "*) crossed="$crossed $floor"; echo "WARNING: deploying $short BELOW floor $floor: $reason" ;;
        *)
          # A floor only the local copy lists: master's file lost it, or this
          # checkout is ahead of origin/master. Either way it still holds.
          [ "$from" = local ] && reason="$reason [listed in this checkout's $floors_rel but not in $short's]"
          echo "STEP floor FAILED (floor not satisfied: $floor $reason) — $short does not contain it. An emergency rollback below it is DEPLOY_BELOW_FLOOR=$floor with DEPLOY_BELOW_FLOOR_REASON (docs/runbook.md)"; exit 1 ;;
      esac ;;
    # Anything else is git failing to answer, which is never a pass.
    *) echo "STEP floor FAILED (cannot check floor $floor: commit missing locally or git error $rc — this is not a floor violation; fetch and retry)"; exit 1 ;;
  esac
done <<< "$floors"
for f in $below; do
  case " $crossed " in
    *" $f "*) ;;
    *) echo "STEP floor FAILED (DEPLOY_BELOW_FLOOR names $f, which is not a floor $short is below; name exactly the floors crossed)"; exit 1 ;;
  esac
done
# A deploy below a floor leaves a marker, so the next deploy that satisfies
# every floor says production is back above them. Written before the deploy
# step, since a deploy that reports failure may still have shipped.
marker="$HOME/tmp/antiproton-below-floor.$mode"
if [ -n "$crossed" ]; then
  at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$HOME/tmp" && printf '%s %s %s\n' "$at" "$short" "$crossed" >> "$marker" \
    || { echo "STEP floor FAILED (cannot write the marker $marker)"; exit 1; }
  for f in $crossed; do echo "STEP deploy crossed floor $f at $at: $below_reason"; done
  echo "WARNING: production will run a build below a deploy floor. Tell Raft (AppFather) now: its web may already depend on what the floor changed." >&2
fi
echo "STEP floor ok ($(printf '%s\n' "$floors" | wc -l | tr -d ' ') checked${crossed:+, crossed:$crossed})"

wt=""
added=""
cleanup() {
  cd / || true
  if [ -n "$added" ]; then g worktree remove --force "$wt" >/dev/null 2>&1 || echo "STEP cleanup FAILED (remove it by hand: git --git-dir=$repo worktree remove --force $wt)"
  elif [ -n "$wt" ]; then rmdir "$wt" 2>/dev/null || true
  fi
  g worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT
# A unique directory rather than a name derived from the SHA alone: two runs
# of the same SHA must not share, or remove, each other's worktree.
{ mkdir -p "$root" && wt=$(mktemp -d "$root/deploy-pinned-$short-$mode.XXXXXX"); } 2>/dev/null || { wt=""; echo "STEP worktree FAILED (cannot make a directory under $root)"; exit 1; }
g worktree add -q --detach "$wt" "$sha" || { echo "STEP worktree FAILED"; exit 1; }
added=1
cd "$wt" || { echo "STEP worktree FAILED (cannot enter $wt)"; exit 1; }
echo "STEP head $short tree $(git rev-parse 'HEAD^{tree}' | cut -c1-8) ($mode, $wt)"

# A real install, not a link to another checkout's node_modules: a dependency
# bump would otherwise be gated and deployed against the old packages.
npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 || { echo "STEP npm ci FAILED"; exit 1; }

if [ "$mode" = prod ]; then
  ANTIPROTON_ENV_FILE="$env_file" bash cf/scripts/verify-and-deploy.sh || { echo "STEP deploy FAILED"; exit 1; }
  url=https://antiproton.ai/ui/whoami
else
  (cd cf && set -a && . "$env_file" && set +a && ANTIPROTON_DEPLOY_COMMIT="$sha" bash scripts/deploy.sh --config wrangler.preview.jsonc) || { echo "STEP deploy FAILED"; exit 1; }
  url=https://preview.antiproton.ai/ui/whoami
fi
# Nothing else knows this worktree, so a moved HEAD here is a defect in this
# script or the gate, and the deploy above is not the SHA it was told.
[ "$(git rev-parse HEAD)" = "$sha" ] || { echo "STEP worktree HEAD moved to $(git rev-parse --short HEAD) (expected $short)"; exit 1; }

# The live build, with the time it was read: a deploy reports success before
# every edge serves it, and "live" without a time cannot be compared with a
# later reading.
b=
for _ in $(seq 1 24); do
  b=$(curl -fsS -m 20 "$url" 2>/dev/null | sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p')
  [ "$b" = "$short" ] && break
  sleep 5
done
echo "STEP live build ${b:-none} read $(date -u +%H:%M:%SZ)"
[ "$b" = "$short" ] || { echo "STEP live build MISMATCH (expected $short)"; exit 1; }
if [ -z "$crossed" ] && [ -f "$marker" ]; then
  echo "STEP back above all floors (previous deploy crossed$(awk '{ for (i = 3; i <= NF; i++) printf " %s", $i }' "$marker"))"
  rm -f "$marker"
fi
echo "STEP done"
