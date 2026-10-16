#!/usr/bin/env python3
"""Verify a complete hosted release before loading images or changing services."""

import hashlib
import json
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != 1 or manifest.get("platform") != "linux/amd64":
        raise SystemExit("Unsupported release manifest")
    files = manifest.get("files", {})
    if (
        not {"images.tar.gz", "hosted/compose.yaml", "hosted/release.sh"}
        <= files.keys()
    ):
        raise SystemExit("Incomplete hosted release")
    for name, expected in files.items():
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
    print("Hosted release checksums verified")


if __name__ == "__main__":
    main()
