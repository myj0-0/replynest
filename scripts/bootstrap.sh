#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

source "$project_dir/scripts/check-local-sso-secret.sh"
check_local_sso_secret

docker compose config --quiet
docker compose pull --ignore-buildable
docker compose build
docker compose up -d postgres redis mailpit
docker compose run --rm rails bundle exec rails db:chatwoot_prepare
docker compose up -d rails sidekiq help-docs
docker compose ps

echo
echo "Chatwoot: http://localhost:3000"
echo "Mailpit:  http://localhost:8025"
echo "Configure your own Chatwoot account/API inbox/token in .env, then run docker compose up -d."
