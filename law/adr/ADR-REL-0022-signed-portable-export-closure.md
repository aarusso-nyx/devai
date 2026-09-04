---
id: ADR-REL-0022
title: Bind portable export closure and acyclic aggregate signature
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-REL-0021
provenance:
  - law/constitution.md Article 41 (exact immutable evidence)
  - law/adr/ADR-REL-0019-preserve-and-restate-installed-release-policy.md
  - law/adr/ADR-REL-0021-append-only-export-artifact-sink-extension.md
  - packages/cli/src/services/release-policy-closure.ts
  - packages/cli/src/services/release-policy-closure-transport.ts
affected_rules:
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- Each exported evidence-manifest decodes only as canonical devai.release-policy-closure-json.v1 and verifies the exact plan, archive, candidate proof and, where applicable, producer evidence using the externally expected installed package and checked implementation; any ambient path, install, checkout or network dereference refuses.
  - IA-002 -- The sole signature covers a canonical acyclic transcript containing the prepared parent identities, every closure digest, the expected installed-package identity, each recomputed policy-resolution digest, destination, trust and existing attempt id. Altering any member refuses; provider-result signature bytes and the final manifest never enter that signature preimage.
  - IA-003 -- Each package retains a distinct current opaque evidence-manifest identity, even when the trusted same sink deduplicates byte-identical closure storage. Offline verification rehashes every identity before any SHA-256-and-size keyed cache use.
  - IA-004 -- The final five-kind commit remains append-only and parent-continuous. A provider-result must bind the signed transcript digest, its detached signature, trust and its evidence-manifest digest; tampering with it or the final manifest refuses without a second signing action.
---

# Bind portable export closure and acyclic aggregate signature

## Status

Proposed forward correction. It does not edit ADR-REL-0021, prepared handles,
state records or receipt formats. It is not executable authority unless accepted
after the required adversarial review.

## Context

ADR-REL-0021 correctly preserves the prepared three-kind ArtifactSink commit,
adds the two existing export kinds, and binds a single protected signer. Its
closed five-kind projection, however, does not itself say which exact bytes an
`evidence-manifest` carries or place the installed-policy resolution identity in
the signer preimage. A digest reference without retained bytes would force an
offline verifier to consult a checkout, installation or network, contrary to
ADR-REL-0019.

The existing package already has the necessary portable carrier:
`createReleasePolicyClosure`, `encodeReleasePolicyClosure`,
`decodeReleasePolicyClosure` and `verifyReleasePolicyClosure`. Its wire format
is the closed, canonical UTF-8 `devai.release-policy-closure-json.v1`; it
contains the exact plan, approved archive, candidate Git objects and, for the
producer route, toolchain files, producer Git objects and build provenance.
The verifier reconstructs policy only from these bytes, the externally supplied
expected identity and the already checked matching implementation.

The final provider results cannot be in the signature preimage: they contain
the detached signature that the signer produces. Including them or a final
manifest that hashes them would form a cycle rather than evidence coverage.

## Decision

### Exact evidence-manifest carrier

For each package, the existing `evidence-manifest` ArtifactSink object is the
exact UTF-8 bytes produced by `encodeReleasePolicyClosure` in format
`devai.release-policy-closure-json.v1`, under the bounded transport limits
selected by the protected host. It is not a pathname, a package coordinate, a
recipe, executable code or a new evidence kind.

The host creates this closure only from a fresh genuine ADR-REL-0019 resolution
and plan. Before begin and offline it decodes it canonically and calls
`verifyReleasePolicyClosure` with the existing external
`ReleasePolicyExpectedIdentity.installed_package` and the same checked runtime
implementation. That existing external identity already contains the required
name, version, archive SHA-256 and content-manifest SHA-256; this record adds
no fourth identity contract. A closure is invalid if it needs a checkout,
source layout, mutable installation, environment locator or network fetch.

The current state projection requires a distinct
`(kind, sink_id, opaque_handle)` identity for every package. Therefore this
record does not introduce shared opaque handles. When multiple exact closure
byte sequences are equal, the trusted same sink may deduplicate its private
content storage, and the trusted reader may cache only after resolving and
rehashing each distinct recorded opaque identity and finding equal SHA-256 and
size. Such deduplication never changes a recorded handle, byte, digest, size,
package projection, capacity count or offline input and never crosses sinks.

