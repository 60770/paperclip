#!/usr/bin/env bash
set -euo pipefail

export PATH=/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/root
export DOCKER_CONFIG=/root/.docker
IFS=$' \t\n'
umask 077
unset BASH_ENV ENV CDPATH DOCKER_HOST DOCKER_CONTEXT DOCKER_CLI_PLUGIN_EXTRA_DIRS
unset BUILDX_CONFIG PYTHONHOME PYTHONPATH PYTHONSTARTUP XDG_CONFIG_HOME
for inherited_variable in ${!GIT_@} ${!COMPOSE_@}; do
  unset "${inherited_variable}"
done

readonly INSTALL_DIR=/usr/local/libexec/paperclip-tester1
readonly SOURCE_PATH=docker/warden/tester1
readonly BUILDER_ROOT=/var/lib/paperclip/warden-builder/tester1
readonly GIT_BIN=/usr/bin/git
readonly PYTHON_BIN=/usr/bin/python3
readonly DOCKER_BIN=/usr/bin/docker
readonly EXPECTED_SERVICES=(egress-proxy qa-tunnel runner ssh-proxy)
readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_dir=""
live_dir=""
commit=""

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s --repo-dir <path> --commit <full-sha> --live-dir <path>\n' "$0" >&2
  exit 64
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      [[ "$#" -ge 2 ]] || usage
      repo_dir="$2"
      shift 2
      ;;
    --commit)
      [[ "$#" -ge 2 ]] || usage
      commit="$2"
      shift 2
      ;;
    --live-dir)
      [[ "$#" -ge 2 ]] || usage
      live_dir="$2"
      shift 2
      ;;
    *)
      usage
      ;;
  esac
done

[[ "${EUID}" -eq 0 ]] || fail "Builder must run as root."
[[ "${ROOT_DIR}" == "${INSTALL_DIR}" ]] \
  || fail "Builder must run from the root-owned installation at ${INSTALL_DIR}."
[[ ! -L "${BASH_SOURCE[0]}" ]] || fail "Installed builder must not be a symlink."

