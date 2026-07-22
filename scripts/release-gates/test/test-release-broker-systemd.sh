#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
unit="$repo_root/deploy/release-broker/gotto-release-broker.service"

required=(
  'NoNewPrivileges=yes'
  'CapabilityBoundingSet='
  'AmbientCapabilities='
  'ProtectSystem=strict'
  'ProtectHome=yes'
  'PrivateDevices=yes'
  'PrivateTmp=yes'
  'PrivateMounts=yes'
  'RestrictNamespaces=yes'
  'RestrictSUIDSGID=yes'
  'LockPersonality=yes'
  'MemoryDenyWriteExecute=yes'
  'SystemCallArchitectures=native'
  'SystemCallFilter=@system-service'
  'DevicePolicy=closed'
  'IPAddressDeny=any'
  'LoadCredential=gitlab-merge-token:'
  'LoadCredential=paperclip-api-key:'
)
for setting in "${required[@]}"; do
  grep -Fq "$setting" "$unit" || {
    printf 'missing hardening setting: %s\n' "$setting" >&2
    exit 1
  }
done

if grep -Eq 'Environment=.*(TOKEN|KEY|SECRET)=' "$unit"; then
  printf 'secret injected through environment\n' >&2
  exit 1
fi

printf 'release broker systemd regression: ok\n'
