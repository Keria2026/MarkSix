#!/bin/bash
(
set -euo pipefail
# Only generated hexadecimal secrets are interpolated into bootstrap SQL.
[[ "$PORTAL_DB_PASSWORD" =~ ^[0-9a-f]{64}$ ]]
MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysql -uroot <<SQL
CREATE USER IF NOT EXISTS 'portal'@'%' IDENTIFIED BY '$PORTAL_DB_PASSWORD';
SQL
)
