#!/usr/bin/env bash
set -euo pipefail

readonly COMPANY_ID="2c63b918-ab4c-4d8f-9928-140930d9dc71"
readonly TESTER1_ID="57fce968-55e1-4abd-b04b-233032d5b8c0"
readonly ENVIRONMENT_NAME="Tester1 Warden"
readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SHARED_DIR="$(cd -- "${ROOT_DIR}/../.." && pwd -P)"
readonly RUNNER_KEY_FILE="${RUNNER_SSH_KEY_FILE:-}"
readonly ROTATE_RUNNER_KEY="${ROTATE_RUNNER_KEY:-0}"
readonly INSTANCE_ROOT="$(cd -- "${ROOT_DIR}/../../../../.." && pwd -P)"
readonly INSTANCE_CONFIG_PATH="${PAPERCLIP_CONFIG_PATH:-${INSTANCE_ROOT}/config.json}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

validate_runtime_key() {
  local authorized_key
  local authorized_fingerprint
  local key_path
  local runtime_fingerprint

  [[ -n "${RUNNER_KEY_FILE}" && -s "${RUNNER_KEY_FILE}" ]] \
    || fail "RUNNER_SSH_KEY_FILE must point to a runtime-supplied private key."
  [[ "$(stat -c '%a' "${RUNNER_KEY_FILE}")" == "600" ]] \
    || fail "Runtime private key must have mode 0600."

  key_path="$(readlink -f "${RUNNER_KEY_FILE}")"
  case "${key_path}" in
    "${SHARED_DIR}"/*)
      fail "Runtime private key must not live under ${SHARED_DIR}."
      ;;
  esac

  runtime_fingerprint="$(ssh-keygen -y -f "${RUNNER_KEY_FILE}" | ssh-keygen -lf - | awk '{print $2}')"
  authorized_key="$(docker exec paperclip-tester1-runner-1 \
    sed -nE 's/^.*(ssh-ed25519 [^ ]+).*$/\1/p' /home/runner/.ssh/authorized_keys)"
  [[ -n "${authorized_key}" ]] || fail "Running Warden has no authorized runner key."
  authorized_fingerprint="$(printf '%s\n' "${authorized_key}" | ssh-keygen -lf - | awk '{print $2}')"
  [[ "${runtime_fingerprint}" == "${authorized_fingerprint}" ]] \
    || fail "Runtime key does not match the runner authorized key."
}

resolve_api_base() {
  local candidate="${PAPERCLIP_BOARD_API_URL:-${PAPERCLIP_API_URL:-}}"

  if [[ -n "${candidate}" && ! "${candidate}" =~ ^https?://[^[:space:]]+$ ]]; then
    printf 'Ignoring malformed PAPERCLIP_API_URL=%q; falling back to the instance config.\n' \
      "${candidate}" >&2
    candidate=""
  fi

  if [[ -z "${candidate}" && -r "${INSTANCE_CONFIG_PATH}" ]]; then
    candidate="$(jq -r '.auth.publicBaseUrl // empty' "${INSTANCE_CONFIG_PATH}")"
  fi

  [[ "${candidate}" =~ ^https?://[^[:space:]]+$ ]] \
    || fail "Set PAPERCLIP_BOARD_API_URL to an absolute http(s) control-plane URL."

  candidate="${candidate%/}"
  candidate="${candidate%/api}"
  printf '%s\n' "${candidate}"
}

api_base="$(resolve_api_base)"

[[ -z "${PAPERCLIP_BOARD_API_KEY:-}" ]] \
  || fail "PAPERCLIP_BOARD_API_KEY is forbidden; use PAPERCLIP_BOARD_PROFILE."
[[ -n "${PAPERCLIP_BOARD_PROFILE:-}" ]] \
  || fail "Set PAPERCLIP_BOARD_PROFILE to an authenticated board instance-admin profile."

cli_args=(--api-base "${api_base}" --profile "${PAPERCLIP_BOARD_PROFILE}")

paperclip_cli() {
  env -u PAPERCLIP_API_KEY paperclipai "$@"
}

health="$(paperclip_cli health --json "${cli_args[@]}")"
jq -e '.status == "ok" and .authReady == true' <<<"${health}" >/dev/null \
  || fail "Paperclip health preflight failed for ${api_base}."

if ! paperclip_cli whoami --json "${cli_args[@]}" >/dev/null; then
  fail "Authenticate a board instance-admin CLI profile, then set PAPERCLIP_BOARD_PROFILE."
fi

[[ "${ROTATE_RUNNER_KEY}" == "0" || "${ROTATE_RUNNER_KEY}" == "1" ]] \
  || fail "ROTATE_RUNNER_KEY must be 0 or 1."

for container in \
  paperclip-tester1-runner-1 \
  paperclip-tester1-egress-proxy-1 \
  paperclip-tester1-ssh-proxy-1; do
  [[ "$(docker inspect -f '{{.State.Running}}' "${container}" 2>/dev/null)" == "true" ]] \
    || fail "Warden container ${container} is not running."
done

if docker inspect paperclip-tester1-docker-daemon-1 >/dev/null 2>&1; then
  fail "Legacy privileged Docker daemon still exists; remove the orphan before assigning Tester1."
fi
if [[ "${ROTATE_RUNNER_KEY}" == "1" ]]; then
  validate_runtime_key
fi

known_hosts="$(ssh-keyscan -p 2223 -t ed25519 127.0.0.1 2>/dev/null | awk 'NF == 3 { print; exit }')"
[[ -n "${known_hosts}" ]] || fail "Could not read the Warden SSH host key."

expected_host_key="$(docker exec paperclip-tester1-runner-1 \
  sed -n '1p' /home/runner/.ssh/ssh_host_ed25519_key.pub)"
[[ -n "${expected_host_key}" ]] || fail "Running Warden has no SSH host public key."
expected_fingerprint="$(printf '%s\n' "${expected_host_key}" | ssh-keygen -lf - | awk '{print $2}')"
scanned_fingerprint="$(printf '%s\n' "${known_hosts}" | ssh-keygen -lf - | awk '{print $2}')"
[[ "${expected_fingerprint}" == "${scanned_fingerprint}" ]] \
  || fail "Warden SSH host-key fingerprint mismatch."

environment_list="$(paperclip_cli environment list \
  --company-id "${COMPANY_ID}" \
  --json \
  "${cli_args[@]}")"

match_count="$(jq --arg name "${ENVIRONMENT_NAME}" '[.[] | select(.name == $name)] | length' <<<"${environment_list}")"
[[ "${match_count}" -le 1 ]] || fail "Multiple environments named ${ENVIRONMENT_NAME} exist."

if [[ "${match_count}" == "1" ]]; then
  environment_id="$(jq -r --arg name "${ENVIRONMENT_NAME}" '.[] | select(.name == $name) | .id' <<<"${environment_list}")"
  saved_environment="$(paperclip_cli environment get "${environment_id}" --json "${cli_args[@]}")"
  jq -e '
    .driver == "ssh" and
    .status == "active" and
    .config.host == "127.0.0.1" and
    .config.port == 2223 and
    .config.username == "runner" and
    .config.remoteWorkspacePath == "/workspace" and
    .config.privateKey == null and
    .config.privateKeySecretRef.type == "secret_ref" and
    (.config.privateKeySecretRef.secretId | type) == "string" and
    .config.strictHostKeyChecking == true
  ' <<<"${saved_environment}" >/dev/null \
    || fail "Existing environment ${environment_id} does not match the Warden contract."

  if [[ "${ROTATE_RUNNER_KEY}" == "1" ]]; then
    secret_id="$(jq -er '.config.privateKeySecretRef.secretId' <<<"${saved_environment}")"
    TESTER1_RUNNER_KEY_VALUE="$(<"${RUNNER_KEY_FILE}")" \
      paperclip_cli secrets rotate "${secret_id}" \
        --value-env TESTER1_RUNNER_KEY_VALUE \
        --json \
        "${cli_args[@]}" >/dev/null
  fi
else
  validate_runtime_key
  created_secret="$(TESTER1_RUNNER_KEY_VALUE="$(<"${RUNNER_KEY_FILE}")" \
    paperclip_cli secrets create \
      --company-id "${COMPANY_ID}" \
      --name "Tester1 Warden runner SSH key ${BASHPID}" \
      --description "Runtime private key for the Tester1 Warden SSH environment." \
      --value-env TESTER1_RUNNER_KEY_VALUE \
      --json \
      "${cli_args[@]}")"
  secret_id="$(jq -er '.id' <<<"${created_secret}")"
  payload="$(jq -n \
    --arg secretId "${secret_id}" \
    --arg knownHosts "${known_hosts}" \
    '{
      name: "Tester1 Warden",
      description: "Dedicated Warden-isolated SSH runtime for Tester1 only (GOT-1714).",
      driver: "ssh",
      status: "active",
      config: {
        host: "127.0.0.1",
        port: 2223,
        username: "runner",
        remoteWorkspacePath: "/workspace",
        privateKeySecretRef: {
          type: "secret_ref",
          secretId: $secretId,
          version: "latest"
        },
        knownHosts: $knownHosts,
        strictHostKeyChecking: true
      },
      envVars: {},
      metadata: {
        managedBy: "GOT-1714",
        scope: "tester1",
        wardenEnvironment: "paperclip-tester1"
      }
    }')"
  created="$(paperclip_cli environment create \
    --company-id "${COMPANY_ID}" \
    --payload-json "${payload}" \
    --json \
    "${cli_args[@]}")"
  environment_id="$(jq -er '.id' <<<"${created}")"
fi

saved_environment="$(paperclip_cli environment get "${environment_id}" --json "${cli_args[@]}")"
jq -e '
  .config.privateKey == null and
  .config.privateKeySecretRef.type == "secret_ref" and
  (.config.privateKeySecretRef.secretId | type) == "string"
' <<<"${saved_environment}" >/dev/null \
  || fail "Runner private key is not backed by a Paperclip secret reference."

probe="$(paperclip_cli environment probe "${environment_id}" --json "${cli_args[@]}")"
jq -e '.ok == true and .driver == "ssh"' <<<"${probe}" >/dev/null \
  || fail "Paperclip environment probe failed for ${environment_id}."

paperclip_cli agent update "${TESTER1_ID}" \
  --payload-json "$(jq -cn --arg id "${environment_id}" '{defaultEnvironmentId:$id}')" \
  --json \
  "${cli_args[@]}" >/dev/null

tester1="$(paperclip_cli agent get "${TESTER1_ID}" --json "${cli_args[@]}")"
[[ "$(jq -r '.defaultEnvironmentId // ""' <<<"${tester1}")" == "${environment_id}" ]] \
  || fail "Tester1 defaultEnvironmentId was not updated."

agents="$(paperclip_cli agent list --company-id "${COMPANY_ID}" --json "${cli_args[@]}")"
other_assignments="$(jq --arg id "${environment_id}" --arg tester "${TESTER1_ID}" \
  '[.[] | select(.defaultEnvironmentId == $id and .id != $tester)] | length' <<<"${agents}")"
[[ "${other_assignments}" == "0" ]] \
  || fail "The Warden environment is assigned to an agent other than Tester1."

tester1_configuration="$(paperclip_cli agent configuration "${TESTER1_ID}" \
  --json \
  "${cli_args[@]}")"
jq -e '.adapterType == "codex_local"' <<<"${tester1_configuration}" >/dev/null \
  || fail "Tester1 must use the codex_local adapter."

adapter_config="$(jq -c '.adapterConfig // {}' <<<"${tester1_configuration}")"
adapter_test_payload="$(jq -n \
  --arg environmentId "${environment_id}" \
  --argjson adapterConfig "${adapter_config}" \
  '{environmentId:$environmentId, adapterConfig:$adapterConfig}')"
adapter_test="$(paperclip_cli adapter test-environment codex_local \
  --company-id "${COMPANY_ID}" \
  --payload-json "${adapter_test_payload}" \
  --json \
  "${cli_args[@]}")"
jq -e '
  .status == "pass" and
  any(.checks[]?; .code == "codex_hello_probe_passed")
' <<<"${adapter_test}" >/dev/null \
  || fail "Tester1 codex_local adapter test failed inside the Warden environment."

printf 'environmentId=%s\n' "${environment_id}"
printf 'apiBase=%s\n' "${api_base}"
printf 'probe.ok=true\n'
printf 'adapterTest.status=pass\n'
printf 'tester1.defaultEnvironmentId=%s\n' "${environment_id}"
printf 'otherAgentAssignments=0\n'
printf 'runnerSecretRef=true\n'
