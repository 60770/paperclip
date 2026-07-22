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
[[ -n "${live_dir}" && -d "${live_dir}" && ! -L "${live_dir}" ]] \
  || fail "--live-dir must name an existing non-symlink directory."
live_dir="$(cd -- "${live_dir}" && pwd -P)"
[[ "${live_dir}" != / && "${live_dir}" != "${ROOT_DIR}" ]] \
  || fail "Refusing unsafe live directory: ${live_dir}"

"${ROOT_DIR}/verify-attestation.sh" --canonical-dir "${ROOT_DIR}" --source-only >/dev/null

while IFS= read -r line; do
  [[ "${line}" =~ ^[0-9a-f]{64}\ \ ([A-Za-z0-9._/-]+)$ ]] \
    || fail "Malformed source manifest line: ${line}"
  relative_path="${BASH_REMATCH[1]}"
  destination="${live_dir}/${relative_path}"
  [[ ! -L "${destination}" ]] || fail "Refusing to replace symlink: ${relative_path}"
  install -D -m "$(stat -c '%a' "${ROOT_DIR}/${relative_path}")" \
    "${ROOT_DIR}/${relative_path}" "${destination}"
done <"${ROOT_DIR}/attestation/source-manifest.sha256"
install -D -m 0644 \
  "${ROOT_DIR}/attestation/source-manifest.sha256" \
  "${live_dir}/attestation/source-manifest.sha256"

"${ROOT_DIR}/verify-attestation.sh" \
  --canonical-dir "${ROOT_DIR}" \
  --live-dir "${live_dir}"
