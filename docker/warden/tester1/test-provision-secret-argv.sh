#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly TEMP_ROOT="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/tester1-provision-test.XXXXXX")"
readonly BOARD_SENTINEL='board-token-sentinel-7f31'
readonly KEY_SENTINEL='runner-private-key-sentinel-8c42'
readonly SECRET_ID='11111111-1111-4111-8111-111111111111'
readonly ENVIRONMENT_ID='22222222-2222-4222-8222-222222222222'

cleanup() {
  rm -rf -- "${TEMP_ROOT}"
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mkdir -p "${TEMP_ROOT}/bin"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'for arg in "$@"; do' \
  '  [[ "${arg}" != *"${BOARD_SENTINEL}"* ]] || exit 97' \
  '  [[ "${arg}" != *"${KEY_SENTINEL}"* ]] || exit 98' \
  'done' \
  '[[ -z "${PAPERCLIP_API_KEY:-}" ]] || exit 99' \
  '[[ "${PAPERCLIP_TESTER1_BOARD_KEY:-}" == "${BOARD_SENTINEL}" ]] || exit 96' \
  'printf "CALL %s:%s\n" "${1:-}" "${2:-}" >>"${FAKE_ARG_LOG}"' \
  'for arg in "$@"; do printf "ARG %s\n" "${arg}" >>"${FAKE_ARG_LOG}"; done' \
  'case "${1:-}:${2:-}" in' \
  '  health:--json) printf '\''{"status":"ok","authReady":true}\n'\'' ;;' \
  '  whoami:--json) printf '\''{"actorType":"user"}\n'\'' ;;' \
  '  environment:list)' \
  '    if [[ "${FAKE_ENVIRONMENT_EXISTS:-0}" == "1" ]]; then' \
  '      printf '\''[{"id":"%s","name":"Tester1 Warden"}]\n'\'' "${ENVIRONMENT_ID}"' \
  '    else' \
  '      printf '\''[]\n'\''' \
  '    fi' \
  '    ;;' \
  '  environment:get)' \
  '    jq -cn --arg id "${ENVIRONMENT_ID}" --arg secretId "${SECRET_ID}" '\''' \
  '      {id:$id,driver:"ssh",status:"active",config:{host:"127.0.0.1",port:2223,username:"runner",remoteWorkspacePath:"/workspace",privateKey:null,privateKeySecretRef:{type:"secret_ref",secretId:$secretId,version:"latest"},strictHostKeyChecking:true}}'\''' \
  '    ;;' \
  '  secrets:create)' \
  '    [[ "${TESTER1_RUNNER_KEY_VALUE:-}" == "${KEY_SENTINEL}" ]] || exit 95' \
  '    jq -cn --arg id "${SECRET_ID}" '\''{id:$id}'\''' \
  '    ;;' \
  '  secrets:rotate)' \
  '    [[ "${TESTER1_RUNNER_KEY_VALUE:-}" == "${KEY_SENTINEL}" ]] || exit 94' \
  '    printf '\''{"ok":true}\n'\''' \
  '    ;;' \
  '  environment:create)' \
  '    payload=""' \
  '    while [[ "$#" -gt 0 ]]; do' \
  '      if [[ "$1" == "--payload-json" ]]; then payload="$2"; break; fi' \
  '      shift' \
  '    done' \
  '    jq -e --arg secretId "${SECRET_ID}" '\''.config.privateKeySecretRef == {type:"secret_ref",secretId:$secretId,version:"latest"} and (.config | has("privateKey") | not)'\'' <<<"${payload}" >/dev/null || exit 93' \
  '    jq -cn --arg id "${ENVIRONMENT_ID}" '\''{id:$id}'\''' \
  '    ;;' \
  '  environment:probe) printf '\''{"ok":true,"driver":"ssh"}\n'\'' ;;' \
  '  agent:update) printf '\''{"ok":true}\n'\'' ;;' \
  '  agent:get) jq -cn --arg id "${ENVIRONMENT_ID}" '\''{defaultEnvironmentId:$id}'\'' ;;' \
  '  agent:list) printf '\''[]\n'\'' ;;' \
  '  agent:configuration) printf '\''{"adapterType":"codex_local","adapterConfig":{}}\n'\'' ;;' \
  '  adapter:test-environment) printf '\''{"status":"pass","checks":[{"code":"codex_hello_probe_passed"}]}\n'\'' ;;' \
  '  *) exit 92 ;;' \
  'esac' >"${TEMP_ROOT}/bin/paperclipai"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${1:-}" == "inspect" && "${2:-}" == "-f" ]]; then printf '\''true\n'\''; exit 0; fi' \
  'if [[ "${1:-}" == "inspect" ]]; then exit 1; fi' \
  'if [[ "${1:-}" == "exec" && "$*" == *"authorized_keys"* ]]; then' \
  '  printf '\''restrict ssh-ed25519 AAAARUNNER fixture\n'\''' \
  '  exit 0' \
  'fi' \
  'if [[ "${1:-}" == "exec" && "$*" == *"ssh_host_ed25519_key.pub"* ]]; then' \
  '  printf '\''ssh-ed25519 AAAAHOST fixture\n'\''' \
  '  exit 0' \
  'fi' \
  'exit 91' >"${TEMP_ROOT}/bin/docker"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'printf '\''[127.0.0.1]:2223 ssh-ed25519 AAAAHOST\n'\''' \
  >"${TEMP_ROOT}/bin/ssh-keyscan"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${1:-}" == "-y" ]]; then printf '\''ssh-ed25519 AAAARUNNER\n'\''; exit 0; fi' \
  'if [[ "${1:-}" == "-lf" && "${2:-}" == "-" ]]; then' \
  '  input="$(</dev/stdin)"' \
  '  if [[ "${input}" == *"AAAAHOST"* ]]; then' \
  '    printf '\''256 SHA256:host fixture (ED25519)\n'\''' \
  '  else' \
  '    printf '\''256 SHA256:runner fixture (ED25519)\n'\''' \
  '  fi' \
  '  exit 0' \
  'fi' \
  'exit 90' >"${TEMP_ROOT}/bin/ssh-keygen"

