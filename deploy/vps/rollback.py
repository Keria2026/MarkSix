#!/usr/bin/env python3
"""Explicit application rollback; never silently downgrade a database schema."""

import argparse
import datetime as dt
import json
from pathlib import Path
import re
import subprocess
import sys

import deploy
import ops
import releases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--confirm-rollback", action="store_true", required=True)
    parser.add_argument("--shared", type=Path, default=Path("/opt/marksix/shared"))
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("A full retained commit SHA is required")
    shared = args.shared.resolve()
    ops.configuration(shared)
    with ops.lock(shared / ".operations.lock"):
        state = json.loads((shared / "deployment.json").read_text())
        root = shared.parent / "releases"
        source = root / state["sha"]
        target = root / args.sha
        if source.is_symlink() or target.is_symlink():
            raise RuntimeError("Release directories may not be symlinks")
        current_manifest = json.loads((source / "manifest.json").read_text())
        manifest = json.loads((target / "manifest.json").read_text())
        # Contract includes every published central and tenant SQL migration.
        # Missing metadata, changed DDL or edited migrations require a coordinated
        # database restore, never an optimistic old-binary restart.
        contract = current_manifest.get("database_contract")
        if not contract or contract != manifest.get("database_contract"):
            raise RuntimeError(
                "Database compatibility unproven; restore a matching backup in maintenance first"
            )
        if not (target / ".deployed.json").is_file():
            raise RuntimeError(
                "Rollback target must be a previously healthy retained release"
            )
        subprocess.run([sys.executable, str(target / "verify.py")], check=True)
        previous = shared.parent / "current"
        old_release = ops.RELEASE
        try:
            ops.RELEASE = source / "hosted"
            ops.compose(shared, "stop", "--timeout", "45", "backend", "authority")
            backup = ops.backup(shared)
            ops.RELEASE = target / "hosted"
            ops.compose(
                shared,
                "up",
                "-d",
                "--no-build",
                "--pull",
                "never",
                "--wait",
                "--wait-timeout",
                "240",
            )
            deploy.health(shared, args.sha)
            releases.switch_current(previous, ops.RELEASE)
            deploy.record(
                shared,
                {
                    "sha": args.sha,
                    "previous": str(source / "hosted"),
                    "status": "healthy",
                    "operation": "manual-rollback",
                    "backup": str(backup),
                    "completed_at": dt.datetime.now(dt.timezone.utc).isoformat(),
                },
            )
            print(
                "Application rollback healthy; release-order high-water mark preserved"
            )
        except BaseException:
            ops.compose(shared, "stop", "--timeout", "45", "backend", "authority")
            raise
        finally:
            ops.RELEASE = old_release


if __name__ == "__main__":
    main()
