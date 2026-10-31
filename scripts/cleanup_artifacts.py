#!/usr/bin/env python3
"""Bound CI artifact storage without deleting a deployment's download source."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

UTC = dt.timezone.utc
PACKAGE = "MarkSix-Ubuntu-x64"
ACCEPTANCE = {"runtime-acceptance", "hosted-acceptance"}
REPORTS = ACCEPTANCE | {"browser-report", "coverage-report", "text-entry-corpus"}
RETIRED = {"MarkSix-Windows-Native-x64", "marksix-images"}
DEPLOY_STEP = "Transfer and deploy the tested artifact"


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def lane(run):
    return ((run.get("head_repository") or {}).get("id"), run["head_branch"])


def latest_per_lane(runs):
    latest = {}
    for run in sorted(runs, key=lambda r: (r["run_number"], r["id"])):
        latest[lane(run)] = run["id"]
    return set(latest.values())


def plan_cleanup(artifacts, runs, jobs, repository_id, workflow_id, now):
    ci = {k: r for k, r in runs.items() if r["workflow_id"] == workflow_id}
    completed = [r for r in ci.values() if r["status"] == "completed"]
    success = latest_per_lane(r for r in completed if r["conclusion"] == "success")
    failed = latest_per_lane(r for r in completed if r["conclusion"] != "success")
    manual = latest_per_lane(
        r for r in completed
        if r["event"] == "workflow_dispatch" and r["conclusion"] == "success"
    )
    attempted, healthy, unknown_deployments = [], [], set()
    for run in ci.values():
        if (run["event"] != "push" or run["head_branch"] != "master"
                or (run.get("head_repository") or {}).get("id") != repository_id):
            continue
        # Inspect every attempt: rerunning an old CI must not erase evidence that
        # an earlier attempt deployed, even if public verification then failed.
        recognized = False
        for job in jobs.get(run["id"], []):
            if job["name"] != "Deploy MarkSix to VPS":
                continue
            for step in job.get("steps", []):
                if step["name"] == DEPLOY_STEP:
                    recognized = True
                if step["name"] == DEPLOY_STEP and step["conclusion"] in {
                    "success", "failure", "cancelled", "timed_out"
                }:
                    when = step.get("completed_at") or step.get("started_at")
                    if not when:
                        raise RuntimeError("Deployment time is unknown; cleanup stopped")
                    marker = (timestamp(when), run["id"])
                    # SSH can fail after the remote release has changed. Preserve
                    # that candidate too, until a later deployment supersedes it.
                    attempted.append(marker)
                    if job["conclusion"] == "success" and step["conclusion"] == "success":
                        healthy.append(marker)
        if not recognized:
            unknown_deployments.add(run["id"])
    protected = {max(group)[1] for group in (attempted, healthy) if group}
    plan = []
    for artifact in artifacts:
        name = artifact["name"]
        run_id = (artifact.get("workflow_run") or {}).get("id")
        run = ci.get(run_id)
        action, reason = "keep", "unmanaged artifact or workflow"
        known = name in REPORTS | RETIRED | {PACKAGE} or name.endswith(".dockerbuild")
        if run and known and (run.get("head_repository") or {}).get("id") is not None:
            age = now - timestamp(artifact["created_at"])
            if run["status"] != "completed":
                reason = "workflow is still running or waiting"
            elif artifact["expired"]:
                action, reason = "delete", "already expired"
            elif run_id in protected and name in ACCEPTANCE | {PACKAGE}:
                reason = "latest attempted or last verified production deployment"
            elif run_id in unknown_deployments and name == PACKAGE:
                reason = "unrecognized production deployment history; manual review required"
            elif name.endswith(".dockerbuild") or name in RETIRED:
                action, reason = "delete", "retired package or disposable build record"
            elif name == "browser-report" and run["conclusion"] == "success":
                action, reason = "delete", "failure report superseded by successful retry"
            elif name == PACKAGE:
                if run_id in manual and age < dt.timedelta(days=7):
                    reason = "latest successful manual download, up to seven days"
                else:
                    action, reason = "delete", "unused, failed or superseded package"
            elif run_id in success and age < dt.timedelta(days=7):
                reason = "latest successful report for this branch, up to seven days"
            elif run_id in failed and age < dt.timedelta(days=1):
                reason = "latest failure report for this branch, up to one day"
            else:
                action, reason = "delete", "superseded or aged report"
        plan.append({
            "id": artifact["id"], "name": name, "run_id": run_id,
            "bytes": artifact["size_in_bytes"], "action": action, "reason": reason,
        })
    return plan


class GitHub:
    def __init__(self, repository, token=None):
        if (not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository)
                or any(part in {".", ".."} for part in repository.split("/"))):
            raise ValueError("Invalid repository name")
        self.base = "https://api.github.com/repos/" + repository
        self.headers = {"Accept": "application/vnd.github+json",
                        "X-GitHub-Api-Version": "2022-11-28"}
        if token:
            self.headers["Authorization"] = "Bearer " + token

    def request(self, path, method="GET", missing_ok=False):
        request = urllib.request.Request(self.base + path, method=method,
                                         headers=self.headers)
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    return True if response.status == 204 else json.load(response)
            except urllib.error.HTTPError as error:
                if error.code == 404 and missing_ok:
                    return None
                if (error.code == 429 or error.code >= 500) and attempt < 2:
                    time.sleep(2 ** attempt)
                    continue
                raise RuntimeError(f"GitHub {method} {path}: HTTP {error.code}") from None
            except urllib.error.URLError:
                raise RuntimeError(f"GitHub {method} {path}: network request failed") from None

    def listing(self, path, key):
        items = []
        separator = "&" if "?" in path else "?"
        for page in range(1, 1001):
            batch = self.request(f"{path}{separator}per_page=100&page={page}")[key]
            items.extend(batch)
            if len(batch) < 100:
                return items
        raise RuntimeError("Pagination limit reached; no cleanup performed")


def inventory(client):
    repo = client.request("")
    workflow = client.request("/actions/workflows/ci.yml")
    artifacts = client.listing("/actions/artifacts", "artifacts")
    run_ids = {(a.get("workflow_run") or {}).get("id") for a in artifacts} - {None}
    runs = {}
    jobs = {}
    for run_id in sorted(run_ids):
        run = client.request(f"/actions/runs/{run_id}", missing_ok=True)
        if run is None:
            continue  # Missing provenance is never authority to delete.
        runs[run_id] = run
        if (run["workflow_id"] == workflow["id"] and run["event"] == "push"
                and run["head_branch"] == "master"
                and (run.get("head_repository") or {}).get("id") == repo["id"]):
            jobs[run_id] = client.listing(
                f"/actions/runs/{run_id}/jobs?filter=all", "jobs"
            )
            if not jobs[run_id]:
                raise RuntimeError("Production job history is unavailable; cleanup stopped")
    return artifacts, runs, jobs, repo["id"], workflow["id"]


def apply_plan(client, plan, runs, result=None):
    if result is None:
        result = {}
    deleted = result.setdefault("deleted", [])
    absent = result.setdefault("already_absent", [])
    changed = result.setdefault("changed_runs_skipped", [])
    for item in plan:
        if item["action"] != "delete":
            continue
        before = runs[item["run_id"]]
        current = client.request(f"/actions/runs/{item['run_id']}", missing_ok=True)
        if current is None or any(current[k] != before[k] for k in
                                  ("status", "run_attempt", "head_sha", "workflow_id")):
            changed.append(item["id"])
            continue
        removed = client.request(f"/actions/artifacts/{item['id']}",
                                 method="DELETE", missing_ok=True)
        (deleted if removed else absent).append(item["id"])
        print(json.dumps({"deleted" if removed else "already_absent": item["id"],
                          "reason": item["reason"]}), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", default=os.environ.get("GITHUB_REPOSITORY"))
    parser.add_argument("--apply", action="store_true", help="Delete the selected artifacts")
    parser.add_argument("--output", type=Path, default=Path("test-results/artifact-cleanup.json"))
    args = parser.parse_args()
    if not args.repository:
        parser.error("--repository or GITHUB_REPOSITORY is required")
    token = os.environ.get("GH_TOKEN")
    if os.environ.get("GITHUB_ACTIONS") == "true" and not token:
        parser.error("GH_TOKEN is required in Actions")
    client = GitHub(args.repository, token)
    artifacts, runs, jobs, repository_id, workflow_id = inventory(client)
    now = dt.datetime.now(UTC)
    plan = plan_cleanup(artifacts, runs, jobs, repository_id, workflow_id, now)
    result = {"apply": args.apply, "at": now.isoformat(), "plan": plan,
              "planned_bytes": sum(a["bytes"] for a in plan if a["action"] == "delete")}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    if args.apply:
        result["completed"] = False
        try:
            apply_plan(client, plan, runs, result)
            result["completed"] = True
        finally:
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    selected = sum(a["action"] == "delete" for a in plan)
    summary = (f"Artifact cleanup: {'apply' if args.apply else 'dry run'}; "
               f"selected {selected}/{len(plan)}, {result['planned_bytes']} bytes; "
               f"deleted {len(result.get('deleted', []))}, "
               f"changed runs skipped {len(result.get('changed_runs_skipped', []))}.")
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as output:
            output.write(summary + "\n")


if __name__ == "__main__":
    main()
