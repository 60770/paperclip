#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly ROOT_DIR="${WARDEN_ROOT:-${SCRIPT_DIR}}"
readonly INPUT_MANIFEST="${ROOT_DIR}/attestation/build-inputs.json"
readonly RUNNER_DOCKERFILE="${ROOT_DIR}/.warden/runner/Dockerfile"
readonly PACKAGE_JSON="${ROOT_DIR}/.warden/runner/package.json"
readonly PACKAGE_LOCK="${ROOT_DIR}/.warden/runner/package-lock.json"
readonly AUDIT_SCRIPT="${ROOT_DIR}/audit-runner-image.sh"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -r "${INPUT_MANIFEST}" ]] || fail "Missing build input manifest."
[[ -r "${RUNNER_DOCKERFILE}" ]] || fail "Missing runner Dockerfile."
[[ -r "${PACKAGE_JSON}" ]] || fail "Missing runner package.json."
[[ -r "${PACKAGE_LOCK}" ]] || fail "Missing runner package-lock.json."
[[ -r "${AUDIT_SCRIPT}" ]] || fail "Missing runner image audit script."

jq -e '
  .schemaVersion == 1 and
  .architecture == "linux/amd64" and
  ((.services | keys | sort) == ["egress-proxy", "qa-tunnel", "runner", "ssh-proxy"]) and
  all(.services[];
    (.dockerfile | test("^\\.warden/[a-z-]+/Dockerfile$")) and
    (.baseImage | test("^[a-z0-9./:-]+@sha256:[0-9a-f]{64}$"))) and
  all((.services.runner.aptPackages[], .services["egress-proxy"].aptPackages[]);
    test("^[a-z0-9][a-z0-9+.-]*=[^[:space:]]+$")) and
  all((.services["qa-tunnel"].apkPackages[], .services["ssh-proxy"].apkPackages[]);
    . as $package |
    ($package.name | test("^[a-z0-9][a-z0-9+.-]*$")) and
    ($package.version | test("^[^[:space:]]+$")) and
    ($package.filename == ($package.name + "-" + $package.version + ".apk")) and
    ($package.url | test("^https://dl-cdn\\.alpinelinux\\.org/alpine/v3\\.22/main/x86_64/[A-Za-z0-9_.+-]+\\.apk$")) and
    ($package.url | endswith("/" + $package.filename)) and
    ($package.sha256 | test("^[0-9a-f]{64}$")))
' "${INPUT_MANIFEST}" >/dev/null || fail "Build input manifest is malformed or incomplete."

validate_base_image() {
  local service="$1"
  local dockerfile="$2"
  local expected_image
  local from_line
  expected_image="$(jq -er --arg service "${service}" '.services[$service].baseImage' "${INPUT_MANIFEST}")"
  from_line="$(awk 'toupper($1) == "FROM" { print; exit }' "${dockerfile}")"
  [[ "${from_line}" == "FROM ${expected_image}" ]] \
    || fail "${service} base image differs from the build input manifest."
}

apt_package_specs() {
  awk '
    /apt-get install/ { packages = 1; next }
    packages {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      sub(/[[:space:]]*\\$/, "", line)
      if (line ~ /^&&/) exit
      if (line != "") print line
    }
  ' "$1"
}

validate_debian_service() {
  local service="$1"
  local dockerfile
  local repository_file
  local expected_packages
  local actual_packages
  local expected_repositories
  local actual_repositories
  dockerfile="${ROOT_DIR}/$(jq -er --arg service "${service}" '.services[$service].dockerfile' "${INPUT_MANIFEST}")"
  repository_file="${ROOT_DIR}/$(jq -er --arg service "${service}" '.services[$service].repositoryFile' "${INPUT_MANIFEST}")"
  [[ -r "${dockerfile}" ]] || fail "Missing ${service} Dockerfile."
  [[ -r "${repository_file}" ]] || fail "Missing ${service} Debian sources."
  validate_base_image "${service}" "${dockerfile}"

  expected_repositories="$(jq -r --arg service "${service}" '.services[$service].repositories[]' "${INPUT_MANIFEST}" | LC_ALL=C sort)"
  actual_repositories="$(sed -n 's/^URIs: //p' "${repository_file}" | LC_ALL=C sort)"
  [[ "${actual_repositories}" == "${expected_repositories}" ]] \
    || fail "${service} repository list differs from the build input manifest."
  [[ "$(grep -Ec '^URIs: http://snapshot\.debian\.org/archive/(debian|debian-security)/[0-9]{8}T[0-9]{6}Z$' "${repository_file}")" == "2" ]] \
    || fail "${service} must use dated Debian and Debian Security snapshots."
  if grep -Eq 'deb\.debian\.org|security\.debian\.org' "${repository_file}"; then
    fail "Mutable Debian repository found for ${service}."
  fi

  expected_packages="$(jq -r --arg service "${service}" '.services[$service].aptPackages[]' "${INPUT_MANIFEST}" | LC_ALL=C sort)"
  actual_packages="$(apt_package_specs "${dockerfile}" | LC_ALL=C sort)"
  [[ "${actual_packages}" == "${expected_packages}" ]] \
    || fail "${service} APT packages differ from the build input manifest."
}

