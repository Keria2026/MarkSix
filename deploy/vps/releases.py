"""Release ordering, disk budgets and project-owned artifact retention."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

RESERVE = 2 * 1024**3
SHA = re.compile(r"[0-9a-f]{40}")


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_json(path, data):
    temporary = path.with_suffix(".partial")
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(data, stream, indent=2)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    sync_directory(path.parent)


def switch_current(current, release):
    temporary = current.with_name("current.next")
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(release)
    temporary.replace(current)
    sync_directory(current.parent)


def check_order(shared, sha, sequence, attempt):
    if sequence < 1 or attempt < 1:
        raise RuntimeError("A positive Actions run number and attempt are required")
    path = shared / "release-order.json"
    if path.exists():
        previous = json.loads(path.read_text())
        if sequence < previous["sequence"] or (
            sequence == previous["sequence"]
            and (sha != previous["sha"] or attempt < previous["attempt"])
        ):
            raise RuntimeError(
                "Stale deployment rejected; installed release was not changed"
            )
    return {"sha": sha, "sequence": sequence, "attempt": attempt}


def require_space(root, required):
    if shutil.disk_usage(root).free < required:
        raise RuntimeError(
            f"Insufficient disk space; need {required} free bytes before transfer/load"
        )


def cleanup(shared, keep=3, candidate=None):
    # Only delete verified project-owned releases. Unknown files, volumes and
    # backups are never garbage collected here; recent failures stay available.
    root = shared.parent / "releases"
    protected = {candidate} if candidate else set()
    current = shared.parent / "current"
    if current.is_symlink():
        protected.add(current.resolve().parent)
    deployment = shared / "deployment.json"
    if deployment.is_file():
        state = json.loads(deployment.read_text())
        if SHA.fullmatch(state.get("sha", "")):
            protected.add(root / state["sha"])
        previous = state.get("previous")
        if previous:
            protected.add(Path(previous).resolve().parent)
    healthy, managed = [], []
    for path in root.iterdir():
        if path.is_symlink() or not SHA.fullmatch(path.name) or not path.is_dir():
            continue
        for marker, collection in [
            (".deployed.json", healthy),
            (".managed.json", managed),
        ]:
            receipt = path / marker
            if receipt.is_file():
                data = json.loads(receipt.read_text())
                if data.get("sha") == path.name:
                    collection.append((data["completed_at"], path))
    healthy.sort(reverse=True)
    managed.sort(reverse=True)
    protected.update(path for _, path in healthy[:keep])
    protected.update(path for _, path in managed[:keep])
    for path in {p for _, p in [*healthy, *managed]} - protected:
        for service in ("backend", "frontend", "mysql"):
            tag = f"marksix-{service}:{path.name}"
            exists = subprocess.run(
                ["docker", "image", "inspect", tag],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            if exists.returncode == 0:
                subprocess.run(
                    ["docker", "image", "rm", tag],
                    check=True,
                    stdout=subprocess.DEVNULL,
                )
        shutil.rmtree(path)
    # Successful archives are redundant once unpacked; interrupted uploads expire
    # only after 48h, far beyond the serialized deployment timeout.
    cutoff = time.time() - 48 * 3600
    for path in root.iterdir():
        if (
            not path.is_symlink()
            and path.is_dir()
            and re.fullmatch(r"\.incoming-[0-9]+-[0-9]+-[0-9a-f]{40}", path.name)
            and path.stat().st_mtime < cutoff
        ):
            shutil.rmtree(path)
