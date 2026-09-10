#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import hashlib
import json
import tempfile
import tarfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("harness", HERE / "cli_exact_current_lane.py")
assert SPEC and SPEC.loader
harness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(harness)


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


class HarnessRefusalTests(unittest.TestCase):
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
                        "mutants": [
                            {key: item for key, item in value.items() if key != "fileName"}
                        ]
                    }
                }
            }
            report = root / "mutation.json"
            report.write_text(json.dumps(report_value))
            (events / "3-onMutationTestReportReady.json").write_text(json.dumps(report_value))
            result = harness.verify_execution(events, report, [mapped(value)])
            self.assertEqual(result["statusCounts"], {"Survived": 1})
            self.assertEqual(result["credit"]["killed"], 0)
            self.assertFalse(result["credit"]["allMappedClaimsKilled"])
            self.assertFalse(result["outcomes"][0]["credited"])

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