validate_alpine_service() {
  local service="$1"
  local dockerfile
  local expected_count
  local actual_count
  dockerfile="${ROOT_DIR}/$(jq -er --arg service "${service}" '.services[$service].dockerfile' "${INPUT_MANIFEST}")"
  [[ -r "${dockerfile}" ]] || fail "Missing ${service} Dockerfile."
  validate_base_image "${service}" "${dockerfile}"
  [[ "$(jq -er --arg service "${service}" '.services[$service].installMode' "${INPUT_MANIFEST}")" == "checksum-verified-apk-offline" ]] \
    || fail "${service} must install checksum-verified APKs offline."
  grep -Fq 'apk add --no-network --repositories-file /dev/null --allow-untrusted \' "${dockerfile}" \
    || fail "${service} APK install must disable repositories and networking."

  expected_count="$(jq -r --arg service "${service}" '.services[$service].apkPackages | length' "${INPUT_MANIFEST}")"
  actual_count="$(grep -Ec '^ADD --checksum=sha256:[0-9a-f]{64} https://[^[:space:]]+ /tmp/packages/[^[:space:]]+\.apk$' "${dockerfile}")"
  [[ "${actual_count}" == "${expected_count}" ]] \
    || fail "${service} checksum-pinned APK count differs from the build input manifest."

  while IFS=$'\t' read -r filename url sha256; do
    grep -Fqx "ADD --checksum=sha256:${sha256} ${url} /tmp/packages/${filename}" "${dockerfile}" \
      || fail "${service} APK source differs from the build input manifest: ${filename}"
    [[ "$(grep -Fc "/tmp/packages/${filename}" "${dockerfile}")" == "2" ]] \
      || fail "${service} APK must be both fetched and installed exactly once: ${filename}"
  done < <(jq -r --arg service "${service}" '.services[$service].apkPackages[] | [.filename, .url, .sha256] | @tsv' "${INPUT_MANIFEST}")
}

validate_debian_service runner
validate_debian_service egress-proxy
validate_alpine_service qa-tunnel
validate_alpine_service ssh-proxy

if grep -Fq 'docker.sock' "${AUDIT_SCRIPT}"; then
  fail "Runner image audit must not reference the Docker socket."
fi
grep -Fq 'docker image save --output "${archive_path}" "${image_id}"' "${AUDIT_SCRIPT}" \
  || fail "Runner image audit must save the resolved image ID."
grep -Fq '"docker-archive:/scan/runner-image.tar"' "${AUDIT_SCRIPT}" \
  || fail "Syft must scan the saved Docker archive."
grep -Fq -- '--input /scan/runner-image.tar' "${AUDIT_SCRIPT}" \
  || fail "Trivy must scan the saved Docker archive."

grep -Eq '^COPY package\.json package-lock\.json /opt/runner-tools/$' "${RUNNER_DOCKERFILE}" \
  || fail "Dockerfile must copy package-lock.json into the npm install context."
grep -Eq 'npm ci([[:space:]]|\\)' "${RUNNER_DOCKERFILE}" \
  || fail "Dockerfile must install npm dependencies with npm ci."
grep -Eq -- '--prefix /opt/runner-tools' "${RUNNER_DOCKERFILE}" \
  || fail "npm ci must install the locked runner toolchain under /opt/runner-tools."
grep -Eq '/opt/runner-tools/node_modules/\.bin' "${RUNNER_DOCKERFILE}" \
  || fail "Locked npm executables are missing from PATH."
grep -Fq 'ln -s /opt/runner-tools/node_modules/.bin/codex /usr/local/bin/codex' "${RUNNER_DOCKERFILE}" \
  || fail "The pinned Codex executable must be installed at the wrapper path."
grep -Fq 'ln -s /opt/runner-tools/node_modules/.bin/playwright-mcp /usr/local/bin/playwright-mcp' "${RUNNER_DOCKERFILE}" \
  || fail "The pinned Playwright MCP executable must be installed at the smoke-test path."
grep -Eq 'rm -rf /usr/local/lib/node_modules/npm' "${RUNNER_DOCKERFILE}" \
  || fail "The npm package manager must not remain in the runtime image."
if grep -Eq 'npm[[:space:]]+(install|i)([[:space:]]|\\)' "${RUNNER_DOCKERFILE}"; then
  fail "Mutable npm install command found in Dockerfile."
fi

jq -e --slurpfile package "${PACKAGE_JSON}" '
  .lockfileVersion == 3 and
  .packages[""].dependencies == $package[0].dependencies and
  ($package[0].private == true) and
  .packages["node_modules/@openai/codex"].bin.codex == "bin/codex.js" and
  .packages["node_modules/@playwright/mcp"].bin["playwright-mcp"] == "cli.js" and
  ([$package[0].dependencies[] | test("^[0-9]+\\.[0-9]+\\.[0-9]+([+-].*)?$")] | all) and
  ([.packages | to_entries[] | select(.key != "") | .value | select(.resolved != null) | has("integrity")] | all)
' "${PACKAGE_LOCK}" >/dev/null || fail "package-lock.json is incomplete or inconsistent with package.json."

printf 'PASS: Tester1 Warden supply-chain inputs are immutable and lock-backed.\n'
