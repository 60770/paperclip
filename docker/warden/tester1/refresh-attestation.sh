#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
live_dir="${WARDEN_LIVE_DIR:-}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == "--live-dir" && "$#" -eq 2 ]]; then
  live_dir="$2"
elif [[ "$#" -ne 0 ]]; then
  fail "Usage: $0 --live-dir <path>"
fi
[[ -n "${live_dir}" && -f "${live_dir}/.env" ]] || fail "Live Warden .env is required to render config."
for runtime_only_path in \
  .env \
  .warden/runner/authorized_keys \
  .warden/runner/ssh_host_ed25519_key \
  .warden/runner/ssh_host_ed25519_key.pub; do
  [[ ! -e "${ROOT_DIR}/${runtime_only_path}" && ! -L "${ROOT_DIR}/${runtime_only_path}" ]] \
    || fail "Canonical source must not contain runtime-only path: ${runtime_only_path}"
done

docker_bin="${DOCKER_BIN:-docker}"
command -v "${docker_bin}" >/dev/null 2>&1 || fail "Docker Compose is required to render config."
temp_root="$(mktemp -d "${PAPERCLIP_RUN_SCRATCH_DIR:-${TMPDIR:-/tmp}}/tester1-attestation.XXXXXX")"
cleanup() {
  rm -rf -- "${temp_root}"
}
trap cleanup EXIT

mkdir -p "${temp_root}/source"
cp -a "${ROOT_DIR}/." "${temp_root}/source/"
cp "${live_dir}/.env" "${temp_root}/source/.env"
sentinel_sha256="$(printf '0%.0s' {1..64})"
(
  cd -- "${temp_root}/source"
  WARDEN_SOURCE_MANIFEST_SHA256="${sentinel_sha256}" \
  WARDEN_RENDERED_CONFIG_SHA256="${sentinel_sha256}" \
    "${docker_bin}" compose \
      --project-directory "${temp_root}/source" \
      --env-file "${temp_root}/source/.env" \
      -p paperclip-tester1 \
      -f "${temp_root}/source/.warden/warden-networks.yml" \
      -f "${temp_root}/source/.warden/warden-env.yml" \
      config
) >"${temp_root}/rendered.yml"
sed "s|${temp_root}/source|<WARDEN_ROOT>|g" \
  "${temp_root}/rendered.yml" >"${temp_root}/rendered-normalized.yml"
sha256sum "${temp_root}/rendered-normalized.yml" | awk '{print $1}' \
  >"${temp_root}/rendered-config.sha256"
install -D -m 0644 "${temp_root}/rendered-config.sha256" \
  "${ROOT_DIR}/attestation/rendered-config.sha256"

(
  cd -- "${ROOT_DIR}"
  find . -type f ! -path './attestation/source-manifest.sha256' -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) | sed 's#  \./#  #' >"${temp_root}/source-manifest.sha256"
install -D -m 0644 "${temp_root}/source-manifest.sha256" \
  "${ROOT_DIR}/attestation/source-manifest.sha256"

printf 'sourceManifestSha256=%s\n' "$(sha256sum "${ROOT_DIR}/attestation/source-manifest.sha256" | awk '{print $1}')"
printf 'renderedConfigSha256=%s\n' "$(tr -d '[:space:]' <"${ROOT_DIR}/attestation/rendered-config.sha256")"
