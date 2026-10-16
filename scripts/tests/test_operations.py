"""Failure-path regressions. All files and command effects are isolated doubles."""

import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def module_at(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RestoreTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="marksix-ops-test-")
        self.addCleanup(self.directory.cleanup)
        self.shared = Path(self.directory.name)
        self.ops = module_at("test_hosted_ops", ROOT / "deploy/vps/ops.py")
        self.stamp = "20261015T000000000000Z-deadbeef"
        self.manifest = self.shared / "backups/control/backup.json"
        self.data = {"schema": 1, "created_at": self.stamp, "accounts": [], "files": {}}
        self.dump(f"control/{self.stamp}.sql.gz")
        self.save_manifest()
        self.commands = []
        self.ops.configuration = lambda shared: {}
        self.ops.compose = lambda shared, *args, **kwargs: self.commands.append(args)
        self.ops.backup = lambda shared, preserve=None: self.manifest

    def dump(self, name):
        path = self.shared / "backups" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"isolated backup fixture")
        self.data["files"][name] = hashlib.sha256(path.read_bytes()).hexdigest()

    def save_manifest(self):
        self.manifest.write_text(json.dumps(self.data))

    def add_account(self):
        self.data["accounts"].append({"id": "customer"})
        self.dump(f"tenants/customer/{self.stamp}.sql.gz")
        self.save_manifest()

    def erase_receipt(self):
        path = self.shared / "backups/erasures/customer.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(
                {
                    "account_id": "customer",
                    "cleared_at_utc": "2026-10-16T00:00:00+00:00",
                }
            )
        )

    def run_restore(self):
        args = [
            "ops.py",
            "restore",
            "--shared",
            str(self.shared),
            "--manifest",
            str(self.manifest),
            "--confirm-restore",
        ]
        with patch.object(sys, "argv", args), redirect_stdout(io.StringIO()):
            self.ops.main()

    def app_commands(self, operation):
        return [c for c in self.commands if c[0] == operation and "backend" in c]

    def test_erased_backup_is_rejected_without_stopping_the_site(self):
        self.add_account()
        self.erase_receipt()
        self.ops.mysql = lambda *args: self.fail("Preflight must not execute SQL")
        with self.assertRaisesRegex(RuntimeError, "predates customer history erasure"):
            self.run_restore()
        self.assertEqual(self.commands, [])

    def test_corrupt_backup_is_rejected_without_stopping_the_site(self):
        self.manifest.with_name(f"{self.stamp}.sql.gz").write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            self.run_restore()
        self.assertEqual(self.commands, [])

    def test_missing_tenant_dump_is_rejected_before_any_sql(self):
        self.data["accounts"] = [{"id": "customer"}]
        self.save_manifest()
        self.ops.mysql = lambda *args: self.fail("Preflight must not execute SQL")
        with self.assertRaisesRegex(self.ops.RestorePreflightError, "Missing tenant"):
            self.ops.restore_data(self.shared, self.manifest)

    def test_erasure_between_preflight_and_shutdown_restarts_applications(self):
        self.add_account()

        def backup(shared, preserve=None):
            self.erase_receipt()
            return self.manifest

        self.ops.backup = backup
        self.ops.mysql = lambda *args: self.fail("Erased data must not be restored")
        with self.assertRaisesRegex(self.ops.RestorePreflightError, "predates"):
            self.run_restore()
        self.assertEqual(len(self.app_commands("stop")), 1)
        self.assertEqual(len(self.app_commands("up")), 1)

    def test_sql_read_failure_before_restore_restarts_applications(self):
        def unavailable(*args):
            raise RuntimeError("SQL preflight unavailable")

        self.ops.mysql = unavailable
        with self.assertRaisesRegex(self.ops.RestorePreflightError, "unavailable"):
            self.run_restore()
        self.assertEqual(len(self.app_commands("up")), 1)

    def test_failure_after_destructive_sql_leaves_applications_stopped(self):
        sql = []

        def mysql(shared, statement):
            sql.append(statement)
            if statement.startswith("DROP DATABASE"):
                raise RuntimeError("Injected failure after attempting destructive SQL")
            return []

        self.ops.mysql = mysql
        self.ops.account_list = lambda shared: [
            ("customer", "marksix_t_customer", "mt_customer", "ready")
        ]
        with self.assertRaisesRegex(RuntimeError, "destructive SQL"):
            self.run_restore()
        self.assertTrue(any(s.startswith("DROP DATABASE") for s in sql))
        self.assertEqual(len(self.app_commands("stop")), 1)
        self.assertEqual(self.app_commands("up"), [])

    def test_successful_restore_restarts_applications(self):
        self.ops.restore = lambda *args: None
        self.run_restore()
        self.assertEqual(len(self.app_commands("stop")), 1)
        self.assertEqual(len(self.app_commands("up")), 1)


class PackageVerifierTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="marksix-package-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        script = self.root / "verify.py"
        script.write_text((ROOT / "scripts/verify_package.py").read_text())
        self.verify = module_at("test_package_verify", script)
        self.files = {}
        for name in ["images.tar.gz", "hosted/compose.yaml", "hosted/release.sh"]:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            # Cross multiple read boundaries, including a short final chunk.
            path.write_bytes(b"a" * (2 * 1024 * 1024 + 7))
            self.files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.manifest = {"schema": 1, "platform": "linux/amd64", "files": self.files}
        self.save_manifest()

    def save_manifest(self):
        (self.root / "manifest.json").write_text(json.dumps(self.manifest))

    def test_valid_package_without_python_311_hash_api(self):
        # The real Python 3.10 CI run has no such API. Also catch accidental use
        # when the same regression suite runs on a newer developer interpreter.
        with (
            patch.object(hashlib, "file_digest", None, create=True),
            redirect_stdout(io.StringIO()),
        ):
            self.verify.main()

    def test_tampered_archive_is_rejected(self):
        (self.root / "images.tar.gz").write_bytes(b"tampered")
        with self.assertRaisesRegex(SystemExit, "Checksum mismatch"):
            self.verify.main()

    def test_missing_file_is_rejected(self):
        (self.root / "hosted/release.sh").unlink()
        with self.assertRaisesRegex(SystemExit, "Missing or invalid"):
            self.verify.main()

    def test_path_outside_package_is_rejected(self):
        self.files["../outside"] = "irrelevant"
        self.save_manifest()
        with self.assertRaisesRegex(SystemExit, "Missing or invalid"):
            self.verify.main()


if __name__ == "__main__":
    unittest.main()
