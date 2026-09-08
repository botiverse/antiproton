#!/usr/bin/env python3
"""Fix an upstream AppWorld bug so one server process can serve many tasks.

`Requester.close_all()` is a classmethod, so it has no `remote_apis_url`, and
calls the two-argument `unset_remote_date_and_time(url, id)` with only the id.
The instance path a few lines above gets it right. In remote-apis mode this
raises on the SECOND `AppWorld.__init__` in a process (the first has nothing to
close), which aborts /initialize and leaves the API server with no database
bound — every later call then fails with "no such table: supervisors".

The fix records the URL on the class when an instance registers a remote time
freezer, and uses it when closing. Idempotent; safe to re-run.

  python bench/appworld/patch_appworld.py [--check]
"""
import sys, pathlib, importlib.util

MARK = "# harness-patch: remote_apis_url for close_all"

OLD_APPEND = "            self.time_freezers_or_ids.append(self.time_freezer_or_id)"
NEW_APPEND = (
    "            self.time_freezers_or_ids.append(self.time_freezer_or_id)\n"
    f"            type(self)._remote_apis_url = remote_apis_url  {MARK}"
)

OLD_CLOSE = """            else:
                unset_remote_date_and_time(time_freezer_or_id)"""
NEW_CLOSE = f"""            else:
                _url = getattr(cls, "_remote_apis_url", None)  {MARK}
                if _url:
                    unset_remote_date_and_time(_url, time_freezer_or_id)"""


def main() -> int:
    spec = importlib.util.find_spec("appworld")
    if spec is None or not spec.submodule_search_locations:
        print("appworld is not importable from this interpreter", file=sys.stderr)
        return 2
    path = pathlib.Path(list(spec.submodule_search_locations)[0]) / "requester.py"
    src = path.read_text()
    if MARK in src:
        print(f"already patched: {path}")
        return 0
    if "--check" in sys.argv:
        print(f"NOT patched: {path}")
        return 1
    if OLD_APPEND not in src or OLD_CLOSE not in src:
        print(f"unexpected source; refusing to patch {path}", file=sys.stderr)
        return 3
    path.write_text(src.replace(OLD_APPEND, NEW_APPEND, 1).replace(OLD_CLOSE, NEW_CLOSE, 1))
    print(f"patched: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
