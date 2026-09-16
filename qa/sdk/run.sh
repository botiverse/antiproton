#!/usr/bin/env bash
# Manually triggered QA for the OpenAI-compatible agents API (task #17). Run it when it is
# needed; it is not part of any merge or deploy (tygg, 2026-09-15).
#
#   qa/sdk/run.sh [contract|model|all]      (default: contract)
#   QA_ONLY=<substring> qa/sdk/run.sh model  runs matching scenarios only
#
# Target: the preview deployment only (antiproton-preview), where /v1 is deployed.
# Each run issues its own API key. For the model tiers the DeepSeek key from
# ~/.secrets/antiproton.env is put on the preview Worker for the run and deleted on
# exit, whatever happens; it is read from that file only and never printed.
set -euo pipefail
tier="${1:-contract}"
case "$tier" in contract|model|all) ;; *) echo "usage: qa/sdk/run.sh [contract|model|all]" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
base="https://preview.antiproton.ai"

set -a; . "$HOME/.secrets/antiproton.env"; set +a
[ -d "$here/node_modules/openai" ] || (cd "$here" && npm ci --no-audit --no-fund --silent)

key=$(curl -s -H "x-harness-token: $PREVIEW_AUTOMATION_TOKEN" -H 'content-type: application/json' \
  -X POST "$base/admin/api-keys" -d "{\"tenantId\":\"demo\",\"ownerAgentId\":\"u-qa-sdk\",\"label\":\"qa-$tier-$(date -u +%Y%m%dT%H%M%SZ)\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("key",""))' 2>/dev/null || true)
[ -n "$key" ] || { echo "could not issue an API key on $base" >&2; exit 1; }

model_key_on=""
cleanup() {
  if [ -n "$model_key_on" ]; then
    if (cd "$repo/cf" && npx wrangler secret delete DEEPSEEK_API_KEY --config wrangler.preview.jsonc </dev/null >/dev/null 2>&1); then
      echo "  model key removed from antiproton-preview"
    else
      echo "  WARNING: DEEPSEEK_API_KEY could not be removed from antiproton-preview; remove it by hand" >&2
    fi
  fi
}
trap cleanup EXIT

if [ "$tier" != "contract" ]; then
  # The preview Worker now carries the dev key as a standing secret (tygg,
  # 2026-09-16: "预览worker 也用开发的 key"). Putting our own copy would be
  # harmless; deleting it on the way out would not — cleanup removes whatever
  # is there, so a run that borrowed an existing secret would take it with it.
  # So only add, and only clean up, when the Worker had none.
  if (cd "$repo/cf" && npx wrangler secret list --config wrangler.preview.jsonc 2>/dev/null \
        | grep -q '"name": *"DEEPSEEK_API_KEY"'); then
    echo "  antiproton-preview already holds a model key; leaving it alone"
  else
    printf '%s' "$DEEPSEEK_API_KEY" | (cd "$repo/cf" && npx wrangler secret put DEEPSEEK_API_KEY --config wrangler.preview.jsonc >/dev/null 2>&1)
    model_key_on=1
    echo "  model key put on antiproton-preview for this run; waiting 30s for the new version to take traffic"
    sleep 30
  fi
fi

OPENAI_BASE_URL="$base/v1" OPENAI_API_KEY="$key" QA_TIER="$tier" node "$here/run.mjs"
