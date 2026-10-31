"""Deletion decisions and API failures use fake HTTP, never a live GitHub write."""

import contextlib
import datetime as dt
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.error
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cleanup_artifacts as c


class CleanupExecution(unittest.TestCase):
    def run_record(self, id=1, **changes):
        return dict(
            id=id,
            workflow_id=3,
            run_number=id,
            status="completed",
            head_branch="dev",
            head_repository={"id": 2},
            event="push",
            conclusion="success",
            run_attempt=1,
            head_sha="a" * 40,
            **changes,
        )

    def test_http_retries_absence_errors_and_paginated_lists(self):
        with self.assertRaises(ValueError):
            c.GitHub("../bad")
        client = c.GitHub("example/repo", "synthetic")

        def response(data, status=200):
            value = io.BytesIO(json.dumps(data).encode())
            value.status = status
            return value

        error = lambda code: urllib.error.HTTPError(
            "https://example.test", code, "synthetic", {}, None
        )
        with (
            patch.object(
                c.urllib.request,
                "urlopen",
                side_effect=[error(503), error(429), response({"ok": True})],
            ),
            patch.object(c.time, "sleep") as sleep,
        ):
            self.assertTrue(client.request("/test")["ok"])
            self.assertEqual(sleep.call_count, 2)
        with patch.object(
            c.urllib.request, "urlopen", return_value=response(None, 204)
        ):
            self.assertTrue(client.request("/test", "DELETE"))
        for code in [404, 403, 500]:
            with (
                patch.object(c.urllib.request, "urlopen", side_effect=error(code)),
                patch.object(c.time, "sleep"),
            ):
                if code == 404:
                    self.assertIsNone(client.request("/test", missing_ok=True))
                else:
                    with self.assertRaisesRegex(RuntimeError, f"HTTP {code}"):
                        client.request("/test")
        with (
            patch.object(
                c.urllib.request,
                "urlopen",
                side_effect=urllib.error.URLError("synthetic"),
            ),
            self.assertRaisesRegex(RuntimeError, "network"),
        ):
            client.request("/test")
        with patch.object(
            client,
            "request",
            side_effect=[{"items": list(range(100))}, {"items": [100]}],
        ) as request:
            self.assertEqual(len(client.listing("/things?filter=all", "items")), 101)
            self.assertIn("&per_page=100&page=2", request.call_args.args[0])
        with (
            patch.object(client, "request", return_value={"items": [0] * 100}),
            self.assertRaisesRegex(RuntimeError, "Pagination"),
        ):
            client.listing("/things", "items")

    def test_inventory_missing_provenance_and_production_job_history(self):
        client = Mock()
        run = self.run_record()
        run.update(head_branch="master")
        client.request.side_effect = [{"id": 2}, {"id": 3}, run, None]
        client.listing.side_effect = [
            [{"workflow_run": {"id": 1}}, {"workflow_run": {"id": 2}}],
            [{"name": "job"}],
        ]
        result = c.inventory(client)
        self.assertEqual(result[1], {1: run})
        self.assertEqual(result[2], {1: [{"name": "job"}]})
        client.request.side_effect = [{"id": 2}, {"id": 3}, run]
        client.listing.side_effect = [[{"workflow_run": {"id": 1}}], []]
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            c.inventory(client)

    def test_cleanup_rechecks_each_run_and_records_partial_results(self):
        run = self.run_record()
        plan = [
            {"id": n, "run_id": 1, "action": "delete", "reason": "expired"}
            for n in range(1, 5)
        ] + [{"action": "keep"}]
        client = Mock()
        changed = {**run, "run_attempt": 2}
        client.request.side_effect = [run, True, run, None, changed, None]
        with contextlib.redirect_stdout(io.StringIO()):
            result = c.apply_plan(client, plan, {1: run})
        self.assertEqual(
            result,
            {"deleted": [1], "already_absent": [2], "changed_runs_skipped": [3, 4]},
        )

    def test_production_history_manual_retention_and_aged_reports(self):
        now = dt.datetime(2040, 1, 10, tzinfo=dt.timezone.utc)
        runs = {i: self.run_record(i) for i in range(1, 7)}
        for i in [1, 2, 3]:
            runs[i]["head_branch"] = "master"
        runs[4]["event"] = "workflow_dispatch"
        runs[5]["conclusion"] = "failure"
        runs[6]["conclusion"] = "failure"
        jobs = {
            i: [
                {
                    "name": "Deploy MarkSix to VPS",
                    "conclusion": "success" if i == 1 else "failure",
                    "steps": [
                        {
                            "name": c.DEPLOY_STEP,
                            "conclusion": "success" if i == 1 else "failure",
                            "completed_at": f"2040-01-0{i}T00:00:00Z",
                        }
                    ],
                }
            ]
            for i in [1, 2]
        }
        artifacts = [
            {
                "id": i * 10 + j,
                "name": name,
                "workflow_run": {"id": i},
                "created_at": "2040-01-09T12:00:00Z",
                "expired": False,
                "size_in_bytes": 1,
            }
            for i in runs
            for j, name in enumerate(
                [
                    c.PACKAGE,
                    "hosted-acceptance",
                    "coverage-report",
                    "browser-report",
                    "old.dockerbuild",
                ]
            )
        ]
        plan = c.plan_cleanup(artifacts, runs, jobs, 2, 3, now)
        byid = {p["id"]: p for p in plan}
        for id in [10, 11, 20, 21, 30, 40, 42, 62]:
            self.assertEqual(byid[id]["action"], "keep", id)
        for id in [14, 43, 52]:
            self.assertEqual(byid[id]["action"], "delete", id)
        jobs[1][0]["steps"][0].pop("completed_at")
        with self.assertRaisesRegex(RuntimeError, "time is unknown"):
            c.plan_cleanup(artifacts, runs, jobs, 2, 3, now)

    def test_cli_dry_run_apply_and_partial_failure_persist_reports(self):
        run = self.run_record()
        artifact = {
            "id": 7,
            "name": "old.dockerbuild",
            "workflow_run": {"id": 1},
            "created_at": "2000-01-01T00:00:00Z",
            "expired": True,
            "size_in_bytes": 12,
        }
        for mode in ["dry", "apply", "failure"]:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as folder:
                output = Path(folder) / "report.json"
                summary = Path(folder) / "summary.md"
                args = [
                    "cleanup",
                    "--repository",
                    "example/repo",
                    "--output",
                    str(output),
                ]
                if mode != "dry":
                    args += ["--apply"]
                client = Mock()
                client.request.side_effect = [
                    run,
                    RuntimeError("synthetic") if mode == "failure" else True,
                ]
                with (
                    patch.object(sys, "argv", args),
                    patch.object(c, "GitHub", return_value=client),
                    patch.object(
                        c, "inventory", return_value=([artifact], {1: run}, {}, 2, 3)
                    ),
                    patch.dict(
                        c.os.environ,
                        {
                            "GITHUB_ACTIONS": "true",
                            "GH_TOKEN": "synthetic-token",
                            "GITHUB_STEP_SUMMARY": str(summary),
                        },
                        clear=True,
                    ),
                    contextlib.redirect_stdout(io.StringIO()),
                ):
                    if mode == "failure":
                        with self.assertRaises(RuntimeError):
                            c.main()
                    else:
                        c.main()
                result = json.loads(output.read_text())
                self.assertEqual(result["planned_bytes"], 12)
                if mode == "failure":
                    self.assertFalse(result["completed"])
                else:
                    self.assertTrue(summary.is_file())
                if mode == "dry":
                    client.request.assert_not_called()

    def test_actions_without_token_rejects_before_creating_client(self):
        with (
            patch.dict(c.os.environ, {"GITHUB_ACTIONS": "true"}, clear=True),
            patch.object(sys, "argv", ["cleanup", "--repository", "example/repo"]),
            patch.object(c, "GitHub") as client,
            contextlib.redirect_stderr(io.StringIO()) as errors,
            self.assertRaises(SystemExit) as failure,
        ):
            c.main()
        self.assertEqual(failure.exception.code, 2)
        self.assertIn("GH_TOKEN is required in Actions", errors.getvalue())
        client.assert_not_called()
