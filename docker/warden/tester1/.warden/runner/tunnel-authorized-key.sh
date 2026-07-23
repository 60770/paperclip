#!/usr/bin/env bash
set -euo pipefail

public_key=/run/qa-tunnel/tunnel_ed25519.pub

[[ -s "${public_key}" ]] || exit 0

read -r key_type key_data _ <"${public_key}"
printf '%s %s %s\n' \
  'command="/home/runner/tunnel-shell.sh",no-agent-forwarding,no-X11-forwarding,no-pty,permitlisten="127.0.0.1:8223",permitlisten="127.0.0.1:8224"' \
  "${key_type}" \
  "${key_data}"
