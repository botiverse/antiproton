#!/usr/bin/env bash
# Upload run records to the public bucket the report page links to.
#
# Two things this must not do: publish a credential, and let a published record
# differ from the record a figure was computed from. Both are checked here, and
# both fail closed — a check that cannot run stops the publish rather than
# waving it through.
set -uo pipefail

BUCKET=antiproton-report-runs
BASE=https://pub-212e604eb60944c6854033a8ee1b3cef.r2.dev
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="$ROOT/report/runs/manifest.tsv"

# Whether a file carries a credential shape is decided by secretMatch — the
# function the console and /agent/message refuse with, which asks each plugin
# for its own declaration (Piper, Ada, #354). A regex here would be a third
# copy of the GitHub shape and would drift: the copy this replaced already had,
# missing gho_/ghu_/ghs_/ghr_ that the declaration catches.
#
# Exit 0 = a shape was found (and named), 1 = clean, 2 = the check itself could
# not run. The caller treats 2 as fatal: an import error once read as "clean"
# and published a token to the public bucket.
carries_secret() {
  node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    const [root, file] = process.argv.slice(1);
    let secretMatch;
    try {
      ({ secretMatch } = await import(pathToFileURL(`${root}/cf/src/secret-shape.ts`).href));
    } catch (e) {
      console.error(`the credential check could not load secret-shape.ts: ${e.message}`);
      process.exit(2);
    }
    const hit = secretMatch(readFileSync(file, "utf8"));
    if (hit) { process.stdout.write(hit.kind); process.exit(0); }
    process.exit(1);
  ' "$ROOT" "$1"
}

sha() { sha256sum "$1" | cut -d' ' -f1; }

manifest_sha() { [ -f "$MANIFEST" ] && awk -F'\t' -v k="$1" '$1==k {print $2}' "$MANIFEST" | head -1; }

uploaded=0 skipped=0 refused=0 changed=0
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

for f in $(find "$ROOT/report/runs" -type f ! -path "$ROOT/report/runs/README.md" ! -path "$ROOT/report/runs/manifest.tsv" | sort); do
  key="runs/${f#"$ROOT"/report/runs/}"
  local_sha=$(sha "$f")

  # A record that changed after it was published is the case a hash exists to
  # catch: the figure on the page was computed from the old bytes.
  want=$(manifest_sha "$key")
  if [ -n "$want" ] && [ "$want" != "$local_sha" ]; then
    echo "CHANGED  $key — the local file no longer matches the manifest; not uploaded"
    changed=$((changed+1)); continue
  fi

  kind=$(carries_secret "$f"); code=$?
  case $code in
    0) echo "REFUSED  $key — looks like a ${kind}; it was not uploaded"; refused=$((refused+1)); continue;;
    1) ;;
    *) echo "STOPPED  the credential check failed on $key; nothing further was uploaded"; exit 2;;
  esac

  # Whether the bucket already has it is answered by the bytes, not by a 200:
  # a key can exist and hold something else (Ada, #354).
  if curl -fsS -o "$tmp/remote" -m 60 "$BASE/$key" 2>/dev/null; then
    if [ "$(sha "$tmp/remote")" = "$local_sha" ]; then
      skipped=$((skipped+1))
    else
      echo "DIFFERS  $key — the bucket holds different bytes under this key; not overwritten"
      changed=$((changed+1))
    fi
    continue
  fi

  case "$f" in
    *.json) ct="application/json";;
    *.log)  ct="text/plain; charset=utf-8";;
    *.md)   ct="text/markdown; charset=utf-8";;
    *)      ct="application/octet-stream";;
  esac
  if npx wrangler r2 object put "$BUCKET/$key" --file "$f" --content-type "$ct" \
       --cache-control "public, max-age=31536000, immutable" --remote > /dev/null 2>&1; then
    printf '%s\t%s\t%s\n' "$key" "$local_sha" "$(wc -c < "$f" | tr -d ' ')" >> "$MANIFEST"
    LC_ALL=C sort -o "$MANIFEST" "$MANIFEST"
    echo "uploaded $BASE/$key"
    uploaded=$((uploaded+1))
  else
    echo "FAILED   $key"
    refused=$((refused+1))
  fi
done

echo "uploaded=$uploaded verified=$skipped refused=$refused changed=$changed"
[ "$refused" -eq 0 ] && [ "$changed" -eq 0 ]
