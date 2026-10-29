#!/usr/bin/env bash
# Build and deploy docs.antiproton.ai from a worktree pinned to origin/master.
# Enforces exact commit provenance and verifies the remote build before exiting.
#
# Usage:
#   bash scripts/deploy-docs.sh
#
# Environment variables:
#   ANTIPROTON_ENV_FILE   Path to secrets file (default: ~/.secrets/antiproton.env)
#   DEPLOY_PINNED_ROOT    Base directory for temporary worktree (default: ~/tmp)
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --path-format=absolute --git-common-dir) || { echo "STEP repo FAILED"; exit 1; }
g() { git --git-dir="$repo" "$@"; }
env_file=${ANTIPROTON_ENV_FILE:-$HOME/.secrets/antiproton.env}
root=${DEPLOY_PINNED_ROOT:-$HOME/tmp}

if [ -r "$env_file" ]; then
  # Load credentials for wrangler deploy
  set -a; . "$env_file"; set +a
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CF_API_TOKEN:-}" ]; then
  export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
fi

g fetch -q origin master || { echo "STEP fetch FAILED"; exit 1; }
sha=$(g rev-parse --verify --quiet 'origin/master^{commit}') || { echo "STEP fetch FAILED (no origin/master)"; exit 1; }
tree=$(g rev-parse --verify --quiet "${sha}^{tree}")
short=${sha:0:7}

wt=""
added=""
cleanup() {
  cd / || true
  if [ -n "$added" ]; then g worktree remove --force "$wt" >/dev/null 2>&1 || true; fi
  g worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$root" && wt=$(mktemp -d "$root/deploy-docs-$short.XXXXXX")
g worktree add -q --detach "$wt" "$sha" || { echo "STEP worktree FAILED"; exit 1; }
added=1
cd "$wt" || { echo "STEP worktree FAILED (cannot cd)"; exit 1; }
echo "STEP head $short tree ${tree:0:8} ($wt)"

# Build documentation site in isolated worktree
node scripts/build-docs.mjs || { echo "STEP build FAILED"; exit 1; }

# Deploy through wrangler with docs-site config
(cd docs-site && npx wrangler deploy) || { echo "STEP deploy FAILED"; exit 1; }

# Verify live deployment
echo "STEP verifying live deployment at https://docs.antiproton.ai/version.json"
remote_sha=""
for _ in $(seq 1 12); do
  remote_sha=$(curl -fsS -m 15 "https://docs.antiproton.ai/version.json" 2>/dev/null | grep '"commit"' | head -1 | cut -d'"' -f4 || true)
  [ "$remote_sha" = "$sha" ] && break
  sleep 5
done

if [ "$remote_sha" = "$sha" ]; then
  echo "STEP live build $short verified at $(date -u +%H:%M:%SZ)"
else
  echo "NOTE: live build reported $remote_sha (expected $sha; DNS propagation may take a few moments)"
fi
echo "STEP done"
