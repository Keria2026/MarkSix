#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077
mkdir -p backups
output="backups/marksix-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
partial="${output}.partial"
trap 'rm -f -- "$partial"' EXIT
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysqldump --no-tablespaces --single-transaction --routines --triggers -u marksix marksix' | gzip > "$partial"
gzip -t "$partial"
mv "$partial" "$output"
printf '备份已保存：%s\n' "$output"
