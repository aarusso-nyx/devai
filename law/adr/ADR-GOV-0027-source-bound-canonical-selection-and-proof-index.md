---
id: ADR-GOV-0027
title: Source-bound canonical selection and a typed one-entry proof index contract
type: adr
status: accepted
date: 2026-10-24
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (machine proof storage and binding authority)
  - law/constitution.md Article 9 (explicit constitutional amendment)
  - law/constitution.md Articles 7, 10 and 24 (independent assurance)
  - ADR-GOV-0026 (preserved 1.1.0 authority rows and role safeguards)
  - ADR-EVI-0006 (separate custody-proven divergent-anchor contract)
  - REC-B1-A and three-path catalogue companion, contract-authoring approval on 2026-10-24
affected_rules:
  - law/constitution.md
  - law/schemas/proof-index-reconciliation-contract.schema.json
inspector_acceptance:
  - IA-001 -- Removing only the two proposed Article 6 paragraphs and successor date/version markers recovers exact Constitution 1.1.0 bytes and digest; the preserved ADR-GOV-0026 regression still reconstructs exact 1.0.2.
  - IA-002 -- Every existing Article 6 authority row, Article 9 and all other article bodies remain byte-identical; no role, client extension, filesystem grant or ref operation can widen the exception.
  - IA-003 -- The reference schema rejects unknown nested fields, arbitrary physical Git paths, any proof path other than record/proofs/chain.json, non-Inspector initiation, absent consent and broad or ref effects.
  - IA-004 -- The contract schema remains source-only; the complete canonical catalogue adds exactly one schema while the installed runtime ROSTER remains unchanged, with missing and unexpected schemas still refused.
  - IA-005 -- Structurally valid identity and custody strings are never treated as a runtime capability; trusted-host semantic verification, real-index locking and one-entry CAS require separately approved implementation.
  - IA-006 -- Source and pin divergence remains a failed binding gate until exact registered effects are separately approved; no test or author may hand-edit pin/config state to manufacture successor parity.
---

# Source-bound canonical selection and a typed one-entry proof index contract

## Status

Contract initially authored under the human's 2026-10-24 instruction:

“Approve REC-B1-A and its three-path catalogue companion for contract authoring only. Preserve historical checks; return the exact version, digest and binding plan before binding or integration. Keep runtime, release and DETRAN effects held.”

The human subsequently expressly authorized all listed DEVAI internal work,
binding, integration and publication as v2.8.0. That authorization accepts this
bounded Constitution **1.2.0** amendment with the previously returned exact source
SHA-256 `d5dfdc972161e0f848dd859be7bbfa510973c5c9a449a0f9e6b8960e4f5ac96a`.
The registered installed-package preview and subsequent binding are recorded in
`docs/dev/operations/u1-b1-recovery-20261024/release-280/self-binding-success/`.
Earlier authoring-only packets and their holds remain historical. This record
supersedes no historical ADR; ADR-GOV-0026 and accepted evidence ADRs remain exact.
DETRAN execution and adoption remain outside the authorization.

## Context

Article 6 permits proof storage only through executing-verb appends. Immutable
custody of divergent chains alone cannot authorize replacement of the active
chain during an unresolved merge. Article 9 requires explicit constitutional
amendment for a changed fail-closed property in Articles 6–10. Existing machine
filesystem rules are not an exception to append-only semantics.

The current runtime target union has fs, git-ref, db and remote; a ref target does
not authorize index mutation. A linked worktree may resolve its real index into
Git administration outside its checkout, so broad filesystem grants or
caller-supplied physical paths are unsuitable. A source-only typed contract can
specify the boundary without installing any target, adapter or executable action.

## Decision

Propose exactly the following two insertions in Article 6, preserving every
existing row and other article. First insert immediately after the `record/` row:

> At an explicitly Owner-approved unresolved Git merge, a registered machine evidence-reconciliation verb may materialize the complete canonical chain of one exact published parent as the active merge result only after it has durably preserved and hash-verified the complete chains, proof epochs and ancestry of every displaced parent and the common base. This is a narrowly declared canonical-selection exception to append-only storage, not permission to edit, truncate, reorder, resequence, splice or re-record any source history or proof epoch. The Inspector-initiated verb must bind the exact parents, semantic index, source manifests, selected canonical prefix and immutable custody receipts, refuse every unapproved delta, and append a distinct canonical-selection evidence entry to the selected prefix through the normal machine writer before publishing the result. Every displaced active event remains explicitly archival; missing proof anchors require their separately authorized supported recovery. No human or client extension may exercise or widen this exception.

