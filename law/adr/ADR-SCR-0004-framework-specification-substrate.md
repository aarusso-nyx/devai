---
id: ADR-SCR-0004
title: The framework carries its own specification substrate as records
type: adr
status: proposed
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/constitution.md#article-4-fundamental-substrates
  - law/constitution.md#article-11-invariants-as-control-setpoints
  - law/constitution.md#article-12-owner-authored-specs-and-compilation
  - law/schemas/invariant.schema.json
  - law/policy/sensor-registry.json
affected_rules:
  - law/invariants
  - law/security/threat-model.json
  - law/security/data-handling.json
  - law/targets/performance.json
  - law/targets/robustness.json
  - law/trace.json
inspector_acceptance:
  - IA-001 -- Every invariant record validates against law/schemas/invariant.schema.json and names a constitution article or accepted decision as its source.
  - IA-002 -- Every readiness-bearing invariant resolves through law/trace.json to at least one existing test path; a dangling trace entry fails law:validate.
  - IA-003 -- Every performance and robustness target names a registered sensor kind and a threshold that sensor emits as a metric.
  - IA-004 -- The data handling declaration states that the repository stores no personal data, and inventory_data_handling reads it rather than scanning for PII columns that do not exist.
  - IA-005 -- Removing an invariant record turns the corresponding spec sensor from pass to fail on the same head.
---

# The framework carries its own specification substrate as records

## Status

Proposed on 2026-09-26 by maintainer decision. Implemented by campaign CMP-0002, rounds R-0203 and R-0205.

## Context

Article 11 makes invariants the control setpoints and Article 4 places
invariants, trace, decisions, and contracts in substrate F1. The framework
repository holds its constitution, sixty-six decision records, and a trace
file, but `law/invariants/` is empty. Seven sensors read invariant records:
spec depth, spec alignment, spec security coverage, spec performance
targets, spec robustness targets, test invariant alignment, and harness
invariant alignment. All seven report fail or review today, and two spec
sensors pass vacuously because they scanned nothing.

## Decision

The framework authors its reference signal as records. Invariants are JSON
records under `law/invariants/`, one per measurable obligation, derived from
constitution articles and the inspector acceptance items of accepted
decisions, with severity from the readiness-bearing set where the
constitution says so. A threat model names the trust boundaries the
authority broker, the evidence transport, and the release workflow defend. A
data handling declaration states that the repository stores no personal
data. Performance and robustness targets are records naming a sensor kind
and a measurable threshold. `law/trace.json` links every invariant to the
tests that observe it. Tests are classified so that the security,
performance, and robustness coverage sensors can count them.

## Consequences

The spec sensors measure something real, and the vacuous passes disappear.
Prose obligations become setpoints a test can reference. Authoring is a
bounded Architect task, not an ongoing tax: a new obligation enters as a
record at the same time as its decision.

## Alternatives Considered

Marking the F1 cells N/A for the framework is rejected: the framework has
the richest reference signal of any adopter and would be the one repository
exempt from it. Deriving invariant records automatically from ADR acceptance
items is rejected for now because acceptance items are attacks, not
setpoints; the mapping needs an Architect.

## Affected Rules

- `law/invariants/` holds the records; `law/trace.json` links them to tests.
- `law/security/threat-model.json`, `law/security/data-handling.json`, `law/targets/performance.json`, and `law/targets/robustness.json` are new record kinds with schemas.

## Inspector Adversarial Acceptance

Discharged by `tests/contract/invariant-resolution.contract.test.ts`, `tests/contract/targets-resolution.contract.test.ts`, and `packages/sensors/tests/spec-substrate.test.ts`.
