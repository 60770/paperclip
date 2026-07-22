#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly TEMP_ROOT="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/tester1-attestation-test.XXXXXX")"

cleanup() {
  chmod -R u+w "${TEMP_ROOT}" 2>/dev/null || true
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
fixture_commit="$(git -C "${TEMP_ROOT}/repo" rev-parse HEAD)"
"${canonical_dir}/verify-attestation.sh" \
  --canonical-dir "${canonical_dir}" \
  --source-only >/dev/null

prepare_live() {
  rm -rf -- "${TEMP_ROOT}/live"
  mkdir -p "${TEMP_ROOT}/live"
  cp -a "${canonical_dir}/." "${TEMP_ROOT}/live/"
  printf 'WARDEN_ENV_NAME=paperclip-tester1\nWARDEN_ENV_TYPE=local\n' >"${TEMP_ROOT}/live/.env"
  touch "${TEMP_ROOT}/live/.writetest"
  printf 'ssh-ed25519 AAAATEST runtime\n' >"${TEMP_ROOT}/live/.warden/runner/authorized_keys"
  printf 'runtime-private-key\n' >"${TEMP_ROOT}/live/.warden/runner/ssh_host_ed25519_key"
  printf 'ssh-ed25519 AAAAHOST runtime\n' >"${TEMP_ROOT}/live/.warden/runner/ssh_host_ed25519_key.pub"
  chmod 0600 "${TEMP_ROOT}/live/.env" "${TEMP_ROOT}/live/.warden/runner/ssh_host_ed25519_key"
  chmod 0644 "${TEMP_ROOT}/live/.warden/runner/authorized_keys" "${TEMP_ROOT}/live/.warden/runner/ssh_host_ed25519_key.pub"
  rm -f \
    "${TEMP_ROOT}/docker-build-entered" \
    "${TEMP_ROOT}/live-mutation-restored" \
    "${TEMP_ROOT}/snapshot-build-context-sha256" \
    "${TEMP_ROOT}/docker-build-invoked" \
    "${TEMP_ROOT}/docker-rendered"
}

cat <<'SH' >"${TEMP_ROOT}/fake-docker"
#!/usr/bin/env bash
set -euo pipefail

image_id_for_service() {
  case "$1" in
    egress-proxy) printf 'sha256:%064d\n' 1 ;;
    qa-tunnel) printf 'sha256:%064d\n' 2 ;;
    runner) printf 'sha256:%064d\n' 3 ;;
    ssh-proxy) printf 'sha256:%064d\n' 4 ;;
  esac
}

if [[ "${1:-}" == compose ]]; then
  shift
  project_dir=""
  action=""
  while [[ "$#" -gt 0 ]]; do
    case "$1" in
      --project-directory)
        project_dir="$2"
        shift 2
        ;;
      config|build|up|down)
        action="$1"
        shift
        ;;
      *)
        shift
        ;;
    esac
  done
  case "${action}" in
    config)
      touch "${FAKE_RENDER_MARKER}"
      environment="$(awk -F= '$1 == "WARDEN_ENV_NAME" { print $2 }' "${project_dir}/.env")"
      printf 'root: %s\nenvironment: %s\n' "${project_dir}" "${environment}"
      ;;
    build)
      touch "${FAKE_BUILD_MARKER}"
      if [[ -n "${FAKE_BUILD_ENTERED:-}" ]]; then
        touch "${FAKE_BUILD_ENTERED}"
        for _ in $(seq 1 500); do
          [[ -e "${FAKE_LIVE_MUTATION_RESTORED}" ]] && break
          sleep 0.01
        done
        [[ -e "${FAKE_LIVE_MUTATION_RESTORED}" ]] || exit 70
      fi
      ! grep -q 'concurrent mutation' "${project_dir}/.warden/runner/Dockerfile"
      sha256sum "${project_dir}/.warden/runner/Dockerfile" | awk '{print $1}' >"${FAKE_BUILD_CONTEXT_SHA256}"
      ;;
    up|down)
      ;;
    *)
      exit 64
      ;;
  esac
  exit 0
fi

if [[ "${1:-}" == ps ]]; then
  printf 'c1\nc2\nc3\nc4\n'
  exit 0
fi
if [[ "${1:-}" == inspect ]]; then
  case "${4}" in
    c1) service=egress-proxy ;;
    c2) service=qa-tunnel ;;
    c3) service=runner ;;
    c4) service=ssh-proxy ;;
    *) exit 64 ;;
  esac
  if [[ "${3}" == *compose.service* ]]; then
    printf '%s\n' "${service}"
  elif [[ "${service}" == "${FAKE_BAD_RUNNING_IMAGE_SERVICE:-}" ]]; then
    printf 'sha256:%064d\n' 9
  else
    image_id_for_service "${service}"
  fi
  exit 0
