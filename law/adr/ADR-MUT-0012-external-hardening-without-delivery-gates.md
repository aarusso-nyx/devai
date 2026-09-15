---
id: ADR-MUT-0012
title: Extract mutation testing to Bedel and remove every delivery dependency
type: adr
status: accepted
date: 2026-09-14
authority: Architect
supersedes: []
provenance:
  - Owner and Architect mandate for DEVAI 1.5.0 and independent aarusso-nyx/bedel
  - law/adr/ADR-MUT-0011-disable-survivor-count-acceptance.md
  - law/adr/ADR-REL-0026-current-offline-mutation-check.md
affected_rules:
  - law/constitution.md
  - law/policy/release-lifecycle.json
  - law/policy/release-verification.json
  - law/policy/devai-adoption.json
  - law/policy/mutation-strength.json
  - law/schemas/release-verification-profile.schema.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- Minor, major, LTS, risk selection and legacy rosters cannot dispatch mutation testing or make its evidence required.
  - IA-002 -- Missing, failing, invalid or incomplete mutation evidence cannot block CI, certification, preparation, export or publication.
  - IA-003 -- A current profile containing a nonempty mutation roster or execution template is rejected before any execution.
  - IA-004 -- Migration previews identify removed requirements and refuse to overwrite customized adopter bytes without a reviewed write.
  - IA-005 -- Historical mutation readers cannot confer current delivery eligibility and ordinary verification remains mandatory.
---

# Mutation testing becomes independent external hardening

## Status

Accepted by the explicit Owner and Architect mandate for the unpublished DEVAI
1.5.0 slot. This decision overrides previous mutation-testing delivery
requirements only; it leaves source-write authority and ordinary verification
requirements intact.

## Context

CLI campaigns consumed more than a day of sustained CPU and failed to produce
conclusive evidence. Execution outside CI still blocked delivery through
mandatory export receipts and certification dependencies. Mutation testing is
useful hardening but cannot remain on any DEVAI or adopter delivery path.

## Decision

Amend Constitution 1.0.1 to make mutation testing optional external hardening.
No transition, support intention, risk or escalation may require it. Current
plans record mutation none and not-required with reason
`mutation-external-hardening`; no synthetic passing result is created.

Release profile 1.4.0 has an empty compatibility roster and no execution
template. Prior version grammars remain readable for historical configuration
and migration. Their mutation declarations do not become current execution
requirements. Existing adopter configurations use the normal bind preview and
reviewed write flow; customized bytes must never be silently replaced.

Extract execution, transport, scheduling, persistence and mutation-specific
ceremony to independent Bedel. DEVAI does not depend on Bedel. Optional or
historical evidence must not enter the required artifact population. Historical
schemas and verifiers retain their original report semantics but cannot gate
current delivery. The legacy mutation-strength policy has no required scope.

## Consequences

DEVAI 1.5.0 publication can finish before Bedel. Ordinary regression tests,
including tests developed during prior campaigns, remain in DEVAI. Bedel owns
its machinery tests and independent qualification. Formatting, lint, types,
contracts, integrity and ordinary release controls remain required.

## Alternatives Considered

Moving the same mandatory campaign to another host preserves the delivery
bottleneck. Reducing its threshold preserves an unnecessary gate. Both are
rejected in favor of removing the dependency and extracting the capability.

## Affected Rules

The constitution, current release policies, adopter materialization and profile
schema implement the new mandate. Historical mutation report schemas remain
unchanged to preserve existing evidence readability.

## Inspector Adversarial Acceptance

Exercise all transition/support combinations, legacy rosters, absent Bedel,
missing and malformed mutation reports, and profile template injection.
Inspect every workflow and task dependency. Confirm that ordinary required
checks still block on failure and that migration previews expose removals.
