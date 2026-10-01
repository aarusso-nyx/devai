---
id: ADR-MUT-0013
title: Advance the mutation-evidence approved source to the intent-export verifier
type: adr
status: proposed
date: 2026-10-01
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 41 (exact immutable evidence)
  - law/adr/ADR-MUT-0010-pin-canonical-verifier-v22-source.md
  - law/adr/ADR-REL-0031-export-reconstructs-intent-policy.md
  - canonical devai-verifier commit 8b215d706a828af7361f9c6799b9cb0a30c9d00b
affected_rules:
  - law/policy/mutation-evidence-v2.json
  - law/schemas/mutation-evidence-policy-v2.schema.json
inspector_acceptance:
  - IA-001 -- The active policy and schema bind exactly canonical verifier commit 8b215d706a828af7361f9c6799b9cb0a30c9d00b, tree 8a27adfd751da76810255f037cfbddaccf5aad4c, exact vendor provenance-manifest bytes, and the complete 26-file vendor byte set.
  - IA-002 -- Every declared vendor file equals the named source-commit file byte-for-byte; a missing, extra, substituted, symlinked, or digest-mismatched runtime file refuses before mutation emission or verification.
  - IA-003 -- The source-only regression population is exactly the nine named upstream test files and remains excluded from the runtime manifest and installed runtime population.
---

# Advance the mutation-evidence approved source to the intent-export verifier

## Status

Proposed forward provenance pin. It binds nothing until the Owner accepts it;
the policy and schema constants are repinned only after that acceptance. It
advances only the exact canonical verifier identity used by the active
mutation-evidence v2 contract; it does not change the mutation protocol, the
release action set, the evidence meaning, the signer, or any external effect.

## Context

ADR-MUT-0007 froze the canonical verifier source and requires a forward ADR,
policy, and schema update before activation can name another exact source.
ADR-MUT-0010 advanced that identity in the same form, and the active policy
pins commit `8174749ebcfabab246031281a036032f636b8a39`, tree
`e231ff55353f45bedf530a1ebd4821493328d67b`, manifest digest
`1035c8aad52f4b2beb6a6f010106a4d1866c92dadf3fbae1c6e36e1a4d2ceddf` and
byte-set digest
`670be4bbdc7cd2fae146019566f1ab341fea1f87ece90d9bd1b6b24e6bea0224`. That pin
was moved from the ADR-MUT-0010 identity by the 1.5.4 evidence fix without a
forward record of its own; this record names it as the identity it replaces
and does not ratify that step retroactively.

ADR-REL-0031 changed the canonical verifier: the exporter reconstructs the
expected task policy from a pinned release intent, and the change landed first
in the canonical source and was then re-vendored under
`packages/cli/vendor/evidence-verification` with a new `provenance.json`. The
re-vendored source is commit `8b215d706a828af7361f9c6799b9cb0a30c9d00b`, tree
`8a27adfd751da76810255f037cfbddaccf5aad4c`. Because the active policy pins
the previous manifest and byte set as constants, the runtime provenance proof
no longer matches and mutation v2.1 activation refuses with
`MUTATION_VENDOR_PROVENANCE_MISMATCH`. The Owner decided on 2026-10-01 that a
new record advances the approved source in the form ADR-MUT-0010 used.

The change between the two sources is confined to `README.md`,
`src/build-policy-cli.js`, `src/export-cli.js`, `src/export.js`,
`src/policy-builder.js`, `test/export.test.js` and
`test/policy-builder.test.js`. The mutation modules `src/mutation.js`,
`src/mutation-v21.js`, `src/mutation-v22.js` and the verifier entry
`src/verify.js` are byte-unchanged from the pinned source. The runtime
population stays 26 files and the source-only upstream test population stays
the same nine named files; the native suite grew by seventeen cases, and the
policy pins the file names, not the case count.

At the time of this proposal commit `8b215d70` is pushed on the canonical
repository branch `claude/rel-0031-intent-export` and is not yet contained in
canonical `main`. ADR-MUT-0007 cited the merged pull requests that produced
its source and ADR-MUT-0010 stated that canonical `main` contained its commit;
neither states a rule that the pinned commit must be on `main`, but both
precedents pinned a merged commit. Whether acceptance waits for the merge is
an open item for the Owner; this record does not claim a merge that has not
happened.

## Decision

`mutation-evidence-v2` remains schema version `2.1.0` and keeps its historic
source baseline unchanged. Its sole active approved source, activation proof,
and semantic receipt provenance advance to the exact canonical repository
`devai-nyx/devai-verifier`, commit
`8b215d706a828af7361f9c6799b9cb0a30c9d00b`, tree
`8a27adfd751da76810255f037cfbddaccf5aad4c`, vendor manifest digest, and
26-file byte-set digest recorded in the accompanying policy and schema
constants once the Owner accepts this record.

The vendor manifest itself remains the complete selected runtime byte set. Its
exact file bytes hash to
`302161f378e54d0a2b14b743a68577f4bfc43a147a1f17568941e08e14e767a0`; its
RFC 8785 ordered `{path,sha256}` population hashes to
`bc12045a9d6fb74298e665350c18c1a080b99f76fcfe8d4c972bf090e2ee8729`.
Each declared vendor byte is equal to the identically named file in the pinned
canonical source commit. The runtime population is exactly `provenance.json`
plus those 26 declared files. The source layout additionally permits exactly
the nine named source-only upstream tests already listed in
`activationModel.sourceOnlyTestPaths`; the installed runtime layout permits
none. The `sourceOnlyTestPaths` list, `runtimeFileCount`, every rule string,
and every other constant are unchanged.

No byte is accepted because it merely self-identifies with this source. The
existing runtime rehash, no-follow, exact population, source/tree equality and
semantic-receipt provenance checks remain mandatory before emission or
verification. The old source pin is readable historical provenance only and
cannot authorize a current mutation result.

## Consequences

Engineer implementation may call the vendored intent-export verifier for
mutation evidence only after the Owner accepts this record, the policy and
schema constants are repinned, and the runtime proof recomputes this exact
manifest and byte set. Until then the active contract keeps refusing with
`MUTATION_VENDOR_PROVENANCE_MISMATCH`, which is the correct reading of a
vendor root that no longer matches its pin. Inspector coverage must exercise
source/vendor equality, file population, the unchanged source-only test
census, and all existing refusal paths against the new identity. This decision
grants neither a mutation execution nor release readiness, and it does not
move the trusted local-RC verifier pin, which ADR-REL-0031 keeps on its own
repin rule.

## Alternatives Considered

**Retain the old pin while shipping new vendor bytes.** Rejected because an
active exact source contract would then contradict the runtime population,
and the refusal would persist for every mutation emission.

**Re-vendor the mutation modules from the old commit and the exporter from the
new one.** Rejected because the activation contract requires one approved
source and complete byte-set equality with that source, not a composed set.

**Treat the exporter files as an unpinned extension.** Rejected because the
existing activation contract requires complete byte-set equality, not a
trusted subset.

## Affected Rules

Only the active mutation-evidence policy and its exact-constant schema update
to the new canonical source provenance, and only after acceptance. Historical
ADRs and the historic source baseline remain unchanged.

## Inspector Adversarial Acceptance

Recompute the manifest and byte-set digests from a clean vendor root, compare
every declared byte against the named canonical commit, confirm the mutation
modules and verifier entry are byte-equal to the previous pin, and refuse any
commit, tree, manifest, file population, source-only census, digest, path,
symlink or semantic-receipt provenance mismatch before mutation emission or
verification.
