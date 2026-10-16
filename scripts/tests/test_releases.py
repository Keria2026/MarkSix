"""Production gates with disposable files and command doubles; never a VPS."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(
        name, ROOT / "deploy/vps" / f"{name}.py"
    )
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class ReleasesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.shared = self.root / "shared"
        self.shared.mkdir()
        self.releases = self.root / "releases"
        self.releases.mkdir()
        self.ops = module("ops")
        self.release = module("releases")
        with patch.dict(sys.modules, ops=self.ops, releases=self.release):
            self.deploy = module("deploy")
            with patch.dict(sys.modules, deploy=self.deploy):
                self.rollback = module("rollback")

    def order(self, sha, sequence, attempt=1):
        return self.release.check_order(self.shared, sha, sequence, attempt)

    def test_old_build_and_attempt_are_rejected_but_same_commit_retry_is_allowed(self):
        self.release.atomic_json(
            self.shared / "release-order.json", self.order("b" * 40, 20, 2)
        )
        for sha, seq, attempt in [
            ("a" * 40, 19, 3),
            ("a" * 40, 20, 3),
            ("b" * 40, 20, 1),
        ]:
            with self.assertRaisesRegex(RuntimeError, "Stale deployment"):
                self.order(sha, seq, attempt)
        self.assertEqual(self.order("b" * 40, 20, 3)["attempt"], 3)
        self.assertEqual(self.order("c" * 40, 21)["sequence"], 21)

    def test_stale_deploy_cannot_change_pointer_or_run_container_commands(self):
        current = self.releases / ("b" * 40) / "hosted"
        current.mkdir(parents=True)
        (self.root / "current").symlink_to(current)
        candidate = self.releases / ("a" * 40)
        (candidate / "hosted").mkdir(parents=True)
        (candidate / "manifest.json").write_text(
            json.dumps({"version": "a" * 40, "image_unpacked_bytes": 1024})
        )
        (self.shared / ".env").touch()
        self.release.atomic_json(
            self.shared / "release-order.json", self.order("b" * 40, 20)
        )
        commands = []
        self.ops.RELEASE = candidate / "hosted"
        self.ops.configuration = lambda _: {}
        self.ops.compose = lambda *a, **k: commands.append(a)
        args = [
            "deploy.py",
            "--sha",
            "a" * 40,
            "--sequence",
            "19",
            "--attempt",
            "1",
            "--shared",
            str(self.shared),
        ]
        with (
            patch.object(sys, "argv", args),
            patch.object(self.deploy.subprocess, "run") as run,
        ):
            with self.assertRaisesRegex(RuntimeError, "Stale deployment"):
                self.deploy.main()
        self.assertEqual(commands, [])
        self.assertFalse(any(c.args[0][0] == "docker" for c in run.call_args_list))
        self.assertEqual((self.root / "current").resolve(), current)
        self.assertFalse((self.shared / "deployment.json").exists())

    def test_pretransfer_low_disk_leaves_no_staging_directory(self):
        receive = module("receive")
        args = [
            "receive.py",
            "prepare",
            "a" * 40,
            "21",
            "1",
            "100",
            "200",
            "300",
            "--root",
            str(self.releases),
        ]
        with (
            patch.object(sys, "argv", args),
            patch.object(receive.shutil, "disk_usage", return_value=Mock(free=128)),
        ):
            with self.assertRaisesRegex(RuntimeError, "before upload"):
                receive.main()
        self.assertEqual(list(self.releases.iterdir()), [])

    def test_retention_protects_current_previous_latest_and_unowned_files(self):
        for n in range(1, 7):
            p = self.releases / f"{n:040x}"
            p.mkdir()
            (p / ".deployed.json").write_text(
                json.dumps({"sha": p.name, "completed_at": n})
            )
        unknown = self.releases / "other-application"
        unknown.mkdir()
        (self.root / "current").symlink_to(self.releases / f"{1:040x}" / "hosted")
        self.release.atomic_json(
            self.shared / "deployment.json",
            {"previous": str(self.releases / f"{2:040x}" / "hosted")},
        )
        with patch.object(
            self.release.subprocess, "run", return_value=Mock(returncode=0)
        ) as run:
            self.release.cleanup(self.shared)
        self.assertTrue(unknown.exists())
        for n in [1, 2, 4, 5, 6]:
            self.assertTrue((self.releases / f"{n:040x}").exists())
        self.assertFalse((self.releases / f"{3:040x}").exists())
        self.assertEqual(
            len([c for c in run.call_args_list if c.args[0][2] == "rm"]), 3
        )
        self.assertFalse(
            any("prune" in str(c) or "volume" in str(c) for c in run.call_args_list)
        )

    def test_rollback_rejects_changed_or_missing_schema_contract_without_stopping(self):
        source, target = [self.releases / (n * 40) for n in ["a", "b"]]
        source.mkdir()
        target.mkdir()
        (self.shared / "deployment.json").write_text(json.dumps({"sha": source.name}))
        (source / "manifest.json").write_text(
            json.dumps({"database_contract": {"migration": "new"}})
        )
        self.ops.configuration = lambda _: {}
        self.ops.compose = Mock()
        args = [
            "rollback.py",
            "--sha",
            target.name,
            "--confirm-rollback",
            "--shared",
            str(self.shared),
        ]
        for contract in [None, {"migration": "old"}]:
            (target / "manifest.json").write_text(
                json.dumps({"database_contract": contract})
            )
            with patch.object(sys, "argv", args):
                with self.assertRaisesRegex(RuntimeError, "compatibility unproven"):
                    self.rollback.main()
        self.ops.compose.assert_not_called()

    def test_compatible_rollback_preserves_release_high_water_and_switches_after_health(
        self,
    ):
        source, target = [self.releases / (n * 40) for n in ["a", "b"]]
        for path in [source, target]:
            (path / "hosted").mkdir(parents=True)
            (path / "manifest.json").write_text(
                json.dumps(
                    {"version": path.name, "database_contract": {"migration": "same"}}
                )
            )
            (path / ".deployed.json").write_text("{}")
        (self.root / "current").symlink_to(source / "hosted")
        self.release.atomic_json(
            self.shared / "deployment.json", {"sha": source.name, "status": "healthy"}
        )
        self.release.atomic_json(
            self.shared / "release-order.json", self.order(source.name, 50)
        )
        commands = []
        self.ops.configuration = lambda _: {}
        self.ops.compose = lambda _, *args, **kw: commands.append(args)
        self.ops.backup = lambda _: self.shared / "recovery.json"
        self.deploy.health = Mock()
        args = [
            "rollback.py",
            "--sha",
            target.name,
            "--confirm-rollback",
            "--shared",
            str(self.shared),
        ]
        with (
            patch.object(sys, "argv", args),
            patch.object(self.rollback.subprocess, "run"),
        ):
            self.rollback.main()
        self.assertEqual((self.root / "current").resolve(), target / "hosted")
        self.assertEqual(
            json.loads((self.shared / "release-order.json").read_text())["sequence"], 50
        )
        self.assertEqual([c[0] for c in commands], ["stop", "up"])
        self.deploy.health.assert_called_once()

    def test_extract_rejects_links_and_path_traversal_before_running_verifier(self):
        import io
        import tarfile

        receive = module("receive")
        for name, kind in [
            ("../outside", tarfile.REGTYPE),
            ("hosted/link", tarfile.SYMTYPE),
        ]:
            stage = self.releases / (".incoming-21-1-" + "c" * 40)
            stage.mkdir()
            archive = stage / "package.tar"
            with tarfile.open(archive, "w") as output:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.size = 1 if kind == tarfile.REGTYPE else 0
                member.linkname = "/etc/passwd" if kind == tarfile.SYMTYPE else ""
                output.addfile(member, io.BytesIO(b"x") if member.size else None)
            args = [
                "receive.py",
                "extract",
                "c" * 40,
                "21",
                "1",
                str(archive.stat().st_size),
                str(member.size or 1),
                "100",
                "--root",
                str(self.releases),
            ]
            with (
                patch.object(sys, "argv", args),
                patch.object(receive.subprocess, "run") as run,
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "Invalid archive|expanded size"
                ):
                    receive.main()
                run.assert_not_called()
            self.assertFalse((self.root / "outside").exists())
            import shutil

            shutil.rmtree(stage)

    def test_upload_verifies_and_atomically_extracts_without_retaining_outer_tar(self):
        import hashlib
        import shutil
        import tarfile

        receive = module("receive")
        content = self.root / "content"
        (content / "hosted").mkdir(parents=True)
        files = {
            "images.tar.gz": b"fixture image bytes",
            "hosted/compose.yaml": b"fixture compose",
            "hosted/release.sh": b"fixture release",
        }
        files["verify.py"] = (ROOT / "scripts/verify_package.py").read_bytes()
        for name, value in files.items():
            (content / name).write_bytes(value)
        manifest = {
            "schema": 1,
            "version": "d" * 40,
            "platform": "linux/amd64",
            "image_unpacked_bytes": 1024,
            "files": {n: hashlib.sha256(v).hexdigest() for n, v in files.items()},
        }
        (content / "manifest.json").write_text(json.dumps(manifest))
        archive = self.root / "fixture.tar"
        with tarfile.open(archive, "w") as output:
            output.add(content, arcname=".")
        with tarfile.open(archive) as source:
            expanded = sum(m.size for m in source)
        for attempt in [1, 2]:
            rest = [
                "d" * 40,
                "21",
                str(attempt),
                str(archive.stat().st_size),
                str(expanded),
                "1024",
                "--root",
                str(self.releases),
            ]
            with (
                patch.object(sys, "argv", ["receive.py", "prepare", *rest]),
                patch.object(
                    receive.shutil, "disk_usage", return_value=Mock(free=10 * 1024**3)
                ),
            ):
                receive.main()
            stage = self.releases / (f".incoming-21-{attempt}-" + "d" * 40)
            shutil.copyfile(archive, stage / "package.tar")
            with patch.object(sys, "argv", ["receive.py", "extract", *rest]):
                receive.main()
            self.assertFalse(stage.exists())
            self.assertFalse((self.releases / ("d" * 40) / "package.tar").exists())
            self.assertEqual(
                json.loads((self.releases / ("d" * 40) / "manifest.json").read_text()),
                manifest,
            )

    def test_failed_upload_cleanup_only_discards_its_own_staging(self):
        receive = module("receive")
        stage = self.releases / (".incoming-21-1-" + "a" * 40)
        stage.mkdir()
        (stage / "package.tar").write_bytes(b"partial upload")
        other = self.releases / (".incoming-21-2-" + "a" * 40)
        other.mkdir()
        args = [
            "receive.py",
            "discard",
            "a" * 40,
            "21",
            "1",
            "100",
            "200",
            "300",
            "--root",
            str(self.releases),
        ]
        with patch.object(sys, "argv", args):
            receive.main()
            receive.main()
        self.assertFalse(stage.exists())
        self.assertTrue(other.exists())

    def test_origin_health_rejects_old_running_binary_even_when_routes_are_healthy(
        self,
    ):
        self.ops.configuration = lambda _: {
            "APP_DOMAIN": "app.test",
            "ADMIN_DOMAIN": "admin.test",
        }

        def response(command, **kwargs):
            host = "authority" if "admin.test" in command[-1] else "hosted"
            return Mock(
                stdout=json.dumps({"mode": host, "status": "ok", "commit": "b" * 40})
            )

        with patch.object(self.deploy.subprocess, "run", side_effect=response):
            self.deploy.health(self.shared, "b" * 40)
            with self.assertRaisesRegex(RuntimeError, "expected commit"):
                self.deploy.health(self.shared, "a" * 40)


if __name__ == "__main__":
    unittest.main()
