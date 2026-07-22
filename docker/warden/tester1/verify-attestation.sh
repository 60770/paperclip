#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
canonical_dir="${WARDEN_CANONICAL_DIR:-${SCRIPT_DIR}}"
live_dir="${WARDEN_LIVE_DIR:-}"
post_build=false
source_only=false

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  printf 'Usage: %s [--canonical-dir <path>] [--live-dir <path>] [--source-only] [--post-build]\n' "$0" >&2
  exit 64
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --canonical-dir)
      [[ "$#" -ge 2 ]] || usage
      canonical_dir="$2"
      shift 2
      ;;
    --live-dir)
      [[ "$#" -ge 2 ]] || usage
      live_dir="$2"
      shift 2
      ;;
    --source-only)
      source_only=true
      shift
      ;;
    --post-build)
      post_build=true
      shift
      ;;
    *)
      usage
      ;;
  esac
done

[[ -d "${canonical_dir}" ]] || fail "Canonical directory does not exist: ${canonical_dir}"
canonical_dir="$(cd -- "${canonical_dir}" && pwd -P)"
manifest_path="${canonical_dir}/attestation/source-manifest.sha256"
rendered_hash_path="${canonical_dir}/attestation/rendered-config.sha256"
[[ -s "${manifest_path}" ]] || fail "Missing source manifest: ${manifest_path}"
[[ -s "${rendered_hash_path}" ]] || fail "Missing rendered config hash: ${rendered_hash_path}"

