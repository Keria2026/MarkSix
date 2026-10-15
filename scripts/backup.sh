#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
output="backups/marksix-$(date -u +%Y%m%dT%H%M%SZ)-$(python3 -c 'import secrets; print(secrets.token_hex(4))').sql.gz"
partial="${output}.partial"
trap 'rm -f -- "$partial"' EXIT
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --no-tablespaces --single-transaction --routines --triggers --hex-blob --set-gtid-purged=OFF --default-character-set=utf8mb4 -u marksix --databases marksix' | gzip > "$partial"
gzip -t "$partial"
[[ -s "$partial" ]]
mv "$partial" "$output"
printf '备份已保存：%s\n' "$output"
