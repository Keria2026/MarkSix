#!/usr/bin/env python3
"""Package tested Linux/amd64 images for Windows Docker Desktop; no credentials."""
import argparse
import datetime
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version', required=True)
    parser.add_argument('--backend', required=True)
    parser.add_argument('--frontend', required=True)
    parser.add_argument('--mysql', default='mysql:8.4')
    parser.add_argument('--target', choices=['windows-docker','ubuntu'], default='windows-docker')
    parser.add_argument('--output', type=Path, default=ROOT / 'windows-package')
    args = parser.parse_args()
    if not re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}', args.version):
        parser.error('Version must be a valid Docker image tag')
    output = args.output.resolve()
    if output.exists() and any(output.iterdir()):
        parser.error('Output directory must be empty; existing files will not be overwritten')
    output.mkdir(parents=True, exist_ok=True)
    compose = json.loads(run('docker', 'compose', '-f', str(ROOT / 'compose.yaml'),
                             'config', '--no-interpolate', '--format', 'json'))
    # Let the explicit Compose project name control resource names.
    for section in ('volumes', 'networks'):
        for resource in compose.get(section, {}).values():
            resource.pop('name', None)
    tags = []
    for service, source, label in [('backend', args.backend, 'backend'),
                                   ('frontend', args.frontend, 'frontend'),
                                   ('db', args.mysql, 'mysql')]:
        platform = run('docker', 'image', 'inspect', '--format', '{{.Os}}/{{.Architecture}}', source)
        if platform != 'linux/amd64':
            raise RuntimeError(f'{source}: expected linux/amd64, got {platform}')
        tag = f'marksix-{label}:{args.version}'
        subprocess.run(['docker', 'tag', source, tag], check=True)
        compose['services'][service].pop('build', None)
        compose['services'][service]['image'] = tag
        compose['services'][service]['pull_policy'] = 'never'
        tags.append(tag)
    # JSON is valid YAML, avoiding an additional packaging dependency.
    (output / 'compose.yaml').write_text(json.dumps(compose, indent=2).replace('Run scripts/configure.py first', 'Run install.sh first' if args.target == 'ubuntu' else 'Run Install.cmd first') + '\n', encoding='utf-8')
    if args.target == 'ubuntu':
        shutil.copytree(ROOT / 'deploy/ubuntu', output, dirs_exist_ok=True)
        (output / 'scripts').mkdir(exist_ok=True)
        for name in ['configure.py', 'backup.sh', 'restore.sh']:
            shutil.copyfile(ROOT / 'scripts' / name, output / 'scripts' / name)
        shutil.copyfile(ROOT / 'docs/RUNNING.md', output / 'README.md')
    else:
        for path in (ROOT / 'deploy/windows').iterdir():
            if path.suffix in ('.ps1', '.cmd'):
                shutil.copyfile(path, output / path.name)
        shutil.copyfile(ROOT / 'docs/WINDOWS.md', output / 'README.txt')
    archive = output / 'images.tar.gz'
    with subprocess.Popen(['docker', 'save', *tags], stdout=subprocess.PIPE) as process:
        try:
            with gzip.open(archive, 'wb', compresslevel=6) as destination:
                shutil.copyfileobj(process.stdout, destination, length=1024 * 1024)
        except BaseException:
            process.kill()
            raise
        finally:
            process.stdout.close()
        if process.wait():
            raise RuntimeError('docker save failed; package must not be published')
    hashes = {}
    for path in sorted(output.rglob("*")):
        if not path.is_file():
            continue
        with path.open('rb') as stream:
            hashes[str(path.relative_to(output))] = hashlib.file_digest(stream, 'sha256').hexdigest()
    manifest = {'schema': 1, 'version': args.version, 'platform': 'linux/amd64', 'target': args.target,
                'built_at_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                'files': hashes}
    (output / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'Deployment package ready: {output} ({archive.stat().st_size:,} image bytes)')


if __name__ == '__main__':
    main()
