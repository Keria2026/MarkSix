#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
command -v python3 >/dev/null
docker compose version >/dev/null
docker info >/dev/null
python3 verify.py
if [[ ! -f .env ]]; then python3 scripts/configure.py; fi
docker load --input images.tar.gz
bash start.sh
