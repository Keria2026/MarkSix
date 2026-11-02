"""Reject malformed or ambiguous release paths before any deployment side effect."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import verify_package


class PackageVerification(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.files = {}
        for name in ['images.tar.gz', 'hosted/compose.yaml', 'hosted/release.sh']:
            path = self.root / name
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(b'review fixture')
            self.files[name] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.manifest = {'schema': 1, 'platform': 'linux/amd64', 'files': self.files}

    def write(self, value):
        (self.root / 'manifest.json').write_text(json.dumps(value))

    def test_complete_package_and_main(self):
        self.write(self.manifest)
        self.assertEqual(verify_package.verify(self.root), self.manifest)
        with patch.object(verify_package, '__file__', str(self.root / 'verify.py')), contextlib.redirect_stdout(io.StringIO()) as out:
            verify_package.main()
        self.assertIn('verified', out.getvalue())

    def test_schema_and_required_files(self):
        for value in [None, [], {}, {'schema': 2}, {**self.manifest, 'platform': 'other'}]:
            with self.subTest(value=value), self.assertRaisesRegex(SystemExit, 'Unsupported'):
                self.write(value)
                verify_package.verify(self.root)
        for files in [None, [], {}, {'images.tar.gz': 'a' * 64}]:
            with self.subTest(files=files), self.assertRaisesRegex(SystemExit, 'Incomplete'):
                self.write({**self.manifest, 'files': files})
                verify_package.verify(self.root)

    def test_manifest_paths_cannot_alias_or_escape(self):
        for name in ['', '../outside', 'hosted/../images.tar.gz', './images.tar.gz', 'hosted//compose.yaml', '/absolute', 'hosted\\compose.yaml']:
            with self.subTest(name=name), self.assertRaisesRegex(SystemExit, 'Invalid'):
                self.write({**self.manifest, 'files': {**self.files, name: 'a' * 64}})
                verify_package.verify(self.root)
        for digest in [None, 42, [], '', 'A' * 64, 'g' * 64, 'a' * 63]:
            with self.subTest(digest=digest), self.assertRaisesRegex(SystemExit, 'Invalid'):
                self.write({**self.manifest, 'files': {**self.files, 'extra': digest}})
                verify_package.verify(self.root)

    def test_absolute_path_even_inside_release_is_rejected(self):
        self.write({**self.manifest, 'files': {**self.files, str(self.root / 'images.tar.gz'): self.files['images.tar.gz']}})
        with self.assertRaises(SystemExit):
            verify_package.verify(self.root)

    def test_symlinks_in_files_and_parent_directories_are_rejected(self):
        self.write(self.manifest)
        image = self.root / 'images.tar.gz'
        image.rename(self.root / 'real-image')
        image.symlink_to(self.root / 'real-image')
        with self.assertRaisesRegex(SystemExit, 'symlink'):
            verify_package.verify(self.root)
        image.unlink()
        (self.root / 'real-image').rename(image)
        (self.root / 'hosted').rename(self.root / 'real-hosted')
        (self.root / 'hosted').symlink_to(self.root / 'real-hosted', target_is_directory=True)
        with self.assertRaisesRegex(SystemExit, 'symlink'):
            verify_package.verify(self.root)

    def test_corruption_missing_file_and_directory(self):
        self.write(self.manifest)
        image = self.root / 'images.tar.gz'
        image.write_bytes(b'corrupted')
        with self.assertRaisesRegex(SystemExit, 'Checksum'):
            verify_package.verify(self.root)
        image.unlink()
        with self.assertRaisesRegex(SystemExit, 'Missing'):
            verify_package.verify(self.root)
        image.mkdir()
        with self.assertRaisesRegex(SystemExit, 'Missing'):
            verify_package.verify(self.root)

class ReceiveIsolation(unittest.TestCase):
    def test_existing_release_symlink_is_not_reused(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'deploy/vps'))
        import receive
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sha = 'a' * 40
            stage = root / f'.incoming-1-1-{sha}'
            stage.mkdir()
            (stage / 'package.tar').write_bytes(b'x')
            outside = root / 'outside'
            outside.mkdir()
            (root / sha).symlink_to(outside, target_is_directory=True)
            with patch.object(sys, 'argv', ['receive', 'extract', sha, '1', '1', '1', '1', '1', '--root', str(root)]), patch.object(receive.subprocess, 'run') as run, self.assertRaisesRegex(RuntimeError, 'must not be a symlink'):
                receive.main()
            run.assert_not_called()
            self.assertEqual(list(outside.iterdir()), [])
