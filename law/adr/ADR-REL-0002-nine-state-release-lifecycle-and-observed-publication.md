---
id: ADR-REL-0002
title: Nine-state release lifecycle with pure reads and observed publication
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-REL-0001
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 10 (authority separation in a single loop iteration)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0001-release-lifecycle-actions-and-state.md
  - law/policy/governed-surface.md
  - law/policy/trusted-local-rc-verifier-package.json
affected_rules:
  - law/policy/action-registry.json
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/release-plan-receipt.schema.json
  - law/schemas/release-offline-verification-receipt.schema.json
  - law/schemas/release-publication-receipt.schema.json
  - law/schemas/release-lifecycle-observation.schema.json
inspector_acceptance:
  - IA-001 -- release publish that appends a published state record fails closed. The only state a dispatch may append is publication_dispatched, and a record naming published is rejected by the state contract regardless of the authorization presented.
  - IA-002 -- release resume that appends any record fails closed. Observing published never writes, and an observation that claims published without a verified signed publication receipt is rejected.
  - IA-003 -- release preflight without a bound valid plan receipt fails closed. A plan receipt whose repository, candidate, or input identity differs from the invocation is a mismatch, not a near match.
  - IA-004 -- release evidence-publish without a bound passing offline-verification receipt fails closed. A failing receipt, an absent receipt, and a receipt bound to a different exported state each fail.
  - IA-005 -- A signed publication receipt whose dispatched-state id, record digest, candidate, artifact digest, or trust identity differs from the recorded publication_dispatched state does not derive published. A near match is a mismatch.
  - IA-006 -- A publication receipt carrying an absent, malformed, or untrusted signature derives nothing. An unverifiable receipt is not weaker evidence; it is no evidence.
  - IA-007 -- release plan, release offline-verify, and release resume leave the repository byte-identical. A read that writes state, evidence, or a receipt file fails closed.
  - IA-008 -- Possession of any receipt or observation authorizes no effect. Presenting a plan receipt, an offline-verification receipt, a publication receipt, or a lifecycle observation in place of an Owner authorization fails on both remote actions.
  - IA-009 -- release prepare and release export refuse an Inspector-declared session, and release preflight and release certify refuse an Architect-declared session. The registry role is the only accepted initiator.
  - IA-010 -- Replaying a consumed one-time authorization on either remote action fails, and an Owner authorization for a different candidate version, commit, or tree fails on both.
---

# Nine-state release lifecycle with pure reads and observed publication

## Status

Accepted. Supersedes ADR-REL-0001.

## Context

ADR-REL-0001 declared nine release actions over six ordered states and separated
evidence publication from product publication. Its action set, its effect
ceilings, and its role separation were correct and are carried forward
unchanged.

Three things in it were wrong or unstated.

First, the lifecycle had no state for what a read action establishes. `release
plan` and `release offline-verify` produced a verdict that vanished: nothing in
the contract said what a later mutating action was allowed to rely on, so a
mutating action could only claim it had read something.

Second, `release publish` produced `published` directly. The action that
initiates a publication is not the thing that observes one. Treating the local
dispatch record as proof of the external outcome means the repository asserts a
fact about a remote system it never checked, and a dispatch that failed
downstream leaves a record that reads as success.

Third, the boundary between what the repository persists and what it merely
observes was implicit. A state that is derived from a receipt and a state that
is appended to a chain are different kinds of claim, and a contract that stores
them in one undifferentiated enum invites a reader to append the derived ones.

## Decision

The release lifecycle is nine actions over nine states.

The states, in order, are `planned`, `preflight_passed`, `certified`,
`prepared`, `exported`, `offline_verified`, `evidence_published`,
`publication_dispatched`, and `published`.

Six of them are persisted. `preflight_passed`, `certified`, `prepared`,
`exported`, `evidence_published`, and `publication_dispatched` are appended by
the six mutating actions, one state per action, and are the only states a
lifecycle state record may name.

Three of them are derived and never persisted. `planned` is derived from a
deterministic plan receipt, `offline_verified` from a passing deterministic
offline-verification receipt, and `published` from a signed publication receipt.
No action produces them, and the state contract rejects a record that names one.

Three actions are read and are pure. `release plan` emits a deterministic plan
receipt to stdout, `release offline-verify` emits a deterministic
offline-verification receipt to stdout, and `release resume` verifies supplied
or located receipts and emits a deterministic lifecycle observation to stdout.
None of the three persists repository state, appends a record, or writes a
receipt file. Their output is evidence about the repository, not a change to it.

Mutating actions bind the read receipts they require and append their own state
records. `release preflight` binds a valid plan receipt and appends
`preflight_passed`. `release evidence-publish` binds a passing
offline-verification receipt and appends `evidence_published`. The remaining
four bind their named predecessor by state id and record digest.

