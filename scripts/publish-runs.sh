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

# The shapes cf/src/secret-shape.ts recognises, plus the generic ones a runner
# could echo. Kept here rather than imported: this script runs without a build.
SECRET_RE='ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[baprs]-[A-Za-z0-9-]{10,}|postgres(ql)?://[^[:space:]"]*:[^[:space:]"@]*@|ap-[A-Za-z0-9_-]{24,}'

uploaded=0 skipped=0 refused=0
for f in $(find "$ROOT/report/runs" -type f ! -name README.md | sort); do
  key="runs/${f#"$ROOT"/report/runs/}"
  if grep -qE "$SECRET_RE" "$f"; then
    echo "REFUSED  $key — credential shape in the file; it was not uploaded"
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
