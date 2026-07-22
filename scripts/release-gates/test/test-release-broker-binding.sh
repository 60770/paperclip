#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
binding="$repo_root/deploy/release-broker/releasebot-binding/AGENTS.md"

[[ -f "$binding" ]] || { printf 'binding missing\n' >&2; exit 1; }
grep -Fq 'client-cli.js merge-once' "$binding"

forbidden=(
  'GITLAB_API_TOKEN'
  'GITLAB_TOKEN'
  'PRIVATE-TOKEN'
  'gitlab-merge-token'
  '.git-credentials'
  'credential.helper'
  'CREDENTIALS_DIRECTORY'
  'glab auth'
  'release-human-gate-preflight.sh'
  'release-main-lock-resolver.sh'
)
for pattern in "${forbidden[@]}"; do
  if grep -Fq "$pattern" "$binding"; then
    printf 'forbidden binding pattern: %s\n' "$pattern" >&2
    exit 1
  fi
done
if grep -Eiq 'curl[^\n]*(merge_requests|/merge)|/api/v4/projects/.*/merge_requests/.*/merge' "$binding"; then
  printf 'direct merge call in binding\n' >&2
  exit 1
fi

printf 'release broker binding regression: ok\n'
