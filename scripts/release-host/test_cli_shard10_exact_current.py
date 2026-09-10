#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("harness", HERE / "cli_shard10_exact_current.py")
assert SPEC and SPEC.loader
harness = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(harness)


def mutant(mutant_id: str, replacement: str = "false") -> dict:
    return {
        "id": mutant_id,
        "fileName": "packages/cli/src/example.ts",
        "location": {"start": {"line": 1, "column": 2}, "end": {"line": 1, "column": 6}},
        "mutatorName": "BooleanLiteral",
        "replacement": replacement,
        "static": False,
    }


class HarnessRefusalTests(unittest.TestCase):
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
        frozen = [{"mutant": mutant("7")}]
        current = [{"mutant": mutant("10")}, {"mutant": mutant("11")}]
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
            expected = {harness.structural(first), harness.structural(second)}
            with self.assertRaisesRegex(harness.Refusal, "EXECUTION_MUTANT_EVENTS_INCOMPLETE"):
                harness.verify_execution(events, report, expected)


if __name__ == "__main__":
    unittest.main()
