---
id: ADR-REL-0003
title: Blocked release plans are deterministic non-transitions
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-REL-0002
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0002-nine-state-release-lifecycle-and-observed-publication.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/release-plan-receipt.schema.json
inspector_acceptance:
  - IA-001 -- Each of invalid-semver, downgrade, same-version-without-support-promotion, and support-promotion-requires-lts emits one schema-valid deterministic blocked receipt with the exact reason and no plan steps.
  - IA-002 -- A blocked receipt with planned state, a non-null transition, any capability, any plan step, or a mutation disposition other than blocked fails schema or semantic verification.
  - IA-003 -- A passing receipt still requires planned state, exactly nine ordered actions, a valid non-null transition, ready profile verdict, and no blocking reason.
  - IA-004 -- No mutating action may bind a blocked receipt, and possession of one grants no authority or lifecycle transition.
---

# Blocked release plans are deterministic non-transitions

## Status

Accepted. Supersedes ADR-REL-0002 while retaining its nine-state lifecycle,
pure-read boundary, publication separation, role separation, and receipt
authority limits.

## Context

ADR-REL-0002 correctly made `release plan` a pure deterministic read and made a
passing plan receipt the derivation of `planned`. Its receipt schema, however,
required every receipt to contain exactly nine plan steps and required
`determination.transition` to name a valid transition. Those requirements made
the declared `block` verdict internally contradictory: invalid SemVer,
downgrades, forbidden same-version attempts, and invalid support promotions
have no valid transition and must not expose an executable-looking plan.

A refusal that cannot validate is not durable evidence. Repairing it by naming
a fictitious patch transition or by returning the normal action plan would be
worse, because a downstream consumer could mistake the blocked result for a
weaker ready result.

## Decision

`release plan` always emits one deterministic receipt, including when planning
is blocked. A blocked receipt is a non-transition. Its verdict and profile
verdict are `block`; `state_observed` and `transition` are null; `plan` and
`capabilities` are empty; mutation is `none`; mutation disposition is
`blocked`; and it contains at least one exact blocking reason. It is not
bindable by a mutating action and grants no lifecycle transition.

The SemVer refusal precedence is exact: `invalid-semver`, `downgrade`,
`same-version-without-support-promotion`, then
`support-promotion-requires-lts`. For each of those conditions the receipt
contains that condition as its sole blocking reason and mutation-disposition
reason. Precedence makes overlapping malformed input resolve to identical
bytes on every invocation.

A passing receipt is not weakened. It continues to require `planned`, a ready
profile verdict, one valid non-null transition, exactly nine ordered lifecycle
actions, a required or not-required mutation disposition, and no blocking
reason. Schema validation alone establishes neither pass nor block: the named
semantic kernels recompute the result and canonical receipt identity from all
four bound inputs.

## Consequences

Callers receive structured refusal evidence rather than an exception-shaped
hole, while downstream mutation is safer because a refusal contains no partial
plan. Existing passing plan structure and its unconditional verification floor
remain unchanged.

The release-plan determination and receipt semantic kernels advance to v2
because their algorithms changed. The receipt canonicalization projection is
unchanged; identical blocked inputs produce identical receipt digests and IDs.

Runtime implementations and Inspector fixtures must adopt the v2 kernels before
the lifecycle is claimed implemented. This decision changes no action effect,
role, authorization, workflow, publication, or remote-state contract.

## Alternatives Considered

**Throw before emitting a receipt.** Rejected: it loses deterministic,
candidate-bound evidence about why planning refused.

**Emit the normal nine actions with verdict block.** Rejected: a blocked result
would expose an executable-looking plan and permit consumers to ignore one
field to create a transition.

**Invent a transition for invalid input.** Rejected: `patch` or any other valid
transition would be a false claim about the supplied versions.

**Relax passing receipts together with blocked receipts.** Rejected: the
correction closes a refusal shape and does not reduce the ready-path floor.

## Affected Rules

- `law/policy/release-lifecycle.json` — exact blocked-receipt output and SemVer refusal precedence.
- `law/schemas/release-lifecycle-policy.schema.json` — frozen v2 determination kernel.
- `law/schemas/release-lifecycle-state.schema.json` — example bindings updated to the exact corrected policy and plan-receipt digests.
- `law/schemas/release-plan-receipt.schema.json` — disjoint pass and block shapes plus v2 verification kernel.

## Inspector Adversarial Acceptance

The Inspector demonstrates all four refusal outcomes twice and compares the
complete canonical bytes, digest, and receipt ID. It then attacks every field
that distinguishes block from pass and confirms that a blocked receipt cannot
satisfy the plan-receipt prerequisite of `release preflight`.
