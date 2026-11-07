"""The deployed artifact must come from a successful, complete matching dev run."""
import copy
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import select_dev_artifact as selection


class FakeGitHub:
    def __init__(self):
        self.run = {'id': 7, 'run_attempt': 1, 'workflow_id': 3, 'head_sha': 'a' * 40,
                    'status': 'completed', 'conclusion': 'success', 'event': 'push',
                    'head_branch': 'dev', 'head_repository': {'id': 2}}
        self.jobs = [{'name': n, 'conclusion': 'success'} for n in selection.REQUIRED_JOBS]
        self.artifacts = [{'name': selection.ARTIFACT, 'expired': False}]
        self.trees = {'a' * 40: 'same', 'b' * 40: 'same'}
    def request(self, path):
        if path == '': return {'id': 2}
        if path == '/actions/workflows/ci.yml': return {'id': 3}
        if path.startswith('/git/commits/'): return {'tree': {'sha': self.trees[path.rsplit('/', 1)[1]]}}
        raise AssertionError(path)
    def listing(self, path, key):
        if '/workflows/' in path: return [copy.deepcopy(self.run)]
        if path.endswith('/jobs'): return self.jobs
        if path.endswith('/artifacts'): return self.artifacts
        raise AssertionError(path)


class Selection(unittest.TestCase):
    def test_equal_trees_allow_different_commit_ids(self):
        self.assertEqual(selection.select(FakeGitHub(), 'b' * 40), (7, 'a' * 40))

    def test_rejects_changed_tree_failed_jobs_expired_artifact_and_untrusted_run(self):
        for mutation in ('tree', 'job', 'artifact', 'repo', 'event', 'conclusion', 'workflow'):
            client = FakeGitHub()
            if mutation == 'tree': client.trees['a' * 40] = 'other'
            if mutation == 'job': client.jobs[0]['conclusion'] = 'failure'
            if mutation == 'artifact': client.artifacts[0]['expired'] = True
            if mutation == 'repo': client.run['head_repository']['id'] = 4
            if mutation == 'event': client.run['event'] = 'workflow_dispatch'
            if mutation == 'conclusion': client.run['conclusion'] = 'failure'
            if mutation == 'workflow': client.run['workflow_id'] = 4
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                selection.select(client, 'b' * 40)

    def test_invalid_master_sha_is_rejected(self):
        with self.assertRaises(ValueError): selection.select(FakeGitHub(), '../master')
