---
id: ADR-AUT-0001
title: Append-only exact effect authorization
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/schemas/authority-policy.schema.json
  - law/schemas/governance-event.schema.json
  - law/schemas/forbidden-action-authorizations.schema.json
affected_rules:
  - law/schemas/effect-authorization-event.schema.json
  - law/schemas/effect-authorization-ledger.schema.json
  - law/policy/release-lifecycle.json
inspector_acceptance:
  - IA-001 -- An authorization presented a second time is denied. The first consumption is terminal and the ledger records it.
  - IA-002 -- A revoked authorization is denied even when it has not expired and has never been consumed.
  - IA-003 -- An expired authorization is denied even when it was never consumed and was never revoked.
  - IA-004 -- An authorization whose action, effect, resource, repository, candidate, consuming role, or consent differs from the invocation is denied. Every one of those mismatches is tested independently.
  - IA-005 -- An identifier containing a glob metacharacter is rejected by the contract, so a scope cannot widen at resolution time.
  - IA-006 -- Presenting the bytes of a valid authorization from a different declared role is denied. Possession is not authority.
  - IA-007 -- A ledger with a sequence gap, a broken digest link, or an unresolvable reference denies every authorization it contains rather than resolving the intact prefix.
  - IA-008 -- An absent ledger denies. Absence is a failure to observe, never an absence of restriction.
  - IA-009 -- A remote-write authorization granted by any role other than Owner is rejected by the contract.
---

# Append-only exact effect authorization

## Status

Accepted.

## Context

DEVAI already has three partial authorization mechanisms. The authority policy
resolves whether an action *may* occur against a selector. Governance events
record what *did* occur, hash-linked and append-only. Forbidden-action
authorizations record an Owner receipt for one finding at one commit.

None of them is a consumable grant for one external effect. The gap matters most
at the release boundary, where an effect is externally visible and irreversible:
publishing a package or an evidence bundle is not undone by recording that it
happened. A rule that says Owner may publish is a standing permission; what a
publication needs is a specific, exhaustible, revocable act of consent bound to
the exact thing being published.

The failure modes to design against are concrete. A grant that outlives its use
is replayable. A grant that names a family of resources widens at resolution
time. A grant whose bytes are sufficient to act is a bearer token, and bearer
tokens leak. A grant that is checked against an absent or broken ledger, and
therefore treated as unconstrained, fails open.

## Decision

An effect authorization is one append-only, hash-linked event naming exactly one
action, one effect, one resource, one repository, one candidate, one consuming
role, one consent triple, and one validity window.

It is consumable exactly once. `one_time` is true and `uses_permitted` is one,
and consumption is itself an appended event that names the grant it resolves and
the lifecycle state it produced.

It confers nothing on its holder. `bearer_transferable` and `delegable` are both
false. Authority resolves from the ledger, the declared role, and the exact
bound identities; the record's bytes are not a credential.

There is no wildcard scope. The action id pattern admits no glob character, and
the resource identifier pattern rejects glob metacharacters outright, so a scope
cannot expand at resolution time.

Resolution is fail-closed on every outcome that is not an exact, live,
unconsumed match. Replay denies. Revocation denies. Expiry denies. A sequence
gap denies. A broken digest link denies. An unresolvable reference denies. Any
identity mismatch denies. An absent ledger denies — that last one is the
important one, because it is the case where failing open looks like nothing
happening.

For release remote effects, the grantor and the consuming role are both Owner.
The contract enforces this structurally: a `remote-write` authorization from any
other role is rejected.

## Consequences

Every publication requires an Owner act that is exhausted by use. Two
publications require two grants. A failed publication that must be retried
requires a new grant, which is a deliberate cost: the retry is a new external
effect and deserves a new decision.

Ledger integrity is load-bearing. A ledger that cannot be resolved blocks
publication rather than permitting it, so a corrupted ledger is an outage rather
than a breach. That trade is intended.

The existing authority policy is unchanged. It continues to decide whether an
action may occur at all; an authorization decides whether one particular
occurrence is consented to. Both must succeed.

No runtime consumes these records yet. This decision defines the contract; the
resolver, the ledger writer, and their adversarial tests are Engineer and
Inspector work. Until they exist, no action in the registry is gated by a
ledger, and claiming otherwise would be a false readiness claim.

## Alternatives Considered

**Reuse governance events for authorization.** Rejected: governance events
record that something occurred. An authorization must be checkable and
exhaustible *before* the effect. Conflating the record of an act with the
permission for it means the permission is written by the actor.

**A standing role-based rule that Owner may publish.** Rejected: that is what
the authority policy already provides, and it is exactly the shape that cannot
be exhausted, revoked for one candidate, or bound to a specific artifact.

**Signed bearer tokens.** Rejected: possession becomes authority, which is the
property being designed out. A leaked token publishes.

**Resolve the intact prefix of a broken ledger.** Rejected: an attacker who can
truncate a ledger would choose the prefix. A broken chain denies entirely.

**Treat an absent ledger as no restrictions.** Rejected: it is the canonical
fail-open. Article 41 is explicit that a failure to observe never manufactures a
pass.

## Affected Rules

- `law/schemas/effect-authorization-event.schema.json` — new authorization event contract.
- `law/schemas/effect-authorization-ledger.schema.json` — new append-only ledger contract.
- `law/policy/release-lifecycle.json` — binds the two remote release actions to Owner-only one-time authorizations.
- `law/schemas/release-lifecycle-state.schema.json` — remote transitions cite the consumed authorization.
- `law/schemas/authority-policy.schema.json` — unchanged; permission and consent remain separate gates.

## Inspector Adversarial Acceptance

Acceptance is demonstrated by the attacks in this record's
`inspector_acceptance` frontmatter, each of which must fail closed. The
Inspector additionally demonstrates that a `granted` event carrying a
`consumed_by_state_id` is rejected by the contract, and that a `consumed` event
that does not name its grant is rejected.
