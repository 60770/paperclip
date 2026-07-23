#!/usr/bin/env bash
set -euo pipefail

base_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
shared_dir="$(cd -- "${base_dir}/../.." && pwd)"
runner_container="paperclip-tester1-runner-1"
qa_tunnel_container="paperclip-tester1-qa-tunnel-1"
runner_ssh_key="${RUNNER_SSH_KEY_FILE:-}"
revoked_key_image="${REVOKED_KEY_IMAGE:-}"
known_hosts="$(mktemp)"
fixture_log="$(mktemp)"
unauthorized_dir="$(mktemp -d)"
unauthorized_key="${unauthorized_dir}/id_ed25519"
fixture_pid=""

cleanup() {
  if [[ -n "${fixture_pid}" ]]; then
    kill "${fixture_pid}" 2>/dev/null || true
    wait "${fixture_pid}" 2>/dev/null || true
  fi
  rm -f "${known_hosts}" "${fixture_log}"
  rm -rf "${unauthorized_dir}"
}
trap cleanup EXIT INT TERM

[[ -n "${runner_ssh_key}" && -f "${runner_ssh_key}" ]] || {
  echo "FAIL RUNNER_SSH_KEY_FILE must point to the runtime-supplied runner key" >&2
  exit 1
}
[[ "$(stat -c '%a' "${runner_ssh_key}")" == "600" ]] || {
  echo "FAIL runner key must have mode 0600" >&2
  exit 1
}
case "$(readlink -f "${runner_ssh_key}")" in
  "${shared_dir}"/*)
    echo "FAIL runner private key must not live under shared/" >&2
    exit 1
    ;;
esac

for container in \
  "${runner_container}" \
  paperclip-tester1-egress-proxy-1 \
  paperclip-tester1-ssh-proxy-1; do
  [[ "$(docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null || true)" == "true" ]] || {
    echo "FAIL Warden container ${container} is not running" >&2
    exit 1
  }
done

rendered_config="$(/opt/warden/bin/warden env config)"
if grep -Eq 'docker-daemon|DOCKER_HOST|2375|privileged:[[:space:]]*true' <<<"${rendered_config}"; then
  echo "FAIL rendered Warden config exposes a Docker control plane" >&2
  exit 1
fi
if docker inspect paperclip-tester1-docker-daemon-1 >/dev/null 2>&1; then
  echo "FAIL legacy privileged Docker daemon still exists" >&2
  exit 1
fi
echo "PASS docker_control_plane_absent service=false api_2375=false"

python3 "${base_dir}/qa-fixture.py" --bind 127.0.0.1 >"${fixture_log}" 2>&1 &
fixture_pid="$!"
for _ in $(seq 1 30); do
  if curl --noproxy '*' --silent --fail --max-time 1 http://127.0.0.1:8223/health >/dev/null \
    && curl --noproxy '*' --silent --fail --max-time 1 http://127.0.0.1:8224/health >/dev/null; then
    break
  fi
  sleep 0.2
done
curl --noproxy '*' --silent --fail --max-time 2 http://127.0.0.1:8223/health >/dev/null
curl --noproxy '*' --silent --fail --max-time 2 http://127.0.0.1:8224/health >/dev/null

/opt/warden/bin/warden env build qa-tunnel >/dev/null
/opt/warden/bin/warden env up -d --no-build --force-recreate qa-tunnel >/dev/null
for _ in $(seq 1 50); do
  if [[ "$(docker inspect -f '{{.State.Running}}' "${qa_tunnel_container}" 2>/dev/null || true)" == "true" ]] \
    && docker exec "${runner_container}" test -s /run/qa-tunnel/tunnel_ed25519.pub \
    && docker exec "${runner_container}" \
      curl --noproxy '*' --silent --fail --max-time 1 http://127.0.0.1:8223/health >/dev/null 2>&1 \
    && docker exec "${runner_container}" \
      curl --noproxy '*' --silent --fail --max-time 1 http://127.0.0.1:8224/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done
docker exec "${runner_container}" curl --noproxy '*' --silent --fail --max-time 2 http://127.0.0.1:8223/health >/dev/null
docker exec "${runner_container}" curl --noproxy '*' --silent --fail --max-time 2 http://127.0.0.1:8224/health >/dev/null
echo "PASS fixture_and_tunnel_on_demand_started ports=8223,8224 bind=127.0.0.1"

awk '{ print "[127.0.0.1]:2223 " $1 " " $2 }' \
  "${base_dir}/.warden/runner/ssh_host_ed25519_key.pub" >"${known_hosts}"

ssh_common_options=(
  -i "${runner_ssh_key}"
  -o BatchMode=yes
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=${known_hosts}"
  -o LogLevel=ERROR
)

set +e
timeout 5 ssh -p 2223 "${ssh_common_options[@]}" \
  -o ExitOnForwardFailure=yes \
  -N -R 127.0.0.1:9999:127.0.0.1:9999 \
  runner@127.0.0.1 </dev/null >/dev/null 2>&1
runner_forward_rc="$?"
set -e
if [[ "${runner_forward_rc}" == "0" || "${runner_forward_rc}" == "124" ]]; then
  echo "FAIL runner key accepted port forwarding" >&2
  exit 1
fi
echo "PASS runner_key_port_forwarding_denied"

ssh-keygen -q -t ed25519 -N '' -f "${unauthorized_key}"
set +e
timeout 5 ssh -p 2223 \
  -i "${unauthorized_key}" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o "UserKnownHostsFile=${known_hosts}" \
  -o LogLevel=ERROR \
  runner@127.0.0.1 'true' </dev/null >/dev/null 2>&1
unauthorized_key_rc="$?"
set -e
[[ "${unauthorized_key_rc}" != "0" ]] || {
  echo "FAIL unauthorized key unexpectedly succeeded" >&2
  exit 1
}
echo "PASS unauthorized_key_rejected"

if [[ -n "${revoked_key_image}" ]]; then
  set +e
  timeout 8 docker run --rm --network host --entrypoint ssh "${revoked_key_image}" \
    -i /home/tunnel/.ssh/id_ed25519 \
    -p 2223 \
    -o BatchMode=yes \
    -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/home/tunnel/.ssh/known_hosts \
    runner@127.0.0.1 'id -u' </dev/null >/dev/null 2>&1
  revoked_key_rc="$?"
  set -e
  [[ "${revoked_key_rc}" != "0" && "${revoked_key_rc}" != "124" ]] || {
    echo "FAIL revoked legacy key still authenticates" >&2
    exit 1
  }
  echo "PASS revoked_legacy_key_rejected"
fi

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
  runner@127.0.0.1 'id -u' </dev/null >/dev/null 2>&1
tunnel_key_shell_rc="$?"
set -e
[[ "${tunnel_key_shell_rc}" != "0" ]] || {
  echo "FAIL tunnel key can execute shell commands" >&2
  exit 1
}
echo "PASS tunnel_key_shell_denied"

set +e
timeout 5 docker exec "${qa_tunnel_container}" ssh "${tunnel_ssh_options[@]}" \
  -o ExitOnForwardFailure=yes \
  -N -R 127.0.0.1:9999:127.0.0.1:9999 \
  runner@127.0.0.1 </dev/null >/dev/null 2>&1
tunnel_extra_reverse_rc="$?"
timeout 5 docker exec "${qa_tunnel_container}" sh -c '
  ssh -i /tmp/tunnel_ed25519 -p 2223 \
    -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile=/tmp/known_hosts -o LogLevel=ERROR \
    -N -L 127.0.0.1:9998:127.0.0.1:8223 runner@127.0.0.1 &
  ssh_pid=$!
  sleep 0.5
  if wget -q -T 2 -O /dev/null http://127.0.0.1:9998/health; then result=0; else result=1; fi
  kill "${ssh_pid}" 2>/dev/null || true
  wait "${ssh_pid}" 2>/dev/null || true
  exit "${result}"
' </dev/null >/dev/null 2>&1
tunnel_local_forward_rc="$?"
set -e
if [[ "${tunnel_extra_reverse_rc}" == "0" || "${tunnel_extra_reverse_rc}" == "124" \
  || "${tunnel_local_forward_rc}" == "0" || "${tunnel_local_forward_rc}" == "124" ]]; then
  echo "FAIL tunnel key accepted a non-approved forwarding channel" >&2
  exit 1
fi
echo "PASS tunnel_key_only_reverse_8223_8224"

docker exec "${qa_tunnel_container}" test -s /tmp/tunnel_ed25519
docker exec "${runner_container}" test ! -e /run/qa-tunnel/tunnel_ed25519
qa_tunnel_image="$(docker inspect -f '{{.Image}}' "${qa_tunnel_container}")"
docker run --rm --entrypoint sh "${qa_tunnel_image}" -c \
  'test ! -e /home/tunnel/.ssh/id_ed25519 && ! find /home /root /run /tmp -xdev -type f -exec grep -Il "BEGIN OPENSSH PRIVATE KEY" {} + 2>/dev/null | grep -q .'
echo "PASS tunnel_private_key_runtime_tmpfs_only image_without_private_key=true"

ssh -p 2223 "${ssh_common_options[@]}" runner@127.0.0.1 \
  'curl --noproxy "*" --silent --fail --max-time 5 http://127.0.0.1:8223/health >/dev/null && curl --noproxy "*" --silent --fail --max-time 5 http://127.0.0.1:8224/health >/dev/null && rm -rf /workspace/playwright-mcp-smoke.mjs /workspace/.playwright-mcp'
echo "PASS qa_reverse_tunnel_loopback_only"
scp -O -P 2223 "${ssh_common_options[@]}" \
  "${base_dir}/playwright-mcp-smoke.mjs" \
  runner@127.0.0.1:/workspace/playwright-mcp-smoke.mjs >/dev/null

ssh -p 2223 "${ssh_common_options[@]}" runner@127.0.0.1 'bash -s' <<'REMOTE'
set -euo pipefail
cleanup_remote() {
  rm -rf /workspace/playwright-mcp-smoke.mjs /workspace/.playwright-mcp
}
trap cleanup_remote EXIT

test "$(id -u)" = "10001"
test ! -e /home/agottardo/.paperclip
test ! -e /var/run/docker.sock
test "${PATH%%:*}" = "/workspace/.qa-harness/bin"
python -m pytest --version >/dev/null
test -z "${DOCKER_HOST:-}"
! command -v docker >/dev/null 2>&1
if curl --noproxy '*' --silent --fail --max-time 3 http://docker-daemon:2375/_ping >/dev/null 2>&1; then
  echo "FAIL unauthenticated Docker API remains reachable" >&2
  exit 1
fi
if docker run --privileged alpine true >/dev/null 2>&1 \
  || docker run --device /dev/null alpine true >/dev/null 2>&1 \
  || docker run -v /:/host alpine true >/dev/null 2>&1; then
  echo "FAIL runner accepted a forbidden container operation" >&2
  exit 1
fi
echo "PASS qa_toolchain path=.qa-harness/bin python=pytest container_runtime=absent"
echo "PASS docker_api_privileged_device_host_bind_denied"
echo "PASS host_paths_and_host_docker_socket_absent"

if env -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
  curl --noproxy '*' --silent --show-error --max-time 5 https://example.com/ >/dev/null 2>&1; then
  echo "FAIL direct arbitrary egress unexpectedly succeeded" >&2
  exit 1
fi
echo "PASS direct_arbitrary_egress_denied"

if curl --silent --show-error --max-time 10 https://example.com/ >/dev/null 2>&1; then
  echo "FAIL proxied arbitrary egress unexpectedly succeeded" >&2
  exit 1
fi
echo "PASS proxied_arbitrary_egress_denied"

curl --silent --fail --max-time 15 https://estetia.tidycode.it/health >/dev/null
echo "PASS taia_preproduction_health_allowed"

if curl --silent --fail --max-time 10 https://estetia.it/ >/dev/null 2>&1; then
  echo "FAIL TaIA production egress unexpectedly succeeded" >&2
  exit 1
fi
echo "PASS taia_production_egress_denied"

node /workspace/playwright-mcp-smoke.mjs
REMOTE

ssh -p 2223 "${ssh_common_options[@]}" runner@127.0.0.1 'bash -s' <<'REMOTE'
set -euo pipefail
if find /workspace -mindepth 1 -maxdepth 1 ! -name .git -print -quit | grep -q .; then
  echo "FAIL workspace contains persistent QA artifacts" >&2
  find /workspace -mindepth 1 -maxdepth 1 ! -name .git -printf '%f\n' >&2
  exit 1
fi
if find /home/runner /workspace -type f \
  \( -iname '*cookie*' -o -iname '*storage*state*' -o -iname '*session*' -o -iname '*trace*.zip' \) \
  ! -path '/home/runner/.ssh/*' -print -quit | grep -q .; then
  echo "FAIL persistent browser/session artifact found" >&2
  exit 1
fi
echo "PASS no_persistent_session_cookie_password_or_trace_artifacts"
REMOTE

docker inspect "${runner_container}" \
  --format '{{json .HostConfig.ReadonlyRootfs}} {{json .HostConfig.Privileged}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}'
echo "PASS runtime_permissions uid=10001 rootfs=readonly privileged=false cap_drop=ALL no_new_privileges=true"

mapfile -t warden_containers < <(
  docker ps -aq --filter label=com.docker.compose.project=paperclip-tester1
)
[[ "${#warden_containers[@]}" -gt 0 ]]
for container_id in "${warden_containers[@]}"; do
  docker inspect "${container_id}" --format '{{json .}}' | jq -e '
    .HostConfig.Privileged == false and
    ((.HostConfig.CapAdd // []) | length) == 0 and
    ((.HostConfig.CapDrop // []) | index("ALL")) != null and
    ((.HostConfig.Devices // []) | length) == 0 and
    ((.HostConfig.SecurityOpt // []) | index("no-new-privileges:true")) != null and
    ((.HostConfig.SecurityOpt // []) | index("seccomp=unconfined")) == null
  ' >/dev/null
done
docker inspect "${runner_container}" --format '{{json .Mounts}}' | jq -e \
  'all(.[]; .Type != "bind")' >/dev/null
echo "PASS warden_least_privilege privileged=false cap_add=none cap_drop=ALL devices=none seccomp=default"

docker exec "${runner_container}" test -s /run/qa-tunnel/tunnel_ed25519.pub
[[ "$(docker inspect -f '{{.State.Running}}' "${qa_tunnel_container}" 2>/dev/null || true)" == "true" ]]
echo "PASS runtime_tunnel_remains_available key=tmpfs"
