---
id: ADR-REL-0007
title: Make release prepare pure and sink-mediated
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
  - law/adr/ADR-REL-0005-separate-legacy-seams-state-generation-and-log-sequence.md
  - law/adr/ADR-REL-0006-blocked-retry-observation-requirement.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/policy/action-registry.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-request.schema.json
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/action-registry.schema.json
inspector_acceptance:
  - IA-001 -- release certify emits one complete sorted package-entry manifest per certified package, bound to exact repository and candidate commit/tree, task-policy digest, and release-unit roster. Each source and generated entry names path, mode, byte size, SHA-256, and an immutable blob locator.
  - IA-002 -- prepare reads source entries only from the named immutable Git object, verifies the Git object ID using blob framing and verifies the raw-byte SHA-256. It reads generated entries only from their certified immutable output locator and verifies their raw-byte SHA-256. Paths, symlinks, ambient worktree reads, missing entries, extra entries, and any mismatch refuse.
  - IA-003 -- prepare creates the tar/gzip and SBOM with the frozen pure pack specification in memory; no npm, tool, shell, or ambient executable runs. Unsupported package-selection semantics refuse before a sink effect.
  - IA-004 -- without an injected trusted ArtifactSink, prepare refuses before package generation or exposure. With one, it uses exactly begin, verified opaque puts, core re-verification, one atomic complete-manifest commit, and abort on every pre-commit failure; it never invokes a pathname sink.
  - IA-005 -- export, offline verification, evidence publication, and publication re-load artifacts by opaque handle and independently recompute byte digest, size, and manifest membership before use.
---

# Make release prepare pure and sink-mediated

## Status

Accepted as a forward v3 execution contract. It preserves v1/v2 observations
and historic local-path records as read-only compatibility data, but they can
never select a v3 prepare implementation.

## Context

The older prepare shape admitted a local staging destination and delegated
package construction to npm tooling. That permits ambient executable selection,
package-file selection that is not fully evidenced at certification time, and a
pathname authority boundary that cannot establish that an external artifact is
the exact in-memory release object. A deterministic release contract needs the
full package population, not only the resulting tarball, to be certified and
bound before preparation.

## Decision

`release certify` produces a complete package-entry manifest for every release
package. The manifest is bound to exact repository and candidate commit/tree,
task-policy digest, and package roster. It covers source and generated files;
each entry carries its relative path, mode, byte count, SHA-256, and immutable
content locator.

For a Git entry, prepare reads only the named candidate-tree object and proves
its Git object identifier by hashing `blob <decimal-size>\\0<raw-bytes>` before
checking the raw-byte SHA-256. A generated entry is read only from its certified
content-addressed output blob and has the same raw-byte check. Worktree paths,
symlinks, and ambient reads are prohibited.

Prepare implements the frozen `devai.pure-npm-compatible-pack.v1` tar/gzip
format in memory. Its canonical pack-spec byte string and SHA-256 are part of
the policy. npm, any helper tool subprocess, shells, and executable PATH
selection are forbidden. A package feature outside that frozen specification
refuses before an artifact is generated or exposed.

The only exposure boundary is an injected trusted two-phase `ArtifactSink`.
It returns opaque transaction and artifact handles, verifies each object,
accepts exactly one atomic complete-manifest commit, and supports abort. A
missing sink fails before package generation or exposure. DEVAI provides no
built-in pathname sink, and a candidate repository cannot provide the trusted
sink. The core re-verifies sink-reported handles and artifact identities;
every downstream lifecycle operation must independently reread through those
opaque handles and verify bytes, digest, size, and manifest membership.

## Consequences

Prepare no longer relies on npm or a host-selected executable, nor can a caller
steer an output path. Certification becomes the authoritative package-content
boundary and generated outputs become explicit evidence rather than ambient
side effects. The sink becomes an intentionally injected, reviewable trust
boundary; its commit result is not accepted merely because it reports success.

Existing v1/v2 local staging fields and records remain readable for DEVAI 1.x
compatibility. They are deprecated and non-authoritative for v3 preparation.
The request schema rejects a caller-selected `destination` for v3 prepare;
trusted sink injection is a composition concern, not an untrusted CLI field.

## Alternatives Considered

**Keep invoking npm with a constrained executable path.** Rejected because an
external tool retains package-selection and output semantics outside the
certified input manifest.

**Write into a hardened DEVAI-controlled staging directory.** Rejected because
a pathname remains a mutable host boundary and cannot provide an opaque,
independently re-verifiable artifact identity.

**Allow a repository-local ArtifactSink.** Rejected because candidate code
would then participate in the trusted publication-material boundary.

**Trust a sink commit receipt without rereading artifacts.** Rejected because a
receipt alone does not prove byte identity to downstream evidence or publication
actions.

## Affected Rules

- `law/policy/release-lifecycle.json` freezes the v3 certification, pure-pack,
  content-verification, sink, compatibility, and downstream-reverification
  contract.
- `law/schemas/release-lifecycle-policy.schema.json` requires that exact
  contract, including the pack-spec digest and two-phase protocol.
- `law/schemas/release-lifecycle-state.schema.json` defines the package-entry
  manifest and immutable locator shapes while retaining historical read
  compatibility.
- `law/schemas/release-lifecycle-request.schema.json` rejects a prepare
  destination, so no untrusted request can choose a pathname sink.
- `law/policy/action-registry.json` and its schema expose only the explicit
  artifact-sink capability and remove process capabilities from prepare.

## Inspector Adversarial Acceptance

The Inspector must demonstrate all five frontmatter cases against a complete
multi-package candidate, including a generated output. It must mutate every
entry field, Git object framing, task-policy digest, pack-spec digest, sink
handle, response digest, and commit sequence individually. It must prove that
the missing-sink, unsupported-semantics, and abort paths execute no npm/tool/
shell process and perform no artifact exposure. A schema-valid manifest without
semantic content verification is insufficient.
