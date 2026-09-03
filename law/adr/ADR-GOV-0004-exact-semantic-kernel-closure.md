---
id: ADR-GOV-0004
title: Exact semantic-kernel closure
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0003
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 10 (role separation)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0001-adr-identity-and-fail-closed-validation.md
  - law/adr/ADR-GOV-0002-constrained-self-dogfood.md
  - law/adr/ADR-AUT-0001-exact-effect-authorization-ledger.md
  - law/adr/ADR-MUT-0001-mutation-assurance-v2.md
  - law/adr/ADR-REL-0002-nine-state-release-lifecycle-and-observed-publication.md
  - law/adr/ADR-GOV-0003-mandatory-semantic-kernels.md
affected_rules:
  - law/policy/mutation-assurance-v2.json
  - law/policy/release-lifecycle.json
  - law/policy/self-dogfood.json
  - law/schemas/effect-authorization-event.schema.json
  - law/schemas/effect-authorization-ledger.schema.json
  - law/schemas/mutation-assurance-policy-v2.schema.json
  - law/schemas/mutation-assurance-v2.schema.json
  - law/schemas/release-lifecycle-observation.schema.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/release-offline-verification-receipt.schema.json
  - law/schemas/release-plan-receipt.schema.json
  - law/schemas/release-publication-receipt.schema.json
  - law/schemas/self-dogfood-policy.schema.json
inspector_acceptance:
  - IA-001 -- Engineer typecheck is permitted as local-write by both the exact check roster and the Engineer row; harness-write and remote-write remain forbidden.
  - IA-002 -- A ledger entry that differs from its resolved event in ledger, sequence, identity, digest link, kind, or grant reference fails; no grant can receive a second terminal or be consumed outside its live window.
  - IA-003 -- Mutation score and verdict are reproduced under the frozen Stryker detected-over-scored rational formula, including no_coverage and unconditional runtime/infrastructure-error blocking.
  - IA-004 -- A release plan with any input outside the exact ordered four-input contract, an unknown risk, a wrong transition, or a different capability or mutation result fails closed.
  - IA-005 -- A publication dispatch without an exact Owner grant and explicit destination, protected workflow/environment, and external trust identities/digests appends no state.
  - IA-006 -- Plan and offline receipt identities are reproduced from UTF-8 RFC 8785 JCS SHA-256 projections, and every internal example digest is reproducible from its example bytes.
---

# Exact semantic-kernel closure

## Status

Accepted. Supersedes ADR-GOV-0003 forward while retaining the still-valid
decisions referenced above; no earlier accepted record is edited.

## Context

ADR-GOV-0003 made semantic verification mandatory but left six values or
relationships open to runtime interpretation: one self-dogfood row contradicted
its check roster, ledger index fields were not equated to event content, the
mutation score formula was unnamed, plan inputs and profile resolution were not
closed, publication workflow/trust expectations had no recorded source, and two
receipt projections lacked a canonical byte form.

## Decision

The Engineer self-dogfood row permits read and local-write, including canonical
`check`, so local-write `typecheck` is coherent. It still forbids harness-write
and remote-write.

The authorization ledger kernel equates every index field to the resolved event
and binds the event to the ledger id. A grant has at most one terminal event of
any kind. Consumption is valid only at or after `not_before`, strictly before
`expires_at`, and before any terminal; terminal-after-terminal fails closed.

Mutation uses the Stryker detected-over-scored model. Detected is killed plus
timeout. Scored is detected plus survived plus no_coverage. Zero scored yields
100; otherwise score is detected times 100 divided by scored. A reported JSON
decimal is converted to an exact base-ten rational and must equal that rational
without tolerance. Thresholds require score at least `score_min` and survived at
most `survived_max`; any runtime or infrastructure error blocks pass.

Release planning binds exactly four ordered UTF-8 RFC 8785 JCS inputs: the
invocation release-intent document, `law/policy/release-verification.json`,
`law/policy/release-lifecycle.json`, and `law/policy/action-registry.json`.
The lifecycle policy declaratively freezes the existing release-profile SemVer,
support, change-impact, known-risk, capability-union, Owner-escalation, and
mutation-selection rules. Unknown risk blocks. Non-LTS empty mutation rosters
remain ready with mutation none and typed not-required; LTS empty rosters block.

Only `release publish` may record `publication_expectation`, and it records the
exact Owner authorization event, destination, protected workflow repository,
path, SHA and environment, plus trust-root id, trust-store digest, key id and
signature algorithm without key material. The dispatch kernel verifies this
binding before appending `publication_dispatched`. Observation compares the
signed receipt only to those recorded state fields and the exact trust store.

Plan and offline receipts use UTF-8 RFC 8785 JCS and SHA-256, excluding only
their receipt id and receipt digest, then derive the id from the first sixteen
lowercase digest characters. Publication and event projections remain acyclic.

## Consequences

The semantic kernels now have one result for the same evidence. Examples are
recomputed from their final canonical bytes; an external publication signature
still requires the explicitly identified external trust fixture and embeds no
key material. All nine release actions, effects, roles, stability, read purity,
and registry counts remain unchanged.

## Alternatives Considered

**Permit tolerance or runner-selected score formulas.** Rejected because a
threshold verdict must be reproducible exactly.

**Discover workflow or trust identity during resume.** Rejected because the
receipt would choose the authority used to verify itself.

**Retain generic plan input arrays.** Rejected because an omitted input could
silently change SemVer, risk, or capability selection.

## Affected Rules

The `affected_rules` frontmatter is exhaustive. No runtime, test, generated
view, workflow, action registry, or remote state is changed.

## Inspector Adversarial Acceptance

The six frontmatter attacks must fail structurally or under the exact mandatory
kernel. Schema-only acceptance never establishes authority, pass, or published.