Then insert the separate metadata paragraph after the existing extension paragraph
and before the Article 6 closing rule:

> Git index mutation is permitted only through a registered machine index boundary for an exact approved reconciliation. The boundary addresses a host-bound repository/worktree identity and one declared proof-chain entry, verifies all other semantic index entries are unchanged, and performs compare-and-swap publication under the real Git index lock. It grants no general filesystem access to Git administration directories, no ref update, commit, push, force operation or business-source staging. Inspector initiation and explicit write consent are required. Linked-worktree administration paths must be resolved and bound by the trusted host; caller-supplied physical paths cannot authorize them.

### Reference contract

`law/schemas/proof-index-reconciliation-contract.schema.json` is a closed,
source-only shape contract. It binds logical repository/worktree identity, the
single proof-chain path, before/after semantic index witnesses, exact source and
parent/base identities, selected published parent, complete custody/epoch/ancestry
manifests, phase/approval/constitution tokens, human Inspector initiation, explicit
write consent and one-entry compare-and-swap effect.

Schema validity proves shape only. A future separately approved trusted host must
resolve actual repository/worktree administration, authenticate approvals and
custody, verify all parents and ancestry, recompute source/index/epoch hashes and
prove all non-proof entries unchanged. It must publish the single proof entry
under the real Git index lock through a host-issued mutation capability. Neither
caller JSON, synthetic examples, a durable boolean nor a hash string confers one.

The catalogue companion adds only this schema name to the CLI's explicit
SOURCE_ONLY_SCHEMAS list and updates its two Inspector census fixtures. Runtime
ROSTER remains unchanged. No git-index ResourceTarget, selector, action, adapter,
policy permission, command option or runtime schema promotion is implemented.

### Separate return gates

Before binding, return the actual 1.2.0 source/version/digest and the registered
binding plan with exact current-state hashes, output bytes/digests, action/role/
consent and any state/receipt/proof/lock effects. Installed bundled content must
match the reviewed source; a checkout file is not an installed authority source.
A dry-plan with unresolved output identities is not approval to write them.

Integration needs its own exact source authorization, completed binding closure,
independent assurance and current exact-head required checks. Runtime B1-I-r2,
U1 implementation, packaging/build/release and DETRAN D1-L remain independently
held. DETRAN #211 stays unmerged, C6 blocked and S3 runtime held. No old 335-record
example, historical release or earlier Owner delegation authorizes current effects.

## Consequences

- The amendment makes canonical selection explicit without allowing a human to
  edit, splice, truncate, reorder, resequence or re-record source history.
- Durable complete displaced custody precedes publication. A distinct selection
  event is required; it is not a generic proof-epoch row or substitute for supported
  separate anchor recovery.
- Git index publication is one semantic entry under a real lock, with all other
  entries unchanged. No Git administration filesystem grant, ref mutation,
  commit/push, force operation or business-source staging follows.
- Existing source/pin parity checks correctly remain blocked until the separate
  binding decision. Historical 1.0.2→1.1.0 checks remain effective on the recovered
  exact predecessor, while new checks own the proposed successor delta.
- Source-only schema/catalogue validation can be demonstrated independently of
  runtime capability. Installed runtime admission belongs to B1-I-r2.

## Alternatives Considered

- Treating ordinary machine filesystem grants as an append-only exception is
  rejected because it silently widens Article 6.
- A generic Git filesystem/ref capability is rejected because it admits unrelated
  metadata or business staging and fails to bind the semantic index transaction.
- Promoting the reference schema into runtime ROSTER now is deferred: contract
  authoring approves no live target or consumer.
- A multi-chain/DAG history format is a different design requiring its own schemas,
  verifier and approval. It is not delivered by this bounded exception.
- Read-only custody and planning remain available while all mutation gates are held.

## Affected Rules

- law/constitution.md
- law/schemas/proof-index-reconciliation-contract.schema.json

## Inspector Adversarial Acceptance

Discharge IA-001–006 in separate Inspector assurance. Counterexamples must fail at
the real boundary they concern. Draft schema tests establish shape and source-only
census only; they must never be reported as live index/lock/custody verification.
Preserve all historical assertions and negative meanings. Missing binding remains
an explicit incomplete gate, never a skipped or weakened successor parity check.