git_root="$(git -C "${canonical_dir}" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "Canonical directory must belong to a Git worktree."
canonical_relative="$(realpath --relative-to="${git_root}" "${canonical_dir}")"
[[ "${canonical_relative}" != .. && "${canonical_relative}" != ../* ]] \
  || fail "Canonical directory escapes its Git worktree."
git -C "${git_root}" ls-files --error-unmatch \
  "${canonical_relative}/attestation/source-manifest.sha256" >/dev/null 2>&1 \
  || fail "Source manifest is not tracked by Git."
git_state="$(git -C "${git_root}" status --porcelain --untracked-files=all -- "${canonical_relative}")"
[[ -z "${git_state}" ]] || fail "Canonical source is dirty; commit it before attestation."

manifest_files=()
while IFS= read -r line; do
  [[ "${line}" =~ ^([0-9a-f]{64})\ \ ([A-Za-z0-9._/-]+)$ ]] \
    || fail "Malformed source manifest line: ${line}"
  relative_path="${BASH_REMATCH[2]}"
  [[ "${relative_path}" != /* && "${relative_path}" != .. && "${relative_path}" != ../* && "${relative_path}" != */../* ]] \
    || fail "Unsafe source manifest path: ${relative_path}"
  manifest_files+=("${relative_path}")
done <"${manifest_path}"
[[ "${#manifest_files[@]}" -gt 0 ]] || fail "Source manifest is empty."

if ! (cd -- "${canonical_dir}" && sha256sum --check --strict attestation/source-manifest.sha256 >/dev/null); then
  fail "Canonical source does not match its manifest."
fi

expected_inventory="$(mktemp)"
actual_inventory="$(mktemp)"
rendered_config=""
normalized_rendered_config=""
cleanup() {
  rm -f -- "${expected_inventory}" "${actual_inventory}" "${rendered_config}" "${normalized_rendered_config}"
}
trap cleanup EXIT

printf '%s\n' "${manifest_files[@]}" 'attestation/source-manifest.sha256' | LC_ALL=C sort -u >"${expected_inventory}"
(
  cd -- "${canonical_dir}"
  find . -type l -printf 'SYMLINK:%P\n'
  find . -type f -printf '%P\n' | LC_ALL=C sort
) >"${actual_inventory}"
cmp -s "${expected_inventory}" "${actual_inventory}" \
  || fail "Canonical file inventory differs from the manifest."

source_manifest_sha256="$(sha256sum "${manifest_path}" | awk '{print $1}')"
expected_rendered_sha256="$(tr -d '[:space:]' <"${rendered_hash_path}")"
[[ "${expected_rendered_sha256}" =~ ^[0-9a-f]{64}$ ]] \
  || fail "Rendered config hash must be a full sha256 digest."

if [[ "${source_only}" == "true" ]]; then
  printf 'sourceManifestSha256=%s\n' "${source_manifest_sha256}"
  printf 'renderedConfigSha256=%s\n' "${expected_rendered_sha256}"
  exit 0
fi

[[ -n "${live_dir}" && -d "${live_dir}" ]] || fail "--live-dir must name the existing Warden directory."
[[ ! -L "${live_dir}" ]] || fail "Live Warden directory must not be a symlink."
live_dir="$(cd -- "${live_dir}" && pwd -P)"
[[ -f "${live_dir}/.env" ]] || fail "Live Warden .env is missing."
for runtime_file in \
  .warden/runner/authorized_keys \
  .warden/runner/ssh_host_ed25519_key \
  .warden/runner/ssh_host_ed25519_key.pub; do
  [[ -f "${live_dir}/${runtime_file}" && ! -L "${live_dir}/${runtime_file}" ]] \
    || fail "Required runtime key material is missing or symlinked: ${runtime_file}"
done

if ! (cd -- "${live_dir}" && sha256sum --check --strict "${manifest_path}" >/dev/null); then
  fail "Live source does not match the Git-tracked manifest."
fi
cmp -s "${manifest_path}" "${live_dir}/attestation/source-manifest.sha256" \
  || fail "Live source manifest differs from the Git-tracked manifest."

for relative_path in "${manifest_files[@]}"; do
  canonical_mode="$(stat -c '%a' "${canonical_dir}/${relative_path}")"
  live_mode="$(stat -c '%a' "${live_dir}/${relative_path}")"
  [[ "${canonical_mode}" == "${live_mode}" ]] \
    || fail "Live file mode mismatch: ${relative_path}"
done

printf '%s\n' "${manifest_files[@]}" \
  'attestation/source-manifest.sha256' \
  '.env' \
  '.warden/runner/authorized_keys' \
  '.warden/runner/ssh_host_ed25519_key' \
  '.warden/runner/ssh_host_ed25519_key.pub' | LC_ALL=C sort -u >"${expected_inventory}"
if [[ -f "${live_dir}/.writetest" && ! -L "${live_dir}/.writetest" ]]; then
  printf '.writetest\n' >>"${expected_inventory}"
  LC_ALL=C sort -u -o "${expected_inventory}" "${expected_inventory}"
fi
(
  cd -- "${live_dir}"
  find . -type l -printf 'SYMLINK:%P\n'
  find . -type f -printf '%P\n' | LC_ALL=C sort
) >"${actual_inventory}"
cmp -s "${expected_inventory}" "${actual_inventory}" \
  || fail "Live Warden inventory has missing, unexpected, or symlinked files."

warden_bin="${WARDEN_BIN:-/opt/warden/bin/warden}"
[[ -x "${warden_bin}" ]] || fail "Warden executable is unavailable: ${warden_bin}"
rendered_config="$(mktemp)"
sentinel_sha256="$(printf '0%.0s' {1..64})"
(
  cd -- "${live_dir}"
  WARDEN_SOURCE_MANIFEST_SHA256="${sentinel_sha256}" \
  WARDEN_RENDERED_CONFIG_SHA256="${sentinel_sha256}" \
    "${warden_bin}" env config
) >"${rendered_config}"
normalized_rendered_config="$(mktemp)"
sed "s|${live_dir}|<WARDEN_ROOT>|g" "${rendered_config}" >"${normalized_rendered_config}"
actual_rendered_sha256="$(sha256sum "${normalized_rendered_config}" | awk '{print $1}')"
[[ "${actual_rendered_sha256}" == "${expected_rendered_sha256}" ]] \
  || fail "Rendered Warden config does not match the Git-tracked hash."

if [[ "${post_build}" == "true" ]]; then
  docker_bin="${DOCKER_BIN:-docker}"
  command -v "${docker_bin}" >/dev/null 2>&1 || fail "Docker is required for post-build attestation."
  expected_services=(egress-proxy qa-tunnel runner ssh-proxy)
  declare -A seen_services=()
  mapfile -t container_ids < <("${docker_bin}" ps -q --filter label=com.docker.compose.project=paperclip-tester1)
  [[ "${#container_ids[@]}" == "${#expected_services[@]}" ]] \
    || fail "Expected exactly four running Tester1 Warden containers."
  for container_id in "${container_ids[@]}"; do
    service="$("${docker_bin}" inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "${container_id}")"
    case "${service}" in
      egress-proxy|qa-tunnel|runner|ssh-proxy) ;;
      *) fail "Unexpected Tester1 Warden service: ${service}" ;;
    esac
    [[ -z "${seen_services[${service}]:-}" ]] || fail "Duplicate Tester1 Warden service: ${service}"
    seen_services["${service}"]=1
    image_id="$("${docker_bin}" inspect -f '{{.Image}}' "${container_id}")"
    image_source_sha256="$("${docker_bin}" image inspect -f '{{index .Config.Labels "com.gotto.warden.source-manifest-sha256"}}' "${image_id}")"
    image_rendered_sha256="$("${docker_bin}" image inspect -f '{{index .Config.Labels "com.gotto.warden.rendered-config-sha256"}}' "${image_id}")"
    [[ "${image_source_sha256}" == "${source_manifest_sha256}" ]] \
      || fail "Image source-manifest label mismatch for ${service}."
    [[ "${image_rendered_sha256}" == "${expected_rendered_sha256}" ]] \
      || fail "Image rendered-config label mismatch for ${service}."
  done
  for service in "${expected_services[@]}"; do
    [[ "${seen_services[${service}]:-}" == "1" ]] || fail "Missing Tester1 Warden service: ${service}"
  done
fi

printf 'sourceManifestSha256=%s\n' "${source_manifest_sha256}"
printf 'renderedConfigSha256=%s\n' "${expected_rendered_sha256}"
printf 'liveSource=verified\n'
printf 'renderedConfig=verified\n'
if [[ "${post_build}" == "true" ]]; then
  printf 'imageLabels=verified\n'
fi
