#!/usr/bin/env python3
"""Hosted backup, restore and lifecycle operations. No secrets in CLI arguments."""

import argparse
from contextlib import contextmanager
import datetime as dt
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys

RELEASE = Path(__file__).resolve().parent


def file_sha256(path):
    # Ubuntu 22.04 ships Python 3.10, without hashlib.file_digest.
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def configuration(shared):
    result = {}
    for line in (shared / ".env").read_text(encoding="utf-8").splitlines():
        if line.strip() and not line.startswith("#"):
            key, value = line.split("=", 1)
            result[key] = value
    if Path(result["HOSTED_SHARED_ROOT"]).resolve() != shared:
        raise RuntimeError("Shared path does not match private configuration")
    return result


def compose(shared, *args, **kwargs):
    return subprocess.run(
        [
            "docker",
            "compose",
            "--env-file",
            str(shared / ".env"),
            "--env-file",
            str(RELEASE / ".images.env"),
            "-f",
            str(RELEASE / "compose.yaml"),
            *args,
        ],
        check=True,
        **kwargs,
    )


def mysql(shared, sql):
    result = compose(
        shared,
        "exec",
        "-T",
        "tools",
        "sh",
        "-c",
        'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -hdb -uroot --batch --skip-column-names marksix_control',
        input=sql,
        text=True,
        stdout=subprocess.PIPE,
    )
    return result.stdout.strip().splitlines()


@contextmanager
def lock(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        yield


def account_list(shared):
    rows = mysql(
        shared,
        "SELECT id,database_name,database_user,state FROM hosted_accounts ORDER BY id;",
    )
    result = []
    for row in rows:
        account, database, user, state = row.split("\t")
        if (
            not re.fullmatch(r"[0-9a-f-]{36}", account)
            or not re.fullmatch(r"marksix_t_[0-9a-f]{32}", database)
            or not re.fullmatch(r"mt_[0-9a-f]{24}", user)
        ):
            raise RuntimeError("Unexpected tenant identifiers")
        result.append((account, database, user, state))
    return result


def dump(shared, database, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    os.chmod(destination.parent, 0o700)
    # mysql credentials are expanded only inside the database container.
    command = [
        "docker",
        "compose",
        "--env-file",
        str(shared / ".env"),
        "--env-file",
        str(RELEASE / ".images.env"),
        "-f",
        str(RELEASE / "compose.yaml"),
        "exec",
        "-T",
        "tools",
        "sh",
        "-c",
        'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysqldump -hdb -uroot --single-transaction --no-tablespaces --routines --triggers --hex-blob --set-gtid-purged=OFF --default-character-set=utf8mb4 "$1"',
        "dump",
        database,
    ]
    partial = destination.with_suffix(".partial")
    try:
        with subprocess.Popen(command, stdout=subprocess.PIPE) as proc:
            with gzip.open(partial, "wb") as output:
                while chunk := proc.stdout.read(1024 * 1024):
                    output.write(chunk)
            proc.stdout.close()
            if proc.wait():
                raise RuntimeError(f"Dump failed for {database}")
        os.chmod(partial, 0o600)
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


@contextmanager
def maintenance(shared):
    compose(shared, "up", "-d", "--no-deps", "tools")
    try:
        yield
    finally:
        compose(shared, "stop", "--timeout", "10", "tools")


def backup(shared, preserve=None):
    with maintenance(shared):
        return backup_data(shared, preserve)


def backup_data(shared, preserve=None):
    # Call only after both applications have stopped. This gives a consistent
    # control/ledger boundary across independent per-customer SQL dumps.
    accounts = account_list(shared)
    if any(state != "ready" for _, _, _, state in accounts):
        raise RuntimeError(
            "Complete or delete provisioning/failed/deleting accounts before full backup"
        )
    stamp = (
        dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        + "-"
        + secrets.token_hex(4)
    )
    root = shared / "backups"
    files = {}
    with lock(root / ".lock"):
        for account, database, _, _ in accounts:
            path = root / "tenants" / account / f"{stamp}.sql.gz"
            dump(shared, database, path)
            files[str(path.relative_to(root))] = file_sha256(path)
        path = root / "control" / f"{stamp}.sql.gz"
        dump(shared, "marksix_control", path)
        files[str(path.relative_to(root))] = file_sha256(path)
        manifest = root / "control" / f"{stamp}.json"
        manifest.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "created_at": stamp,
                    "files": files,
                    "accounts": [
                        {"id": a, "database": d, "user": u} for a, d, u, _ in accounts
                    ],
                },
                indent=2,
            )
            + "\n"
        )
        os.chmod(manifest, 0o600)
        for path in [
            root,
            root / "control",
            *(root / "tenants" / a for a, _, _, _ in accounts),
        ]:
            if os.geteuid() == 0:
                os.chown(path, 10001, 10001)
        # Authority must be able to erase these files on permanent deletion.
        for path in root.rglob("*"):
            if os.geteuid() == 0:
                os.chown(path, 10001, 10001)
        keep = int(configuration(shared).get("BACKUP_KEEP", "14"))
        if not 1 <= keep <= 90:
            raise RuntimeError("BACKUP_KEEP must be 1–90 complete backup generations")
        for folder in [
            root / "control",
            *(root / "tenants" / a for a, _, _, _ in accounts),
        ]:
            old = [
                p
                for p in sorted(folder.glob("*.sql.gz"), reverse=True)[keep:]
                if preserve is None or not p.name.startswith(preserve)
            ]
            for path in old:
                path.unlink()
                if folder.name == "control":
                    path.with_name(path.name.removesuffix(".sql.gz") + ".json").unlink(
                        missing_ok=True
                    )
    return manifest


