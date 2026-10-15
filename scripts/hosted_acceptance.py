#!/usr/bin/env python3
"""Real Docker/Nginx/TLS hosted acceptance in an isolated Compose project."""

import argparse
import concurrent.futures
import http.client
import json
import os
from pathlib import Path
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]


class LocalTLS(http.client.HTTPSConnection):
    def connect(self):
        raw = socket.create_connection(("127.0.0.1", self.port), self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path)
    parser.add_argument("--backend", default="marksix-backend:dev1-test")
    parser.add_argument("--frontend", default="marksix-frontend:dev1-test")
    parser.add_argument("--users", type=int, default=2)
    parser.add_argument("--load-seconds", type=int, default=30)
    parser.add_argument("--keep", action="store_true")
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--bun", default=shutil.which("bun"))
    parser.add_argument("--browser-cache")
    args = parser.parse_args()
    if not 2 <= args.users <= 200:
        parser.error("Use 2–200 isolated test accounts")
    root = (
        args.root.resolve()
        if args.root
        else Path(tempfile.mkdtemp(prefix="marksix-hosted-"))
    )
    root.mkdir(parents=True, exist_ok=True)
    if any(root.iterdir()):
        parser.error("Acceptance root must be empty")
    os.umask(0o077)
    release = root / "hosted"
    shutil.copytree(
        ROOT / "deploy/vps",
        release,
        ignore=shutil.ignore_patterns("__pycache__", ".env", ".images.env"),
    )
    text = (
        (release / "compose.yaml")
        .read_text()
        .replace(
            "name: marksix-hosted", f"name: marksix-acceptance-{uuid.uuid4().hex[:8]}"
        )
        .replace('"80:80", "443:443"', '"18080:80", "18443:443"')
    )
    if os.geteuid() != 0:
        # Local unprivileged runners cannot chown a bind mount. CI deliberately
        # runs this script as root and exercises the production UID 10001.
        text = text.replace(
            "command: [marksix, --hosted-authority]",
            f'command: [marksix, --hosted-authority]\n    user: "{os.geteuid()}:{os.getegid()}"',
        )
    (release / "compose.yaml").write_text(text)
    shared = root / "shared"
    subprocess.run(
        [
            sys.executable,
            str(release / "configure.py"),
            "--shared",
            str(shared),
            "--domain",
            "app.marksix.test",
            "--admin-domain",
            "admin.marksix.test",
        ],
        check=True,
    )
    config = dict(
        line.split("=", 1) for line in (shared / ".env").read_text().splitlines()
    )
    certs = shared / "letsencrypt/live/marksix"
    certs.mkdir(parents=True)
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            str(certs / "privkey.pem"),
            "-out",
            str(certs / "fullchain.pem"),
            "-days",
            "1",
            "-subj",
            "/CN=app.marksix.test",
            "-addext",
            "subjectAltName=DNS:app.marksix.test,DNS:admin.marksix.test",
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    (release / ".images.env").write_text(
        f"BACKEND_IMAGE={args.backend}\nFRONTEND_IMAGE={args.frontend}\nMYSQL_IMAGE=mysql:8.4\n"
    )
    compose = [
        "docker",
        "compose",
        "--env-file",
        str(shared / ".env"),
        "--env-file",
        str(release / ".images.env"),
        "-f",
        str(release / "compose.yaml"),
    ]
    ctx = ssl.create_default_context(cafile=str(certs / "fullchain.pem"))
    checks = []
    failures = []
    latencies = []
    started = time.monotonic()
    completed = False
    resources = []
    connections = threading.local()

    def command(*parts, **kwargs):
        return subprocess.run([*compose, *parts], check=True, **kwargs)

    def sql(query):
        command("up", "-d", "--no-deps", "tools", stdout=subprocess.DEVNULL)
        try:
            return (
                command(
                    "exec",
                    "-T",
                    "tools",
                    "sh",
                    "-c",
                    'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -hdb -uroot --batch --skip-column-names marksix_control',
                    input=query,
                    text=True,
                    stdout=subprocess.PIPE,
                )
                .stdout.strip()
                .splitlines()
            )
        finally:
            command("stop", "--timeout", "10", "tools", stdout=subprocess.DEVNULL)

    def call(host, path, method="GET", body=None, cookie=""):
        persistent = getattr(connections, "connection", None)
        connection = persistent or LocalTLS(host, 18443, timeout=30, context=ctx)
        headers = {
            "x-marksix": "1",
            "content-type": "application/json",
            "cookie": cookie,
        }
        begin = time.monotonic()
        connection.request(
            method,
            "/api" + path,
            body=json.dumps(body) if body is not None else None,
            headers=headers,
        )
        response = connection.getresponse()
        content = response.read()
        elapsed = (time.monotonic() - begin) * 1000
        try:
            result = json.loads(content)
        except ValueError:
            result = {"error": f"Unexpected non-JSON response (HTTP {response.status})"}
        cookie_out = (response.getheader("set-cookie") or "").split(";")[0]
        if path == "/login" and response.status == 200:
            cookie_header = response.getheader("set-cookie") or ""
            assert all(
                flag in cookie_header
                for flag in ["; Secure", "; HttpOnly", "; SameSite=Strict"]
            )
        if persistent is None:
            connection.close()
        return response.status, result, cookie_out, elapsed

    def ok(host, path, method="GET", body=None, cookie=""):
        status, result, output, elapsed = call(host, path, method, body, cookie)
        if status != 200:
            raise AssertionError(
                f"{method} {host}{path}: HTTP {status}, {result.get('error', 'invalid response')}"
            )
        return result, output, elapsed

    app = "app.marksix.test"
    admin = "admin.marksix.test"
    try:
        command("config", "--quiet")
        command(
            "up",
            "-d",
            "--no-build",
            "--pull",
            "never",
            "--wait",
            "--wait-timeout",
            "240",
        )
        assert ok(app, "/site")[0]["mode"] == "hosted"
        assert ok(admin, "/site")[0]["mode"] == "authority"
        checks.append("nginx_sni_tls_two_services")
        owner = ok(
            admin,
            "/login",
            "POST",
            {
                "username": config["AUTHORITY_ADMIN_USERNAME"],
                "password": config["AUTHORITY_ADMIN_PASSWORD"],
            },
        )[1]
        accounts = []
        password = uuid.uuid4().hex
        for index in range(args.users):
            name = f"acceptance-{index:03d}"
            account = ok(
                admin,
                "/accounts",
                "POST",
                {"username": name, "password": password, "permanent": index > 0},
                owner,
            )[0]
            accounts.append(account)
            if (index + 1) % 20 == 0:
                print(
                    f"Provisioned {index + 1}/{args.users} isolated accounts",
                    flush=True,
                )
        checks.append("independent_databases_provisioned")
        cookies = [
            ok(
                app, "/login", "POST", {"username": a["username"], "password": password}
            )[1]
            for a in accounts
        ]
        assert call(app, "/bootstrap", cookie=cookies[0])[0] == 402
        import datetime

        date = (
            (
                datetime.datetime.now(datetime.timezone.utc)
                + datetime.timedelta(hours=8, days=1)
            )
            .date()
            .isoformat()
        )
        code = ok(
            admin,
            f"/accounts/{accounts[0]['id']}/codes",
            "POST",
            {"days": 1, "redeem_through": date},
            owner,
        )[0]["code"]
        assert (
            call(
                app,
                "/license/activate",
                "POST",
                {"code": code, "request_id": str(uuid.uuid4())},
                cookies[1],
            )[0]
            == 422
        )
        ok(
            app,
            "/license/activate",
            "POST",
            {"code": code, "request_id": str(uuid.uuid4())},
            cookies[0],
        )
        assert ok(app, "/license", cookie=cookies[0])[0]["active"]
        assert ok(app, "/bootstrap", cookie=cookies[0])[0]["plays"]
        checks.append("production_portal_database_grants_and_account_activation")
        assert call(admin, "/accounts", cookie=cookies[0])[0] == 401
        checks.append("customer_cookie_cannot_manage_authority")
        new_cookie = ok(
            app,
            "/login",
            "POST",
            {"username": accounts[0]["username"], "password": password},
        )[1]
        assert call(app, "/session", cookie=cookies[0])[0] == 401
        cookies[0] = new_cookie
        checks.append("single_session_over_secure_cookie")
        if args.users > 2:
            # Match a real empty-ledger overview: five API requests per cycle,
            # persistent HTTPS connections and staggered six-second refreshes.
            def client(index):
                local = []
                end = time.monotonic() + args.load_seconds
                time.sleep((index % 60) / 10)
                connections.connection = LocalTLS(app, 18443, timeout=30, context=ctx)
                try:
                    while time.monotonic() < end:
                        status, _, _, elapsed = call(
                            app, "/license", cookie=cookies[index]
                        )
                        local.append((status, elapsed))
                        status, data, _, elapsed = call(
                            app, "/bootstrap", cookie=cookies[index]
                        )
                        local.append((status, elapsed))
                        period = data.get("today", {}).get("id", "invalid")
                        for path in [
                            "/bets",
                            f"/periods/{period}/statistics",
                            "/parties",
                        ]:
                            status, _, _, elapsed = call(
                                app, path, cookie=cookies[index]
                            )
                            local.append((status, elapsed))
                        time.sleep(6)
                finally:
                    connections.connection.close()
                    connections.connection = None
                return local

            with concurrent.futures.ThreadPoolExecutor(
                max_workers=args.users
            ) as executor:
                for results in executor.map(client, range(args.users)):
                    for status, latency in results:
                        latencies.append(latency)
                        if status != 200:
                            failures.append(status)
            if failures:
                raise AssertionError(
                    f"Online load had {len(failures)} failed responses, statuses {sorted(set(failures))}"
                )
            checks.append(f"{args.users}_sessions_real_polling")
        ids = command("ps", "-q", text=True, stdout=subprocess.PIPE).stdout.split()
        inspected = json.loads(
            subprocess.check_output(["docker", "inspect", *ids], text=True)
        )
        assert all(
            not item["State"]["OOMKilled"] and item["RestartCount"] == 0
            for item in inspected
        )
        resources = [
            json.loads(line)
            for line in subprocess.check_output(
                ["docker", "stats", "--no-stream", "--format", "{{json .}}", *ids],
                text=True,
            ).splitlines()
        ]
        # A known tenant row must survive a real stopped-apps SQL backup/restore.
        database = sql(
            f"SELECT database_name FROM hosted_accounts WHERE id='{accounts[0]['id']}';"
        )[0]
        sql(f"UPDATE `{database}`.plays SET enabled=FALSE WHERE id=1;")
        result = subprocess.run(
            [
                sys.executable,
                str(release / "ops.py"),
                "backup",
                "--shared",
                str(shared),
            ],
            check=True,
            text=True,
            stdout=subprocess.PIPE,
        )
        manifest = next(
            line.removeprefix("Backup saved: ")
            for line in result.stdout.splitlines()
            if line.startswith("Backup saved: ")
        )
        sql(f"UPDATE `{database}`.plays SET enabled=TRUE WHERE id=1;")
        subprocess.run(
            [
                sys.executable,
                str(release / "ops.py"),
                "restore",
                "--shared",
                str(shared),
                "--manifest",
                manifest,
                "--confirm-restore",
            ],
            check=True,
        )
        assert sql(f"SELECT enabled FROM `{database}`.plays WHERE id=1;") == ["0"]
        checks.append("cold_backup_restore_preserves_tenant_and_recreates_principals")
        assert call(app, "/session", cookie=cookies[0])[0] == 401
        checks.append("restore_invalidates_old_sessions")
        for _ in range(2):
            subprocess.run(
                [
                    sys.executable,
                    str(release / "ops.py"),
                    "stop",
                    "--shared",
                    str(shared),
                ],
                check=True,
            )
        subprocess.run(
            [sys.executable, str(release / "ops.py"), "start", "--shared", str(shared)],
            check=True,
        )
        checks.append("repeat_stop_and_start")
        owner = ok(
            admin,
            "/login",
            "POST",
            {
                "username": config["AUTHORITY_ADMIN_USERNAME"],
                "password": config["AUTHORITY_ADMIN_PASSWORD"],
            },
        )[1]
        if args.browser:
            if not args.bun:
                raise RuntimeError("Bun executable is required for browser acceptance")
            env = os.environ.copy()
            env["HOSTED_OWNER_USERNAME"] = config["AUTHORITY_ADMIN_USERNAME"]
            env["HOSTED_OWNER_PASSWORD"] = config["AUTHORITY_ADMIN_PASSWORD"]
            if args.browser_cache:
                env["PLAYWRIGHT_BROWSERS_PATH"] = args.browser_cache
            subprocess.run(
                [args.bun, "x", "playwright", "test", "hosted.spec.ts"],
                cwd=ROOT / "frontend",
                env=env,
                check=True,
            )
            checks.append(
                "real_browser_management_activation_single_session_deletion_axe_mobile"
            )
            # Browser login replaced the manager session. Refresh it before API cleanup.
            owner = ok(
                admin,
                "/login",
                "POST",
                {
                    "username": config["AUTHORITY_ADMIN_USERNAME"],
                    "password": config["AUTHORITY_ADMIN_PASSWORD"],
                },
            )[1]
        for account in accounts:
            ok(
                admin,
                f"/accounts/{account['id']}",
                "PUT",
                {"action": "delete", "confirmation": f"永久删除 {account['username']}"},
                owner,
            )
        assert sql("SELECT COUNT(*) FROM hosted_accounts;") == ["0"]
        assert not (shared / "backups/control").exists()
        checks.append("permanent_delete_erases_control_and_tenant_backup_data")
        completed = True
    finally:
        destination = ROOT / "test-results"
        destination.mkdir(exist_ok=True)
        ordered = sorted(latencies)
        result = {
            "passed": completed,
            "checks": checks,
            "users": args.users,
            "requests": len(latencies),
            "failed_responses": len(failures),
            "p95_ms": round(ordered[int(len(ordered) * 0.95)], 2) if ordered else None,
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "production_vps_tested": False,
            "load_dataset": "independent accounts, default rules, empty ledgers, five overview requests every six seconds",
            "authority_uid": 10001 if os.geteuid() == 0 else os.geteuid(),
            "resources_after_load": resources,
            "container_cpu_quota_sum": 2.0,
            "container_memory_limit_sum_mb": 800,
        }
        (destination / "hosted-acceptance.json").write_text(
            json.dumps(result, indent=2) + "\n"
        )
        os.chmod(destination, 0o755)
        os.chmod(destination / "hosted-acceptance.json", 0o644)
        if not args.keep:
            command("down", "--volumes", "--remove-orphans")
        else:
            print(f"Isolated acceptance installation retained at {root}", flush=True)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
