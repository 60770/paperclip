#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly TEMP_ROOT="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/tester1-attestation-test.XXXXXX")"

cleanup() {
  rm -rf -- "${TEMP_ROOT}"
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

mkdir -p "${TEMP_ROOT}/repo/docker/warden" "${TEMP_ROOT}/live"
cp -a "${ROOT_DIR}" "${TEMP_ROOT}/repo/docker/warden/tester1"
canonical_dir="${TEMP_ROOT}/repo/docker/warden/tester1"
printf 'root: <WARDEN_ROOT>\nenvironment: paperclip-tester1\n' \
  | sha256sum \
  | awk '{print $1}' >"${canonical_dir}/attestation/rendered-config.sha256"
(
  cd -- "${canonical_dir}"
  find . -type f ! -path './attestation/source-manifest.sha256' -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) | sed 's#  \./#  #' >"${TEMP_ROOT}/source-manifest.sha256"
mv "${TEMP_ROOT}/source-manifest.sha256" "${canonical_dir}/attestation/source-manifest.sha256"
git -C "${TEMP_ROOT}/repo" init -q
git -C "${TEMP_ROOT}/repo" add docker/warden/tester1
git -C "${TEMP_ROOT}/repo" \
  -c user.name='Attestation Test' \
  -c user.email='attestation-test@example.invalid' \
  commit -qm 'test fixture'
"${canonical_dir}/verify-attestation.sh" \
  --canonical-dir "${canonical_dir}" \
  --source-only >/dev/null

prepare_live() {
  rm -rf -- "${TEMP_ROOT}/live"
  mkdir -p "${TEMP_ROOT}/live"
  cp -a "${canonical_dir}/." "${TEMP_ROOT}/live/"
  printf 'WARDEN_ENV_NAME=paperclip-tester1\n' >"${TEMP_ROOT}/live/.env"
  touch "${TEMP_ROOT}/live/.writetest"
  printf 'ssh-ed25519 AAAATEST runtime\n' >"${TEMP_ROOT}/live/.warden/runner/authorized_keys"
  printf 'runtime-private-key\n' >"${TEMP_ROOT}/live/.warden/runner/ssh_host_ed25519_key"
  printf 'ssh-ed25519 AAAAHOST runtime\n' >"${TEMP_ROOT}/live/.warden/runner/ssh_host_ed25519_key.pub"
  chmod 0600 "${TEMP_ROOT}/live/.warden/runner/ssh_host_ed25519_key"
  rm -f "${TEMP_ROOT}/warden-rendered" "${TEMP_ROOT}/warden-build-invoked"
}

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${1:-}" == "env" && "${2:-}" == "config" ]]; then' \
  '  touch "${FAKE_RENDER_MARKER}"' \
  '  environment="$(awk -F= '\''$1 == "WARDEN_ENV_NAME" { print $2 }'\'' .env)"' \
  '  printf '\''root: %s\nenvironment: %s\n'\'' "$(pwd -P)" "${environment}"' \
  '  exit 0' \
  'fi' \
  'touch "${FAKE_BUILD_MARKER}"' \
  'exit 0' >"${TEMP_ROOT}/fake-warden"
chmod 0755 "${TEMP_ROOT}/fake-warden"

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'if [[ "${1:-}" == "ps" ]]; then' \
  '  printf '\''c1\nc2\nc3\nc4\n'\''' \
  '  exit 0' \
  'fi' \
  'if [[ "${1:-}" == "inspect" ]]; then' \
  '  case "${4}" in c1) service=egress-proxy ;; c2) service=qa-tunnel ;; c3) service=runner ;; c4) service=ssh-proxy ;; esac' \
  '  if [[ "${3}" == *compose.service* ]]; then printf '\''%s\n'\'' "${service}"; else printf '\''image-%s\n'\'' "${service}"; fi' \
  '  exit 0' \
  'fi' \
  'if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then' \
  '  image_id="${5}"' \
  '  if [[ "${4}" == *source-manifest* ]]; then' \
  '    if [[ "${image_id}" == "image-${FAKE_BAD_IMAGE_SERVICE:-}" ]]; then printf '\''%064d\n'\'' 0; else printf '\''%s\n'\'' "${FAKE_SOURCE_SHA256}"; fi' \
  '  else' \
  '    printf '\''%s\n'\'' "${FAKE_RENDERED_SHA256}"' \
  '  fi' \
  '  exit 0' \
  'fi' \
  'exit 64' >"${TEMP_ROOT}/fake-docker"