chmod 0755 "${TEMP_ROOT}/bin/"*
printf '%s\n' "${KEY_SENTINEL}" >"${TEMP_ROOT}/runner-key"
chmod 0600 "${TEMP_ROOT}/runner-key"
touch "${TEMP_ROOT}/argv.log"

run_env=(
  PATH="${TEMP_ROOT}/bin:${PATH}"
  BOARD_SENTINEL="${BOARD_SENTINEL}"
  KEY_SENTINEL="${KEY_SENTINEL}"
  SECRET_ID="${SECRET_ID}"
  ENVIRONMENT_ID="${ENVIRONMENT_ID}"
  FAKE_ARG_LOG="${TEMP_ROOT}/argv.log"
  PAPERCLIP_API_KEY='ambient-run-token'
  PAPERCLIP_BOARD_API_URL='https://paperclip.example.test'
  PAPERCLIP_BOARD_PROFILE='tester1-provision'
  PAPERCLIP_TESTER1_BOARD_KEY="${BOARD_SENTINEL}"
  RUNNER_SSH_KEY_FILE="${TEMP_ROOT}/runner-key"
)

if output="$(env "${run_env[@]}" PAPERCLIP_BOARD_API_KEY="${BOARD_SENTINEL}" \
  "${ROOT_DIR}/provision-paperclip.sh" 2>&1)"; then
  fail "Provisioning accepted PAPERCLIP_BOARD_API_KEY."
fi
grep -q 'PAPERCLIP_BOARD_API_KEY is forbidden' <<<"${output}" \
  || fail "Literal board token was rejected for an unexpected reason: ${output}"
[[ ! -s "${TEMP_ROOT}/argv.log" ]] \
  || fail "Provisioning invoked Paperclip before rejecting the literal board token."

env "${run_env[@]}" "${ROOT_DIR}/provision-paperclip.sh" >/dev/null
env "${run_env[@]}" FAKE_ENVIRONMENT_EXISTS=1 ROTATE_RUNNER_KEY=1 \
  "${ROOT_DIR}/provision-paperclip.sh" >/dev/null

[[ "$(grep -c '^CALL secrets:create$' "${TEMP_ROOT}/argv.log")" == "1" ]] \
  || fail "Provisioning did not create the runner secret exactly once."
[[ "$(grep -c '^CALL secrets:rotate$' "${TEMP_ROOT}/argv.log")" == "1" ]] \
  || fail "Provisioning did not rotate the runner secret exactly once."
[[ "$(grep -c '^ARG --value-env$' "${TEMP_ROOT}/argv.log")" == "2" ]] \
  || fail "Secret create and rotate must both use --value-env."
if grep -Fq -- '--api-key' "${TEMP_ROOT}/argv.log"; then
  fail "Provisioning passed a board key through argv."
fi
if grep -Fq "${BOARD_SENTINEL}" "${TEMP_ROOT}/argv.log" \
  || grep -Fq "${KEY_SENTINEL}" "${TEMP_ROOT}/argv.log"; then
  fail "Provisioning exposed a sentinel secret through argv."
fi

printf 'PASS: board and runner secrets stay out of provisioning argv.\n'
