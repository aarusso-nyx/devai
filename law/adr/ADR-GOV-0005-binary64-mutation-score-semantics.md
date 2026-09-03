---
id: ADR-GOV-0005
title: Binary64 mutation score semantics
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0004
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 41 (independently checkable evidence)
  - law/adr/ADR-MUT-0001-mutation-assurance-v2.md
  - law/adr/ADR-GOV-0004-exact-semantic-kernel-closure.md
affected_rules:
  - law/policy/mutation-assurance-v2.json
  - law/schemas/mutation-assurance-policy-v2.schema.json
inspector_acceptance:
  - IA-001 -- detected 2 and scored 3 recomputes to the binary64 value emitted by JSON as 66.66666666666666 and SameValue succeeds.
  - IA-002 -- any adjacent or otherwise altered reported binary64 score fails SameValue.
  - IA-003 -- NaN, infinity, negative zero, or a non-safe-integer count fails closed before threshold evaluation.
---

# Binary64 mutation score semantics

## Status

Accepted. Supersedes ADR-GOV-0004 forward while retaining every other decision
and contract incorporated by that record. No earlier accepted record is edited.

## Context

ADR-GOV-0004 required a finite JSON decimal to equal the exact rational mutation
score. Ratios such as 200 divided by 3 have no finite decimal representation, so
that rule rejected a correctly reported canonical verifier result.

## Decision

Mutation counts must be nonnegative safe integers and are converted exactly to
IEEE-754 binary64. NaN, infinity, and non-safe-integer counts fail. Using
round-to-nearest, ties-to-even after every operation, the verifier computes
`detected = killed + timeout`, then `scored = (detected + survived) +
no_coverage`, then `score = scored === 0 ? 100 : (detected / scored) * 100` in
that exact order.

The reported JSON number is parsed as binary64 and must be SameValue with the
recomputed score. Negative zero is forbidden. Threshold evaluation uses that
same recomputed score against canonical `score_min` parsed as binary64 and uses
integer `survived <= survived_max`. Runtime or infrastructure errors continue
to block pass.

## Consequences

Common repeating ratios are representable exactly as the canonical verifier's
binary64 result, while altered numbers still fail deterministically. All other
ADR-GOV-0004 decisions, registry entries, examples, identities, and authority
boundaries remain unchanged.

## Alternatives Considered

**Exact rational equality to a JSON decimal.** Rejected because many rational
scores have no finite JSON representation.

**Tolerance-based comparison.** Rejected because a tolerance introduces an
implementation-selected acceptance range.

## Affected Rules

Only the two mutation assurance contract documents listed in frontmatter are
changed. No runtime, test, generated view, workflow, registry, or remote state
is changed.

## Inspector Adversarial Acceptance

The three frontmatter cases must produce the stated result under the mandatory
`devai.kernel.mutation-assurance-v2.v1` kernel; schema validation alone never
establishes pass.
