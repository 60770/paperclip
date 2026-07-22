#!/usr/bin/env bash
set -euo pipefail

readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly ROOT_DIR="${WARDEN_ROOT:-${SCRIPT_DIR}}"
readonly DOCKERFILE="${ROOT_DIR}/.warden/runner/Dockerfile"
readonly PACKAGE_JSON="${ROOT_DIR}/.warden/runner/package.json"
readonly PACKAGE_LOCK="${ROOT_DIR}/.warden/runner/package-lock.json"
readonly DEBIAN_SOURCES="${ROOT_DIR}/.warden/runner/debian.sources"

fail() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

[[ -r "${DOCKERFILE}" ]] || fail "Missing runner Dockerfile."
[[ -r "${PACKAGE_JSON}" ]] || fail "Missing runner package.json."
[[ -r "${PACKAGE_LOCK}" ]] || fail "Missing runner package-lock.json."
[[ -r "${DEBIAN_SOURCES}" ]] || fail "Missing pinned Debian sources."

from_line="$(awk 'toupper($1) == "FROM" { print; exit }' "${DOCKERFILE}")"
[[ "${from_line}" =~ ^FROM[[:space:]]+node:24-bookworm-slim@sha256:[0-9a-f]{64}$ ]] \
  || fail "Runner base image must use a full sha256 digest."

grep -Eq '^COPY package\.json package-lock\.json /opt/runner-tools/$' "${DOCKERFILE}" \
  || fail "Dockerfile must copy package-lock.json into the npm install context."
grep -Eq 'npm ci([[:space:]]|\\)' "${DOCKERFILE}" \
  || fail "Dockerfile must install npm dependencies with npm ci."
grep -Eq -- '--prefix /opt/runner-tools' "${DOCKERFILE}" \
  || fail "npm ci must install the locked runner toolchain under /opt/runner-tools."
grep -Eq '/opt/runner-tools/node_modules/\.bin' "${DOCKERFILE}" \
  || fail "Locked npm executables are missing from PATH."
grep -Eq 'rm -rf /usr/local/lib/node_modules/npm' "${DOCKERFILE}" \
  || fail "The npm package manager must not remain in the runtime image."
if grep -Eq 'npm[[:space:]]+(install|i)([[:space:]]|\\)' "${DOCKERFILE}"; then
  fail "Mutable npm install command found in Dockerfile."
fi

snapshot_count="$(grep -Ec '^URIs: http://snapshot\.debian\.org/archive/(debian|debian-security)/[0-9]{8}T[0-9]{6}Z$' "${DEBIAN_SOURCES}")"
[[ "${snapshot_count}" == "2" ]] || fail "Debian and security repositories must use dated snapshots."
if grep -Eq 'deb\.debian\.org|security\.debian\.org' "${DEBIAN_SOURCES}"; then
  fail "Mutable Debian repository found."
fi

awk '
  /apt-get install/ { packages = 1; next }
  /npm ci/ { packages = 0 }
  packages {
    line = $0
    sub(/^[[:space:]]+/, "", line)
    sub(/[[:space:]]*\\$/, "", line)
    if (line != "" && line !~ /^[a-z0-9][a-z0-9+.-]*=[^[:space:]]+$/) {
      print "Unpinned APT package: " line > "/dev/stderr"
      exit 1
    }
  }
' "${DOCKERFILE}" || fail "Every direct APT package must pin an exact version."

jq -e --slurpfile package "${PACKAGE_JSON}" '
  .lockfileVersion == 3 and
  .packages[""].dependencies == $package[0].dependencies and
  ($package[0].private == true) and
  ([$package[0].dependencies[] | test("^[0-9]+\\.[0-9]+\\.[0-9]+([+-].*)?$")] | all) and
  ([.packages | to_entries[] | select(.key != "") | .value | select(.resolved != null) | has("integrity")] | all)
' "${PACKAGE_LOCK}" >/dev/null || fail "package-lock.json is incomplete or inconsistent with package.json."

printf 'PASS: Tester1 Warden supply-chain inputs are immutable and lock-backed.\n'
