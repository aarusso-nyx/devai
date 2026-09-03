---
id: ADR-MUT-0003
title: Canonical package evidence and candidate composition for mutation v2
type: adr
status: accepted
date: 2026-09-03
authority: Architect
supersedes:
  - ADR-MUT-0002
  - ADR-MUT-0001
  - ADR-GOV-0005
provenance:
  - law/constitution.md Article 30 (test weakening prohibition)
  - law/constitution.md Article 39 (explicit uncertainty over false precision)
  - law/constitution.md Article 41 (evidence)
  - law/policy/mutation-strength.json
  - devai-verifier source commit fcefd0ad9b1210f5d460509f801a16fc3c4dcbd1
affected_rules:
  - law/policy/mutation-assurance-v2.json
  - law/policy/mutation-evidence-v2.json
  - law/schemas/mutation-assurance-v2.schema.json
  - law/schemas/mutation-assurance-policy-v2.schema.json
  - law/schemas/mutation-evidence-policy-v2.schema.json
  - law/schemas/mutation-report-set-v2.schema.json
inspector_acceptance:
  - IA-001 -- An immutable package result whose input digest omits or mismatches any source, test, manifest, mutation configuration, runner, roster, threshold, sanitizer, lockfile, relevant environment, toolchain, or semantic-rebind binding is rejected.
  - IA-002 -- All-executed, all-reused, and mixed compositions reproduce the same package metrics without executing a mutation process during finalization.
  - IA-003 -- Every declared package is represented exactly once as executed, reused, or not-required, and aggregate counts cannot erase any disposition.
  - IA-004 -- Pending prevents completion; RuntimeError and infrastructure failure prevent pass; CompileError and Ignored remain present in raw totals but are not scored.
  - IA-005 -- Unknown mutation namespace spellings or versions, incomplete or reordered rosters, digest mismatches, host paths, symlink escapes, credential material, and noncanonical JSON fail closed.
  - IA-006 -- A v1 result remains readable only through the v1 verifier and can never be reused, exported, published, or translated into v2 evidence.
  - IA-007 -- No mutation-assurance-v2 writer, semantic kernel, dual write, or translation path remains callable when mutation-evidence-v2 activates.
---

# Complete package evidence and candidate composition for mutation v2

## Status

Accepted as the frozen source contract. Activation remains fail-closed until the
canonical verifier implements this contract at an immutable source commit and
DEVAI pins those exact bytes.

## Context

The first DEVAI mutation-v2 design and the canonical verifier evolved into two
different protocols. ADR-MUT-0001 defined a candidate-bound assurance report,
five synthetic execution artifacts, six normalized outcomes, and a separate
semantic kernel. The verifier instead implemented the useful operational seam:
one normalized Stryker report and one package result per package, referenced by
a candidate-specific composition envelope. It preserves Stryker's eight raw
statuses and already verifies report, result, reference, roster, threshold, and
composition digests.

Running both protocols would make the same release claim mean two different
things. Translating or dual-writing would be worse: neither representation can
losslessly prove the other's semantics, and a v1 or candidate-bound report does
not contain the complete package input identity required for safe reuse.

The verifier's v2 source at the provenance commit is therefore the source seam,
but its draft `2.0.0` shape is not yet sufficient. It treats process presence as
freshness, rewrites package result bytes for reuse, has one campaign-specific
baseline comparison, omits `not-required`, and carries only an opaque input
projection digest. Those gaps must be repaired without adding another protocol.

## Decision

There is one public mutation-v2 protocol: `mutation-report-set-v2`, schema
version `2.1.0`, governed by `law/policy/mutation-evidence-v2.json` and validated
by `law/schemas/mutation-report-set-v2.schema.json`. That schema is a strict
discriminated union for the output contract, immutable package result, and
candidate composition. The old mutation-assurance-v2 policy is a non-authoritative
tombstone. Its writer and kernel are removed; it is not translated or dual-written.

Each required package execution produces exactly two authoritative immutable
artifacts: a canonical portable normalized Stryker JSON report and a canonical
package-result JSON document. The result embeds the complete input projection.
The runner stores both under one content-addressed namespace keyed by the input
digest; no candidate-specific cache is a second source of truth.
Its input digest is
`SHA-256(UTF8("devai:mutation-input:v2.1\\0") || uint64be(byteLength(JCS)) || UTF8(JCS))`,
where JCS is the RFC 8785 encoding of the projection. The
projection has exact population and selection-rule digests for source, tests,
manifests, mutation configuration, runner, package roster, thresholds,
sanitizer, lockfile, relevant environment, toolchain, and semantic-rebind input.
Any changed, absent,
or additional binding changes the input digest and denies reuse.
Environment and toolchain population members contain only canonical identity
names and digests. Raw environment values, credentials, private material, and
host paths are never input-projection fields.
The semantic verifier recomputes each population and selection-rule digest from
the exact candidate, policy, runner, and externally supplied control inputs; an
input projection never verifies itself.

