"""Filesystem and failure contracts. Every destructive target is temporary."""
import contextlib
import datetime as dt
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import tarfile
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'deploy/vps'))
sys.path.insert(0, str(ROOT / 'scripts'))
import configure, deploy, ops, releases, receive, rollback
import package_ubuntu as package
import audit_dependencies as audit
import cleanup_artifacts as cleanup

class Configuration(unittest.TestCase):

    def test_domains_are_required_and_existing_secrets_are_preserved(self):
        with tempfile.TemporaryDirectory(prefix='marksix-config-') as folder:
            shared = Path(folder) / 'shared'
            args = ['configure', '--shared', str(shared), '--domain', 'app.example.test', '--admin-domain', 'admin.example.test']
            with patch.object(sys, 'argv', args), contextlib.redirect_stdout(io.StringIO()):
                configure.main()
            env = shared / '.env'
            before = env.read_bytes()
            values = ops.configuration(shared)
            self.assertEqual(values['APP_DOMAIN'], 'app.example.test')
            self.assertEqual(len(values['DB_ROOT_PASSWORD']), 64)
            self.assertEqual(env.stat().st_mode & 511, 384)
            with patch.object(sys, 'argv', args), self.assertRaises(FileExistsError):
                configure.main()
            self.assertEqual(env.read_bytes(), before)
        with patch.object(sys, 'argv', ['configure']), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            configure.main()

    def test_domain_collisions_and_path_syntax_are_rejected(self):
        for args in [['--domain', 'same.test', '--admin-domain', 'same.test'], ['--domain', 'https://bad.test', '--admin-domain', 'admin.test'], ['--domain', 'app.test', '--admin-domain', 'admin.test', '--shared', '/tmp/a b']]:
            with self.subTest(args=args), patch.object(sys, 'argv', ['configure', *args]), contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                configure.main()

