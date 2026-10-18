#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

source "$project_dir/scripts/check-local-sso-secret.sh"

echo "WSL distro: ${WSL_DISTRO_NAME:-not-wsl}"
echo "User: $(id -un)"
echo "Project: $(pwd)"

command -v docker >/dev/null || {
  echo "ERROR: docker is unavailable in this WSL distro."
  echo "Enable Docker Desktop > Settings > Resources > WSL Integration for Ubuntu-24.04."
  exit 1
}

docker version --format 'Docker server: {{.Server.Version}}'
docker compose version
check_local_sso_secret
docker compose config --quiet
echo "Local environment check passed."
