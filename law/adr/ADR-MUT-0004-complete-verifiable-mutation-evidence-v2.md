---
id: ADR-MUT-0004
title: Complete verifiable mutation evidence v2
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-MUT-0003
  - ADR-GOV-0004
provenance:
  - law/constitution.md Article 30 (test weakening prohibition)
  - law/constitution.md Article 39 (explicit uncertainty over false precision)
  - law/constitution.md Article 41 (evidence)
  - law/adr/ADR-MUT-0002-canonical-verifier-v2-alignment.md
  - law/adr/ADR-MUT-0003-complete-mutation-evidence-v2-contract.md
  - devai-verifier source commit fcefd0ad9b1210f5d460509f801a16fc3c4dcbd1
affected_rules:
  - law/policy/mutation-assurance-v2.json
  - law/policy/mutation-evidence-v2.json
  - law/schemas/mutation-assurance-v2.schema.json
  - law/schemas/mutation-assurance-policy-v2.schema.json
  - law/schemas/mutation-evidence-policy-v2.schema.json
  - law/schemas/mutation-report-set-v2.schema.json
inspector_acceptance:
  - IA-001 -- A score above break and scoreMin still fails when Survived exceeds survivedMax; low greater than high is rejected.
  - IA-002 -- Offline verification refuses self-asserted input populations or not-required decisions unless an exact prior semantic-verification receipt is bound by the signed artifact manifest.
  - IA-003 -- Executed has null origin, reused binds producing candidate semantic receipt and evidence set, and one inputDigest is equal across output contract package result reference composition and semantic receipt.
  - IA-004 -- An all-not-required composition emits verdict not-applicable and passed false; no empty or unmeasured population produces pass.
  - IA-005 -- The normalized Stryker report admits all eight raw statuses and rejects unknown fields versions paths and statuses.
  - IA-006 -- Cache identity is inputDigest while report and result objects are separately addressed by their byte digests; immutable evidence contains no duration or timestamp.
  - IA-007 -- Activation fails without exact canonical source and vendor commit tree path manifest digest byte-set digest and byte equality.
  - IA-008 -- Replacing any policy algorithm error roster source baseline or semantic constant makes the canonical policy fail its schema.
  - IA-009 -- Every path rejects controls newline carriage return absolute drive UNC dot dotdot backslash non-NFC aliases and final or ancestor symlink traversal.
---

# Complete verifiable mutation evidence v2

## Status

Accepted as a forward correction to ADR-MUT-0003. It also supersedes
ADR-GOV-0004 for `mutation-assurance-v2.schema.json`, closing the remaining
independent effective-head lineage without editing accepted history.

## Context

ADR-MUT-0003 selected the right architecture: one verifier-compatible v2
protocol, immutable package execution artifacts, and candidate-specific
composition. Independent inspection found nine places where its first schema
could still accept a weaker or unverifiable claim.

The threshold record retained Stryker break/high/low but omitted DEVAI's
existing `score_min` and `survived_max` authority. Offline verification was
asked to recompute populations whose member manifests were not in the bundle.
Reuse did not bind its producing receipt and evidence set. An all-not-required
roster could still look like aggregate pass. The normalized Stryker report was
not itself a strict contract. Cache identity and artifact content address were
conflated, and a variable duration was embedded in supposedly stable evidence.
Activation used booleans instead of provenance. Policy algorithm and error
arrays were replaceable with arbitrary strings. Portable-path syntax did not
exclude every control or semantic alias.

## Decision

The mutation-v2 schema remains exactly `2.1.0`; these corrections complete its
pre-activation contract and do not create another version or translation path.

Every required package applies five threshold values: Stryker `break`, `high`,
and `low`, plus DEVAI `scoreMin` and `survivedMax`. The ordering is
`0 <= low <= high <= 100`, with `break` and `scoreMin` independently inside
zero through one hundred and `survivedMax` a nonnegative safe integer. Pass
requires both `score >= max(break, scoreMin)` and
`Survived <= survivedMax`. Neither source can weaken the other.

