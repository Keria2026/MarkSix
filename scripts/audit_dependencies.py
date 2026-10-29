#!/usr/bin/env python3
"""Fail closed on Rust/Bun advisories; use reviewed, expiring exact-version exceptions."""

import argparse
import datetime as dt
import json
from pathlib import Path
import re
import subprocess
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


def evaluate(packages, results, exceptions, today, ecosystem="crates.io"):
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
                and e.get("ecosystem", "crates.io") == ecosystem
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


def bun_packages(text):
    packages = sorted(set(re.findall(
        r'^\s*"[^"\n]+": \["((?:@[^/]+/)?[^@"\n]+)@([^"\n]+)",',
        text,
        re.M,
    )))
    if not packages:
        raise RuntimeError("No locked Bun packages; audit did not run")
    return packages


def bun_results(packages, report):
    if not isinstance(report, dict):
        raise RuntimeError("Invalid Bun audit response")
    if set(report) - {name for name, _ in packages}:
        raise RuntimeError("Bun audit returned an unlocked package")
    results = []
    for name, _ in packages:
        advisories = []
        for entry in report.get(name, []):
            url = entry.get("url", "")
            if not re.fullmatch(r"https://github.com/advisories/GHSA-[a-z0-9-]+", url):
                raise RuntimeError("Unknown advisory identity; audit blocked")
            advisories.append({"id": url.rsplit("/", 1)[1]})
        results.append({"vulns": advisories})
    return results


def rust_results(packages):
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
        return json.load(response)["results"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--frontend", action="store_true")
    args = parser.parse_args()
    ecosystem = "npm" if args.frontend else "crates.io"
    if args.frontend:
        packages = bun_packages((ROOT / "frontend/bun.lock").read_text())
        scan = subprocess.run(
            ["bun", "audit", "--json"],
            cwd=ROOT / "frontend",
            capture_output=True,
            text=True,
            timeout=60,
        )
        if scan.returncode not in (0, 1):
            raise RuntimeError("Bun audit failed; release blocked")
        raw = json.loads(scan.stdout)
        if scan.returncode != 0 and not raw:
            raise RuntimeError("Bun audit failed without findings; release blocked")
        results = bun_results(packages, raw)
    else:
        packages = locked_packages((ROOT / "backend/Cargo.lock").read_text())
        results = rust_results(packages)
    exceptions = json.loads((ROOT / "scripts/security-exceptions.json").read_text())
    findings, rejected = evaluate(
        packages, results, exceptions, dt.datetime.now(dt.timezone.utc).date(), ecosystem
    )
    report = {
        "packages": len(packages),
        "findings": findings,
        "unreviewed": len(rejected),
    }
    output = ROOT / "test-results" / (
        "frontend-dependency-audit.json" if args.frontend else "dependency-audit.json"
    )
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))
    if rejected:
        raise SystemExit("Unreviewed dependency advisory; release blocked")


if __name__ == "__main__":
    main()