chmod 0755 "${TEMP_ROOT}/fake-docker"

run_env=(
  WARDEN_BIN="${TEMP_ROOT}/fake-warden"
  FAKE_RENDER_MARKER="${TEMP_ROOT}/warden-rendered"
  FAKE_BUILD_MARKER="${TEMP_ROOT}/warden-build-invoked"
)

prepare_live
source_sha256="$(sha256sum "${canonical_dir}/attestation/source-manifest.sha256" | awk '{print $1}')"
rendered_sha256="$(tr -d '[:space:]' <"${canonical_dir}/attestation/rendered-config.sha256")"
env "${run_env[@]}" \
  DOCKER_BIN="${TEMP_ROOT}/fake-docker" \
  FAKE_SOURCE_SHA256="${source_sha256}" \
  FAKE_RENDERED_SHA256="${rendered_sha256}" \
  "${canonical_dir}/verify-attestation.sh" \
    --canonical-dir "${canonical_dir}" \
    --live-dir "${TEMP_ROOT}/live" \
    --post-build >/dev/null
printf 'PASS: source, rendered config, and image-label chain.\n'

if output="$(env "${run_env[@]}" \
  DOCKER_BIN="${TEMP_ROOT}/fake-docker" \
  FAKE_SOURCE_SHA256="${source_sha256}" \
  FAKE_RENDERED_SHA256="${rendered_sha256}" \
  FAKE_BAD_IMAGE_SERVICE=runner \
  "${canonical_dir}/verify-attestation.sh" \
    --canonical-dir "${canonical_dir}" \
    --live-dir "${TEMP_ROOT}/live" \
    --post-build 2>&1)"; then
  fail "Gate accepted a mismatched image label."
fi
grep -q 'Image source-manifest label mismatch for runner' <<<"${output}" \
  || fail "Image-label mismatch failed for an unexpected reason: ${output}"
printf 'PASS: postbuild gate rejects mismatched image labels.\n'

expect_prebuild_rejection() {
  local label="$1"
  local output
  if output="$(env "${run_env[@]}" \
    "${canonical_dir}/rebuild-attested.sh" --live-dir "${TEMP_ROOT}/live" 2>&1)"; then
    fail "Gate accepted ${label}."
  fi
  grep -q 'Live source does not match the Git-tracked manifest' <<<"${output}" \
    || fail "Gate rejected ${label} for an unexpected reason: ${output}"
  [[ ! -e "${TEMP_ROOT}/warden-rendered" && ! -e "${TEMP_ROOT}/warden-build-invoked" ]] \
    || fail "Warden was invoked after ${label} drift."
  printf 'PASS: prebuild gate rejects %s before Warden invocation.\n' "${label}"
}

prepare_live
printf '\n# mutation\n' >>"${TEMP_ROOT}/live/verify-no-docker-boundary.sh"
expect_prebuild_rejection 'verifier drift'

prepare_live
printf '\n# mutation\n' >>"${TEMP_ROOT}/live/.warden/warden-env.yml"
expect_prebuild_rejection 'config drift'

prepare_live
printf 'WARDEN_ENV_NAME=changed-environment\n' >"${TEMP_ROOT}/live/.env"
if output="$(env "${run_env[@]}" \
  "${canonical_dir}/rebuild-attested.sh" --live-dir "${TEMP_ROOT}/live" 2>&1)"; then
  fail "Gate accepted rendered config drift."
fi
grep -q 'Rendered Warden config does not match the Git-tracked hash' <<<"${output}" \
  || fail "Rendered config drift failed for an unexpected reason: ${output}"
[[ -e "${TEMP_ROOT}/warden-rendered" && ! -e "${TEMP_ROOT}/warden-build-invoked" ]] \
  || fail "Rendered config drift was not stopped before rebuild."
printf 'PASS: rendered config drift is rejected before rebuild.\n'

printf 'PASS: attestation regression gate.\n'
