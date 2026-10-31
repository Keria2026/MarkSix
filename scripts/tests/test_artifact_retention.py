"""Coverage reports follow report retention, never production-package retention."""
import datetime as dt
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cleanup_artifacts as cleanup


class CoverageRetention(unittest.TestCase):
    def run_record(self, identity, number, status='completed', conclusion='success'):
        return {'id': identity, 'workflow_id': 3, 'run_number': number, 'status': status,
                'head_branch': 'dev', 'head_repository': {'id': 2}, 'event': 'push', 'conclusion': conclusion}

    def artifact(self, identity, run, created='2040-01-01T00:00:00Z'):
        return {'id': identity, 'name': 'coverage-report', 'workflow_run': {'id': run},
                'created_at': created, 'expired': False, 'size_in_bytes': 10}

    def test_latest_report_is_retained_and_superseded_report_is_removed(self):
        runs = {1: self.run_record(1, 1), 2: self.run_record(2, 2)}
        plan = cleanup.plan_cleanup([self.artifact(1, 1), self.artifact(2, 2)], runs, {}, 2, 3, dt.datetime(2040, 1, 2, tzinfo=dt.timezone.utc))
        self.assertEqual([item['action'] for item in plan], ['delete', 'keep'])

    def test_synthetic_corpus_follows_report_retention(self):
        runs = {1: self.run_record(1, 1), 2: self.run_record(2, 2)}
        artifacts = [{**self.artifact(i, i), 'name': 'text-entry-corpus'} for i in (1, 2)]
        plan = cleanup.plan_cleanup(artifacts, runs, {}, 2, 3, dt.datetime(2040, 1, 2, tzinfo=dt.timezone.utc))
        self.assertEqual([item['action'] for item in plan], ['delete', 'keep'])

    def test_in_progress_reports_are_kept_and_completed_reports_expire(self):
        runs = {1: self.run_record(1, 1, 'in_progress', None), 2: self.run_record(2, 2)}
        plan = cleanup.plan_cleanup([self.artifact(1, 1), self.artifact(2, 2)], runs, {}, 2, 3, dt.datetime(2040, 1, 9, tzinfo=dt.timezone.utc))
        self.assertEqual([item['action'] for item in plan], ['keep', 'delete'])
