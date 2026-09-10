#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import io
import subprocess
import shutil
import tempfile
import tarfile
import unittest
from pathlib import Path
from unittest import mock


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("harness", HERE / "cli_exact_current_lane.py")
assert SPEC and SPEC.loader
harness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(harness)
TEST_GIT = Path("/usr/bin/git")
TEST_NODE = Path(shutil.which("node") or "")
harness.activate_executables(
    {
        "git": harness.executable_binding(TEST_GIT, harness.sha_file(TEST_GIT)),
        "node": harness.executable_binding(TEST_NODE, harness.sha_file(TEST_NODE)),
    }
)


def mutant(mutant_id: str, replacement: str = "false", status: str = "Killed") -> dict:
    return {
        "id": mutant_id,
        "fileName": "packages/cli/src/example.ts",
        "location": {"start": {"line": 1, "column": 2}, "end": {"line": 1, "column": 6}},
        "mutatorName": "BooleanLiteral",
        "replacement": replacement,
        "static": False,
        "status": status,
    }


def mapped(value: dict, frozen_id: str | None = None) -> dict:
    return {
        "lane": "shard-10",
        "frozenMutantId": frozen_id or value["id"],
        "currentMutantId": value["id"],
        "path": value["fileName"],
        "location": value["location"],
        "mutatorName": value["mutatorName"],
        "replacement": value["replacement"],
        "static": value["static"],
    }


def write_frozen_retention(root: Path) -> tuple[dict[str, str], str]:
    campaign = {"commit": "a" * 40, "tree": "b" * 40, "id": "campaign-1"}
    lane = "shard-10"
    planned = mutant("7")
    planned.pop("status")
    event_name = "1-onMutationTestingPlanReady.json"
    event_path = root / event_name
    event_path.write_bytes(harness.canonical({"mutantPlans": [{"mutant": planned}]}))
    archive = root / "events.tgz"
    with tarfile.open(archive, "x:gz") as bundle:
        bundle.add(event_path, arcname=event_name, recursive=False)
    event_path.unlink()
    identity = {
        "candidate": campaign["commit"],
        "tree": campaign["tree"],
        "campaignId": campaign["id"],
        "shardId": lane,
    }
    container_id = "c" * 64
    execution = {
        "candidate": campaign["commit"],
        "phase": "mutation",
        "containerId": container_id,
    }
    files = {
        "identity.json": identity,
        "invocation.json": [],
        "container.json": {"id": container_id},
        "output.log": "ok\n",
        "mutation.json": {"files": {}},
        "resources.json": {},
        "execution-completion.json": execution,
    }
    for name, value in files.items():
        if isinstance(value, str):
            (root / name).write_text(value)
        else:
            (root / name).write_bytes(harness.canonical(value))
    indexed = []
    for name in sorted([*files, "events.tgz"]):
        path = root / name
        indexed.append(
            {"path": name, "sha256": harness.sha_file(path), "bytes": path.stat().st_size}
        )
    event_bytes = harness.canonical({"mutantPlans": [{"mutant": planned}]})
    index = {
        "diagnosticOnly": True,
        "candidate": campaign["commit"],
        "tree": campaign["tree"],
        "campaignId": campaign["id"],
        "shardId": lane,
        "containerId": container_id,
        "files": indexed,
        "eventMembers": [
            {
                "path": event_name,
                "sha256": hashlib.sha256(event_bytes).hexdigest(),
                "bytes": len(event_bytes),
            }
        ],
    }
    (root / "retention-index.json").write_bytes(harness.canonical(index))
    completion = {
        "kind": "diagnostic-cli-shard-retention-completion",
        "version": 1,
        "diagnosticOnly": True,
        "candidate": campaign["commit"],
        "tree": campaign["tree"],
        "campaignId": campaign["id"],
        "shardId": lane,
        "containerId": container_id,
        "identitySha256": harness.sha_file(root / "identity.json"),
        "executionCompletionSha256": harness.sha_file(root / "execution-completion.json"),
        "retentionIndexSha256": harness.sha_file(root / "retention-index.json"),
        "eventsArchiveSha256": harness.sha_file(archive),
    }
    (root / "retention-completion.json").write_bytes(harness.canonical(completion))
    return campaign, lane


