#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -u)" == 0 ]]
shared_root="${1:-/opt/marksix/shared}"
[[ "$shared_root" =~ ^/[A-Za-z0-9_/-]+$ ]]
deployment_root="$(dirname "$shared_root")"
cat > /etc/systemd/system/marksix-renew.service <<EOF
[Unit]
Description=Renew MarkSix HTTPS certificates
After=docker.service network-online.target
[Service]
Type=oneshot
ExecStart=/bin/bash $deployment_root/current/renew.sh $shared_root
EOF
cat > /etc/systemd/system/marksix-renew.timer <<'EOF'
[Unit]
Description=Check MarkSix certificate renewal twice daily
[Timer]
OnCalendar=*-*-* 03,15:15:00
RandomizedDelaySec=1800
Persistent=true
[Install]
WantedBy=timers.target
EOF
cat > /etc/systemd/system/marksix-backup.service <<EOF
[Unit]
Description=Consistent MarkSix account and ledger backup
After=docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $deployment_root/current/ops.py backup --shared $shared_root
EOF
cat > /etc/systemd/system/marksix-backup.timer <<'EOF'
[Unit]
Description=Back up MarkSix outside the draw window
[Timer]
OnCalendar=*-*-* 19:00:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now marksix-renew.timer marksix-backup.timer
