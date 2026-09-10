#!/usr/bin/env python3
"""Prepare and run one fail-closed, diagnostic-only CLI lane verification.

Preparation is deliberately separate from execution.  ``prepare`` materializes
the exact candidate, dependencies, and dist without contacting Docker.
``execute`` requires the checksum of that preparation and an explicit literal
authorization.  It then obtains a fresh PlanReady population, maps frozen
claims structurally, and runs only an exactly representable range population.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import tarfile
import time
from collections import Counter
from pathlib import Path
from types import ModuleType
from typing import Any


PREPARATION_PIN_PATHS = frozenset(
    {
        "extract-dependencies.mjs",
        "local-small-packages-inputs/dependencies/dependencies.json",
        "notebook-baselines-1/cli/stryker.config.json",
    }
)
DEPENDENCY_MANIFEST = "local-small-packages-inputs/dependencies/dependencies.json"
EXPECTED_DEPENDENCY_ARCHIVES = 11
EXPECTED_NODE_VERSION = "v24.15.0"
EXPECTED_DEPENDENCY_INPUTS = 13
EXPECTED_DEPENDENCY_WORKSPACES = 10
BOUND_EXECUTABLES: dict[str, dict[str, str]] = {}


class Refusal(RuntimeError):
    """A closed diagnostic boundary."""


def canonical(value: object) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode()


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json_exclusive(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("xb") as stream:
        stream.write(canonical(value))
        stream.flush()
        os.fsync(stream.fileno())


def replace_json(path: Path, value: object) -> None:
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("xb") as stream:
        stream.write(canonical(value))
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def regular_file(path: Path, expected: str, code: str) -> None:
    try:
        mode = path.lstat().st_mode
    except FileNotFoundError as error:
        raise Refusal(code) from error
    if path.is_symlink() or not stat.S_ISREG(mode) or sha_file(path) != expected:
        raise Refusal(code)


def safe_relative_name(value: object, code: str) -> str:
    if not isinstance(value, str) or not value:
        raise Refusal(code)
    if "\\" in value or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise Refusal(code)
    path = Path(value)
    if path.is_absolute() or ".." in path.parts or path.as_posix() != value:
        raise Refusal(code)
    return value


def materialization_entries(root: Path) -> list[dict[str, object]]:
    if root.is_symlink() or not root.is_dir():
        raise Refusal("MATERIALIZATION_ROOT_INVALID")
    entries: list[dict[str, object]] = []

    def visit(directory: Path, relative: Path) -> None:
        try:
            children = sorted(directory.iterdir(), key=lambda item: item.name)
        except OSError as error:
            raise Refusal("MATERIALIZATION_WALK_FAILED") from error
        for child in children:
            child_relative = relative / child.name
            try:
                mode = child.lstat().st_mode
            except OSError as error:
                raise Refusal("MATERIALIZATION_WALK_FAILED") from error
            common: dict[str, object] = {
                "path": child_relative.as_posix(),
                "mode": stat.S_IMODE(mode),
            }
            if stat.S_ISLNK(mode):
                try:
                    resolved = child.resolve(strict=True)
                except (OSError, RuntimeError) as error:
                    raise Refusal("MATERIALIZATION_SYMLINK_INVALID") from error
                if not resolved.is_relative_to(root.resolve()):
                    raise Refusal("MATERIALIZATION_SYMLINK_ESCAPES_ROOT")
                entries.append({**common, "kind": "symlink", "target": os.readlink(child)})
            elif stat.S_ISDIR(mode):
                entries.append({**common, "kind": "directory"})
                visit(child, child_relative)
            elif stat.S_ISREG(mode):
                entries.append(
                    {
                        **common,
                        "kind": "file",
                        "bytes": child.stat().st_size,
                        "sha256": sha_file(child),
                    }
                )
            else:
                raise Refusal("MATERIALIZATION_SPECIAL_MEMBER_REFUSED")

    visit(root, Path())
    return entries


def write_materialization_manifest(
    path: Path, candidate_root: Path, candidate: str, tree: str
) -> str:
    entries = materialization_entries(candidate_root)
    value = {
        "kind": "diagnostic-cli-execution-materialization",
        "version": 1,
        "candidate": candidate,
        "tree": tree,
        "excluded": [],
        "population": {
            "count": len(entries),
            "sha256": sha_bytes(canonical(entries)),
        },
        "entries": entries,
    }
    write_json_exclusive(path, value)
    return sha_file(path)


def verify_materialization_manifest(
    path: Path,
    expected_sha256: str,
    candidate_root: Path,
    candidate: str,
    tree: str,
) -> None:
    regular_file(path, expected_sha256, "MATERIALIZATION_MANIFEST_BINDING_INVALID")
    value = load_json(path, "MATERIALIZATION_MANIFEST_INVALID")
    entries = materialization_entries(candidate_root)
    if (
        value.get("kind") != "diagnostic-cli-execution-materialization"
        or value.get("version") != 1
        or value.get("candidate") != candidate
        or value.get("tree") != tree
        or value.get("excluded") != []
        or value.get("entries") != entries
        or value.get("population")
        != {"count": len(entries), "sha256": sha_bytes(canonical(entries))}
    ):
        raise Refusal("EXECUTION_MATERIALIZATION_CHANGED")


def parse_bound_file(value: str, code: str) -> tuple[Path, str]:
    parts = value.rsplit("=", 1)
    if len(parts) != 2 or not re.fullmatch(r"[a-f0-9]{64}", parts[1]):
        raise Refusal(code)
    path = Path(parts[0]).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    regular_file(path, parts[1], code)
    return path.resolve(), parts[1]


def parse_retained(value: str) -> tuple[str, Path, str]:
    parts = value.rsplit("=", 2)
    if len(parts) != 3 or not parts[0] or not re.fullmatch(r"[a-f0-9]{64}", parts[2]):
        raise Refusal("FROZEN_RETENTION_BINDING_INVALID")
    path = Path(parts[1]).expanduser()
    if not path.is_absolute():
        path = Path.cwd() / path
    completion = path / "retention-completion.json"
    regular_file(completion, parts[2], "FROZEN_RETENTION_BINDING_INVALID")
    if path.is_symlink() or not path.is_dir():
        raise Refusal("FROZEN_RETENTION_BINDING_INVALID")
    return parts[0], path.resolve(), parts[2]


def executable(name: str) -> str:
    binding = BOUND_EXECUTABLES.get(name)
    if not isinstance(binding, dict):
        raise Refusal("PREPARATION_EXECUTABLE_BINDING_MISSING")
    path = Path(str(binding.get("path")))
    regular_file(path, str(binding.get("sha256")), "PREPARATION_EXECUTABLE_CHANGED")
    return str(path)


def executable_binding(path: Path, expected: str) -> dict[str, object]:
    regular_file(path, expected, "PREPARATION_EXECUTABLE_CHANGED")
    state = path.stat()
    return {
        "path": str(path),
        "sha256": expected,
        "device": state.st_dev,
        "inode": state.st_ino,
        "mode": stat.S_IMODE(state.st_mode),
        "uid": state.st_uid,
    }


def activate_executables(bindings: object) -> None:
    if not isinstance(bindings, dict) or set(bindings) != {"git", "node"}:
        raise Refusal("PREPARATION_EXECUTABLE_BINDING_INVALID")
    checked: dict[str, dict[str, str]] = {}
    for name in ("git", "node"):
        item = bindings.get(name)
        if not isinstance(item, dict) or set(item) != {
            "path", "sha256", "device", "inode", "mode", "uid"
        }:
            raise Refusal("PREPARATION_EXECUTABLE_BINDING_INVALID")
        path = Path(str(item.get("path")))
        expected = str(item.get("sha256"))
        if not path.is_absolute() or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise Refusal("PREPARATION_EXECUTABLE_BINDING_INVALID")
        if executable_binding(path, expected) != item:
            raise Refusal("PREPARATION_EXECUTABLE_CHANGED")
        if name == "git" and (
            item.get("uid") != 0 or int(item.get("mode", 0)) & 0o022
        ):
            raise Refusal("PREPARATION_GIT_TRUST_INVALID")
        checked[name] = dict(item)
    BOUND_EXECUTABLES.clear()
    BOUND_EXECUTABLES.update(checked)


def git(repo: Path, *args: str) -> str:
    binary = executable("git")
    result = subprocess.run([binary, "-C", str(repo), *args], capture_output=True, check=False)
    executable("git")
    if result.returncode:
        raise Refusal(f"GIT_COMMAND_FAILED:{' '.join(args)}")
    return result.stdout.decode().strip()


def bind_candidate(repo: Path, candidate: str, tree: str) -> None:
    if not re.fullmatch(r"[a-f0-9]{40}", candidate) or not re.fullmatch(r"[a-f0-9]{40}", tree):
        raise Refusal("FINAL_CANDIDATE_TREE_BINDING_INVALID")
    if git(repo, "rev-parse", "--verify", f"{candidate}^{{commit}}") != candidate:
        raise Refusal("FINAL_CANDIDATE_TREE_BINDING_INVALID")
    if git(repo, "rev-parse", f"{candidate}^{{tree}}") != tree:
        raise Refusal("FINAL_CANDIDATE_TREE_BINDING_INVALID")


def load_json(path: Path, code: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_bytes())
    except Exception as error:
        raise Refusal(code) from error
    if not isinstance(value, dict):
        raise Refusal(code)
    return value


def regular_path_beneath(base: Path, relative: str, code: str) -> Path:
    try:
        base_mode = base.lstat().st_mode
    except OSError as error:
        raise Refusal(code) from error
    if stat.S_ISLNK(base_mode) or not stat.S_ISDIR(base_mode):
        raise Refusal(code)
    base = base.resolve(strict=True)
    path = base.joinpath(*Path(relative).parts)
    current = base
    try:
        for part in Path(relative).parts:
            current = current / part
            mode = current.lstat().st_mode
            if stat.S_ISLNK(mode):
                raise Refusal(code)
        resolved = path.resolve(strict=True)
    except OSError as error:
        raise Refusal(code) from error
    if not resolved.is_relative_to(base) or not stat.S_ISREG(path.lstat().st_mode):
        raise Refusal(code)
    return path


def resolve_preparation_pins_at_base(
    base: Path, pins: object
) -> list[dict[str, str]]:
    if not isinstance(pins, dict) or set(pins) != PREPARATION_PIN_PATHS:
        raise Refusal("PREPARATION_PIN_POPULATION_INVALID")
    try:
        mode = base.lstat().st_mode
    except OSError as error:
        raise Refusal("PREPARATION_PIN_ROOT_INVALID") from error
    if stat.S_ISLNK(mode) or not stat.S_ISDIR(mode):
        raise Refusal("PREPARATION_PIN_ROOT_INVALID")
    base = base.resolve(strict=True)
    resolved: list[dict[str, str]] = []
    for relative in sorted(PREPARATION_PIN_PATHS):
        expected = pins.get(relative)
        if not isinstance(expected, str) or not re.fullmatch(r"[a-f0-9]{64}", expected):
            raise Refusal("PREPARATION_PIN_BINDING_INVALID")
        path = regular_path_beneath(base, relative, "PREPARATION_PIN_PATH_ESCAPE")
        regular_file(path, expected, "PREPARATION_PIN_BINDING_INVALID")
        resolved.append(
            {
                "relativePath": relative,
                "path": str(path.resolve()),
                "sha256": expected,
            }
        )
    return resolved


def resolve_preparation_pins(
    runner_path: Path, pins: object
) -> list[dict[str, str]]:
    return resolve_preparation_pins_at_base(runner_path.parent, pins)


def revalidate_preparation_pins(
    inputs: dict[str, Any], config: dict[str, Any]
) -> list[dict[str, str]]:
    runner = inputs.get("runner")
    if not isinstance(runner, dict) or not isinstance(runner.get("path"), str):
        raise Refusal("PREPARATION_PIN_INPUT_BINDING_INVALID")
    resolved = resolve_preparation_pins(
        Path(runner["path"]), config.get("preparation_pins")
    )
    if inputs.get("preparationPins") != resolved:
        raise Refusal("PREPARATION_PIN_INPUT_BINDING_INVALID")
    return resolved


def basename_field(value: object, code: str) -> str:
    if (
        not isinstance(value, str)
        or not value
        or Path(value).name != value
        or value in {".", ".."}
        or "/" in value
        or "\\" in value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
    ):
        raise Refusal(code)
    return value


def node_version() -> str:
    binary = executable("node")
    result = subprocess.run([binary, "--version"], capture_output=True, check=False)
    executable("node")
    if result.returncode:
        raise Refusal("PREPARATION_NODE_VERSION_INVALID")
    try:
        value = result.stdout.decode().strip()
    except UnicodeDecodeError as error:
        raise Refusal("PREPARATION_NODE_VERSION_INVALID") from error
    if value != EXPECTED_NODE_VERSION:
        raise Refusal("PREPARATION_NODE_VERSION_INVALID")
    return value


def sha_from_git(repo: Path, candidate: str, relative: str) -> str:
    binary = executable("git")
    result = subprocess.run(
        [binary, "-C", str(repo), "show", f"{candidate}:{relative}"],
        capture_output=True,
        check=False,
    )
    executable("git")
    if result.returncode:
        raise Refusal("PREPARATION_DEPENDENCY_INPUT_INVALID")
    return sha_bytes(result.stdout)


def validate_dependency_control(
    base: Path, config: dict[str, Any], repo: Path, candidate: str, tree: str
) -> list[str]:
    manifest_path = regular_path_beneath(
        base, DEPENDENCY_MANIFEST, "PREPARATION_DEPENDENCY_MANIFEST_INVALID"
    )
    manifest = load_json(manifest_path, "PREPARATION_DEPENDENCY_MANIFEST_INVALID")
    if (
        manifest.get("protocol") != "devai.protected-linux-dependencies.v1"
        or manifest.get("offline_rebuild_identical") is not True
        or not re.fullmatch(r"[a-f0-9]{64}", str(manifest.get("identity_sha256")))
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(manifest.get("image")))
    ):
        raise Refusal("PREPARATION_DEPENDENCY_MANIFEST_INVALID")
    inputs = manifest.get("inputs")
    files = inputs.get("files") if isinstance(inputs, dict) else None
    workspaces = inputs.get("workspace_packages") if isinstance(inputs, dict) else None
    if (
        not isinstance(files, list)
        or len(files) != EXPECTED_DEPENDENCY_INPUTS
        or not isinstance(workspaces, list)
        or len(workspaces) != EXPECTED_DEPENDENCY_WORKSPACES
    ):
        raise Refusal("PREPARATION_DEPENDENCY_INPUT_INVALID")
    seen_inputs: set[str] = set()
    input_hashes: dict[str, str] = {}
    for item in files:
        if not isinstance(item, dict):
            raise Refusal("PREPARATION_DEPENDENCY_INPUT_INVALID")
        relative = safe_relative_name(
            item.get("path"), "PREPARATION_DEPENDENCY_INPUT_INVALID"
        )
        expected = item.get("sha256")
        if (
            relative in seen_inputs
            or not re.fullmatch(r"[a-f0-9]{64}", str(expected))
            or sha_from_git(repo, candidate, relative) != expected
        ):
            raise Refusal("PREPARATION_DEPENDENCY_INPUT_INVALID")
        seen_inputs.add(relative)
        input_hashes[relative] = str(expected)
    seen_workspaces: set[str] = set()
    seen_workspace_names: set[str] = set()
    for item in workspaces:
        if not isinstance(item, dict):
            raise Refusal("PREPARATION_DEPENDENCY_INPUT_INVALID")
        path = safe_relative_name(
            item.get("path"), "PREPARATION_DEPENDENCY_INPUT_INVALID"
        )
        manifest_name = f"{path}/package.json"
        if (
            path in seen_workspaces
            or not isinstance(item.get("name"), str)
            or not item.get("name")
            or item.get("name") in seen_workspace_names
            or item.get("manifest_sha256") != input_hashes.get(manifest_name)
        ):
            raise Refusal("PREPARATION_DEPENDENCY_INPUT_INVALID")
        git_binary = executable("git")
        manifest_bytes = subprocess.run(
            [git_binary, "-C", str(repo), "show", f"{candidate}:{manifest_name}"],
            capture_output=True,
            check=False,
        )
        executable("git")
        try:
            package_name = json.loads(manifest_bytes.stdout).get("name")
        except Exception as error:
            raise Refusal("PREPARATION_DEPENDENCY_INPUT_INVALID") from error
        if manifest_bytes.returncode or package_name != item.get("name"):
            raise Refusal("PREPARATION_DEPENDENCY_INPUT_INVALID")
        seen_workspaces.add(path)
        seen_workspace_names.add(str(item.get("name")))
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, list) or len(artifacts) != EXPECTED_DEPENDENCY_ARCHIVES:
        raise Refusal("PREPARATION_DEPENDENCY_ARTIFACT_POPULATION_INVALID")
    archive_paths: list[str] = []
    seen_archives: set[str] = set()
    seen_mounts: set[str] = set()
    dependency_root = Path(DEPENDENCY_MANIFEST).parent
    for artifact in artifacts:
        if not isinstance(artifact, dict):
            raise Refusal("PREPARATION_DEPENDENCY_ARTIFACT_INVALID")
        name = basename_field(
            artifact.get("file"), "PREPARATION_DEPENDENCY_ARTIFACT_INVALID"
        )
        mount = safe_relative_name(
            artifact.get("mount_path"), "PREPARATION_DEPENDENCY_ARTIFACT_INVALID"
        )
        expected = artifact.get("sha256")
        expected_bytes = artifact.get("size_bytes")
        regular_files = artifact.get("regular_files")
        links = artifact.get("links")
        relative = (dependency_root / name).as_posix()
        if (
            name in seen_archives
            or mount in seen_mounts
            or not re.fullmatch(r"[a-f0-9]{64}", str(expected))
            or not isinstance(expected_bytes, int)
            or expected_bytes <= 0
            or not isinstance(regular_files, int)
            or regular_files < 0
            or not isinstance(links, int)
            or links < 0
        ):
            raise Refusal("PREPARATION_DEPENDENCY_ARTIFACT_INVALID")
        path = regular_path_beneath(
            base, relative, "PREPARATION_DEPENDENCY_ARTIFACT_INVALID"
        )
        if path.stat().st_size != expected_bytes:
            raise Refusal("PREPARATION_DEPENDENCY_ARTIFACT_INVALID")
        regular_file(path, str(expected), "PREPARATION_DEPENDENCY_ARTIFACT_INVALID")
        seen_archives.add(name)
        seen_mounts.add(mount)
        archive_paths.append(relative)
    return archive_paths


def validate_dist_control(
    base: Path, config: dict[str, Any], candidate: str, tree: str
) -> list[str]:
    archive_name = basename_field(
        config.get("current_dist_archive"), "PREPARATION_DIST_NAME_INVALID"
    )
    manifest_name = basename_field(
        config.get("current_dist_manifest_path"), "PREPARATION_DIST_NAME_INVALID"
    )
    archive_sha = config.get("current_dist_archive_sha256")
    manifest_sha = config.get("current_dist_manifest_sha256")
    if not re.fullmatch(r"[a-f0-9]{64}", str(archive_sha)) or not re.fullmatch(
        r"[a-f0-9]{64}", str(manifest_sha)
    ):
        raise Refusal("PREPARATION_DIST_BINDING_INVALID")
    archive = regular_path_beneath(
        base, archive_name, "PREPARATION_DIST_BINDING_INVALID"
    )
    manifest_path = regular_path_beneath(
        base, manifest_name, "PREPARATION_DIST_BINDING_INVALID"
    )
    regular_file(archive, str(archive_sha), "PREPARATION_DIST_BINDING_INVALID")
    regular_file(manifest_path, str(manifest_sha), "PREPARATION_DIST_BINDING_INVALID")
    manifest = load_json(manifest_path, "PREPARATION_DIST_MANIFEST_INVALID")
    members = manifest.get("members")
    if (
        manifest.get("candidate") != candidate
        or manifest.get("tree") != tree
        or manifest.get("archiveSha256") != archive_sha
        or not isinstance(members, dict)
        or not members
    ):
        raise Refusal("PREPARATION_DIST_MANIFEST_INVALID")
    seen: set[str] = set()
    try:
        with tarfile.open(archive, "r:gz") as bundle:
            for member in bundle.getmembers():
                relative = Path(member.name)
                declared = members.get(member.name)
                if (
                    not member.isfile()
                    or relative.is_absolute()
                    or ".." in relative.parts
                    or len(relative.parts) < 4
                    or relative.parts[0] != "packages"
                    or relative.parts[2] != "dist"
                    or member.name in seen
                    or not isinstance(declared, dict)
                ):
                    raise Refusal("PREPARATION_DIST_ARCHIVE_INVALID")
                extracted = bundle.extractfile(member)
                if extracted is None:
                    raise Refusal("PREPARATION_DIST_ARCHIVE_INVALID")
                content = extracted.read()
                if (
                    declared.get("bytes") != len(content)
                    or declared.get("sha256") != sha_bytes(content)
                    or not isinstance(declared.get("mode"), int)
                    or isinstance(declared.get("mode"), bool)
                    or declared.get("mode") != (member.mode & 0o777)
                    or member.mode & ~0o777
                ):
                    raise Refusal("PREPARATION_DIST_ARCHIVE_INVALID")
                seen.add(member.name)
    except (OSError, tarfile.TarError) as error:
        raise Refusal("PREPARATION_DIST_ARCHIVE_INVALID") from error
    if seen != set(members):
        raise Refusal("PREPARATION_DIST_MEMBER_POPULATION_INVALID")
    return [archive_name, manifest_name]


def open_directory_chain(
    root: Path, parts: tuple[str, ...], code: str, create: bool = False
) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(root, flags)
    except OSError as error:
        raise Refusal(code) from error
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(part, flags, dir_fd=descriptor)
            if create:
                os.fchmod(child, 0o700)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except OSError as error:
        os.close(descriptor)
        raise Refusal(code) from error


def copy_regular_exclusive(
    source_root: Path,
    relative: str,
    destination_root: Path,
    destination_relative: str,
    executable_destination: bool = False,
) -> None:
    destination_relative = safe_relative_name(
        destination_relative, "CONTROL_SNAPSHOT_DESTINATION_INVALID"
    )
    source_relative = safe_relative_name(relative, "CONTROL_SNAPSHOT_SOURCE_INVALID")
    source_parts = Path(source_relative).parts
    source_parent = open_directory_chain(
        source_root, source_parts[:-1], "CONTROL_SNAPSHOT_SOURCE_INVALID"
    )
    destination_parts = Path(destination_relative).parts
    destination_parent = open_directory_chain(
        destination_root,
        destination_parts[:-1],
        "CONTROL_SNAPSHOT_DESTINATION_INVALID",
        create=True,
    )
    read_flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
    write_flags = (
        os.O_WRONLY
        | os.O_CREAT
        | os.O_EXCL
        | getattr(os, "O_NOFOLLOW", 0)
    )
    try:
        descriptor = os.open(source_parts[-1], read_flags, dir_fd=source_parent)
    except OSError as error:
        os.close(source_parent)
        os.close(destination_parent)
        raise Refusal("CONTROL_SNAPSHOT_SOURCE_INVALID") from error
    before = os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode):
        os.close(descriptor)
        os.close(source_parent)
        os.close(destination_parent)
        raise Refusal("CONTROL_SNAPSHOT_SOURCE_INVALID")
    try:
        output = os.open(
            destination_parts[-1], write_flags, 0o600, dir_fd=destination_parent
        )
    except OSError as error:
        os.close(descriptor)
        os.close(source_parent)
        os.close(destination_parent)
        raise Refusal("CONTROL_SNAPSHOT_DESTINATION_INVALID") from error
    os.close(source_parent)
    os.close(destination_parent)
    digest = hashlib.sha256()
    try:
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(output, view)
                view = view[written:]
        os.fsync(output)
        os.fchmod(output, 0o700 if executable_destination else 0o600)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
        os.close(output)
    destination = destination_root / destination_relative
    if (
        before.st_dev != after.st_dev
        or before.st_ino != after.st_ino
        or before.st_size != after.st_size
        or before.st_mtime_ns != after.st_mtime_ns
        or digest.hexdigest() != sha_file(destination)
    ):
        raise Refusal("CONTROL_SNAPSHOT_SOURCE_CHANGED")
    expected_mode = 0o700 if executable_destination else 0o600
    if stat.S_IMODE(destination.lstat().st_mode) != expected_mode:
        raise Refusal("CONTROL_SNAPSHOT_DESTINATION_INVALID")


def control_snapshot_entries(root: Path) -> list[dict[str, object]]:
    try:
        mode = root.lstat().st_mode
    except OSError as error:
        raise Refusal("CONTROL_SNAPSHOT_INVALID") from error
    if root.is_symlink() or not stat.S_ISDIR(mode) or stat.S_IMODE(mode) != 0o700:
        raise Refusal("CONTROL_SNAPSHOT_INVALID")
    entries: list[dict[str, object]] = []
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        base = Path(directory)
        for name in sorted(names):
            path = base / name
            child_mode = path.lstat().st_mode
            if path.is_symlink() or not stat.S_ISDIR(child_mode) or stat.S_IMODE(child_mode) != 0o700:
                raise Refusal("CONTROL_SNAPSHOT_MEMBER_INVALID")
        names[:] = sorted(names)
        for name in sorted(files):
            path = base / name
            child_mode = path.lstat().st_mode
            if path.is_symlink() or not stat.S_ISREG(child_mode):
                raise Refusal("CONTROL_SNAPSHOT_MEMBER_INVALID")
            relative = path.relative_to(root).as_posix()
            entries.append(
                {
                    "path": relative,
                    "bytes": path.stat().st_size,
                    "mode": stat.S_IMODE(child_mode),
                    "sha256": sha_file(path),
                }
            )
    return sorted(entries, key=lambda item: str(item["path"]))


def write_control_snapshot_manifest(
    path: Path, snapshot: Path, candidate: str, tree: str
) -> str:
    entries = control_snapshot_entries(snapshot)
    manifest = {
        "kind": "diagnostic-cli-control-snapshot",
        "version": 1,
        "candidate": candidate,
        "tree": tree,
        "members": entries,
        "population": {"count": len(entries), "sha256": sha_bytes(canonical(entries))},
    }
    write_json_exclusive(path, manifest)
    path.chmod(0o600)
    return sha_file(path)


def verify_control_snapshot_manifest(
    path: Path, snapshot: Path, candidate: str, tree: str, expected_sha256: str
) -> None:
    regular_file(path, expected_sha256, "CONTROL_SNAPSHOT_MANIFEST_BINDING_INVALID")
    manifest = load_json(path, "CONTROL_SNAPSHOT_MANIFEST_INVALID")
    entries = control_snapshot_entries(snapshot)
    if (
        manifest.get("kind") != "diagnostic-cli-control-snapshot"
        or manifest.get("version") != 1
        or manifest.get("candidate") != candidate
        or manifest.get("tree") != tree
        or manifest.get("members") != entries
        or manifest.get("population")
        != {"count": len(entries), "sha256": sha_bytes(canonical(entries))}
    ):
        raise Refusal("CONTROL_SNAPSHOT_CHANGED")


def snapshot_relative_bindings(
    output: Path,
    source_base: Path,
    source_bindings: dict[str, tuple[Path, str]],
    config: dict[str, Any],
    repo: Path,
    candidate: str,
    tree: str,
    retained: Path,
    lane_id: str,
) -> tuple[Path, dict[str, dict[str, str]], dict[str, str]]:
    snapshot = output / "control-snapshot"
    snapshot.mkdir(mode=0o700)
    material = snapshot / "material"
    material.mkdir(mode=0o700)
    validate_imported_runner_invariants(
        repo, config, candidate, tree, source_bindings["runner"][1]
    )
    resolve_preparation_pins_at_base(source_base, config.get("preparation_pins"))
    dependency_archives = validate_dependency_control(
        source_base, config, repo, candidate, tree
    )
    dist_files = validate_dist_control(source_base, config, candidate, tree)
    copy_population: dict[str, tuple[Path, str]] = {}
    rebound: dict[str, dict[str, str]] = {}
    for name, (source, expected) in source_bindings.items():
        destination_relative = (
            "inventory/consolidated-inventory.json"
            if name == "consolidated"
            else f"executables/{source.name}"
            if name == "nodeExecutable"
            else f"material/{source.name}"
        )
        existing = copy_population.get(destination_relative)
        if existing is not None and existing != (source, expected):
            raise Refusal("CONTROL_SNAPSHOT_DESTINATION_COLLISION")
        copy_population[destination_relative] = (source, expected)
        rebound[name] = {
            "path": str((snapshot / destination_relative).resolve()),
            "sha256": expected,
        }
    for relative in sorted(
        set(PREPARATION_PIN_PATHS) | set(dependency_archives) | set(dist_files)
    ):
        source = regular_path_beneath(
            source_base, relative, "CONTROL_SNAPSHOT_SOURCE_INVALID"
        )
        copy_population[f"material/{relative}"] = (source, sha_file(source))
    validate_frozen_retention(
        retained,
        frozen_campaign(load_consolidated(source_bindings["consolidated"][0], candidate, tree)),
        lane_id,
    )
    retained_names = sorted(path.name for path in retained.iterdir())
    for name in retained_names:
        safe_relative_name(name, "CONTROL_SNAPSHOT_RETAINED_INVALID")
        source = regular_path_beneath(
            retained, name, "CONTROL_SNAPSHOT_RETAINED_INVALID"
        )
        copy_population[f"retained/{lane_id}/{name}"] = (source, sha_file(source))
    for destination_relative, (source, expected) in sorted(copy_population.items()):
        if sha_file(source) != expected:
            raise Refusal("CONTROL_SNAPSHOT_SOURCE_BINDING_INVALID")
        copy_regular_exclusive(
            source.parent,
            source.name,
            snapshot,
            destination_relative,
            destination_relative.startswith("executables/"),
        )
        regular_file(
            snapshot / destination_relative,
            expected,
            "CONTROL_SNAPSHOT_COPY_BINDING_INVALID",
        )
    retained_snapshot = snapshot / f"retained/{lane_id}"
    manifest_path = output / "control-snapshot-manifest.json"
    manifest_sha = write_control_snapshot_manifest(
        manifest_path, snapshot, candidate, tree
    )
    control = {
        "path": str(snapshot.resolve()),
        "manifestPath": str(manifest_path.resolve()),
        "manifestSha256": manifest_sha,
    }
    return snapshot, rebound, {
        **control,
        "retainedPath": str(retained_snapshot.resolve()),
    }


def validate_control_snapshot(
    root: Path,
    control: object,
    config: dict[str, Any],
    repo: Path,
    candidate: str,
    tree: str,
    lane_id: str,
) -> Path:
    if not isinstance(control, dict):
        raise Refusal("CONTROL_SNAPSHOT_BINDING_INVALID")
    snapshot = root / "control-snapshot"
    manifest_path = root / "control-snapshot-manifest.json"
    if control != {
        "path": str(snapshot.resolve()),
        "manifestPath": str(manifest_path.resolve()),
        "manifestSha256": control.get("manifestSha256"),
        "retainedPath": str((snapshot / f"retained/{lane_id}").resolve()),
    }:
        raise Refusal("CONTROL_SNAPSHOT_BINDING_INVALID")
    verify_control_snapshot_manifest(
        manifest_path,
        snapshot,
        candidate,
        tree,
        str(control.get("manifestSha256")),
    )
    material = snapshot / "material"
    resolve_preparation_pins_at_base(material, config.get("preparation_pins"))
    runner_name = basename_field(
        config.get("runner_snapshot_name"), "CONTROL_SNAPSHOT_RUNNER_BINDING_INVALID"
    )
    runner_path = regular_path_beneath(
        material, runner_name, "CONTROL_SNAPSHOT_RUNNER_BINDING_INVALID"
    )
    validate_imported_runner_invariants(
        repo, config, candidate, tree, sha_file(runner_path)
    )
    validate_dependency_control(material, config, repo, candidate, tree)
    validate_dist_control(material, config, candidate, tree)
    inventory_path = regular_path_beneath(
        snapshot,
        "inventory/consolidated-inventory.json",
        "CONTROL_SNAPSHOT_INVENTORY_INVALID",
    )
    inventory = load_consolidated(inventory_path, candidate, tree)
    retained = Path(str(control.get("retainedPath")))
    validate_frozen_retention(retained, frozen_campaign(inventory), lane_id)
    return snapshot


def load_module(path: Path, expected: str, name: str, code: str) -> ModuleType:
    flags = os.O_RDONLY | os.O_NONBLOCK | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
        mode = os.fstat(descriptor).st_mode
        if not stat.S_ISREG(mode):
            raise Refusal(code)
        chunks: list[bytes] = []
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        source = b"".join(chunks)
        if sha_bytes(source) != expected:
            raise Refusal(code)
        compiled = compile(source, str(path), "exec")
        module = ModuleType(name)
        module.__file__ = str(path)
        module.__package__ = ""
        exec(compiled, module.__dict__)
    except Exception as error:
        if isinstance(error, Refusal):
            raise
        raise Refusal(f"{code}_IMPORT_INVALID") from error
    finally:
        if "descriptor" in locals():
            os.close(descriptor)
    return module


class BoundSubprocess:
    def __init__(self, docker: str) -> None:
        self.docker = docker

    def __getattr__(self, name: str) -> Any:
        return getattr(subprocess, name)

    def rewrite(self, args: object) -> object:
        if not isinstance(args, (list, tuple)) or not args:
            return args
        first = args[0]
        if first not in {"git", "node"}:
            if first != self.docker:
                raise Refusal("RUNNER_SUBPROCESS_EXECUTABLE_UNBOUND")
            return args
        rewritten = [executable(str(first)), *args[1:]]
        return tuple(rewritten) if isinstance(args, tuple) else rewritten

    def run(self, args: object, *positional: object, **keywords: object) -> Any:
        rewritten = self.rewrite(args)
        result = subprocess.run(rewritten, *positional, **keywords)
        if isinstance(args, (list, tuple)) and args and args[0] in {"git", "node"}:
            executable(str(args[0]))
        return result

    def check_output(
        self, args: object, *positional: object, **keywords: object
    ) -> Any:
        rewritten = self.rewrite(args)
        result = subprocess.check_output(rewritten, *positional, **keywords)
        if isinstance(args, (list, tuple)) and args and args[0] in {"git", "node"}:
            executable(str(args[0]))
        return result


def bind_runner_controls(runner: ModuleType, base: Path, repository: Path) -> None:
    runner.BASE = base
    runner.REPOSITORY = repository
    docker = str(getattr(runner, "DOCKER", ""))
    if not Path(docker).is_absolute():
        raise Refusal("RUNNER_DOCKER_BINDING_INVALID")
    runner.subprocess = BoundSubprocess(docker)


def relative_file_name(value: object) -> str:
    if not isinstance(value, str):
        raise Refusal("PLAN_MUTANT_FILE_INVALID")
    prefix = "/workspace/candidate/"
    path = value[len(prefix) :] if value.startswith(prefix) else value
    if path.startswith("/") or ".." in Path(path).parts or not path.startswith("packages/cli/src/"):
        raise Refusal("PLAN_MUTANT_FILE_INVALID")
    return path


def structural(mutant: object, include_static: bool = True) -> tuple[object, ...]:
    if not isinstance(mutant, dict):
        raise Refusal("PLAN_MUTANT_INVALID")
    location = mutant.get("location")
    if not isinstance(location, dict):
        raise Refusal("PLAN_MUTANT_INVALID")
    key: tuple[object, ...] = (
        relative_file_name(mutant.get("fileName")),
        json.dumps(location, sort_keys=True, separators=(",", ":")),
        mutant.get("mutatorName"),
        mutant.get("replacement"),
    )
    return (*key, mutant.get("static")) if include_static else key


def plan_population(value: object, code: str = "CURRENT_PLAN_POPULATION_INVALID") -> list[dict[str, Any]]:
    if not isinstance(value, dict):
        raise Refusal(code)
    plans = value.get("mutantPlans")
    if not isinstance(plans, list) or not plans:
        raise Refusal(code)
    ids: set[str] = set()
    structures: set[tuple[object, ...]] = set()
    for item in plans:
        mutant = item.get("mutant") if isinstance(item, dict) else None
        mutant_id = mutant.get("id") if isinstance(mutant, dict) else None
        if not isinstance(mutant_id, str) or not mutant_id.isdigit() or mutant_id in ids:
            raise Refusal("CURRENT_PLAN_ID_DUPLICATE")
        key = structural(mutant)
        if key in structures:
            raise Refusal("CURRENT_PLAN_STRUCTURAL_DUPLICATE")
        ids.add(mutant_id)
        structures.add(key)
    return plans


def frozen_campaign(value: dict[str, Any]) -> dict[str, str]:
    campaign = value.get("frozenCampaign")
    if not isinstance(campaign, dict):
        raise Refusal("CONSOLIDATED_FROZEN_CAMPAIGN_INVALID")
    expected = {
        "commit": campaign.get("commit"),
        "tree": campaign.get("tree"),
        "id": campaign.get("id"),
    }
    if (
        not re.fullmatch(r"[a-f0-9]{40}", str(expected["commit"]))
        or not re.fullmatch(r"[a-f0-9]{40}", str(expected["tree"]))
        or not isinstance(expected["id"], str)
        or not expected["id"]
    ):
        raise Refusal("CONSOLIDATED_FROZEN_CAMPAIGN_INVALID")
    return expected  # type: ignore[return-value]


def validate_frozen_retention(
    retained: Path, campaign: dict[str, str], lane: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    completion = load_json(retained / "retention-completion.json", "FROZEN_RETENTION_INVALID")
    expected_identity = {
        "candidate": campaign["commit"],
        "tree": campaign["tree"],
        "campaignId": campaign["id"],
        "shardId": lane,
    }
    if (
        completion.get("kind") != "diagnostic-cli-shard-retention-completion"
        or completion.get("version") != 1
        or completion.get("diagnosticOnly") is not True
        or {key: completion.get(key) for key in expected_identity} != expected_identity
    ):
        raise Refusal("FROZEN_RETENTION_IDENTITY_MISMATCH")
    index_path = retained / "retention-index.json"
    regular_file(
        index_path,
        completion.get("retentionIndexSha256", ""),
        "FROZEN_RETENTION_INDEX_BINDING_INVALID",
    )
    index = load_json(index_path, "FROZEN_RETENTION_INDEX_INVALID")
    container_id = completion.get("containerId")
    if (
        index.get("diagnosticOnly") is not True
        or {key: index.get(key) for key in expected_identity} != expected_identity
        or not re.fullmatch(r"[a-f0-9]{64}", str(container_id))
        or index.get("containerId") != container_id
    ):
        raise Refusal("FROZEN_RETENTION_INDEX_IDENTITY_MISMATCH")
    members = index.get("files")
    event_members = index.get("eventMembers")
    if not isinstance(members, list) or not isinstance(event_members, list):
        raise Refusal("FROZEN_RETENTION_INDEX_INVALID")
    indexed_names: set[str] = set()
    for member in members:
        if not isinstance(member, dict):
            raise Refusal("FROZEN_RETENTION_INDEX_INVALID")
        name = safe_relative_name(member.get("path"), "FROZEN_RETENTION_MEMBER_UNSAFE")
        if Path(name).name != name or name in indexed_names:
            raise Refusal("FROZEN_RETENTION_MEMBER_UNSAFE")
        digest = member.get("sha256")
        size = member.get("bytes")
        if not re.fullmatch(r"[a-f0-9]{64}", str(digest)) or not isinstance(size, int) or size < 0:
            raise Refusal("FROZEN_RETENTION_INDEX_INVALID")
        path = retained / name
        regular_file(path, str(digest), "FROZEN_RETENTION_MEMBER_BINDING_INVALID")
        if path.stat().st_size != size:
            raise Refusal("FROZEN_RETENTION_MEMBER_BINDING_INVALID")
        indexed_names.add(name)
    required = {
        "identity.json",
        "invocation.json",
        "container.json",
        "output.log",
        "mutation.json",
        "resources.json",
        "execution-completion.json",
        "events.tgz",
    }
    if not required.issubset(indexed_names):
        raise Refusal("FROZEN_RETENTION_REQUIRED_MEMBER_MISSING")
    actual_names = {path.name for path in retained.iterdir()}
    if actual_names != indexed_names | {"retention-index.json", "retention-completion.json"}:
        raise Refusal("FROZEN_RETENTION_MEMBER_POPULATION_MISMATCH")
    regular_file(
        retained / "identity.json",
        completion.get("identitySha256", ""),
        "FROZEN_RETENTION_IDENTITY_BINDING_INVALID",
    )
    regular_file(
        retained / "execution-completion.json",
        completion.get("executionCompletionSha256", ""),
        "FROZEN_EXECUTION_COMPLETION_BINDING_INVALID",
    )
    identity = load_json(retained / "identity.json", "FROZEN_IDENTITY_INVALID")
    if {key: identity.get(key) for key in expected_identity} != expected_identity:
        raise Refusal("FROZEN_IDENTITY_MISMATCH")
    execution = load_json(
        retained / "execution-completion.json", "FROZEN_EXECUTION_COMPLETION_INVALID"
    )
    container_record = load_json(retained / "container.json", "FROZEN_CONTAINER_RECORD_INVALID")
    if (
        execution.get("candidate") != campaign["commit"]
        or execution.get("phase") != "mutation"
        or execution.get("containerId") != container_id
        or container_record.get("id") != container_id
    ):
        raise Refusal("FROZEN_EXECUTION_COMPLETION_MISMATCH")
    archive = retained / "events.tgz"
    regular_file(
        archive,
        completion.get("eventsArchiveSha256", ""),
        "FROZEN_EVENTS_ARCHIVE_BINDING_INVALID",
    )
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        if any(
            member.issym()
            or member.islnk()
            or not member.isfile()
            or member.name.startswith("/")
            or ".." in Path(member.name).parts
            for member in members
        ):
            raise Refusal("FROZEN_EVENTS_ARCHIVE_UNSAFE")
        archive_by_name = {member.name: member for member in members}
        if len(archive_by_name) != len(members):
            raise Refusal("FROZEN_EVENTS_ARCHIVE_DUPLICATE")
        declared_events: dict[str, dict[str, Any]] = {}
        for event in event_members:
            if not isinstance(event, dict):
                raise Refusal("FROZEN_EVENT_INDEX_INVALID")
            name = safe_relative_name(event.get("path"), "FROZEN_EVENT_MEMBER_UNSAFE")
            if Path(name).name != name or name in declared_events:
                raise Refusal("FROZEN_EVENT_MEMBER_UNSAFE")
            if (
                not re.fullmatch(r"[a-f0-9]{64}", str(event.get("sha256")))
                or not isinstance(event.get("bytes"), int)
                or event["bytes"] < 0
            ):
                raise Refusal("FROZEN_EVENT_INDEX_INVALID")
            declared_events[name] = event
        if set(archive_by_name) != set(declared_events):
            raise Refusal("FROZEN_EVENT_MEMBER_POPULATION_MISMATCH")
        for name, member in archive_by_name.items():
            extracted = bundle.extractfile(member)
            if extracted is None:
                raise Refusal("FROZEN_EVENT_MEMBER_BINDING_INVALID")
            content = extracted.read()
            declared = declared_events[name]
            if len(content) != declared["bytes"] or sha_bytes(content) != declared["sha256"]:
                raise Refusal("FROZEN_EVENT_MEMBER_BINDING_INVALID")
        matches = [member for member in members if member.name.endswith("-onMutationTestingPlanReady.json")]
        if len(matches) != 1:
            raise Refusal("FROZEN_PLAN_POPULATION_INVALID")
        extracted = bundle.extractfile(matches[0])
        if extracted is None:
            raise Refusal("FROZEN_PLAN_POPULATION_INVALID")
        value = json.load(extracted)
    return completion, value


def load_frozen_plan(
    retained: Path, campaign: dict[str, str], lane: str
) -> list[dict[str, Any]]:
    _, value = validate_frozen_retention(retained, campaign, lane)
    return plan_population(value, "FROZEN_PLAN_POPULATION_INVALID")


def load_consolidated(path: Path, candidate: str, tree: str) -> dict[str, Any]:
    value = load_json(path, "CONSOLIDATED_INVENTORY_INVALID")
    if (
        value.get("kind") != "devai-cli-final-consolidated-remediation-inventory"
        or value.get("schemaVersion") != "1.0.0"
        or value.get("credit") != "zero-until-exact-current-plan-tuple-reports-killed"
    ):
        raise Refusal("CONSOLIDATED_INVENTORY_INVALID")
    if value.get("diagnosticOnly") is not True or value.get("finalCandidate") != {
        "commit": candidate,
        "tree": tree,
    }:
        raise Refusal("CONSOLIDATED_CANDIDATE_BINDING_INVALID")
    frozen_campaign(value)
    claims = value.get("claims")
    if not isinstance(claims, list) or not claims:
        raise Refusal("CONSOLIDATED_CLAIMS_INVALID")
    tuples: list[list[str]] = []
    seen: set[tuple[str, str]] = set()
    for claim in claims:
        lane = claim.get("lane") if isinstance(claim, dict) else None
        mutant_id = claim.get("frozenMutantId") if isinstance(claim, dict) else None
        if (
            not isinstance(lane, str)
            or not re.fullmatch(r"shard-(?:0[1-9]|1[0-2])", lane)
            or not isinstance(mutant_id, str)
            or not mutant_id.isdigit()
        ):
            raise Refusal("CONSOLIDATED_CLAIMS_INVALID")
        key = (lane, mutant_id)
        if key in seen:
            raise Refusal("CONSOLIDATED_CLAIM_DUPLICATE")
        seen.add(key)
        tuples.append([lane, mutant_id])
    population = value.get("claimPopulation")
    expected = sha_bytes(canonical(sorted(tuples, key=lambda item: (item[0], int(item[1])))))
    if not isinstance(population, dict) or population.get("count") != len(tuples) or population.get("sha256") != expected:
        raise Refusal("CONSOLIDATED_CLAIM_POPULATION_INVALID")
    return value


def map_claims(
    claims: list[dict[str, Any]],
    frozen_plans: list[dict[str, Any]],
    current_plans: list[dict[str, Any]],
    reference_structural: Any | None = None,
) -> list[dict[str, Any]]:
    def key(mutant: dict[str, Any]) -> tuple[object, ...]:
        local = structural(mutant)
        if reference_structural is not None:
            try:
                reference = tuple(reference_structural(mutant))
            except Exception as error:
                raise Refusal("MAPPER_REFERENCE_REJECTED_MUTANT") from error
            if reference != local:
                raise Refusal("MAPPER_REFERENCE_STRUCTURAL_CONTRACT_MISMATCH")
        return local

    frozen_by_id: dict[str, dict[str, Any]] = {}
    for item in frozen_plans:
        mutant = item["mutant"]
        mutant_id = mutant["id"]
        if mutant_id in frozen_by_id:
            raise Refusal("FROZEN_PLAN_ID_DUPLICATE")
        frozen_by_id[mutant_id] = mutant
    current_by_structure: dict[tuple[object, ...], dict[str, Any]] = {}
    for item in current_plans:
        mutant = item["mutant"]
        mutant_key = key(mutant)
        if mutant_key in current_by_structure:
            raise Refusal("CURRENT_PLAN_STRUCTURAL_DUPLICATE")
        current_by_structure[mutant_key] = mutant
    mapped: list[dict[str, Any]] = []
    seen_current: set[str] = set()
    for claim in claims:
        frozen = frozen_by_id.get(claim["frozenMutantId"])
        if frozen is None:
            raise Refusal("FROZEN_CLAIM_ID_MISSING")
        current = current_by_structure.get(key(frozen))
        if current is None:
            raise Refusal("CURRENT_PLAN_TUPLE_MISSING")
        if current["id"] in seen_current:
            raise Refusal("CURRENT_PLAN_TUPLE_MULTIPLY_CLAIMED")
        seen_current.add(current["id"])
        mapped.append(
            {
                "lane": claim["lane"],
                "frozenMutantId": frozen["id"],
                "currentMutantId": current["id"],
                "path": relative_file_name(current["fileName"]),
                "location": current["location"],
                "mutatorName": current["mutatorName"],
                "replacement": current["replacement"],
                "static": current.get("static"),
            }
        )
    return sorted(mapped, key=lambda item: int(item["frozenMutantId"]))


def position(value: object, code: str) -> tuple[int, int]:
    if not isinstance(value, dict) or not isinstance(value.get("line"), int) or not isinstance(value.get("column"), int):
        raise Refusal(code)
    if value["line"] < 0 or value["column"] < 0:
        raise Refusal(code)
    return value["line"], value["column"]


def location_bounds(location: object) -> tuple[tuple[int, int], tuple[int, int]]:
    if not isinstance(location, dict):
        raise Refusal("PLAN_MUTANT_LOCATION_INVALID")
    start = position(location.get("start"), "PLAN_MUTANT_LOCATION_INVALID")
    end = position(location.get("end"), "PLAN_MUTANT_LOCATION_INVALID")
    if start > end:
        raise Refusal("PLAN_MUTANT_LOCATION_INVALID")
    return start, end


def derive_exact_ranges(
    mapped: list[dict[str, Any]], current_plans: list[dict[str, Any]]
) -> list[str]:
    ranges: list[tuple[str, tuple[int, int], tuple[int, int]]] = []
    for item in mapped:
        start, end = location_bounds(item["location"])
        ranges.append((item["path"], start, end))
    unique_ranges = sorted(set(ranges))
    selected = {structural(item["mutant"]) for item in current_plans if item["mutant"]["id"] in {entry["currentMutantId"] for entry in mapped}}
    induced: set[tuple[object, ...]] = set()
    for item in current_plans:
        mutant = item["mutant"]
        path = relative_file_name(mutant["fileName"])
        start, end = location_bounds(mutant["location"])
        if any(path == range_path and range_start <= start and end <= range_end for range_path, range_start, range_end in unique_ranges):
            induced.add(structural(mutant))
    if induced != selected:
        raise Refusal("EXACT_MUTATE_RANGE_POPULATION_UNREPRESENTABLE")
    return [
        f"{path}:{start[0] + 1}:{start[1]}-{end[0] + 1}:{end[1]}"
        for path, start, end in unique_ranges
    ]


def inert_named_export_suffix(frozen: bytes, current: bytes) -> bool:
    if not current.startswith(frozen):
        return False
    try:
        frozen_text = frozen.decode("utf-8")
        suffix = current[len(frozen) :].decode("utf-8")
    except UnicodeDecodeError:
        return False
    if not suffix:
        return False
    lowered = suffix.lower()
    if any(
        marker in lowered
        for marker in ("stryker", "istanbul", "eslint", "@ts-", "sourcemappingurl")
    ):
        return False
    identifier = r"[A-Za-z_$][A-Za-z0-9_$]*"
    export_block = re.compile(rf"export\s*\{{(?P<body>[^}}]*)\}}\s*;")
    exported: list[str] = []
    cursor = 0
    while cursor < len(suffix):
        whitespace = re.match(r"[ \t\r\n]+", suffix[cursor:])
        if whitespace is not None:
            cursor += whitespace.end()
            continue
        if suffix.startswith("//", cursor):
            end = suffix.find("\n", cursor)
            cursor = len(suffix) if end < 0 else end + 1
            continue
        block = export_block.match(suffix, cursor)
        if block is None:
            return False
        entries = [entry.strip() for entry in block.group("body").split(",") if entry.strip()]
        if not entries:
            return False
        for entry in entries:
            match = re.fullmatch(rf"({identifier})(?:\s+as\s+({identifier}))?", entry)
            if match is None or "default" in match.groups():
                return False
            exported.append(match.group(1))
        cursor = block.end()
    if not exported or len(exported) != len(set(exported)):
        return False
    return all(
        re.search(
            rf"\b(?:function|class|const|let|var|interface|type|enum)\s+{re.escape(name)}\b",
            frozen_text,
        )
        is not None
        for name in exported
    )


def verify_changed_source_plan_bijection(
    frozen_plans: list[dict[str, Any]],
    current_plans: list[dict[str, Any]],
    changed_paths: set[str],
) -> None:
    for path in sorted(changed_paths):
        frozen = Counter(
            structural(item["mutant"])
            for item in frozen_plans
            if relative_file_name(item["mutant"].get("fileName")) == path
        )
        current = Counter(
            structural(item["mutant"])
            for item in current_plans
            if relative_file_name(item["mutant"].get("fileName")) == path
        )
        if not frozen or frozen != current:
            raise Refusal("TARGET_SOURCE_CHANGED_PLAN_POPULATION_MISMATCH")


def verify_source_blobs(
    repo: Path,
    candidate: str,
    frozen_candidate: str,
    retained: Path,
    mapped: list[dict[str, Any]],
) -> tuple[dict[str, str], set[str]]:
    report = load_json(retained / "mutation.json", "FROZEN_REPORT_INVALID")
    files = report.get("files")
    if not isinstance(files, dict):
        raise Refusal("FROZEN_REPORT_INVALID")
    bindings: dict[str, str] = {}
    changed_paths: set[str] = set()
    for path in sorted({item["path"] for item in mapped}):
        report_file = files.get(path)
        if not isinstance(report_file, dict) or not isinstance(report_file.get("source"), str):
            raise Refusal("FROZEN_SOURCE_MISSING")
        try:
            frozen = report_file["source"].encode()
        except UnicodeEncodeError as error:
            raise Refusal("FROZEN_SOURCE_MISSING") from error
        git_binary = executable("git")
        frozen_git = subprocess.run(
            [git_binary, "-C", str(repo), "show", f"{frozen_candidate}:{path}"],
            capture_output=True,
            check=False,
        )
        if frozen_git.returncode or frozen_git.stdout != frozen:
            raise Refusal("FROZEN_REPORT_SOURCE_BINDING_INVALID")
        executable("git")
        current = subprocess.run(
            [git_binary, "-C", str(repo), "show", f"{candidate}:{path}"], capture_output=True, check=False
        )
        executable("git")
        if current.returncode:
            raise Refusal("TARGET_SOURCE_CHANGED_REQUIRES_MANUAL_REMAP")
        if current.stdout != frozen:
            if not inert_named_export_suffix(frozen, current.stdout):
                raise Refusal("TARGET_SOURCE_CHANGED_REQUIRES_MANUAL_REMAP")
            changed_paths.add(path)
        bindings[path] = sha_bytes(current.stdout)
    return bindings, changed_paths


def event_payload(path: Path) -> dict[str, Any]:
    value = load_json(path, "EVENT_JSON_INVALID")
    content = value.get("content")
    return content if isinstance(content, dict) else value


def verify_execution(
    events: Path,
    report_path: Path,
    mapped: list[dict[str, Any]],
    source_bindings: dict[str, str] | None = None,
) -> dict[str, object]:
    plan_files = sorted(events.glob("*-onMutationTestingPlanReady.json"))
    tested_files = sorted(events.glob("*-onMutantTested.json"))
    report_files = sorted(events.glob("*-onMutationTestReportReady.json"))
    if len(plan_files) != 1:
        raise Refusal("EXECUTION_PLAN_MISSING_OR_DUPLICATE")
    if len(report_files) != 1:
        raise Refusal("EXECUTION_TERMINAL_REPORT_MISSING_OR_DUPLICATE")
    plans = plan_population(event_payload(plan_files[0]), "EXECUTION_PLAN_INVALID")
    report = load_json(report_path, "EXECUTION_REPORT_INVALID")
    if event_payload(report_files[0]) != report:
        raise Refusal("EXECUTION_TERMINAL_REPORT_MISMATCH")
    expected = {
        (
            item["path"],
            json.dumps(item["location"], sort_keys=True, separators=(",", ":")),
            item["mutatorName"],
            item["replacement"],
            item["static"],
        )
        for item in mapped
    }
    expected_by_structure = {
        (
            item["path"],
            json.dumps(item["location"], sort_keys=True, separators=(",", ":")),
            item["mutatorName"],
            item["replacement"],
            item["static"],
        ): item
        for item in mapped
    }
    if len(expected) != len(mapped) or len(expected_by_structure) != len(mapped):
        raise Refusal("EXECUTION_EXPECTED_POPULATION_AMBIGUOUS")
    planned = {structural(item["mutant"]) for item in plans}
    if planned != set(expected_by_structure) or len(planned) != len(plans):
        raise Refusal("EXECUTION_PLAN_TARGET_POPULATION_MISMATCH")
    tested: dict[str, tuple[object, ...]] = {}
    for path in tested_files:
        mutant = event_payload(path)
        mutant_id = mutant.get("id")
        if not isinstance(mutant_id, str) or mutant_id in tested:
            raise Refusal("EXECUTION_TESTED_ID_DUPLICATE")
        tested[mutant_id] = structural(mutant)
    observed: dict[str, tuple[object, ...]] = {}
    statuses: dict[str, str] = {}
    files = report.get("files")
    if not isinstance(files, dict):
        raise Refusal("EXECUTION_REPORT_INVALID")
    observed_source_bindings: dict[str, str] = {}
    for path, file in files.items():
        mutants = file.get("mutants") if isinstance(file, dict) else None
        if not isinstance(mutants, list):
            raise Refusal("EXECUTION_REPORT_INVALID")
        normalized_path = relative_file_name(path)
        if source_bindings is not None:
            if normalized_path in observed_source_bindings:
                raise Refusal("EXECUTION_REPORT_SOURCE_BINDING_INVALID")
            source = file.get("source")
            if not isinstance(source, str):
                raise Refusal("EXECUTION_REPORT_SOURCE_BINDING_INVALID")
            try:
                observed_source_bindings[normalized_path] = sha_bytes(source.encode())
            except UnicodeEncodeError as error:
                raise Refusal("EXECUTION_REPORT_SOURCE_BINDING_INVALID") from error
        for mutant in mutants:
            mutant_id = mutant.get("id") if isinstance(mutant, dict) else None
            if not isinstance(mutant_id, str) or mutant_id in observed:
                raise Refusal("EXECUTION_REPORT_ID_DUPLICATE")
            observed[mutant_id] = structural({**mutant, "fileName": path})
            status = mutant.get("status")
            if status not in {
                "Killed",
                "Survived",
                "Timeout",
                "NoCoverage",
                "CompileError",
                "RuntimeError",
                "Ignored",
            }:
                raise Refusal("EXECUTION_REPORT_STATUS_INVALID")
            statuses[mutant_id] = status
    if source_bindings is not None and observed_source_bindings != source_bindings:
        raise Refusal("EXECUTION_REPORT_SOURCE_BINDING_INVALID")
    planned_by_id = {item["mutant"]["id"]: structural(item["mutant"]) for item in plans}
    if len(tested_files) != len(plans) or set(tested) != set(planned_by_id):
        raise Refusal("EXECUTION_MUTANT_EVENTS_INCOMPLETE")
    if set(observed) != set(planned_by_id):
        raise Refusal("EXECUTION_REPORT_POPULATION_INCOMPLETE")
    if tested != planned_by_id or observed != planned_by_id:
        raise Refusal("EXECUTION_STRUCTURAL_POPULATION_MISMATCH")
    by_structure = {value: (mutant_id, statuses[mutant_id]) for mutant_id, value in observed.items()}
    if len(by_structure) != len(observed):
        raise Refusal("EXECUTION_STATUS_POPULATION_AMBIGUOUS")
    outcomes = []
    for claim in sorted(mapped, key=lambda item: int(item["frozenMutantId"])):
        key = (
            claim["path"],
            json.dumps(claim["location"], sort_keys=True, separators=(",", ":")),
            claim["mutatorName"],
            claim["replacement"],
            claim["static"],
        )
        execution_id, status = by_structure[key]
        outcomes.append(
            {
                "lane": claim["lane"],
                "frozenMutantId": claim["frozenMutantId"],
                "currentPlanMutantId": claim["currentMutantId"],
                "executionMutantId": execution_id,
                "structural": {
                    "path": claim["path"],
                    "location": claim["location"],
                    "mutatorName": claim["mutatorName"],
                    "replacement": claim["replacement"],
                    "static": claim["static"],
                },
                "status": status,
                "credited": status == "Killed",
            }
        )
    status_counts = Counter(item["status"] for item in outcomes)
    killed = [item for item in outcomes if item["credited"]]
    return {
        "plannedMutants": len(plans),
        "testedEvents": len(tested_files),
        "reportMutants": len(observed),
        "structuralPopulationSha256": sha_bytes(canonical(sorted([list(item) for item in expected], key=str))),
        "statusCounts": dict(sorted(status_counts.items())),
        "outcomes": outcomes,
        "credit": {
            "policy": "only-exact-current-Killed-status-receives-credit",
            "killed": len(killed),
            "notCredited": len(outcomes) - len(killed),
            "allMappedClaimsKilled": len(killed) == len(outcomes),
            "populationSha256": sha_bytes(canonical(outcomes)),
        },
    }


def validate_lane(value: object) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"shard-(?:0[1-9]|1[0-2])", value):
        raise Refusal("EXACT_CURRENT_LANE_INVALID")
    return value


def selected_lane(config: dict[str, Any], lane_id: str) -> dict[str, Any]:
    lane_id = validate_lane(lane_id)
    shards = config.get("campaign_shards")
    if not isinstance(shards, list):
        raise Refusal("LANE_SOURCE_POPULATION_INVALID")
    matches = [item for item in shards if isinstance(item, dict) and item.get("id") == lane_id]
    if len(matches) != 1 or not isinstance(matches[0].get("sources"), list) or not matches[0]["sources"]:
        raise Refusal("LANE_SOURCE_POPULATION_INVALID")
    return {"id": f"{lane_id}-planready", "sources": sorted(matches[0]["sources"])}


def bind_source_partition(repo: Path, candidate: str, config: dict[str, Any]) -> None:
    committed = sorted(
        path
        for path in git(repo, "ls-tree", "-r", "--name-only", candidate, "packages/cli/src").splitlines()
        if path.endswith(".ts") and not path.endswith(".d.ts")
    )
    shards = config.get("campaign_shards")
    if not isinstance(shards, list):
        raise Refusal("CAMPAIGN_SOURCE_PARTITION_INVALID")
    populations = [item.get("sources") for item in shards if isinstance(item, dict)]
    if len(populations) != len(shards) or any(not isinstance(items, list) for items in populations):
        raise Refusal("CAMPAIGN_SOURCE_PARTITION_INVALID")
    assigned = [path for items in populations for path in items]
    if len(assigned) != len(set(assigned)) or sorted(assigned) != committed:
        raise Refusal("CAMPAIGN_SOURCE_PARTITION_INVALID")
    expected_manifest = sha_bytes(
        json.dumps(shards, sort_keys=True, separators=(",", ":")).encode()
    )
    if (
        config.get("full_source_population") != committed
        or config.get("campaign_manifest_sha256") != expected_manifest
    ):
        raise Refusal("CAMPAIGN_SOURCE_BINDING_INVALID")


def validate_imported_runner_invariants(
    repo: Path,
    config: dict[str, Any],
    candidate: str,
    tree: str,
    runner_sha256: str,
) -> None:
    if config.get("candidate") != candidate or config.get("tree") != tree:
        raise Refusal("RAW_CAMPAIGN_CANDIDATE_BINDING_INVALID")
    if (
        "base" in config
        or config.get("diagnosticOnly") is not True
        or config.get("usableOnlyThroughExactCurrentHarness") is not True
        or config.get("diagnostic_score_target") != 80
        or config.get("runner_sha256") != runner_sha256
    ):
        raise Refusal("IMPORTED_RUNNER_INVARIANT_INVALID")
    timeouts = config.get("phase_timeouts")
    if (
        not isinstance(timeouts, dict)
        or not isinstance(timeouts.get("baseline"), int)
        or isinstance(timeouts.get("baseline"), bool)
        or timeouts["baseline"] < 3600
        or not isinstance(timeouts.get("mutation"), int)
        or isinstance(timeouts.get("mutation"), bool)
        or timeouts["mutation"] < 28800
    ):
        raise Refusal("IMPORTED_RUNNER_TIMEOUT_INVALID")
    if git(repo, "rev-parse", f"{candidate}^{{tree}}") != tree:
        raise Refusal("RAW_CAMPAIGN_CANDIDATE_BINDING_INVALID")
    bind_source_partition(repo, candidate, config)
    node_version()


def refresh_case_bindings(case: Path, additions: dict[str, Any]) -> None:
    host = case / "host"
    identity = load_json(case / "identity.json", "PREPARED_IDENTITY_INVALID")
    identity.update(additions)
    identity["policyBoundSha256"] = sha_file(host / "stryker.config.json")
    identity["controls"] = [
        {"path": path.name, "sha256": sha_file(path)} for path in sorted(host.iterdir()) if path.is_file()
    ]
    replace_json(case / "identity.json", identity)


def prepare_planready(
    root: Path,
    config: dict[str, Any],
    runner: ModuleType,
    census_program: Path,
    lane_id: str,
) -> Path:
    bind_candidate(runner.REPOSITORY, config["candidate"], config["tree"])
    prepared_parent = root / "planready"
    prepared_parent.mkdir()
    prepared = runner.prepare(prepared_parent, config, selected_lane(config, lane_id))
    bind_candidate(runner.REPOSITORY, config["candidate"], config["tree"])
    case = prepared / "baseline"
    materialization_sha = write_materialization_manifest(
        prepared / "materialization.json",
        prepared / "candidate",
        config["candidate"],
        config["tree"],
    )
    policy_path = case / "host/stryker.config.json"
    policy = load_json(policy_path, "PREPARED_POLICY_INVALID")
    policy.update(
        reporters=[],
        dryRunOnly=False,
        dryRunTimeoutMinutes=15,
        cleanTempDir=False,
        tempDirName=f"/tmp/stryker-{lane_id}-planready-{config['candidate'][:7]}",
    )
    replace_json(policy_path, policy)
    shutil.copyfile(census_program, case / "host/run.mjs")
    refresh_case_bindings(
        case,
        {
            "kind": "diagnostic-cli-exact-current-planready",
            "selectedLane": lane_id,
            "phase": "planready",
            "mutantExecutionPermitted": False,
            "censusProgramSha256": sha_file(census_program),
            "materializationSha256": materialization_sha,
        },
    )
    return prepared


def prepare(args: argparse.Namespace) -> dict[str, object]:
    try:
        repo_mode = args.repo.lstat().st_mode
    except OSError as error:
        raise Refusal("PREPARATION_REPOSITORY_INVALID") from error
    if stat.S_ISLNK(repo_mode) or not stat.S_ISDIR(repo_mode):
        raise Refusal("PREPARATION_REPOSITORY_INVALID")
    repo = args.repo.resolve()
    lane_id = validate_lane(args.lane)
    git_path, git_sha = parse_bound_file(args.git, "PREPARATION_GIT_BINDING_INVALID")
    node_path, node_sha = parse_bound_file(args.node, "PREPARATION_NODE_BINDING_INVALID")
    discovered_executables = {
        "git": executable_binding(git_path, git_sha),
        "node": executable_binding(node_path, node_sha),
    }
    activate_executables(discovered_executables)
    if Path(git(repo, "rev-parse", "--show-toplevel")) != repo:
        raise Refusal("PREPARATION_REPOSITORY_INVALID")
    bind_candidate(repo, args.final_candidate, args.final_tree)
    inventory_path, inventory_sha = parse_bound_file(args.consolidated, "CONSOLIDATED_BINDING_INVALID")
    inventory = load_consolidated(inventory_path, args.final_candidate, args.final_tree)
    runner_path, runner_sha = parse_bound_file(args.runner, "SHARDED_RUNNER_BINDING_INVALID")
    mapper_path, mapper_sha = parse_bound_file(args.mapper, "MAPPER_REFERENCE_BINDING_INVALID")
    census_path, census_sha = parse_bound_file(args.census_program, "CENSUS_PROGRAM_BINDING_INVALID")
    config_path, config_sha = parse_bound_file(args.campaign_config, "CAMPAIGN_CONFIG_BINDING_INVALID")
    config = load_json(config_path, "CAMPAIGN_CONFIG_INVALID")
    retained_bindings = [
        {"lane": lane, "path": str(path), "completionSha256": digest}
        for lane, path, digest in (parse_retained(spec) for spec in args.frozen_retained)
    ]
    if [item["lane"] for item in retained_bindings] != [lane_id]:
        raise Refusal("SELECTED_LANE_FROZEN_RETENTION_BINDING_INVALID")
    validate_frozen_retention(
        Path(retained_bindings[0]["path"]), frozen_campaign(inventory), lane_id
    )
    if runner_path.parent != census_path.parent or mapper_path.parent != runner_path.parent:
        raise Refusal("DIAGNOSTIC_MATERIAL_ROOT_MISMATCH")
    mapper_binder = mapper_path.parent / "prepare-cli-targeted-remediation-final.py"
    if not mapper_binder.is_file() or mapper_binder.is_symlink():
        raise Refusal("MAPPER_BINDER_REFERENCE_INVALID")
    validate_imported_runner_invariants(
        repo, config, args.final_candidate, args.final_tree, runner_sha
    )
    source_bindings = {
        "consolidated": (inventory_path, inventory_sha),
        "runner": (runner_path, runner_sha),
        "mapperReference": (mapper_path, mapper_sha),
        "mapperBinderReference": (mapper_binder.resolve(), sha_file(mapper_binder)),
        "censusProgram": (census_path, census_sha),
        "campaignConfig": (config_path, config_sha),
        "nodeExecutable": (
            Path(discovered_executables["node"]["path"]),
            discovered_executables["node"]["sha256"],
        ),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        args.output.mkdir(mode=0o700)
    except FileExistsError as error:
        raise Refusal("OUTPUT_ALREADY_EXISTS") from error
    snapshot, rebound, control = snapshot_relative_bindings(
        args.output,
        runner_path.parent,
        source_bindings,
        config,
        repo,
        args.final_candidate,
        args.final_tree,
        Path(retained_bindings[0]["path"]),
        lane_id,
    )
    config.update(
        candidate=args.final_candidate,
        tree=args.final_tree,
        runner_sha256=runner_sha,
        runner_snapshot_name=Path(rebound["runner"]["path"]).name,
        census_program_name=census_path.name,
        census_program_sha256=census_sha,
        campaign_id=f"devai-cli-exact-current-{lane_id}-{args.final_candidate[:12]}",
        allocation_id=f"exact-current-{lane_id}",
        parallel_shards=1,
        assigned_shard_ids=[f"{lane_id}-planready"],
        output_root=str(args.output.resolve()),
        census_evidence={
            "candidate": args.final_candidate,
            "tree": args.final_tree,
            "mutantExecutionStarted": False,
            "maximumPossibleScore": 100,
        },
    )
    retained_snapshot = Path(control["retainedPath"])
    snapshot_node = executable_binding(
        Path(rebound["nodeExecutable"]["path"]),
        str(rebound["nodeExecutable"]["sha256"]),
    )
    inputs = {
        "kind": "diagnostic-cli-exact-current-lane-inputs",
        "version": 1,
        "diagnosticOnly": True,
        "launchAuthorized": False,
        "candidate": args.final_candidate,
        "tree": args.final_tree,
        "selectedLane": lane_id,
        "repository": str(
            (args.output / "planready" / f"{lane_id}-planready" / "candidate").resolve()
        ),
        **rebound,
        "executables": {
            "git": discovered_executables["git"],
            "node": snapshot_node,
        },
        "gitExecutable": discovered_executables["git"],
        "nodeExecutable": snapshot_node,
        "preparationPins": resolve_preparation_pins_at_base(
            snapshot / "material", config.get("preparation_pins")
        ),
        "controlSnapshot": control,
        "frozenRetained": [
            {
                "lane": lane_id,
                "path": str(retained_snapshot),
                "completionSha256": sha_file(
                    retained_snapshot / "retention-completion.json"
                ),
            }
        ],
    }
    write_json_exclusive(args.output / "effective-config.json", config)
    activate_executables(inputs["executables"])
    runner = load_module(
        Path(rebound["runner"]["path"]),
        rebound["runner"]["sha256"],
        "devai_cli_sharded_snapshot",
        "SHARDED_RUNNER_BINDING_INVALID",
    )
    bind_runner_controls(runner, snapshot / "material", repo)
    validate_control_snapshot(
        args.output, control, config, repo, args.final_candidate, args.final_tree, lane_id
    )
    prepared = prepare_planready(
        args.output, config, runner, Path(rebound["censusProgram"]["path"]), lane_id
    )
    validate_control_snapshot(
        args.output, control, config, repo, args.final_candidate, args.final_tree, lane_id
    )
    if Path(inputs["repository"]) != (prepared / "candidate").resolve():
        raise Refusal("PREPARATION_REPOSITORY_BINDING_INVALID")
    write_json_exclusive(args.output / "inputs.json", inputs)
    completion = {
        "kind": "diagnostic-cli-exact-current-lane-preparation",
        "version": 1,
        "diagnosticOnly": True,
        "launchAuthorized": False,
        "status": "prepared-no-docker-launch",
        "candidate": args.final_candidate,
        "tree": args.final_tree,
        "selectedLane": lane_id,
        "inputsSha256": sha_file(args.output / "inputs.json"),
        "effectiveConfigSha256": sha_file(args.output / "effective-config.json"),
        "planreadyIdentitySha256": sha_file(prepared / "baseline/identity.json"),
        "controlSnapshotManifestSha256": control["manifestSha256"],
    }
    write_json_exclusive(args.output / "preparation-completion.json", completion)
    return {
        "output": str(args.output),
        "completion": str(args.output / "preparation-completion.json"),
        "sha256": sha_file(args.output / "preparation-completion.json"),
        "status": completion["status"],
    }


def validate_preparation(completion_spec: str) -> tuple[Path, dict[str, Any], dict[str, Any], dict[str, Any]]:
    completion_path, _ = parse_bound_file(completion_spec, "PREPARATION_COMPLETION_BINDING_INVALID")
    completion = load_json(completion_path, "PREPARATION_COMPLETION_INVALID")
    root = completion_path.parent
    if (
        completion.get("kind") != "diagnostic-cli-exact-current-lane-preparation"
        or completion.get("status") != "prepared-no-docker-launch"
        or completion.get("diagnosticOnly") is not True
        or completion.get("launchAuthorized") is not False
    ):
        raise Refusal("PREPARATION_COMPLETION_INVALID")
    regular_file(root / "inputs.json", completion.get("inputsSha256", ""), "PREPARATION_INPUTS_BINDING_INVALID")
    regular_file(root / "effective-config.json", completion.get("effectiveConfigSha256", ""), "PREPARATION_CONFIG_BINDING_INVALID")
    inputs = load_json(root / "inputs.json", "PREPARATION_INPUTS_INVALID")
    config = load_json(root / "effective-config.json", "PREPARATION_CONFIG_INVALID")
    activate_executables(inputs.get("executables"))
    lane_id = validate_lane(completion.get("selectedLane"))
    candidate_binding = {"candidate": completion.get("candidate"), "tree": completion.get("tree")}
    if (
        inputs.get("kind") != "diagnostic-cli-exact-current-lane-inputs"
        or inputs.get("diagnosticOnly") is not True
        or inputs.get("launchAuthorized") is not False
        or {key: inputs.get(key) for key in candidate_binding} != candidate_binding
        or {key: config.get(key) for key in candidate_binding} != candidate_binding
        or inputs.get("selectedLane") != lane_id
        or config.get("assigned_shard_ids") != [f"{lane_id}-planready"]
        or config.get("diagnosticOnly") is not True
        or inputs.get("executables")
        != {"git": inputs.get("gitExecutable"), "node": inputs.get("nodeExecutable")}
    ):
        raise Refusal("PREPARATION_INTERNAL_BINDING_INVALID")
    retained = inputs.get("frozenRetained")
    if not isinstance(retained, list) or any(not isinstance(item, dict) for item in retained):
        raise Refusal("SELECTED_LANE_FROZEN_RETENTION_BINDING_INVALID")
    retained_lanes = [item.get("lane") for item in retained]
    if retained_lanes != [lane_id]:
        raise Refusal("SELECTED_LANE_FROZEN_RETENTION_BINDING_INVALID")
    prepared = root / "planready" / f"{lane_id}-planready"
    repository = prepared / "candidate"
    if Path(str(inputs.get("repository"))) != repository.resolve():
        raise Refusal("PREPARATION_REPOSITORY_BINDING_INVALID")
    regular_file(prepared / "baseline/identity.json", completion.get("planreadyIdentitySha256", ""), "PLANREADY_IDENTITY_BINDING_INVALID")
    planready_identity = load_json(prepared / "baseline/identity.json", "PLANREADY_IDENTITY_INVALID")
    if (
        {key: planready_identity.get(key) for key in candidate_binding} != candidate_binding
        or planready_identity.get("selectedLane") != lane_id
        or planready_identity.get("shardId") != f"{lane_id}-planready"
    ):
        raise Refusal("PLANREADY_CANDIDATE_BINDING_INVALID")
    verify_materialization_manifest(
        prepared / "materialization.json",
        planready_identity.get("materializationSha256", ""),
        prepared / "candidate",
        str(candidate_binding["candidate"]),
        str(candidate_binding["tree"]),
    )
    for binding in (
        inputs["consolidated"],
        inputs["runner"],
        inputs["mapperReference"],
        inputs["mapperBinderReference"],
        inputs["censusProgram"],
        inputs["campaignConfig"],
        inputs["gitExecutable"],
        inputs["nodeExecutable"],
    ):
        regular_file(Path(binding["path"]), binding["sha256"], "PREPARATION_SOURCE_BINDING_CHANGED")
    for binding in inputs["frozenRetained"]:
        regular_file(Path(binding["path"]) / "retention-completion.json", binding["completionSha256"], "FROZEN_RETENTION_BINDING_CHANGED")
    snapshot = validate_control_snapshot(
        root,
        inputs.get("controlSnapshot"),
        config,
        repository,
        str(candidate_binding["candidate"]),
        str(candidate_binding["tree"]),
        lane_id,
    )
    if completion.get("controlSnapshotManifestSha256") != inputs.get(
        "controlSnapshot", {}
    ).get("manifestSha256"):
        raise Refusal("CONTROL_SNAPSHOT_COMPLETION_BINDING_INVALID")
    expected_paths = {
        "consolidated": snapshot / "inventory/consolidated-inventory.json",
        "runner": snapshot / "material" / Path(inputs["runner"]["path"]).name,
        "mapperReference": snapshot
        / "material"
        / Path(inputs["mapperReference"]["path"]).name,
        "mapperBinderReference": snapshot
        / "material"
        / Path(inputs["mapperBinderReference"]["path"]).name,
        "censusProgram": snapshot
        / "material"
        / Path(inputs["censusProgram"]["path"]).name,
        "campaignConfig": snapshot
        / "material"
        / Path(inputs["campaignConfig"]["path"]).name,
        "gitExecutable": Path(inputs["gitExecutable"]["path"]),
        "nodeExecutable": snapshot / "executables/node",
    }
    if any(
        Path(inputs[name]["path"]) != expected.resolve()
        for name, expected in expected_paths.items()
    ):
        raise Refusal("CONTROL_SNAPSHOT_INPUT_PATH_INVALID")
    resolved_pins = resolve_preparation_pins_at_base(
        snapshot / "material", config.get("preparation_pins")
    )
    if inputs.get("preparationPins") != resolved_pins:
        raise Refusal("PREPARATION_PIN_INPUT_BINDING_INVALID")
    raw_config = load_json(
        Path(inputs["campaignConfig"]["path"]), "CAMPAIGN_CONFIG_INVALID"
    )
    validate_imported_runner_invariants(
        repository,
        raw_config,
        str(candidate_binding["candidate"]),
        str(candidate_binding["tree"]),
        str(inputs["runner"]["sha256"]),
    )
    inventory = load_consolidated(
        Path(inputs["consolidated"]["path"]),
        str(candidate_binding["candidate"]),
        str(candidate_binding["tree"]),
    )
    validate_frozen_retention(
        Path(retained[0]["path"]), frozen_campaign(inventory), lane_id
    )
    return root, completion, inputs, config


def execute_planready(
    case: Path, runner: ModuleType, group: str, attempt_id: str
) -> dict[str, Any]:
    identity = load_json(case / "identity.json", "PLANREADY_IDENTITY_INVALID")
    candidate = case.parent / "candidate"
    if git(candidate, "rev-parse", "HEAD") != identity["candidate"]:
        raise Refusal("PLANREADY_CANDIDATE_CHANGED")
    verify_materialization_manifest(
        case.parent / "materialization.json",
        identity.get("materializationSha256", ""),
        candidate,
        identity["candidate"],
        identity["tree"],
    )
    for member in identity["targets"] + identity["tests"]:
        regular_file(candidate / member["path"], member["sha256"], "PLANREADY_SOURCE_OR_TEST_CHANGED")
    for member in identity["controls"]:
        regular_file(case / "host" / member["path"], member["sha256"], "PLANREADY_CONTROL_CHANGED")
    lane = identity["lane"]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", identity.get("image", "")):
        raise Refusal("PLANREADY_IMAGE_NOT_PINNED")
    lane_id = validate_lane(identity.get("selectedLane"))
    name = f"devai-cli-{identity['candidate'][:7]}-{attempt_id}-{lane_id}-planready"
    args = [
        runner.DOCKER,
        "create",
        "--name",
        name,
        "--label",
        f"devai.diagnostic.group={group}",
        "--network",
        "none",
        "--cpus",
        str(lane["cpus"]),
        "--memory",
        lane["memory"],
        "--memory-swap",
        lane["memorySwap"],
        "--pids-limit",
        str(lane["pidsLimit"]),
        "--env",
        "npm_config_offline=true",
        "--mount",
        f"type=bind,source={candidate},target=/workspace/candidate,readonly",
        "--mount",
        f"type=bind,source={case / 'host'},target=/devai-host,readonly",
        "--mount",
        f"type=bind,source={case / 'results'},target=/results",
        "--mount",
        f"type=bind,source={candidate}/node_modules/.devai-npm-cache,target=/npm-seed,readonly",
        "--workdir",
        "/workspace/candidate",
        identity["image"],
        "/bin/sh",
        "-ec",
        'mkdir -p /root/.npm; cp -a /npm-seed/. /root/.npm/; node /devai-host/run.mjs',
    ]
    write_json_exclusive(case / "invocation.json", args)
    container_id = runner.output(args, env=runner.ENV)
    if not re.fullmatch(r"[a-f0-9]{64}", container_id):
        raise Refusal("PLANREADY_CONTAINER_ID_INVALID")
    write_json_exclusive(case / "container.json", {"id": container_id, "name": name})
    started = time.monotonic()
    with (case / "output.log").open("xb") as log:
        try:
            result = subprocess.run(
                [runner.DOCKER, "start", "--attach", container_id],
                env=runner.ENV,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=identity["timeoutSeconds"],
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            subprocess.run(
                [runner.DOCKER, "stop", "-t", "15", container_id],
                env=runner.ENV,
                stdout=log,
                stderr=subprocess.STDOUT,
                timeout=45,
                check=False,
            )
            raise Refusal("PLANREADY_EXECUTION_TIMEOUT") from error
    state = json.loads(runner.docker(["inspect", container_id]))[0]
    verify_materialization_manifest(
        case.parent / "materialization.json",
        identity.get("materializationSha256", ""),
        candidate,
        identity["candidate"],
        identity["tree"],
    )
    if result.returncode or state["State"]["Status"] != "exited" or state["State"]["ExitCode"] or state["State"]["OOMKilled"]:
        raise Refusal("PLANREADY_EXECUTION_FAILED")
    plan_path = case / "results/census-plan.json"
    summary_path = case / "results/census-summary.json"
    summary = load_json(summary_path, "PLANREADY_OUTPUT_MISSING")
    plan = load_json(plan_path, "PLANREADY_OUTPUT_MISSING")
    plans = plan_population(plan)
    if summary.get("diagnosticOnly") is not True or summary.get("mutantExecutionStarted") is not False:
        raise Refusal("PLANREADY_EXECUTION_BOUNDARY_INVALID")
    if summary.get("planSha256") != sha_file(plan_path) or summary.get("totals", {}).get("planned") != len(plans):
        raise Refusal("PLANREADY_POPULATION_BINDING_INVALID")
    summary_files = summary.get("files")
    if not isinstance(summary_files, list) or any(not isinstance(item, dict) for item in summary_files):
        raise Refusal("PLANREADY_SOURCE_POPULATION_INVALID")
    if {item.get("path") for item in summary_files} != {item["path"] for item in identity["targets"]}:
        raise Refusal("PLANREADY_SOURCE_POPULATION_INVALID")
    completion = {
        "kind": "diagnostic-cli-exact-current-planready-completion",
        "version": 1,
        "diagnosticOnly": True,
        "mutantExecutionStarted": False,
        "candidate": identity["candidate"],
        "tree": identity["tree"],
        "containerId": container_id,
        "seconds": time.monotonic() - started,
        "identitySha256": sha_file(case / "identity.json"),
        "planSha256": sha_file(plan_path),
        "summarySha256": sha_file(summary_path),
        "outputLogSha256": sha_file(case / "output.log"),
        "plannedMutants": len(plans),
    }
    write_json_exclusive(case / "completion.json", completion)
    return completion


def retain_planready(case: Path, destination: Path) -> dict[str, Any]:
    destination.mkdir(mode=0o700)
    members = []
    for relative in (
        "identity.json",
        "invocation.json",
        "container.json",
        "output.log",
        "completion.json",
        "results/census-plan.json",
        "results/census-summary.json",
    ):
        source = case / relative
        target = destination / relative.replace("/", "-")
        with target.open("xb") as stream:
            stream.write(source.read_bytes())
            stream.flush()
            os.fsync(stream.fileno())
        members.append({"path": target.name, "sha256": sha_file(target), "bytes": target.stat().st_size})
    index = {
        "kind": "diagnostic-cli-exact-current-planready-retention-index",
        "version": 1,
        "diagnosticOnly": True,
        "files": members,
    }
    write_json_exclusive(destination / "retention-index.json", index)
    completion = {
        "kind": "diagnostic-cli-exact-current-planready-retention-completion",
        "version": 1,
        "diagnosticOnly": True,
        "retentionIndexSha256": sha_file(destination / "retention-index.json"),
        "planSha256": sha_file(destination / "results-census-plan.json"),
    }
    write_json_exclusive(destination / "retention-completion.json", completion)
    return completion


def patch_target_cases(
    prepared: Path,
    ranges: list[str],
    mapped: list[dict[str, Any]],
    plan_sha: str,
    inventory_sha: str,
    materialization_sha: str,
) -> None:
    additions = {
        "kind": "diagnostic-cli-exact-current-lane-target",
        "exactMutateRanges": ranges,
        "mappedClaims": mapped,
        "currentPlanSha256": plan_sha,
        "consolidatedInventorySha256": inventory_sha,
        "materializationSha256": materialization_sha,
    }
    for phase in ("baseline", "mutation"):
        case = prepared / phase
        config_path = case / "host/stryker.config.json"
        config = load_json(config_path, "TARGET_POLICY_INVALID")
        config["mutate"] = ranges
        replace_json(config_path, config)
        refresh_case_bindings(case, additions)


def attempt_evidence_files(root: Path) -> list[dict[str, object]]:
    members: list[dict[str, object]] = []
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        base = Path(directory)
        relative_base = base.relative_to(root)
        if any((base / name).is_symlink() for name in names):
            raise Refusal("ATTEMPT_EVIDENCE_MEMBER_INVALID")
        names[:] = sorted(
            name
            for name in names
            if name not in {".git", "node_modules", "candidate"}
        )
        for name in sorted(files):
            path = base / name
            relative = (relative_base / name).as_posix()
            if relative in {"attempt-index.json", "attempt-completion.json"}:
                continue
            if path.is_symlink() or not path.is_file():
                raise Refusal("ATTEMPT_EVIDENCE_MEMBER_INVALID")
            members.append(
                {
                    "path": relative,
                    "sha256": sha_file(path),
                    "bytes": path.stat().st_size,
                }
            )
    return members


def current_attempt_container_records(root: Path) -> list[Path]:
    records: list[Path] = []
    for path in root.glob("**/container.json"):
        parts = path.relative_to(root).parts
        if "candidate" in parts or (parts and parts[0] == "control-snapshot"):
            continue
        records.append(path)
    return sorted(records)


def current_attempt_invocation_records(root: Path) -> list[Path]:
    records: list[Path] = []
    for path in root.glob("**/invocation.json"):
        parts = path.relative_to(root).parts
        in_exact_candidate = (
            len(parts) >= 4
            and parts[0] in {"planready", "targeted"}
            and parts[2] == "candidate"
        )
        if in_exact_candidate or (parts and parts[0] == "control-snapshot"):
            continue
        records.append(path)
    return sorted(records)


def observed_containers(root: Path, runner: ModuleType | None) -> list[dict[str, object]]:
    containers: list[dict[str, object]] = []
    for path in current_attempt_container_records(root):
        relative = path.relative_to(root).as_posix()
        try:
            value = load_json(path, "ATTEMPT_CONTAINER_RECORD_INVALID")
            container_id = value.get("id")
            if not re.fullmatch(r"[a-f0-9]{64}", str(container_id)):
                raise Refusal("ATTEMPT_CONTAINER_RECORD_INVALID")
            state: object = "inspection-unavailable"
            if runner is not None:
                try:
                    inspected = json.loads(runner.docker(["inspect", container_id]))
                    state = inspected[0].get("State", {}) if len(inspected) == 1 else "inspection-invalid"
                except Exception:
                    state = "inspection-unavailable"
            containers.append(
                {
                    "record": relative,
                    "id": container_id,
                    "name": value.get("name"),
                    "state": state,
                }
            )
        except Exception as error:
            containers.append({"record": relative, "state": "record-invalid", "error": type(error).__name__})
    return containers


def expected_invocation_name(
    invocation_path: Path,
    docker: str,
    group: str,
    attempt_id: str,
    lane_id: str,
    candidate: str,
    tree: str,
) -> tuple[str, dict[str, Any], list[str]]:
    try:
        mode = invocation_path.lstat().st_mode
        argv = json.loads(invocation_path.read_bytes())
    except Exception as error:
        raise Refusal("RECOVERY_INVOCATION_INVALID") from error
    if invocation_path.is_symlink() or not stat.S_ISREG(mode):
        raise Refusal("RECOVERY_INVOCATION_INVALID")
    identity_path = invocation_path.parent / "identity.json"
    try:
        identity_mode = identity_path.lstat().st_mode
    except OSError as error:
        raise Refusal("RECOVERY_INVOCATION_IDENTITY_INVALID") from error
    if identity_path.is_symlink() or not stat.S_ISREG(identity_mode):
        raise Refusal("RECOVERY_INVOCATION_IDENTITY_INVALID")
    identity = load_json(identity_path, "RECOVERY_INVOCATION_IDENTITY_INVALID")
    if (
        not isinstance(argv, list)
        or len(argv) < 4
        or any(not isinstance(item, str) for item in argv)
        or argv[0] != docker
        or argv[1] != "create"
        or argv.count("--name") != 1
        or argv[2] != "--name"
    ):
        raise Refusal("RECOVERY_INVOCATION_INVALID")
    recorded_name = argv[3]
    if identity.get("phase") == "planready":
        selected = validate_lane(identity.get("selectedLane"))
        if (
            identity.get("allocationId") != f"exact-current-{lane_id}"
            or identity.get("shardId") != f"{lane_id}-planready"
        ):
            raise Refusal("RECOVERY_INVOCATION_IDENTITY_INVALID")
        expected = (
            f"devai-cli-{str(identity.get('candidate'))[:7]}-"
            f"{attempt_id}-{selected}-planready"
        )
    else:
        phase = identity.get("phase")
        if phase not in {"baseline", "mutation"}:
            raise Refusal("RECOVERY_INVOCATION_IDENTITY_INVALID")
        if (
            identity.get("allocationId") != f"exact-current-{lane_id}-{attempt_id}"
            or identity.get("shardId") != f"{lane_id}-exact-current"
        ):
            raise Refusal("RECOVERY_INVOCATION_IDENTITY_INVALID")
        expected = (
            f"devai-cli-{str(identity.get('candidate'))[:7]}-"
            f"{identity.get('allocationId')}-{identity.get('shardId')}-{phase}"
        )
    if (
        identity.get("candidate") != candidate
        or identity.get("tree") != tree
        or recorded_name != expected
        or not re.fullmatch(r"[A-Za-z0-9_.-]+", recorded_name)
        or (identity.get("selectedLane") is not None and identity.get("selectedLane") != lane_id)
    ):
        raise Refusal("RECOVERY_INVOCATION_NAME_MISMATCH")
    lane = identity.get("lane")
    if not isinstance(lane, dict) or set(lane) != {
        "cpus", "memory", "memorySwap", "pidsLimit", "workers"
    }:
        raise Refusal("RECOVERY_INVOCATION_IDENTITY_INVALID")
    if (
        not isinstance(lane["cpus"], int)
        or isinstance(lane["cpus"], bool)
        or lane["cpus"] < 1
        or not isinstance(lane["pidsLimit"], int)
        or isinstance(lane["pidsLimit"], bool)
        or lane["pidsLimit"] < 1
        or not isinstance(lane["workers"], int)
        or isinstance(lane["workers"], bool)
        or lane["workers"] < 1
        or not re.fullmatch(r"[1-9][0-9]*[kKmMgG]?", str(lane["memory"]))
        or not re.fullmatch(r"[1-9][0-9]*[kKmMgG]?", str(lane["memorySwap"]))
        or not re.fullmatch(r"sha256:[a-f0-9]{64}", str(identity.get("image")))
    ):
        raise Refusal("RECOVERY_INVOCATION_IDENTITY_INVALID")
    case = invocation_path.parent
    candidate_path = case.parent / "candidate"
    command = (
        'mkdir -p /root/.npm; cp -a /npm-seed/. /root/.npm/; node /devai-host/run.mjs'
        if identity.get("phase") == "planready"
        else 'mkdir -p /root/.npm; cp -a /npm-seed/. /root/.npm/; node /devai-host/run.mjs & p=$!; wait "$p"; exit $?'
    )
    expected_argv = [
        docker,
        "create",
        "--name",
        expected,
        "--label",
        f"devai.diagnostic.group={group}",
        "--network",
        "none",
        "--cpus",
        str(lane["cpus"]),
        "--memory",
        str(lane["memory"]),
        "--memory-swap",
        str(lane["memorySwap"]),
        "--pids-limit",
        str(lane["pidsLimit"]),
        "--env",
        "npm_config_offline=true",
        "--mount",
        f"type=bind,source={candidate_path},target=/workspace/candidate,readonly",
        "--mount",
        f"type=bind,source={case / 'host'},target=/devai-host,readonly",
        "--mount",
        f"type=bind,source={case / 'results'},target=/results",
        "--mount",
        f"type=bind,source={candidate_path}/node_modules/.devai-npm-cache,target=/npm-seed,readonly",
        "--workdir",
        "/workspace/candidate",
        str(identity.get("image")),
        "/bin/sh",
        "-ec",
        command,
    ]
    if len(argv) != len(expected_argv):
        raise Refusal("RECOVERY_INVOCATION_INVALID")
    for recorded, required in zip(argv, expected_argv):
        if recorded != required:
            raise Refusal("RECOVERY_INVOCATION_INVALID")
    return expected, identity, argv


def docker_memory_bytes(value: str) -> int:
    match = re.fullmatch(r"([1-9][0-9]*)([kKmMgG])?", value)
    if match is None:
        raise Refusal("RECOVERY_INVOCATION_IDENTITY_INVALID")
    multiplier = {None: 1, "k": 1024, "m": 1024**2, "g": 1024**3}[
        match.group(2).lower() if match.group(2) else None
    ]
    return int(match.group(1)) * multiplier


def invocation_mounts(argv: list[str]) -> set[tuple[str, str, str, bool]]:
    mounts: set[tuple[str, str, str, bool]] = set()
    for index, item in enumerate(argv):
        if item != "--mount":
            continue
        if index + 1 >= len(argv):
            raise Refusal("RECOVERY_INVOCATION_INVALID")
        fields: dict[str, str | bool] = {}
        for part in argv[index + 1].split(","):
            if "=" in part:
                key, value = part.split("=", 1)
                fields[key] = value
            else:
                fields[part] = True
        if not {"type", "source", "target"}.issubset(fields) or not set(fields).issubset(
            {"type", "source", "target", "readonly"}
        ):
            raise Refusal("RECOVERY_INVOCATION_INVALID")
        mounts.add(
            (
                str(fields["type"]),
                str(fields["source"]),
                str(fields["target"]),
                fields.get("readonly") is True,
            )
        )
    if len(mounts) != 4:
        raise Refusal("RECOVERY_INVOCATION_INVALID")
    return mounts


def inspected_mounts(record: dict[str, Any]) -> set[tuple[str, str, str, bool]] | None:
    observed = record.get("HostConfig", {}).get("Mounts")
    if not isinstance(observed, list) or any(not isinstance(item, dict) for item in observed):
        return None
    normalized: set[tuple[str, str, str, bool]] = set()
    for item in observed:
        if not isinstance(item.get("ReadOnly"), bool):
            return None
        normalized.add(
            (
                str(item.get("Type")),
                str(item.get("Source")),
                str(item.get("Target")),
                item["ReadOnly"],
            )
        )
    return normalized


def inspect_invocation_container(
    runner: ModuleType,
    name: str,
    group: str,
    identity: dict[str, Any],
    argv: list[str],
) -> dict[str, object]:
    try:
        output = runner.docker(
            ["ps", "-aq", "--no-trunc", "--filter", f"name=^/{name}$"]
        )
        ids = [item for item in output.splitlines() if item]
        if not ids:
            return {"name": name, "status": "absent"}
        if len(ids) != 1 or not re.fullmatch(r"[a-f0-9]{64}", ids[0]):
            return {"name": name, "status": "mismatch", "ids": ids}
        inspected = json.loads(runner.docker(["inspect", ids[0]]))
        if len(inspected) != 1 or not isinstance(inspected[0], dict):
            return {"name": name, "status": "mismatch", "ids": ids}
        record = inspected[0]
        configuration = record.get("Config", {})
        host = record.get("HostConfig", {})
        labels = configuration.get("Labels", {})
        lane = identity["lane"]
        mounts = invocation_mounts(argv)
        expected_command = argv[argv.index("--workdir") + 3 :]
        expected_memory = docker_memory_bytes(str(lane["memory"]))
        custody_matches = (
            record.get("Id") == ids[0]
            and record.get("Name") == f"/{name}"
            and labels.get("devai.diagnostic.group") == group
            and configuration.get("Image") == identity.get("image")
            and configuration.get("Cmd") == expected_command
            and configuration.get("WorkingDir") == "/workspace/candidate"
            and "npm_config_offline=true" in configuration.get("Env", [])
            and host.get("NanoCpus") == int(float(lane["cpus"]) * 1_000_000_000)
            and host.get("Memory") == expected_memory
            and host.get("MemorySwap") == docker_memory_bytes(str(lane["memorySwap"]))
            and host.get("PidsLimit") == lane["pidsLimit"]
            and host.get("NetworkMode") == "none"
            and inspected_mounts(record) == mounts
        )
        if not custody_matches:
            return {
                "name": name,
                "status": "mismatch",
                "id": ids[0],
                "observedName": record.get("Name"),
                "observedGroup": labels.get("devai.diagnostic.group"),
            }
        state = record.get("State")
        if (
            not isinstance(state, dict)
            or not isinstance(state.get("Status"), str)
            or any(
                not isinstance(state.get(field), bool)
                for field in ("Running", "Paused", "Restarting", "OOMKilled", "Dead")
            )
            or not isinstance(state.get("Pid"), int)
            or isinstance(state.get("Pid"), bool)
            or not isinstance(state.get("ExitCode"), int)
            or isinstance(state.get("ExitCode"), bool)
        ):
            return {"name": name, "status": "mismatch", "id": ids[0]}
        state_status = state["Status"]
        if state_status in {"exited", "dead"}:
            if (
                state["Running"]
                or state["Paused"]
                or state["Restarting"]
                or state["Pid"] != 0
                or state["Dead"] != (state_status == "dead")
            ):
                return {"name": name, "status": "mismatch", "id": ids[0]}
            recovery_status = "terminal-custody-matching"
        elif state_status in {"created", "running", "paused", "restarting", "removing"}:
            recovery_status = "nonterminal-custody-matching"
        else:
            return {
                "name": name,
                "status": "mismatch",
                "id": ids[0],
                "observedState": state_status,
            }
        return {
            "name": name,
            "status": recovery_status,
            "custody": "full-invocation",
            "id": ids[0],
            "state": state,
        }
    except Exception as error:
        return {
            "name": name,
            "status": "inspection-unavailable",
            "error": type(error).__name__,
        }


def recover_invocation_intents(
    root: Path,
    runner: ModuleType,
    group: str,
    attempt_id: str,
    lane_id: str,
    candidate: str,
    tree: str,
) -> list[dict[str, object]]:
    recovered: list[dict[str, object]] = []
    invocation_parents: set[Path] = set()
    for path in current_attempt_invocation_records(root):
        invocation_parents.add(path.parent)
        relative = path.relative_to(root).as_posix()
        container_path = path.parent / "container.json"
        try:
            container_path.lstat()
            has_container_record = True
        except FileNotFoundError:
            has_container_record = False
        try:
            name, identity, argv = expected_invocation_name(
                path, str(runner.DOCKER), group, attempt_id, lane_id, candidate, tree
            )
            binding: dict[str, object] | None = None
            if has_container_record:
                try:
                    mode = container_path.lstat().st_mode
                    value = json.loads(container_path.read_bytes())
                except Exception as error:
                    raise Refusal("RECOVERY_CONTAINER_RECORD_INVALID") from error
                if (
                    container_path.is_symlink()
                    or not stat.S_ISREG(mode)
                    or not isinstance(value, dict)
                    or set(value) != {"id", "name"}
                    or value.get("name") != name
                    or not re.fullmatch(r"[a-f0-9]{64}", str(value.get("id")))
                ):
                    raise Refusal("RECOVERY_CONTAINER_RECORD_INVALID")
                binding = {"id": value["id"], "name": value["name"]}
            inspection = inspect_invocation_container(runner, name, group, identity, argv)
            if (
                binding is not None
                and inspection.get("id") is not None
                and inspection.get("id") != binding["id"]
            ):
                inspection = {
                    "name": name,
                    "status": "mismatch",
                    "error": "RECOVERY_CONTAINER_RECORD_ID_MISMATCH",
                }
            recovered.append({
                "invocation": relative,
                "adjacentContainerRecord": has_container_record,
                **({"containerRecord": binding} if binding is not None else {}),
                **inspection,
            })
        except Refusal as error:
            recovered.append(
                {
                    "invocation": relative,
                    "adjacentContainerRecord": has_container_record,
                    "status": "mismatch",
                    "error": str(error).split(":", 1)[0],
                }
            )
    for container_path in current_attempt_container_records(root):
        if container_path.parent in invocation_parents:
            continue
        recovered.append(
            {
                "containerRecord": container_path.relative_to(root).as_posix(),
                "adjacentContainerRecord": True,
                "status": "mismatch",
                "error": "RECOVERY_CONTAINER_WITHOUT_INVOCATION",
            }
        )
    return recovered


def refuse_unsealable_recovery(inspections: list[dict[str, object]]) -> None:
    if any(item.get("adjacentContainerRecord") is True for item in inspections):
        raise Refusal("RECOVERY_ADJACENT_CONTAINER_RECORD_PRESENT")
    statuses = {item.get("status") for item in inspections}
    if "inspection-unavailable" in statuses:
        raise Refusal("RECOVERY_ORPHAN_INSPECTION_UNAVAILABLE")
    if "mismatch" in statuses or not statuses.issubset(
        {
            "absent",
            "terminal-custody-matching",
            "nonterminal-custody-matching",
        }
    ):
        raise Refusal("RECOVERY_ORPHAN_CONTAINER_MISMATCH")
    if "nonterminal-custody-matching" in statuses:
        raise Refusal("RECOVERY_ORPHAN_CONTAINER_NONTERMINAL")
    if "terminal-custody-matching" in statuses:
        raise Refusal("RECOVERY_ORPHAN_CONTAINER_RESTARTABLE")


def seal_recovered_partial_attempt(
    root: Path,
    preparation_sha: str,
    attempt_id: str,
    candidate: str,
    tree: str,
    lane_id: str,
    runner: ModuleType,
    group: str,
) -> dict[str, object]:
    inspections = recover_invocation_intents(
        root, runner, group, attempt_id, lane_id, candidate, tree
    )
    refuse_unsealable_recovery(inspections)
    return seal_attempt(
        root,
        preparation_sha,
        attempt_id,
        candidate,
        tree,
        lane_id,
        "recovered-interrupted",
        "PARTIAL_ATTEMPT_STATE_FOUND",
        runner,
        inspections,
    )


def seal_attempt(
    root: Path,
    preparation_sha256: str,
    attempt_id: str,
    candidate: str,
    tree: str,
    lane_id: str,
    status_value: str,
    error_code: str | None,
    runner: ModuleType | None,
    recovery_inspections: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    members = attempt_evidence_files(root)
    index = {
        "kind": "diagnostic-cli-exact-current-lane-attempt-index",
        "version": 1,
        "attemptId": attempt_id,
        "selectedLane": lane_id,
        "files": members,
    }
    replace_json(root / "attempt-index.json", index)
    completion: dict[str, object] = {
        "kind": "diagnostic-cli-exact-current-lane-attempt-completion",
        "version": 1,
        "diagnosticOnly": True,
        "productionCertification": False,
        "attemptId": attempt_id,
        "candidate": candidate,
        "tree": tree,
        "selectedLane": lane_id,
        "preparationCompletionSha256": preparation_sha256,
        "status": status_value,
        "errorCode": error_code,
        "attemptIndexSha256": sha_file(root / "attempt-index.json"),
        "containers": observed_containers(root, runner),
        "recoveryInspections": recovery_inspections or [],
    }
    write_json_exclusive(root / "attempt-completion.json", completion)
    return completion


def seal_failure_after_runtime_reconciliation(
    root: Path,
    preparation_sha: str,
    attempt_id: str,
    candidate: str,
    tree: str,
    lane_id: str,
    status_value: str,
    error_code: str,
    runner: ModuleType,
    group: str,
) -> dict[str, object]:
    has_runtime_records = bool(
        current_attempt_invocation_records(root)
        or current_attempt_container_records(root)
    )
    inspections: list[dict[str, object]] = []
    if has_runtime_records:
        inspections = recover_invocation_intents(
            root, runner, group, attempt_id, lane_id, candidate, tree
        )
        refuse_unsealable_recovery(inspections)
    return seal_attempt(
        root,
        preparation_sha,
        attempt_id,
        candidate,
        tree,
        lane_id,
        status_value,
        error_code,
        runner,
        inspections,
    )


def validate_attempt_seal(
    root: Path, preparation_sha256: str, candidate: str, tree: str, lane_id: str
) -> dict[str, Any]:
    completion = load_json(root / "attempt-completion.json", "ATTEMPT_COMPLETION_INVALID")
    expected = {
        "candidate": candidate,
        "tree": tree,
        "preparationCompletionSha256": preparation_sha256,
        "selectedLane": lane_id,
    }
    if (
        completion.get("kind") != "diagnostic-cli-exact-current-lane-attempt-completion"
        or completion.get("diagnosticOnly") is not True
        or {key: completion.get(key) for key in expected} != expected
    ):
        raise Refusal("ATTEMPT_COMPLETION_IDENTITY_MISMATCH")
    index_path = root / "attempt-index.json"
    regular_file(
        index_path,
        completion.get("attemptIndexSha256", ""),
        "ATTEMPT_INDEX_BINDING_INVALID",
    )
    index = load_json(index_path, "ATTEMPT_INDEX_INVALID")
    if (
        index.get("attemptId") != completion.get("attemptId")
        or index.get("selectedLane") != lane_id
        or index.get("files") != attempt_evidence_files(root)
    ):
        raise Refusal("ATTEMPT_EVIDENCE_CHANGED")
    return completion


def runtime_attempt_started(root: Path) -> bool:
    return bool(
        current_attempt_container_records(root)
        or current_attempt_invocation_records(root)
    ) or any(
        (root / name).exists()
        for name in ("retained-planready", "current-map.json", "targeted", "execution-completion.json")
    )


def acquire_execution_lock(root: Path) -> int:
    path = root / ".execution.lock"
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
        state = os.fstat(descriptor)
        if not stat.S_ISREG(state.st_mode):
            raise Refusal("EXECUTION_LOCK_INVALID")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        if "descriptor" in locals():
            os.close(descriptor)
        raise Refusal("EXECUTION_ALREADY_RUNNING") from error
    except OSError as error:
        if "descriptor" in locals():
            os.close(descriptor)
        raise Refusal("EXECUTION_LOCK_INVALID") from error
    return descriptor


def release_execution_lock(descriptor: int) -> None:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
    finally:
        os.close(descriptor)


def attempt_identity(preparation_sha256: str, lane_id: str) -> tuple[str, str]:
    if not re.fullmatch(r"[a-f0-9]{64}", preparation_sha256):
        raise Refusal("PREPARATION_COMPLETION_BINDING_INVALID")
    lane_id = validate_lane(lane_id)
    attempt_id = preparation_sha256[:12]
    return attempt_id, f"cli-exact-current-{lane_id}-{attempt_id}"


def execute(args: argparse.Namespace) -> dict[str, object]:
    if args.authorization != "RUN_DIAGNOSTIC_CLI_LANE_EXACT_CURRENT":
        raise Refusal("EXPLICIT_DIAGNOSTIC_LAUNCH_AUTHORIZATION_REQUIRED")
    completion_path, _ = parse_bound_file(
        args.prepared, "PREPARATION_COMPLETION_BINDING_INVALID"
    )
    descriptor = acquire_execution_lock(completion_path.parent)
    try:
        return execute_locked(args)
    finally:
        release_execution_lock(descriptor)


def execute_locked(args: argparse.Namespace) -> dict[str, object]:
    root, preparation, inputs, config = validate_preparation(args.prepared)
    repo = Path(inputs["repository"])
    bind_candidate(repo, preparation["candidate"], preparation["tree"])
    runner_binding = inputs["runner"]
    runner = load_module(
        Path(runner_binding["path"]),
        runner_binding["sha256"],
        "devai_cli_sharded_bound",
        "SHARDED_RUNNER_BINDING_INVALID",
    )
    mapper_binding = inputs["mapperReference"]
    mapper = load_module(
        Path(mapper_binding["path"]),
        mapper_binding["sha256"],
        "devai_cli_mapper_bound",
        "MAPPER_REFERENCE_BINDING_INVALID",
    )
    lane_id = validate_lane(inputs.get("selectedLane"))
    snapshot = validate_control_snapshot(
        root,
        inputs.get("controlSnapshot"),
        config,
        repo,
        preparation["candidate"],
        preparation["tree"],
        lane_id,
    )
    runner_base = snapshot / "material"
    if Path(runner_binding["path"]).parent != runner_base:
        raise Refusal("CONTROL_SNAPSHOT_RUNNER_BINDING_INVALID")
    expected_repository = root / "planready" / f"{lane_id}-planready" / "candidate"
    if repo != expected_repository.resolve():
        raise Refusal("PREPARED_REPOSITORY_BINDING_INVALID")
    bind_runner_controls(runner, runner_base, repo)
    preparation_sha = parse_bound_file(
        args.prepared, "PREPARATION_COMPLETION_BINDING_INVALID"
    )[1]
    attempt_id, group = attempt_identity(preparation_sha, lane_id)
    if (root / "attempt-completion.json").exists():
        prior = validate_attempt_seal(
            root, preparation_sha, preparation["candidate"], preparation["tree"], lane_id
        )
        if prior.get("status") == "succeeded":
            execution_path = root / "execution-completion.json"
            execution = load_json(execution_path, "EXECUTION_COMPLETION_INVALID")
            if (
                execution.get("attemptId") != attempt_id
                or execution.get("selectedLane") != lane_id
                or execution.get("candidate") != preparation["candidate"]
                or execution.get("tree") != preparation["tree"]
                or execution.get("preparationCompletionSha256") != preparation_sha
            ):
                raise Refusal("EXECUTION_COMPLETION_ATTEMPT_MISMATCH")
            return {
                "output": str(execution_path),
                "sha256": sha_file(execution_path),
                "mapped": execution.get("eventCompleteness", {}).get("plannedMutants"),
                "creditedKilled": execution.get("eventCompleteness", {}).get("credit", {}).get("killed"),
                "reconciled": True,
            }
        raise Refusal("PREVIOUS_ATTEMPT_TERMINAL_REQUIRES_NEW_PREPARATION")
    if runtime_attempt_started(root):
        seal_recovered_partial_attempt(
            root,
            preparation_sha,
            attempt_id,
            preparation["candidate"],
            preparation["tree"],
            lane_id,
            runner,
            group,
        )
        raise Refusal("PARTIAL_ATTEMPT_SEALED_REQUIRES_NEW_PREPARATION")
    runner.assert_no_foreign_running(group)
    try:
        planready_case = root / "planready" / f"{lane_id}-planready" / "baseline"
        execute_planready(planready_case, runner, group, attempt_id)
        retained_plan = root / "retained-planready"
        retain_planready(planready_case, retained_plan)
        current_plan_path = retained_plan / "results-census-plan.json"
        current_plan = plan_population(load_json(current_plan_path, "CURRENT_PLAN_INVALID"))
        inventory_path = Path(inputs["consolidated"]["path"])
        inventory = load_consolidated(
            inventory_path, preparation["candidate"], preparation["tree"]
        )
        claims = [claim for claim in inventory["claims"] if claim["lane"] == lane_id]
        if not claims:
            raise Refusal("SELECTED_LANE_CLAIM_POPULATION_EMPTY")
        retained_bindings = [
            item for item in inputs["frozenRetained"] if item["lane"] == lane_id
        ]
        if len(retained_bindings) != 1:
            raise Refusal("SELECTED_LANE_FROZEN_RETENTION_BINDING_INVALID")
        frozen_retained = Path(retained_bindings[0]["path"])
        frozen_identity = frozen_campaign(inventory)
        frozen_plan = load_frozen_plan(frozen_retained, frozen_identity, lane_id)
        mapped = map_claims(claims, frozen_plan, current_plan, mapper.structural)
        source_bindings, changed_source_paths = verify_source_blobs(
            repo,
            preparation["candidate"],
            frozen_identity["commit"],
            frozen_retained,
            mapped,
        )
        verify_changed_source_plan_bijection(
            frozen_plan, current_plan, changed_source_paths
        )
        ranges = derive_exact_ranges(mapped, current_plan)
        mapping = {
            "kind": "devai-cli-exact-current-lane-plan-remediation-map",
            "version": 1,
            "diagnosticOnly": True,
            "launchAuthorized": False,
            "candidate": preparation["candidate"],
            "tree": preparation["tree"],
            "consolidatedInventorySha256": inputs["consolidated"]["sha256"],
            "currentPlanSha256": sha_file(current_plan_path),
            "sourceBlobSha256": source_bindings,
            "changedSourceContinuity": {
                "policy": "append-only-inert-local-named-exports-and-full-file-plan-bijection",
                "paths": sorted(changed_source_paths),
            },
            "mappedClaims": mapped,
            "exactMutateRanges": ranges,
            "population": {
                "count": len(mapped),
                "sha256": sha_bytes(
                    canonical(
                        [
                            [item["lane"], item["frozenMutantId"], item["currentMutantId"]]
                            for item in mapped
                        ]
                    )
                ),
            },
        }
        write_json_exclusive(root / "current-map.json", mapping)
        target_parent = root / "targeted"
        target_parent.mkdir()
        target_shard = {
            "id": f"{lane_id}-exact-current",
            "sources": sorted({item["path"] for item in mapped}),
        }
        config["allocation_id"] = f"exact-current-{lane_id}-{attempt_id}"
        config["census_evidence"] = {
            "candidate": preparation["candidate"],
            "tree": preparation["tree"],
            "mutantExecutionStarted": False,
            "maximumPossibleScore": load_json(
                planready_case / "results/census-summary.json", "PLANREADY_SUMMARY_INVALID"
            ).get("maximumPossibleScore"),
        }
        validate_control_snapshot(
            root,
            inputs.get("controlSnapshot"),
            config,
            repo,
            preparation["candidate"],
            preparation["tree"],
            lane_id,
        )
        targeted = runner.prepare(target_parent, config, target_shard)
        validate_control_snapshot(
            root,
            inputs.get("controlSnapshot"),
            config,
            repo,
            preparation["candidate"],
            preparation["tree"],
            lane_id,
        )
        target_materialization_sha = write_materialization_manifest(
            targeted / "materialization.json",
            targeted / "candidate",
            preparation["candidate"],
            preparation["tree"],
        )
        patch_target_cases(
            targeted,
            ranges,
            mapped,
            sha_file(current_plan_path),
            inputs["consolidated"]["sha256"],
            target_materialization_sha,
        )
        for phase in ("baseline", "mutation"):
            verify_materialization_manifest(
                targeted / "materialization.json",
                target_materialization_sha,
                targeted / "candidate",
                preparation["candidate"],
                preparation["tree"],
            )
            runner.assert_no_foreign_running(group)
            runner.execute(targeted, phase, group)
            verify_materialization_manifest(
                targeted / "materialization.json",
                target_materialization_sha,
                targeted / "candidate",
                preparation["candidate"],
                preparation["tree"],
            )
        completeness = verify_execution(
            targeted / "mutation/results/events",
            targeted / "mutation/results/mutation.json",
            mapped,
            source_bindings,
        )
        credit = completeness["credit"]
        completion = {
            "kind": "diagnostic-cli-exact-current-lane-completion",
            "version": 1,
            "diagnosticOnly": True,
            "productionCertification": False,
            "attemptId": attempt_id,
            "selectedLane": lane_id,
            "candidate": preparation["candidate"],
            "tree": preparation["tree"],
            "preparationCompletionSha256": preparation_sha,
            "planreadyRetentionCompletionSha256": sha_file(
                retained_plan / "retention-completion.json"
            ),
            "mappingSha256": sha_file(root / "current-map.json"),
            "targetRetentionCompletionSha256": sha_file(
                targeted / "retained/retention-completion.json"
            ),
            "eventCompleteness": completeness,
            "status": (
                "execution-complete-all-mapped-killed"
                if credit["allMappedClaimsKilled"]
                else "execution-complete-with-non-killed-claims"
            ),
        }
        write_json_exclusive(root / "execution-completion.json", completion)
        seal_attempt(
            root,
            preparation_sha,
            attempt_id,
            preparation["candidate"],
            preparation["tree"],
            lane_id,
            "succeeded",
            None,
            runner,
        )
        return {
            "output": str(root / "execution-completion.json"),
            "sha256": sha_file(root / "execution-completion.json"),
            "mapped": len(mapped),
            "creditedKilled": credit["killed"],
            "reconciled": False,
        }
    except BaseException as error:
        if not (root / "attempt-completion.json").exists():
            code = str(error).split(":", 1)[0] or type(error).__name__
            seal_failure_after_runtime_reconciliation(
                root,
                preparation_sha,
                attempt_id,
                preparation["candidate"],
                preparation["tree"],
                lane_id,
                "interrupted" if isinstance(error, (KeyboardInterrupt, SystemExit)) else "failed",
                code[:160],
                runner,
                group,
            )
        raise


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    commands = root.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--repo", type=Path, required=True)
    prepare_parser.add_argument("--lane", required=True, metavar="shard-NN")
    prepare_parser.add_argument("--final-candidate", required=True)
    prepare_parser.add_argument("--final-tree", required=True)
    prepare_parser.add_argument("--consolidated", required=True, metavar="PATH=SHA256")
    prepare_parser.add_argument("--frozen-retained", action="append", required=True, metavar="LANE=DIR=SHA256")
    prepare_parser.add_argument("--runner", required=True, metavar="PATH=SHA256")
    prepare_parser.add_argument("--mapper", required=True, metavar="PATH=SHA256")
    prepare_parser.add_argument("--census-program", required=True, metavar="PATH=SHA256")
    prepare_parser.add_argument("--campaign-config", required=True, metavar="PATH=SHA256")
    prepare_parser.add_argument("--git", required=True, metavar="PATH=SHA256")
    prepare_parser.add_argument("--node", required=True, metavar="PATH=SHA256")
    prepare_parser.add_argument("--output", type=Path, required=True)
    execute_parser = commands.add_parser("execute")
    execute_parser.add_argument("--prepared", required=True, metavar="PREPARATION_COMPLETION=SHA256")
    execute_parser.add_argument("--authorization", required=True)
    return root


def main() -> None:
    args = parser().parse_args()
    try:
        result = prepare(args) if args.command == "prepare" else execute(args)
        print(json.dumps(result, sort_keys=True))
    except Refusal as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
