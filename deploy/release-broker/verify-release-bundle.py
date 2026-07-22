#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
import subprocess
from datetime import datetime
from pathlib import Path, PurePosixPath


class VerificationError(Exception):
    pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", required=True)
    parser.add_argument("--public-key", required=True)
    parser.add_argument("--generation-state", required=True)
    parser.add_argument("--require-new", action="store_true")
    parser.add_argument("--record-generation", action="store_true")
    args = parser.parse_args()

    try:
        if args.record_generation and not args.require_new:
            raise VerificationError()
        evidence = verify_bundle(
            Path(args.bundle),
            Path(args.public_key),
            Path(args.generation_state),
            args.require_new,
        )
        if args.record_generation:
            record_generation(Path(args.generation_state), evidence)
    except (VerificationError, OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError):
        print("RELEASE_BUNDLE_ERROR reason=verification_failed")
        return 21

    print(
        "RELEASE_BUNDLE_CLEAR"
        f" generation={evidence['generation']}"
        f" manifest={evidence['manifestSha256']}"
        f" source={evidence['sourceCommit']}"
    )
    return 0


def verify_bundle(
    bundle: Path,
    public_key: Path,
    generation_state: Path,
    require_new: bool,
) -> dict[str, object]:
    if bundle.is_symlink() or public_key.is_symlink():
        raise VerificationError()
    bundle = bundle.resolve(strict=True)
    public_key = public_key.resolve(strict=True)
    if not bundle.is_dir() or not public_key.is_file():
        raise VerificationError()

    manifest_path = bundle / "manifest.json"
    signature_path = bundle / "manifest.json.sig"
    payload = bundle / "payload"
    if {path.name for path in bundle.iterdir()} != {"manifest.json", "manifest.json.sig", "payload"}:
        raise VerificationError()
    for path in [manifest_path, signature_path, payload]:
        if path.is_symlink() or not path.exists():
            raise VerificationError()
    if stat.S_IMODE(manifest_path.stat().st_mode) != 0o444 or stat.S_IMODE(signature_path.stat().st_mode) != 0o444:
        raise VerificationError()

    subprocess.run(
        [
            "openssl",
            "pkeyutl",
            "-verify",
            "-pubin",
            "-inkey",
            str(public_key),
            "-sigfile",
            str(signature_path),
            "-rawin",
            "-in",
            str(manifest_path),
        ],
        check=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=15,
    )

    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    validate_manifest(manifest)
    canonical = (json.dumps(manifest, sort_keys=False, separators=(",", ":")) + "\n").encode()
    if canonical != manifest_bytes:
        raise VerificationError()
    verify_inventory(payload, manifest["files"])

    state = read_generation_state(generation_state)
    generation = manifest["generation"]
    if require_new and generation <= state["generation"]:
        raise VerificationError()
    if not require_new and generation != state["generation"]:
        raise VerificationError()

    return {
        "generation": generation,
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "sourceCommit": manifest["sourceCommit"],
    }


def validate_manifest(manifest: object) -> None:
    if not isinstance(manifest, dict):
        raise VerificationError()
    allowed = {"schemaVersion", "generation", "sourceCommit", "builtAt", "rollbackOf", "files"}
    required = allowed - {"rollbackOf"}
    if set(manifest) - allowed or not required.issubset(manifest):
        raise VerificationError()
    if manifest["schemaVersion"] != 1:
        raise VerificationError()
    generation = manifest["generation"]
    if not isinstance(generation, int) or isinstance(generation, bool) or generation <= 0:
        raise VerificationError()
    source_commit = manifest["sourceCommit"]
    if not isinstance(source_commit, str) or len(source_commit) != 40 or any(
        character not in "0123456789abcdef" for character in source_commit
    ):
        raise VerificationError()
    if not isinstance(manifest["builtAt"], str) or not manifest["builtAt"]:
        raise VerificationError()
    try:
        datetime.fromisoformat(manifest["builtAt"].replace("Z", "+00:00"))
    except ValueError as error:
        raise VerificationError() from error
    rollback_of = manifest.get("rollbackOf")
    if rollback_of is not None and (
        not isinstance(rollback_of, int)
        or isinstance(rollback_of, bool)
        or rollback_of <= 0
        or rollback_of >= generation
    ):
        raise VerificationError()
    files = manifest["files"]
    if not isinstance(files, list) or not files:
        raise VerificationError()
    paths: list[str] = []
    for entry in files:
        if not isinstance(entry, dict) or set(entry) != {"path", "sha256", "mode"}:
            raise VerificationError()
        path = entry["path"]
        digest = entry["sha256"]
        mode = entry["mode"]
        if (
            not isinstance(path, str)
            or not valid_relative_path(path)
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
            or mode not in {"0444", "0555"}
        ):
            raise VerificationError()
        paths.append(path)
    if paths != sorted(paths) or len(paths) != len(set(paths)):
        raise VerificationError()


def valid_relative_path(value: str) -> bool:
    path = PurePosixPath(value)
    return (
        0 < len(value) <= 240
        and not path.is_absolute()
        and ".." not in path.parts
        and str(path) == value
        and "\\" not in value
        and "\0" not in value
    )


def verify_inventory(payload: Path, expected: list[dict[str, str]]) -> None:
    actual: list[str] = []
    for root, directories, filenames in os.walk(payload, followlinks=False):
        directories.sort()
        filenames.sort()
        root_path = Path(root)
        for name in [*directories, *filenames]:
            if (root_path / name).is_symlink():
                raise VerificationError()
        for name in filenames:
            path = root_path / name
            if not path.is_file():
                raise VerificationError()
            actual.append(path.relative_to(payload).as_posix())
    actual.sort()
    expected_paths = [entry["path"] for entry in expected]
    if actual != expected_paths:
        raise VerificationError()

    for entry in expected:
        path = payload.joinpath(*PurePosixPath(entry["path"]).parts)
        metadata = path.stat(follow_symlinks=False)
        mode = f"0{stat.S_IMODE(metadata.st_mode):o}"
        if mode != entry["mode"]:
            raise VerificationError()
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise VerificationError()


def read_generation_state(path: Path) -> dict[str, object]:
    if not path.exists():
        return {"generation": 0, "manifestSha256": ""}
    if path.is_symlink() or not path.is_file():
        raise VerificationError()
    state = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(state, dict) or set(state) != {"generation", "manifestSha256"}:
        raise VerificationError()
    if not isinstance(state["generation"], int) or state["generation"] < 0:
        raise VerificationError()
    manifest_sha = state["manifestSha256"]
    if not isinstance(manifest_sha, str) or (
        state["generation"] > 0
        and (len(manifest_sha) != 64 or any(character not in "0123456789abcdef" for character in manifest_sha))
    ):
        raise VerificationError()
    return state


def record_generation(path: Path, evidence: dict[str, object]) -> None:
    path.parent.mkdir(mode=0o555, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    data = json.dumps(
        {
            "generation": evidence["generation"],
            "manifestSha256": evidence["manifestSha256"],
        },
        separators=(",", ":"),
    ) + "\n"
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o444)
    try:
        os.write(descriptor, data.encode())
        os.fchmod(descriptor, 0o444)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, path)
    directory_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


if __name__ == "__main__":
    raise SystemExit(main())
