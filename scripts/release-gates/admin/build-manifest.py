#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import json
import os
import stat
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--generation", required=True, type=int)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--built-at", required=True)
    parser.add_argument("--rollback-of", type=int)
    args = parser.parse_args()

    payload = Path(args.payload).resolve(strict=True)
    if args.generation <= 0 or len(args.source_commit) != 40 or any(
        character not in "0123456789abcdef" for character in args.source_commit
    ):
        raise SystemExit("invalid manifest identity")

    files: list[dict[str, object]] = []
    for root, directories, filenames in os.walk(payload, followlinks=False):
        directories.sort()
        filenames.sort()
        root_path = Path(root)
        for name in [*directories, *filenames]:
            candidate = root_path / name
            if candidate.is_symlink():
                raise SystemExit("symlink denied")
        for name in filenames:
            path = root_path / name
            mode = stat.S_IMODE(path.stat(follow_symlinks=False).st_mode)
            if mode not in {0o444, 0o555} or not path.is_file():
                raise SystemExit("invalid payload mode or type")
            relative = path.relative_to(payload).as_posix()
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            files.append({"path": relative, "sha256": digest, "mode": f"0{mode:o}"})

    manifest: dict[str, object] = {
        "schemaVersion": 1,
        "generation": args.generation,
        "sourceCommit": args.source_commit,
        "builtAt": args.built_at,
        "files": sorted(files, key=lambda item: str(item["path"])),
    }
    if args.rollback_of is not None:
        if args.rollback_of <= 0 or args.rollback_of >= args.generation:
            raise SystemExit("invalid rollback generation")
        manifest["rollbackOf"] = args.rollback_of

    encoded = json.dumps(manifest, sort_keys=False, separators=(",", ":")) + "\n"
    Path(args.output).write_text(encoded, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
