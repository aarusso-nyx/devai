---
id: ADR-REL-0015
title: Close v3 certification provenance and sink-commit ambiguity
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 3 (human-directed control)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-REL-0007-pure-sink-mediated-prepare.md
  - law/adr/ADR-REL-0013-canonical-v3-artifact-projection-vocabulary.md
affected_rules:
  - law/policy/release-lifecycle.json
  - law/policy/action-registry.json
  - law/schemas/release-lifecycle-policy.schema.json
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/action-registry.schema.json
inspector_acceptance:
  - IA-001 -- A current v3 certify request refuses before execution when the protected certification provider or its two-phase evidence sink is absent. Ambient worktree enumeration and self-issued generated-output receipts are not valid certification inputs.
  - IA-002 -- Every generated entry is closed over the provider's externally finalized receipt and opaque evidence-sink blob handle. The receipt, handle, candidate, task policy, package, digest, size, and complete per-package output population agree exactly.
  - IA-003 -- A Git source locator binds repository, commit, tree, object format, path, mode, object id, size, and content digest. Both SHA-1 and SHA-256 Git object formats verify their declared blob framing and exact candidate-tree membership; every foreign object, path, or mode refuses.
  - IA-004 -- A timeout, lost response, or other unprovable ArtifactSink commit outcome appends unknown terminal evidence, preserves transaction and handles without abort or rollback, and makes resume non-retriable until external reconciliation.
---

# Close v3 certification provenance and sink-commit ambiguity

## Status

Accepted as a forward v3 correction. It does not weaken the pure pack or
opaque-artifact vocabulary adopted by ADR-REL-0007 through ADR-REL-0013.

## Context

The initial v3 runtime shape could enumerate an ambient worktree while
constructing a certification manifest and locally form a receipt-shaped
generated-output reference. A digest-shaped reference is not proof that a
protected certification execution emitted, retained, and can later resolve
that output. The Git source locator also named only an object id, which does
not prove its candidate-tree path or mode and unnecessarily assumed SHA-1.
Finally, a two-phase sink cannot safely classify a timed-out commit as a
pre-commit failure: the atomic effect may have happened even when the caller
cannot observe its result.

## Decision

Current v3 `release certify` requires an injected
`protected-certification-provider-v3` and its injected two-phase,
content-addressed certification-evidence sink. The provider executes only the
selected immutable task policy outside candidate authority, captures declared
generated outputs, and returns complete package-entry manifests plus
externally finalized `release-certification-evidence-receipt-v1` documents and
opaque blob handles. It proves a sorted, duplicate-free per-package/output
closure. It may not scan the ambient worktree and may not self-issue a
generated-output receipt. Missing provider or sink refuses before task
execution, evidence exposure, or state append. Stock v3 composition includes
only plan, preflight, and resume; legacy certify remains read-only deprecated
compatibility data.

Each Git source locator names exact repository, commit, tree, object format,
path, mode, object id, byte size, and SHA-256 content digest. Resolver code
must first prove that exact path/mode/object is a member of the exact candidate
tree, then hash the declared Git blob framing for the declared SHA-1 or SHA-256
object format, and finally rehash raw bytes. Foreign, substituted, or
cross-tree objects refuse.

The ArtifactSink commit boundary has three outcomes. Only an outcome proved to
have failed before commit is abortable and retryable. A timeout, lost response,
or unverifiable commit outcome writes unknown/ambiguous terminal evidence,
preserves transaction and opaque handles, performs no abort or rollback, and
blocks resume and redispatch until an external reconciliation proves the
outcome. A successful commit remains subject to downstream byte and manifest
reverification.

## Consequences

Generated release material is now rooted in a protected producer and durable
evidence store rather than mutable residue. Git object identity becomes a
candidate-tree membership proof for both supported Git object formats. Sink
ambiguity is observable and fail-closed rather than being converted into a
destructive cleanup or automatic retry.

## Alternatives Considered

**Treat an untracked file plus its hash as generated evidence.** Rejected: it
does not identify a protected producer or durable immutable output.

**Allow an object id from any reachable Git object.** Rejected: it permits a
foreign object to masquerade as candidate source content.

**Abort on commit timeout.** Rejected: the commit may already be durable and
the abort could destroy the only inspectable trace.

## Affected Rules

- The lifecycle policy and schema pin provider/evidence-sink composition,
  full locator closure, and uncertain-commit handling.
- The lifecycle state schema carries the exact current locator and generated
  opaque evidence forms while preserving legacy branches for observation only.
- The action registry fixes `release certify` to the protected provider and
  certification-evidence sink, and retains `release prepare` as the separate
  pure ArtifactSink action.

## Inspector Adversarial Acceptance

- A current v3 certify invocation without its protected provider or
  certification-evidence sink refuses before it can execute a task, expose an
  output, or append state. An ambient-worktree scan and a locally created
  generated-output receipt both refuse.
- An accepted generated entry can be traced through the externally finalized
  certification receipt, opaque sink handle, candidate, task-policy digest,
  package, output closure, byte size, and SHA-256 digest; an omitted, extra,
  duplicate, or substituted member refuses.
- Fixtures cover a valid SHA-1 and a valid SHA-256 locator, while a foreign
  object, path, or mode refuses because it cannot prove exact candidate-tree
  membership before blob-frame and raw-byte rehashing.
- A sink commit timeout or lost response produces unknown terminal evidence
  without abort, rollback, retry, or redispatch; resume reports reconciliation
  as the only next requirement.
