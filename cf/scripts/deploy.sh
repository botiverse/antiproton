#!/usr/bin/env bash
# Deploy a Worker with the commit it is built from, so whoami can say which
# code is running and the bench records can name it. Any arguments go to
# wrangler (e.g. --config wrangler.preview.jsonc). Refuses a dirty tree: a
# commit id that does not describe the deployed bytes is worse than none.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain -- . ../src ../test 2>/dev/null)" ]; then
  echo "deploy.sh: working tree has uncommitted changes under cf/, src/ or test/; commit first" >&2
  exit 1
fi
sha="$(git rev-parse --short=7 HEAD)"
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
