"""Uploaded packages stay immutable and staging paths cannot escape a temporary root."""

import io
import json
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy/vps"))
import receive


class Receive(unittest.TestCase):
    def invoke(self, root, action, sha, archive=1, expanded=1, images=1):
        with patch.object(
            sys,
            "argv",
            [
                "receive",
                action,
                sha,
                "1",
                "1",
                str(archive),
                str(expanded),
                str(images),
                "--root",
                str(root),
            ],
        ):
            receive.main()

    def test_prepare_discard_and_space_rejection(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sha = "a" * 40
            stage = root / f".incoming-1-1-{sha}"
            with (
                patch.object(
                    shutil, "disk_usage", return_value=shutil._ntuple_diskusage(1, 1, 0)
                ),
                self.assertRaisesRegex(RuntimeError, "space"),
            ):
                self.invoke(root, "prepare", sha)
            self.assertFalse(stage.exists())
            with patch.object(
                shutil,
                "disk_usage",
                return_value=shutil._ntuple_diskusage(10**12, 0, 10**12),
            ):
                self.invoke(root, "prepare", sha)
            self.assertEqual(stage.stat().st_mode & 0o777, 0o700)
            self.invoke(root, "discard", sha)
            self.invoke(root, "discard", sha)
            self.assertFalse(stage.exists())

    def test_extract_and_identical_retry_preserve_original_release(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            sha = "a" * 40
            manifest = {"version": sha, "image_unpacked_bytes": 1}

            def prepare():
                stage = root / f".incoming-1-1-{sha}"
                stage.mkdir()
                archive = stage / "package.tar"
                expanded = 0
                with tarfile.open(archive, "w") as stream:
                    for name, value in [
                        ("manifest.json", json.dumps(manifest).encode()),
                        ("verify.py", b"pass"),
                        ("hosted/file", b"public"),
                    ]:
                        entry = tarfile.TarInfo(name)
                        entry.size = len(value)
                        expanded += len(value)
                        stream.addfile(entry, io.BytesIO(value))
                return archive.stat().st_size, expanded

            for _ in range(2):
                size, expanded = prepare()
                with patch.object(receive.subprocess, "run") as verify:
                    self.invoke(root, "extract", sha, size, expanded)
                self.assertEqual(verify.call_count, 1)
                self.assertEqual((root / sha / "hosted/file").read_bytes(), b"public")
                self.assertEqual((root / sha / "hosted").stat().st_mode & 0o777, 0o755)
                self.assertFalse((root / f".incoming-1-1-{sha}").exists())
            manifest["changed"] = True
            size, expanded = prepare()
            with (
                patch.object(receive.subprocess, "run"),
                self.assertRaisesRegex(RuntimeError, "different artifact"),
            ):
                self.invoke(root, "extract", sha, size, expanded)
            self.assertNotIn(
                "changed", json.loads((root / sha / "manifest.json").read_text())
            )
