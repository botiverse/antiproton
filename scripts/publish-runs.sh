#!/usr/bin/env bash
# Upload run records to the public bucket the report page links to.
#
# The bucket is world-readable, so this refuses a file that carries a
# credential shape. That check is a net, not a proof: a record is the output of
# an agent that held real mounts. Read what you publish.
set -uo pipefail

BUCKET=antiproton-report-runs
BASE=https://pub-212e604eb60944c6854033a8ee1b3cef.r2.dev
ROOT=$(cd "$(dirname "$0")/.." && pwd)

# Whether a file carries a credential shape is decided by secretMatch — the
# same function the console and /agent/message refuse with, which asks each
# plugin for its own declaration (Piper, #354). A regex copied to here would be
# a third copy of the GitHub shape and would drift from the declaration; the
# first copy of it already did.
carries_secret() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { secretMatch } from "./cf/src/secret-shape.ts";
    const hit = secretMatch(readFileSync(process.argv[1], "utf8"));
    if (hit) { process.stdout.write(hit.kind); process.exit(0); }
    process.exit(1);
  ' "$1" 2>/dev/null
}

uploaded=0 skipped=0 refused=0
for f in $(find "$ROOT/report/runs" -type f ! -name README.md | sort); do
  key="runs/${f#"$ROOT"/report/runs/}"
  if kind=$(carries_secret "$f"); then
    echo "REFUSED  $key — looks like a ${kind}; it was not uploaded"
    refused=$((refused+1)); continue
  fi
  if curl -fsS -o /dev/null -m 20 --head "$BASE/$key" 2>/dev/null; then
    skipped=$((skipped+1)); continue
  fi
  case "$f" in
    *.json) ct="application/json";;
    *.log)  ct="text/plain; charset=utf-8";;
    *.md)   ct="text/markdown; charset=utf-8";;
    *)      ct="application/octet-stream";;
  esac
  if npx wrangler r2 object put "$BUCKET/$key" --file "$f" --content-type "$ct" \
       --cache-control "public, max-age=31536000, immutable" --remote > /dev/null 2>&1; then
    echo "uploaded $BASE/$key"
    uploaded=$((uploaded+1))
  else
    echo "FAILED   $key"
    refused=$((refused+1))
  fi
done
echo "uploaded=$uploaded already-there=$skipped refused-or-failed=$refused"
[ "$refused" -eq 0 ]
