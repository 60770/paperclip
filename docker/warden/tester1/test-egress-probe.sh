#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly PROBE="${ROOT_DIR}/.warden/runner/verify-egress-denied.sh"
readonly RUNNER_DOCKERFILE="${ROOT_DIR}/.warden/runner/Dockerfile"
readonly BOUNDARY_VERIFY="${ROOT_DIR}/verify-no-docker-boundary.sh"
readonly TEMP_ROOT="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/tester1-egress-probe.XXXXXX")"

cleanup() {
  rm -rf -- "${TEMP_ROOT}"
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mkdir -p "${TEMP_ROOT}/bin"
cat >"${TEMP_ROOT}/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >>"${FAKE_CURL_LOG}"
printf '%s' "${FAKE_HTTP_CODE}"
exit "${FAKE_CURL_RC}"
SH
chmod 0755 "${TEMP_ROOT}/bin/curl"

curl_log="${TEMP_ROOT}/curl.log"
if PATH="${TEMP_ROOT}/bin:${PATH}" \
  FAKE_CURL_LOG="${curl_log}" \
  FAKE_HTTP_CODE=401 \
  FAKE_CURL_RC=0 \
  "${PROBE}" --max-time 10 https://registry-1.docker.io/v2/ >/dev/null 2>&1; then
  fail "HTTP 401 was classified as denied egress."
fi
printf 'PASS: reachable HTTP 401 is not a deny result.\n'

PATH="${TEMP_ROOT}/bin:${PATH}" \
FAKE_CURL_LOG="${curl_log}" \
FAKE_HTTP_CODE=000 \
FAKE_CURL_RC=56 \
  "${PROBE}" --max-time 10 https://registry-1.docker.io/v2/
printf 'PASS: transport failure before HTTP is a deny result.\n'

if grep -Fq -- '--fail' "${curl_log}"; then
  fail "Reachability probe must not convert HTTP errors into transport failures."
fi
grep -Fq 'COPY verify-egress-denied.sh /usr/local/bin/verify-egress-denied' "${RUNNER_DOCKERFILE}" \
  || fail "Runner image does not install the reachability probe."
[[ "$(grep -c 'verify-egress-denied --' "${BOUNDARY_VERIFY}")" == "3" ]] \
  || fail "Boundary verifier does not route all negative HTTP probes through the reachability helper."

printf 'PASS: egress reachability regression guard.\n'
