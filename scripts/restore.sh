#!/usr/bin/env bash
set -euo pipefail
# Resolve the input before changing directories, supporting absolute/relative/space paths.
if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo '用法：scripts/restore.sh /完整路径/备份.sql 或 备份.sql.gz' >&2
  exit 1
fi
backup_file="$(realpath -- "$1")"
cd "$(dirname "$0")/.."
if [[ "${CONFIRM_RESTORE:-}" != 'yes' ]]; then
  echo '恢复会覆盖当前数据库。先备份，再设置 CONFIRM_RESTORE=yes 运行本命令。' >&2
  exit 1
fi
if [[ "$backup_file" == *.gz ]]; then gzip -t "$backup_file"; fi
read_backup() { if [[ "$backup_file" == *.gz ]]; then gzip -dc -- "$backup_file"; else cat -- "$backup_file"; fi; }
docker compose stop --timeout 60 frontend backend
# Keep an automatic recovery point. An import failure deliberately leaves the app stopped.
bash scripts/backup.sh
docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql -u marksix --execute="DROP DATABASE marksix; CREATE DATABASE marksix CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"'
if ! read_backup | docker compose exec -T db sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" mysql --binary-mode --default-character-set=utf8mb4 -u marksix marksix'; then
  echo '恢复失败，应用保持停止。请使用刚生成的恢复前备份还原，保留日志。' >&2
  exit 1
fi
docker compose up -d --no-build --wait --wait-timeout 180 backend frontend
echo '恢复完成，服务已健康启动。请检查期次、投注记录和设备授权。'