Certify performs full semantic recomputation while the exact candidate, release
plan, release profile, policy, runner, and protected controls are available. Each
required output-contract entry embeds the complete canonical input projection
and its digest, so offline verification needs no live population provider. It
emits `mutation-semantic-verification-receipt-v2`. That receipt binds the
candidate, output-contract digest, release-plan receipt digest, release-profile
digest, policy digest, exact verifier provenance, ordered package-result-set
digest, evidence-set digest, and verdict. Its own digest is bound by the signed
artifact manifest. Offline verification validates that signed receipt and exact
artifact/result-set closure rather than pretending an opaque population digest
can reconstruct missing source bytes. Schema validation alone does not establish
semantic verification.

An executed package has null origin. A reused package carries the producing
candidate, semantic-receipt digest, and evidence-set digest. Not-required has no
origin or artifact reference. The output contract, package result, evidence
reference, composition entry, and semantic receipt carry one exactly equal
`inputDigest`. A caller-supplied
not-required reason is accepted only when the prior semantic receipt proves the
exact release plan/profile made that determination. When every package is
not-required, the only aggregate result is `not-applicable` with `passed: false`.

The canonical normalized Stryker document is a member of the strict v2 union.
It contains only portable normalized project-relative file identities, digest
of each replacement rather than replacement text, source location, mutator
name, and one of all eight raw statuses. Unknown fields, versions, statuses, or
noncanonical paths fail. CompileError and Ignored remain visible and non-scored;
Pending blocks completion; RuntimeError blocks pass.

`inputDigest` is the cache key. Each report and result is separately addressed
by its SHA-256 byte digest beneath that input-key namespace. Store entries are
write-once. Duration, timestamp, current directory, raw output, and unrelated
environment do not enter immutable evidence. Refinalization reads validated
artifacts and opens zero processes.

Activation requires a provenance object, not a flag. It binds canonical source
repository, commit, tree, and byte-set digest to the vendor root, manifest path,
manifest digest, recorded source commit/tree, and vendor byte-set digest. The
semantic activation gate requires exact commit/tree provenance and byte-set
equality before emission or verification becomes permitted.

The policy schema fixes the complete source baseline, semantic algorithm, error
roster, and every other semantic constant. The `mutation-` kind namespace is
reserved. Paths are already-NFC single-representation POSIX-relative values;
absolute, drive, UNC, control, newline, carriage-return, backslash, dot, dotdot,
duplicate-separator, and normalized-alias forms fail. Trust-store and artifact
reads reject symlinks at the final component and every ancestor, and diagnostics
never disclose native paths.

## Consequences

Threshold consolidation can only maintain or strengthen the prior requirement.
STYNX package break thresholds remain intact while DEVAI's survivor ceiling is
also enforced.

Offline verification has a precise boundary: semantic work is performed by the
canonical verifier during certify and carried in a signed digest-bound receipt.
Offline code still recomputes artifact digests, signature/trust, receipt digest,
candidate identity, provenance, composition closure, and exact result sets.

Roster drift invalidates every package because the complete roster identity is
inside every package input projection. Package-local input drift invalidates the
affected package. Composition-only repair remains zero-execution.

The policy remains frozen and emits nothing until the canonical verifier source
implements these semantics and its exact vendored byte equality is recorded.

## Alternatives Considered

**Drop survivedMax in favor of the Stryker score.** Rejected as threshold
weakening; score and survivor ceiling express different limits.

**Bundle every source byte for offline recomputation.** Rejected as unnecessary
bulk and a larger disclosure surface. A prior signed semantic-verification
receipt provides a complete explicit boundary.

**Address artifacts only by inputDigest.** Rejected because equal inputs can
still expose corrupted or substituted bytes. Cache identity and object content
address are separate invariants.

**Retain duration in the immutable result.** Rejected because duration changes
without an input change and would make the write-once object nondeterministic.

## Affected Rules

- `law/policy/mutation-evidence-v2.json` freezes the complete semantics and negative fixtures.
- `law/schemas/mutation-report-set-v2.schema.json` defines all five strict v2 document kinds.
- `law/schemas/mutation-evidence-policy-v2.schema.json` fixes policy constants and activation provenance.
- The deprecated mutation-assurance files remain read-only tombstones and grant no new authority.

## Inspector Adversarial Acceptance

Each frontmatter case must be independently executed against the schema and
semantic kernel. Acceptance also requires changed algorithm text, source
baseline, error roster, provenance field, threshold, origin, input digest,
normalized-report field, path alias, and all-not-required verdict fixtures to
fail closed. A spawn stub that throws must remain uncalled during refinalization.
