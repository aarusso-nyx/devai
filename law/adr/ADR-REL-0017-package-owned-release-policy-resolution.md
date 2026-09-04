---
id: ADR-REL-0017
title: Bind release planning to installed policy and declarative adoption
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 6 (package materialization and path authority)
  - law/constitution.md Article 10 (authority separation)
  - law/constitution.md Article 41 (exact immutable evidence)
  - law/adr/ADR-REL-0002-nine-state-release-lifecycle-and-observed-publication.md
  - law/adr/ADR-REL-0015-close-certification-provenance-and-sink-ambiguity.md
  - law/adr/ADR-REL-0016-protected-preflight-execution-authority.md
affected_rules:
  - law/policy/action-registry.json
  - law/policy/release-lifecycle.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-plan-receipt-v2.schema.json
  - law/schemas/release-policy-resolution.schema.json
inspector_acceptance:
  - IA-001 -- Only the externally approved immutable installed package supplies lifecycle policy, action registry, schemas and materializer; a same-version altered archive or installed file, extra member, source-layout fallback, or adopter policy shadow refuses before use.
  - IA-002 -- The release profile must be explicitly declared in the exact candidate's adopter policy and byte-identical to its registered init materialization; missing, stale, forged, incomplete or extra binding entries, lock drift, project drift or constitution drift refuse.
  - IA-003 -- Every plan input binds its true origin and portable path; physical install locations never enter portable evidence. Equal JCS documents with different raw binding bytes do not bypass raw-byte checks.
  - IA-004 -- Plan, replay, execution, export and offline verification use the same source and binding kernel; offline evidence without the complete independently checkable closure or external expected package and candidate identity refuses.
  - IA-005 -- Historical plan v1 receipts remain byte-identical and observational under their original contract; rewriting their origin, rehashing or wrapping them never authorizes a current transition. Missing resolution evidence never produces a current passing plan.
---

# Bind release planning to installed policy and declarative adoption

## Status

Accepted as a narrow forward source-resolution contract. It changes neither the
nine actions nor their roles, effects, stages, consent, sink boundaries or trust
claim. It does not declare an unpublished package available. Historical accepted
ADRs, plan schemas and receipt bytes are preserved.

## Context

The original plan names all policy paths relative to the candidate repository.
That forces an adopter to duplicate DEVAI's lifecycle and action registry and
cannot describe a release profile generated from the adopter's own declarative
policy. Reinterpreting those paths at runtime would misstate evidence origin.
An explicit versioned contract is required, not another search-path fallback.

## Decision

### Exact origins and versions

Lifecycle policy `2.7.0` selects plan receipt `2.0.0`, plan determination kernel
`devai.kernel.release-plan-determination.v3`, verification kernel
`devai.kernel.release-plan-receipt.v3`, and resolution kernel
`devai.release-policy-resolution.v1`. The new schemas are
`release-plan-receipt-v2.schema.json` and `release-policy-resolution.schema.json`.
Receipt canonicalization remains v1: SHA-256 of RFC 8785 JCS of every receipt
member except `receipt_id` and `receipt_digest_sha256`. The complete
`policy_resolution` is therefore covered, without a self-referential digest.

The four ordered semantic inputs remain intent, profile, lifecycle and registry.
Their origins are respectively `invocation`, `generated-adopter`,
`installed-package`, `installed-package`. The intent is the supplied inline
document and has no `path` member: it is not a file-origin claim. The three
file-backed inputs require their exact paths in `required_inputs` and the
receipt. The profile's source and path are exactly
`.devai/config/release-verification.json`, relative to the exact candidate.
Lifecycle and registry source/path are exactly
`dist/law/policy/release-lifecycle.json` and
`dist/law/policy/action-registry.json`, relative to the verified installed
package root. Schema names remain logical `law/schemas/` identifiers, resolved
only to the same package's `dist/runtime/index/schemas/` bytes. Physical installation
locations are execution locators, never portable evidence. Neither candidate
`law/policy` shadows, module-relative source-layout searches nor a default
release profile may satisfy these inputs.

### Installed identity and candidate binding

Before resolving policy, the trusted external composition supplies an expected
package name, version, raw archive SHA-256 and content-manifest SHA-256. The
receipt does not select its own trusted package. Published artifacts and
explicitly approved locally installed candidate archives use the same check;
a local archive is never represented as a published registry release.

