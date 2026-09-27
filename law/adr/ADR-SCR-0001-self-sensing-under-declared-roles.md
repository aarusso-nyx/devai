---
id: ADR-SCR-0001
title: Admit sensing and recording on the framework repository under declared roles
type: adr
status: accepted
date: 2026-09-27
authority: Architect
supersedes: []
provenance:
  - law/constitution.md#article-7-human-roles
  - law/constitution.md#article-33-the-auditor
  - law/adr/ADR-GOV-0002-constrained-self-dogfood-and-the-role-and-effect-matrix.md
  - law/policy/self-dogfood.json
  - packages/cli/src/services/self-dogfood.ts
affected_rules:
  - law/policy/self-dogfood.json
  - law/schemas/self-dogfood-policy.schema.json
  - packages/cli/src/services/self-dogfood.ts
inspector_acceptance:
  - IA-001 -- sense run with a read effect is admitted for every declared role, and the admission is taken from the matrix row, not from the absence of a rule.
  - IA-002 -- sense record and audit observe are refused for owner, architect, engineer, and auditor, and admitted for the inspector only with explicit write consent.
  - IA-003 -- Any sense action that carries --publish is refused before the matrix is consulted, for every role.
  - IA-004 -- A sense run whose resolved population contains a remote-write member is refused even under the inspector with write consent.
  - IA-005 -- A recorded reading carries the declaring role and the human invocation; a reading without both is rejected by sense record.
---

# Admit sensing and recording on the framework repository under declared roles

## Status

Accepted on 2026-09-27 by maintainer decision. Implemented by campaign CMP-0002, round R-0201. Amends the matrix of ADR-GOV-0002 by addition; it supersedes nothing.

## Context

ADR-GOV-0002 constrains self-dogfood to an exact list of checks and a total
role and effect matrix. That list predates the sensor population. Today no
row names `sense run`, `sense record`, or `audit observe`, and the policy's
fail-closed remainder treats an undeclared action id as forbidden. The
scorecard machinery therefore has no lawful way to produce readings for the
framework's own repository, and the grid computed for main reads UNKNOWN in
every scoreable cell. The CLI authority path meanwhile admits a sweep dry run
for any role, so the policy and the runtime disagree.

## Decision

The self-dogfood policy admits three sensing actions and nothing else.

`sense run` with an aggregate effect of read is admitted for every declared
role. A population that resolves to a local-write or harness-write member is
admitted for the inspector only, with explicit write consent. A population
that resolves to a remote-write member is refused for every role; the
structural prohibition of remote effects in every matrix row is unchanged.

`sense record` and `audit observe` are harness-write actions admitted for the
inspector only, with explicit write consent, because the inspector row is the
only row that already permits harness-write. No other row gains an effect.

`--publish` on any sense action is refused before the matrix is consulted.
A recorded reading carries the declaring role and the human invocation.

## Consequences

The policy and the runtime agree, and the disagreement observed today is
closed in the policy's favor. Recording readings for the framework becomes a
deliberate inspector act, never a side effect of a check. Nothing in this
record grants publication authority or a readiness claim; the scorecard it
enables is an Auditor observation under Article 33.

## Alternatives Considered

Admitting sensing through the check runner's permitted checks is rejected
because sensing is not a check and the runner would inherit effects it does
not declare. Admitting recording for the engineer is rejected because
harness-write is reserved to the inspector row and widening a row is the
exact thing ADR-GOV-0002 forbids. Leaving the policy silent and relying on
the runtime's admission is rejected because fail-closed must mean refused.

## Affected Rules

- `law/policy/self-dogfood.json` gains the three action identifiers in the rows named above.
- `law/schemas/self-dogfood-policy.schema.json` limits harness-write actions to rows that permit harness-write.
- `packages/cli/src/services/self-dogfood.ts` decides the three actions from the matrix.

## Inspector Adversarial Acceptance

The inspector acceptance items in the front matter are discharged by
`packages/cli/tests/unit/self-dogfood-policy.test.ts`.
