#!/usr/bin/env python3
"""Validate local links in the maintained documentation tree."""

from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]


def main():
    errors = []
    paths = [ROOT / "README.md", *sorted((ROOT / "docs").rglob("*.md"))]
    for path in paths:
        content = re.sub(r"```[^\n]*\n.*?```", "", path.read_text(), flags=re.S)
        for match in re.finditer(r"\[[^\]]*\]\(([^\s)]+)\)", content):
            target = urlsplit(match.group(1))
            if target.scheme or target.netloc or not target.path:
                continue
            resolved = (path.parent / unquote(target.path)).resolve()
            if not resolved.is_relative_to(ROOT) or not resolved.exists():
                errors.append(f"{path.relative_to(ROOT)}: missing {match.group(1)}")
    if errors:
        raise SystemExit("\n".join(errors))
    print(f"Documentation links verified: {len(paths)} files")


if __name__ == "__main__":
    main()
