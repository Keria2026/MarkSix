#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
docker compose up -d --no-build --pull never --wait --wait-timeout 180
printf 'MarkSix 已启动。默认仅本机访问：http://127.0.0.1:8088\n'
