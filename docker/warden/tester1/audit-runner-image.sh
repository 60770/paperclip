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

"${ROOT_DIR}/verify-supply-chain.sh"
mkdir -p "${OUTPUT_DIR}"

image_id="$(docker image inspect "${IMAGE_REF}" --format '{{.Id}}')"
base_image="$(awk 'toupper($1) == "FROM" { print $2; exit }' "${ROOT_DIR}/.warden/runner/Dockerfile")"
scanned_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"

printf '%s\n' "${image_id}" >"${OUTPUT_DIR}/runner-image-digest.txt"
docker run --rm \
  --volume /var/run/docker.sock:/var/run/docker.sock:ro \
  "${SYFT_IMAGE}" "docker:${IMAGE_REF}" --output cyclonedx-json \
  >"${OUTPUT_DIR}/runner-sbom.cdx.json"
docker run --rm \
  --volume /var/run/docker.sock:/var/run/docker.sock:ro \
  "${TRIVY_IMAGE}" image --quiet --scanners vuln --format json "${IMAGE_REF}" \
  >"${OUTPUT_DIR}/runner-trivy.json"

critical_count="$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL")] | length' "${OUTPUT_DIR}/runner-trivy.json")"
high_count="$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "HIGH")] | length' "${OUTPUT_DIR}/runner-trivy.json")"
fixable_critical_count="$(jq '[.Results[]?.Vulnerabilities[]? | select(.Severity == "CRITICAL" and (.FixedVersion // "") != "")] | length' "${OUTPUT_DIR}/runner-trivy.json")"

{
  printf '# Tester1 Warden runner supply-chain report\n\n'
  printf -- '- Image: `%s`\n' "${IMAGE_REF}"
  printf -- '- Image ID: `%s`\n' "${image_id}"
  printf -- '- Base: `%s`\n' "${base_image}"
  printf -- '- Scanned at: `%s`\n' "${scanned_at}"
  printf -- '- SBOM: CycloneDX JSON generated with `%s`\n' "${SYFT_IMAGE}"
  printf -- '- Vulnerability scan: Trivy JSON generated with `%s`\n' "${TRIVY_IMAGE}"
  printf -- '- Findings: CRITICAL=%s, HIGH=%s, fixable CRITICAL=%s\n' \
    "${critical_count}" "${high_count}" "${fixable_critical_count}"
  printf '\nRollback: take the complete Warden environment down and keep Tester1 without a default environment. Do not restore the legacy privileged daemon.\n'
} >"${OUTPUT_DIR}/runner-supply-chain-report.md"

printf 'imageId=%s\n' "${image_id}"
printf 'critical=%s\n' "${critical_count}"
printf 'high=%s\n' "${high_count}"
printf 'fixableCritical=%s\n' "${fixable_critical_count}"

[[ "${fixable_critical_count}" == "0" ]] \
  || fail "Fixable CRITICAL vulnerabilities found; see runner-trivy.json."
