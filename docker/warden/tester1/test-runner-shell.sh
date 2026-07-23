#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RUNNER_SHELL="${ROOT_DIR}/.warden/runner/runner-shell.sh"
readonly BOUNDARY_SMOKE="${ROOT_DIR}/verify-playwright-boundary.sh"
readonly TEMP_ROOT="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/tester1-runner-shell.XXXXXX")"

cleanup() {
  rm -rf -- "${TEMP_ROOT}"
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mkdir -p "${TEMP_ROOT}/bin"
cat >"${TEMP_ROOT}/bin/scp" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >"${FAKE_SCP_LOG}"
SH
chmod 0755 "${TEMP_ROOT}/bin/scp"

scp_log="${TEMP_ROOT}/scp.log"
PATH="${TEMP_ROOT}/bin:${PATH}" \
FAKE_SCP_LOG="${scp_log}" \
SSH_ORIGINAL_COMMAND='scp -t /workspace/playwright-mcp-smoke.mjs' \
  "${RUNNER_SHELL}"

grep -qx -- '-t /workspace/playwright-mcp-smoke.mjs' "${scp_log}" \
  || fail "Forced runner shell did not execute the legacy SCP sink."
grep -Fq 'scp -O -P 2223 "${ssh_common_options[@]}" \' "${BOUNDARY_SMOKE}" \
  || fail "Boundary smoke does not force the legacy SCP protocol."

printf 'PASS: legacy SCP reaches the forced runner shell.\n'
