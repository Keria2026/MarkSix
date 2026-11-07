#!/usr/bin/env python3
"""Find a completed dev CI package for exactly the deployed Git tree."""
import os
import re

from cleanup_artifacts import GitHub

ARTIFACT = "marksix-verified-dev"
SHA = re.compile(r"[0-9a-f]{40}\Z")
REQUIRED_JOBS = {"frontend", "integration", "verify", "images", "release"}


def select(client, master_sha):
    if not SHA.fullmatch(master_sha):
        raise ValueError("Invalid master commit")
    repo = client.request("")
    workflow = client.request("/actions/workflows/ci.yml")
    tree = client.request(f"/git/commits/{master_sha}")["tree"]["sha"]
    runs = client.listing("/actions/workflows/ci.yml/runs?branch=dev&event=push&status=success", "workflow_runs")
    for run in runs:
        commit = run.get("head_sha", "")
        if (not SHA.fullmatch(commit) or run.get("status") != "completed"
                or run.get("conclusion") != "success" or run.get("event") != "push"
                or run.get("head_branch") != "dev" or run.get("workflow_id") != workflow["id"]
                or (run.get("head_repository") or {}).get("id") != repo["id"]):
            continue
        if client.request(f"/git/commits/{commit}")["tree"]["sha"] != tree:
            continue
        jobs = client.listing(f"/actions/runs/{run['id']}/attempts/{run['run_attempt']}/jobs", "jobs")
        succeeded = {job["name"] for job in jobs if job.get("conclusion") == "success"}
        if not REQUIRED_JOBS <= succeeded:
            continue
        artifacts = client.listing(f"/actions/runs/{run['id']}/artifacts", "artifacts")
        if any(a.get("name") == ARTIFACT and not a.get("expired") for a in artifacts):
            return run["id"], commit
    raise RuntimeError("No successful dev build with a matching tree and available tested package")


def main():
    client = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
    run_id, sha = select(client, os.environ["GITHUB_SHA"])
    print(f"run_id={run_id}\nsha={sha}")


if __name__ == "__main__":
    main()
