#!/usr/bin/env bash
set -euo pipefail

readonly ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly GUARD="${ROOT_DIR}/verify-supply-chain.sh"
readonly TEMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tester1-supply-chain.XXXXXX")"

cleanup() {
  rm -rf -- "${TEMP_ROOT}"
}
trap cleanup EXIT

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

reset_fixture() {
  rm -rf -- "${TEMP_ROOT}/.warden" "${TEMP_ROOT}/attestation"
  cp -a "${ROOT_DIR}/.warden" "${TEMP_ROOT}/.warden"
  mkdir -p "${TEMP_ROOT}/attestation"
  cp "${ROOT_DIR}/attestation/build-inputs.json" "${TEMP_ROOT}/attestation/build-inputs.json"
  cp "${ROOT_DIR}/audit-runner-image.sh" "${TEMP_ROOT}/audit-runner-image.sh"
}

expect_guard_failure() {
  local label="$1"
  if WARDEN_ROOT="${TEMP_ROOT}" "${GUARD}" >/dev/null 2>&1; then
    fail "Guard accepted ${label}."
  fi
  printf 'PASS: guard rejects %s.\n' "${label}"
}

"${GUARD}"

short_digest="$(printf 'a%.0s' {1..63})"
valid_digest="$(printf 'b%.0s' {1..64})"
for service in runner proxy qa-tunnel ssh-proxy; do
  dockerfile="${ROOT_DIR}/.warden/${service}/Dockerfile"
  digest_validation="$(
    sed -n '/^RUN for digest /,/^    done$/p' "${dockerfile}" \
      | sed '1s/^RUN //; s/[[:space:]]*\\$//'
  )"
  if WARDEN_SOURCE_MANIFEST_SHA256="${short_digest}" \
    WARDEN_RENDERED_CONFIG_SHA256="${valid_digest}" \
    /bin/sh -c "${digest_validation}"; then
    fail "${service} image accepted a short source digest followed by a valid rendered digest."
  else
    status="$?"
  fi
  [[ "${status}" == "64" ]] \
    || fail "${service} image rejected a short source digest with unexpected status ${status}."
done
printf 'PASS: every image rejects a short first attestation digest.\n'

reset_fixture
sed -i -E 's/@sha256:[0-9a-f]{64}//' "${TEMP_ROOT}/.warden/runner/Dockerfile"
expect_guard_failure "mutable FROM"

reset_fixture
sed -i -E 's/@sha256:[0-9a-f]{64}//' "${TEMP_ROOT}/.warden/proxy/Dockerfile"
expect_guard_failure "mutable proxy FROM"

reset_fixture
sed -i 's/squid=5.7-2+deb12u5/squid/' "${TEMP_ROOT}/.warden/proxy/Dockerfile"
expect_guard_failure "unpinned proxy APT package"

reset_fixture
sed -i 's/0815a5f0403974bb9c34d456e71dc9c0222cb5455d393bc63c44b573da3d7fe0/1815a5f0403974bb9c34d456e71dc9c0222cb5455d393bc63c44b573da3d7fe0/' \
  "${TEMP_ROOT}/.warden/qa-tunnel/Dockerfile"
expect_guard_failure "qa-tunnel APK checksum drift"

reset_fixture
sed -i 's/--no-network --repositories-file \/dev\/null --allow-untrusted/--no-cache/' \
  "${TEMP_ROOT}/.warden/ssh-proxy/Dockerfile"
expect_guard_failure "online ssh-proxy APK install"

reset_fixture
jq '.services["egress-proxy"].baseImage = "debian:bookworm-slim@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"' \
  "${TEMP_ROOT}/attestation/build-inputs.json" >"${TEMP_ROOT}/attestation/build-inputs.json.next"
mv "${TEMP_ROOT}/attestation/build-inputs.json.next" "${TEMP_ROOT}/attestation/build-inputs.json"
expect_guard_failure "build input manifest mismatch"

reset_fixture
sed -i 's/npm ci/npm install/' "${TEMP_ROOT}/.warden/runner/Dockerfile"
expect_guard_failure "npm install without lock enforcement"

reset_fixture
sed -i 's/COPY package.json package-lock.json/COPY package.json/' "${TEMP_ROOT}/.warden/runner/Dockerfile"
expect_guard_failure "Docker build without package-lock.json"

reset_fixture
sed -i '/node_modules\/\.bin\/codex \/usr\/local\/bin\/codex/d' "${TEMP_ROOT}/.warden/runner/Dockerfile"
expect_guard_failure "runner image without the pinned Codex command path"

reset_fixture
sed -i '/node_modules\/\.bin\/playwright-mcp \/usr\/local\/bin\/playwright-mcp/d' "${TEMP_ROOT}/.warden/runner/Dockerfile"
expect_guard_failure "runner image without the pinned Playwright MCP command path"

reset_fixture
printf '\n# /var/run/docker.sock\n' >>"${TEMP_ROOT}/audit-runner-image.sh"
expect_guard_failure "Docker socket reference in image audit"

