"""Destructive retention decisions use synthetic Actions history, never a VPS."""

import datetime as dt
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch
import urllib.error

spec = importlib.util.spec_from_file_location(
    "artifact_cleanup", Path(__file__).resolve().parents[1] / "cleanup_artifacts.py"
)
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)
NOW = dt.datetime(2026, 10, 18, 12, tzinfo=dt.timezone.utc)


def run(number, branch="dev", conclusion="success", event="push", **extra):
    return dict(id=number, run_number=number, run_attempt=1,
                head_sha=f"{number:040x}", head_branch=branch,
                head_repository={"id": 1}, workflow_id=10,
                status="completed", conclusion=conclusion, event=event, **extra)


def artifact(number, run_id, name, hours=1, **extra):
    return dict(id=number, workflow_run={"id": run_id}, name=name,
                created_at=(NOW - dt.timedelta(hours=hours)).isoformat(),
                size_in_bytes=1024, expired=False, **extra)


def deployment(when, healthy=True):
    return {"name": "Deploy MarkSix to VPS",
            "conclusion": "success" if healthy else "failure",
            "steps": [{"name": cleanup.DEPLOY_STEP, "conclusion": "success",
                       "completed_at": when.isoformat()}]}


class ArtifactRetentionTests(unittest.TestCase):
    def plan(self, artifacts, runs, jobs=None):
        return cleanup.plan_cleanup(artifacts, {r["id"]: r for r in runs},
                                    jobs or {}, 1, 10, NOW)

    def deleted(self, *args):
        return {a["id"] for a in self.plan(*args) if a["action"] == "delete"}

    def test_current_and_last_verified_deployment_survive_public_probe_failure(self):
        runs = [run(n, "master", "failure" if n == 3 else "success")
                for n in (1, 2, 3)]
        artifacts = [artifact(n, n, cleanup.PACKAGE, hours=1000) for n in (1, 2, 3)]
        jobs = {n: [deployment(NOW - dt.timedelta(hours=4 - n), n != 3)]
                for n in (1, 2, 3)}
        self.assertEqual(self.deleted(artifacts, runs, jobs), {1})

    def test_old_attempt_deployment_is_preserved_after_failed_rerun(self):
        r = run(1, "master", "failure")
        r["run_attempt"] = 2
        jobs = {1: [deployment(NOW - dt.timedelta(days=10)),
                    {"name": "Deploy MarkSix to VPS", "conclusion": "skipped", "steps": []}]}
        artifacts = [artifact(1, 1, cleanup.PACKAGE, hours=240),
                     artifact(2, 1, "hosted-acceptance", hours=240)]
        self.assertEqual(self.deleted(artifacts, [r], jobs), set())

    def test_skipped_deployment_does_not_replace_deployed_package(self):
        runs = [run(1, "master"), run(2, "master")]
        jobs = {1: [deployment(NOW - dt.timedelta(days=2))],
                2: [{"name": "Deploy MarkSix to VPS", "conclusion": "success",
                     "steps": [{"name": cleanup.DEPLOY_STEP, "conclusion": "skipped"}]}]}
        self.assertEqual(self.deleted([artifact(n, n, cleanup.PACKAGE) for n in (1, 2)],
                                      runs, jobs), {2})

    def test_disconnected_deployment_preserves_candidate_and_last_healthy_package(self):
        runs = [run(1, "master"), run(2, "master", "failure")]
        uncertain = deployment(NOW, healthy=False)
        uncertain["steps"][0]["conclusion"] = "failure"
        jobs = {1: [deployment(NOW - dt.timedelta(days=2))], 2: [uncertain]}
        self.assertEqual(self.deleted([artifact(n, n, cleanup.PACKAGE) for n in (1, 2)],
                                      runs, jobs), set())

    def test_renamed_or_unknown_deployment_steps_cannot_authorize_package_deletion(self):
        runs = [run(1, "master")]
        for job in ({"name": "Renamed deployment", "conclusion": "success", "steps": []},
                    {"name": "Deploy MarkSix to VPS", "conclusion": "success",
                     "steps": [{"name": "Renamed transfer", "conclusion": "success"}]}):
            self.assertEqual(self.deleted([artifact(1, 1, cleanup.PACKAGE)],
                                          runs, {1: [job]}), set())

    def test_running_waiting_queued_and_rerun_are_never_cleaned(self):
        for status in ("queued", "in_progress", "waiting", "requested", "pending"):
            r = run(1)
            r["status"] = status
            a = artifact(1, 1, cleanup.PACKAGE, hours=1000)
            a["expired"] = True
            self.assertEqual(self.deleted([a], [r]), set())

    def test_manual_package_is_bounded_and_failed_or_dev_packages_are_invalid(self):
        runs = [run(1, event="workflow_dispatch"), run(2, event="workflow_dispatch"),
                run(3, conclusion="failure", event="workflow_dispatch"), run(4)]
        artifacts = [artifact(n, n, cleanup.PACKAGE) for n in (1, 2, 3, 4)]
        self.assertEqual(self.deleted(artifacts, runs), {1, 3, 4})
        artifacts[1]["created_at"] = (NOW - dt.timedelta(days=7)).isoformat()
        self.assertEqual(self.deleted(artifacts, runs), {1, 2, 3, 4})

    def test_reports_keep_only_latest_success_and_short_lived_failure_per_branch(self):
        runs = [run(1), run(2), run(3, conclusion="failure"), run(4, conclusion="failure"),
                run(5, "other")]
        artifacts = [artifact(n, n, "runtime-acceptance") for n in range(1, 6)]
        self.assertEqual(self.deleted(artifacts, runs), {1, 3})
        artifacts[1]["created_at"] = (NOW - dt.timedelta(days=7)).isoformat()
        artifacts[3]["created_at"] = (NOW - dt.timedelta(days=1)).isoformat()
        self.assertEqual(self.deleted(artifacts, runs), {1, 2, 3, 4})

    def test_successful_retry_discards_old_failure_trace_even_on_production(self):
        r = run(1, "master")
        self.assertEqual(self.deleted([artifact(1, 1, "browser-report")], [r],
                                      {1: [deployment(NOW)]}), {1})

    def test_fork_cannot_claim_production_or_displace_own_branch_reports(self):
        trusted, fork = run(1), run(2)
        fork["head_repository"] = {"id": 999}
        artifacts = [artifact(1, 1, "runtime-acceptance"),
                     artifact(2, 2, "runtime-acceptance"),
                     artifact(3, 2, cleanup.PACKAGE)]
        self.assertEqual(self.deleted(artifacts, [trusted, fork]), {3})
        fork.update(head_branch="master", event="push")
        self.assertEqual(self.deleted([artifacts[2]], [fork],
                                      {2: [deployment(NOW)]}), {3})

    def test_unmanaged_workflow_names_and_missing_provenance_are_retained(self):
        other, deleted_repo = run(2), run(3)
        other["workflow_id"] = 20
        deleted_repo["head_repository"] = None
        artifacts = [artifact(1, 1, "other-application"),
                     artifact(2, 2, cleanup.PACKAGE),
                     artifact(3, 999, cleanup.PACKAGE),
                     artifact(4, 3, "runtime-acceptance"),
                     artifact(5, 3, cleanup.PACKAGE)]
        self.assertEqual(self.deleted(artifacts, [run(1), other, deleted_repo]), set())

    def test_disposable_records_and_retired_packages_are_removed_even_on_production(self):
        artifacts = [artifact(n, 1, name) for n, name in enumerate(
            [cleanup.PACKAGE, "runtime-acceptance", "hosted-acceptance",
             "repo~build.dockerbuild", "MarkSix-Windows-Native-x64", "marksix-images"], 1)]
        self.assertEqual(self.deleted(artifacts, [run(1, "master")],
                                      {1: [deployment(NOW)]}), {4, 5, 6})

    def test_expired_completed_artifact_is_removed(self):
        a = artifact(1, 1, "runtime-acceptance")
        a["expired"] = True
        self.assertEqual(self.deleted([a], [run(1)]), {1})

    def test_apply_rechecks_attempt_and_status_and_is_idempotent_on_404(self):
        r = run(1)
        plan = self.plan([artifact(1, 1, cleanup.PACKAGE)], [r])
        for field, value in [("status", "in_progress"), ("run_attempt", 2),
                             ("head_sha", "b" * 40), ("workflow_id", 20)]:
            current = dict(r, **{field: value})
            client = Mock()
            client.request.return_value = current
            result = cleanup.apply_plan(client, plan, {1: r})
            self.assertEqual(result["changed_runs_skipped"], [1])
            self.assertEqual(client.request.call_count, 1)
        client = Mock()
        client.request.side_effect = [r, None]
        result = cleanup.apply_plan(client, plan, {1: r})
        self.assertEqual(result["already_absent"], [1])
        self.assertEqual(result["deleted"], [])

    def test_inventory_reads_all_pages_and_all_deployment_attempts_before_deleting(self):
        client = cleanup.GitHub("owner/repo")
        client.request = Mock(side_effect=[{"id": 1}, {"id": 10},
            {"artifacts": [artifact(n, 1, cleanup.PACKAGE) for n in range(100)]},
            {"artifacts": [artifact(101, 1, "runtime-acceptance")]}, run(1, "master"),
            {"jobs": [deployment(NOW)]}])
        artifacts, _, jobs, _, _ = cleanup.inventory(client)
        self.assertEqual(len(artifacts), 101)
        self.assertIn(1, jobs)
        self.assertEqual(client.request.call_args_list[-1].args,
                         ("/actions/runs/1/jobs?filter=all&per_page=100&page=1",))
        self.assertFalse(any(c.kwargs.get("method") == "DELETE"
                             for c in client.request.call_args_list))

    def test_forbidden_api_response_stops_cleanup_without_exposing_response_body(self):
        client = cleanup.GitHub("owner/repo", "private-token")
        error = urllib.error.HTTPError("url", 403, "sensitive response", {}, None)
        with patch.object(cleanup.urllib.request, "urlopen", side_effect=error):
            with self.assertRaisesRegex(RuntimeError, r"HTTP 403") as failure:
                client.request("/actions/artifacts")
        self.assertNotIn("private-token", str(failure.exception))
        self.assertNotIn("sensitive", str(failure.exception))

    def test_incomplete_production_inventory_stops_before_any_deletion(self):
        client = Mock()
        client.request.side_effect = [{"id": 1}, {"id": 10}, run(1, "master")]
        client.listing.side_effect = [[artifact(1, 1, cleanup.PACKAGE)], []]
        with self.assertRaisesRegex(RuntimeError, "history is unavailable"):
            cleanup.inventory(client)
        self.assertFalse(any(c.kwargs.get("method") == "DELETE"
                             for c in client.request.call_args_list))

    def test_partial_failure_preserves_evidence_and_stops_remaining_deletions(self):
        r = run(1)
        plan = self.plan([artifact(n, 1, cleanup.PACKAGE) for n in (1, 2, 3)], [r])
        client = Mock()
        client.request.side_effect = [r, True, r, RuntimeError("HTTP 403")]
        result = {}
        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            cleanup.apply_plan(client, plan, {1: r}, result)
        self.assertEqual(result["deleted"], [1])
        self.assertEqual(client.request.call_count, 4)


if __name__ == "__main__":
    unittest.main()