for trusted_file in \
  "${ROOT_DIR}/rebuild-attested.sh" \
  "${ROOT_DIR}/materialize-attested-snapshot.py" \
  "${GIT_BIN}" \
  "${PYTHON_BIN}" \
  "${DOCKER_BIN}"; do
  [[ -f "${trusted_file}" && ! -L "${trusted_file}" ]] || fail "Trusted executable is missing or symlinked: ${trusted_file}"
  trusted_mode="$(stat -c '%a' "${trusted_file}")"
  (( (8#${trusted_mode} & 8#022) == 0 )) || fail "Trusted executable is group/other writable: ${trusted_file}"
done
for trusted_file in \
  "${ROOT_DIR}/rebuild-attested.sh" \
  "${ROOT_DIR}/materialize-attested-snapshot.py"; do
  [[ "$(stat -c '%u' "${trusted_file}")" == 0 ]] || fail "Installed builder file must be root-owned: ${trusted_file}"
done
trusted_dir="${ROOT_DIR}"
while [[ "${trusted_dir}" != / ]]; do
  [[ "$(stat -c '%u' "${trusted_dir}")" == 0 ]] || fail "Builder path must be root-owned: ${trusted_dir}"
  install_mode="$(stat -c '%a' "${trusted_dir}")"
  (( (8#${install_mode} & 8#022) == 0 )) || fail "Builder path must not be group/other writable: ${trusted_dir}"
  trusted_dir="$(dirname -- "${trusted_dir}")"
done

[[ "${commit}" =~ ^[0-9a-f]{40}$ ]] || fail "--commit must be a full lowercase commit SHA."
[[ -n "${repo_dir}" && -n "${live_dir}" ]] || usage
[[ -d "${repo_dir}" && -d "${live_dir}" && ! -L "${live_dir}" ]] || fail "Repository and live directories must exist without a live-directory symlink."
repo_dir="$(realpath -e -- "${repo_dir}")"
live_dir="$(realpath -e -- "${live_dir}")"

export GIT_CONFIG_NOSYSTEM=1
export GIT_CONFIG_GLOBAL=/dev/null
resolved_commit="$(${GIT_BIN} -c "safe.directory=${repo_dir}" -C "${repo_dir}" rev-parse --verify "${commit}^{commit}")" \
  || fail "Selected commit is unavailable."
[[ "${resolved_commit}" == "${commit}" ]] || fail "Selected commit did not resolve exactly."

verify_installed_source() {
  local installed_path="$1"
  local repository_path="$2"
  local installed_sha256
  local committed_sha256
  installed_sha256="$(sha256sum "${installed_path}" | awk '{print $1}')"
  committed_sha256="$(${GIT_BIN} -c "safe.directory=${repo_dir}" -C "${repo_dir}" show "${commit}:${repository_path}" | sha256sum | awk '{print $1}')" \
    || fail "Cannot read builder source from selected commit: ${repository_path}"
  [[ "${installed_sha256}" == "${committed_sha256}" ]] \
    || fail "Installed builder differs from selected commit: ${repository_path}"
}

verify_installed_source "${ROOT_DIR}/rebuild-attested.sh" "${SOURCE_PATH}/rebuild-attested.sh"
verify_installed_source "${ROOT_DIR}/materialize-attested-snapshot.py" "${SOURCE_PATH}/materialize-attested-snapshot.py"

install -d -o root -g root -m 0700 "${BUILDER_ROOT}" "${BUILDER_ROOT}/snapshots"
snapshot_dir="$(mktemp -d "${BUILDER_ROOT}/snapshots/${commit}.XXXXXX")"
fingerprint_path="${snapshot_dir}.runtime-fingerprints.sha256"
expected_images_path="${snapshot_dir}.expected-images"
metadata_path="${snapshot_dir}.metadata"
chmod 0700 "${snapshot_dir}"

"${PYTHON_BIN}" "${ROOT_DIR}/materialize-attested-snapshot.py" \
  --git-bin "${GIT_BIN}" \
  --repo-dir "${repo_dir}" \
  --commit "${commit}" \
  --source-path "${SOURCE_PATH}" \
  --live-dir "${live_dir}" \
  --snapshot-dir "${snapshot_dir}" \
  --fingerprint-output "${fingerprint_path}"

attestation="$(DOCKER_BIN="${DOCKER_BIN}" "${snapshot_dir}/verify-attestation.sh" \
  --snapshot-dir "${snapshot_dir}")"
source_manifest_sha256="$(awk -F= '$1 == "sourceManifestSha256" { print $2 }' <<<"${attestation}")"
rendered_config_sha256="$(awk -F= '$1 == "renderedConfigSha256" { print $2 }' <<<"${attestation}")"
[[ "${source_manifest_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail "Attestation returned an invalid source digest."
[[ "${rendered_config_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail "Attestation returned an invalid config digest."

compose=(
  "${DOCKER_BIN}" compose
  --project-directory "${snapshot_dir}"
  --env-file "${snapshot_dir}/.env"
  -p paperclip-tester1
  -f "${snapshot_dir}/.warden/warden-networks.yml"
  -f "${snapshot_dir}/.warden/warden-env.yml"
)

(
  export WARDEN_SOURCE_MANIFEST_SHA256="${source_manifest_sha256}"
  export WARDEN_RENDERED_CONFIG_SHA256="${rendered_config_sha256}"
  "${compose[@]}" build
)

: >"${expected_images_path}"
chmod 0600 "${expected_images_path}"
for service in "${EXPECTED_SERVICES[@]}"; do
  image_id="$("${DOCKER_BIN}" image inspect --format '{{.Id}}' "paperclip-tester1-${service}")"
  [[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Build returned an invalid image ID for ${service}."
  printf '%s=%s\n' "${service}" "${image_id}" >>"${expected_images_path}"
done

if ! (
  export WARDEN_SOURCE_MANIFEST_SHA256="${source_manifest_sha256}"
  export WARDEN_RENDERED_CONFIG_SHA256="${rendered_config_sha256}"
  "${compose[@]}" up -d --no-build --force-recreate --remove-orphans
); then
  (
    export WARDEN_SOURCE_MANIFEST_SHA256="${source_manifest_sha256}"
    export WARDEN_RENDERED_CONFIG_SHA256="${rendered_config_sha256}"
    "${compose[@]}" down --remove-orphans
  ) || true
  fail "Snapshot start failed; partial Tester1 Warden containers were stopped. Snapshot retained at ${snapshot_dir}."
fi

if ! DOCKER_BIN="${DOCKER_BIN}" "${snapshot_dir}/verify-attestation.sh" \
  --snapshot-dir "${snapshot_dir}" \
  --post-build \
  --expected-images "${expected_images_path}"; then
  (
    export WARDEN_SOURCE_MANIFEST_SHA256="${source_manifest_sha256}"
    export WARDEN_RENDERED_CONFIG_SHA256="${rendered_config_sha256}"
    "${compose[@]}" down --remove-orphans
  ) || true
  fail "Post-build attestation failed; Tester1 Warden was stopped. Snapshot retained at ${snapshot_dir}."
fi

{
  printf 'commit=%s\n' "${commit}"
  printf 'snapshot=%s\n' "${snapshot_dir}"
  printf 'sourceManifestSha256=%s\n' "${source_manifest_sha256}"
  printf 'renderedConfigSha256=%s\n' "${rendered_config_sha256}"
  printf 'runtimeFingerprints=%s\n' "${fingerprint_path}"
  printf 'expectedImages=%s\n' "${expected_images_path}"
} >"${metadata_path}"
chmod 0600 "${metadata_path}"
ln -sfn "${metadata_path}" "${BUILDER_ROOT}/current"

printf 'sourceCommit=%s\n' "${commit}"
printf 'sourceManifestSha256=%s\n' "${source_manifest_sha256}"
printf 'renderedConfigSha256=%s\n' "${rendered_config_sha256}"
printf 'snapshot=%s\n' "${snapshot_dir}"
printf 'imageIds=verified\n'
