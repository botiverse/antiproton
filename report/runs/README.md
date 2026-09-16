# Run records

The records behind every figure on the status report: the runner's own JSON, and
its stdout byte-for-byte where a log was captured.

They are **not in this repository**. They live in a public bucket, so a reader
who was not present can open the record behind a row without a checkout:

    https://pub-212e604eb60944c6854033a8ee1b3cef.r2.dev/runs/<day>/<file>

For example the τ² run of 2026-09-13:

    https://pub-212e604eb60944c6854033a8ee1b3cef.r2.dev/runs/2026-09-13/tau2-v5-mtz6ecej.json

Records written before 2026-09-16 were committed here; they are still in this
repository's history, and every one of them was uploaded to the bucket.

## Publishing a run

`bench/record.ts` writes each record under `report/runs/<day>/` in the working
tree, where it is ignored by git. After a run, upload it:

    bash scripts/publish-runs.sh

The script uploads every file under `report/runs/` that is not already in the
bucket, and prints the URL of each. Capture a runner's log with a redirect
(`> report/runs/<day>/<name>.log 2>&1`) rather than a pipe into `tail`, or the
byte-for-byte record is lost and only the JSON survives.

## Before uploading

The bucket is world-readable. `publish-runs.sh` refuses to upload a file that
contains a credential shape, but the check is a net, not a proof: a record is
the output of an agent that was given real mounts, so read what you publish.
