---
id: ADR-REL-0008
title: Bind v3 prepared state to sink handles and a complete pack specification
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 6 (path authority)
  - law/constitution.md Article 9 (authority chain)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0007-pure-sink-mediated-prepare.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/policy/action-registry.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/action-registry.schema.json
inspector_acceptance:
  - IA-001 -- A schemaVersion 2.1.0 prepared state rejects every pathname artifact and requires only opaque artifact handles plus one sink id, transaction handle, and committed-manifest handle/digest/size identity.
  - IA-002 -- A generated-output locator rejects a lifecycle-state digest or an incomplete referent. It resolves only an independently finalized release-certification-evidence-receipt-v1 by its RFC8785/JCS SHA-256 and verifies candidate commit/tree, task-policy digest, package id, and output digest before blob access.
  - IA-003 -- The v2 pack-spec canonical bytes hash to the pinned digest and completely determine entry selection/order, tar, stored-DEFLATE gzip, and SPDX 2.3 SBOM bytes. Any unsupported file, path, mode, or package-selection semantic refuses before a sink effect.
  - IA-004 -- The action-registry schema rejects a release prepare entry that adds a proc capability, removes the sink capability, or changes the exact sink adapter/bounded target set.
  - IA-005 -- The lifecycle policy schema rejects a missing or altered prepare/sink/downstream error roster, package-entry digest domain, sorting rule, or downstream committed-handle reverification rule.
---

# Bind v3 prepared state to sink handles and a complete pack specification

## Status

Accepted as a forward correction to ADR-REL-0007. ADR-REL-0007 remains the
decision that removes npm and pathname authority; this record closes the
remaining ambiguity in the persisted representation and deterministic bytes.

## Context

An opaque sink protocol is not complete if a prepared state can substitute a
pathname for the sink's returned object identity. The original forward contract
also used a generated-output locator that referenced a certification state
digest, which could be circular or mutable rather than independent evidence.
Finally, a pack-spec name and a few compression settings cannot reproduce npm-
compatible package bytes or an SBOM across implementations.

## Decision

New v3 prepared and downstream release states use schemaVersion `2.1.0`. Their
artifacts are opaque sink handles with digest and size, never paths. They carry
the exact trusted sink id, transaction handle, and single committed manifest
handle, digest, and size. Path references remain readable only as v1/v2 legacy
record forms; they cannot satisfy v3 prepare or downstream resolution.

Generated output uses an independently finalized
`release-certification-evidence-receipt-v1`, addressed by its RFC8785/JCS
SHA-256. Its referent contains the candidate commit/tree, task-policy digest,
package id, and output blob SHA-256. Prepare must load that immutable receipt,
verify all referent fields against the package-entry manifest, then retrieve and
rehash the content-addressed output blob. A lifecycle state digest is never a
locator input.

The v2 pack specification is a pinned canonical byte string and SHA-256. It
selects exactly the certified manifest entries in UTF-8 byte path order, writes
only regular `100644`/`100755` entries below `package/`, fixes every ustar field
and padding byte, and uses stored DEFLATE blocks so zlib version cannot affect
gzip output. It also fixes all SPDX 2.3 JSON fields, ordering, timestamps,
identifiers, checksums, relationships, and absent optional fields. Unsupported
selection semantics, paths, types, sizes, metadata, or encodings fail closed.

The release prepare catalog is schema-pinned to its exact non-process
capabilities, sink adapter, and bounded target kinds. The lifecycle policy
schema likewise pins all v3 prepare/sink/downstream refusal codes and the
framed package-entry manifest digest rule.

## Consequences

No consumer needs a host path to resolve release material: each downstream
action can prove it obtained the exact committed object through the injected
sink and rehash it. Generated output evidence has a separate finalized digest
domain, avoiding state self-reference. Independent pack implementations have a
complete byte-level contract, including compression and SBOM output.

This is a forward wire change. Runtime composition must emit `2.1.0` for v3;
it must retain prior versions solely for observation and never promote them to
v3 execution. Existing local records are not rewritten.

## Alternatives Considered

**Keep `path` as an optional v3 fallback.** Rejected because a fallback becomes
an unchecked second authority boundary and defeats opaque sink identity.

**Use the certification state digest for generated output.** Rejected because
the state may contain the manifest it is meant to locate and is not an
independently finalized evidence object.

**Permit normal zlib compression with fixed options.** Rejected because output
may vary by zlib version; stored DEFLATE is straightforward and byte-stable.

**Specify an SBOM format but leave timestamps or relationships to a library.**
Rejected because library defaults would make the SBOM non-reproducible.

## Affected Rules

- `law/schemas/release-lifecycle-state.schema.json` gives v3 states opaque
  artifact and committed-sink forms, plus the independent receipt referent.
- `law/policy/release-lifecycle.json` pins the full byte specification, framed
  package-manifest digest, resolver procedure, and refusal roster.
- `law/schemas/release-lifecycle-policy.schema.json` freezes every new field
  and refusal code.
- `law/schemas/action-registry.schema.json` makes the non-process prepare
  capability and adapter mapping mechanically enforceable.

## Inspector Adversarial Acceptance

The Inspector runs the five frontmatter cases and a multi-package fixture with
source plus generated output. It must mutate each opaque handle and sink
identity, receipt referent field, manifest-domain byte, tar header byte, stored
DEFLATE block, gzip trailer, and SPDX field independently. It must prove that
every mutation refuses before sink commit and that a legacy pathname record is
observable but never accepted as a v3 input.
