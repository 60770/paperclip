#!/usr/bin/env bash
set -euo pipefail

# Codex refuses headless execution outside a trusted Git worktree. The
# workspace is an ephemeral tmpfs, so initialize a throwaway repository on
# every container start rather than persisting trust state on the host.
git -C /workspace init --quiet

exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config
