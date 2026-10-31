#!/usr/bin/env python3
"""Verify a complete hosted release before loading images or changing services."""

import hashlib
import json
from pathlib import Path
import re


def verify(root):
    root = Path(root).resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("schema") != 1 or manifest.get("platform") != "linux/amd64":
        raise SystemExit("Unsupported release manifest")
    files = manifest.get("files", {})
    if (
        not isinstance(files, dict)
        or not {"images.tar.gz", "hosted/compose.yaml", "hosted/release.sh"}
        <= files.keys()
    ):
        raise SystemExit("Incomplete hosted release")
    for name, expected in files.items():
        if (
            not name
            or "\\" in name
            or any(part in ("", ".", "..") for part in name.split("/"))
            or not isinstance(expected, str)
            or not re.fullmatch(r"[0-9a-f]{64}", expected)
        ):
            raise SystemExit("Invalid package manifest entry")
        relative = Path(name)
        if relative.is_absolute() or any((root / part).is_symlink() for part in [relative, *relative.parents]):
            raise SystemExit("Invalid package path or symlink")
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            raise SystemExit("Missing or invalid package path")
        with path.open("rb") as stream:
            # Ubuntu 22.04's Python 3.10 has no hashlib.file_digest.
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            actual = digest.hexdigest()
        if actual != expected:
            raise SystemExit(f"Checksum mismatch: {name}")
    return manifest


def main():
    verify(Path(__file__).resolve().parent)
    print("Hosted release checksums verified")


if __name__ == "__main__":
    main()
