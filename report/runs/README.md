# Run records

The records behind every figure on the status report: the runner's own JSON, and
its stdout byte-for-byte where a log was captured.

They are **not in this repository**. They live in a public bucket, so a reader
who was not present can open the record behind a row without a checkout:

    https://pub-212e604eb60944c6854033a8ee1b3cef.r2.dev/runs/<day>/<file>

For example the τ² run of 2026-09-13:

    https://pub-212e604eb60944c6854033a8ee1b3cef.r2.dev/runs/2026-09-13/tau2-v5-mtz6ecej.json

Every record written before 2026-09-16 — the days 2026-09-10 through
2026-09-15 — is in the bucket, and each of those files is also still in this
repository's history. Nothing is in the history alone. Records written from
2026-09-16 on exist only in the bucket, so publishing a run is what preserves
it.

The bucket address above is the only address these records have: the report
page and this file cite it in 28 places, and they all break together if the
bucket is renamed or deleted. Move the objects first if that ever has to
change.

## What the bucket does and does not promise

`manifest.tsv` here lists every published record as `key`, SHA-256, size. It is
what makes a link checkable: fetch the object, hash it, compare. Every one of
the 28 records published on 2026-09-16 was verified this way against the bytes
in the bucket.

A public bucket gives **availability, not immutability**. Anyone with write
access to the account can overwrite or delete an object, and
`Cache-Control: immutable` is a hint to caches, not a property of the store.
The manifest is the anchor: it says what the bytes were when the figure was
computed, so a record that changed can be noticed instead of trusted.

## Publishing a run

`bench/record.ts` writes each record under `report/runs/<day>/` in the working
tree, where it is ignored by git. After a run, upload it:

    set -a; . ~/.secrets/antiproton.env; set +a
    bash scripts/publish-runs.sh

Publishing needs a Cloudflare API token. wrangler reads `CLOUDFLARE_API_TOKEN`;
the credential file calls the same value `CF_API_TOKEN`, and the script accepts
either. With neither it stops before reading or fetching anything.

The script uploads every file under `report/runs/` whose bytes are not already
in the bucket, and prints the URL of each. It compares hashes rather than
checking that a key exists, so a key holding different bytes is reported and
not overwritten, and a local record that no longer matches `manifest.tsv` stops
the publish. If the credential check cannot run at all, the script stops rather
than publishing unchecked. Capture a runner's log with a redirect rather than a pipe into `tail`, or the
byte-for-byte record is lost and only the JSON survives. **Name it after the
record the runner prints**, so the pair shares one stem:

    node bench/tau2/cf.ts … > /tmp/run.log 2>&1        # runner prints: recorded report/runs/<day>/<stem>.json
    mv /tmp/run.log report/runs/<day>/<stem>.log        # same <stem>, so one name opens both

A name invented at the keyboard breaks that pairing and has leaked machine
details into a world-readable bucket: three logs went up as
names taken from the machine they ran on, on 2026-09-16, and the
credential check cannot catch that — a hostname is only sensitive if you know
what it is. Those objects were re-uploaded under their record's stem and the
originals deleted. `TAU2-RUNNER-CORRECTION-v4.md` in that day's records is the
note to read: it states no fact about the bucket, it tells you to fetch the key
and read the answer, so it holds either side of the deletion. Earlier notes in
that chain were written before it and do state the old keys' status: v2 says one
is "still live", which stopped being true when it was deleted.

## Before uploading

The bucket is world-readable. `publish-runs.sh` refuses to upload a file that
contains a credential shape, but the check is a net, not a proof, and the two
halves are worth stating separately:

- It catches what *looks* like a credential — a `ghp_` token, an AWS key id, a
  private-key header, a password inside a connection URL.
- It cannot catch what is sensitive only if you know the context: an internal
  hostname, a customer's name, part of a key, a URL that is private because of
  where it points rather than how it is shaped.

A record is the output of an agent that was given real mounts, so read what you
publish. The automated check is the floor, not the decision.