`release publish` produces `publication_dispatched` and nothing further. It
consumes its own exact, one-time, Owner-issued authorization, dispatches the
publication, and records that it did so. A protected external workflow later
emits a signed publication receipt for that dispatch.

`published` is observation-only. `release resume` may derive it, and only by
verifying the signed publication receipt against the exact
`publication_dispatched` state identity, candidate identity, artifact identity,
and trust identity it claims. It never appends `published`, and an unverifiable
receipt derives nothing.

Receipts and observations grant no authority. A receipt is not an
authorization, not a consent, and not a substitute for a state it did not
produce. Every receipt and observation binds exact repository, candidate, input,
artifact, state, verifier, workflow, and trust identity as its kind requires,
along with canonical receipt digests, and any divergence fails closed.

Article 10 holds across the lifecycle unchanged: the role that certifies a
candidate is not the role that packages it, and neither is the role that
publishes it.

## Consequences

The nine actions and their registry entries are unchanged in count, effect,
role, and stability. What changes is what each one returns: `release plan`
returns a plan receipt, `release offline-verify` returns an offline-verification
receipt, `release resume` returns a lifecycle observation, and all six mutating
actions return a lifecycle state record. The registry keeps exactly fifty-seven
entries at thirty-two stable, fourteen preview, and eleven internal.

Publication is now a two-party fact. The repository can say it dispatched a
publication; only the protected external workflow's signed receipt lets it say
the publication happened. A dispatch whose receipt never arrives stays at
`publication_dispatched`, which is the honest reading of that situation.

These remain contracts before they are code. No CLI handler, effects-check
catalog entry, sensor kind, or generated registry view is claimed here, and the
four new receipt schemas are not yet in the runtime schema roster. Until an
Engineer implements the handlers, the receipt emitters, the receipt verifier,
and the protected publication workflow, this surface has no runtime, which is a
stated gap rather than an implied capability.

`release verify`, `release check`, `release drift`, and `release status` are
untouched. The mutation-assurance, effect-authorization, and self-dogfood
contracts are untouched.

ADR-REL-0001's file is not edited. This record supersedes it forward, and
ADR-014 remains preserved byte-for-byte under the exception catalog in
`law/policy/adr-validation.json`.

## Alternatives Considered

**Keep six states and treat plan and offline-verify output as ambient.**
Rejected: a mutating action that cannot name the exact receipt it relied on
relies on nothing checkable, which is the failure Article 41 exists to prevent.

**Persist `planned` and `offline_verified` as records.** Rejected: it makes a
read action a write action, and it lets a verification manufacture a state in
the chain it was meant to observe.

**Let `release publish` append `published` and let the workflow receipt confirm
it afterwards.** Rejected: the record would assert a remote outcome before any
evidence of it exists, and a later contradicting receipt would have to correct a
history that already read as success.

**Let `release resume` append `published` once it verifies the receipt.**
Rejected: resume is the action an agent reaches for when blocked. A read that
can append the terminal state is the most dangerous write in the lifecycle
wearing the safest name.

**Trust the publication receipt on signature validity alone.** Rejected: a
validly signed receipt for a different candidate, artifact, or dispatch is still
a statement about something else. Signature validity is necessary and never
sufficient.

**Amend ADR-REL-0001 in place.** Rejected: superseding by editing the superseded
record destroys the history the authority chain depends on.

## Affected Rules

- `law/policy/action-registry.json` — output payload schemas for the nine actions; counts unchanged.
- `law/policy/release-lifecycle.json` — nine states, receipt bindings, dispatch and observation separation.
- `law/schemas/release-lifecycle-policy.schema.json` — persisted versus derived states; per-action receipt obligations.
- `law/schemas/release-lifecycle-state.schema.json` — six appendable states; bound receipts; `published` unappendable.
- `law/schemas/release-plan-receipt.schema.json` — deterministic plan receipt.
- `law/schemas/release-offline-verification-receipt.schema.json` — deterministic offline-verification receipt.
- `law/schemas/release-publication-receipt.schema.json` — signed publication receipt from the protected external workflow.
- `law/schemas/release-lifecycle-observation.schema.json` — deterministic lifecycle observation.

## Inspector Adversarial Acceptance

Acceptance is demonstrated by the attacks in this record's
`inspector_acceptance` frontmatter, each of which must fail closed. The
Inspector additionally demonstrates that a lifecycle record carrying a
`remote-write` effect with a null `authorization_event_id` is rejected by the
state contract, that a `preflight_passed` record carrying a non-null
`prior_state` is rejected, and that a lifecycle observation reporting
`published` with a head other than `publication_dispatched` is rejected.
