#!/usr/bin/env bash

set -euo pipefail

[[ "${EUID:-$(id -u)}" -eq 0 ]] || {
  printf 'installer must run as root\n' >&2
  exit 1
}
[[ "$#" -eq 1 ]] || {
  printf 'usage: install-release-broker.sh /var/lib/gotto-release-broker-incoming/<bundle>\n' >&2
  exit 2
}

incoming_root="/var/lib/gotto-release-broker-incoming"
bundle="$(realpath -e -- "$1")"
[[ "$bundle" == "$incoming_root/"* && -d "$bundle" && ! -L "$bundle" ]] || {
  printf 'bundle must be a real directory below the fixed incoming root\n' >&2
  exit 2
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
verifier="$script_dir/verify-release-bundle.py"
public_key="/etc/gotto/release-broker/ed25519.pub"
generation_state="/var/lib/gotto-release-broker-control/generation.json"
release_root="/opt/gotto/release-broker"
releases="$release_root/releases"
[[ "$(stat -c '%u:%g:%a' "$public_key")" == "0:0:444" ]] || {
  printf 'invalid public key ownership or mode\n' >&2
  exit 21
}

verification="$(python3 "$verifier" \
  --bundle "$bundle" \
  --public-key "$public_key" \
  --generation-state "$generation_state" \
  --require-new)" || exit 21
generation="$(sed -n 's/.* generation=\([0-9][0-9]*\).*/\1/p' <<<"$verification")"
manifest_sha="$(sha256sum "$bundle/manifest.json" | cut -d' ' -f1)"
[[ "$generation" =~ ^[1-9][0-9]*$ && "$manifest_sha" =~ ^[0-9a-f]{64}$ ]] || exit 21

install -d -o root -g root -m 0555 "$release_root" "$releases"
staging="$(mktemp -d "$releases/.staging.XXXXXX")"
cleanup() {
  if [[ -n "${staging:-}" && -d "$staging" && "$staging" == "$releases/.staging."* ]]; then
    rm -rf -- "$staging"
  fi
}
trap cleanup EXIT
cp -a -- "$bundle/." "$staging/"
chown -R root:root "$staging"
find "$staging" -type d -exec chmod 0555 {} +

python3 "$verifier" \
  --bundle "$staging" \
  --public-key "$public_key" \
  --generation-state "$generation_state" \
  --require-new >/dev/null

python3 - "$staging" <<'PY'
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
for path in sorted(root.rglob("*"), reverse=True):
    if path.is_file():
        descriptor = os.open(path, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
for path in sorted([root, *[item for item in root.rglob("*") if item.is_dir()]], reverse=True):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
PY

release_name="${generation}-${manifest_sha}"
final_release="$releases/$release_name"
[[ ! -e "$final_release" ]] || {
  printf 'generation already installed\n' >&2
  exit 21
}

systemctl stop gotto-release-broker.service
python3 "$verifier" \
  --bundle "$staging" \
  --public-key "$public_key" \
  --generation-state "$generation_state" \
  --require-new \
  --record-generation >/dev/null

mv -- "$staging" "$final_release"
staging=""
ln -s "releases/$release_name" "$release_root/.current.$generation"
mv -Tf -- "$release_root/.current.$generation" "$release_root/current"

generation_config="/etc/gotto/release-broker/.generation.conf.$generation"
printf 'BROKER_GATE_GENERATION=%s\n' "$generation" > "$generation_config"
chown root:root "$generation_config"
chmod 0444 "$generation_config"
mv -Tf -- "$generation_config" /etc/gotto/release-broker/generation.conf

systemctl daemon-reload
systemctl start gotto-release-broker.service
printf 'installed release broker generation %s\n' "$generation"
