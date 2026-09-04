---
id: ADR-MUT-0008
title: Retain one protected unit mutation evidence closure
type: adr
status: accepted
date: 2026-09-04
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 41 (exact immutable evidence)
  - law/adr/ADR-MUT-0003-complete-mutation-evidence-v2-contract.md
  - law/adr/ADR-MUT-0006-measured-aggregation-and-activation-closure.md
  - law/adr/ADR-REL-0015-close-certification-provenance-and-sink-ambiguity.md
  - law/adr/ADR-REL-0012-close-offline-receipt-sink-continuity.md
affected_rules:
  - law/policy/devai-adoption.json
  - law/schemas/release-verification-profile.schema.json
  - law/schemas/release-lifecycle-state.schema.json
  - law/schemas/release-offline-verification-receipt.schema.json
inspector_acceptance:
  - IA-001 -- A mutation roster package that is not a publishable release package never appears as a package tarball, package manifest, or package evidence row solely to retain mutation evidence.
  - IA-002 -- A current required mutation composition retains exactly one canonical report and one canonical package result for every required package, and exactly one summary and one semantic receipt for the release unit. Omitted, extra, duplicate, reordered, or substituted members refuse before certification success.
  - IA-003 -- Every retained member is reread through the existing certification-evidence sink, rehashed, and checked against one externally finalized unit receipt before prepare or export can accept it. Export retains byte-identical closure/receipt/member bytes in the existing provider-result; offline verification and evidence publication rehash and verify only that portable copy. No pathname, candidate callback, ambient store, package tarball, raw runner output, original host store, or live provider is a fallback.
  - IA-004 -- A replayed, cross-candidate, cross-release-unit, cross-plan, cross-profile, cross-policy, cross-task-policy, cross-sink, or stale unit receipt refuses. The signed export transcript binds the verified closure identity and complete member projection without creating a second signer or ArtifactSink kind.
---

# Retain one protected unit mutation evidence closure

## Status

Accepted forward correction. It preserves the active mutation-v2.1 document
protocol, its score and status rules, the existing certification-evidence sink,
and the five-kind release ArtifactSink projection. Historical state and receipt
bytes remain readable unchanged; the current schema branch gains an optional,
strict unit-closure reference and current semantic rules decide when it is
required.

## Context

The DEVAI release unit is one publishable CLI package, while its approved
mutation roster contains ten internal workspace packages. A package-scoped
certification-output closure therefore cannot be used as a row for each
mutation roster package: those packages are not request package rows and
putting their reports in the CLI package manifest would put evidence into a
published tarball. Conversely, `ReleaseStateMaterial.artifacts` is the exact
five-kind prepare/export projection; adding mutation reports there would widen
the prepared ArtifactSink vocabulary and contradict ADR-REL-0012 and
ADR-REL-0021.

The existing certification-evidence sink already provides the required trusted
content-addressed write/read/rehash boundary. It needs one unit-scoped closure
in addition to its existing package-output closure, not another sink, bundle
filesystem, candidate callback, release action, or public CLI field.

## Decision

### Exact execution mapping

For the `devai.protected-mutation-stryker.v1` template, every roster row names
one immutable task node, one exact Vitest configuration path, and one exact
TypeScript configuration path. Both configuration paths must be present in the
row's bound `config_paths` population. The protected producer resolves its
effective Stryker/Vitest/TypeScript options only from those checked candidate
bytes and its host-owned template; it never imports an ambient configuration or
uses a candidate script as a runner. TypeScript `extends` and project
references are traversed no-follow into the bound configuration closure; a
missing, cyclic, symlinked or out-of-bound reference refuses rather than being
ignored or resolved from an ambient path.

The complete roster `test_selectors` population is passed to the run unchanged.
The complete selected source-and-test population remains security-relevant and
input-bound. Runner-local exclude rules, reporter file omission, and an emitted
mutant census do not subtract either population. The actual mutation target
projection remains the separately frozen `mutation_targets` rule: selected
zero-mutant files stay in the selected/instrumented census even though Stryker
does not emit them in the raw report.

