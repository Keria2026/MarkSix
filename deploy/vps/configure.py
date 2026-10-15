#!/usr/bin/env python3
"""Create the private, persistent hosted configuration. Never print credentials."""

import argparse
import os
from pathlib import Path
import re
import secrets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--shared", type=Path, default=Path("/opt/marksix/shared"))
    parser.add_argument("--domain", default="3801.win")
    parser.add_argument("--admin-domain", default="admin.3801.win")
    parser.add_argument("--email", default="")
    parser.add_argument("--owner", default="owner")
    args = parser.parse_args()
    for host in (args.domain, args.admin_domain):
        if (
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?", host)
            or "." not in host
        ):
            parser.error("Use ASCII DNS hostnames")
    if args.domain == args.admin_domain:
        parser.error("Customer and management hostnames must differ")
    if args.email and not re.fullmatch(r"[A-Za-z0-9_.+-]+@[A-Za-z0-9.-]+", args.email):
        parser.error("Invalid ACME email")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", args.owner):
        parser.error("Bootstrap owner must be an ASCII account name")
    root = args.shared.resolve()
    if not re.fullmatch(r"/[A-Za-z0-9_/-]+", str(root)):
        parser.error(
            "Shared path must be an absolute path without spaces or special characters"
        )
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    # Exclusive create also protects an existing installation's database passwords.
    values = {
        "HOSTED_SHARED_ROOT": str(root),
        "APP_DOMAIN": args.domain,
        "ADMIN_DOMAIN": args.admin_domain,
        "ACME_EMAIL": args.email,
        "AUTHORITY_ADMIN_USERNAME": args.owner,
        "BACKUP_KEEP": "14",
        **{
            name: secrets.token_hex(32)
            for name in (
                "DB_ROOT_PASSWORD",
                "AUTHORITY_DB_PASSWORD",
                "PORTAL_DB_PASSWORD",
                "AUTHORITY_ADMIN_PASSWORD",
            )
        },
    }
    fd = os.open(root / ".env", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        stream.write("".join(f"{key}={value}\n" for key, value in values.items()))
    for folder in ("backups", "letsencrypt", "acme"):
        (root / folder).mkdir(mode=0o700, exist_ok=True)
    if os.geteuid() == 0:
        os.chown(root / "backups", 10001, 10001)
    os.chmod(root / "acme", 0o755)
    print(
        f"Private configuration created: {root / '.env'}. Credentials were not printed."
    )
    print(
        "Read the initial owner credential privately on the server. Preserve this file across releases."
    )


if __name__ == "__main__":
    main()
