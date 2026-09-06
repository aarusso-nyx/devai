---
id: ADR-GOV-0015
title: Lifecycle kernel closure and callable schema reachability
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-GOV-0014
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 6 (substrate authority-by-path)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-GOV-0014-durable-v2-remote-execution.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/effect-authorization-ledger.schema.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-store-record.schema.json
  - law/schemas/release-offline-verification-receipt.schema.json
  - packages/schemas/src/roster.ts
inspector_acceptance:
  - IA-001 -- A local or harness completion has a null provider handle and not-dispatched status; a remote dispatched completion requires an observed nonempty handle.
  - IA-002 -- The store semantic kernel defines an opening attempt, a successor attempt against the exact current head, an exact terminal-to-attempt link, at most one terminal, and mutually exclusive completion/unknown outcomes.
  - IA-003 -- The authorization ledger verifies both v1 and v2 event canonicalizations and validates a v2 consumption binding before dispatch without weakening v1 read semantics.
  - IA-004 -- Offline verification reads v1 receipts and validates v2 canonicalization plus complete package, result, and trust closure.
  - IA-005 -- The installed schema roster contains every callable governance schema required by the lifecycle, ADR, mutation, and self-dogfood public contracts.
---

# ADR-GOV-0015 — Lifecycle kernel closure and callable schema reachability

## Status

Accepted. This forward ADR supersedes ADR-GOV-0014 only for its shared
lifecycle execution and schema-reachability subjects.

## Context

The prior lifecycle correction made a remote completion safe but accidentally
applied its dispatched-handle condition to every completion. Its store chain
also described a completion as genesis before first defining the attempt that
the completion closes. The authorization ledger and offline receipt envelopes
could parse v2 fields while their named semantic kernels still hard-coded v1.
Finally, the package roster omitted callable governance schemas, making an
installed runtime unable to validate the same public surface as source.

## Decision

Only remote completions require a dispatched, observed provider handle. Local
and harness terminal records remain non-dispatched with a null handle. The
store's deterministic chain starts with an opening attempt, links each later
attempt to the exact current completed head, and links every terminal record to
one exact attempt. Completion and unknown results are mutually exclusive, and
there is never more than one terminal record per attempt.

The authorization-ledger semantic verifier explicitly supports v1 and v2
canonical event records. It preserves the v1 consumed-state binding and, for
v2 consumption, recomputes the exact durable attempt, request, repository,
candidate, destination, grant, and ledger-predecessor binding before dispatch.
The offline verifier likewise selects the receipt schema-version canonicalizer
and closes v2 package manifests, tarballs, SBOMs, evidence manifests, provider
results, and trust identities exactly.

The source and installed schema roster is the explicit closure of callable
governance contracts, including ADR-v2, mutation policy/report v2, and
self-dogfood. It does not imply that deprecated mutation policy has release
authority.

## Consequences

Normal local lifecycle actions are representable, while remote effects retain
their at-most-once safety. A malformed v2 consumption, receipt closure, or
store linkage remains a refusal rather than an inferred repair. Installed
DEVAI can load every schema named by its current public governance surface.

## Alternatives Considered

**Treat every completion as a provider dispatch.** Rejected because a local
preflight or certification has no provider handle to observe.

**Let a terminal record name only an attempt ID.** Rejected because the store
would lack a deterministic predecessor chain for audit and resume.

**Require v2 event/receipt writers but keep v1-only semantic kernels.**
Rejected because structural acceptance cannot establish the intended v2
identity or trust closure.

## Affected Rules

- `law/policy/release-lifecycle.json`: exact attempt/terminal/head semantics.
- `law/schemas/effect-authorization-ledger.schema.json`: v1/v2 event and
  durable-consumption semantic verification.
- `law/schemas/release-lifecycle-policy.schema.json` and
  `release-lifecycle-store-record.schema.json`: executable store contract.
- `law/schemas/release-offline-verification-receipt.schema.json`: version-bound
  receipt canonicalization and v2 package/trust/result closure.
- `packages/schemas/src/roster.ts`: installed callable schema closure.

## Inspector Adversarial Acceptance

- IA-001 -- A nonremote completion validates without a provider handle; a
  remote completion without one does not.
- IA-002 -- Forged opening, successor, terminal, duplicate-terminal, and
  completion/unknown chain cases fail semantic verification.
- IA-003 -- V1 and v2 event/receipt fixtures both validate under their exact
  canonicalization; a missing v2 consumption or package/trust/result field
  fails closed.
- IA-004 -- Every named governance schema is included in the installed roster.
