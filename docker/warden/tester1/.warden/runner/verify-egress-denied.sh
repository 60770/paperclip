#!/usr/bin/env bash
set -euo pipefail

http_code=""
if http_code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "$@")"; then
  printf 'reachable http_status=%s\n' "${http_code}" >&2
  exit 1
fi

if [[ "${http_code}" != "000" ]]; then
  printf 'reachable http_status=%s\n' "${http_code}" >&2
  exit 1
fi
