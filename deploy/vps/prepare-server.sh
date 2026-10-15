#!/usr/bin/env bash
# One-time preparation on the owner's Ubuntu VPS, never on a customer's PC.
set -euo pipefail
[[ "$(id -u)" == 0 ]] || { echo 'Run this preparation script with sudo.' >&2; exit 1; }
deploy_user="${1:-ubuntu}"
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]*$ ]]
id "$deploy_user" >/dev/null
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" =~ ^(22\.04|24\.04)$ ]] || {
  echo 'Validated package instructions target Ubuntu 22.04/24.04. Inspect another release before installing.' >&2
  exit 1
}
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install --no-install-recommends -y ca-certificates curl gnupg python3 certbot openssl
if ! docker compose version >/dev/null 2>&1; then
  install -d -m 755 /etc/apt/keyrings
  key_file="$(mktemp)"
  trap 'test ! -f "$key_file" || unlink "$key_file"' EXIT
  curl --fail --silent --show-error --location https://download.docker.com/linux/ubuntu/gpg --output "$key_file"
  fingerprint="$(gpg --batch --show-keys --with-colons "$key_file" | awk -F: '$1=="fpr" {print $10;exit}')"
  [[ "$fingerprint" == 9DC858229FC7DD38854AE2D88D81803C0EBFCD88 ]] || {
    echo 'Docker signing key fingerprint changed; verify it before proceeding.' >&2; exit 1;
  }
  install -m 644 "$key_file" /etc/apt/keyrings/docker.asc
  architecture="$(dpkg --print-architecture)"
  codename="${UBUNTU_CODENAME:-$VERSION_CODENAME}"
  [[ "$architecture" == amd64 && "$codename" =~ ^[a-z]+$ ]]
  cat > /etc/apt/sources.list.d/marksix-docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $codename
Components: stable
Architectures: $architecture
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install --no-install-recommends -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
docker compose version
docker info >/dev/null
install -d -m 755 -o "$deploy_user" -g "$(id -gn "$deploy_user")" /opt/marksix/releases
install -d -m 700 /opt/marksix/shared
echo 'Prerequisites ready. Configure a dedicated deployment SSH key and initialize hosted/shared configuration next.'
