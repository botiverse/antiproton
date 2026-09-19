#!/usr/bin/env bash
# Upload run records to the public bucket the report page links to.
#
# Three things this must not do: publish a credential, let a published record
# differ from the record a figure was computed from, and anchor a figure to a
# run whose own code was never merged. All three are checked here, and all
# three fail closed — a check that cannot run stops the publish rather than
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

# A record names two commits: `build` is the Worker that answered the run, and
# `driver` is the code that wrote the record down. They are often different —
# the deployment lags the repo most days — and that is not a fault: they answer
# two questions. What must hold is that both are on THIS repository's history,
# because a driver on a tree that was never merged leaves no trace in the
# bytes: every figure in such a record looks ordinary (Vera, 2026-09-19).
#
# Three exits, because two of the refusals are different mistakes with
# different repairs — and a check with two exits reports the wrong one: when a
# commit is simply absent from the checkout, "is it an ancestor" fails in both
# directions, which reads as "these two are unrelated" while the truth is "I
# cannot see one of them" (Vera again).
#   0 = one history, or the record predates the fields (records before
#       2026-09-12 carry neither, and they are still republished from history)
#   1 = both commits known, and neither reaches the other  ⇒ merge that tree
#   2 = cannot judge                                        ⇒ fetch, then publish
one_history() {
  local f="$1" out build driver c
  case "$f" in *.json) ;; *) return 0;; esac
  if ! out=$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const [file] = process.argv.slice(1);
    // Unreadable, unparseable and "not an object" are all "cannot judge", so
    // they are one throw rather than three silent empties: an empty pair is
    // how a pre-2026-09-12 record says it has no claim to check.
    const r = JSON.parse(readFileSync(file, "utf8"));
    if (!r || typeof r !== "object") throw new TypeError("not a record object");
    const d = r.driver;
    const build = typeof r.build === "string" ? r.build : "";
    const driver = typeof d === "string" ? d : d && typeof d.commit === "string" ? d.commit : "";
    process.stdout.write(`${build} ${driver}`);
  ' "$f" 2>&1); then
    echo "the provenance check could not read $f: $out" >&2
    return 2
  fi
  build=${out%% *}; driver=${out##* }
  if [ -z "$build" ] && [ -z "$driver" ]; then return 0; fi
  # Half a claim. No runner writes this — both fields come from the same place
  # in each of them — and it appears 0 times in all 24 JSON records on the
  # manifest (19 carry both, 5 carry neither; Vera and cody counted the whole
  # manifest separately, 2026-09-19, after each of us first counted a smaller
  # set we had to hand). So which refusal it belongs to is undecided on
  # purpose: it is
  # not "fetch it" (nothing is missing here that fetching would bring) and it
  # is not "merge it" either (one field absent is no evidence about any tree).
  # It stops, and the message says only what is true of it.
  if [ -z "$build" ] || [ -z "$driver" ]; then
    echo "$f names only one of build/driver ('$out'), and a lone commit cannot be checked against anything" >&2
    return 2
  fi
  for c in "$build" "$driver"; do
    if ! git -C "$ROOT" cat-file -e "${c}^{commit}" 2>/dev/null; then
      echo "commit $c is not in this checkout, so build and driver cannot be compared — fetch it and publish again" >&2
      return 2
    fi
  done
  git -C "$ROOT" merge-base --is-ancestor "$build" "$driver" 2>/dev/null && return 0
  git -C "$ROOT" merge-base --is-ancestor "$driver" "$build" 2>/dev/null && return 0
  echo "build $build and driver $driver are on neither's history — the run used a tree that was never merged" >&2
  return 1
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

  one_history "$f"; code=$?
  case $code in
    0) ;;
    1) echo "REFUSED  $key — its build and driver are not on one history; it was not uploaded"; refused=$((refused+1)); continue;;
    *) echo "STOPPED  the provenance check could not judge $key; nothing further was uploaded"; exit 2;;
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
