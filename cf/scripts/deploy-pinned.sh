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
echo "STEP done"
