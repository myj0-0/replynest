#!/usr/bin/env bash

read_env_value() {
  local key="$1"
  awk -v key="$key" '
    index($0, key "=") == 1 {
      sub(/^[^=]*=/, "")
      sub(/\r$/, "")
      print
      exit
    }
  ' .env
}

check_local_sso_secret() {
  if [[ ! -f .env ]]; then
    echo "ERROR: .env is missing. Copy .env.example to .env and configure local secrets."
    return 1
  fi

  local sso_secret
  sso_secret="$(read_env_value SAAS_SSO_SHARED_SECRET)"

  if [[ ${#sso_secret} -lt 32 || "$sso_secret" == CHANGE_ME* ]]; then
    echo "ERROR: SAAS_SSO_SHARED_SECRET must be a unique random value of at least 32 characters."
    echo "Generate one with: openssl rand -hex 48"
    echo "Then store it only in .env before starting or recreating the stack."
    return 1
  fi

  local other_key other_value
  for other_key in SECRET_KEY_BASE MOCK_WECHAT_SECRET DEMO_TENANT_API_KEY; do
    other_value="$(read_env_value "$other_key")"
    if [[ -n "$other_value" && "$sso_secret" == "$other_value" ]]; then
      echo "ERROR: SAAS_SSO_SHARED_SECRET must not reuse $other_key."
      return 1
    fi
  done
}
