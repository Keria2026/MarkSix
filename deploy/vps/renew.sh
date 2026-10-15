#!/usr/bin/env bash
set -euo pipefail
shared_root="${1:-/opt/marksix/shared}"
[[ "$shared_root" =~ ^/[A-Za-z0-9_/-]+$ ]]
exec 9>"$shared_root/.operations.lock"
flock -x 9
certbot renew --quiet --config-dir "$shared_root/letsencrypt" --work-dir "$shared_root/acme-work" --logs-dir "$shared_root/acme-logs"
current_release="$(readlink -f "$shared_root/../current")"
docker compose --env-file "$shared_root/.env" --env-file "$current_release/.images.env" -f "$current_release/compose.yaml" exec -T nginx nginx -s reload
