---
id: ADR-GOV-0013
title: Executable fail-closed release lifecycle contract
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0012
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0012-release-execution-seams.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/release-lifecycle-observation.schema.json
  - law/schemas/release-lifecycle-request.schema.json
  - law/schemas/release-lifecycle-store-record.schema.json
  - packages/schemas/src/roster.ts
inspector_acceptance:
  - IA-001 -- Every lifecycle head, derived state, blocked store condition, and ambiguous provider outcome produces one exact pure resume outcome and never causes resume to mutate or redispatch.
  - IA-002 -- A malformed request, nested authority or state injection, locator drift, stale head, forged predecessor, noncanonical ID or digest, unsafe path, orphan, conflicting sequence, or broken chain fails before lifecycle advance.
  - IA-003 -- A remote authorization consumption names one durable attempt and its exact request/repository/candidate/action/destination; a crash or unknown provider result after consumption forbids blind replay.
  - IA-004 -- For every release unit and package, manifest, tarball, SBOM, evidence manifest, provider result, and trust identity form one exact action-appropriate bijection across request, state, store, receipt, and provider result.
  - IA-005 -- A v1 record remains readable for observation only; every new persisted record is v2, JCS-hashed, content-addressed, predecessor/head checked, and semantically revalidated by the core.
---

# ADR-GOV-0013 — Executable fail-closed release lifecycle contract

## Status

Accepted. This forward ADR supersedes ADR-GOV-0012 only for the lifecycle
subjects they share. It preserves predecessor bytes and all unrelated authority.

## Context

The initial execution-seam contract established the correct direction—core
derivation, append-only state, and consume-before-dispatch—but left several
implementation choices open. In particular, resume did not have a total next
action mapping, append-only records lacked a machine-validatable durable event
shape, provider uncertainty did not have a distinct terminal record, and
multi-package artifacts could be described without a complete identity
bijection.

## Decision

Release execution contract v2 is the only contract for new lifecycle writes.
It defines a closed request schema; no request can contain lifecycle state,
digest, actor, authorization, authority, consent, provider result, or provider
handle material. The core resolves and JCS-hashes the request, candidate,
receipts, and provider outputs itself.

The store has exactly head, attempt, completion, failure, and unknown-result
record populations. Every store event is an RFC 8785 JCS SHA-256 record with a
content-derived ID and exact predecessor. Record creation is exclusive and
durable before a completion may compare-and-swap the head. Resume recomputes
the one chain from genesis and reports an orphan or conflict without linking,
repairing, deleting, or overwriting it.

Resume is pure and total: every lifecycle state maps to exactly one next action
or to a terminal complete/awaiting/blocked/ambiguous outcome. Unknown provider
results, consumed authorization without an observed completion, and every
identity or chain mismatch have null next action. They never redispatch.

For a remote effect, the authorization consumption is durable and names the
exact attempt, request digest, repository, candidate, action, and destination
before the one provider dispatch. A timeout or crash after consumption is an
unknown provider result, not permission to retry. A new attempt needs a fresh
exact Owner authorization.

V2 state adds canonicalization and release-unit package evidence. Every package
is paired exactly once with its manifest, tarball, SBOM, evidence manifest,
provider result, and non-secret trust identity when that lifecycle stage makes
the material available. V1 remains wire-readable only; it cannot establish a
new v2 transition.

## Consequences

Engineer receives closed documents and deterministic stop outcomes rather than
client-trusted conventions. Partial remote outcomes remain deliberately
conservative: they may need human resolution and a fresh authorization, but
they cannot duplicate a protected effect. Existing record bytes remain
readable; no historical record is rewritten.

## Alternatives Considered

**Infer a retry from an absent completion record.** Rejected because the
provider may have received the effect before the local process failed.

**Use only a mutable head file as execution evidence.** Rejected because it
cannot distinguish a crash, orphan, conflicting writer, or forged predecessor.

**Allow a client to name a state or authorization as a convenience.** Rejected
because a locator request would then become a bearer authority channel.

**Treat a package aggregate as sufficient evidence.** Rejected because it can
hide one omitted or substituted package artifact.

## Affected Rules

- `law/policy/release-lifecycle.json`: v2 execution, total resume, state, store,
  remote-effect, and package-bijection semantics.
- `law/schemas/release-lifecycle-policy.schema.json`: closed machine-readable
  lifecycle contract and canonical example.
- `law/schemas/release-lifecycle-state.schema.json`: v1 read compatibility and
  v2 canonical state/release-unit shape.
- `law/schemas/release-lifecycle-observation.schema.json`: pure exact
  next-action/outcome reporting.
- `law/schemas/release-lifecycle-request.schema.json`: closed untrusted request
  projection.
- `law/schemas/release-lifecycle-store-record.schema.json`: durable JCS-chained
  attempt/completion/failure/unknown records.
- `packages/schemas/src/roster.ts`: registers the new canonical schemas.

## Inspector Adversarial Acceptance

- IA-001 -- Each state and all blocked/ambiguous branches produce the declared
  next-action result without state mutation.
- IA-002 -- Nested client state/authority injection, malformed locator, stale
  head, forged chain, noncanonical content identity, unsafe filesystem target,
  orphan, and conflict all fail closed.
- IA-003 -- Authorization replay, provider timeout, crash after consumption,
  and unknown provider response never dispatch twice.
- IA-004 -- Omitted, duplicated, reordered, digest-mismatched, or
  trust-mismatched package material fails the cross-document bijection.
- IA-005 -- V1 reads remain accepted while every newly written v2 state and
  store record must satisfy its canonical semantic kernel.
