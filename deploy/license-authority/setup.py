#!/usr/bin/env python3
"""Create authority-only credentials once. Keep the signing key out of client packages."""
import os
from pathlib import Path
import secrets
import sys
root = Path(__file__).resolve().parent
if (root / '.env').exists():
    sys.exit('.env already exists; it was not overwritten.')
content = f'AUTHORITY_DB_PASSWORD={secrets.token_hex(24)}\nAUTHORITY_ROOT_PASSWORD={secrets.token_hex(24)}\nAUTHORITY_PORT=8090\n'
fd = os.open(root / '.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as out:
    out.write(content)
print('Created private authority .env. Install the matching signing key separately before starting.')
