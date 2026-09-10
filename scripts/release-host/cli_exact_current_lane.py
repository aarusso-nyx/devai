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
import hashlib
import importlib.util
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


def git(repo: Path, *args: str) -> str:
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, check=False)
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


def load_module(path: Path, expected: str, name: str, code: str) -> ModuleType:
    regular_file(path, expected, code)
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise Refusal(f"{code}_IMPORT_INVALID")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except Exception as error:
        raise Refusal(f"{code}_IMPORT_INVALID") from error
    return module


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
        frozen_git = subprocess.run(
            ["git", "-C", str(repo), "show", f"{frozen_candidate}:{path}"],
            capture_output=True,
            check=False,
        )
        if frozen_git.returncode or frozen_git.stdout != frozen:
            raise Refusal("FROZEN_REPORT_SOURCE_BINDING_INVALID")
        current = subprocess.run(
            ["git", "-C", str(repo), "show", f"{candidate}:{path}"], capture_output=True, check=False
        )
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
    config["full_source_population"] = committed
    config["campaign_manifest_sha256"] = sha_bytes(
        json.dumps(shards, sort_keys=True, separators=(",", ":")).encode()
    )


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
    prepared_parent = root / "planready"
    prepared_parent.mkdir()
    prepared = runner.prepare(prepared_parent, config, selected_lane(config, lane_id))
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
    repo = args.repo.resolve()
    lane_id = validate_lane(args.lane)
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
    runner = load_module(
        runner_path, runner_sha, "devai_cli_sharded_bound", "SHARDED_RUNNER_BINDING_INVALID"
    )
    if runner_path.parent != census_path.parent or mapper_path.parent != runner_path.parent:
        raise Refusal("DIAGNOSTIC_MATERIAL_ROOT_MISMATCH")
    runner.BASE = runner_path.parent
    runner.REPOSITORY = repo
    bind_source_partition(repo, args.final_candidate, config)
    config.update(
        candidate=args.final_candidate,
        tree=args.final_tree,
        runner_sha256=runner_sha,
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
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        args.output.mkdir(mode=0o700)
    except FileExistsError as error:
        raise Refusal("OUTPUT_ALREADY_EXISTS") from error
    mapper_binder = mapper_path.parent / "prepare-cli-targeted-remediation-final.py"
    if not mapper_binder.is_file() or mapper_binder.is_symlink():
        raise Refusal("MAPPER_BINDER_REFERENCE_INVALID")
    inputs = {
        "kind": "diagnostic-cli-exact-current-lane-inputs",
        "version": 1,
        "diagnosticOnly": True,
        "launchAuthorized": False,
        "candidate": args.final_candidate,
        "tree": args.final_tree,
        "selectedLane": lane_id,
        "repository": str(repo),
        "consolidated": {"path": str(inventory_path), "sha256": inventory_sha},
        "runner": {"path": str(runner_path), "sha256": runner_sha},
        "mapperReference": {"path": str(mapper_path), "sha256": mapper_sha},
        "mapperBinderReference": {"path": str(mapper_binder), "sha256": sha_file(mapper_binder)},
        "censusProgram": {"path": str(census_path), "sha256": census_sha},
        "campaignConfig": {"path": str(config_path), "sha256": config_sha},
        "frozenRetained": retained_bindings,
    }
    write_json_exclusive(args.output / "inputs.json", inputs)
    write_json_exclusive(args.output / "effective-config.json", config)
    prepared = prepare_planready(args.output, config, runner, census_path, lane_id)
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
    if completion.get("kind") != "diagnostic-cli-exact-current-lane-preparation" or completion.get("status") != "prepared-no-docker-launch":
        raise Refusal("PREPARATION_COMPLETION_INVALID")
    regular_file(root / "inputs.json", completion.get("inputsSha256", ""), "PREPARATION_INPUTS_BINDING_INVALID")
    regular_file(root / "effective-config.json", completion.get("effectiveConfigSha256", ""), "PREPARATION_CONFIG_BINDING_INVALID")
    inputs = load_json(root / "inputs.json", "PREPARATION_INPUTS_INVALID")
    config = load_json(root / "effective-config.json", "PREPARATION_CONFIG_INVALID")
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
    ):
        raise Refusal("PREPARATION_INTERNAL_BINDING_INVALID")
    retained = inputs.get("frozenRetained")
    if not isinstance(retained, list) or any(not isinstance(item, dict) for item in retained):
        raise Refusal("SELECTED_LANE_FROZEN_RETENTION_BINDING_INVALID")
    retained_lanes = [item.get("lane") for item in retained]
    if retained_lanes != [lane_id]:
        raise Refusal("SELECTED_LANE_FROZEN_RETENTION_BINDING_INVALID")
    prepared = root / "planready" / f"{lane_id}-planready"
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
    ):
        regular_file(Path(binding["path"]), binding["sha256"], "PREPARATION_SOURCE_BINDING_CHANGED")
    for binding in inputs["frozenRetained"]:
        regular_file(Path(binding["path"]) / "retention-completion.json", binding["completionSha256"], "FROZEN_RETENTION_BINDING_CHANGED")
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


def observed_containers(root: Path, runner: ModuleType | None) -> list[dict[str, object]]:
    containers: list[dict[str, object]] = []
    for path in sorted(root.glob("**/container.json")):
        if "candidate" in path.relative_to(root).parts:
            continue
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
    }
    write_json_exclusive(root / "attempt-completion.json", completion)
    return completion


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
    runtime_containers = [
        path
        for path in root.glob("**/container.json")
        if "candidate" not in path.relative_to(root).parts
    ]
    return bool(runtime_containers) or any(
        (root / name).exists()
        for name in ("retained-planready", "current-map.json", "targeted", "execution-completion.json")
    )


def attempt_identity(preparation_sha256: str, lane_id: str) -> tuple[str, str]:
    if not re.fullmatch(r"[a-f0-9]{64}", preparation_sha256):
        raise Refusal("PREPARATION_COMPLETION_BINDING_INVALID")
    lane_id = validate_lane(lane_id)
    attempt_id = preparation_sha256[:12]
    return attempt_id, f"cli-exact-current-{lane_id}-{attempt_id}"


def execute(args: argparse.Namespace) -> dict[str, object]:
    if args.authorization != "RUN_DIAGNOSTIC_CLI_LANE_EXACT_CURRENT":
        raise Refusal("EXPLICIT_DIAGNOSTIC_LAUNCH_AUTHORIZATION_REQUIRED")
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
    runner.BASE = Path(runner_binding["path"]).parent
    runner.REPOSITORY = repo
    lane_id = validate_lane(inputs.get("selectedLane"))
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
        seal_attempt(
            root,
            preparation_sha,
            attempt_id,
            preparation["candidate"],
            preparation["tree"],
            lane_id,
            "recovered-interrupted",
            "PARTIAL_ATTEMPT_STATE_FOUND",
            runner,
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
        targeted = runner.prepare(target_parent, config, target_shard)
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
            seal_attempt(
                root,
                preparation_sha,
                attempt_id,
                preparation["candidate"],
                preparation["tree"],
                lane_id,
                "interrupted" if isinstance(error, (KeyboardInterrupt, SystemExit)) else "failed",
                code[:160],
                runner,
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
