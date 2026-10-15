#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose stop --timeout 60
remaining="$(docker compose ps --status running --quiet)"
if [[ -n "$remaining" ]]; then
  echo '仍有容器运行，停止未完成。请检查 docker compose ps 和日志。' >&2
  exit 1
fi
printf 'MarkSix 已停止，数据卷保留。\n'
