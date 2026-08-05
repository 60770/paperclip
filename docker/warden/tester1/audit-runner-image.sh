#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SYFT_IMAGE="docker.io/anchore/syft:v1.49.0@sha256:13b53ebabe3d215268c90cf8fb9b875f0183908245f376fd4b3a2cb69d21d484"
readonly TRIVY_IMAGE="docker.io/aquasec/trivy:0.72.0@sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f"
readonly OUTPUT_DIR="${1:-}"
readonly IMAGE_REF="${2:-paperclip-tester1-runner:latest}"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -n "${OUTPUT_DIR}" ]] || fail "Usage: $0 <output-directory> [image-reference]"
command -v docker >/dev/null 2>&1 || fail "docker is required."
command -v jq >/dev/null 2>&1 || fail "jq is required."
command -v sha256sum >/dev/null 2>&1 || fail "sha256sum is required."
command -v tar >/dev/null 2>&1 || fail "tar is required."

"${ROOT_DIR}/verify-supply-chain.sh"
mkdir -p "${OUTPUT_DIR}"

image_id="$(docker image inspect "${IMAGE_REF}" --format '{{.Id}}')"
[[ "${image_id}" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Resolved image ID is not a full sha256 digest."
base_image="$(awk 'toupper($1) == "FROM" { print $2; exit }' "${ROOT_DIR}/.warden/runner/Dockerfile")"
scanned_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
audit_work_dir="$(mktemp -d "${OUTPUT_DIR}/.audit.XXXXXX")"
archive_path="${audit_work_dir}/runner-image.tar"
trivy_db_archive="${audit_work_dir}/trivy-db.tar"

cleanup() {
  rm -rf -- "${audit_work_dir}"
}
trap cleanup EXIT

docker image save --output "${archive_path}" "${image_id}"
chmod 0444 "${archive_path}"
archive_config="$(tar -xOf "${archive_path}" manifest.json | jq -er '
  if length == 1 then .[0].Config else error("archive must contain exactly one image") end
')"
image_id_hex="${image_id#sha256:}"
[[ "${archive_config}" == "${image_id_hex}.json" || "${archive_config}" == "blobs/sha256/${image_id_hex}" ]] \
  || fail "Saved archive config does not match the resolved image ID."
archive_sha256="$(sha256sum "${archive_path}" | awk '{print $1}')"

printf '%s\n' "${image_id}" >"${OUTPUT_DIR}/runner-image-digest.txt"
printf '%s  runner-image.tar\n' "${archive_sha256}" >"${OUTPUT_DIR}/runner-image-archive.sha256"

scanner_options=(
  --rm
  --network none
  --read-only
  --cap-drop ALL
  --security-opt no-new-privileges
  --user 65532:65532
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=4g,uid=65532,gid=65532,mode=0700
  --env HOME=/tmp
  --mount "type=bind,src=${archive_path},dst=/scan/runner-image.tar,readonly"
)

docker run "${scanner_options[@]}" \
  --env SYFT_CHECK_FOR_APP_UPDATE=false \
  --env SYFT_CACHE_DIR=/tmp/syft-cache \
  "${SYFT_IMAGE}" "docker-archive:/scan/runner-image.tar" --output cyclonedx-json \
  >"${OUTPUT_DIR}/runner-sbom.cdx.json"

docker run --rm \
  --network bridge \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user 65532:65532 \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=2g,uid=65532,gid=65532,mode=0700 \
  --env HOME=/tmp \
  --entrypoint /bin/sh \
  "${TRIVY_IMAGE}" -c \
  'set -eu; trivy --cache-dir /tmp/trivy image --download-db-only --no-progress >&2; tar -C /tmp/trivy -cf - db' \
  >"${trivy_db_archive}"

docker run --interactive "${scanner_options[@]}" \
  --entrypoint /bin/sh \
  "${TRIVY_IMAGE}" -c \
  'set -eu; mkdir -p /tmp/trivy; tar -C /tmp/trivy -xf -; exec trivy --cache-dir /tmp/trivy image --quiet --scanners vuln --format json --input /scan/runner-image.tar --skip-db-update --skip-java-db-update --skip-check-update --skip-vex-repo-update --offline-scan --disable-telemetry --skip-version-check' \
  <"${trivy_db_archive}" \
  >"${OUTPUT_DIR}/runner-trivy.json"

[[ "$(sha256sum "${archive_path}" | awk '{print $1}')" == "${archive_sha256}" ]] \
  || fail "Runner image archive changed during the scan."

critical_count="$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' "${OUTPUT_DIR}/runner-trivy.json")"
high_count="$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' "${OUTPUT_DIR}/runner-trivy.json")"
fixable_critical_count="$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL" and (.FixedVersion // "") != "")] | length' "${OUTPUT_DIR}/runner-trivy.json")"
fixable_high_count="$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH" and (.FixedVersion // "") != "")] | length' "${OUTPUT_DIR}/runner-trivy.json")"

{
  printf '# Tester1 Warden runner supply-chain report\n\n'
  printf -- '- Image: `%s`\n' "${IMAGE_REF}"
  printf -- '- Image ID: `%s`\n' "${image_id}"
  printf -- '- Archive SHA-256: `%s`\n' "${archive_sha256}"
  printf -- '- Base: `%s`\n' "${base_image}"
  printf -- '- Scanned at: `%s`\n' "${scanned_at}"
  printf -- '- SBOM: CycloneDX JSON generated from the saved archive with `%s`\n' "${SYFT_IMAGE}"
  printf -- '- Vulnerability scan: Trivy JSON generated offline from the same archive with `%s`\n' "${TRIVY_IMAGE}"
  printf -- '- Findings: CRITICAL=%s, HIGH=%s, fixable CRITICAL=%s, fixable HIGH=%s\n' \
    "${critical_count}" "${high_count}" "${fixable_critical_count}" "${fixable_high_count}"
  printf '\nRollback: take the complete Warden environment down and keep Tester1 without a default environment. Do not restore the legacy privileged daemon.\n'
} >"${OUTPUT_DIR}/runner-supply-chain-report.md"

printf 'imageId=%s\n' "${image_id}"
printf 'archiveSha256=%s\n' "${archive_sha256}"
printf 'critical=%s\n' "${critical_count}"
printf 'high=%s\n' "${high_count}"
printf 'fixableCritical=%s\n' "${fixable_critical_count}"
printf 'fixableHigh=%s\n' "${fixable_high_count}"

[[ "${fixable_critical_count}" == "0" ]] \
  || fail "Fixable CRITICAL vulnerabilities found; see runner-trivy.json."