class ReleaseContracts(unittest.TestCase):

    def test_order_high_water_mark(self):
        with tempfile.TemporaryDirectory() as folder:
            shared = Path(folder)
            sha = 'a' * 40
            releases.atomic_json(shared / 'release-order.json', {'sha': sha, 'sequence': 10, 'attempt': 2})
            for args in [(sha, 9, 1), (sha, 10, 1), ('b' * 40, 10, 2)]:
                with self.subTest(args=args), self.assertRaises(RuntimeError):
                    releases.check_order(shared, *args)
            self.assertEqual(releases.check_order(shared, sha, 10, 2)['attempt'], 2)
            self.assertEqual(releases.check_order(shared, 'b' * 40, 11, 1)['sequence'], 11)

    def test_insufficient_space_and_atomic_link_switch(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            release = root / 'release'
            release.mkdir()
            link = root / 'current'
            releases.switch_current(link, release)
            self.assertEqual(link.resolve(), release)
            with patch.object(shutil, 'disk_usage', return_value=shutil._ntuple_diskusage(10, 9, 1)), self.assertRaises(RuntimeError):
                releases.require_space(root, 2)

    def test_package_digest_rejects_corruption_and_traversal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            shutil.copyfile(ROOT / 'scripts/verify_package.py', root / 'verify.py')
            files = {}
            for name in ['images.tar.gz', 'hosted/compose.yaml', 'hosted/release.sh']:
                p = root / name
                p.parent.mkdir(exist_ok=True)
                p.write_bytes(b'public artifact')
                files[name] = hashlib.sha256(p.read_bytes()).hexdigest()
            manifest = {'schema': 1, 'platform': 'linux/amd64', 'files': files}
            (root / 'manifest.json').write_text(json.dumps(manifest))

            def verify():
                return subprocess.run([sys.executable, str(root / 'verify.py')], capture_output=True).returncode
            self.assertEqual(verify(), 0)
            (root / 'images.tar.gz').write_bytes(b'changed')
            self.assertNotEqual(verify(), 0)
            files['../outside'] = 'a' * 64
            (root / 'manifest.json').write_text(json.dumps(manifest))
            self.assertNotEqual(verify(), 0)

    def test_failed_deployment_keeps_current_and_stops_application_services(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            shared = root / 'shared'
            shared.mkdir()
            (shared / '.env').write_text('configured')
            package = root / 'release'
            hosted = package / 'hosted'
            hosted.mkdir(parents=True)
            sha = 'b' * 40
            (package / 'manifest.json').write_text(json.dumps({'version': sha, 'image_unpacked_bytes': 1}))
            with patch.object(sys, 'argv', ['deploy', '--sha', sha, '--sequence', '1', '--attempt', '1', '--shared', str(shared)]), patch.object(ops, 'RELEASE', hosted), patch.object(ops, 'configuration'), patch.object(deploy.subprocess, 'run'), patch.object(releases, 'cleanup'), patch.object(releases, 'require_space'), patch.object(deploy, 'certificate'), patch.object(deploy, 'health', side_effect=RuntimeError('unhealthy')), patch.object(ops, 'compose') as compose, self.assertRaises(RuntimeError):
                deploy.main()
            self.assertFalse((root / 'current').exists())
            self.assertEqual(json.loads((shared / 'deployment.json').read_text())['status'], 'failed')
            self.assertIn(unittest.mock.call(shared, 'stop', '--timeout', '45', 'backend', 'authority'), compose.call_args_list)

    def test_rollback_rejects_different_migration_contract_before_stopping(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            shared = root / 'shared'
            shared.mkdir()
            sha = 'a' * 40
            other = 'b' * 40
            (shared / 'deployment.json').write_text(json.dumps({'sha': sha}))
            for key, contract in [(sha, {'001': 'a'}), (other, {'001': 'b'})]:
                p = root / 'releases' / key
                p.mkdir(parents=True)
                (p / 'manifest.json').write_text(json.dumps({'database_contract': contract}))
            with patch.object(sys, 'argv', ['rollback', '--sha', other, '--confirm-rollback', '--shared', str(shared)]), patch.object(ops, 'configuration'), patch.object(ops, 'compose') as compose, self.assertRaises(RuntimeError):
                rollback.main()
            compose.assert_not_called()

    def test_package_contains_current_guide_and_no_copied_default_fixture(self):
        class SavedImages:
            def __init__(self, *args, **kwargs): self.stdout = io.BytesIO(b'images')
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def wait(self): return 0
            def kill(self): pass
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'package'
            args = ['package', '--version', 'a' * 40, '--backend', 'backend:test', '--frontend', 'frontend:test', '--output', str(output)]
            with patch.object(sys, 'argv', args), patch.object(package, 'run', return_value='linux/amd64'), patch.object(package.subprocess, 'run'), patch.object(package.subprocess, 'Popen', SavedImages), contextlib.redirect_stdout(io.StringIO()):
                package.main()
            self.assertFalse((output / 'fixtures').exists())
            self.assertEqual((output / 'hosted/README.md').read_bytes(), (ROOT / 'docs/human/deployment.md').read_bytes())
            self.assertFalse(any(p.name == '.env' for p in output.rglob('*')))
            result = subprocess.run([sys.executable, str(output / 'verify.py')], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_receive_rejects_archive_path_escape_before_extracting(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sha = 'a' * 40
            stage = root / f'.incoming-1-1-{sha}'
            stage.mkdir()
            archive = stage / 'package.tar'
            with tarfile.open(archive, 'w') as stream:
                entry = tarfile.TarInfo('../escape')
                entry.size = 1
                stream.addfile(entry, io.BytesIO(b'x'))
            args = ['receive', 'extract', sha, '1', '1', str(archive.stat().st_size), '1', '1', '--root', str(root)]
            with patch.object(sys, 'argv', args), self.assertRaisesRegex(RuntimeError, 'path/type'):
                receive.main()
            self.assertFalse((root / 'escape').exists())

class BackupContracts(unittest.TestCase):

    def sample(self, root):
        stamp = '20400101T000000000000Z-abcd'
        paths = [f'control/{stamp}.sql.gz', f'tenants/sample/{stamp}.sql.gz']
        files = {}
        for name in paths:
            p = root / 'backups' / name
            p.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(p, 'wb') as stream:
                stream.write(b'SELECT 1;')
            files[name] = ops.file_sha256(p)
        manifest = root / 'backups' / 'control' / f'{stamp}.json'
        manifest.write_text(json.dumps({'schema': 1, 'created_at': stamp, 'files': files, 'accounts': [{'id': 'sample'}]}))
        return manifest

    def test_complete_generation_corruption_and_erasure_receipt(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = self.sample(root)
            self.assertEqual(ops.validate_restore(root, manifest)['schema'], 1)
            receipt = root / 'backups/erasures'
            receipt.mkdir()
            (receipt / 'sample.json').write_text(json.dumps({'account_id': 'sample', 'cleared_at_utc': '2040-01-02T00:00:00+00:00'}))
            with self.assertRaisesRegex(RuntimeError, 'erasure'):
                ops.validate_restore(root, manifest)
            (receipt / 'sample.json').unlink()
            next((root / 'backups/tenants/sample').glob('*.gz')).write_bytes(b'corrupt')
            with self.assertRaisesRegex(RuntimeError, 'checksum'):
                ops.validate_restore(root, manifest)

    def test_invalid_restore_changes_no_database(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            manifest = self.sample(root)
            data = json.loads(manifest.read_text())
            data['files']['../../escape'] = 'a' * 64
            manifest.write_text(json.dumps(data))
            with patch.object(ops, 'mysql') as mysql, self.assertRaises(ops.RestorePreflightError):
                ops.restore_data(root, manifest)
            mysql.assert_not_called()

class SecurityContracts(unittest.TestCase):

    def test_advisory_exceptions_match_version_ecosystem_and_expiry(self):
        today = dt.date(2040, 1, 1)
        packages = [('sample', '1.0')]
        result = [{'vulns': [{'id': 'GHSA-test'}]}]
        exception = {'package': 'sample', 'version': '1.0', 'id': 'GHSA-test', 'review_by': '2040-01-02', 'reason': 'reviewed', 'ecosystem': 'npm'}
        self.assertEqual(len(audit.evaluate(packages, result, [exception], today, 'npm')[1]), 0)
        self.assertEqual(len(audit.evaluate(packages, result, [exception], today)[1]), 1)
        with self.assertRaises(RuntimeError):
            audit.evaluate(packages, result, [exception], dt.date(2040, 1, 3), 'npm')
        with self.assertRaises(RuntimeError):
            audit.evaluate(packages, [], [], today)

    def test_lock_parsers_reject_empty_or_unrelated_audit_data(self):
        with self.assertRaises(RuntimeError):
            audit.locked_packages('')
        with self.assertRaises(RuntimeError):
            audit.bun_packages('')
        with self.assertRaises(RuntimeError):
            audit.bun_results([('sample', '1')], {'other': []})
        self.assertTrue(audit.locked_packages((ROOT / 'backend/Cargo.lock').read_text()))
        self.assertTrue(audit.bun_packages((ROOT / 'frontend/bun.lock').read_text()))

    def test_artifact_cleanup_protects_active_runs_and_unknown_artifacts(self):
        now = dt.datetime(2040, 1, 1, tzinfo=dt.timezone.utc)
        run = {'id': 1, 'workflow_id': 3, 'run_number': 1, 'status': 'in_progress', 'head_branch': 'dev', 'head_repository': {'id': 2}, 'event': 'push', 'conclusion': None}
        artifacts = [{'id': 1, 'name': cleanup.PACKAGE, 'workflow_run': {'id': 1}, 'created_at': '2030-01-01T00:00:00Z', 'expired': False, 'size_in_bytes': 10}, {'id': 2, 'name': 'external', 'size_in_bytes': 1}]
        plan = cleanup.plan_cleanup(artifacts, {1: run}, {}, 2, 3, now)
        self.assertTrue(all((p['action'] == 'keep' for p in plan)))
if __name__ == '__main__':
    unittest.main()
