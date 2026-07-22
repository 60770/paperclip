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
  rm -rf -- "${TEMP_ROOT}/.warden"
  mkdir -p "${TEMP_ROOT}/.warden"
  cp -a "${ROOT_DIR}/.warden/runner" "${TEMP_ROOT}/.warden/runner"
}

expect_guard_failure() {
  local label="$1"
  if WARDEN_ROOT="${TEMP_ROOT}" "${GUARD}" >/dev/null 2>&1; then
    fail "Guard accepted ${label}."
  fi
  printf 'PASS: guard rejects %s.\n' "${label}"
}

"${GUARD}"

reset_fixture
sed -i -E 's/@sha256:[0-9a-f]{64}//' "${TEMP_ROOT}/.warden/runner/Dockerfile"
expect_guard_failure "mutable FROM"

reset_fixture
sed -i 's/npm ci/npm install/' "${TEMP_ROOT}/.warden/runner/Dockerfile"
expect_guard_failure "npm install without lock enforcement"

reset_fixture
sed -i 's/COPY package.json package-lock.json/COPY package.json/' "${TEMP_ROOT}/.warden/runner/Dockerfile"
expect_guard_failure "Docker build without package-lock.json"

printf 'PASS: supply-chain regression guard.\n'
