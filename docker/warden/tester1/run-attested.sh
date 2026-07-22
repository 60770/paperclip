#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
live_dir="${WARDEN_LIVE_DIR:-}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

if [[ "${1:-}" == "--live-dir" && "$#" -ge 4 && "${3:-}" == "--" ]]; then
  live_dir="$2"
  shift 3
elif [[ -n "${live_dir}" && "${1:-}" == "--" && "$#" -ge 2 ]]; then
  shift
else
  fail "Usage: $0 --live-dir <path> -- <command> [args...]"
fi

attestation="$(${ROOT_DIR}/verify-attestation.sh \
  --canonical-dir "${ROOT_DIR}" \
  --live-dir "${live_dir}")"
export WARDEN_SOURCE_MANIFEST_SHA256="$(awk -F= '$1 == "sourceManifestSha256" { print $2 }' <<<"${attestation}")"
export WARDEN_RENDERED_CONFIG_SHA256="$(awk -F= '$1 == "renderedConfigSha256" { print $2 }' <<<"${attestation}")"
[[ "${WARDEN_SOURCE_MANIFEST_SHA256}" =~ ^[0-9a-f]{64}$ ]] || fail "Attestation returned an invalid source digest."
[[ "${WARDEN_RENDERED_CONFIG_SHA256}" =~ ^[0-9a-f]{64}$ ]] || fail "Attestation returned an invalid config digest."

cd -- "${live_dir}"
exec "$@"
