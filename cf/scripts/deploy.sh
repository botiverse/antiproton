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
exec npx wrangler deploy --var "GIT_COMMIT:${sha}" "$@"
