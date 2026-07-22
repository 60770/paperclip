#!/usr/bin/env bash
set -euo pipefail

ssh_command="${SSH_ORIGINAL_COMMAND:-}"

if [[ -z "${ssh_command}" ]]; then
  exec /bin/bash
fi

if [[ "${ssh_command}" == scp* ]]; then
  eval "exec ${ssh_command}"
fi

exec /bin/bash -lc -- "${ssh_command}"
