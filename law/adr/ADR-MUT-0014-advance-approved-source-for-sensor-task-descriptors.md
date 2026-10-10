---
id: ADR-MUT-0014
title: Advance the approved verifier source for exact sensor task descriptors
type: adr
status: accepted
date: 2026-10-10
authority: Architect
supersedes:
  - ADR-MUT-0013
provenance:
  - ADR-MUT-0007
  - ADR-MUT-0013
  - ADR-REL-0031
  - ADR-SCR-0015
  - canonical devai-verifier pull request 13
affected_rules:
  - law/policy/mutation-evidence-v2.json
  - law/schemas/mutation-evidence-policy-v2.schema.json
inspector_acceptance:
  - IA-001 -- The active policy, schema and semantic receipt provenance bind canonical commit ad790aea6f200412da79a3a1bfbaa03cbdb47a2d, tree d7a7695691cbc02013a35404531b5c522ad1476e, the exact vendor manifest and its complete 26-file runtime byte set.
  - IA-002 -- Every vendor runtime file and all nine source-only upstream test files equal the merged canonical source bytes. Missing, extra, substituted, symlinked or digest-mismatched runtime files remain refused.
  - IA-003 -- The source baseline and the published trusted local-RC verifier package pin remain unchanged; annotation changes alter the full descriptor digest and task keys rather than being stripped before verification.
---

# Approved source for exact sensor task descriptors

## Status

Accepted on 2026-10-10 under the Owner-authorized DEVAI 2.4.0 compatibility
implementation, reviewed upstream integration and exact vendoring. Canonical
pull request 13 merged the reviewed source before this forward pin. This record
advances the active source identity only; it adds no mutation execution or
release authority.

## Context

ADR-SCR-0015 admits an optional, closed `sensorKinds` annotation on reviewed task
nodes. The immutable verifier's descriptor schema and separate exact-key
validator rejected that annotation. Removing it before verification would
discard part of the reviewed descriptor identity. The canonical verifier was
therefore changed and tested first, then vendored from the merged source under
ADR-REL-0031.

ADR-MUT-0013 pins the complete vendor population to source commit
`8b215d706a828af7361f9c6799b9cb0a30c9d00b`, tree
`8a27adfd751da76810255f037cfbddaccf5aad4c`, manifest digest
`302161f378e54d0a2b14b743a68577f4bfc43a147a1f17568941e08e14e767a0`
and byte-set digest
`bc12045a9d6fb74298e665350c18c1a080b99f76fcfe8d4c972bf090e2ee8729`.
The active exact source must advance with the vendor bytes, even though the
mutation modules themselves did not change.

## Decision

The sole active approved source and its activation and semantic receipt
provenance advance to repository `devai-nyx/devai-verifier`, commit
`ad790aea6f200412da79a3a1bfbaa03cbdb47a2d`, tree
`d7a7695691cbc02013a35404531b5c522ad1476e`. That tree equals the reviewed
candidate's tree. The exact provenance manifest SHA-256 is
`fc79da07d4d4dfa466548337a4944ae1b7e0bfdcf2f1c334b341bb1ad477cd4d`;
the RFC 8785 manifest-order `{path,sha256}` runtime population digest is
`9fabc74bec014c4d8690984194d6ca5871490ed6ae1c244c90e17ba854ed482f`.

Only `schemas/task-descriptor.schema.json`, `src/policy-builder.js` and
`test/policy-builder.test.js` changed from the previous approved source.
Annotation admission remains closed, requires the exact reviewed population
and supported executable output contract, and preserves the full descriptor
digest in every task key. Unknown keys, invalid kinds, duplicate annotations,
probe-only tasks and protected output-census annotations remain refused. No
annotation is stripped or ignored to make a receipt verify.

The runtime population remains exactly 26 declared files plus
`provenance.json`. All nine named upstream test files remain source-only and
excluded from the installed runtime. The historical `sourceBaseline`, protocol
version, mutation modules, verifier entry, thresholds, no-follow rules, complete
population checks and runtime digest/equality checks remain unchanged. Historical
evidence is not rewritten. An earlier source identity remains historical
provenance and does not authorize the current active source.

The trusted local-RC verifier package remains `@aarusso-nyx/devai@1.9.0` with
its existing package, provenance and source pins. It verifies the release
candidate, whose own descriptor does not adopt `sensorKinds`. Only after this
new vendor population ships in a verified published release may a separate
complete repin follow the existing one-published-release lag. Adopters must
likewise use a published compatible verifier before annotated descriptors can
establish their RC evidence; no fallback to the candidate verifier is inferred.

## Consequences

The active source policy agrees with the exact vendored bytes without weakening
independent reconstruction. Any runtime population or source-provenance
divergence still fails closed. The canonical descriptor now admits the opt-in
sensor annotations, while existing unannotated descriptors retain their prior
identity and behavior.

## Alternatives Considered

Editing only the vendor copy would violate canonical source provenance.
Stripping annotations would erase reviewed input from identity. Keeping the old
active source constants with new bytes would fail the mandatory runtime proof.
Repinning the trusted verifier before publication would violate its immutable
package trust and one-release lag. Each alternative is rejected.

## Affected Rules

The active source, activation proof and semantic receipt constants in
`law/policy/mutation-evidence-v2.json` and
`law/schemas/mutation-evidence-policy-v2.schema.json` advance together. The
trusted local-RC verifier package policy and historical source baseline retain
their existing bytes and authority.

## Inspector Adversarial Acceptance

Verify IA-001 through IA-003 against the merged canonical source and complete
vendored population. Retain every existing runtime refusal and historical
evidence fixture. Independently verify annotation-sensitive descriptor/task
digests, invalid and unknown-key refusals, and exact source/vendor byte equality.
