#!/usr/bin/env python3
"""Inventory runtime sources and report measured coverage without hiding absent files.

Inputs: Bun LCOV, LLVM JSON, coverage.py JSON and source-mapped Playwright JSON.
An uninstrumented file is unknown, never counted as covered or silently omitted.
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def source_path(value, root, base=None):
    path = Path(value)
    if not path.is_absolute():
        path = (base or root) / path
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


def lcov(text):
    result = {}
    current = None
    for line in text.splitlines():
        key, _, value = line.partition(':')
        if key == 'SF':
            current = result.setdefault(value, {})
        elif key == 'DA' and current is not None:
            number, count, *_ = value.split(',')
            current[int(number)] = max(current.get(int(number), 0), int(count))
        elif key == 'end_of_record':
            current = None
    return result


def inventory(root):
    groups = {
        'backend': sorted((root / 'backend/src').rglob('*.rs')),
        'frontend': sorted((root / 'frontend/src').rglob('*.ts')) + sorted((root / 'frontend/src').rglob('*.svelte')),
        'python': sorted((root / 'scripts').glob('*.py')) + sorted((root / 'deploy/vps').glob('*.py')),
        'typescript_tools': sorted((root / 'scripts').glob('*.ts')),
        'shell': sorted((root / 'scripts').glob('*.sh')) + sorted((root / 'deploy/vps').glob('*.sh')),
    }
    return {name: [p.relative_to(root).as_posix() for p in paths
                   if not p.name.endswith('.d.ts') and p != root / 'backend/src/hosted/tests.rs']
            for name, paths in groups.items()}


def collect(root, directory):
    measured = {}
    lines = {}
    inputs = []
    unit = directory / 'frontend/lcov.info'
    if unit.exists():
        inputs.append(str(unit))
        for name, hits in lcov(unit.read_text()).items():
            path = source_path(name, root, root / 'frontend')
            if path:
                lines[path] = hits
    for file in sorted((directory / 'browser').glob('*.json')):
        inputs.append(str(file))
        for report in json.loads(file.read_text()):
            for name, coverage in report.items():
                path = source_path(name, root)
                if not path:
                    continue
                hits = lines.setdefault(path, {})
                for key, statement in coverage['statementMap'].items():
                    # v8-to-istanbul emits one statement per source line.
                    number = statement['start']['line']
                    hits[number] = max(hits.get(number, 0), coverage['s'][key])
    for path, hits in lines.items():
        measured[path] = {'covered': sum(n > 0 for n in hits.values()), 'total': len(hits),
                          'missing_lines': sorted(n for n, count in hits.items() if not count)}
    rust = directory / 'backend.json'
    if rust.exists():
        inputs.append(str(rust))
        for unit in json.loads(rust.read_text())['data']:
            for file in unit['files']:
                path = source_path(file['filename'], root)
                if path:
                    coverage = file['summary']['lines']
                    measured[path] = {'covered': coverage['covered'], 'total': coverage['count']}
    python = directory / 'python.json'
    if python.exists():
        inputs.append(str(python))
        for name, file in json.loads(python.read_text())['files'].items():
            path = source_path(name, root)
            if path:
                summary = file['summary']
                measured[path] = {'covered': summary['covered_lines'], 'total': summary['num_statements'],
                                  'missing_lines': file['missing_lines'],
                                  'branches_covered': summary.get('covered_branches'),
                                  'branches_total': summary.get('num_branches')}
    groups = {}
    for name, sources in inventory(root).items():
        files = {source: measured.get(source) for source in sources}
        unknown = [source for source, coverage in files.items() if coverage is None]
        covered = sum(c['covered'] for c in files.values() if c)
        total = sum(c['total'] for c in files.values() if c)
        groups[name] = {'files': files, 'unmeasured': unknown, 'covered': covered, 'total': total,
                        'measured_line_percent': round(100 * covered / total, 2) if total else None,
                        'complete_inventory': not unknown}
    return {'schema': 1, 'inputs': inputs, 'groups': groups,
            'branch_note': 'Python reports source branches. Bun/LLVM line and V8 source-map coverage do not establish full cross-language branch coverage.'}


def meets_target(report):
    return bool(report['inputs']) and all(
        group['complete_inventory'] and all(
            coverage is not None and coverage['total'] > 0 and coverage['covered'] == coverage['total']
            and (coverage.get('branches_total') is None
                 or coverage['branches_covered'] == coverage['branches_total'])
            for coverage in group['files'].values())
        for group in report['groups'].values())


def markdown(report):
    rows = ['# Coverage inventory', '', '| Scope | Measured lines | Measured % | Unmeasured files |',
            '| --- | --- | --- | --- |']
    for name, group in report['groups'].items():
        rows.append(f"| {name} | {group['covered']}/{group['total']} | {group['measured_line_percent']} | {len(group['unmeasured'])} |")
    rows.extend(['', 'Percentages apply only to measured files; unmeasured files prevent a complete-project claim.', '', report['branch_note'], '', '## Unmeasured sources', ''])
    for group in report['groups'].values():
        rows.extend(f'- `{name}`' for name in group['unmeasured'])
    return '\n'.join(rows) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, default=ROOT / 'test-results/coverage')
    parser.add_argument('--strict', action='store_true', help='Fail on absent sources or any uncovered measured lines/branches; not a proof of unmeasured branch coverage.')
    args = parser.parse_args()
    report = collect(ROOT, args.directory)
    args.directory.mkdir(parents=True, exist_ok=True)
    (args.directory / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
    (args.directory / 'SUMMARY.md').write_text(markdown(report))
    print(markdown(report))
    if args.strict and not meets_target(report):
        raise SystemExit('100% coverage target has not been reached; see summary.json for missing sources and lines.')


if __name__ == '__main__':
    main()