The content manifest is the lexically path-sorted complete array of
`{path, mode, size, sha256}` for all regular files in the approved package
archive, with only the archive's `package/` prefix removed. Mode is the numeric
Unix permission bits, size is the raw byte count and SHA-256 hashes raw bytes.
The content-manifest digest is SHA-256 of UTF-8 RFC 8785 JCS of that array.
There are no file exclusions. Reject duplicate, non-normalized, absolute,
escaping, linked or non-regular archive entries except structural directories;
the installed package has exactly those regular files, modes and bytes, and
only their ancestor directories. A package-manager symlink may locate the
package root; after the host resolves and binds that root, no link in the
package population or resolution read is permitted. Package-manager metadata
must remain outside that verified root. The host pins a checked immutable
snapshot for the operation: verifying a pathname and later reopening mutable
bytes is not sufficient. The archive, running implementation, schemas and
materializer must belong to that same checked package, not merely advertise
the same version. External expected identity remains mandatory offline.

`policy_resolution.installation_origin` is exactly one of
`candidate-adopter-dependency` and `external-producer-toolchain`, selected by
the trusted host's expected binding, never by untrusted candidate input. Both
routes verify the same approved installed archive and content population.

`policy_resolution` binds the raw-byte SHA-256 and portable paths of the adopter
`package.json`, complete applicable supported lockfile set, generated project
config, constitution pin, adopter policy source, existing adopter binding
receipt and complete materialized output set. Supported lock parsing is npm
or pnpm; unsupported or ambiguous resolution refuses. In the
`candidate-adopter-dependency` route, the resolver must prove that the candidate
declaration and lock resolve exactly the installed package version
and archive identity. A local archive locator is permitted only when its
verified bytes equal the externally approved archive; it grants no pathname
authority and is not a registry identity. All adopter-side files in the proof
are exact members of the candidate commit/tree, not mutable untracked residue.
Lists are path-sorted and duplicate-free; no receipt-selected subset may omit
an applicable lockfile or materialized target.

For `candidate-adopter-dependency`, the candidate's declaration and lockfiles
must resolve the approved installed DEVAI archive as specified above, and
`producer_toolchain` is forbidden. For `external-producer-toolchain`, the
candidate is the DEVAI producer repository `aarusso-nyx/devai`, releasing
`@aarusso-nyx/devai`; it is not required to invent a dependency on itself.
Its own declaration and complete lockfile set remain independently bound and
validated as candidate inputs. Instead, the required closed
`producer_toolchain` object carries a separate immutable toolchain
`package.json` and complete npm/pnpm lockfile set that resolve the installed
DEVAI archive. These paths are relative to the externally held toolchain
snapshot, not the candidate or a physical host installation. The toolchain
package manager is explicit and independent of the candidate package manager.

That branch additionally binds `producer_source` repository id/commit/tree,
the source package manifest path/raw digest and `build_provenance_sha256`.
The producer repository id is exactly `aarusso-nyx/devai`; the source package
manifest's name/version must match the installed package. The trusted host
must possess and verify an externally approved immutable build-provenance
document whose complete raw bytes hash to that digest and whose statement
binds the exact producer source, package manifest, toolchain declaration and
lock digests to the exact installed archive and content-manifest digests.
That document uses `release-policy-resolution.schema.json` definition
`producer_build_provenance`, version `1.0.0`: exactly `schemaVersion`,
`producer_source`, `installed_package` and `toolchain`. Its producer source
omits only the outer `build_provenance_sha256` to avoid self-reference; all
other identities must equal the corresponding resolution values. Its complete
raw bytes, with no digest projection or excluded members, are hashed. No
embedded approval flag or candidate signature substitutes for external approval.
Source manifest membership in the named producer tree is verified. A
candidate-authored source claim or self-consistent digest is insufficient;
the external expected identity binds this entire producer-toolchain object.
The host's producing source and release candidate are separately named and
verified, not silently asserted to be the same commit. This route is only for
the named DEVAI producer; ordinary adopters cannot select it to bypass their
dependency binding. Offline closure includes all additional toolchain and
producer source/build evidence, checked against the same external expectation.
Neither route accepts mutable ambient toolchain files or source-layout policy.

The generated project `devai_version` must equal the installed version. Its
constitution version and raw digest, the pinned constitution bytes and the
installed constitution must all agree for this release path. This stricter
release prerequisite does not change generic Doctor's historical pin reporting.

The source is the one exact policy under adopter `law/policy/` named by the
closed `adopter-policy-binding.json` v1 receipt. Verify its schema, id, version
and raw digest; require an explicit `release_verification` member. Recompute
the entire existing pure adopter materialization using the verified package
version and bound project input. Compare the exact output path set, every raw
output byte, every binding receipt digest and the generated release profile.
The materializer's project reconciliation must reproduce the bound project;
a circular self-assertion or a Doctor PASS flag is not a substitute for these
checks. The existing init binding receipt stays v1 and is not rewritten by a
release action. Only registered `init apply`/`init bind` may generate or repair
config/pins. A release read never repairs missing or stale inputs.