fi
if [[ "${1:-}" == image && "${2:-}" == inspect ]]; then
  image_id="${5}"
  if [[ "${4}" == *source-manifest* ]]; then
    if [[ "${image_id}" == "$(image_id_for_service "${FAKE_BAD_IMAGE_SERVICE:-}")" ]]; then
      printf '%064d\n' 0
    else
      printf '%s\n' "${FAKE_SOURCE_SHA256}"
    fi
  else
    printf '%s\n' "${FAKE_RENDERED_SHA256}"
  fi
  exit 0
fi
exit 64
SH
chmod 0755 "${TEMP_ROOT}/fake-docker"

run_env=(
  DOCKER_BIN="${TEMP_ROOT}/fake-docker"
  FAKE_RENDER_MARKER="${TEMP_ROOT}/docker-rendered"
  FAKE_BUILD_MARKER="${TEMP_ROOT}/docker-build-invoked"
  FAKE_BUILD_CONTEXT_SHA256="${TEMP_ROOT}/snapshot-build-context-sha256"
)

cp -a "${TEMP_ROOT}/repo" "${TEMP_ROOT}/runtime-manifest-repo"
runtime_manifest_dir="${TEMP_ROOT}/runtime-manifest-repo/docker/warden/tester1"
printf 'ssh-ed25519 AAAAVERSIONED invalid\n' \
  >"${runtime_manifest_dir}/.warden/runner/authorized_keys"
(
  cd -- "${runtime_manifest_dir}"
  find . -type f ! -path './attestation/source-manifest.sha256' -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) | sed 's#  \./#  #' >"${TEMP_ROOT}/runtime-source-manifest.sha256"
mv "${TEMP_ROOT}/runtime-source-manifest.sha256" \
  "${runtime_manifest_dir}/attestation/source-manifest.sha256"
git -C "${TEMP_ROOT}/runtime-manifest-repo" add docker/warden/tester1
git -C "${TEMP_ROOT}/runtime-manifest-repo" \
  -c user.name='Attestation Test' \
  -c user.email='attestation-test@example.invalid' \
  commit -qm 'test runtime-only manifest fixture'

runtime_live="${TEMP_ROOT}/runtime-live"
mkdir -p "${runtime_live}"
cp -a "${runtime_manifest_dir}/." "${runtime_live}/"
printf 'WARDEN_ENV_NAME=paperclip-tester1\nWARDEN_ENV_TYPE=local\n' >"${runtime_live}/.env"
printf 'ssh-ed25519 AAAASENTINEL runtime\n' \
  >"${runtime_live}/.warden/runner/authorized_keys"
cp "${runtime_live}/.warden/runner/authorized_keys" \
  "${TEMP_ROOT}/authorized-keys-sentinel"
rm -f \
  "${runtime_live}/.warden/runner/ssh_host_ed25519_key" \
  "${runtime_live}/.warden/runner/ssh_host_ed25519_key.pub"
if output="$(env "${run_env[@]}" \
  "${runtime_manifest_dir}/sync-live-source.sh" --live-dir "${runtime_live}" 2>&1)"; then
  fail "Sync accepted a runtime-only path in the source manifest."
fi
grep -q 'Runtime-only path is forbidden in source manifest: .warden/runner/authorized_keys' <<<"${output}" \
  || fail "Runtime-only manifest path failed for an unexpected reason: ${output}"
cmp -s "${TEMP_ROOT}/authorized-keys-sentinel" \
  "${runtime_live}/.warden/runner/authorized_keys" \
  || fail "Sync changed runtime authorized_keys before rejecting the manifest."
printf 'PASS: runtime-only manifest path is rejected before live writes.\n'

printf '%064d\n' 7 >"${runtime_manifest_dir}/attestation/rendered-config.sha256"
cp "${runtime_manifest_dir}/attestation/rendered-config.sha256" \
  "${TEMP_ROOT}/rendered-config-sentinel"
rm -f "${TEMP_ROOT}/docker-rendered"
if output="$(env "${run_env[@]}" \
  "${runtime_manifest_dir}/refresh-attestation.sh" --live-dir "${runtime_live}" 2>&1)"; then
  fail "Refresh accepted runtime-only canonical source."
fi
grep -q 'Canonical source must not contain runtime-only path: .warden/runner/authorized_keys' <<<"${output}" \
  || fail "Runtime-only refresh path failed for an unexpected reason: ${output}"
cmp -s "${TEMP_ROOT}/rendered-config-sentinel" \
  "${runtime_manifest_dir}/attestation/rendered-config.sha256" \
  || fail "Refresh changed attestation output before rejecting runtime-only source."
