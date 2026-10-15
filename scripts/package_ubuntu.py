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
    compose = json.loads(
        run(
            "docker",
            "compose",
            "-f",
            str(ROOT / "compose.yaml"),
            "config",
            "--no-interpolate",
            "--format",
            "json",
        )
    )
    # Let the explicit Compose project name control resource names.
    for section in ("volumes", "networks"):
        for resource in compose.get(section, {}).values():
            resource.pop("name", None)
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
        compose["services"][service].pop("build", None)
        compose["services"][service]["image"] = tag
        compose["services"][service]["pull_policy"] = "never"
        tags.append(tag)
    # JSON is valid YAML, avoiding an additional packaging dependency.
    (output / "compose.yaml").write_text(
        json.dumps(compose, indent=2).replace(
            "Run scripts/configure.py first", "Run install.sh first"
        )
        + "\n",
        encoding="utf-8",
    )
    shutil.copytree(ROOT / "deploy/ubuntu", output, dirs_exist_ok=True)
    (output / "scripts").mkdir(exist_ok=True)
    for name in ["configure.py", "backup.sh", "restore.sh"]:
        shutil.copyfile(ROOT / "scripts" / name, output / "scripts" / name)
    shutil.copyfile(ROOT / "docs/RUNNING.md", output / "README.md")
    shutil.copyfile(ROOT / "docs/LICENSING.md", output / "LICENSING.md")
    shutil.copyfile(ROOT / "docs/legacy/RUNNING.md", output / "LEGACY_LOCAL_README.md")
    shutil.copyfile(ROOT / "docs/legacy/LICENSING.md", output / "LEGACY_LICENSING.md")
    # Repository-relative links must point at their shipped artifact locations.
    for name, replacements in {
        "README.md": {
            "../deploy/vps/README.md": "hosted/README.md",
            "legacy/RUNNING.md": "LEGACY_LOCAL_README.md",
        },
        "LICENSING.md": {
            "../deploy/vps/README.md": "hosted/README.md",
            "legacy/LICENSING.md": "LEGACY_LICENSING.md",
        },
        "LEGACY_LOCAL_README.md": {"(LICENSING.md)": "(LEGACY_LICENSING.md)"},
    }.items():
        path = output / name
        text = path.read_text(encoding="utf-8")
        for source, target in replacements.items():
            text = text.replace(source, target)
        path.write_text(text, encoding="utf-8")
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
    (output / "license-authority").mkdir()
    # Explicit allowlist: never copy owner .env, private keys, or local data.
    for name in ["compose.yaml", "setup.py"]:
        shutil.copyfile(
            ROOT / "deploy/license-authority" / name,
            output / "license-authority" / name,
        )
    authority_compose = (output / "license-authority/compose.yaml").read_text()
    authority_compose = authority_compose.replace(
        "${BACKEND_IMAGE:-marksix-backend:local}", tags[0]
    ).replace("mysql:8.4", tags[2])
    (output / "license-authority/compose.yaml").write_text(authority_compose)
    archive = output / "images.tar.gz"
    with subprocess.Popen(["docker", "save", *tags], stdout=subprocess.PIPE) as process:
        try:
            with gzip.open(archive, "wb", compresslevel=6) as destination:
                shutil.copyfileobj(process.stdout, destination, length=1024 * 1024)
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
            hashes[str(path.relative_to(output))] = hashlib.file_digest(
                stream, "sha256"
            ).hexdigest()
    manifest = {
        "schema": 1,
        "version": args.version,
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