def write_preparation_pins(root: Path) -> tuple[Path, dict[str, str]]:
    runner = root / "runner.py"
    runner.write_text("# runner\n")
    values = {
        "extract-dependencies.mjs": "extractor\n",
        "local-small-packages-inputs/dependencies/dependencies.json": "{}\n",
        "notebook-baselines-1/cli/stryker.config.json": "{}\n",
    }
    pins: dict[str, str] = {}
    for relative, content in values.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        pins[relative] = harness.sha_file(path)
    return runner, pins


def write_dependency_fixture(root: Path) -> tuple[Path, str, dict]:
    repo = root / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q", str(repo)], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.email", "fixture@example.test"], check=True)
    subprocess.run(["git", "-C", str(repo), "config", "user.name", "Fixture"], check=True)
    input_files = []
    for name, content in (
        ("package.json", '{"name":"root"}\n'),
        ("pnpm-lock.yaml", "lock\n"),
        ("pnpm-workspace.yaml", "workspace\n"),
    ):
        (repo / name).write_text(content)
        input_files.append({"path": name, "sha256": harness.sha_bytes(content.encode())})
    workspaces = []
    for index in range(harness.EXPECTED_DEPENDENCY_WORKSPACES):
        path = f"packages/pkg-{index}"
        content = json.dumps({"name": f"pkg-{index}"}, separators=(",", ":")) + "\n"
        manifest_path = repo / path / "package.json"
        manifest_path.parent.mkdir(parents=True)
        manifest_path.write_text(content)
        digest = harness.sha_bytes(content.encode())
        input_files.append({"path": f"{path}/package.json", "sha256": digest})
        workspaces.append(
            {"path": path, "name": f"pkg-{index}", "manifest_sha256": digest}
        )
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "fixture"], check=True)
    candidate = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    control = root / "control"
    dependency = control / Path(harness.DEPENDENCY_MANIFEST).parent
    dependency.mkdir(parents=True)
    artifacts = []
    for index in range(harness.EXPECTED_DEPENDENCY_ARCHIVES):
        archive = dependency / f"dep-{index}.tgz"
        archive.write_bytes(f"archive-{index}".encode())
        artifacts.append(
            {
                "file": archive.name,
                "mount_path": f"node_modules/dep-{index}",
                "sha256": harness.sha_file(archive),
                "size_bytes": archive.stat().st_size,
                "regular_files": 1,
                "links": 0,
            }
        )
    tree = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "HEAD^{tree}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    manifest = {
        "protocol": "devai.protected-linux-dependencies.v1",
        "offline_rebuild_identical": True,
        "identity_sha256": "a" * 64,
        "image": "sha256:" + "b" * 64,
        "candidate": {"commit": candidate, "tree": tree},
        "inputs": {"files": input_files, "workspace_packages": workspaces},
        "artifacts": artifacts,
    }
    (control / harness.DEPENDENCY_MANIFEST).write_bytes(harness.canonical(manifest))
    return repo, candidate, manifest