[[ ! -e "${TEMP_ROOT}/docker-rendered" ]] \
  || fail "Compose rendered config before refresh rejected runtime-only source."
printf 'PASS: refresh rejects runtime-only source before attestation writes.\n'

prepare_live
source_sha256="$(sha256sum "${canonical_dir}/attestation/source-manifest.sha256" | awk '{print $1}')"
rendered_sha256="$(tr -d '[:space:]' <"${canonical_dir}/attestation/rendered-config.sha256")"
expected_images="${TEMP_ROOT}/expected-images"
printf 'egress-proxy=sha256:%064d\nqa-tunnel=sha256:%064d\nrunner=sha256:%064d\nssh-proxy=sha256:%064d\n' \
  1 2 3 4 >"${expected_images}"
chmod 0600 "${expected_images}"
env "${run_env[@]}" \
  FAKE_SOURCE_SHA256="${source_sha256}" \
  FAKE_RENDERED_SHA256="${rendered_sha256}" \
  "${canonical_dir}/verify-attestation.sh" \
    --canonical-dir "${canonical_dir}" \
    --live-dir "${TEMP_ROOT}/live" \
    --post-build \
    --expected-images "${expected_images}" >/dev/null
printf 'PASS: source, rendered config, image-label, and image-ID chain.\n'

if output="$(env "${run_env[@]}" \
  FAKE_SOURCE_SHA256="${source_sha256}" \
  FAKE_RENDERED_SHA256="${rendered_sha256}" \
  FAKE_BAD_IMAGE_SERVICE=runner \
  "${canonical_dir}/verify-attestation.sh" \
    --canonical-dir "${canonical_dir}" \
    --live-dir "${TEMP_ROOT}/live" \
    --post-build \
    --expected-images "${expected_images}" 2>&1)"; then
  fail "Gate accepted a mismatched image label."
fi
grep -q 'Image source-manifest label mismatch for runner' <<<"${output}" \
  || fail "Image-label mismatch failed for an unexpected reason: ${output}"
printf 'PASS: postbuild gate rejects mismatched image labels.\n'

if output="$(env "${run_env[@]}" \
  FAKE_SOURCE_SHA256="${source_sha256}" \
  FAKE_RENDERED_SHA256="${rendered_sha256}" \
  FAKE_BAD_RUNNING_IMAGE_SERVICE=runner \
  "${canonical_dir}/verify-attestation.sh" \
    --canonical-dir "${canonical_dir}" \
    --live-dir "${TEMP_ROOT}/live" \
    --post-build \
    --expected-images "${expected_images}" 2>&1)"; then
  fail "Gate accepted a running image that was not produced by the builder."
fi
grep -q 'Running image ID differs from the builder-produced ID for runner' <<<"${output}" \
  || fail "Image-ID mismatch failed for an unexpected reason: ${output}"
printf 'PASS: postbuild gate rejects a non-builder image ID.\n'

expect_prebuild_rejection() {
  local label="$1"
  local output
  rm -f "${TEMP_ROOT}/docker-rendered"
  if output="$(env "${run_env[@]}" \
    "${canonical_dir}/verify-attestation.sh" \
      --canonical-dir "${canonical_dir}" \
      --live-dir "${TEMP_ROOT}/live" 2>&1)"; then
    fail "Gate accepted ${label}."
  fi
  grep -q 'Live source does not match the Git-tracked manifest' <<<"${output}" \
    || fail "Gate rejected ${label} for an unexpected reason: ${output}"
  [[ ! -e "${TEMP_ROOT}/docker-rendered" ]] \
    || fail "Compose rendered config after ${label} drift."
  printf 'PASS: prebuild gate rejects %s before Compose invocation.\n' "${label}"
}

prepare_live
printf '\n# mutation\n' >>"${TEMP_ROOT}/live/verify-no-docker-boundary.sh"
expect_prebuild_rejection 'verifier drift'

prepare_live
printf '\n# mutation\n' >>"${TEMP_ROOT}/live/.warden/warden-env.yml"
expect_prebuild_rejection 'config drift'

prepare_live
printf 'WARDEN_ENV_NAME=changed-environment\nWARDEN_ENV_TYPE=local\n' >"${TEMP_ROOT}/live/.env"
if output="$(env "${run_env[@]}" \
  "${canonical_dir}/verify-attestation.sh" \
    --canonical-dir "${canonical_dir}" \
    --live-dir "${TEMP_ROOT}/live" 2>&1)"; then
  fail "Gate accepted rendered config drift."
fi
grep -q 'WARDEN_ENV_NAME must be paperclip-tester1' <<<"${output}" \
  || fail "Rendered config drift failed for an unexpected reason: ${output}"
[[ ! -e "${TEMP_ROOT}/docker-rendered" ]] \
  || fail "Rendered config drift was not stopped before Compose invocation."
