#!/usr/bin/env bash
# Upload run records to the public bucket the report page links to.
#
# Two things this must not do: publish a credential, and let a published record
# differ from the record a figure was computed from. Both are checked here, and
# both fail closed — a check that cannot run stops the publish rather than
# waving it through.
set -uo pipefail

BUCKET=antiproton-report-runs
# Overridable so the tests can point at an address that answers nothing; the
# default is the bucket the report page links to.
BASE=${PUBLISH_RUNS_BASE:-https://pub-212e604eb60944c6854033a8ee1b3cef.r2.dev}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST="$ROOT/report/runs/manifest.tsv"

# wrangler reads CLOUDFLARE_API_TOKEN; this repo's credential file calls the
# same value CF_API_TOKEN. Without this, every check passed and the run died at
# the upload, which is the last place a person can act on it (Vera, 2026-09-16).
# Asked here instead, before anything is read or fetched.
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if [ -n "${CF_API_TOKEN:-}" ]; then
    export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
  else
    echo "publishing needs a Cloudflare API token, and none is set." >&2
    echo "wrangler reads CLOUDFLARE_API_TOKEN; ours is CF_API_TOKEN in ~/.secrets/antiproton.env." >&2
    echo "  set -a; . ~/.secrets/antiproton.env; set +a; bash scripts/publish-runs.sh" >&2
    echo "Nothing was read or uploaded." >&2
    exit 3
  fi
fi

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
    let hit;
    try {
      const { secretMatch } = await import(pathToFileURL(`${root}/cf/src/secret-shape.ts`).href);
      hit = secretMatch(readFileSync(file, "utf8"));
    } catch (e) {
      // Loading the matcher, reading the file and running the match are all
      // "could not judge". Each exits 1 on its own, and 1 is what the caller
      // reads as clean, so all three are mapped here instead (Ada, #354):
      // a plugin whose looksLike regex throws must stop the publish.
      console.error(`the credential check could not run on ${file}: ${e.message}`);
      process.exit(2);
    }
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
    # Replace this key's row rather than adding one. Appending blind duplicates
    # a key whenever the row already exists — which is the normal case when the
    # manifest was written before publishing, and it happened twice (Vera,
    # 2026-09-16). A duplicate passes every "does it resolve" check, because
    # both copies name the same object and both fetch 200.
    # awk, not `grep -P`: PCRE is a GNU extension, and a grep that does not
    # have it exits non-zero with an empty file already created — which would
    # replace the manifest with nothing rather than duplicate a row (Piper,
    # 2026-09-16). Losing every anchor is worse than the defect above, so the
    # filter must not be the thing that can fail here.
    if [ -f "$MANIFEST" ]; then awk -F'\t' -v k="$key" '$1 != k' "$MANIFEST" > "$MANIFEST.tmp"; else : > "$MANIFEST.tmp"; fi
    printf '%s\t%s\t%s\n' "$key" "$local_sha" "$(wc -c < "$f" | tr -d ' ')" >> "$MANIFEST.tmp"
    LC_ALL=C sort -o "$MANIFEST.tmp" "$MANIFEST.tmp"
    mv "$MANIFEST.tmp" "$MANIFEST"
    echo "uploaded $BASE/$key"
    uploaded=$((uploaded+1))
  else
    echo "FAILED   $key"
    refused=$((refused+1))
  fi
done

echo "uploaded=$uploaded verified=$skipped refused=$refused changed=$changed"
[ "$refused" -eq 0 ] && [ "$changed" -eq 0 ]
