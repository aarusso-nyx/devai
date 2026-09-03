---
id: ADR-REL-0001
title: Release lifecycle actions, states, and separated publication
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-014
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 10 (authority separation in a single loop iteration)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-014-release-verification-profiles.md
  - law/policy/governed-surface.md
affected_rules:
  - law/policy/action-registry.json
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
inspector_acceptance:
  - IA-001 -- release resume reports the recorded head and writes nothing. Invoking it on a blocked or stale lifecycle does not advance, repair, or revive any state.
  - IA-002 -- release offline-verify returns a verdict and grants nothing. A passing offline verification does not satisfy any prior state and does not authorize any publication.
  - IA-003 -- release certify fails when the preflighted record it names does not exist, or exists with a different record digest. A certify never opens its own chain.
  - IA-004 -- A lifecycle record whose repository, candidate, input, evidence, artifact, or prior-state identity differs from the invocation fails closed. A near match is a mismatch.
  - IA-005 -- release publish fails when only an evidence-publish authorization is presented. Evidence publication never authorizes product publication and the reverse also fails.
  - IA-006 -- Replaying a consumed one-time authorization on either remote action fails. A second publication requires a second Owner grant.
  - IA-007 -- release prepare and release export refuse an Inspector-declared session, and release preflight and release certify refuse an Architect-declared session. The registry role is the only accepted initiator.
  - IA-008 -- An Owner authorization for a different candidate version, commit, or tree fails on both remote actions.
---

# Release lifecycle actions, states, and separated publication

## Status

Accepted. Supersedes ADR-014.

## Context

ADR-014 resolved release verification into capability profiles across a SemVer
axis and a support axis, and was explicit that it changed no publication
authority, no workflow permission, and no release action effect. That was the
correct boundary for a resolver, and it left the actual lifecycle unstated:
which actions exist, which of them write, who may initiate each one, what state
each produces, and what a state depends on.

The consequence is that "release" was a set of verification verbs with no
declared transition structure. Nothing distinguished reading a lifecycle from
advancing one, nothing separated packaging the product from publishing it, and
nothing separated publishing evidence about a candidate from publishing the
candidate itself. In that shape, a passing check reads like permission.

The registry's current release verbs (`check`, `drift`, `status`, `verify`)
remain, and this decision does not redefine them.

## Decision

The release lifecycle is nine actions over six ordered states.

Three actions are read: `release plan`, `release resume`, and
`release offline-verify`. They produce no state, hold no write consent, and
require no binding. `release resume` is observational in the strict sense: it
reports the exact recorded head and advances nothing. `release offline-verify`
grants nothing — its verdict is evidence about an exported artifact, never a
substitute for a state it did not produce.

Two actions are harness-write and are initiated only by the Inspector:
`release preflight` opens the chain at `preflighted`, and `release certify`
advances it to `certified`. Verification writes belong to sensor authority.

Two actions are local-write and are initiated only by the Architect:
`release prepare` produces `prepared` and `release export` produces `exported`.
Local packaging belongs to engineering-specification authority and performs no
remote effect.

Two actions are remote-write and are initiated only by the Owner:
`release evidence-publish` produces `evidence-published` and `release publish`
produces `published`. Each consumes its own exact, one-time, Owner-issued effect
authorization bound to the candidate. They are distinct actions with distinct
authorizations: evidence publication never implies product publication, product
publication never implies evidence publication, and one authorization never
covers both.

Every state record binds exact repository, candidate, input, evidence, artifact,
and prior-state identity. A transition consumes a named predecessor by state id
and record digest; `preflighted` is the only state with a null predecessor. Any
divergence in a bound identity fails closed. Records are appended, never edited.

Article 10 is preserved across the lifecycle: the role that certifies a
candidate is not the role that packages it, and neither is the role that
publishes it.

## Consequences

The nine actions enter `law/policy/action-registry.json` as `stable` with
`release_controller` authority. They are contracts before they are code: no CLI
handler, effects-check catalog entry, or sensor kind is claimed by this
decision, and the generated registry views are unchanged in this change. Until
an Engineer regenerates those views and implements the handlers, invoking these
actions is a registry-declared surface with no runtime, which is a stated gap
rather than an implied capability.

`release verify`, `release check`, `release drift`, and `release status` are
untouched and continue to mean what they meant.

Publishing now costs two Owner decisions when both evidence and product are
published. That is the intended cost.

ADR-014's substance is not discarded. Its capability floor, its `not-required`
disposition, and its targeted-versus-full mutation distinction survive: the
first two in the preflight and certification contracts, the third in
`ADR-MUT-0001`. ADR-014's file is preserved byte-for-byte under the exception
catalog in `law/policy/adr-validation.json`; this record supersedes it forward
and does not edit it.

## Alternatives Considered

**One `release publish` covering evidence and product.** Rejected: a single
authorization for two externally visible effects means the Owner cannot consent
to one without consenting to the other, and a partial failure leaves no
principled state.

**Let `release resume` repair or re-drive a stalled lifecycle.** Rejected: a
read action that can advance state is a write action with a misleading name, and
resume is exactly the action an agent reaches for when blocked.

**Let a passing `release offline-verify` satisfy the `exported` prerequisite.**
Rejected: it converts an observation into a transition and lets a verification
manufacture the state it was meant to check.

**Give every write action to the Architect.** Rejected: it collapses the
sensor and specification authorities into one role inside a single lifecycle,
which Article 10 forbids.

**Amend ADR-014 in place.** Rejected: superseding by editing the superseded
record destroys the history the authority chain depends on.

## Affected Rules

- `law/policy/action-registry.json` — nine added release actions; counts updated.
- `law/policy/release-lifecycle.json` — new canonical action and state policy.
- `law/schemas/release-lifecycle-policy.schema.json` — new policy contract.
- `law/schemas/release-lifecycle-state.schema.json` — new state record contract.
- `law/schemas/effect-authorization-event.schema.json` — authorization consumed by the two remote actions.

## Inspector Adversarial Acceptance

Acceptance is demonstrated by the attacks in this record's
`inspector_acceptance` frontmatter, each of which must fail closed. The
Inspector additionally demonstrates that a lifecycle record carrying a
`remote-write` effect with a null `authorization_event_id` is rejected by the
state contract, and that a `preflighted` record carrying a non-null
`prior_state` is rejected.