printf 'PASS: rendered config drift is rejected before build.\n'

prepare_live
if output="$(env "${run_env[@]}" \
  "${canonical_dir}/rebuild-attested.sh" \
    --repo-dir "${TEMP_ROOT}/repo" \
    --commit "${fixture_commit}" \
    --live-dir "${TEMP_ROOT}/live" 2>&1)"; then
  fail "Uninstalled builder ran outside its privileged boundary."
fi
grep -Eq 'Builder must run as root|Builder must run from the root-owned installation' <<<"${output}" \
  || fail "Uninstalled builder failed for an unexpected reason: ${output}"
[[ ! -e "${TEMP_ROOT}/docker-build-invoked" ]] \
  || fail "Uninstalled builder reached Docker."
printf 'PASS: operational rebuild requires the installed privileged boundary.\n'

prepare_live
snapshot_dir="${TEMP_ROOT}/snapshot"
mkdir -m 0700 "${snapshot_dir}"
"${canonical_dir}/materialize-attested-snapshot.py" \
  --git-bin /usr/bin/git \
  --repo-dir "${TEMP_ROOT}/repo" \
  --commit "${fixture_commit}" \
  --source-path docker/warden/tester1 \
  --live-dir "${TEMP_ROOT}/live" \
  --snapshot-dir "${snapshot_dir}" \
  --fingerprint-output "${TEMP_ROOT}/runtime-fingerprints.sha256"
[[ "$(wc -l <"${TEMP_ROOT}/runtime-fingerprints.sha256")" == 4 ]] \
  || fail "Runtime fingerprint inventory is incomplete."
env "${run_env[@]}" \
  "${snapshot_dir}/verify-attestation.sh" --snapshot-dir "${snapshot_dir}" >/dev/null

live_target="${TEMP_ROOT}/live/.warden/runner/Dockerfile"
cp "${live_target}" "${TEMP_ROOT}/live-target-original"
original_sha256="$(sha256sum "${live_target}" | awk '{print $1}')"
(
  for _ in $(seq 1 500); do
    [[ -e "${TEMP_ROOT}/docker-build-entered" ]] && break
    sleep 0.01
  done
  [[ -e "${TEMP_ROOT}/docker-build-entered" ]] || exit 71
  printf '\n# concurrent mutation\n' >>"${live_target}"
  cp "${TEMP_ROOT}/live-target-original" "${live_target}"
  touch "${TEMP_ROOT}/live-mutation-restored"
) &
mutation_pid=$!
env "${run_env[@]}" \
  FAKE_BUILD_ENTERED="${TEMP_ROOT}/docker-build-entered" \
  FAKE_LIVE_MUTATION_RESTORED="${TEMP_ROOT}/live-mutation-restored" \
  "${TEMP_ROOT}/fake-docker" compose \
    --project-directory "${snapshot_dir}" \
    --env-file "${snapshot_dir}/.env" \
    -p paperclip-tester1 \
    -f "${snapshot_dir}/.warden/warden-networks.yml" \
    -f "${snapshot_dir}/.warden/warden-env.yml" \
    build
wait "${mutation_pid}"
snapshot_build_sha256="$(tr -d '[:space:]' <"${TEMP_ROOT}/snapshot-build-context-sha256")"
[[ "${snapshot_build_sha256}" == "${original_sha256}" ]] \
  || fail "Build context followed the concurrent live-tree mutation."
[[ "$(sha256sum "${live_target}" | awk '{print $1}')" == "${original_sha256}" ]] \
  || fail "Concurrent mutation fixture did not restore the live file."
printf 'PASS: concurrent live mutation+restore cannot change the snapshot build context.\n'

prepare_live
chmod 0664 "${TEMP_ROOT}/live/.env"
mkdir -m 0700 "${TEMP_ROOT}/bad-mode-snapshot"
if output="$("${canonical_dir}/materialize-attested-snapshot.py" \
  --git-bin /usr/bin/git \
  --repo-dir "${TEMP_ROOT}/repo" \
  --commit "${fixture_commit}" \
  --source-path docker/warden/tester1 \
  --live-dir "${TEMP_ROOT}/live" \
  --snapshot-dir "${TEMP_ROOT}/bad-mode-snapshot" \
  --fingerprint-output "${TEMP_ROOT}/bad-mode-fingerprints" 2>&1)"; then
  fail "Snapshot accepted an unsafe runtime file mode."
fi
grep -q 'Runtime file mode must be 0600: .env' <<<"${output}" \
  || fail "Runtime mode mismatch failed for an unexpected reason: ${output}"
printf 'PASS: runtime file modes are validated before snapshot completion.\n'

"${ROOT_DIR}/test-provision-secret-argv.sh"

printf 'PASS: attestation regression gate.\n'
