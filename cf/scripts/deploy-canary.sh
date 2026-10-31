#!/usr/bin/env bash
# Deploy one named commit to the canary (cf/wrangler.canary.jsonc, canary.antiproton.ai), the staging-only
# environment where a reviewed branch commit is run against staging Raft before it is merged.
#
#   bash cf/scripts/deploy-canary.sh <commit sha>
#
# The commit is the argument, never "whatever is checked out": the shared checkout is left on other people's
# branches, so this builds in a worktree of its own at that commit, runs `npm ci` and the branch gate
# (cf/scripts/gate.sh) there, and only then hands the tree to
# cf/scripts/deploy.sh, which applies the D1 migrations to the canary database and deploys with GIT_COMMIT set.
# The last step asks the canary's /ui/whoami which build it serves, and fails unless it is this commit.
#
# Refused before anything is built: a sha that is not hex, one no ref on origin contains (an unpushed commit has
# not been reviewed), a commit without cf/wrangler.canary.jsonc (rebase it onto master), and a canary config whose
# database_id is still the placeholder (docs/runbook.md "Canary environment" creates the database first).
#
# CANARY_ORIGIN overrides where the build is checked (the workers.dev URL, before the custom domain is attached).
set -uo pipefail

step() { echo "STEP $*"; }
refuse() { step "refused: $*"; exit 1; }

sha_arg="${1:-}"
[ $# -eq 1 ] || { echo "usage: $0 <commit sha>" >&2; exit 2; }
printf '%s' "$sha_arg" | grep -Eq '^[0-9a-f]{7,40}$' || refuse "'$sha_arg' is not a commit sha (7 to 40 lowercase hex)"

repo="$(cd "$(dirname "$0")/../.." && pwd)"
git -C "$repo" fetch -q origin || { step "fetch FAILED"; exit 1; }
sha=$(git -C "$repo" rev-parse --verify --quiet "${sha_arg}^{commit}") || refuse "$sha_arg is not a commit in this repository after fetching origin"
on_origin=$(git -C "$repo" for-each-ref --contains "$sha" --format='%(refname:short)' refs/remotes/origin | head -3 | tr '\n' ' ')
[ -n "$on_origin" ] || refuse "${sha:0:7} is on no branch of origin; push it (and have it reviewed) first"
step "commit $sha (on ${on_origin% })"

config=$(git -C "$repo" show "$sha:cf/wrangler.canary.jsonc" 2>/dev/null) || refuse "${sha:0:7} has no cf/wrangler.canary.jsonc; rebase it onto origin/master"
case "$config" in *PLACEHOLDER*) refuse "cf/wrangler.canary.jsonc at ${sha:0:7} still has the placeholder database_id; create the D1 database and commit its id first";; esac
# What the canary binds is master's decision; a branch's older copy still deploys, but says so.
if ! git -C "$repo" diff --quiet "origin/master" "$sha" -- cf/wrangler.canary.jsonc; then
  step "note: cf/wrangler.canary.jsonc at ${sha:0:7} differs from origin/master's"
fi

# A worktree of its own, removed on every exit. Under ~/tmp, never the shared /tmp.
base="${CANARY_TMP:-$HOME/tmp}"
mkdir -p "$base"
wt=$(mktemp -d "$base/canary-${sha:0:7}-XXXXXX")
cleanup() { git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || rm -rf "$wt"; git -C "$repo" worktree prune; }
trap cleanup EXIT
git -C "$repo" worktree add -q --detach "$wt" "$sha" || { step "worktree FAILED"; exit 1; }
cd "$wt" || exit 1
[ "$(git rev-parse HEAD)" = "$sha" ] || refuse "the worktree is at $(git rev-parse --short HEAD), not ${sha:0:7}"
step "worktree $wt"

npm ci --no-audit --no-fund >"$wt.npm-ci.log" 2>&1 || { step "npm ci FAILED (log: $wt.npm-ci.log)"; exit 1; }
rm -f "$wt.npm-ci.log"
# npm ci must not have rewritten a tracked file (package-lock.json): the build would no longer be the commit.
[ -z "$(git status --porcelain --untracked-files=no)" ] || refuse "the tree at ${sha:0:7} is dirty after npm ci: $(git status --porcelain --untracked-files=no | head -3 | tr '\n' ' ')"
step "npm ci ok"

# The whole branch gate, as a merge would need it. The host is shared, so it waits for a quiet moment first.
while load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null) && [ -n "$load" ] && awk -v l="$load" 'BEGIN { exit !(l > 12) }'; do
  step "waiting: load $load > 12"; sleep 60
done
gate_log="$wt.gate.log"
if ! bash cf/scripts/gate.sh >"$gate_log" 2>&1; then
  tail -40 "$gate_log"; step "gate FAILED (log: $gate_log)"; exit 1
fi
tail -3 "$gate_log"; rm -f "$gate_log"
step "gate ok"

# Secrets only now, after every suite, as verify-and-deploy.sh does. deploy.sh refuses a dirty tree again,
# applies cf/migrations to antiproton-canary-control, and deploys with GIT_COMMIT=<sha:7>.
(cd cf && set -a && . "$HOME/.secrets/antiproton.env" && set +a && bash scripts/deploy.sh --config wrangler.canary.jsonc) \
  || { step "deploy FAILED"; exit 1; }
step "deployed"

origin="${CANARY_ORIGIN:-https://canary.antiproton.ai}"
want="${sha:0:7}"
b=""
for _ in $(seq 1 12); do
  b=$(curl -fsS -m 20 "$origin/ui/whoami" 2>/dev/null | sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p')
  [ "$b" = "$want" ] && break
  sleep 5
done
step "live build ${b:-none} at $origin"
[ "$b" = "$want" ] || { step "verify FAILED: expected $want"; exit 1; }
step "done"