Candidate composition never rewrites those artifacts. It references their
portable paths, byte digests, and input digest. A package entry declares exactly
one disposition: `executed`, `reused`, or `not-required`. For compatibility with
the verifier seam, an evidence-bearing reference also retains `provenance`, with
the exact mapping `executed` to `fresh` and `reused` to `reused`. `not-required`
has no evidence reference, is never a pass, and requires a policy-permitted typed
reason. The aggregate records each disposition count, and its evidence-set
digest binds the ordered complete package-entry array, including not-required
entries, using the same framing with domain
`devai:mutation-composition:v2.1\\0`.
The output contract binds the exact release-plan receipt and release-profile
digests. The verifier recomputes every `not-required` determination from those
verified inputs; a caller-supplied reason is never authority. If the exact
profile requires mutation for a package, that package cannot be not-required
and the aggregate cannot pass.

The finalizer is a pure function of the output contract, candidate identity,
package artifacts, and policy. It opens no subprocess and performs no network or
repository write. Repairing composition metadata therefore launches zero
mutation processes whenever the immutable package artifacts and their input
digests remain valid. Equal inputs produce equal composition bytes regardless
of wall clock, current directory, unrelated environment, or ambient host state.

Stryker statuses remain uncollapsed. `Killed` and `Timeout` are detected and
scored. `Survived` and `NoCoverage` are undetected and scored. `CompileError` and
`Ignored` are preserved in the report and totals but are non-scored; ignore rules
are covered by the mutation-configuration input binding. `Pending` means the
run is incomplete and cannot establish pass. Any `RuntimeError`, spawn error,
signal termination, or nonzero runner exit is a blocking runtime or
infrastructure failure. No new compile-error threshold is introduced.

The score uses the previously frozen binary64 operation order:
`detected = Killed + Timeout`, `scored = detected + Survived + NoCoverage`, and
`score = scored === 0 ? 100 : (detected / scored) * 100`. Counts are nonnegative
safe integers; the reported score must be SameValue with the recomputed binary64
number and must not be negative zero. Existing per-package `break`, `high`, and
`low` thresholds remain authoritative.

The verifier may continue to read v1 through its existing v1 path. v1 bytes
cannot be reused, promoted, translated, or composed as v2 because they lack the
complete v2 input digest. The verifier's unshipped v2 `2.0.0` draft is also not a
compatibility surface: new evidence emits only `2.1.0`, and every unsupported
version fails closed.

The `mutation-` kind prefix is reserved. An unknown spelling or version cannot
fall through to opaque generic-artifact handling. All artifact reads use a
normalized repository-relative path and no-follow traversal for the final path
and every ancestor. Offline verification requires external expected repository,
candidate commit/tree, task-policy digest, signer identity, trust-root identity,
trust-store digest, and key identity. It also proves exact equality between the
signed receipt result population, the bundle manifest result-digest population,
and the supplied result files. Candidate-provided defaults establish none of
those expectations.

## Consequences

Mutation execution becomes reusable without making candidate evidence mutable.
Changing only a final summary executes no mutants. Changing a package-local
lockfile, sanitizer, threshold, runner, environment contract, or other bound
input invalidates the affected package artifact. Because the complete roster
binding is intentionally present in every package input projection, roster
churn invalidates every package artifact.

The canonical verifier needs one forward source patch before activation. It
must validate the embedded input projection and digest, read immutable package
results independent of candidate disposition, admit typed not-required package
entries, bind the complete ordered package array, remove the campaign-specific
single-baseline assumption, and apply the status rules above. DEVAI must then
vendor that exact verifier commit and remove its competing assurance writer and
kernel.

Until that source commit is pinned, policy forbids v2 emission and verification.
This temporarily leaves only historical v1 read support; it prevents DEVAI from
claiming a protocol the source verifier cannot yet reproduce.

## Alternatives Considered

**Keep both v2 protocols and translate between them.** Rejected because the
translation cannot manufacture the missing complete input identity or preserve
the verifier's eight-status evidence.

**Declare the verifier's existing 2.0.0 draft final.** Rejected because it
rewrites package results to express reuse, omits not-required packages, and
cannot independently recompute the opaque input projection digest.

**Make the package result candidate-specific.** Rejected because the same
validated inputs would generate different immutable bytes on every candidate,
defeating content-addressed reuse.

**Add a CompileError ceiling.** Rejected because no approved threshold exists.
CompileError stays visible and non-scored; changing that policy requires its own
explicit decision.

**Store verbatim runner output.** Rejected because it can contain host paths or
credentials. Only canonical portable normalized report bytes and bounded process
metadata are evidence.

## Affected Rules

- `law/policy/mutation-evidence-v2.json` is the sole forward mutation policy.
- `law/schemas/mutation-report-set-v2.schema.json` is the sole forward mutation-v2 document schema.
- `law/schemas/mutation-evidence-policy-v2.schema.json` validates the policy.
- `law/policy/mutation-assurance-v2.json` is a non-authoritative tombstone.
- `law/schemas/mutation-assurance-v2.schema.json` is historical syntax only and grants no authority.
- `law/schemas/mutation-assurance-policy-v2.schema.json` validates only the tombstoned policy state.
- `law/policy/mutation-strength.json` and existing threshold values remain unchanged.

## Inspector Adversarial Acceptance

The seven frontmatter attacks must fail or pass exactly as stated. Acceptance
also requires byte-identical package artifacts across executed and reused
composition fixtures, a process-spawn sensor proving zero mutation subprocesses
during refinalization (including when the spawn stub throws), deterministic
bytes across time/current-directory/environment perturbations, and an
exact-roster bijection including not-required packages. Schema validation alone
never establishes a mutation pass.