def restore(shared, manifest):
    with maintenance(shared):
        return restore_data(shared, manifest)


def restore_data(shared, manifest):
    root = shared / "backups"
    data = json.loads(manifest.read_text())
    if data.get("schema") != 1 or not isinstance(data.get("files"), dict):
        raise RuntimeError("Invalid backup manifest")
    for relative, expected in data["files"].items():
        path = (root / relative).resolve()
        if not path.is_relative_to(root.resolve()) or not path.is_file():
            raise RuntimeError("Backup is incomplete or contains an invalid path")
        if file_sha256(path) != expected:
            raise RuntimeError("Backup checksum mismatch")
    # Preserve current deletion receipts before restoring an older control dump.
    deleted = set(mysql(shared, "SELECT account_id FROM hosted_deletions;"))
    current = account_list(shared)
    if not re.fullmatch(r"[A-Za-z0-9_-]+", data["created_at"]):
        raise RuntimeError("Invalid backup timestamp")
    stamp = data["created_at"]
    control = root / "control" / f"{stamp}.sql.gz"
    if str(control.relative_to(root)) not in data["files"]:
        raise RuntimeError("Missing control dump")

    # An import failure intentionally leaves the applications stopped.
    def load(path, database):
        with gzip.open(path, "rb") as stream:
            command = [
                "docker",
                "compose",
                "--env-file",
                str(shared / ".env"),
                "--env-file",
                str(RELEASE / ".images.env"),
                "-f",
                str(RELEASE / "compose.yaml"),
                "exec",
                "-T",
                "tools",
                "sh",
                "-c",
                'MYSQL_PWD="$MYSQL_ROOT_PASSWORD" exec mysql -hdb -uroot --binary-mode --default-character-set=utf8mb4 "$1"',
                "restore",
                database,
            ]
            with subprocess.Popen(command, stdin=subprocess.PIPE) as proc:
                try:
                    while chunk := stream.read(1024 * 1024):
                        proc.stdin.write(chunk)
                    proc.stdin.close()
                except BaseException:
                    proc.kill()
                    raise
                if proc.wait():
                    raise RuntimeError(
                        "SQL restore failed; applications remain stopped"
                    )

    for _, database, user, _ in current:
        mysql(
            shared,
            f"DROP DATABASE IF EXISTS `{database}`; DROP USER IF EXISTS '{user}'@'%';",
        )
    load(control, "marksix_control")
    restored = account_list(shared)
    # Recreate only principals from the restored control database. Passwords stay
    # inside mysql, never becoming command arguments or log output.
    for account, database, user, _ in restored:
        if account in deleted:
            mysql(
                shared,
                f"DELETE FROM authority_audit WHERE account_id='{account}'; DELETE FROM hosted_accounts WHERE id='{account}'; INSERT IGNORE INTO hosted_deletions(account_id) VALUES('{account}');",
            )
            continue
        path = root / "tenants" / account / f"{stamp}.sql.gz"
        if str(path.relative_to(root)) not in data["files"]:
            raise RuntimeError("Missing tenant dump")
        grant_database = database.replace("_", "\\_")
        mysql(
            shared,
            f"CREATE DATABASE `{database}` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; SET @q=(SELECT CONCAT('CREATE USER IF NOT EXISTS ',QUOTE(database_user),'@',QUOTE('%'),' IDENTIFIED BY ',QUOTE(database_password)) FROM hosted_accounts WHERE id='{account}'); PREPARE s FROM @q; EXECUTE s; DEALLOCATE PREPARE s; GRANT ALL PRIVILEGES ON `{grant_database}`.* TO '{user}'@'%';",
        )
        load(path, database)
    mysql(shared, "DELETE FROM hosted_sessions; DELETE FROM authority_sessions;")
    for account in deleted:
        if not re.fullmatch(r"[0-9a-f-]{36}", account):
            raise RuntimeError("Invalid deletion receipt")
        mysql(
            shared,
            f"INSERT IGNORE INTO hosted_deletions(account_id) VALUES('{account}');",
        )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "operation", choices=["backup", "restore", "start", "stop", "status"]
    )
    parser.add_argument("--shared", type=Path, default=Path("/opt/marksix/shared"))
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--confirm-restore", action="store_true")
    args = parser.parse_args()
    shared = args.shared.resolve()
    configuration(shared)
    os.umask(0o077)
    with lock(shared / ".operations.lock"):
        if args.operation == "status":
            compose(shared, "ps")
        elif args.operation == "stop":
            compose(shared, "stop", "--timeout", "45", "nginx", "backend", "authority")
        elif args.operation == "start":
            compose(
                shared,
                "up",
                "-d",
                "--no-build",
                "--pull",
                "never",
                "--wait",
                "--wait-timeout",
                "180",
            )
        else:
            if args.operation == "restore" and (
                not args.confirm_restore or not args.manifest
            ):
                parser.error(
                    "Restore overwrites current data; supply --manifest and --confirm-restore"
                )
            compose(shared, "stop", "--timeout", "45", "backend", "authority")
            try:
                preserve = None
                if args.operation == "restore":
                    preserve = json.loads(args.manifest.read_text())["created_at"]
                    if not re.fullmatch(r"[A-Za-z0-9_-]+", preserve):
                        raise RuntimeError("Invalid restore generation")
                recovery = backup(shared, preserve=preserve)
                print(f"Backup saved: {recovery}")
            except BaseException:
                compose(
                    shared,
                    "up",
                    "-d",
                    "--no-build",
                    "--pull",
                    "never",
                    "--wait",
                    "--wait-timeout",
                    "180",
                    "authority",
                    "backend",
                )
                raise
            if args.operation == "restore":
                with lock(shared / "backups" / ".lock"):
                    restore(shared, args.manifest.resolve())
            compose(
                shared,
                "up",
                "-d",
                "--no-build",
                "--pull",
                "never",
                "--wait",
                "--wait-timeout",
                "180",
                "authority",
                "backend",
            )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            f"Operation failed: {error}. Check service status before continuing.",
            file=sys.stderr,
        )
        sys.exit(1)
