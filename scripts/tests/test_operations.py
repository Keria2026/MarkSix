"""Exercise operations orchestration with isolated files and fake external processes."""

import contextlib
import gzip
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy/vps"))
import ops
import deploy
import releases
import rollback

ACCOUNT = (
    "a" * 8 + "-aaaa-aaaa-aaaa-" + "a" * 12,
    "marksix_t_" + "a" * 32,
    "mt_" + "a" * 24,
    "ready",
)


class Process:
    def __init__(self, code=0, broken=False):
        self.stdout = io.BytesIO(b"SELECT 42;\n")
        self.stdin = Mock()
        if broken:
            self.stdin.write.side_effect = BrokenPipeError("synthetic")
        self.code = code
        self.killed = False

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def wait(self):
        return self.code

    def kill(self):
        self.killed = True


class Operations(unittest.TestCase):
    def test_dump_compresses_atomically_and_cleans_failed_partial(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            destination = root / "backup" / "sample.sql.gz"
            for code in [0, 1]:
                with (
                    self.subTest(code=code),
                    patch.object(ops.subprocess, "Popen", return_value=Process(code)),
                ):
                    if code:
                        with self.assertRaisesRegex(RuntimeError, "Dump failed"):
                            ops.dump(root, "marksix_control", destination)
                    else:
                        ops.dump(root, "marksix_control", destination)
                self.assertEqual(
                    gzip.decompress(destination.read_bytes()), b"SELECT 42;\n"
                )
                self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
                self.assertFalse(destination.with_suffix(".partial").exists())

    def test_backup_retention_preserves_named_generation_and_manifest_hashes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)

            def dump(shared, db, path):
                path.parent.mkdir(parents=True, exist_ok=True)
                with gzip.open(path, "wb") as stream:
                    stream.write(b"SELECT 1;")

            with (
                patch.object(ops, "account_list", return_value=[ACCOUNT]),
                patch.object(ops, "dump", side_effect=dump),
                patch.object(ops, "configuration", return_value={"BACKUP_KEEP": "1"}),
                patch.object(ops.os, "geteuid", return_value=1000),
                patch.object(ops, "compose") as compose,
            ):
                first = ops.backup(root)
                preserved = json.loads(first.read_text())["created_at"]
                second = ops.backup(root, preserve=preserved)
                self.assertTrue(first.exists())
                third = ops.backup(root)
                self.assertFalse(first.exists())
                self.assertFalse(second.exists())
                self.assertEqual(
                    ops.validate_restore(root, third)["accounts"][0]["id"], ACCOUNT[0]
                )
                self.assertEqual(compose.call_count, 6)
            with (
                patch.object(
                    ops, "account_list", return_value=[(*ACCOUNT[:3], "failed")]
                ),
                self.assertRaisesRegex(RuntimeError, "provisioning"),
            ):
                ops.backup_data(root)

    def test_account_identifiers_and_configuration_mismatch_are_rejected(self):
        with patch.object(ops, "mysql", return_value=["\t".join(ACCOUNT)]):
            self.assertEqual(ops.account_list(Path("/unused")), [ACCOUNT])
        with (
            patch.object(ops, "mysql", return_value=["bad\tdb\tuser\tready"]),
            self.assertRaisesRegex(RuntimeError, "identifiers"),
        ):
            ops.account_list(Path("/unused"))
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ".env").write_text("# comment\n\nHOSTED_SHARED_ROOT=/different\n")
            with self.assertRaisesRegex(RuntimeError, "Shared path"):
                ops.configuration(root)
        with patch.object(
            ops.subprocess, "run", return_value=Mock(stdout="one\ntwo\n")
        ) as run:
            self.assertEqual(ops.mysql(Path("/unused"), "SELECT 1;"), ["one", "two"])
            self.assertEqual(run.call_args.kwargs["input"], "SELECT 1;")

    def test_restore_recreates_only_live_accounts_and_clears_sessions(self):
        for failure in [None, "exit", "pipe"]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                stamp = "20400101T000000Z"
                paths = [
                    f"control/{stamp}.sql.gz",
                    f"tenants/{ACCOUNT[0]}/{stamp}.sql.gz",
                ]
                for name in paths:
                    path = root / "backups" / name
                    path.parent.mkdir(parents=True, exist_ok=True)
                    with gzip.open(path, "wb") as out:
                        out.write(b"SELECT 1;")
                data = {"created_at": stamp, "files": dict.fromkeys(paths, "test")}
                deleted = "b" * 8 + "-bbbb-bbbb-bbbb-" + "b" * 12
                process = Process(
                    code=1 if failure == "exit" else 0, broken=failure == "pipe"
                )

                def mysql(shared, sql):
                    return [deleted] if "SELECT account_id" in sql else []

                with (
                    patch.object(ops, "validate_restore", return_value=data),
                    patch.object(
                        ops,
                        "account_list",
                        side_effect=[
                            [ACCOUNT],
                            [
                                ACCOUNT,
                                (
                                    deleted,
                                    "marksix_t_" + "b" * 32,
                                    "mt_" + "b" * 24,
                                    "ready",
                                ),
                            ],
                        ],
                    ),
                    patch.object(ops, "mysql", side_effect=mysql) as execute,
                    patch.object(ops.subprocess, "Popen", return_value=process),
                ):
                    if failure:
                        with self.assertRaises((RuntimeError, BrokenPipeError)):
                            ops.restore_data(root, root / "manifest")
                        self.assertFalse(
                            any(
                                "DELETE FROM hosted_sessions" in c.args[1]
                                for c in execute.call_args_list
                            )
                        )
                        if failure == "pipe":
                            self.assertTrue(process.killed)
                    else:
                        ops.restore_data(root, root / "manifest")
                        sql = "\n".join(c.args[1] for c in execute.call_args_list)
                        self.assertIn("DROP DATABASE IF EXISTS", sql)
                        self.assertIn("CREATE DATABASE", sql)
                        self.assertIn("INSERT IGNORE INTO hosted_deletions", sql)
                        self.assertIn("DELETE FROM hosted_sessions", sql)
                        self.assertNotIn("CREATE DATABASE `marksix_t_" + "b" * 32, sql)

    def test_cli_start_stop_status_backup_and_safe_restore_recovery(self):
        for operation in ["start", "stop", "status", "backup", "restore"]:
            with (
                self.subTest(operation=operation),
                tempfile.TemporaryDirectory() as folder,
            ):
                root = Path(folder)
                manifest = root / "manifest.json"
                manifest.write_text(json.dumps({"created_at": "20400101T000000Z"}))
                args = ["ops", operation, "--shared", str(root)]
                if operation == "restore":
                    args += ["--manifest", str(manifest), "--confirm-restore"]
                with (
                    patch.object(sys, "argv", args),
                    patch.object(ops, "configuration"),
                    patch.object(ops, "compose") as compose,
                    patch.object(ops, "backup", return_value=manifest),
                    patch.object(ops, "validate_restore"),
                    patch.object(
                        ops, "restore", side_effect=ops.RestorePreflightError("erased")
                    ),
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    if operation == "restore":
                        with self.assertRaises(ops.RestorePreflightError):
                            ops.main()
                        self.assertEqual(
                            compose.call_args.args[-2:], ("authority", "backend")
                        )
                    else:
                        ops.main()
                    self.assertGreater(compose.call_count, 0)


class Deployment(unittest.TestCase):
    def test_health_checks_mode_sha_and_rejects_mismatch(self):
        with patch.object(
            ops,
            "configuration",
            return_value={"APP_DOMAIN": "app.test", "ADMIN_DOMAIN": "admin.test"},
        ):

            def response(command, **kwargs):
                url = command[-1]
                return Mock(
                    stdout=json.dumps(
                        {
                            "mode": "hosted" if "app.test" in url else "authority",
                            "status": "ok",
                            "commit": "a" * 40,
                        }
                    )
                )

            with patch.object(deploy.subprocess, "run", side_effect=response) as run:
                deploy.health(Path("/unused"), "a" * 40)
                self.assertEqual(run.call_count, 4)
                with self.assertRaisesRegex(RuntimeError, "commit"):
                    deploy.health(Path("/unused"), "b" * 40)
            with (
                patch.object(deploy.subprocess, "run", return_value=Mock(stdout="{}")),
                self.assertRaisesRegex(RuntimeError, "response"),
            ):
                deploy.health(Path("/unused"))

    def test_certificate_uses_valid_cert_or_cleans_bootstrap_after_failure(self):
        for exists, fail, email in [
            (True, False, ""),
            (False, False, "test@example.test"),
            (False, True, ""),
        ]:
            with (
                self.subTest(exists=exists, fail=fail),
                tempfile.TemporaryDirectory() as folder,
            ):
                root = Path(folder)
                if exists:
                    path = root / "letsencrypt/live/marksix/fullchain.pem"
                    path.parent.mkdir(parents=True)
                    path.write_text("synthetic")

                def run(args, **kwargs):
                    if fail and "certonly" in args:
                        raise subprocess.CalledProcessError(1, args)
                    return Mock(returncode=0)

                with (
                    patch.object(
                        ops,
                        "configuration",
                        return_value={
                            "APP_DOMAIN": "app.test",
                            "ADMIN_DOMAIN": "admin.test",
                            "ACME_EMAIL": email,
                        },
                    ),
                    patch.object(ops, "compose") as compose,
                    patch.object(deploy.subprocess, "run", side_effect=run) as command,
                ):
                    if fail:
                        with self.assertRaises(subprocess.CalledProcessError):
                            deploy.certificate(root)
                    else:
                        deploy.certificate(root)
                    if exists:
                        compose.assert_not_called()
                    else:
                        self.assertEqual(
                            command.call_args.args[0],
                            ["docker", "rm", "-f", "marksix-acme-bootstrap"],
                        )

    def test_retention_protects_current_previous_candidate_and_unknown(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            shared = root / "shared"
            shared.mkdir()
            directory = root / "releases"
            directory.mkdir()
            paths = []
            for i in range(8):
                path = directory / f"{i:040x}"
                path.mkdir()
                (path / "hosted").mkdir()
                paths.append(path)
                for marker in [".managed.json", ".deployed.json"]:
                    (path / marker).write_text(
                        json.dumps({"sha": path.name, "completed_at": str(i)})
                    )
            (root / "current").symlink_to(paths[0] / "hosted")
            (shared / "deployment.json").write_text(
                json.dumps({"sha": paths[1].name, "previous": str(paths[2] / "hosted")})
            )
            unknown = directory / "unmanaged"
            unknown.mkdir()
            incoming = directory / (".incoming-1-1-" + "a" * 40)
            incoming.mkdir()
            os.utime(incoming, (1, 1))
            with patch.object(
                releases.subprocess, "run", return_value=Mock(returncode=0)
            ) as command:
                releases.cleanup(shared, keep=1, candidate=paths[3])
            self.assertTrue(all(p.exists() for p in paths[:4] + [paths[7], unknown]))
            self.assertTrue(all(not p.exists() for p in paths[4:7] + [incoming]))
            self.assertEqual(command.call_count, 18)

    def test_successful_rollback_switches_only_after_health(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            shared = root / "shared"
            shared.mkdir()
            a = "a" * 40
            b = "b" * 40
            (shared / "deployment.json").write_text(json.dumps({"sha": a}))
            for sha in [a, b]:
                p = root / "releases" / sha
                p.mkdir(parents=True)
                (p / "hosted").mkdir()
                (p / "manifest.json").write_text(
                    json.dumps({"database_contract": {"m": "same"}})
                )
                (p / ".deployed.json").write_text("{}")
            with (
                patch.object(
                    sys,
                    "argv",
                    [
                        "rollback",
                        "--sha",
                        b,
                        "--confirm-rollback",
                        "--shared",
                        str(shared),
                    ],
                ),
                patch.object(ops, "configuration"),
                patch.object(ops, "compose"),
                patch.object(ops, "backup", return_value=shared / "backup"),
                patch.object(rollback.subprocess, "run"),
                patch.object(deploy, "health"),
                contextlib.redirect_stdout(io.StringIO()),
            ):
                rollback.main()
            self.assertEqual(
                (root / "current").resolve(), root / "releases" / b / "hosted"
            )
            self.assertEqual(
                json.loads((shared / "deployment.json").read_text())["operation"],
                "manual-rollback",
            )


class SuccessfulDeployment(unittest.TestCase):
    def test_successful_upgrade_backs_up_previous_then_switches_current(self):
        for backup_failure in [False, True]:
            with (
                self.subTest(backup_failure=backup_failure),
                tempfile.TemporaryDirectory() as folder,
            ):
                root = Path(folder)
                shared = root / "shared"
                shared.mkdir()
                (shared / ".env").write_text("configured")
                previous = root / "previous" / "hosted"
                previous.mkdir(parents=True)
                (root / "current").symlink_to(previous)
                package = root / "release"
                hosted = package / "hosted"
                hosted.mkdir(parents=True)
                sha = "c" * 40
                (package / "manifest.json").write_text(
                    json.dumps({"version": sha, "image_unpacked_bytes": 1})
                )
                with (
                    patch.object(
                        sys,
                        "argv",
                        [
                            "deploy",
                            "--sha",
                            sha,
                            "--sequence",
                            "2",
                            "--attempt",
                            "1",
                            "--shared",
                            str(shared),
                        ],
                    ),
                    patch.object(ops, "RELEASE", hosted),
                    patch.object(ops, "configuration"),
                    patch.object(deploy.subprocess, "run"),
                    patch.object(releases, "cleanup"),
                    patch.object(releases, "require_space"),
                    patch.object(deploy, "certificate"),
                    patch.object(deploy, "health"),
                    patch.object(
                        ops,
                        "backup",
                        side_effect=RuntimeError("backup failed")
                        if backup_failure
                        else None,
                        return_value=shared / "backup",
                    ),
                    patch.object(ops, "compose") as compose,
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    if backup_failure:
                        with self.assertRaisesRegex(RuntimeError, "backup failed"):
                            deploy.main()
                        self.assertEqual((root / "current").resolve(), previous)
                        self.assertEqual(
                            compose.call_args.args[-2:], ("authority", "backend")
                        )
                    else:
                        deploy.main()
                        self.assertEqual((root / "current").resolve(), hosted)
                        self.assertEqual(
                            json.loads((shared / "deployment.json").read_text())[
                                "status"
                            ],
                            "healthy",
                        )
                        self.assertEqual(
                            json.loads((package / ".deployed.json").read_text())[
                                "backup"
                            ],
                            str(shared / "backup"),
                        )
