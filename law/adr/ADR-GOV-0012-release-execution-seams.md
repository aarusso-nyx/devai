---
id: ADR-GOV-0012
title: Fail-closed release execution seams
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0007
  - ADR-AUT-0001
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0007-subject-scoped-effective-authority.md
  - law/adr/ADR-AUT-0001-exact-effect-authorization-ledger.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
inspector_acceptance:
  - IA-001 -- Every lifecycle action accepts only its declared locator/provider/destination projection and rejects client-supplied lifecycle identity, digest, actor, authority, authorization, or consent material.
  - IA-002 -- A stale or unsafe head, symlink, nonregular target, existing record, broken chain, or crash residue refuses without overwrite, repair, or lifecycle advance.
  - IA-003 -- An adapter cannot provide a lifecycle record or authority decision; the core rechecks every bound identity and hashes the only appendable record.
  - IA-004 -- Prepare records contain a package tarball, manifest, and SBOM; export records contain an evidence bundle and provider result; evidence binds manifest and receipt digests.
  - IA-005 -- An unavailable or failed provider appends only failure evidence. A consumed authorization is never replayed, including after a crash before a success record, and a retry requires a fresh exact Owner grant.
---

# ADR-GOV-0012 — Fail-closed release execution seams

## Status

Accepted. This forward ADR supersedes ADR-GOV-0007 and ADR-AUT-0001 only for
the three shared lifecycle subjects. It preserves every predecessor byte and
every unrelated subject authority.

## Context

The nine-state lifecycle specifies valid transitions and the exact
authorization ledger specifies one-time external consent, but neither record
defines the seam between an untrusted invocation, a local append-only state
store, a producer adapter, and a protected provider. Implementing those pieces
without a shared contract would let a client choose a predecessor, digest,
actor, or authorization identity, or could replay an external effect after a
crash.

## Decision

The release execution-seams v1 kernel is the authoritative implementation
handoff. Each action receives only its fixed projection of candidate,
repository, receipt locators, provider, and destination; lifecycle IDs,
generations, digests, actor, authority, authorization, consent, and effective
authority are core-derived and forbidden from the client request.

State lives only below the deterministic candidate-bound release store. The
core lstat-checks every path, rejects symlinks and nonregular existing files,
creates records exclusively, and atomically replaces only the head after it
has rechecked the predecessor. A record and head are durable only after file
and parent-directory synchronization. Resume scans and recomputes the chain;
it reports the next action and never repairs, overwrites, or advances it.

Adapters return bounded raw output or an opaque provider handle only. They do
not construct lifecycle records, choose state, or decide authority. The core
revalidates locators, candidate, receipts, and provider output, binds
check-runner manifest and receipt digests, then composes and hashes the record.
Every mutating attempt has an append-only attempt record; failure has an
append-only failure record and never advances lifecycle state.

Prepare state includes the deterministic package tarball, manifest, and SBOM.
Export state includes the evidence bundle and provider result. Offline
verification receives external trust inputs, is pure, and emits no state
record.

For either remote action, the core revalidates state and offline evidence,
records the attempt, and consumes the exact unconsumed Owner authorization in
the append-only ledger before provider dispatch. It then dispatches and appends
the success state. If dispatch fails or the process crashes after consumption,
the lifecycle does not advance and resume must not dispatch using that grant;
another attempt needs a fresh exact authorization. This deliberate
at-most-once rule prefers a recoverable authorization outage over replaying an
irreversible external effect.

## Consequences

Engineer can implement local and remote action adapters without trusting
client-drafted state. An ambiguous partial remote outcome remains a stop and
requires fresh Owner direction; it is never silently retried. Existing action
names and compatibility surfaces remain unchanged, while the state schema now
recognizes the required prepared and exported artifact kinds.

## Alternatives Considered

**Consume authorization after provider dispatch.** Rejected because a crash
after dispatch can replay the same irreversible effect.

**Let adapters compose lifecycle records.** Rejected because a provider-facing
adapter would then control governed predecessor, identity, or authority data.

**Repair a damaged head during resume.** Rejected because recovery cannot
invent missing ordering or ownership evidence.

**Treat a provider failure as an unconsumed authorization.** Rejected because
the protected call may have reached the provider despite a local failure.

## Affected Rules

- `law/policy/release-lifecycle.json`: exact invocation projection, state
  storage, adapter, artifact, remote-order, and refusal contracts.
- `law/schemas/release-lifecycle-policy.schema.json`: machine-validatable
  execution-seam policy and canonical example.
- `law/schemas/release-lifecycle-state.schema.json`: required prepared and
  exported artifact kinds.

## Inspector Adversarial Acceptance

- IA-001 -- Each action projection, client-state injection, provider output,
  stale-head, and unsafe-path refusal is independently demonstrated.
- IA-002 -- Crash before CAS, after record creation, after authorization
  consumption, and after provider dispatch do not overwrite or duplicate an
  effect; resume is deterministic and non-writing.
- IA-003 -- Missing prepared/exported artifact kinds, manifest/receipt digest
  mismatch, external-trust omission, provider unavailability, and provider
  failure fail closed without lifecycle advance.
- IA-004 -- A retry after a consumed authorization is denied until a new exact
  Owner grant is observed and consumed.
