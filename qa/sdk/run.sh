#!/usr/bin/env bash
# Manually triggered QA for the OpenAI-compatible agents API (task #17). Run it when it is
# needed; it is not part of any merge or deploy (tygg, 2026-09-15).
#
#   qa/sdk/run.sh [contract|model|all]      (default: contract)
#   QA_ONLY=<substring> qa/sdk/run.sh model  runs matching scenarios only
#
#   QA_BASE=https://antiproton.ai qa/sdk/run.sh contract
#                                      same suite against production
#
# Target: preview (antiproton-preview) by default. `docs/agents-api.md` says /v1 is live on
# production as well, so the same scenarios have to be runnable there — the deploy the QA is
# supposed to stand behind is the one users reach. The operator token that issues this run's
# key follows from the target (PREVIEW_AUTOMATION_TOKEN on preview, AUTOMATION_TOKEN on
# production), and any other address is refused unless QA_BASE_ALLOW=1: an operator token must
# not travel to an address someone typed by accident.
#
# Each run issues its own API key. For the model tiers the DeepSeek key from
# ~/.secrets/antiproton.env is put on the target Worker for the run and deleted on
# exit, whatever happens; it is read from that file only and never printed. On production it
# is never put: a QA run does not add a model credential to the deployment users reach.
set -euo pipefail
tier="${1:-contract}"
case "$tier" in contract|model|all) ;; *) echo "usage: qa/sdk/run.sh [contract|model|all]" >&2; exit 2;; esac
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
base="${QA_BASE:-https://preview.antiproton.ai}"
case "$base" in
  https://preview.antiproton.ai) token_var=PREVIEW_AUTOMATION_TOKEN; wrangler_config=wrangler.preview.jsonc; worker=antiproton-preview; prod=0 ;;
  https://antiproton.ai) token_var=AUTOMATION_TOKEN; wrangler_config=wrangler.jsonc; worker=antiproton; prod=1 ;;
  *)
    if [ "${QA_BASE_ALLOW:-0}" != "1" ]; then
      echo "refusing: QA_BASE=$base is not a deployment this script knows (preview or production)." >&2
      echo "If you mean it, state it: QA_BASE_ALLOW=1 QA_BASE=$base $0 ${1:-contract}" >&2
      exit 2
    fi
    token_var=AUTOMATION_TOKEN; wrangler_config=wrangler.jsonc; worker=antiproton; prod=1 ;;
esac

set -a; . "$HOME/.secrets/antiproton.env"; set +a
token="${!token_var:-}"
[ -n "$token" ] || { echo "$token_var is empty: it issues this run's key on $base" >&2; exit 2; }
[ -d "$here/node_modules/openai" ] || (cd "$here" && npm ci --no-audit --no-fund --silent)

# Whether the target already carries a model key is asked BEFORE the run issues its own API key:
# the production refusal below must not leave an issued key behind that nothing used.
has_model_key=0
if [ "$tier" != "contract" ] && (cd "$repo/cf" && npx wrangler secret list --config "$wrangler_config" 2>/dev/null \
      | grep -q '"name": *"DEEPSEEK_API_KEY"'); then
  has_model_key=1
fi
if [ "$tier" != "contract" ] && [ "$has_model_key" = "0" ] && [ "$prod" = "1" ]; then
  echo "refusing: $worker has no DEEPSEEK_API_KEY, and a QA run does not put a model credential on production." >&2
  echo "Run the contract tier there, or use the preview Worker for the model tier." >&2
  exit 1
fi

key=$(curl -s -H "x-harness-token: $token" -H 'content-type: application/json' \
  -X POST "$base/admin/api-keys" -d "{\"tenantId\":\"demo\",\"ownerAgentId\":\"u-qa-sdk\",\"label\":\"qa-$tier-$(date -u +%Y%m%dT%H%M%SZ)\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin).get("key",""))' 2>/dev/null || true)
[ -n "$key" ] || { echo "could not issue an API key on $base" >&2; exit 1; }

model_key_on=""
cleanup() {
  if [ -n "$model_key_on" ]; then
    if (cd "$repo/cf" && npx wrangler secret delete DEEPSEEK_API_KEY --config "$wrangler_config" </dev/null >/dev/null 2>&1); then
      echo "  model key removed from $worker"
    else
      echo "  WARNING: DEEPSEEK_API_KEY could not be removed from $worker; remove it by hand" >&2
    fi
  fi
}
trap cleanup EXIT

if [ "$tier" != "contract" ]; then
  # The preview Worker now carries the dev key as a standing secret (tygg,
  # 2026-09-16: "预览worker 也用开发的 key"). Putting our own copy would be
  # harmless; deleting it on the way out would not — cleanup removes whatever
  # is there, so a run that borrowed an existing secret would take it with it.
  # So only add, and only clean up, when the Worker had none. Production never
  # reaches this branch without the key: it was refused above.
  if [ "$has_model_key" = "1" ]; then
    echo "  $worker already holds a model key; leaving it alone"
  else
    printf '%s' "$DEEPSEEK_API_KEY" | (cd "$repo/cf" && npx wrangler secret put DEEPSEEK_API_KEY --config "$wrangler_config" >/dev/null 2>&1)
    model_key_on=1
    echo "  model key put on $worker for this run; waiting 30s for the new version to take traffic"
    sleep 30
  fi
fi

OPENAI_BASE_URL="$base/v1" OPENAI_API_KEY="$key" QA_TIER="$tier" node "$here/run.mjs"
