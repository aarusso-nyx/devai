---
id: ADR-MUT-0011
title: Disable survivor-count mutation acceptance
type: adr
status: accepted
date: 2026-09-12
authority: Architect
supersedes:
  - ADR-MUT-0004
  - ADR-GOV-0004
  - ADR-GOV-0005
provenance:
  - Explicit Owner and Architect mandate issued 2026-09-12
  - law/constitution.md Article 6
  - law/policy/thresholds.json#/mutation
affected_rules:
  - law/policy/thresholds.json
  - law/policy/mutation-strength.json
  - law/policy/release-verification.json
  - law/policy/devai-adoption.json
inspector_acceptance:
  - IA-001 -- Mutation acceptance has one numerical quality threshold and the recomputed mutation score is greater than or equal to 60 percent.
  - IA-002 -- Survivor counts remain present in reports and evidence but cannot independently fail current or baseline acceptance.
  - IA-003 -- Existing v2.1 and v2.2 evidence shapes retain survivedMax as a compatibility field set to Number.MAX_SAFE_INTEGER for newly generated evidence.
  - IA-004 -- Historical evidence retains its original bytes and meaning; no prior receipt is rewritten.
---

# Disable survivor-count mutation acceptance

## Status

Accepted by explicit Owner and Architect mandate. This decision applies to new
DEVAI mutation checks and evidence generated from the resulting candidate. It
does not alter any already sealed or executing campaign packet.

## Context

The existing mutation contracts combine a score floor with an absolute
survivor ceiling. The Owner and Architect have exceptionally directed that
mutation score at or above 60 percent become the only numerical acceptance
threshold. Existing evidence formats and historical receipts must remain
readable without rewriting accepted history.

## Decision

Mutation score greater than or equal to 60 percent is the sole numerical
mutation acceptance threshold. Survivor counts and baseline comparisons remain
observable evidence, but neither an absolute value nor a baseline regression
may independently fail acceptance.

The existing v2.1 and v2.2 mutation evidence wire formats require the
`survivedMax` compatibility field. New DEVAI policy and evidence therefore bind
that field to `Number.MAX_SAFE_INTEGER` (`9007199254740991`). Every valid mutant
population count is a safe integer, so the comparison is unreachable and has
no acceptance effect. This preserves the established evidence shape without
reinterpreting or rewriting retained historical evidence.

Runtime errors, infrastructure errors, incomplete populations, invalid reports,
identity mismatches, missing required critical-mutant evidence, and other
non-numerical fail-closed conditions remain unchanged.

## Consequences

The canonical mutation report check evaluates only the configured score floor.
It continues to report current and baseline scores and survivor counts for
inspection. Release-profile mutation rosters carry the compatibility sentinel
so protected v2.1 and v2.2 verification cannot impose a practical survivor
ceiling.

Adopter and generated policy copies must preserve the sentinel. A lower value
in a current release profile is invalid because it would silently reactivate a
criterion this decision disables.

## Alternatives Considered

**Remove `survivedMax` from existing evidence schemas.** Rejected because it
would make retained v2.1 and v2.2 evidence structurally incompatible.

**Keep a configurable high survivor ceiling.** Rejected because any reachable
ceiling would remain a second numerical acceptance threshold.

## Affected Rules

The canonical threshold copies, mutation-strength policy, current release
profiles, release-profile schema and score-checking runtime implement this
decision. Existing evidence schema versions keep their compatibility field.

## Inspector Adversarial Acceptance

Verify that a report at exactly 60 percent passes with more than 50 survivors,
that a report below 60 percent fails, that survivor and baseline values remain
visible but non-blocking, that current v1.2 profiles reject any reachable
survivor ceiling, and that frozen historical fixtures remain byte-identical.

Historical decisions remain immutable: ADR-MUT-0004 and the related governance
ADRs record the previous design. Their survivor-ceiling conclusions are
superseded for new candidates; their evidence-integrity and score-recomputation
requirements continue to apply.
