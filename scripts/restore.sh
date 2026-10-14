#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo '用法：scripts/restore.sh backups/marksix-时间.sql.gz' >&2
  exit 1
fi
if [[ "${CONFIRM_RESTORE:-}" != 'yes' ]]; then
  echo '恢复会覆盖当前数据库。先备份，再设置 CONFIRM_RESTORE=yes 运行本命令。' >&2
  exit 1
fi
gzip -t "$1"
docker compose stop frontend backend
gzip -dc "$1" | docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u marksix marksix'
docker compose up -d backend frontend
echo '恢复完成，服务已启动。请检查期次与投注记录。'
