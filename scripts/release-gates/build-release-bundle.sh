#!/usr/bin/env bash

set -euo pipefail

generation=""
output=""
signing_key=""
rollback_of=""

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --generation) generation="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --signing-key) signing_key="${2:-}"; shift 2 ;;
    --rollback-of) rollback_of="${2:-}"; shift 2 ;;
    *) printf 'unknown argument: %s\n' "$1" >&2; exit 2 ;;
  esac
done

[[ "$generation" =~ ^[1-9][0-9]*$ && -n "$output" && -n "$signing_key" ]] || {
  printf 'usage: build-release-bundle.sh --generation N --output DIR --signing-key FILE [--rollback-of N]\n' >&2
  exit 2
}
[[ -f "$signing_key" && ! -L "$signing_key" ]] || {
  printf 'invalid signing key\n' >&2
  exit 2
}
[[ ! -e "$output" ]] || {
  printf 'output already exists\n' >&2
  exit 2
}

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo_root"
[[ -z "$(git status --porcelain)" ]] || {
  printf 'release bundles require a clean source tree\n' >&2
  exit 1
}
source_commit="$(git rev-parse HEAD)"
[[ "$source_commit" =~ ^[0-9a-f]{40}$ ]] || exit 1
built_at="$(git show -s --format=%cI "$source_commit")"

output_parent="$(dirname "$output")"
mkdir -p "$output_parent"
staging="$(mktemp -d "$output_parent/.release-bundle.XXXXXX")"
cleanup() { rm -rf -- "$staging"; }
trap cleanup EXIT
payload="$staging/payload"
mkdir -p "$payload/packages/release-broker" "$payload/scripts/release-gates" "$payload/deploy"

pnpm --filter @paperclipai/release-broker clean
pnpm --filter @paperclipai/release-broker build
cp -R packages/release-broker/dist "$payload/packages/release-broker/dist"
cp packages/release-broker/package.json "$payload/packages/release-broker/package.json"
install -D scripts/release-gates/runtime/bin/release-gate "$payload/scripts/release-gates/runtime/bin/release-gate"
install -D scripts/release-gates/runtime/bin/release-human-gate-preflight.sh "$payload/scripts/release-gates/runtime/bin/release-human-gate-preflight.sh"
install -D scripts/release-gates/runtime/bin/release-main-lock-resolver.sh "$payload/scripts/release-gates/runtime/bin/release-main-lock-resolver.sh"
install -D scripts/release-gates/runtime/lib/release_main_lock_resolver.py "$payload/scripts/release-gates/runtime/lib/release_main_lock_resolver.py"
install -D scripts/release-gates/policy/RELEASE_BROKER_POLICY.md "$payload/scripts/release-gates/policy/RELEASE_BROKER_POLICY.md"
install -D scripts/release-gates/attestation/manifest.schema.json "$payload/scripts/release-gates/attestation/manifest.schema.json"
install -D scripts/release-gates/admin/build-manifest.py "$payload/scripts/release-gates/admin/build-manifest.py"
install -D scripts/release-gates/test/test-release-attestation.sh "$payload/scripts/release-gates/test/test-release-attestation.sh"
install -D scripts/release-gates/test/test-release-broker-binding.sh "$payload/scripts/release-gates/test/test-release-broker-binding.sh"
install -D scripts/release-gates/test/test-release-broker-systemd.sh "$payload/scripts/release-gates/test/test-release-broker-systemd.sh"
install -D scripts/release-gates/build-release-bundle.sh "$payload/scripts/release-gates/build-release-bundle.sh"
install -D deploy/release-broker/RUNBOOK.md "$payload/deploy/release-broker/RUNBOOK.md"
install -D deploy/release-broker/broker.conf.example "$payload/deploy/release-broker/broker.conf.example"
install -D deploy/release-broker/gotto-release-broker.service "$payload/deploy/release-broker/gotto-release-broker.service"
install -D deploy/release-broker/gotto-release-broker.tmpfiles "$payload/deploy/release-broker/gotto-release-broker.tmpfiles"
install -D deploy/release-broker/install-release-broker.sh "$payload/deploy/release-broker/install-release-broker.sh"
install -D deploy/release-broker/install-releasebot-client.sh "$payload/deploy/release-broker/install-releasebot-client.sh"
install -D deploy/release-broker/gotto-releasebot-client.tmpfiles "$payload/deploy/release-broker/gotto-releasebot-client.tmpfiles"
install -D deploy/release-broker/network-allowlist.conf.example "$payload/deploy/release-broker/network-allowlist.conf.example"
install -D deploy/release-broker/releasebot-binding/AGENTS.md "$payload/deploy/release-broker/releasebot-binding/AGENTS.md"
install -D deploy/release-broker/verify-release-bundle.py "$payload/deploy/release-broker/verify-release-bundle.py"

find "$payload" -type l -print -quit | grep -q . && {
  printf 'symlink in payload\n' >&2
  exit 1
}
find "$payload" -type d -exec chmod 0555 {} +
find "$payload" -type f -exec chmod 0444 {} +
find "$payload/scripts/release-gates/runtime/bin" -type f -exec chmod 0555 {} +
find "$payload/scripts/release-gates/runtime/lib" -type f -name '*.py' -exec chmod 0555 {} +
find "$payload/scripts/release-gates/admin" -type f -exec chmod 0555 {} +
find "$payload/scripts/release-gates/test" -type f -exec chmod 0555 {} +
chmod 0555 "$payload/scripts/release-gates/build-release-bundle.sh"
chmod 0555 "$payload/packages/release-broker/dist/client-cli.js"

manifest_args=(
  --payload "$payload"
  --output "$staging/manifest.json"
  --generation "$generation"
  --source-commit "$source_commit"
  --built-at "$built_at"
)
[[ -z "$rollback_of" ]] || manifest_args+=(--rollback-of "$rollback_of")
python3 scripts/release-gates/admin/build-manifest.py "${manifest_args[@]}"
openssl pkeyutl -sign -rawin -inkey "$signing_key" \
  -in "$staging/manifest.json" -out "$staging/manifest.json.sig"
chmod 0444 "$staging/manifest.json" "$staging/manifest.json.sig"

mv "$staging" "$output"
trap - EXIT
printf 'release bundle created: %s\n' "$output"
