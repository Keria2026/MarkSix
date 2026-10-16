#!/usr/bin/env python3
"""Deploy exactly the tested Ubuntu artifact; keep private state outside releases."""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys

import ops
import releases


def record(shared, data):
    releases.atomic_json(shared / "deployment.json", data)


def health(shared, expected_sha=None):
    config = ops.configuration(shared)
    for host, expected in (
        (config["APP_DOMAIN"], "hosted"),
        (config["ADMIN_DOMAIN"], "authority"),
    ):
        # Verify origin TLS/SNI and routing without depending on CDN caching.
        for path, key, value in (
            ("/api/site", "mode", expected),
            ("/api/health", "status", "ok"),
        ):
            result = subprocess.run(
                [
                    "curl",
                    "--fail",
                    "--silent",
                    "--show-error",
                    "--max-time",
                    "15",
                    "--resolve",
                    f"{host}:443:127.0.0.1",
                    f"https://{host}{path}",
                ],
                check=True,
                text=True,
                stdout=subprocess.PIPE,
            )
            data = json.loads(result.stdout)
            if data.get(key) != value:
                raise RuntimeError(f"Unexpected origin response for {host}{path}")
            if expected_sha is not None and data.get("commit") != expected_sha:
                raise RuntimeError(
                    f"Origin build does not match expected commit: {host}{path}"
                )


def certificate(shared):
    config = ops.configuration(shared)
    certificate = shared / "letsencrypt/live/marksix/fullchain.pem"
    if certificate.is_file():
        checks = [
            [
                "openssl",
                "x509",
                "-in",
                str(certificate),
                "-noout",
                "-checkend",
                "604800",
            ]
        ]
        checks += [
            [
                "openssl",
                "x509",
                "-in",
                str(certificate),
                "-noout",
                "-checkhost",
                config[key],
            ]
            for key in ("APP_DOMAIN", "ADMIN_DOMAIN")
        ]
        if all(
            subprocess.run(
                command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
            ).returncode
            == 0
            for command in checks
        ):
            return
    subprocess.run(["certbot", "--version"], check=True, stdout=subprocess.DEVNULL)
    ops.compose(shared, "stop", "--timeout", "30", "nginx")
    ops.compose(
        shared,
        "run",
        "-d",
        "--service-ports",
        "--no-deps",
        "--name",
        "marksix-acme-bootstrap",
        "nginx",
        "nginx",
        "-c",
        "/etc/nginx/bootstrap.conf",
        "-g",
        "daemon off;",
    )
    try:
        args = [
            "certbot",
            "certonly",
            "--non-interactive",
            "--agree-tos",
            "--webroot",
            "-w",
            str(shared / "acme"),
            "--cert-name",
            "marksix",
            "--force-renewal",
            "--config-dir",
            str(shared / "letsencrypt"),
            "--work-dir",
            str(shared / "acme-work"),
            "--logs-dir",
            str(shared / "acme-logs"),
            "-d",
            config["APP_DOMAIN"],
            "-d",
            config["ADMIN_DOMAIN"],
        ]
        if config.get("ACME_EMAIL"):
            args += ["--email", config["ACME_EMAIL"]]
        else:
            args += ["--register-unsafely-without-email"]
        subprocess.run(args, check=True)
    finally:
        subprocess.run(
            ["docker", "rm", "-f", "marksix-acme-bootstrap"],
            check=True,
            stdout=subprocess.DEVNULL,
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sha", required=True)
    parser.add_argument("--sequence", type=int, required=True)
    parser.add_argument("--attempt", type=int, required=True)
    parser.add_argument("--shared", type=Path, default=Path("/opt/marksix/shared"))
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9a-f]{40}", args.sha):
        parser.error("A complete Git commit SHA is required")
    shared = args.shared.resolve()
    if not (shared / ".env").is_file():
        subprocess.run(
            [
                sys.executable,
                str(ops.RELEASE / "configure.py"),
                "--shared",
                str(shared),
            ],
            check=True,
        )
    ops.configuration(shared)
    package = ops.RELEASE.parent
    manifest = json.loads((package / "manifest.json").read_text())
    if manifest["version"] != args.sha:
        raise RuntimeError("Artifact version does not match the requested commit")
    subprocess.run([sys.executable, str(package / "verify.py")], check=True)
    os.umask(0o077)
    (ops.RELEASE / ".images.env").write_text(
        f"BACKEND_IMAGE=marksix-backend:{args.sha}\nFRONTEND_IMAGE=marksix-frontend:{args.sha}\nMYSQL_IMAGE=marksix-mysql:{args.sha}\n"
    )
    current = shared.parent / "current"
    state = {
        "sha": args.sha,
        "sequence": args.sequence,
        "attempt": args.attempt,
        "started_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "status": "preparing",
    }
    with ops.lock(shared / ".operations.lock"):
        order = releases.check_order(shared, args.sha, args.sequence, args.attempt)
        releases.cleanup(shared, candidate=package)
        releases.require_space(
            shared, manifest["image_unpacked_bytes"] + releases.RESERVE
        )
        previous = current.resolve() if current.is_symlink() else None
        state["previous"] = str(previous) if previous else None
        releases.atomic_json(shared / "release-order.json", order)
        record(shared, state)
        releases.atomic_json(
            package / ".managed.json",
            {"sha": args.sha, "completed_at": state["started_at"]},
        )
        subprocess.run(
            ["docker", "load", "--input", str(package / "images.tar.gz")], check=True
        )
        # Container/network/volume names are specific to hosted Dev1.0; legacy
        # marksix and marksix-license installations are never stopped or removed.
        if previous and previous != ops.RELEASE:
            old_module = ops.RELEASE
            try:
                ops.RELEASE = previous
                ops.compose(shared, "stop", "--timeout", "45", "backend", "authority")
                state["backup"] = str(ops.backup(shared))
                state["status"] = "backed_up"
                record(shared, state)
            except BaseException:
                ops.compose(
                    shared,
                    "up",
                    "-d",
                    "--no-build",
                    "--pull",
                    "never",
                    "--wait",
                    "--wait-timeout",
                    "180",
                    "authority",
                    "backend",
                )
                raise
            finally:
                ops.RELEASE = old_module
        try:
            certificate(shared)
            state["status"] = "migrating"
            record(shared, state)
            # Authority performs central and tenant migrations before portal starts.
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
            ops.compose(shared, "exec", "-T", "nginx", "nginx", "-t")
            health(shared, args.sha)
            releases.switch_current(current, ops.RELEASE)
            state["status"] = "healthy"
            state["completed_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
            record(shared, state)
            releases.atomic_json(package / ".deployed.json", state)
            try:
                releases.cleanup(shared)
            except Exception as e:
                print(
                    f"Release retention failed; deployment remains healthy: {type(e).__name__}",
                    file=sys.stderr,
                )
            print(f"MarkSix deployed and origin health verified: {args.sha}")
        except BaseException:
            state["status"] = "failed"
            record(shared, state)
            # Do not run an older binary against a potentially migrated database.
            ops.compose(shared, "stop", "--timeout", "45", "backend", "authority")
            print(
                "Deployment failed. Application services stopped; databases and backups retained. Restore/review migration compatibility before rollback.",
                file=sys.stderr,
            )
            raise


if __name__ == "__main__":
    main()