class HarnessRefusalTests(unittest.TestCase):
    def test_dependency_control_requires_exact_declared_archive_population(self) -> None:
        for mutation in ("missing", "extra", "unsafe"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                repo, candidate, manifest = write_dependency_fixture(root)
                if mutation == "missing":
                    manifest["artifacts"] = manifest["artifacts"][:-1]
                elif mutation == "extra":
                    manifest["artifacts"].append(dict(manifest["artifacts"][0]))
                else:
                    manifest["artifacts"][0]["file"] = "../dep-0.tgz"
                (root / "control" / harness.DEPENDENCY_MANIFEST).write_bytes(
                    harness.canonical(manifest)
                )
                with self.assertRaises(harness.Refusal):
                    harness.validate_dependency_control(
                        root / "control", {}, repo, candidate, manifest["candidate"]["tree"]
                    )

    def test_dependency_control_rejects_archive_hash_drift(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo, candidate, manifest = write_dependency_fixture(root)
            archive = (
                root
                / "control"
                / Path(harness.DEPENDENCY_MANIFEST).parent
                / manifest["artifacts"][0]["file"]
            )
            archive.write_bytes(b"drift")
            with self.assertRaisesRegex(
                harness.Refusal, "PREPARATION_DEPENDENCY_ARTIFACT_INVALID"
            ):
                harness.validate_dependency_control(
                    root / "control", {}, repo, candidate, manifest["candidate"]["tree"]
                )

    def test_dist_control_rejects_manifest_mode_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "dist.tgz"
            content = b"export {};\n"
            member_name = "packages/cli/dist/index.js"
            with tarfile.open(archive, "w:gz") as bundle:
                member = tarfile.TarInfo(member_name)
                member.size = len(content)
                member.mode = 0o644
                bundle.addfile(member, io.BytesIO(content))
            manifest = root / "dist.json"
            manifest_value = {
                "candidate": "a" * 40,
                "tree": "b" * 40,
                "archiveSha256": harness.sha_file(archive),
                "members": {
                    member_name: {
                        "bytes": len(content),
                        "sha256": harness.sha_bytes(content),
                        "mode": 0o600,
                    }
                },
            }
            manifest.write_bytes(harness.canonical(manifest_value))
            config = {
                "current_dist_archive": archive.name,
                "current_dist_archive_sha256": harness.sha_file(archive),
                "current_dist_manifest_path": manifest.name,
                "current_dist_manifest_sha256": harness.sha_file(manifest),
            }
            with self.assertRaisesRegex(
                harness.Refusal, "PREPARATION_DIST_ARCHIVE_INVALID"
            ):
                harness.validate_dist_control(
                    root, config, "a" * 40, "b" * 40
                )
    def test_preparation_pins_are_resolved_recorded_and_revalidated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner, pins = write_preparation_pins(Path(directory))
            resolved = harness.resolve_preparation_pins(runner, pins)
            self.assertEqual(
                [entry["relativePath"] for entry in resolved], sorted(pins)
            )
            self.assertTrue(all(Path(entry["path"]).is_absolute() for entry in resolved))
            inputs = {"runner": {"path": str(runner)}, "preparationPins": resolved}
            self.assertEqual(
                harness.revalidate_preparation_pins(
                    inputs, {"preparation_pins": pins}
                ),
                resolved,
            )

    def test_preparation_pin_drift_is_refused_for_every_consumed_input(self) -> None:
        for relative in sorted(harness.PREPARATION_PIN_PATHS):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                runner, pins = write_preparation_pins(root)
                resolved = harness.resolve_preparation_pins(runner, pins)
                (root / relative).write_text("drifted\n")
                with self.assertRaisesRegex(
                    harness.Refusal, "PREPARATION_PIN_BINDING_INVALID"
                ):
                    harness.revalidate_preparation_pins(
                        {"runner": {"path": str(runner)}, "preparationPins": resolved},
                        {"preparation_pins": pins},
                    )

    def test_missing_preparation_pin_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner, pins = write_preparation_pins(root)
            (root / "extract-dependencies.mjs").unlink()
            with self.assertRaisesRegex(
                harness.Refusal, "PREPARATION_PIN_PATH_ESCAPE"
            ):
                harness.resolve_preparation_pins(runner, pins)

    def test_relative_control_names_reject_backslash_and_controls(self) -> None:
        for value in ("a\\b", "a\nb", "a\x7fb", "/a", "../a"):
            with self.subTest(value=repr(value)), self.assertRaises(harness.Refusal):
                harness.safe_relative_name(value, "UNSAFE")

    def test_basename_control_fields_reject_paths_and_controls(self) -> None:
        for value in ("a/b", "a\\b", "../a", "/a", "a\nb", ".", ".."):
            with self.subTest(value=repr(value)), self.assertRaises(harness.Refusal):
                harness.basename_field(value, "UNSAFE")

    def test_strict_copy_rejects_symlink_source_and_parent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "real").write_text("bytes")
            (source / "link").symlink_to("real")
            destination = root / "destination"
            destination.mkdir(mode=0o700)
            with self.assertRaisesRegex(harness.Refusal, "CONTROL_SNAPSHOT_SOURCE_INVALID"):
                harness.copy_regular_exclusive(source, "link", destination, "copy")
            source_link = root / "source-link"
            source_link.symlink_to(source, target_is_directory=True)
            with self.assertRaisesRegex(harness.Refusal, "CONTROL_SNAPSHOT_SOURCE_INVALID"):
                harness.copy_regular_exclusive(source_link, "real", destination, "copy")

    def test_strict_copy_rejects_special_source_and_existing_destination(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            fifo = source / "fifo"
            os.mkfifo(fifo)
            destination = root / "destination"
            destination.mkdir(mode=0o700)
            with self.assertRaisesRegex(harness.Refusal, "CONTROL_SNAPSHOT_SOURCE_INVALID"):
                harness.copy_regular_exclusive(source, "fifo", destination, "copy")
            (source / "regular").write_text("bytes")
            (destination / "copy").write_text("owned")
            with self.assertRaisesRegex(harness.Refusal, "CONTROL_SNAPSHOT_DESTINATION_INVALID"):
                harness.copy_regular_exclusive(source, "regular", destination, "copy")

    def test_strict_copy_rejects_symlink_destination_parent(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            (source / "regular").write_text("bytes")
            destination = root / "destination"
            destination.mkdir(mode=0o700)
            outside = root / "outside"
            outside.mkdir()
            (destination / "nested").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(harness.Refusal, "CONTROL_SNAPSHOT_DESTINATION_INVALID"):
                harness.copy_regular_exclusive(source, "regular", destination, "nested/copy")

    def test_snapshot_manifest_detects_changed_deleted_and_extra_members(self) -> None:
        for mutation in ("changed", "deleted", "extra"):
            with self.subTest(mutation=mutation), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                snapshot = root / "snapshot"
                snapshot.mkdir(mode=0o700)
                member = snapshot / "member"
                member.write_text("bound")
                member.chmod(0o600)
                manifest = root / "manifest.json"
                digest = harness.write_control_snapshot_manifest(
                    manifest, snapshot, "a" * 40, "b" * 40
                )
                if mutation == "changed":
                    member.write_text("drift")
                elif mutation == "deleted":
                    member.unlink()
                else:
                    (snapshot / "extra").write_text("extra")
                    (snapshot / "extra").chmod(0o600)
                with self.assertRaisesRegex(harness.Refusal, "CONTROL_SNAPSHOT_CHANGED"):
                    harness.verify_control_snapshot_manifest(
                        manifest, snapshot, "a" * 40, "b" * 40, digest
                    )

    def test_snapshot_walker_rejects_symlinks_and_special_members(self) -> None:
        for kind in ("symlink", "fifo"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory:
                snapshot = Path(directory) / "snapshot"
                snapshot.mkdir(mode=0o700)
                if kind == "symlink":
                    (snapshot / "member").symlink_to("missing")
                else:
                    os.mkfifo(snapshot / "member")
                with self.assertRaisesRegex(harness.Refusal, "CONTROL_SNAPSHOT_MEMBER_INVALID"):
                    harness.control_snapshot_entries(snapshot)

    def test_bound_module_import_does_not_change_snapshot_population(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            snapshot = Path(directory) / "snapshot"
            snapshot.mkdir(mode=0o700)
            module_path = snapshot / "bound.py"
            module_path.write_text("VALUE = 7\n")
            module_path.chmod(0o600)
            before = harness.control_snapshot_entries(snapshot)
            loaded = harness.load_module(
                module_path,
                harness.sha_file(module_path),
                "bound_fixture",
                "BOUND_FIXTURE_INVALID",
            )
            self.assertEqual(loaded.VALUE, 7)
            self.assertEqual(harness.control_snapshot_entries(snapshot), before)
            self.assertFalse((snapshot / "__pycache__").exists())

    def test_bound_module_executes_the_bytes_read_before_path_swap(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bound.py"
            original = b"VALUE = 'bound'\n"
            path.write_bytes(original)
            real_compile = compile

            def replace_then_compile(source, filename, mode):
                path.write_text("VALUE = 'swapped'\n")
                return real_compile(source, filename, mode)

            with mock.patch("builtins.compile", side_effect=replace_then_compile):
                loaded = harness.load_module(
                    path,
                    harness.sha_bytes(original),
                    "bound_swap_fixture",
                    "BOUND_FIXTURE_INVALID",
                )
            self.assertEqual(loaded.VALUE, "bound")

    def test_runner_subprocess_ignores_path_and_rechecks_bound_binary(self) -> None:
        saved = dict(harness.BOUND_EXECUTABLES)
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / "node"
                path.write_text("node")
                bindings = {
                    "git": saved["git"],
                    "node": harness.executable_binding(path, harness.sha_file(path)),
                }
                harness.activate_executables(bindings)
                proxy = harness.BoundSubprocess("/absolute/docker")
                with mock.patch.object(harness.subprocess, "run", return_value="ok") as run:
                    self.assertEqual(proxy.run(["node", "--version"]), "ok")
                    self.assertEqual(run.call_args.args[0][0], str(root / "node"))
                (root / "node").write_text("same-version-substitution")
                with self.assertRaisesRegex(
                    harness.Refusal, "PREPARATION_EXECUTABLE_CHANGED"
                ):
                    proxy.run(["node", "--version"])
                with self.assertRaisesRegex(
                    harness.Refusal, "RUNNER_SUBPROCESS_EXECUTABLE_UNBOUND"
                ):
                    proxy.run(["python3", "-V"])
                with mock.patch.object(harness.subprocess, "run", return_value="docker") as run:
                    self.assertEqual(proxy.run(["/absolute/docker", "ps"]), "docker")
                    self.assertEqual(run.call_args.args[0], ["/absolute/docker", "ps"])
        finally:
            harness.activate_executables(saved)

    def test_malformed_missing_or_extra_preparation_pins_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner, pins = write_preparation_pins(Path(directory))
            missing = dict(pins)
            missing.pop("extract-dependencies.mjs")
            extra = {**pins, "other.json": "0" * 64}
            malformed = {**pins, "extract-dependencies.mjs": "not-a-digest"}
            for value, code in (
                (missing, "PREPARATION_PIN_POPULATION_INVALID"),
                (extra, "PREPARATION_PIN_POPULATION_INVALID"),
                (malformed, "PREPARATION_PIN_BINDING_INVALID"),
            ):
                with self.subTest(code=code), self.assertRaisesRegex(
                    harness.Refusal, code
                ):
                    harness.resolve_preparation_pins(runner, value)

    def test_preparation_pin_parent_symlink_escape_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            runner, pins = write_preparation_pins(root)
            outside = root.parent / f"{root.name}-outside"
            try:
                outside.mkdir()
                escaped = outside / "cli"
                escaped.mkdir()
                (escaped / "stryker.config.json").write_text("{}\n")
                target = root / "notebook-baselines-1"
                for child in sorted(target.rglob("*"), reverse=True):
                    if child.is_file():
                        child.unlink()
                    elif child.is_dir():
                        child.rmdir()
                target.rmdir()
                target.symlink_to(outside, target_is_directory=True)
                pins["notebook-baselines-1/cli/stryker.config.json"] = harness.sha_file(
                    escaped / "stryker.config.json"
                )
                with self.assertRaisesRegex(
                    harness.Refusal, "PREPARATION_PIN_PATH_ESCAPE"
                ):
                    harness.resolve_preparation_pins(runner, pins)
            finally:
                if outside.exists():
                    for child in sorted(outside.rglob("*"), reverse=True):
                        if child.is_file():
                            child.unlink()
                        elif child.is_dir():
                            child.rmdir()
                    outside.rmdir()

    def test_recorded_preparation_pin_population_mismatch_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            runner, pins = write_preparation_pins(Path(directory))
            resolved = harness.resolve_preparation_pins(runner, pins)
            with self.assertRaisesRegex(
                harness.Refusal, "PREPARATION_PIN_INPUT_BINDING_INVALID"
            ):
                harness.revalidate_preparation_pins(
                    {"runner": {"path": str(runner)}, "preparationPins": resolved[:-1]},
                    {"preparation_pins": pins},
                )

    def test_source_binding_allows_only_inert_named_export_suffixes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / "repo"
            retained = root / "retained"
            repo.mkdir()
            retained.mkdir()
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.email", "fixture@example.test"], check=True)
            subprocess.run(["git", "-C", str(repo), "config", "user.name", "Fixture"], check=True)
            source = repo / "packages/cli/src/example.ts"
            source.parent.mkdir(parents=True)
            frozen = "const value = false;\n"
            source.write_text(frozen)
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "frozen"], check=True)
            frozen_candidate = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            (retained / "mutation.json").write_text(
                json.dumps({"files": {"packages/cli/src/example.ts": {"source": frozen}}})
            )
            entry = mapped(mutant("7"))
            entry["location"] = {
                "start": {"line": 0, "column": 14},
                "end": {"line": 0, "column": 19},
            }

            source.write_text(frozen + "export { value };\n")
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "add export"], check=True)
            candidate = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            bindings, changed = harness.verify_source_blobs(
                repo, candidate, frozen_candidate, retained, [entry]
            )
            self.assertEqual(
                bindings,
                {"packages/cli/src/example.ts": harness.sha_bytes(source.read_bytes())},
            )
            self.assertEqual(changed, {"packages/cli/src/example.ts"})

            (retained / "mutation.json").write_text(
                json.dumps(
                    {
                        "files": {
                            "packages/cli/src/example.ts": {"source": "const value = true;\n"}
                        }
                    }
                )
            )
            with self.assertRaisesRegex(
                harness.Refusal, "FROZEN_REPORT_SOURCE_BINDING_INVALID"
            ):
                harness.verify_source_blobs(
                    repo, candidate, frozen_candidate, retained, [entry]
                )
            (retained / "mutation.json").write_text(
                json.dumps({"files": {"packages/cli/src/example.ts": {"source": frozen}}})
            )

            source.write_text("const value = true;\nexport { value };\n")
            subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
            subprocess.run(["git", "-C", str(repo), "commit", "-qm", "change mapped line"], check=True)
            candidate = subprocess.run(
                ["git", "-C", str(repo), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            with self.assertRaisesRegex(
                harness.Refusal, "TARGET_SOURCE_CHANGED_REQUIRES_MANUAL_REMAP"
            ):
                harness.verify_source_blobs(
                    repo, candidate, frozen_candidate, retained, [entry]
                )

    def test_inert_export_suffix_rejects_active_or_directive_content(self) -> None:
        frozen = b"const value = false;\n"
        self.assertTrue(harness.inert_named_export_suffix(frozen, frozen + b"export { value };\n"))
        for suffix in (
            b"export { value } from './other.js';\n",
            b"export * from './other.js';\n",
            b"export { value as default };\n",
            b"export const other = false;\n",
            b"// Stryker disable all\nexport { value };\n",
            b"const helper = value;\nexport { helper };\n",
        ):
            with self.subTest(suffix=suffix):
                self.assertFalse(harness.inert_named_export_suffix(frozen, frozen + suffix))
        self.assertFalse(
            harness.inert_named_export_suffix(
                frozen, b"const changed = false;\nexport { changed };\n"
            )
        )

    def test_changed_source_requires_full_file_plan_bijection(self) -> None:
        frozen = [{"mutant": {key: value for key, value in mutant("7").items() if key != "status"}}]
        current = [{"mutant": {**frozen[0]["mutant"], "id": "70"}}]
        harness.verify_changed_source_plan_bijection(
            frozen, current, {"packages/cli/src/example.ts"}
        )
        current[0]["mutant"]["replacement"] = "true"
        with self.assertRaisesRegex(
            harness.Refusal, "TARGET_SOURCE_CHANGED_PLAN_POPULATION_MISMATCH"
        ):
            harness.verify_changed_source_plan_bijection(
                frozen, current, {"packages/cli/src/example.ts"}
            )

    def test_attempt_identity_separates_lane_and_preparation(self) -> None:
        first = harness.attempt_identity("a" * 64, "shard-01")
        other_lane = harness.attempt_identity("a" * 64, "shard-02")
        other_preparation = harness.attempt_identity("b" * 64, "shard-01")
        self.assertNotEqual(first[1], other_lane[1])
        self.assertNotEqual(first, other_preparation)

    def test_lane_selection_is_exact_and_cross_lane_retention_is_refused(self) -> None:
        config = {
            "campaign_shards": [
                {"id": "shard-01", "sources": ["packages/cli/src/one.ts"]},
                {"id": "shard-10", "sources": ["packages/cli/src/ten.ts"]},
            ]
        }
        self.assertEqual(
            harness.selected_lane(config, "shard-01"),
            {"id": "shard-01-planready", "sources": ["packages/cli/src/one.ts"]},
        )
        with self.assertRaisesRegex(harness.Refusal, "EXACT_CURRENT_LANE_INVALID"):
            harness.selected_lane(config, "shard-1")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            campaign, _ = write_frozen_retention(root)
            with self.assertRaisesRegex(harness.Refusal, "FROZEN_RETENTION_IDENTITY_MISMATCH"):
                harness.load_frozen_plan(root, campaign, "shard-01")

    def test_binding_mismatch_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            path.write_text("{}\n")
            with self.assertRaisesRegex(harness.Refusal, "INPUT_BINDING_INVALID"):
                harness.parse_bound_file(f"{path}={'0' * 64}", "INPUT_BINDING_INVALID")

    def test_missing_plan_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = root / "events"
            events.mkdir()
            report = root / "mutation.json"
            report.write_text(json.dumps({"files": {}}))
            with self.assertRaisesRegex(harness.Refusal, "EXECUTION_PLAN_MISSING_OR_DUPLICATE"):
                harness.verify_execution(events, report, set())

    def test_duplicate_structural_mapping_is_refused(self) -> None:
        frozen = [{"mutant": {key: value for key, value in mutant("7").items() if key != "status"}}]
        current = [
            {"mutant": {key: value for key, value in mutant("10").items() if key != "status"}},
            {"mutant": {key: value for key, value in mutant("11").items() if key != "status"}},
        ]
        claims = [{"lane": "shard-10", "frozenMutantId": "7"}]
        with self.assertRaisesRegex(harness.Refusal, "CURRENT_PLAN_STRUCTURAL_DUPLICATE"):
            harness.map_claims(claims, frozen, current)

    def test_incomplete_events_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = root / "events"
            events.mkdir()
            first = mutant("10")
            second = mutant("11", replacement="true")
            (events / "1-onMutationTestingPlanReady.json").write_text(
                json.dumps({"mutantPlans": [{"mutant": first}, {"mutant": second}]})
            )
            (events / "2-onMutantTested.json").write_text(json.dumps(first))
            report_value = {
                "files": {
                    "packages/cli/src/example.ts": {
                        "mutants": [
                            {key: value for key, value in first.items() if key != "fileName"},
                            {key: value for key, value in second.items() if key != "fileName"},
                        ]
                    }
                }
            }
            report = root / "mutation.json"
            report.write_text(json.dumps(report_value))
            (events / "3-onMutationTestReportReady.json").write_text(json.dumps(report_value))
            expected = [mapped(first), mapped(second)]
            with self.assertRaisesRegex(harness.Refusal, "EXECUTION_MUTANT_EVENTS_INCOMPLETE"):
                harness.verify_execution(events, report, expected)

    def test_survivor_is_reported_but_receives_no_credit(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            events = root / "events"
            events.mkdir()
            value = mutant("10", status="Survived")
            planned = {key: item for key, item in value.items() if key != "status"}
            (events / "1-onMutationTestingPlanReady.json").write_text(
                json.dumps({"mutantPlans": [{"mutant": planned}]})
            )
            (events / "2-onMutantTested.json").write_text(json.dumps(value))
            report_value = {
                "files": {
                    value["fileName"]: {
                        "source": "const value = false;\n",
                        "mutants": [
                            {key: item for key, item in value.items() if key != "fileName"}
                        ]
                    }
                }
            }
            report = root / "mutation.json"
            report.write_text(json.dumps(report_value))
            (events / "3-onMutationTestReportReady.json").write_text(json.dumps(report_value))
            source_bindings = {
                value["fileName"]: harness.sha_bytes(b"const value = false;\n")
            }
            result = harness.verify_execution(
                events, report, [mapped(value)], source_bindings
            )
            self.assertEqual(result["statusCounts"], {"Survived": 1})
            self.assertEqual(result["credit"]["killed"], 0)
            self.assertFalse(result["credit"]["allMappedClaimsKilled"])
            self.assertFalse(result["outcomes"][0]["credited"])

            report_value["files"][value["fileName"]]["source"] = "changed\n"
            report.write_text(json.dumps(report_value))
            (events / "3-onMutationTestReportReady.json").write_text(json.dumps(report_value))
            with self.assertRaisesRegex(
                harness.Refusal, "EXECUTION_REPORT_SOURCE_BINDING_INVALID"
            ):
                harness.verify_execution(events, report, [mapped(value)], source_bindings)

            report_value["files"][value["fileName"]]["source"] = "const value = false;\n"
            report_value["files"][value["fileName"]]["mutants"][0]["static"] = True
            report.write_text(json.dumps(report_value))
            (events / "3-onMutationTestReportReady.json").write_text(json.dumps(report_value))
            with self.assertRaisesRegex(
                harness.Refusal, "EXECUTION_STRUCTURAL_POPULATION_MISMATCH"
            ):
                harness.verify_execution(events, report, [mapped(value)], source_bindings)

    def test_wrong_frozen_campaign_and_tampered_member_are_refused(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            campaign, lane = write_frozen_retention(root)
            self.assertEqual(len(harness.load_frozen_plan(root, campaign, lane)), 1)
            wrong = {**campaign, "id": "different-campaign"}
            with self.assertRaisesRegex(harness.Refusal, "FROZEN_RETENTION_IDENTITY_MISMATCH"):
                harness.load_frozen_plan(root, wrong, lane)
            (root / "mutation.json").write_text("tampered\n")
            with self.assertRaisesRegex(harness.Refusal, "FROZEN_RETENTION_MEMBER_BINDING_INVALID"):
                harness.load_frozen_plan(root, campaign, lane)

    def test_full_materialization_detects_untracked_dist_or_dependency_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate"
            (candidate / "packages/cli/dist").mkdir(parents=True)
            (candidate / "node_modules/cache").mkdir(parents=True)
            (candidate / "packages/cli/dist/index.js").write_text("dist\n")
            dependency = candidate / "node_modules/cache/dependency.js"
            dependency.write_text("dependency\n")
            manifest = root / "materialization.json"
            digest = harness.write_materialization_manifest(
                manifest, candidate, "a" * 40, "b" * 40
            )
            harness.verify_materialization_manifest(
                manifest, digest, candidate, "a" * 40, "b" * 40
            )
            dependency.write_text("changed\n")
            with self.assertRaisesRegex(harness.Refusal, "EXECUTION_MATERIALIZATION_CHANGED"):
                harness.verify_materialization_manifest(
                    manifest, digest, candidate, "a" * 40, "b" * 40
                )

    def test_full_materialization_refuses_symlink_escape(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = root / "candidate"
            candidate.mkdir()
            outside = root / "outside"
            outside.write_text("outside\n")
            (candidate / "escape").symlink_to(outside)
            with self.assertRaisesRegex(harness.Refusal, "MATERIALIZATION_SYMLINK_ESCAPES_ROOT"):
                harness.materialization_entries(candidate)

    def test_partial_attempt_detection_ignores_candidate_records(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "planready/lane/candidate/fixture").mkdir(parents=True)
            (root / "planready/lane/candidate/fixture/container.json").write_text("{}\n")
            self.assertFalse(harness.runtime_attempt_started(root))
            (root / "planready/lane/baseline").mkdir()
            (root / "planready/lane/baseline/container.json").write_text("{}\n")
            self.assertTrue(harness.runtime_attempt_started(root))

    def test_failed_attempt_is_sealed_and_detects_later_evidence_change(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence = root / "output.log"
            evidence.write_text("failure\n")
            harness.seal_attempt(
                root,
                "d" * 64,
                "d" * 12,
                "a" * 40,
                "b" * 40,
                "shard-10",
                "failed",
                "TEST_FAILURE",
                None,
            )
            value = harness.validate_attempt_seal(
                root, "d" * 64, "a" * 40, "b" * 40, "shard-10"
            )
            self.assertEqual(value["status"], "failed")
            evidence.write_text("changed\n")
            with self.assertRaisesRegex(harness.Refusal, "ATTEMPT_EVIDENCE_CHANGED"):
                harness.validate_attempt_seal(
                    root, "d" * 64, "a" * 40, "b" * 40, "shard-10"
                )


if __name__ == "__main__":
    unittest.main()
