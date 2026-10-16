#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
release_sha="${1:?Supply the full commit SHA}"
deploy_user="${2:-ubuntu}"
sequence="${3:?Supply Actions run number}"
attempt="${4:?Supply Actions run attempt}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ && "$deploy_user" =~ ^[a-z_][a-z0-9_-]*$ ]]
if ! docker compose version >/dev/null 2>&1 || ! command -v certbot >/dev/null || ! command -v python3 >/dev/null; then
  bash prepare-server.sh "$deploy_user"
fi
python3 deploy.py --sha "$release_sha" --sequence "$sequence" --attempt "$attempt"
bash install-timers.sh
