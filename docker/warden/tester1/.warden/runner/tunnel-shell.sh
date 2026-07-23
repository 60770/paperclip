#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  echo "Tunnel key is restricted to SSH tunneling only." >&2
  exit 1
fi

exec /bin/sleep infinity
