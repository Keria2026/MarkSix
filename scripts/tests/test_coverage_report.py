"""Coverage must never turn missing instrumentation into a 100% claim."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import coverage_report as coverage


class CoverageInventory(unittest.TestCase):
    def test_lcov_merges_repeated_records_without_double_counting(self):
        parsed = coverage.lcov('SF:src/a.ts\nDA:1,0\nDA:2,2\nend_of_record\nDA:3,8\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n')
        self.assertEqual(parsed, {'src/a.ts': {1: 1, 2: 2}})

    def test_unmeasured_file_blocks_complete_target_even_when_measured_file_is_full(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / 'frontend/src'
            source.mkdir(parents=True)
            (source / 'a.ts').write_text('export const a = 1;')
            (source / 'Untested.svelte').write_text('<h1>Untested</h1>')
            (source / 'env.d.ts').write_text('declare const env: string;')
            directory = root / 'reports'
            (directory / 'frontend').mkdir(parents=True)
            (directory / 'frontend/lcov.info').write_text('SF:src/a.ts\nDA:1,1\nend_of_record\n')
            report = coverage.collect(root, directory)
            self.assertEqual(report['groups']['frontend']['unmeasured'], ['frontend/src/Untested.svelte'])
            self.assertEqual(report['groups']['frontend']['measured_line_percent'], 100)
            self.assertFalse(coverage.meets_target(report))
            self.assertIn('Untested.svelte', coverage.markdown(report))

    def test_browser_maps_and_bun_lines_combine_without_counting_tests_or_external_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'frontend/src').mkdir(parents=True)
            path = root / 'frontend/src/a.ts'
            path.write_text('a\nb\n')
            directory = root / 'reports'
            (directory / 'frontend').mkdir(parents=True)
            (directory / 'browser').mkdir()
            (directory / 'frontend/lcov.info').write_text('SF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n')
            raw = {'statementMap': {'0': {'start': {'line': 2}}}, 's': {'0': 3}}
            (directory / 'browser/run.json').write_text(json.dumps([{str(path): raw, '/outside/vendor.js': raw}]))
            report = coverage.collect(root, directory)
            self.assertEqual(report['groups']['frontend']['covered'], 2)
            self.assertEqual(report['groups']['frontend']['total'], 2)
            self.assertTrue(coverage.meets_target(report))

    def test_no_reports_and_uncovered_branches_fail_target(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'scripts').mkdir()
            (root / 'scripts/runtime.py').write_text('pass')
            directory = root / 'reports'
            directory.mkdir()
            self.assertFalse(coverage.meets_target(coverage.collect(root, directory)))
            raw = {'files': {'scripts/runtime.py': {'summary': {'covered_lines': 1, 'num_statements': 1, 'num_branches': 2, 'covered_branches': 1}, 'missing_lines': []}}}
            (directory / 'python.json').write_text(json.dumps(raw))
            report = coverage.collect(root, directory)
            self.assertFalse(coverage.meets_target(report))
            self.assertEqual(report['groups']['python']['files']['scripts/runtime.py']['branches_total'], 2)

    def test_backend_summary_maps_to_inventory(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'backend/src').mkdir(parents=True)
            source = root / 'backend/src/lib.rs'
            source.write_text('fn main() {}')
            directory = root / 'reports'
            directory.mkdir()
            (directory / 'backend.json').write_text(json.dumps({'data': [{'files': [{'filename': str(source), 'summary': {'lines': {'count': 2, 'covered': 1}}}]}]}))
            report = coverage.collect(root, directory)
            self.assertEqual(report['groups']['backend']['measured_line_percent'], 50)
            self.assertFalse(coverage.meets_target(report))
