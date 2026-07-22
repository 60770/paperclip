#!/usr/bin/env python3

import argparse
import hashlib
import os
import stat
import subprocess
from pathlib import Path


RUNTIME_FILES = {
    ".env": 0o600,
    ".warden/runner/authorized_keys": 0o644,
    ".warden/runner/ssh_host_ed25519_key": 0o600,
    ".warden/runner/ssh_host_ed25519_key.pub": 0o644,
}


def fail(message: str) -> None:
    raise SystemExit(f"ERROR: {message}")


def run_git(git_bin: str, repo_dir: str, *args: str) -> bytes:
    result = subprocess.run(
        [
            git_bin,
            "-c",
            f"safe.directory={repo_dir}",
            "-C",
            repo_dir,
            *args,
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        fail(result.stderr.decode("utf-8", "replace").strip() or "Git command failed.")
    return result.stdout


def open_dir_nofollow(path: str) -> int:
    absolute = os.path.abspath(path)
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in Path(absolute).parts[1:]:
            next_descriptor = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def ensure_parent(root_fd: int, parts: list[str]) -> int:
    descriptor = os.dup(root_fd)
    try:
        for component in parts:
            try:
                os.mkdir(component, 0o700, dir_fd=descriptor)
            except FileExistsError:
                pass
            next_descriptor = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def open_parent(root_fd: int, parts: list[str]) -> int:
    descriptor = os.dup(root_fd)
    try:
        for component in parts:
            next_descriptor = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            os.close(descriptor)
            descriptor = next_descriptor
        return descriptor
    except Exception:
        os.close(descriptor)
        raise


def write_file(root_fd: int, relative_path: str, content: bytes, mode: int) -> None:
    parts = relative_path.split("/")
    parent_fd = ensure_parent(root_fd, parts[:-1])
    try:
        descriptor = os.open(
            parts[-1],
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            mode,
            dir_fd=parent_fd,
        )
        try:
            view = memoryview(content)
            while view:
                written = os.write(descriptor, view)
                view = view[written:]
            os.fchmod(descriptor, mode)
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_fd)


def source_fingerprint(file_stat: os.stat_result) -> tuple[int, ...]:
    return (
        file_stat.st_dev,
        file_stat.st_ino,
        file_stat.st_mode,
        file_stat.st_uid,
        file_stat.st_gid,
        file_stat.st_nlink,
        file_stat.st_size,
        file_stat.st_mtime_ns,
        file_stat.st_ctime_ns,
    )


def read_runtime_file(live_fd: int, relative_path: str, expected_mode: int, owner_uid: int) -> tuple[bytes, str]:
    parts = relative_path.split("/")
    parent_fd = open_parent(live_fd, parts[:-1])
    try:
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent_fd)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                fail(f"Runtime path is not a regular file: {relative_path}")
            if stat.S_IMODE(before.st_mode) != expected_mode:
                fail(f"Runtime file mode must be {expected_mode:04o}: {relative_path}")
            if before.st_uid != owner_uid:
                fail(f"Runtime file owner differs from the live root owner: {relative_path}")
            if before.st_nlink != 1:
                fail(f"Runtime file must have exactly one hard link: {relative_path}")
            chunks = []
            digest = hashlib.sha256()
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
                digest.update(chunk)
            after = os.fstat(descriptor)
            if source_fingerprint(before) != source_fingerprint(after):
                fail(f"Runtime file changed while it was copied: {relative_path}")
            return b"".join(chunks), digest.hexdigest()
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_fd)


def freeze_snapshot(snapshot_dir: str) -> None:
    for root, directories, files in os.walk(snapshot_dir, topdown=False, followlinks=False):
        for filename in files:
            path = os.path.join(root, filename)
            file_stat = os.lstat(path)
            if not stat.S_ISREG(file_stat.st_mode):
                fail(f"Snapshot contains a non-regular file: {path}")
            current_mode = stat.S_IMODE(file_stat.st_mode)
            os.chmod(path, 0o555 if current_mode & 0o111 else 0o444)
        for directory in directories:
            path = os.path.join(root, directory)
            if not stat.S_ISDIR(os.lstat(path).st_mode):
                fail(f"Snapshot contains a non-directory: {path}")
            os.chmod(path, 0o555)
    for relative_path in RUNTIME_FILES:
        path = os.path.join(snapshot_dir, relative_path)
        os.chmod(path, 0o400 if RUNTIME_FILES[relative_path] == 0o600 else 0o444)
    os.chmod(snapshot_dir, 0o555)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--git-bin", required=True)
    parser.add_argument("--repo-dir", required=True)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--source-path", required=True)
    parser.add_argument("--live-dir", required=True)
    parser.add_argument("--snapshot-dir", required=True)
    parser.add_argument("--fingerprint-output", required=True)
    args = parser.parse_args()

    snapshot_stat = os.lstat(args.snapshot_dir)
    if not stat.S_ISDIR(snapshot_stat.st_mode) or stat.S_IMODE(snapshot_stat.st_mode) != 0o700:
        fail("Snapshot directory must be a mode-0700 directory.")
    if snapshot_stat.st_uid != os.geteuid():
        fail("Snapshot directory must be owned by the builder identity.")
    if os.listdir(args.snapshot_dir):
        fail("Snapshot directory must be empty.")

    tree = run_git(
        args.git_bin,
        args.repo_dir,
        "ls-tree",
        "-rz",
        "--full-tree",
        args.commit,
        "--",
        args.source_path,
    )
    root_fd = open_dir_nofollow(args.snapshot_dir)
    try:
        tracked_count = 0
        prefix = f"{args.source_path.rstrip('/')}/"
        for record in tree.split(b"\0"):
            if not record:
                continue
            metadata, raw_path = record.split(b"\t", 1)
            mode, object_type, object_id = metadata.decode("ascii").split(" ")
            path = raw_path.decode("utf-8")
            if object_type != "blob" or mode not in {"100644", "100755"}:
                fail(f"Unsupported Git tree entry: {path}")
            if not path.startswith(prefix):
                fail(f"Git tree entry escapes the source path: {path}")
            relative_path = path[len(prefix) :]
            if not relative_path or any(part in {"", ".", ".."} for part in relative_path.split("/")):
                fail(f"Unsafe Git tree entry: {path}")
            content = run_git(args.git_bin, args.repo_dir, "cat-file", "blob", object_id)
            write_file(root_fd, relative_path, content, 0o755 if mode == "100755" else 0o644)
            tracked_count += 1
        if tracked_count == 0:
            fail("Selected commit has no tracked Tester1 Warden files.")

        live_fd = open_dir_nofollow(args.live_dir)
        try:
            live_stat = os.fstat(live_fd)
            fingerprints = []
            for relative_path, expected_mode in RUNTIME_FILES.items():
                content, digest = read_runtime_file(live_fd, relative_path, expected_mode, live_stat.st_uid)
                write_file(root_fd, relative_path, content, expected_mode)
                fingerprints.append(
                    f"{digest} {expected_mode:04o} {live_stat.st_uid} {relative_path}\n"
                )
        finally:
            os.close(live_fd)
    finally:
        os.close(root_fd)

    fingerprint_fd = os.open(
        args.fingerprint_output,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
        0o600,
    )
    try:
        view = memoryview("".join(fingerprints).encode("utf-8"))
        while view:
            written = os.write(fingerprint_fd, view)
            view = view[written:]
    finally:
        os.close(fingerprint_fd)

    freeze_snapshot(args.snapshot_dir)


if __name__ == "__main__":
    main()
