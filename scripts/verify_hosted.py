#!/usr/bin/env python3
"""Verify built images in a disposable TLS/Compose deployment."""
import argparse
import json
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import uuid
ROOT = Path(__file__).resolve().parents[1]

def port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend', required=True)
    parser.add_argument('--frontend', required=True)
    args = parser.parse_args()
    project = 'marksix-verify-' + uuid.uuid4().hex[:12]
    report = {'project': project, 'passed': False}
    output = ROOT / 'test-results/hosted-acceptance.json'
    output.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='marksix-images-') as folder:
        root = Path(folder)
        hosted = root / 'hosted'
        shutil.copytree(ROOT / 'deploy/vps', hosted)
        # Match package_ubuntu's public runtime permissions. Some managed
        # checkouts use 0600 files, which MySQL's unprivileged init cannot read.
        # Private shared configuration and TLS keys are created separately below.
        for path in [hosted, *hosted.rglob('*')]:
            path.chmod(0o755 if path.is_dir() else 0o644)
        shared = root / 'shared'
        subprocess.run(['python3', str(hosted / 'configure.py'), '--shared', str(shared), '--domain', 'app.example.test', '--admin-domain', 'admin.example.test'], check=True, stdout=subprocess.DEVNULL)
        certificate = shared / 'letsencrypt/live/marksix'
        certificate.mkdir(parents=True)
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=app.example.test', '-addext', 'subjectAltName=DNS:app.example.test,DNS:admin.example.test', '-keyout', str(certificate / 'privkey.pem'), '-out', str(certificate / 'fullchain.pem')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for p in [root, shared, shared / 'letsencrypt', shared / 'letsencrypt/live', certificate]:
            p.chmod(493)
        (certificate / 'fullchain.pem').chmod(420)
        http, tls = (port(), port())
        compose_file = hosted / 'compose.yaml'
        text = compose_file.read_text().replace('ports: ["80:80", "443:443"]', f'ports: ["127.0.0.1:{http}:80", "127.0.0.1:{tls}:443"]')
        compose_file.write_text(text)
        images = hosted / '.images.env'
        images.write_text(f'BACKEND_IMAGE={args.backend}\nFRONTEND_IMAGE={args.frontend}\nMYSQL_IMAGE=mysql:8.4\n')
        command = ['docker', 'compose', '-p', project, '--env-file', str(shared / '.env'), '--env-file', str(images), '-f', str(compose_file)]

        def compose(*parts, **kwargs):
            return subprocess.run([*command, *parts], check=True, **kwargs)

        def request(host, path, body=None, cookie=''):
            command = ['curl', '--fail-with-body', '--silent', '--show-error', '--noproxy', '*', '--max-time', '30', '--cacert', str(certificate / 'fullchain.pem'), '--resolve', f'{host}:{tls}:127.0.0.1', '-H', 'X-Marksix: 1', '-H', 'Content-Type: application/json', '-D', '-']
            if cookie:
                command += ['-H', 'Cookie: ' + cookie]
            if body is not None:
                command += ['--data-binary', json.dumps(body)]
            command += [f'https://{host}:{tls}{path}']
            result = subprocess.run(command, text=True, capture_output=True)
            headers, _, content = result.stdout.partition('\n\n')
            if result.returncode:
                raise RuntimeError(f'{host}{path}: HTTP verification failed')
            cookies = [line.split(':', 1)[1].strip().split(';')[0] for line in headers.splitlines() if line.lower().startswith('set-cookie:')]
            return (json.loads(content), cookies[0] if cookies else '')
        try:
            compose('up', '-d', '--wait', '--wait-timeout', '240', stdout=subprocess.DEVNULL)
            for host, mode in [('app.example.test', 'hosted'), ('admin.example.test', 'authority')]:
                assert request(host, '/api/site')[0]['mode'] == mode
                assert request(host, '/api/health')[0]['status'] == 'ok'
            values = dict((line.split('=', 1) for line in (shared / '.env').read_text().splitlines()))
            _, owner = request('admin.example.test', '/api/login', {'username': values['AUTHORITY_ADMIN_USERNAME'], 'password': values['AUTHORITY_ADMIN_PASSWORD']})
            customer_password = uuid.uuid4().hex
            account, _ = request('admin.example.test', '/api/accounts', {'username': 'image-contract', 'password': customer_password}, owner)
            assert account['state'] == 'ready'
            _, customer = request('app.example.test', '/api/login', {'username': 'image-contract', 'password': customer_password})
            status, _ = request('app.example.test', '/api/license', cookie=customer)
            assert not status['active']
            report.update(passed=True, modes=['hosted', 'authority'], tls=True, account_provisioning=True)
        except BaseException:
            compose('logs', '--tail', '100')
            raise
        finally:
            compose('down', '--volumes', '--remove-orphans', stdout=subprocess.DEVNULL)
            output.write_text(json.dumps(report, indent=2) + '\n')
    print('Hosted image contracts passed')
if __name__ == '__main__':
    main()
