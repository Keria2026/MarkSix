#!/usr/bin/env python3
"""Create a private .env once. Never overwrite existing credentials."""
import getpass
import os
from pathlib import Path
import re
import secrets
import sys

root = Path(__file__).resolve().parents[1]
path = root / '.env'
if path.exists():
    sys.exit('.env 已存在，未覆盖。请按运行说明修改配置；现有管理员密码不会随环境变量更新。')
username = input('管理员账号 [admin]: ').strip() or 'admin'
if not re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', username):
    sys.exit('账号须为 1–80 位英文字母、数字、点、横线或下划线。')
password = getpass.getpass('设置管理员密码（至少 12 字符，不会显示）: ')
if len(password) < 12 or len(password.encode()) > 256 or any(c in password for c in "\r\n'\\"):
    sys.exit("密码须至少 12 字符、至多 256 字节，不能包含换行、单引号或反斜杠。")
if password != getpass.getpass('再次输入密码: '):
    sys.exit('两次密码不一致，未创建文件。')
content = f"DB_PASSWORD={secrets.token_hex(24)}\nDB_ROOT_PASSWORD={secrets.token_hex(24)}\nADMIN_USERNAME={username}\nADMIN_PASSWORD='{password}'\nPORT=8088\n"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as out:
    out.write(content)
print('已创建权限为 600 的 .env。执行 docker compose up -d --build 启动。')
