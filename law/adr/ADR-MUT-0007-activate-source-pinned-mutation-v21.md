---
id: ADR-MUT-0007
title: Activate the source-pinned mutation v2.1 verifier
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-MUT-0006
provenance:
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-MUT-0006-measured-aggregation-and-activation-closure.md
  - canonical devai-verifier commit 098d090013dda34e38d1045ba06274d99bd5aec1
affected_rules:
  - law/policy/mutation-evidence-v2.json
  - law/schemas/mutation-evidence-policy-v2.schema.json
inspector_acceptance:
  - IA-001 -- The active policy pins the exact approved repository, commit and tree plus source-equal vendor provenance as constants; any substituted or missing pin fails schema validation.
  - IA-002 -- Before emission or verification, the runtime recomputes the exact manifest digest, source commit, file population, each file digest and byte-set digest; a missing, extra, symlinked or changed runtime file refuses without legacy fallback.
  - IA-003 -- All 24 runtime files and seven source-only upstream tests match the approved Git source bytes; the source tests are not shipped in the runtime manifest or installed package.
  - IA-004 -- Activation grants neither publication authority nor a package-registry identity, does not select a mutation roster, and preserves every v2.1 measurement, threshold, reuse and signed-bundle closure rule.
---

# Activate the source-pinned mutation v2.1 verifier

## Status

Accepted as the forward activation required by ADR-MUT-0006 IA-004. Only the
shared policy and policy-schema subjects are superseded. The protocol remains
`2.1.0`; historical ADR bytes and the mutation report-set contract are unchanged.

## Context