### One acyclic signed transcript

Before any provider-result is created, the protected signer receives exactly
one canonical UTF-8 JCS object with format
`devai.release-export-transcript-json.v1`. Its closed members are:

- `binding`: action, repository id/commit/tree, candidate commit/tree, plan
  receipt digest, exact parent prepared sink commit, sink id, destination kind
  and exact identifier, trust root/store digest/key/algorithm, and the existing
  lifecycle attempt id;
- `parent`: the lexically sorted complete three-kind opaque parent identities;
- `closures`: lexically sorted package entries, each containing package id, its
  evidence-manifest opaque identity and digest/size, the complete expected
  installed-package identity, and SHA-256 of the JCS policy-resolution object
  recomputed from that decoded closure;
- `destination` and `trust`, duplicated from `binding` only as the exact
  signer-facing protected values; and
- `version`: the transcript format version.

The signer refuses any duplicate, noncanonical, incomplete or unequal member.
The signed transcript binds every retained parent identity, every portable
closure byte through its manifest digest, the expected installed package and
the exact resolved policy identity, destination, trust and attempt. It is the
only aggregate detached-signature preimage.

Each post-signature `provider-result` is canonical UTF-8 and binds its package
id, its evidence-manifest identity/digest, the transcript SHA-256, the
detached signature value and the exact trust identity. It is then rehashed and
committed in the existing final five-kind manifest. Provider-result bytes,
their hashes and the final manifest are not transcript members; final
continuity verifies them after signature verification. This is deliberately
acyclic and does not add a second signer operation.

### Offline continuity and recovery

Offline verification obtains only the exact final ArtifactSink commit through
the trusted reader, verifies its parent identity and complete five-kind
projection, rehashes each opaque artifact, validates every provider-result
against the signed transcript and trust, and reconstructs each policy closure
from its evidence-manifest with the existing external expected identity and
checked implementation. It never obtains missing bytes from an ambient source.

The existing post-sign/commit ambiguity rule remains unchanged: preserve the
transaction and handles, append unknown terminal evidence and never abort,
roll back, retry or redispatch. This record creates no recovery writer or
alternate signer path.

## Consequences

The export extension specification advances to
`devai.release-export-closure.v2`. Its existing two output kinds and 38-package
capacity calculation remain unchanged: two new opaque identities per package,
one aggregate signature and the existing `2 * package_count + 34` bound.

Engineer implementation must use the existing closure transport and verifier
for evidence-manifest bytes, construct the stated transcript before signing,
and verify provider-result/final-manifest continuity afterwards. It must not
create a generic bundle interpreter, additional evidence kind, shared opaque
handle, ambient fallback or a second signature. Inspector must demonstrate the
four acceptance attacks above before any execution claim.

## Alternatives Considered

**Put the final provider-result or final manifest in the signature preimage.**
Rejected because the provider-result contains the signature and the manifest
hashes it, creating a self-reference rather than a verifiable transcript.

**Embed a full copy of the closure in a new artifact kind.** Rejected because
the current evidence-manifest and its established codec already carry the
required bytes; a sixth kind would duplicate authority and capacity.

**Share one opaque evidence-manifest handle across packages.** Rejected because
the current sorted duplicate-free state/offline projection rejects duplicate
kind/sink/handle identities. Private same-sink content dedup retains both
storage efficiency and the existing public identity contract.

**Extend the external expected-identity tuple.** Rejected because ADR-REL-0019
and `ReleasePolicyExpectedIdentity` already require the exact installed package
name, version, archive SHA-256 and content-manifest SHA-256.

## Affected Rules

- `law/policy/release-lifecycle.json` advances only the export closure
  specification and its signed binding description.
- `law/schemas/release-lifecycle-policy.schema.json` pins that exact forward
  policy shape and canonical specification bytes.

No accepted ADR body, action registry, state schema, receipt schema, capacity
bound or external expected-identity shape changes.

## Inspector Adversarial Acceptance

Run every `inspector_acceptance` frontmatter case. Also prove that changing
only the installed archive/content-manifest identity, only the decoded
policy-resolution JCS digest, only a parent opaque identity, only an
evidence-manifest byte, only a provider-result transcript digest, or only a
final provider-result handle fails before an export success result. A
byte-identical same-sink dedup case must retain distinct opaque identities and
be readable offline without any second closure copy or ambient lookup.