Only the v1.2 template can issue a promoting production mutation closure. A
v1.1 template remains readable for the fixed diagnostic exception and
historical observation only; certify, prepare, export, offline verification and
evidence publication refuse a v1.1 template for a mutation-required plan.

### Unit-scoped existing-sink closure

`release certify` retains one
`release-unit-mutation-evidence-closure-v1` for each release unit whose
verified plan requires mutation. It is created atomically by the existing
`certification-evidence-sink-v3`, through a dedicated unit-closure transaction
that has no package tarball or prepare ArtifactSink capability. The closure is
not a package output and is never a certified-package-entry manifest member.

Its closed binding contains the exact repository, candidate commit/tree,
release unit, release-plan receipt digest, release-profile digest,
mutation-policy digest, sorted task-policy digests, sink identity, and the
canonical member projection. The sink externally finalizes exactly one
`release-unit-mutation-evidence-receipt-v1` over that binding and closure
projection. The lifecycle state stores the closed reference; it contains no
pathname or raw runner output.

The closure also retains the exact canonical `mutation-report-set-v2` output
contract and its SHA-256 as a binding control document, not as another report
or result member. `verifyMutationEvidenceV21` requires that contract to obtain
the complete expected paths, policy digest and receipt contract digest. The
unit receipt binds its exact bytes and digest, and the portable copy includes
the exact bytes. Its safe relative path is distinct from every member path and
is an index key only; its exact bytes, size, digest, sink identity and opaque
handle are the authority. A digest alone is never a substitute. The external
unit receipt digest is SHA-256 of the RFC 8785 JCS UTF-8 bytes of its complete
closed object with only `receipt_digest_sha256` omitted, matching the existing
certification receipt rule.

The member projection is UTF-8 byte sorted and duplicate-free. If `N` is the
number of required packages in the completed mutation-v2.1 composition, it
contains exactly `2N + 2` canonical members:

- one normalized Stryker report and one package result for each required
  package, with each immutable reused pair referenced unchanged;
- exactly one composed summary; and
- exactly one semantic-verification receipt.

`not-required` packages have no report/result pair and remain represented only
inside the summary and semantic receipt. Every member carries its canonical
document kind, package name when applicable, path, SHA-256, byte size and
existing certification-evidence-sink opaque handle. The receipt binds the
complete projection, so neither a caller-provided digest nor a partial member
array is authority.

`release_profile_digest` is SHA-256 of the complete resolved
release-verification profile bytes, including its full mutation roster and
thresholds. It is the direct roster pin; no caller may substitute a narrowed
row list after plan resolution. The member projection is RFC 8785 JCS over the
complete ordered array of each member's `document_kind`, `package_name`,
`path`, `sha256`, `size_bytes`, `evidence_sink_id`, and `opaque_handle` fields.
The unit receipt and signed export transcript bind that exact projection. Sink
identity/handles are exact retained-object identities in addition to each
member's content digest.

The sole `mutation-semantic-verification-receipt-v2` member is the existing
v2.1 semantic receipt over the completed report set. It is never the external
`release-unit-mutation-evidence-receipt-v1`, which finalizes the surrounding
unit closure only after all members exist. The two receipt digests are distinct
and the latter never appears as one of the `2N + 2` members.

Before returning certified state, the protected producer rereads every member
through the same sink, recomputes digest and size, validates the two
canonical mutation documents per required package, and invokes the existing
v2.1 finalizer/verifier over the complete closure. The state may carry null
only when the verified plan's mutation determination is `none`; a required,
blocked, failed, incomplete, unknown, or not-applicable composition never
becomes a substitute successful closure.

