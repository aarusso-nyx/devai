---
id: ADR-MUT-0010
title: Pin canonical verifier v2.2 source provenance
type: adr
status: accepted
date: 2026-09-04
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 41 (exact immutable evidence)
  - law/adr/ADR-MUT-0007-activate-source-pinned-mutation-v21.md
  - canonical devai-verifier commit 9f849f117fe1e460b5e3c647515f5ccbe783cbfb
affected_rules:
  - law/policy/mutation-evidence-v2.json
  - law/schemas/mutation-evidence-policy-v2.schema.json
inspector_acceptance:
  - IA-001 -- The active policy and schema bind exactly canonical verifier commit 9f849f117fe1e460b5e3c647515f5ccbe783cbfb, tree ad825591bd32fb39d1a045c492660acf90f78c38, exact vendor provenance-manifest bytes, and the complete 26-file vendor byte set.
  - IA-002 -- Every declared vendor file equals the named source-commit file byte-for-byte; a missing, extra, substituted, symlinked, or digest-mismatched runtime file refuses before mutation emission or verification.
  - IA-003 -- The source-only regression population is exactly nine named upstream test files and remains excluded from the runtime manifest and installed runtime population.
---

# Pin canonical verifier v2.2 source provenance

## Status

Accepted forward provenance pin. It advances only the exact canonical verifier
identity used by the active mutation-evidence v2 contract; it does not change
the mutation protocol, release action set, evidence meaning, signer, or any
external effect.

## Context

ADR-MUT-0007 froze the preceding canonical verifier source and requires a
forward ADR, policy, and schema update before activation can name another exact
source. Canonical verifier main now contains commit
`9f849f117fe1e460b5e3c647515f5ccbe783cbfb`, tree
`ad825591bd32fb39d1a045c492660acf90f78c38`. DEVAI has mechanically vendored
its selected runtime files under the existing vendor root. The new source adds
the v2.2 mutation verifier and detached-trust support, so the previous
provenance manifest, byte-set digest, runtime population, and source-only test
census are no longer exact.

## Decision

`mutation-evidence-v2` remains schema version `2.1.0` and keeps its historic
source baseline unchanged. Its sole active approved source, activation proof,
and semantic receipt provenance advance to the exact canonical repository,
commit, tree, vendor manifest digest, and 26-file byte-set digest recorded in
the accompanying policy and schema constants.

The vendor manifest itself remains the complete selected runtime byte set. Its
exact file bytes hash to
`f61cccd8a0c0c5e7020cc6055f254c1a5ab56388fc9fc220ea76b1f9dc9a196c`; its
RFC 8785 ordered `{path,sha256}` population hashes to
`9ce3f981f51fb4fa5f628cd5d2249bf8146aa44017b06603b797589ebe6505d4`.
Each declared vendor byte is equal to the identically named file in the pinned
canonical source commit. The runtime population is exactly provenance.json plus
those 26 declared files. The source layout additionally permits exactly nine
named source-only upstream tests; installed runtime layout permits none.

No byte is accepted because it merely self-identifies with this source. The
existing runtime rehash, no-follow, exact population, source/tree equality and
semantic-receipt provenance checks remain mandatory before emission or
verification. The old source pin is readable historical provenance only and
cannot authorize a current mutation result.

## Consequences

Engineer implementation may call the merged canonical v2.2 verifier only after
the runtime proof recomputes this exact manifest and byte set. Inspector
coverage must exercise source/vendor equality, file population, new source-only
test census, and all existing refusal paths. This decision grants neither a
mutation execution nor release readiness.

## Alternatives Considered

**Retain the old pin while shipping new vendor bytes.** Rejected because an
active exact source contract would then contradict the runtime population.

**Treat the new files as an unpinned extension.** Rejected because the existing
activation contract requires complete byte-set equality, not a trusted subset.

## Affected Rules

Only the active mutation-evidence policy and its exact-constant schema update
to the merged canonical source provenance. Historical ADRs and the historic
source baseline remain unchanged.

## Inspector Adversarial Acceptance

Recompute the manifest and byte-set digests from a clean vendor root, compare
every declared byte against the named canonical commit, and refuse any commit,
tree, manifest, file population, source-only census, digest, path, symlink or
semantic-receipt provenance mismatch before mutation emission or verification.
