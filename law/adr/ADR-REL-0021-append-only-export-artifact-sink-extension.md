---
id: ADR-REL-0021
title: Add an append-only protected export ArtifactSink extension
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (path-bound authority)
  - law/constitution.md Article 41 (exact immutable evidence)
  - law/adr/ADR-REL-0012-close-offline-receipt-sink-continuity.md
  - law/adr/ADR-REL-0018-bounded-ustar-prefix-prepare.md
  - law/adr/ADR-REL-0019-preserve-and-restate-installed-release-policy.md
affected_rules:
  - law/policy/action-registry.json
  - law/schemas/action-registry.schema.json
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
inspector_acceptance:
  - IA-001 -- Export accepts only an exact prepared parent commit and its complete three-kind opaque closure, preserves every parent handle unchanged, and atomically commits one exact final five-kind closure under one new export commit identity.
  - IA-002 -- The export extension binds its protected sink and signer to the exact action, repository, candidate, plan digest, parent commit, sink, destination and trust; a mismatched, cross-sink, missing, duplicate, noncanonical or ambient member refuses before begin or signing.
  - IA-003 -- A 38-package export requires exactly 110 remaining batches and targets under the existing 128-batch export planner; one fewer refuses before a sink or signer effect, and no generic bound increase or per-package signer is introduced.
  - IA-004 -- Export uses exactly one protected aggregate signature and the dedicated export closure specification, never relabels evidence as pack v4, never broadens prepare, and preserves unknown signing/commit evidence without abort, rollback, retry or redispatch.
---

# Add an append-only protected export ArtifactSink extension

## Status

Accepted as a narrow forward export implementation contract. It adds no action,
state, receipt, publication grant or prepare capability. Accepted ADRs and all
prepared artifacts remain byte-identical.

## Context

Current prepare commits exactly the package-manifest, package-tarball and
package-SBOM handles in one terminal transaction. Export must retain those
opaque identities while adding an evidence manifest and provider result for
every package. Reopening or appending the prepared transaction is unsafe, and
copying the bytes into new handles would violate material continuity.

ADR-REL-0012 instead requires a current exported state and offline receipt to
name one exact final committed-manifest identity with a complete opaque
closure. The lifecycle state and receipt formats already represent that final
identity and all five kinds; they do not need another carrier or a second
evidence framework.

## Decision

`release export` receives exactly two protected host boundaries:
`trusted-export-artifact-sink-v1` and `protected-export-signer-v1`. Neither is
available to prepare, certification, publication, a candidate, or an ambient
host fallback. The extension binding is closed over action id, repository
id/commit/tree, candidate commit/tree, plan receipt digest, exact prepared
parent ArtifactSink commit, sink id, destination kind/exact identifier, and
trust root id/trust-store digest/key id/signature algorithm. Candidate code
cannot select a root, key, signer, implementation or storage path.

Before any begin or signing effect, the trusted host replays the exact
ADR-REL-0019 installed-policy resolution and retains its complete portable
closure. It verifies the exact prepared predecessor manifest through the
trusted reader, including all parent bytes, sizes, digests, same sink id,
sorted duplicate-free membership and exactly one package-manifest,
package-tarball and package-SBOM per package. It also verifies the destination,
trust, binding, canonical export-spec bytes and live capacity. Any failure has
no sink or signing effect.

The dedicated `devai.release-export-closure.v1` specification has canonical
UTF-8 bytes whose SHA-256 is
`fef218440e83dc380fff31ba7bae128f7d1912e41e9cb3e1a8148fd1b9281023`.
It retains the parent handles unchanged, adds exactly one evidence-manifest and
one provider-result per package, and requires one sorted, duplicate-free,
complete five-kind final projection. Evidence and provider-result bytes are
governed by this export specification, never by
`devai.pure-npm-compatible-pack.v4`; the latter remains the prepare-only
package-byte contract.

After preflight, the host begins one dedicated append-only extension
transaction. It performs exactly one externally protected aggregate detached
signature over the canonical pre-commit closure. The signature value is
excluded only from its own signing preimage, and the resulting signature and
trust are bound into every provider result. This is one signer operation for
the complete roster, not a signer operation per package. The final extension
manifest carries the exact parent ArtifactSink commit identity, so downstream
revalidation can prove the anchor without a state or receipt wire change. The
host re-verifies every returned new handle and commits exactly one final
canonical manifest atomically. The exported state carries that new commit
identity; its aggregate contains the retained parent identities plus the new
evidence/provider identities. The reader may resolve only the exact parent or
extension handles through the protected host and refuses every other handle or
member.

The export capacity formula is `2 * package_count + 34` independently for
batches and targets: begin (1), two new objects per package (2N), one protected
aggregate signature (1), commit-manifest put (1), commit (1), pre-commit abort
reserve (1), and the established 29 state-completion reserve. At 38 packages
this is 110, within the existing export ceiling of 128. The host uses a
read-only live invocation-bound account and verifies the complete roster
immediately before begin or signer dispatch. It has no numeric request,
candidate or stale-observation fallback. The existing 128 limit is retained;
there is no inferred or infinite allowance.

Abort is allowed only on a proven pre-commit failure. Once signing or commit
may be ambiguous, the host preserves the transaction and handles, appends
unknown terminal evidence, and never aborts, rolls back, retries or
redispatches. Offline verification and evidence publication continue to use
the final exact opaque closure and committed identity required by ADR-REL-0012.

## Consequences

Engineer implements a dedicated export store/provider, signer adapter and
composite trusted reader. It leaves `createReleaseArtifactStore` and the
prepare-only adapter behavior unchanged. The export reader verifies the parent
and extension transactions without a pathname, candidate-supplied source,
network, source-layout or ambient-installed fallback. It uses the existing
state and offline-receipt forms; no second manifest or receipt schema is added.

The action catalog remains at 57 actions. Regenerate its derived views with
`node scripts/generate-action-registry.mjs` after implementing the host
boundary. No source, generated artifact, remote effect, publication or
preparation is performed by this law amendment.

## Alternatives Considered

**Append to the prepared transaction.** Rejected because prepare commits a
terminal complete transaction; reopening it loses atomicity and auditability.

**Copy prepared bytes into an export transaction.** Rejected because it changes
opaque parent identities and violates continuity.

**Mark export evidence as pack v4.** Rejected because pack v4 specifies only
package manifest, tarball and SBOM bytes, not external provider evidence.

**Sign each package separately.** Rejected because it creates 38 protected
signing operations and needs 147 reserved batches, exceeding the existing
128-batch export plan without a demonstrated need.

## Affected Rules

The action registry and its schema add only the two named export boundaries and
their exact existing bounded planner. The lifecycle policy and its schema pin
the export closure specification, binding, preflight, capacity, signing,
extension and recovery rules. State and receipt schemas remain unchanged
because their one exact final commit identity and five-kind projection already
express the result.

## Inspector Adversarial Acceptance

Substitute any parent commit field, parent handle, sink id, repository,
candidate, plan digest, destination, trust field, export-spec byte/digest,
signature input, member order, duplicate, extra member, cross-sink handle or
new-object digest. Verify refusal before begin/signing. Exercise one-less than
110 capacity and exactly 110 capacity for 38 packages. Verify parent handles
remain byte-identical, exactly one aggregate signing operation occurs, the
final manifest has three retained and two new kinds per package, and unknown
signing/commit outcomes preserve evidence with no abort, rollback, retry,
redispatch, publication or state success.
