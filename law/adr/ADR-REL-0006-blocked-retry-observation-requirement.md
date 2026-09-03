---
id: ADR-REL-0006
title: Report blocked remote retries with their fresh-authorization requirement
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0004-separate-release-log-tail-and-state-head.md
  - law/adr/ADR-REL-0005-separate-legacy-seams-state-generation-and-log-sequence.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-observation.schema.json
inspector_acceptance:
  - IA-001 -- A terminal failed remote evidence-publish or publish attempt with a valid append tail and unchanged completed-state head emits outcome blocked, its exact remote retry action, blocked_reason fresh-exact-authorization-required, and the sole blocked requirement fresh_exact_owner_authorization_required.
  - IA-002 -- The same observation fails if the retry action differs from the failed remote action, is local or harness-write, omits or changes the fresh-authorization requirement, or claims that reporting it consumes, grants, or dispatches authority.
  - IA-003 -- Every other blocked reason has null next_action and an empty blocked_requirements array; ambiguous, including unknown provider result, has null next_action and no retry shape.
---

# Report blocked remote retries with their fresh-authorization requirement

## Status

Accepted as a narrow forward correction consistent with ADR-REL-0005. The
append-tail, completed-head, state-generation, authorization consumption, and
unknown-result decisions of ADR-REL-0004 and ADR-REL-0005 remain unchanged.

## Context

The active lifecycle policy correctly requires a failed remote attempt to stay
blocked until a fresh exact Owner authorization is supplied. It also requires
pure `release resume` to derive the same state transition from the unchanged
completed-state head. The observation schema, however, required every blocked
result to have a null `next_action`.

That shape hides the one deterministic action a human may authorize next. It
forces a caller either to reconstruct the failed remote action from the log or
to treat a legal retry as unrepresentable. Neither is acceptable: reconstruction
outside the kernel invites a wrong action, while a generic non-null blocked
action could be mistaken for authority or an automatic retry.

## Decision

`release resume` remains pure and never grants, consumes, or dispatches an
authorization. A blocked observation may carry a non-null `next_action` only
when all of the following hold:

1. the append tail proves one terminal failed remote attempt;
2. the reported action is exactly that failed attempt's remote action, limited
   to `release evidence-publish` or `release publish`;
3. `blocked_reason` is exactly `fresh-exact-authorization-required`; and
4. `blocked_requirements` is exactly
   `["fresh_exact_owner_authorization_required"]`.

The requirement describes the missing human grant; it is not a grant. Any
later dispatch is a distinct attempt and still validates a newly supplied,
live, exact Owner authorization bound to that attempt, request, repository,
candidate, action, and destination. The failed attempt and its consumed grant
remain non-reusable.

All other blocked observations have null `next_action` and an empty
`blocked_requirements` array. Ambiguous observations always have null
`next_action`; unknown provider results remain ambiguous and non-retriable.
The policy and schema use closed enumerations so no caller can invent another
retry reason, requirement, or action class.

## Consequences

Resume can state the exact authorization boundary without performing work or
requiring consumers to infer a retry from partial history. A human sees both
the precise remote action and the only missing prerequisite.

The correction does not weaken at-most-once dispatch. It adds no retry loop,
authorization carry-over, automatic redispatch, state advance, or provider
call. Existing malformed, stale, orphaned, unterminated, identity-mismatched,
and ambiguous outcomes remain fail-closed.

Runtime and Inspector implementations must use the validated append tail to
prove equality between the failed remote action and the reported retry action;
schema validation only constrains the closed output shape and does not derive
that equality on its own.

## Alternatives Considered

**Keep all blocked next actions null.** Rejected because it contradicts the
policy's deterministic retry transition and makes a legitimate human-authorized
next step undiscoverable from the observation.

**Return ready for a failed remote attempt.** Rejected because no fresh exact
Owner authorization has been supplied and a ready outcome could be executed or
misread as permission.

**Allow any blocked action with a free-form reason.** Rejected because it could
redirect a retry to a different effect or turn an observation into invented
authority.

**Treat unknown provider results as retryable failures.** Rejected because the
provider may have accepted the first dispatch; ambiguity must stop rather than
duplicate an external effect.

## Affected Rules

- `law/policy/release-lifecycle.json` freezes the sole blocked-retry
  observation and its authority boundary.
- `law/schemas/release-lifecycle-policy.schema.json` requires the exact policy
  declaration.
- `law/schemas/release-lifecycle-observation.schema.json` admits only the
  closed failed-remote retry shape and retains null actions for all other
  blocked and ambiguous cases.

## Inspector Adversarial Acceptance

The Inspector executes the three frontmatter cases against complete append
histories and validates the emitted observation bytes. In particular, it must
prove action equality from the failed terminal record rather than accepting a
schema-valid remote action chosen by a caller. It must also prove that the
observation itself produces no ledger event, store record, provider call, or
authorization transition.
