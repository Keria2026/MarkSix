"""Acceptance-runner orchestration contract; actual image acceptance remains separate."""

import contextlib
import io
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import verify_hosted as v


class HostedVerifier(unittest.TestCase):
    def test_reports_success_and_tears_down_on_failed_http_check(self):
        for failure in [False, True]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                runtime = root / "deploy/vps"
                runtime.mkdir(parents=True)
                (runtime / "compose.yaml").write_text('ports: ["80:80", "443:443"]')
                calls = []

                def run(args, **kwargs):
                    calls.append(args)
                    if args[0] == "python3":
                        shared = Path(args[args.index("--shared") + 1])
                        shared.mkdir()
                        (shared / ".env").write_text(
                            "AUTHORITY_ADMIN_USERNAME=synthetic\nAUTHORITY_ADMIN_PASSWORD=synthetic-password\n"
                        )
                    elif args[0] == "openssl":
                        Path(args[args.index("-out") + 1]).write_text(
                            "synthetic certificate"
                        )
                    elif args[0] == "curl":
                        url = args[-1]
                        data = {}
                        if url.endswith("/api/site"):
                            data = {
                                "mode": "authority" if "admin." in url else "hosted"
                            }
                        elif url.endswith("/api/health"):
                            data = {"status": "ok"}
                        elif url.endswith("/api/accounts"):
                            data = {"state": "ready"}
                        elif url.endswith("/api/license"):
                            data = {"active": False}
                        return SimpleNamespace(
                            returncode=1 if failure else 0,
                            stdout="HTTP/1.1 200 OK\nSet-Cookie: sample=synthetic; HttpOnly\n\n"
                            + json.dumps(data),
                        )
                    return SimpleNamespace(returncode=0)

                with (
                    patch.object(v, "ROOT", root),
                    patch.object(
                        sys,
                        "argv",
                        [
                            "verify",
                            "--backend",
                            "synthetic-backend",
                            "--frontend",
                            "synthetic-frontend",
                        ],
                    ),
                    patch.object(v.subprocess, "run", side_effect=run),
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    if failure:
                        with self.assertRaisesRegex(
                            RuntimeError, "verification failed"
                        ):
                            v.main()
                    else:
                        v.main()
                report = json.loads(
                    (root / "test-results/hosted-acceptance.json").read_text()
                )
                self.assertEqual(report["passed"], not failure)
                self.assertTrue(
                    any("down" in call and "--volumes" in call for call in calls)
                )
                self.assertEqual(any("logs" in call for call in calls), failure)
