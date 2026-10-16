import datetime as dt
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "security_audit", Path(__file__).resolve().parents[1] / "audit_dependencies.py"
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class AuditTests(unittest.TestCase):
    def test_lock_parser_ignores_local_package_and_preserves_exact_version(self):
        text = '[[package]]\nname = "local"\nversion = "1"\n[[package]]\nname = "rustls"\nversion = "0.23.46"\nsource = "registry+https://index"\n'
        self.assertEqual(audit.locked_packages(text), [("rustls", "0.23.46")])

    def test_exception_does_not_hide_another_version_or_advisory(self):
        exception = {
            "package": "rsa",
            "version": "0.9.10",
            "id": "RUSTSEC-known",
            "review_by": "2027-01-01",
            "reason": "public key only",
        }
        packages = [("rsa", "0.9.10"), ("rsa", "0.9.11")]
        results = [
            {"vulns": [{"id": "RUSTSEC-known"}, {"id": "RUSTSEC-new"}]},
            {"vulns": [{"id": "RUSTSEC-known"}]},
        ]
        findings, rejected = audit.evaluate(
            packages, results, [exception], dt.date(2026, 10, 16)
        )
        self.assertEqual(len(findings), 3)
        self.assertEqual(len(rejected), 2)
        with self.assertRaisesRegex(RuntimeError, "Expired"):
            audit.evaluate([], [], [exception], dt.date(2027, 1, 2))

    def test_incomplete_scan_is_not_reported_as_clean(self):
        with self.assertRaisesRegex(RuntimeError, "Incomplete"):
            audit.evaluate([("crate", "1")], [], [], dt.date(2026, 10, 16))
        with self.assertRaisesRegex(RuntimeError, "did not run"):
            audit.locked_packages("")