The completed canonical verifier was merged through
[devai-verifier PR 8](https://github.com/devai-nyx/devai-verifier/pull/8);
canonical source hygiene was finalized through
[devai-verifier PR 9](https://github.com/devai-nyx/devai-verifier/pull/9).
The source commit is `098d090013dda34e38d1045ba06274d99bd5aec1`, whose Git tree is
`8eb8491dc43ca893399b2fc87dcfc25815c4a209`. The vendored runtime and upstream
tests now exist and have been compared byte-for-byte against that exact commit.
This supplies the concrete provenance that the inactive policy intentionally
could not represent.

## Decision

`approvedSource` is exactly repository identifier `devai-nyx/devai-verifier`, commit
`098d090013dda34e38d1045ba06274d99bd5aec1`, and tree
`8eb8491dc43ca893399b2fc87dcfc25815c4a209`. The repository identifier denotes the
canonical `https://github.com/devai-nyx/devai-verifier.git` source, not a candidate
repository or a runtime-selected source.

The semantic receipt wire protocol retains its existing repository identifier
`devai-verifier`. The activation contract permits exactly one mapping from
approved repository `devai-nyx/devai-verifier` at that canonical remote to wire
repository `devai-verifier`, with identical approved commit and tree. Other
aliases are forbidden. `provenanceProof.source` must still equal
`approvedSource` exactly; the differently shaped semantic receipt provenance
is checked through this explicit mapping, never claimed to be the same object.
No wire-protocol change or generic repository-alias mechanism is introduced.

The complete semantic receipt `verifierProvenance` must equal the exact
`activationModel.semanticReceiptProvenance` object. Its source has precisely
the wire repository identifier, approved commit and tree, and
`provenanceProof.sourceByteSetDigest`. Its vendor object equals
`provenanceProof.vendor` exactly, including every path and digest, and
`byteEquality` is true. This requirement applies both to the current receipt
and to every producing receipt resolved for reuse. A self-consistent receipt
from another verifier source, vendor manifest, or byte set is not acceptable.

The output contract's `policyDigest` is SHA-256 of RFC 8785 JCS UTF-8 bytes of
the complete canonical `law/policy/mutation-evidence-v2.json` document, with
no excluded members. It is distinct from the execution DAG's `taskPolicyDigest`.
Before emission or verification, the gate recomputes this digest and requires
the output contract, current semantic receipt and every reused producing
semantic receipt to bind that exact value. Equality among caller-supplied
digests alone is insufficient. This policy records the computation rule only;
it does not contain its own actual digest or introduce a self-referential hash.

The source vendor root is `packages/cli/vendor/evidence-verification`; the
installed copy is `dist/runtime/evidence-verification` within the published
DEVAI package. The installed path is solely a physical execution locator.
Emitted portable provenance always retains the canonical source-relative
`vendor.root` and `vendor.manifestPath` values from `provenanceProof.vendor`;
install location never rewrites the receipt identity.
`provenance.json` has exact raw-file SHA-256
`5319ef6154ca90b0851cc2b7fbce4e16919c9f4b5326a67a452e1c52ffb7027b`.
Its ordered `files` array contains exactly 24 runtime entries, each with only
`path` and `sha256`. SHA-256 over that array's RFC 8785 JCS UTF-8 bytes is
`dcb9af5f43f396e4a2a1a09fcdb181ade346575cd111dd532b78269e3fdfc34e`.
The same projection recomputed from the approved Git source has the same
digest, and every declared runtime file is byte-equal to its source referent.
The source tree recorded in the activation proof comes from the exact Git
commit; it is not an invented field in the unchanged vendor manifest.

The policy and schema pin that complete proof as constants and set the policy
active. Emission and verification permissions are conditional: before either
operation the runtime must validate the constant policy, rehash the manifest,
check its source commit, prove the exact runtime population, rehash every
runtime file, and recompute the byte-set digest against the approved source
projection. Runtime population is exactly `provenance.json` plus the 24
manifest-declared files. The source layout additionally permits only the seven
exact upstream test paths listed in `activationModel.sourceOnlyTestPaths`;
the installed layout permits no tests or additional files. No-follow covers
the vendor root, every ancestor of that root, the manifest, and every runtime
or source-test file, including all ancestor and final components. Symlinks,
nonregular files and path-identity changes refuse.
The pinned source tree and source/vendor equality are established
at integration; installed execution needs no source checkout or network fetch.
Neither a boolean nor a self-asserted `byteEqual` value substitutes for these
checks. Missing or divergent provenance refuses without falling back to the
historical `sourceBaseline` or mutation-assurance-v2 writer/kernel.

Seven byte-equal upstream tests remain source-only regression inputs and are
excluded from the runtime manifest and installed package. Canonical vendor
bytes must not be locally reformatted. The source-only exclusion does not
permit any additional runtime artifact.

All prior measurement, digest framing, pooled aggregation, input identity,
reuse-origin verification, external trust, and signed artifact closure rules
remain in force. Legacy read-only compatibility remains non-emitting and
non-promoting. No package roster or threshold is selected by this activation.

This decision pins source and vendor identity only. It neither invents a DEVAI
1.5 package tarball nor replaces the published 1.4.4 identity in
`trusted-local-rc-verifier-package.json`. Publication remains separately
authorized and requires its own exact immutable release evidence.

## Consequences

The completed v2.1 verifier can be used only through the checked, pinned runtime
copy. Source replacement requires another forward source-pinning decision;
changing provenance fields or copying unchecked bytes cannot activate another
implementation. This activation is not a claim that installed lifecycle
composition, a mutation campaign, or publication has completed.

## Alternatives Considered

**Enable an arbitrary source through runtime options.** Rejected: approved
source identity is a law-level constant, not candidate-supplied authority.

**Treat package version 1.5 as already published.** Rejected: a source integration
does not create a registry artifact or its integrity identity.

## Affected Rules

- `law/policy/mutation-evidence-v2.json`: approved source, proven vendor byte
  identity and mandatory runtime equality before either permitted operation.
- `law/schemas/mutation-evidence-policy-v2.schema.json`: exact activated
  constants; no inactive or caller-selected alternative.

## Inspector Adversarial Acceptance

Substitute the approved source, vendor root, manifest path, manifest digest,
source commit/tree, or byte-set digest and require schema rejection. Remove,
add, symlink or alter a runtime file and require refusal before emission or
verification. Preserve native upstream regressions and source-byte comparison;
do not make a formatter rewrite the canonical runtime or its tests.
