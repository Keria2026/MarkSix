#!/usr/bin/env python3
"""Preflight an upload before scp, or verify/extract it into an immutable release."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "extract", "discard"])
    parser.add_argument("sha")
    parser.add_argument("sequence", type=int)
    parser.add_argument("attempt", type=int)
    parser.add_argument("archive_bytes", type=int)
    parser.add_argument("package_bytes", type=int)
    parser.add_argument("image_bytes", type=int)
    parser.add_argument("--root", type=Path, default=Path("/opt/marksix/releases"))
    args = parser.parse_args()
    if (
        not re.fullmatch(r"[0-9a-f]{40}", args.sha)
        or min(
            args.sequence,
            args.attempt,
            args.archive_bytes,
            args.package_bytes,
            args.image_bytes,
        )
        < 1
    ):
        parser.error("Invalid release identity or size")
    root = args.root.resolve(strict=True)
    stage = root / f".incoming-{args.sequence}-{args.attempt}-{args.sha}"
    if stage.is_symlink():
        raise RuntimeError("Upload directory must not be a symlink")
    if args.action == "discard":
        if stage.exists():
            shutil.rmtree(stage)
        return
    if args.action == "prepare":
        required = (
            args.archive_bytes + args.package_bytes + args.image_bytes + 2 * 1024**3
        )
        if shutil.disk_usage(root).free < required:
            raise RuntimeError(
                "Insufficient free disk space before upload; no application was changed"
            )
        stage.mkdir(mode=0o700)  # Reject retries using the same staging path.
        return
    archive = stage / "package.tar"
    if archive.is_symlink() or archive.stat().st_size != args.archive_bytes:
        raise RuntimeError("Upload archive size mismatch")
    destination = root / args.sha
    if destination.exists() or destination.is_symlink():
        # Re-runs can reuse only byte-identical, already verified packages.
        old = json.loads((destination / "manifest.json").read_text())
    else:
        old = None
    with tarfile.open(archive) as source:
        members = source.getmembers()
        if sum(m.size for m in members) != args.package_bytes:
            raise RuntimeError("Upload expanded size mismatch")
        for member in members:
            target = stage / member.name
            if not target.resolve().is_relative_to(stage) or not (
                member.isfile() or member.isdir()
            ):
                raise RuntimeError("Invalid archive path/type")
            if member.name.lstrip("./") == "package.tar":
                raise RuntimeError("Archive may not overwrite itself")
        # Extract only regular files/directories; do not restore archive ownership,
        # setuid bits, links or special files. This also works on Python 3.10.
        directories = {stage}
        for member in members:
            target = stage / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                directories.add(target)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                directories.update(target.parents)
                with source.extractfile(member) as data, target.open("xb") as output:
                    shutil.copyfileobj(data, output, length=1024 * 1024)
                target.chmod(0o644)
        for directory in directories:
            if directory.is_relative_to(stage):
                directory.chmod(0o755)
    manifest = json.loads((stage / "manifest.json").read_text())
    if (
        manifest["version"] != args.sha
        or manifest["image_unpacked_bytes"] != args.image_bytes
    ):
        raise RuntimeError("Upload manifest identity/size mismatch")
    subprocess.run([sys.executable, str(stage / "verify.py")], check=True)
    archive.unlink()
    if old is not None:
        if manifest != old:
            raise RuntimeError(
                "A different artifact already occupies this commit directory"
            )
        shutil.rmtree(stage)
    else:
        os.rename(stage, destination)


if __name__ == "__main__":
    main()
