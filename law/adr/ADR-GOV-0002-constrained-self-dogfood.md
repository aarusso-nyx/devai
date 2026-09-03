---
id: ADR-GOV-0002
title: Constrained self-dogfood and the role and effect matrix
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - AGENTS.md (DEVAI does not govern its own development)
  - law/constitution.md Article 3 (operating mode)
  - law/constitution.md Article 7 (human roles)
  - law/constitution.md Article 34 (auditor spawn cadence)
  - law/constitution.md Article 35 (backlog as the only work queue)
  - law/adr/ADR-014-release-verification-profiles.md
affected_rules:
  - law/policy/self-dogfood.json
  - law/schemas/self-dogfood-policy.schema.json
inspector_acceptance:
  - IA-001 -- A self-dogfood run with no human invocation fails. A timer, a hook, or a prior run's output is not an invocation.
  - IA-002 -- A check id absent from permitted_checks is refused. There is no default-permit remainder.
  - IA-003 -- A role initiating an effect outside its matrix row is refused, including when the same role is permitted that effect in another context.
  - IA-004 -- Every matrix row forbids remote-write. A row that omits it is rejected by the contract itself.
  - IA-005 -- A passing self-dogfood check grants no publication authority and produces no readiness claim.
  - IA-006 -- Write consent does not imply publication consent. Granting write on a self-dogfood run does not enable any remote effect.
  - IA-007 -- A session that declares one role and initiates an action reserved to another is refused rather than elevated.
  - IA-008 -- The Auditor row permits read only. An Auditor-initiated harness-write in a self-dogfood run is refused even though audit observe is a registered harness-write action.
---

# Constrained self-dogfood and the role and effect matrix

## Status

Accepted.

## Context

DEVAI runs its own governed checks against its own source repository. This is
useful — a harness that cannot observe itself is a harness nobody has tested —
and it is also the single most likely place for the framework's central
prohibition to erode.

`AGENTS.md` states the boundary plainly: DEVAI does not govern its own
development; human maintainers choose scope, review changes, and decide
releases. ADR-014 restated it for verification configuration. Neither is
mechanically checkable, and an unmechanized prohibition drifts toward a
convenience: a self-check that writes, then a self-check that schedules itself,
then a self-check whose pass reads like a release decision.

The three specific erosions to prevent are autonomous work, role widening, and
publication authority arriving by implication from a passing check.

## Decision

Self-consumption is verification configuration only, and it is constrained by an
explicit policy rather than by prose.

Every self-dogfood run is human-invoked. Autonomous work, scheduled or timer
execution, backlog dequeue, and self-dispatch are all forbidden, and an
invocation that cannot be attributed to a human fails rather than proceeding.

No run widens a role. Role inference, role elevation, and cross-role sessions
are forbidden. The declared role at session start is the only role in effect.

No run carries publication authority. It is not granted, it is not implied by a
passing check, and it is not implied by write consent. Remote effects are
forbidden outright in this context.

Permitted checks are an exact list of check identifiers with their effect and
their permitted initiator roles. There is no default-permit remainder: a check
absent from the list is not permitted.

The role and effect matrix has one row per declared human role and is total. Each
row states the effects that role may initiate, the effects it may not, and the
exact action identifiers it may invoke. Every row forbids `remote-write`, and
the policy contract enforces that structurally rather than trusting the author
to remember. The Auditor row is read-only, consistent with Article 7: the
Auditor observes and reports, and its reports recommend rather than ratify.

## Consequences

The self-dogfood surface is small and explicitly enumerated. Adding a check to
it is an Architect policy edit that appears in a diff, not an emergent capability
of a runner.

Self-observation produces evidence about the harness and never a readiness
verdict the harness grants itself. This keeps Article 36 honest: the repository's
F5 substrate is scored by the same machinery, and being the subject of a score
is not being the author of it.

Some genuinely useful automation is excluded — a post-merge self-check on a
timer, for instance. That exclusion is the decision, not an oversight: Article 34
already says the framework is quiescent when integration is quiet.

The policy names check identifiers that exist as repository scripts. It does not
create, wire, or schedule any of them, and no runner currently reads this policy.
Enforcing it is Engineer and Inspector work; until then it constrains what may be
built rather than what is running.

## Alternatives Considered

**Leave the boundary as prose in AGENTS.md.** Rejected: prose is what has been
relied on so far, and it is not checkable. The failure it guards against is
gradual and each individual step looks reasonable.

**Permit an allowlist of autonomous checks.** Rejected: an autonomous check is
autonomous work regardless of how narrow its allowlist is, and the allowlist is
the thing that grows.

**Permit remote-write for evidence publication during self-dogfood.** Rejected:
publishing evidence about a candidate is an external effect and belongs to the
release lifecycle under an Owner authorization, not to a self-check.

**Derive the matrix from the action registry at runtime.** Rejected: the registry
states what an action requires, not what self-consumption permits. Deriving one
from the other means a new registered action silently joins the self-dogfood
surface.

## Affected Rules

- `law/policy/self-dogfood.json` — new canonical self-dogfood policy and role and effect matrix.
- `law/schemas/self-dogfood-policy.schema.json` — new policy contract.
- `law/policy/action-registry.json` — action identifiers referenced by the matrix; unchanged by this decision.
- `AGENTS.md` — the prose boundary this decision mechanizes; unchanged.

## Inspector Adversarial Acceptance

Acceptance is demonstrated by the attacks in this record's
`inspector_acceptance` frontmatter, each of which must fail closed. The
Inspector additionally demonstrates that a policy document omitting
`remote-write` from any matrix row is rejected by the schema, and that a
`permitted_checks` entry declaring a `remote-write` effect is rejected by the
schema rather than by a downstream runner.
