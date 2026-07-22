#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
scratch="$(mktemp -d)"
cleanup() {
  [[ -d "$scratch" ]] && rm -rf -- "$scratch"
}
trap cleanup EXIT

openssl genpkey -algorithm ED25519 -out "$scratch/signing.pem" >/dev/null 2>&1
openssl pkey -in "$scratch/signing.pem" -pubout -out "$scratch/public.pem" >/dev/null 2>&1

make_bundle() {
  local name="$1"
  local root="$scratch/$name"
  mkdir -p "$root/bundle/payload/bin" "$root/state"
  install -m 0555 "$repo_root/scripts/release-gates/test/test-release-broker-binding.sh" \
    "$root/bundle/payload/bin/check"
  install -m 0444 "$repo_root/scripts/release-gates/policy/RELEASE_BROKER_POLICY.md" \
    "$root/bundle/payload/policy.md"
  python3 "$repo_root/scripts/release-gates/admin/build-manifest.py" \
    --payload "$root/bundle/payload" \
    --output "$root/bundle/manifest.json" \
    --generation 1 \
    --source-commit 1111111111111111111111111111111111111111 \
    --built-at 2026-07-22T12:00:00Z
  openssl pkeyutl -sign -rawin \
    -inkey "$scratch/signing.pem" \
    -in "$root/bundle/manifest.json" \
    -out "$root/bundle/manifest.json.sig"
  chmod 0444 "$root/bundle/manifest.json" "$root/bundle/manifest.json.sig"
}

verify_new() {
  local name="$1"
  shift
  python3 "$repo_root/deploy/release-broker/verify-release-bundle.py" \
    --bundle "$scratch/$name/bundle" \
    --public-key "$scratch/public.pem" \
    --generation-state "$scratch/$name/state/generation.json" \
    --require-new "$@" >/dev/null
}

assert_denied() {
  if verify_new "$1" 2>/dev/null; then
    printf 'expected attestation denial: %s\n' "$1" >&2
    exit 1
  fi
}

make_bundle valid
python3 "$repo_root/deploy/release-broker/verify-release-bundle.py" \
  --bundle "$scratch/valid/bundle" \
  --public-key "$scratch/public.pem" \
  --generation-state "$scratch/valid/state/generation.json" \
  --require-new \
  --record-generation >/dev/null
assert_denied valid
if python3 "$repo_root/deploy/release-broker/verify-release-bundle.py" \
  --bundle "$scratch/valid/bundle" \
  --public-key "$scratch/public.pem" \
  --generation-state "$scratch/valid/state/generation.json" \
  --record-generation >/dev/null 2>&1; then
  printf 'record-generation accepted without require-new\n' >&2
  exit 1
fi

make_bundle hash
install -m 0555 /dev/null "$scratch/hash/bundle/payload/bin/check"
assert_denied hash

make_bundle inventory
install -m 0444 /dev/null "$scratch/inventory/bundle/payload/extra"
assert_denied inventory

make_bundle mode
chmod 0755 "$scratch/mode/bundle/payload/bin/check"
assert_denied mode

make_bundle signature
install -m 0444 /dev/null "$scratch/signature/bundle/manifest.json.sig"
assert_denied signature

make_bundle symlink
ln -s bin/check "$scratch/symlink/bundle/payload/link"
assert_denied symlink

printf 'release attestation regression: ok\n'
