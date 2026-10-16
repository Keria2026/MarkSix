#!/usr/bin/env python3
"""Fail closed on new Rust dependency advisories; use reviewed, expiring exceptions."""

import datetime as dt
import json
from pathlib import Path
import re
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def locked_packages(text):
    packages = []
    for block in text.split("[[package]]")[1:]:
        fields = dict(re.findall(r'^(name|version|source) = "([^"\n]+)"$', block, re.M))
        if fields.get("source", "").startswith("registry+"):
            packages.append((fields["name"], fields["version"]))
    if not packages:
        raise RuntimeError("No locked registry packages; audit did not run")
    return packages


def evaluate(packages, results, exceptions, today):
    if len(results) != len(packages):
        raise RuntimeError("Incomplete advisory response")
    for exception in exceptions:
        if (
            dt.date.fromisoformat(exception["review_by"]) < today
            or not exception["reason"].strip()
        ):
            raise RuntimeError("Expired or undocumented security exception")
    findings, rejected = [], []
    for (name, version), result in zip(packages, results):
        for advisory in result.get("vulns", []):
            allowed = any(
                e["package"] == name
                and e["version"] == version
                and e["id"] == advisory["id"]
                for e in exceptions
            )
            finding = {
                "package": name,
                "version": version,
                "id": advisory["id"],
                "reviewed_exception": allowed,
            }
            findings.append(finding)
            if not allowed:
                rejected.append(finding)
    return findings, rejected


def main():
    packages = locked_packages((ROOT / "backend/Cargo.lock").read_text())
    queries = [
        {"package": {"name": name, "ecosystem": "crates.io"}, "version": version}
        for name, version in packages
    ]
    request = urllib.request.Request(
        "https://api.osv.dev/v1/querybatch",
        data=json.dumps({"queries": queries}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=45) as response:
        results = json.load(response)["results"]
    exceptions = json.loads((ROOT / "scripts/security-exceptions.json").read_text())
    findings, rejected = evaluate(
        packages, results, exceptions, dt.datetime.now(dt.timezone.utc).date()
    )
    report = {
        "packages": len(packages),
        "findings": findings,
        "unreviewed": len(rejected),
    }
    output = ROOT / "test-results/dependency-audit.json"
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if rejected:
        raise SystemExit("Unreviewed dependency advisory; release blocked")


if __name__ == "__main__":
    main()
