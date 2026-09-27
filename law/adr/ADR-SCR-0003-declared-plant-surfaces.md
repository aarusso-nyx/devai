---
id: ADR-SCR-0003
title: Declared plant surfaces and the skipped-reading rule for absent surfaces
type: adr
status: proposed
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/constitution.md#article-4-fundamental-substrates
  - law/constitution.md#article-5-transversal-properties
  - law/policy/sensor-registry.json
  - law/policy/action-registry.json
  - packages/loop/src/loop/scorecard.ts
affected_rules:
  - law/schemas/sensor-inputs.schema.json
  - .devai/config/sensor-inputs.json
  - packages/loop/src/loop/scorecard.ts
  - packages/sensors/src/plant-coverage.ts
  - packages/sensors/src/inventory-coverage.ts
inspector_acceptance:
  - IA-001 -- With http, database, and rbac declared absent, every inventory and plant sensor bound to those surfaces emits skipped with the declaration as reason and no review or fail finding.
  - IA-002 -- A cell whose readings are all skipped is recorded as N/A with the declaration reason; a cell with one measured reading ignores its skipped readings.
  - IA-003 -- A declaration that names a surface absent while the repository contains it produces a review finding from the sensor that found it, never a skip.
  - IA-004 -- With actions declared present, plant_coverage and inventory_coverage measure the action registry against spec links and report a percentage, not a count of zero endpoints.
---

# Declared plant surfaces and the skipped-reading rule for absent surfaces

## Status

Proposed on 2026-09-26 by maintainer decision. Implemented by campaign CMP-0002, round R-0202.

## Context

The inventory sensors identify a plant through HTTP endpoints, routes,
tables, roles, and PII columns. The framework repository is a command-line
product: it has none of those, and the sweep reports review for their
absence, dragging F2:T1, F4:T1, F4:T2, and F4:T6 to review or fail. A
scorecard that penalizes a repository for lacking a surface it never claimed
measures the wrong thing, and hiding the cells by override would hide real
coverage of the surface the repository does have: sixty-one registered
actions.

## Decision

An adopter declares its plant surfaces in the sensor inputs file: http,
database, rbac, and actions, each present or absent. A sensor bound to an
absent surface emits a skipped reading carrying the declaration as reason.
A sensor that finds evidence of a surface declared absent emits a review
finding instead of skipping. The scorecard composer ignores skipped readings
in a cell that holds any measured reading, and records a cell whose readings
are all skipped as N/A with the declaration reason. Where actions is
declared present, plant coverage and inventory coverage measure the action
registry against its specification links the way they measure routes today.

## Consequences

The framework measures the surface it has and states the ones it lacks. The
rule is symmetric for adopters: a service that declares http present is
measured on it, and one that falsely declares it absent is caught. No
threshold changes and no override is needed for the four cells.

## Alternatives Considered

Per-repository N/A overrides for the four cells are rejected because they
would hide the action surface. Changing the sensors' review verdict to pass
on zero findings is rejected because zero endpoints in a service is a
finding.

## Affected Rules

- `law/schemas/sensor-inputs.schema.json` and `.devai/config/sensor-inputs.json` carry the surfaces declaration.
- `packages/loop/src/loop/scorecard.ts` applies the skipped-reading rule.
- `packages/sensors/src/plant-coverage.ts` and `packages/sensors/src/inventory-coverage.ts` measure the action registry.

## Inspector Adversarial Acceptance

Discharged by `packages/sensors/tests/declared-surfaces.test.ts` and `tests/contract/declared-surfaces.contract.test.ts`.
