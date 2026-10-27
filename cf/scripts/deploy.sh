#!/usr/bin/env bash
# Deploy a Worker with the commit it is built from, so whoami can say which
# code is running and the bench records can name it. Any arguments go to
# wrangler (e.g. --config wrangler.preview.jsonc). Refuses a dirty tree: a
# commit id that does not describe the deployed bytes is worse than none.
set -euo pipefail
cd "$(dirname "$0")/.."
# Dirty means what the gates mean by it (scripts/suite-verdict.sh,
# gate_tree_clean): the whole repository, untracked files included, since an
# untracked file elsewhere can still be imported into the bundle.
. scripts/suite-verdict.sh
if ! gate_tree_clean; then
  echo "deploy.sh: the working tree is not HEAD's (uncommitted or untracked files)" >&2
  gate_dirty_files >&2
  gate_dirty_advice >&2
  exit 1
fi
# ANTIPROTON_DEPLOY_COMMIT is the commit a gate verified (verify-and-deploy.sh
# sets it). The stamp comes from it, and a HEAD that is not it is refused: a
# HEAD read here, after the gate, once named a commit no suite had run on.
# Unset, the stamp is HEAD, as for a preview deploy run by hand.
head="$(git rev-parse HEAD)"
if [ -n "${ANTIPROTON_DEPLOY_COMMIT:-}" ]; then
  pinned="$(git rev-parse --verify --quiet "${ANTIPROTON_DEPLOY_COMMIT}^{commit}" || true)"
  if [ "$pinned" != "$head" ]; then
    echo "deploy.sh: refusing: asked to deploy ${ANTIPROTON_DEPLOY_COMMIT} but HEAD is ${head}" >&2
    exit 1
  fi
fi
sha="${head:0:7}"
# The control plane's schema before the code that reads it: a Worker querying a
# table D1 does not have yet refuses every sign-in until it lands. Applying is
# idempotent (wrangler records what it applied), and CI=1 skips the prompt it
# shows in a terminal. Only --config is passed on; the rest belongs to deploy.
config=()
prev=""
for a in "$@"; do
  case "$a" in --config=*) config=("$a");; esac
  if [ "$prev" = "--config" ] || [ "$prev" = "-c" ]; then config=(--config "$a"); fi
  prev="$a"
done
CI=1 npx wrangler d1 migrations apply CONTROL_DB --remote "${config[@]}"
exec npx wrangler deploy --var "GIT_COMMIT:${sha}" "$@"
