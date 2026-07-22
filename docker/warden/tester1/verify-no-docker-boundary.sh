#!/usr/bin/env bash
set -euo pipefail

base_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
runner_container="paperclip-tester1-runner-1"
qa_tunnel_container="paperclip-tester1-qa-tunnel-1"

fail() {
  printf 'FAIL %s\n' "$*" >&2
  exit 1
}

services="$(/opt/warden/bin/warden env config --services)"
if grep -qx 'docker-daemon' <<<"${services}"; then
  fail "docker_daemon_service_present"
fi

rendered_config="$(/opt/warden/bin/warden env config)"
if grep -Eq 'docker-daemon|DOCKER_HOST|2375|privileged:[[:space:]]*true' <<<"${rendered_config}"; then
  fail "docker_control_plane_present_in_rendered_config"
fi

if docker inspect paperclip-tester1-docker-daemon-1 >/dev/null 2>&1; then
  fail "legacy_docker_daemon_container_present"
fi
printf 'PASS docker_control_plane_absent service=false api_2375=false\n'

mapfile -t warden_containers < <(
  docker ps -aq --filter label=com.docker.compose.project=paperclip-tester1
)
[[ "${#warden_containers[@]}" -gt 0 ]] || fail "no_warden_containers_found"

for container_id in "${warden_containers[@]}"; do
  if ! docker inspect "${container_id}" --format '{{json .}}' | jq -e '
    .HostConfig.Privileged == false and
    ((.HostConfig.CapAdd // []) | length) == 0 and
    ((.HostConfig.CapDrop // []) | index("ALL")) != null and
    ((.HostConfig.Devices // []) | length) == 0 and
    ((.HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
    ((.HostConfig.SecurityOpt // []) | index("seccomp=unconfined")) == null
  ' >/dev/null; then
    fail "least_privilege_container=$(docker inspect -f '{{.Name}}' "${container_id}")"
  fi
done
printf 'PASS warden_least_privilege privileged=false cap_add=none cap_drop=ALL devices=none seccomp=default\n'

docker inspect "${runner_container}" --format '{{json .Mounts}}' | jq -e \
  'all(.[]; .Type != "bind")' >/dev/null \
  || fail "runner_host_bind_present"
docker inspect "${runner_container}" --format '{{json .Config.Env}}' | jq -e \
  'all(.[]; startswith("DOCKER_HOST=") | not)' >/dev/null \
  || fail "runner_docker_host_present"

docker exec "${runner_container}" bash -lc '
  set -euo pipefail
  test ! -e /var/run/docker.sock
  test -z "${DOCKER_HOST:-}"
  ! command -v docker >/dev/null 2>&1
  ! curl --noproxy "*" --silent --fail --max-time 3 http://docker-daemon:2375/_ping >/dev/null 2>&1
  ! docker run --privileged alpine true >/dev/null 2>&1
  ! docker run --device /dev/null alpine true >/dev/null 2>&1
  ! docker run -v /:/host alpine true >/dev/null 2>&1
'
printf 'PASS runner_container_control_denied privileged=true devices=true host_bind=true\n'

docker exec "${runner_container}" bash -lc '
  set -euo pipefail
  ! env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
    curl --noproxy "*" --silent --fail --max-time 5 https://example.com/ >/dev/null 2>&1
  ! curl --silent --fail --max-time 10 https://example.com/ >/dev/null 2>&1
  ! curl --silent --fail --max-time 10 https://registry-1.docker.io/v2/ >/dev/null 2>&1
  curl --silent --fail --max-time 15 https://estetia.tidycode.it/health >/dev/null
'
grep -qx 'http_access deny production' "${base_dir}/.warden/proxy/squid.conf" \
  || fail "production_deny_rule_missing"
if rg -q 'docker_registry|docker\.io|cloudfront\.docker' "${base_dir}/.warden/proxy/squid.conf"; then
  fail "docker_registry_allowlist_present"
fi
printf 'PASS egress_negative arbitrary=denied registry=denied production=locally_denied preprod=allowed\n'

docker exec "${qa_tunnel_container}" test -s /tmp/tunnel_ed25519
docker exec "${runner_container}" test -s /run/qa-tunnel/tunnel_ed25519.pub
docker exec "${runner_container}" test ! -e /run/qa-tunnel/tunnel_ed25519
grep -qx 'AllowTcpForwarding remote' "${base_dir}/.warden/runner/sshd_config"
grep -qx 'PermitListen 127.0.0.1:8223 127.0.0.1:8224' \
  "${base_dir}/.warden/runner/sshd_config"

tunnel_ssh_options=(
  -i /tmp/tunnel_ed25519
  -p 2223
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile=/tmp/known_hosts
  -o LogLevel=ERROR
)

set +e
timeout 5 docker exec "${qa_tunnel_container}" ssh "${tunnel_ssh_options[@]}" \
  -o ExitOnForwardFailure=yes \
  -N -R 127.0.0.1:9999:127.0.0.1:9999 \
  runner@127.0.0.1 </dev/null >/dev/null 2>&1
extra_listener_rc="$?"
set -e
if [[ "${extra_listener_rc}" == "0" || "${extra_listener_rc}" == "124" ]]; then
  fail "tunnel_non_allowlisted_listener_accepted"
fi

docker exec "${runner_container}" awk \
  '$2 == "0100007F:201F" && $4 == "0A" { found=1 } END { exit !found }' \
  /proc/net/tcp
docker exec "${runner_container}" awk \
  '$2 == "0100007F:2020" && $4 == "0A" { found=1 } END { exit !found }' \
  /proc/net/tcp
printf 'PASS qa_tunnel remote_only=true permitlisten=127.0.0.1:8223,127.0.0.1:8224 private_key=tmpfs\n'
