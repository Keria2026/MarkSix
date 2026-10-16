#!/usr/bin/env python3
"""Package tested Ubuntu x64 images and lifecycle scripts; no credentials."""

import argparse
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--backend", required=True)
    parser.add_argument("--frontend", required=True)
    parser.add_argument("--mysql", default="mysql:8.4")
    parser.add_argument("--output", type=Path, default=ROOT / "ubuntu-package")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", args.version):
        parser.error("Version must be a valid Docker image tag")
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error(
            "Output directory must be empty; existing files will not be overwritten"
        )
    output.mkdir(parents=True, exist_ok=True)
    tags = []
    for service, source, label in [
        ("backend", args.backend, "backend"),
        ("frontend", args.frontend, "frontend"),
        ("db", args.mysql, "mysql"),
    ]:
        platform = run(
            "docker",
            "image",
            "inspect",
            "--format",
            "{{.Os}}/{{.Architecture}}",
            source,
        )
        if platform != "linux/amd64":
            raise RuntimeError(f"{source}: expected linux/amd64, got {platform}")
        tag = f"marksix-{label}:{args.version}"
        subprocess.run(["docker", "tag", source, tag], check=True)
        tags.append(tag)
    shutil.copyfile(ROOT / "scripts/verify_package.py", output / "verify.py")
    (output / "README.md").write_text(
        "# MarkSix Ubuntu 托管部署\n\n请按 [部署指南](hosted/README.md) 配置、部署和维护。此工件仅支持 Ubuntu Docker 托管版。\n",
        encoding="utf-8",
    )
    # Allowlist only: never package shared .env, TLS keys or database backups.
    (output / "hosted").mkdir()
    for name in [
        "compose.yaml",
        "init-portal.sh",
        "nginx.conf.template",
        "bootstrap.conf",
        "customer.inc",
        "authority.inc",
        "configure.py",
        "ops.py",
        "deploy.py",
        "releases.py",
        "receive.py",
        "rollback.py",
        "deploy.sh",
        "renew.sh",
        "install-timers.sh",
        "prepare-server.sh",
        "release.sh",
        "nginx-main.conf",
        "README.md",
    ]:
        shutil.copyfile(ROOT / "deploy/vps" / name, output / "hosted" / name)
    (output / "fixtures").mkdir()
    shutil.copyfile(
        ROOT / "fixtures/customer-plays.json", output / "fixtures/customer-plays.json"
    )
    archive = output / "images.tar.gz"
    image_bytes = 0
    with subprocess.Popen(["docker", "save", *tags], stdout=subprocess.PIPE) as process:
        try:
            with gzip.open(archive, "wb", compresslevel=6) as destination:
                while chunk := process.stdout.read(1024 * 1024):
                    image_bytes += len(chunk)
                    destination.write(chunk)
        except BaseException:
            process.kill()
            raise
        finally:
            process.stdout.close()
        if process.wait():
            raise RuntimeError("docker save failed; package must not be published")
    # All packaged material is public application/configuration data. Make
    # MySQL init scripts readable even under a restrictive builder umask.
    for path in output.rglob("*"):
        path.chmod(0o755 if path.is_dir() else 0o644)
    hashes = {}
    for path in sorted(output.rglob("*")):
        if not path.is_file():
            continue
        with path.open("rb") as stream:
            digest = hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
            hashes[str(path.relative_to(output))] = digest.hexdigest()
    manifest = {
        "schema": 1,
        "version": args.version,
        "image_unpacked_bytes": image_bytes,
        "database_contract": {
            str(p.relative_to(ROOT / "backend")): hashlib.sha256(
                p.read_bytes()
            ).hexdigest()
            for p in sorted((ROOT / "backend/migrations").glob("*.sql"))
        },
        "platform": "linux/amd64",
        "target": "ubuntu",
        "built_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "files": hashes,
    }
    (output / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"Deployment package ready: {output} ({archive.stat().st_size:,} image bytes)"
    )


if __name__ == "__main__":
    main()
