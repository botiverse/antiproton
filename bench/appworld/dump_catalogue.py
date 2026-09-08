#!/usr/bin/env python3
"""Regenerate the local AppWorld catalogue and task lists.

The generated files are NOT in this repository on purpose. AppWorld's data
folder is its protected portion: "any public redistribution of it (or of its
derivatives) must also be done in an encrypted format." The catalogue is a
derivative of that data, so it stays local and is rebuilt from your own
licensed install.

Prerequisites: `appworld install && appworld download data`, then start the
servers (bench/appworld/serve.sh start).

  ~/appworld-env/bin/python bench/appworld/dump_catalogue.py
"""
import json
import pathlib
import urllib.parse
import urllib.request

ENV = "http://localhost:8799"
API = "http://localhost:8800"
HERE = pathlib.Path(__file__).parent
SEED_TASK = "50e1ac9_1"


def get(url: str):
    with urllib.request.urlopen(urllib.request.Request(url), timeout=90) as r:
        return json.loads(r.read() or b"null")


def post(url: str, body: dict):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read() or b"null")


def main() -> int:
    # A world has to be bound before the API server will answer.
    post(f"{ENV}/initialize", {
        "task_id": SEED_TASK, "experiment_name": "catalogue", "remote_apis_url": API,
    })

    catalogue, total = {}, 0
    for app in get(f"{API}/api_docs/app_descriptions"):
        name = app["name"]
        docs = [
            get(f"{API}/api_docs/api_doc?app_name={urllib.parse.quote(name)}"
                f"&api_name={urllib.parse.quote(api['name'])}")
            for api in get(f"{API}/api_docs/api_descriptions?app_name={urllib.parse.quote(name)}")
        ]
        catalogue[name] = {"description": app["description"], "apis": docs}
        total += len(docs)
        print(f"  {name:14s} {len(docs):3d}")
    (HERE / "catalogue.json").write_text(json.dumps(catalogue, indent=1))
    print(f"  total: {total} APIs -> catalogue.json")

    from appworld import load_task_ids  # imported late: only needed for the id lists
    for split in ("dev", "test_normal"):
        ids = load_task_ids(split)
        (HERE / f"tasks-{split}.json").write_text(json.dumps(ids))
        print(f"  {split}: {len(ids)} task ids -> tasks-{split}.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