Prepare rereads, rehashes, and semantically verifies this exact
state-referenced sink closure. Export does the same before signing, then embeds
the complete canonical closure bytes—its output-contract bytes, externally
finalized unit receipt and all `2N + 2` member bytes—in the existing
post-signature `provider-result` for the release unit. The provider-result is
the portable copy; it is not another ArtifactSink kind, signer operation, or
sink family. Its closed mutation member projection must byte-equal the pre-sign
sink closure and its digest, receipt identity, and member projection digest are
bound by the existing acyclic signed transcript before the provider-result is
made.

Offline verification and evidence publication use only that exact
provider-result copy, the signed transcript, and external trust/expected
identities. They decode the closed byte carrier, rehash every embedded member,
validate the unit receipt and semantically verify the complete report set
without an original host store, live provider, tarball, checkout, candidate
path, network, or ambient store. A missing, noncanonical, partial, substituted
or host-resolved portable copy refuses.

No consumption lane may infer a successful closure from schema validity. Each
of certify, prepare, export, offline verification and evidence publication
performs the applicable exact receipt, output-contract, projection, byte, and
semantic checks before accepting a mutation-required release unit.

Existing package-output certification closures, package tarballs, prepare
three-kind commits, and export five-kind commits are unchanged. The unit
closure is a bounded sidecar of the existing certification-evidence sink and
is outside those package byte populations.

## Consequences

Engineer adds a private unit-closure transaction and reader to the existing
certification-evidence sink interface, plus a state/receipt reference and
semantic continuity checks. The host mutation producer derives the exact
per-row runner mapping, preserves every declared test/security population,
and passes only its independently established selected, instrumented and
emitted censuses to the normalizer. It writes the complete closure only after
the existing v2.1 normalizer/finalizer succeeds; an interrupted or failed
producer has no successful unit receipt.

The lifecycle kernel must reject an absent closure whenever the verified plan
requires mutation, reject a present closure when it does not, and propagate
the exact closure reference across certify, prepare, export, offline and
evidence-publish. The export transcript extension is a binding addition only;
it must remain acyclic and retain the existing one-signature rule.

The profile schema gains exact Vitest/TypeScript mapping fields for the generic
v1.2 template. DEVAI's adoption profile retains its ten rows and 60/50
thresholds; the generic template remains usable for the STYNX 38-package
profile. Mutation targets, all selected tests, and all security populations
remain unchanged.

## Alternatives Considered

**Treat every mutation roster package as a publishable package.** Rejected:
the release request has one publishable CLI package and manufacture of ten
package rows would corrupt release-unit identity and package tarball closure.

**Put mutation documents in the CLI tarball.** Rejected: mutation evidence is
not product content, and package-entry certification deliberately feeds the
prepare tarball population.

**Add mutation documents to `material.artifacts`.** Rejected: that field is
the closed five-kind ArtifactSink projection used by prepare/export/offline;
another kind would reopen the approved artifact vocabulary.

**Create a separate mutation evidence store.** Rejected: the existing
certification-evidence sink already supplies protected content-addressed
retention, opaque handles, externally finalized receipts and readers.

## Affected Rules

- The DEVAI adoption profile and its schema freeze exact per-row runner
  configuration and the unit-closure retention model.
- Lifecycle state and offline receipt schemas gain only the strict
  state-referenced unit-closure shape needed for current continuity. Historical
  bytes remain read-only and unchanged; the current branch gains the optional
  field and semantic requirement.
- Source extends the existing certification-evidence sink and lifecycle
  continuity kernel; it does not add an action, public CLI input, sink family,
  ArtifactSink kind, tarball member, signer or publication authority.

## Inspector Adversarial Acceptance

Exercise IA-001 through IA-004. Additionally, alter an exact configuration
path, remove it from `config_paths`, use a runner exclusion to reduce an
approved test/security population, omit a zero-mutant selected file from the
selected census, or compare raw zero-based instrumenter locations directly to
one-based report locations: each must refuse before evidence retention or a
certified state. Verify all ten DEVAI roster rows map to their exact package
TypeScript configuration while retaining their existing shared Vitest
configuration and unchanged thresholds.
