---
id: ADR-SCR-0006
title: The governance ledger sensors validate second-generation decision records
type: adr
status: accepted
date: 2026-09-27
authority: Architect
supersedes: []
provenance:
  - law/schemas/adr-v2.schema.json
  - law/adr/README.md
  - packages/loop/src/governance-ledger/index.ts
  - law/policy/sensor-registry.json
affected_rules:
  - packages/loop/src/governance-ledger/index.ts
  - law/schemas/adr.schema.json
  - law/schemas/invariant.schema.json
  - packages/loop/src/loop/scorecard.ts
inspector_acceptance:
  - IA-001 -- decision_record_integrity reports zero findings on a tree whose every record validates against law/schemas/adr-v2.schema.json, and one finding per record that does not.
  - IA-002 -- Supersession symmetry is judged from the supersedes array alone; a superseded record is never required to have been edited.
  - IA-003 -- decision_citation_resolution resolves scoped identities of the form ADR-SCOPE-NNNN and reports every citation of an identity with no file.
  - IA-004 -- Both sensors run over the real law/adr tree in a test and report zero findings at the merged head.
---

# The governance ledger sensors validate second-generation decision records

## Status

Accepted on 2026-09-27 by maintainer decision. Implemented by campaign CMP-0002, round R-0204.

## Context

Decision records moved to the second-generation shape with scoped
identities, four lifecycle values, and supersession by array. The governance
ledger sensors still validate the first-generation shape: the sweep reports
65 schema findings and 40 asymmetric supersession findings on records that
`check adrs` accepts. Five citations remain to identities that no longer
exist: two legacy comments in schemas and two draft identities in the
scorecard composer. The sensors are diagnostics, but they fail the sweep
gate, so no sweep over the framework can report readiness while they
disagree with the law they audit.

## Decision

The governance ledger sensors validate against `law/schemas/adr-v2.schema.json`,
treat proposed, accepted, rejected, and superseded as the lifecycle, and
judge supersession symmetry through the `supersedes` array alone, never by
requiring an edit to a superseded record. Citation resolution understands
scoped identities. The legacy citations are repointed to records that exist
or removed with a note naming the replacement. The accepted records are not
edited to satisfy a sensor.

## Consequences

The sensors and `check adrs` agree on what a valid record is. The sweep gate
can pass on the framework. The first-generation schema remains for adopters
that still carry first-generation records until its own supersession.

## Alternatives Considered

Rewriting sixty-six records to the first-generation shape is rejected
outright. Removing the two sensors from the sweep is rejected because the
ledger is exactly what a self-audit should verify.

## Affected Rules

- `packages/loop/src/governance-ledger/index.ts` validates the v2 shape.
- `law/schemas/adr.schema.json` and `law/schemas/invariant.schema.json` lose their legacy citations.
- `packages/loop/src/loop/scorecard.ts` loses its draft identities.

## Inspector Adversarial Acceptance

Discharged by `packages/loop/tests/governance-ledger.test.ts`.