reset_fixture
cp "${ROOT_DIR}/verify-supply-chain.sh" "${TEMP_ROOT}/verify-supply-chain.sh"
mkdir -p "${TEMP_ROOT}/bin" "${TEMP_ROOT}/audit-output"
cat >"${TEMP_ROOT}/bin/docker" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

printf '%s ' "$@" >>"${FAKE_DOCKER_LOG}"
printf '\n' >>"${FAKE_DOCKER_LOG}"

if [[ "${1:-}" == "image" && "${2:-}" == "inspect" ]]; then
  printf '%s\n' "${FAKE_IMAGE_ID}"
  exit 0
fi

if [[ "${1:-}" == "image" && "${2:-}" == "save" ]]; then
  archive_path="$4"
  image_id="$5"
  archive_root="$(mktemp -d)"
  printf '[{"Config":"%s.json"}]\n' "${image_id#sha256:}" >"${archive_root}/manifest.json"
  tar -C "${archive_root}" -cf "${archive_path}" manifest.json
  rm -rf -- "${archive_root}"
  exit 0
fi

case "$*" in
  *--download-db-only*)
    database_root="$(mktemp -d)"
    mkdir -p "${database_root}/db"
    printf '{}\n' >"${database_root}/db/metadata.json"
    printf 'fixture-db\n' >"${database_root}/db/trivy.db"
    tar -C "${database_root}" -cf - db
    rm -rf -- "${database_root}"
    ;;
  *docker-archive:/scan/runner-image.tar*)
    printf '{"bomFormat":"CycloneDX","metadata":{"component":{"name":"fixture"}}}\n'
    ;;
  *--input\ /scan/runner-image.tar*)
    printf '{"Results":[]}\n'
    ;;
  *)
    exit 64
    ;;
esac
SH
chmod 0755 "${TEMP_ROOT}/bin/docker"

fake_image_id="sha256:$(printf 'd%.0s' {1..64})"
fake_docker_log="${TEMP_ROOT}/docker.log"
PATH="${TEMP_ROOT}/bin:${PATH}" \
FAKE_DOCKER_LOG="${fake_docker_log}" \
FAKE_IMAGE_ID="${fake_image_id}" \
  "${TEMP_ROOT}/audit-runner-image.sh" \
    "${TEMP_ROOT}/audit-output" fixture-runner:latest \
    >"${TEMP_ROOT}/audit.stdout"

grep -qx "${fake_image_id}" "${TEMP_ROOT}/audit-output/runner-image-digest.txt" \
  || fail "Audit did not persist the resolved image ID."
grep -q '^fixableCritical=0$' "${TEMP_ROOT}/audit.stdout" \
  || fail "Audit did not preserve the fixable CRITICAL gate."
grep -q '^fixableHigh=0$' "${TEMP_ROOT}/audit.stdout" \
  || fail "Audit did not report fixable HIGH findings."
[[ -s "${TEMP_ROOT}/audit-output/runner-sbom.cdx.json" ]] \
  || fail "Audit did not produce a CycloneDX SBOM."
[[ -s "${TEMP_ROOT}/audit-output/runner-trivy.json" ]] \
  || fail "Audit did not produce a Trivy report."
[[ "$(grep -c '^image inspect ' "${fake_docker_log}")" == "1" ]] \
  || fail "Audit must resolve the image ID exactly once."
grep -Fq "image save --output" "${fake_docker_log}" \
  || fail "Audit did not save an image archive."
grep -Fq "${fake_image_id}" "${fake_docker_log}" \
  || fail "Audit did not save the resolved image ID."
[[ "$(grep -c -- '--network none' "${fake_docker_log}")" == "2" ]] \
  || fail "Both scan containers must disable networking."
[[ "$(grep -c -- '--mount ' "${fake_docker_log}")" == "2" ]] \
  || fail "Scan containers must mount only the image archive."
[[ "$(grep -c -- '--read-only' "${fake_docker_log}")" == "3" ]] \
  || fail "Every scanner phase must use a read-only root filesystem."
[[ "$(grep -c -- '--cap-drop ALL' "${fake_docker_log}")" == "3" ]] \
  || fail "Every scanner phase must drop all capabilities."
[[ "$(grep -c -- '--security-opt no-new-privileges' "${fake_docker_log}")" == "3" ]] \
  || fail "Every scanner phase must enable no-new-privileges."
[[ "$(grep -c -- '--user 65532:65532' "${fake_docker_log}")" == "3" ]] \
  || fail "Every scanner phase must use the non-root scanner user."
if grep -Fq 'docker.sock' "${fake_docker_log}"; then
  fail "Audit invoked a container with the Docker socket."
fi
grep -Fq 'docker-archive:/scan/runner-image.tar' "${fake_docker_log}" \
  || fail "Syft did not scan the image archive."
grep -Fq -- '--input /scan/runner-image.tar' "${fake_docker_log}" \
  || fail "Trivy did not scan the image archive."
printf 'PASS: archive-only image audit uses hardened scanner containers.\n'

printf 'PASS: supply-chain regression guard.\n'