Each semantic input separately retains its RFC 8785 JCS SHA-256. Raw binding
digests do not replace semantic input digests or the distinct task-policy and
mutation-evidence policy digests. Changes to any bound package, source, lock,
project, pin or materialized byte invalidate the old resolution, even when
parsed JSON happens to be semantically equal.

### Replay, offline closure and refusal

One resolution contract governs planning and every dependent operation:
preflight, certify, prepare, export, offline verification, evidence publication,
product publication and resume. Current operations reverify the resolution,
all four input identities and the complete plan semantics before relying on a
plan; stored success and a schema-valid receipt are insufficient. Execution
retains the exact plan digest in the existing helper/task bindings. No stage
may switch to a repository-relative or weaker policy resolver.

Export must retain an immutable closure containing the plan, all four resolved
documents, every raw binding input and materialized output, the exact approved
package archive, and candidate-tree membership evidence for adopter-side files.
Objects may be content-addressed and deduplicated, but every required byte must
be available. Offline verification recomputes archive identity, content
manifest, schema checks, candidate membership, materialization and plan under
externally supplied expected package and repository/candidate identity. It
executes no code supplied by the bundle: the trusted verifier uses its own
matching approved implementation. It must not consult a checkout, mutable
installed alternate, network, source layout or ambient config to complete a
missing closure. This is trusted local evidence, not independent attestation.

Missing source uses `rpl-policy-source-unresolved`; package or archive divergence
uses `rpl-package-identity-mismatch`; stale/malformed adopter binding uses
`rpl-adopter-binding-mismatch`; inconsistent origin, resolution or offline
closure uses `rpl-policy-resolution-mismatch`; attempted current use of a v1
plan uses `rpl-legacy-plan-non-authoritative`. Report stable codes without
native path or secret disclosure. Existing semantic input and plan refusal
codes remain. A resolution failure yields no current passing plan, no task or
provider invocation, sink effect, success-state append or publication. A
complete valid resolution may still produce the existing deterministic blocked
plan for semantic reasons. No partial provenance is fabricated to fit a schema.

Old plan v1 receipts and their prior chains remain read-only compatibility
evidence under the original source semantics. They may be inspected but cannot
authorize any current transition or be relabelled, rehashed, upgraded or wrapped
into current authority. Replanning from freshly verified inputs creates new
evidence; it never edits old receipts or silently migrates an existing chain.
An observational historical resume must identify that it is historical and
must not infer current readiness or a current executable next step from it.

## Consequences and implementation map

Engineer implements a strict installed-package resolver, sharing the existing
pure `resolveAdopterPolicyMaterialization`, project reconciliation and
constitution-binding computations. Factor Doctor's binding validation into a
shared read-only verifier; do not call mutating init as a release prerequisite
or reuse the bootstrap resolver's source-layout fallbacks. The command planner,
local receipt resolver, plan builder/verifier and lifecycle semantic replay all
consume one verified resolution value and externally expected identity.
Export/offline adapters transport and verify the same closed evidence rather
than inventing another source interpretation. Trusted host installation must
bind the loaded implementation to the checked archive before candidate input.

Register both new schemas in the packaged schema population, keep the old
schema available for historical reads, and regenerate action views with
`node scripts/generate-action-registry.mjs`. The action census remains 57.
No source or generated edit is claimed by this law-only amendment. Adoption
requires the adopter Architect's explicit profile in its single policy and a
registered init rebind against the actual installed artifact before replanning.

## Alternatives Considered

**Copy DEVAI law into each adopter.** Rejected: it duplicates provider authority
and permits release behavior to drift from the installed implementation.

**Search installed and source paths until one exists.** Rejected: existence
does not establish the approved origin or exact package identity.

**Keep v1 and reinterpret its paths.** Rejected: it falsely relabels historical
evidence and permits backward authority from incomparable inputs.

## Affected Rules

The lifecycle policy and schema close the current resolution/kernel contract;
the new plan and resolution schemas express its exact versioned evidence. The
action registry changes only the plan payload schema pointer. Existing state,
authorization, execution and historical receipt formats are unchanged.

## Inspector Adversarial Acceptance

Test installed tarballs in distinct physical locations with identical portable
receipts, plus same-version altered packages, forged lock identity, source-tree
shadows, symlink/extra-member attacks, changed raw JSON with identical JCS,
missing explicit profiles, forged or incomplete materialization, stale pins,
old plans and incomplete offline closures. Verify identical refusals across
the planner and every replay boundary, no read mutation, no task/sink effect
on resolution refusal, and no independent-custody claim.
