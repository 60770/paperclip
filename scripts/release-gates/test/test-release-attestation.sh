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
saved_umask="$(umask)"
umask 077
python3 "$repo_root/deploy/release-broker/verify-release-bundle.py" \
  --bundle "$scratch/valid/bundle" \
  --public-key "$scratch/public.pem" \
  --generation-state "$scratch/valid/state/generation.json" \
  --require-new \
  --record-generation >/dev/null
umask "$saved_umask"
python3 - "$scratch/valid/state/generation.json" <<'PY'
import stat
import sys
from pathlib import Path

path = Path(sys.argv[1])
if stat.S_IMODE(path.stat().st_mode) != 0o444:
    raise SystemExit("generation state mode is not 0444")
if not path.stat().st_mode & stat.S_IROTH:
    raise SystemExit("generation state is not readable by the service principal")
if not path.parent.stat().st_mode & stat.S_IXOTH:
    raise SystemExit("generation state directory is not traversable by the service principal")
PY
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

printf 'fixture-key\n' > "$scratch/paperclip-api-key"
set +e
resolver_output="$(
  BROKER_RELEASE_BOT_AGENT_ID=cf440f88-ba64-4173-80c3-371b44916c04 \
  PAPERCLIP_API_URL=https://127.0.0.1:1 \
  PAPERCLIP_API_KEY_FILE="$scratch/paperclip-api-key" \
  "$repo_root/scripts/release-gates/runtime/bin/release-main-lock-resolver.sh" 2>&1
)"
resolver_status="$?"
set -e
[[ "$resolver_status" -eq 21 && "$resolver_output" == MAIN_LOCK_ERROR\ reason=* ]] || {
  printf 'main-lock wrapper did not invoke the bundled resolver\n' >&2
  exit 1
}

set +e
resolver_output="$(
  BROKER_RELEASE_BOT_AGENT_ID=not-a-uuid \
  PAPERCLIP_API_URL=https://127.0.0.1:1 \
  PAPERCLIP_API_KEY_FILE="$scratch/paperclip-api-key" \
  "$repo_root/scripts/release-gates/runtime/bin/release-main-lock-resolver.sh" 2>&1
)"
resolver_status="$?"
set -e
[[ "$resolver_status" -eq 21 && "$resolver_output" == "MAIN_LOCK_ERROR reason=invalid_release_bot_agent_id" ]] || {
  printf 'main-lock resolver accepted an invalid ReleaseBot id\n' >&2
  exit 1
}

python3 - "$repo_root/scripts/release-gates/runtime/lib/release_main_lock_resolver.py" <<'PY'
import importlib.util
import sys
from datetime import datetime, timezone

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("release_main_lock_resolver", sys.argv[1])
resolver = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = resolver
spec.loader.exec_module(resolver)

configured_id = "11111111-1111-4111-8111-111111111111"
other_id = "22222222-2222-4222-8222-222222222222"
locked_at = datetime(2026, 7, 22, 12, 0, tzinfo=timezone.utc)
unlocked_at = datetime(2026, 7, 22, 12, 1, tzinfo=timezone.utc)
lock = resolver.MarkerEvent("lock", locked_at, "2026-07-22T12:00:00.000Z", "lock", 0, "GOT-2298")
unlock = resolver.MarkerEvent(
    "unlock",
    unlocked_at,
    "2026-07-22T12:01:00.000Z",
    "unlock",
    0,
    author_type="agent",
    author_agent_id=other_id,
)

class Client:
    def get_agent_role(self, agent_id):
        return "engineer"

if resolver.resolve_active_lock([lock, unlock], Client(), configured_id) != lock:
    raise SystemExit("mismatched ReleaseBot id cleared the main lock")
if resolver.resolve_active_lock([lock, unlock], Client(), other_id) is not None:
    raise SystemExit("configured ReleaseBot id did not clear the main lock")
PY

grep -Fq 'and (($completed | length) == 1)' \
  "$repo_root/scripts/release-gates/runtime/bin/release-human-gate-preflight.sh" || {
  printf 'human gate completed-stage cardinality guard missing\n' >&2
  exit 1
}

grep -Fq 'CI=1 NODE_ENV=development pnpm install --frozen-lockfile --lockfile-only' \
  "$repo_root/scripts/release-gates/build-release-bundle.sh" || {
  printf 'release bundle frozen-lockfile gate missing\n' >&2
  exit 1
}

printf 'release attestation regression: ok\n'
