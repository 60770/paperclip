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
[[ -n "${live_dir}" ]] || fail "--live-dir is required."

attestation="$(${ROOT_DIR}/verify-attestation.sh \
  --canonical-dir "${ROOT_DIR}" \
  --live-dir "${live_dir}")"
source_manifest_sha256="$(awk -F= '$1 == "sourceManifestSha256" { print $2 }' <<<"${attestation}")"
rendered_config_sha256="$(awk -F= '$1 == "renderedConfigSha256" { print $2 }' <<<"${attestation}")"
[[ "${source_manifest_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail "Attestation returned an invalid source digest."
[[ "${rendered_config_sha256}" =~ ^[0-9a-f]{64}$ ]] || fail "Attestation returned an invalid config digest."

warden_bin="${WARDEN_BIN:-/opt/warden/bin/warden}"
(
  cd -- "${live_dir}"
  WARDEN_SOURCE_MANIFEST_SHA256="${source_manifest_sha256}" \
  WARDEN_RENDERED_CONFIG_SHA256="${rendered_config_sha256}" \
    "${warden_bin}" env up --build --remove-orphans
)

WARDEN_BIN="${warden_bin}" "${ROOT_DIR}/verify-attestation.sh" \
  --canonical-dir "${ROOT_DIR}" \
  --live-dir "${live_dir}" \
  --post-build
