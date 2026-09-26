# AppWorld through this harness

AppWorld's own interface hands the agent a Python REPL and expects it to read
the supervisor's passwords, log into each app, and carry the access token in its
own context — 362 of its 457 APIs sit behind that token. Here the nine apps are
nine ordinary **mounts**: credentials resolve from `secret_ref`, the gateway
authenticates, the session token lives in the mount's connection state, and the
model addresses `spotify.show_song` without knowing a token exists.

## Setup

AppWorld is not vendored. Install it yourself:

```bash
uv venv --python 3.12 ~/appworld-env
uv pip install --python ~/appworld-env/bin/python \
    --override <(echo 'psutil==6.1.1') appworld
~/appworld-env/bin/appworld install
cd ~ && ~/appworld-env/bin/appworld download data
python bench/appworld/patch_appworld.py     # see below
```

Two local workarounds, both recorded rather than papered over:

- **`psutil` override.** AppWorld pins `psutil<6.0.0`, and no 5.9.x release ships
  an aarch64 wheel. 6.1.1 does, and the APIs in use are unchanged across that
  boundary.
- **`patch_appworld.py`.** `Requester.close_all()` is a classmethod with no
  `remote_apis_url`, but calls the two-argument `unset_remote_date_and_time`
  with one. In remote-apis mode this raises on the *second* `AppWorld.__init__`
  in a process, aborting `/initialize` and leaving the API server with no
  database bound. Idempotent; `--check` reports without writing.

## Running

```bash
bench/appworld/serve.sh start                  # frees the ports first, always
~/appworld-env/bin/python bench/appworld/dump_catalogue.py
AW_TASK=50e1ac9_1 node --experimental-strip-types test/appworld.ts   # the conformance run; the old bench/appworld/run.ts driver was deleted in 2df66b3
```

`catalogue.json` and `tasks-*.json` are **not committed**: they derive from
AppWorld's protected data, which may only be redistributed encrypted.

## Why serve.sh exists

Servers started in an earlier shell keep holding 8799/8800; later ones fail to
bind and die, and every test then silently hits the *old* process — including,
once, one running pre-patch code. `serve.sh` frees the ports by listener rather
than by process-name pattern.
