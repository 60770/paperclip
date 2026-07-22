#!/usr/bin/env python3

import argparse
import hashlib
import os
import re
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
    git_env = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    git_env.update(
        {
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_OPTIONAL_LOCKS": "0",
        }
    )
    result = subprocess.run(
        [
            git_bin,
            "--no-replace-objects",
            "-c",
            f"safe.directory={repo_dir}",
            "-C",
            repo_dir,
            *args,
        ],
        check=False,
        env=git_env,
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


def read_runtime_expectations(path: str) -> dict[str, tuple[str, int, int]]:
    absolute = os.path.abspath(path)
    parent_fd = open_dir_nofollow(os.path.dirname(absolute))
    try:
        descriptor = os.open(
            os.path.basename(absolute),
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=parent_fd,
        )
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                fail("Runtime fingerprint manifest is not a regular file.")
            if stat.S_IMODE(before.st_mode) != 0o600:
                fail("Runtime fingerprint manifest must have mode 0600.")
            if before.st_uid != os.geteuid():
                fail(
                    "Runtime fingerprint manifest must be owned by the builder identity."
                )
            if before.st_nlink != 1:
                fail("Runtime fingerprint manifest must have exactly one hard link.")
            chunks = []
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                chunks.append(chunk)
            after = os.fstat(descriptor)
            if source_fingerprint(before) != source_fingerprint(after):
                fail("Runtime fingerprint manifest changed while it was read.")
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_fd)

    try:
        lines = b"".join(chunks).decode("ascii").splitlines()
    except UnicodeDecodeError:
        fail("Runtime fingerprint manifest must be ASCII.")
    expectations: dict[str, tuple[str, int, int]] = {}
    for line in lines:
        match = re.fullmatch(
            r"([0-9a-f]{64}) (0[0-7]{3}) ([0-9]+) ([A-Za-z0-9._/-]+)",
            line,
        )
        if match is None:
            fail(f"Malformed runtime fingerprint line: {line}")
        digest, mode_text, uid_text, relative_path = match.groups()
        if relative_path not in RUNTIME_FILES:
            fail(f"Unexpected runtime fingerprint path: {relative_path}")
        if relative_path in expectations:
            fail(f"Duplicate runtime fingerprint path: {relative_path}")
        expected_mode = int(mode_text, 8)
        if expected_mode != RUNTIME_FILES[relative_path]:
            fail(
                f"Runtime fingerprint mode must be {RUNTIME_FILES[relative_path]:04o}: "
                f"{relative_path}"
            )
        expectations[relative_path] = (digest, expected_mode, int(uid_text))
    if set(expectations) != set(RUNTIME_FILES):
        fail("Runtime fingerprint manifest must name exactly the four runtime inputs.")
    return expectations


def read_runtime_file(
    live_fd: int,
    relative_path: str,
    expected_digest: str,
    expected_mode: int,
    expected_uid: int,
) -> tuple[bytes, str]:
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
            if before.st_uid != expected_uid:
                fail(
                    f"Runtime file owner differs from the custodied fingerprint: {relative_path}"
                )
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
            actual_digest = digest.hexdigest()
            if actual_digest != expected_digest:
                fail(
                    f"Runtime file digest differs from the custodied fingerprint: {relative_path}"
                )
            return b"".join(chunks), actual_digest
        finally:
            os.close(descriptor)
    finally:
        os.close(parent_fd)


def freeze_snapshot(snapshot_dir: str) -> None:
    for root, directories, files in os.walk(
        snapshot_dir, topdown=False, followlinks=False
    ):
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
    parser.add_argument("--runtime-fingerprints", required=True)
    parser.add_argument("--fingerprint-output", required=True)
    args = parser.parse_args()

    snapshot_stat = os.lstat(args.snapshot_dir)
    if (
        not stat.S_ISDIR(snapshot_stat.st_mode)
        or stat.S_IMODE(snapshot_stat.st_mode) != 0o700
    ):
        fail("Snapshot directory must be a mode-0700 directory.")
    if snapshot_stat.st_uid != os.geteuid():
        fail("Snapshot directory must be owned by the builder identity.")
    if os.listdir(args.snapshot_dir):
        fail("Snapshot directory must be empty.")

    runtime_expectations = read_runtime_expectations(args.runtime_fingerprints)

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
            if not relative_path or any(
                part in {"", ".", ".."} for part in relative_path.split("/")
            ):
                fail(f"Unsafe Git tree entry: {path}")
            content = run_git(
                args.git_bin, args.repo_dir, "cat-file", "blob", object_id
            )
            write_file(
                root_fd, relative_path, content, 0o755 if mode == "100755" else 0o644
            )
            tracked_count += 1
        if tracked_count == 0:
            fail("Selected commit has no tracked Tester1 Warden files.")

        live_fd = open_dir_nofollow(args.live_dir)
        try:
            fingerprints = []
            for relative_path in RUNTIME_FILES:
                expected_digest, expected_mode, expected_uid = runtime_expectations[
                    relative_path
                ]
                content, digest = read_runtime_file(
                    live_fd,
                    relative_path,
                    expected_digest,
                    expected_mode,
                    expected_uid,
                )
                write_file(root_fd, relative_path, content, expected_mode)
                fingerprints.append(
                    f"{digest} {expected_mode:04o} {expected_uid} {relative_path}\n"
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
