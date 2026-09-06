---
id: ADR-GOV-0014
title: Durable v2 remote execution and package-trust bindings
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0013
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0013-executable-release-lifecycle-contract.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/effect-authorization-event.schema.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-store-head.schema.json
  - law/schemas/release-lifecycle-store-record.schema.json
  - law/schemas/release-offline-verification-receipt.schema.json
  - packages/schemas/src/roster.ts
inspector_acceptance:
  - IA-001 -- A remote attempt permits no provider handle before dispatch; an observed dispatched completion requires a nonempty handle; unknown results preserve whether a handle was observed.
  - IA-002 -- A v1 consumed authorization retains its non-null state binding; a v2 consumed authorization has a null legacy state field and binds the exact durable attempt, request, identities, destination, grant, and predecessor before dispatch.
  - IA-003 -- The v2 store admits only one terminal event per attempt, rejects completion/unknown conflicts, and advances a candidate-bound head only through the exact completion chain from genesis.
  - IA-004 -- Preflight attempts do not require future artifacts; completion-stage package requirements are exact and a v2 offline receipt names every package artifact and trust identity.
  - IA-005 -- Release resume accepts absent or every lifecycle head as a pure observation, while the deprecated v1 execution seam cannot choose current request, store, or remote-effect semantics.
---

# ADR-GOV-0014 — Durable v2 remote execution and package-trust bindings

## Status

Accepted. This forward correction supersedes ADR-GOV-0013 only for the shared
lifecycle execution subjects. Earlier records and schemas remain readable.

## Context

The v2 lifecycle handoff correctly required consume-before-dispatch but left a
pre-dispatch record looking as if it needed a future provider handle and a
completed package population. It also retained an incompatible v1
`consumed_by_state_id` requirement at the point at which consumption must
precede a state. The v2 head and terminal-record constraints were prose rather
than a named contract, and offline verification could not name each package's
trust identity.

## Decision

The canonical executable surface is `execution_contract` v2. Legacy
`execution_seams` is sealed as deprecated, read-only, and non-authoritative.
`release resume` selects no prior state and resolves every head condition under
the v2 observation mapping.

A remote attempt records `not-dispatched`, no observed handle, and a null
handle. Completion after dispatch requires an observed, nonempty handle. A
failure can state that it occurred before dispatch; an unknown terminal result
must retain whether a handle was observed. V2 authorization consumption is a
new event shape, bound to the already-durable exact attempt before dispatch;
v1 consumed events retain their original non-null state field.

The named v2 head schema and store kernel make genesis, successor, terminal,
and head linkage deterministic. Package artifacts are nullable on generic
attempts and required only by their completion-stage semantics. V2 offline
receipts bind the per-release-unit package roster and the exact non-secret
trust-root, trust-store digest, key, and algorithm used for verification.

## Consequences

No client can fabricate a missing provider handle after dispatch, reuse a
consumed authorization, or make an attempt appear to be a completed package
population. A crash remains a fail-closed stop. Readers retain v1 compatibility
without granting v1 new write authority.

## Alternatives Considered

**Write the state before consuming authorization.** Rejected: it reverses the
durable ordering needed to prevent replay.

**Require all future artifacts on an attempt.** Rejected: it makes preflight
and a pre-dispatch remote attempt unrepresentable.

**Infer a terminal event from a moved head.** Rejected: it cannot distinguish
unknown provider state from a completed effect.

## Affected Rules

- `law/policy/release-lifecycle.json`: exclusive v2 request, store, resume,
  handle, authorization, artifact, and trust semantics.
- `law/schemas/effect-authorization-event.schema.json`: read-compatible v1 and
  attempt-bound v2 consumed events.
- `law/schemas/release-lifecycle-*.schema.json`: closed policy, head, and store
  contracts.
- `law/schemas/release-offline-verification-receipt.schema.json`: v2
  package/trust receipt binding.
- `packages/schemas/src/roster.ts`: canonical reachability of those schemas.

## Inspector Adversarial Acceptance

- IA-001 -- V1-null, v2-non-null, missing v2 binding, wrong kernel, and a
  remote completion without an observed handle all reject.
- IA-002 -- A remote pre-dispatch attempt with no handle and no future artifact
  population validates; a valid dispatched completion names its handle.
- IA-003 -- Forged genesis/successor/head linkage, duplicate terminal records,
  and completion/unknown overlap fail the store kernel.
- IA-004 -- A v2 receipt missing package or trust material fails; a v1 receipt
  remains readable only under its v1 canonicalization kernel.
