#!/bin/sh
set -eu

private_key=/tmp/tunnel_ed25519
public_key=/run/qa-tunnel-public/tunnel_ed25519.pub
known_hosts=/tmp/known_hosts
ssh_pid=

cleanup() {
  rm -f "${public_key}" "${private_key}" "${private_key}.pub" "${known_hosts}"
  if [ -n "${ssh_pid}" ]; then
    kill "${ssh_pid}" 2>/dev/null || true
    wait "${ssh_pid}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

umask 077
rm -f "${public_key}" "${private_key}" "${private_key}.pub"
ssh-keygen -q -t ed25519 -N '' -C tester1-qa-tunnel-runtime -f "${private_key}"
cp "${private_key}.pub" "${public_key}"
chmod 0644 "${public_key}"
awk '{ print "[127.0.0.1]:2223 " $1 " " $2 }' \
  /run/config/ssh_host_ed25519_key.pub >"${known_hosts}"

ssh -NT \
  -i "${private_key}" \
  -p 2223 \
  -o BatchMode=yes \
  -o ExitOnForwardFailure=yes \
  -o IdentitiesOnly=yes \
  -o ServerAliveCountMax=3 \
  -o ServerAliveInterval=10 \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=${known_hosts}" \
  -R 127.0.0.1:8223:127.0.0.1:8223 \
  -R 127.0.0.1:8224:127.0.0.1:8224 \
  runner@127.0.0.1 &
ssh_pid=$!
wait "${ssh_pid}"
