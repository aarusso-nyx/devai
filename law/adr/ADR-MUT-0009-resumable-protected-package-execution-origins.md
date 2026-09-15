---
id: ADR-MUT-0009
title: Resume protected mutation packages through exact execution origins
type: adr
status: accepted
date: 2026-09-04
authority: Architect
supersedes: []
provenance:
  - law/constitution.md Article 41 (exact immutable evidence)
  - law/adr/ADR-MUT-0003-complete-mutation-evidence-v2-contract.md
  - law/adr/ADR-MUT-0006-measured-aggregation-and-activation-closure.md
  - law/adr/ADR-MUT-0007-activate-source-pinned-mutation-v21.md
  - law/adr/ADR-MUT-0008-unit-mutation-evidence-closure.md
  - law/adr/ADR-REL-0015-close-certification-provenance-and-sink-ambiguity.md
affected_rules:
  - law/policy/mutation-evidence-v2.json
  - law/schemas/mutation-evidence-policy-v2.schema.json
  - law/schemas/mutation-report-set-v2.schema.json
  - law/policy/devai-adoption.json
  - law/schemas/release-verification-profile.schema.json
inspector_acceptance:
  - IA-001 -- A package execution receipt can be committed only by the existing certification-evidence sink after the canonical source verifier has checked one protected, complete, passing pair against its exact candidate, plan, profile, policy, template, task, environment, toolchain and whole-roster input identity. Failed, incomplete, unknown and diagnostic material never become a readable receipt or reusable origin.
  - IA-002 -- A reused v2.2 package accepts only one exact closed origin, a same-candidate MPE1 record or an existing fully resolved semantic receipt for cross-candidate reuse. It must rehash and agree field-for-field with the current v2.2 output contract, final unit receipt referent and external offline expectations. Every missing, extra, noncanonical, stale, foreign, mismatched or caller-supplied substitute refuses.
  - IA-003 -- A final mutation-required release retains exactly the ADR-MUT-0008 `2N + 2` members. The embedded reusable execution receipt is byte-bound inside the v2.2 summary, never a member, tarball entry, ArtifactSink kind, state row, separate signer operation or independent campaign pass.
  - IA-004 -- Lost-commit reconciliation reads the exact committed record once, an exact record becomes reused, an absent record requires a newly protected execution under the ordinary attempt ledger, and ambiguity stops as unknown. Unindexed bytes are never recovered or promoted, although a new independently verified transaction may use ordinary content-addressed deduplication.
  - IA-005 -- The v2.1 reader rejects every v2.2 contract, composition, summary and semantic receipt while preserving exact historical v2.1 reads. The v2.2 reader consumes byte-identical v2.1 report, package-result and input-projection pairs without translating or rewriting them.
  - IA-006 -- DEVAI retains all ten approved mutation-roster packages and their existing thresholds and test/security populations. The generic template remains capable of the STYNX 38-package roster without per-package task duplication or a change to support or mutation determination.
---

# Resume protected mutation packages through exact execution origins

## Status

Accepted forward contract. It authorizes a source-first mutation-v2.2 extension
only after the canonical verifier and its exact vendored provenance are updated.
The currently pinned v2.1 source remains authoritative until that activation
barrier is met. This ADR does not authorize a mutation run, certification,
publication, state rewrite, policy/schema change, or a new lifecycle action.

## Context

ADR-MUT-0008 correctly made the completed release-unit closure atomic: its
single external receipt can exist only after all required package pairs, summary
and semantic receipt exist. That does not make an earlier independently
completed package pair an origin that a later process may safely reuse. The
current v2.1 origin is exactly a producing candidate's _complete_ semantic
receipt and evidence-set digest; the canonical verifier resolves that origin
through a complete composition. The existing sink also exposes only committed
unit closures. Treating interrupted transaction blobs or a digest-shaped pair
as a reusable origin would therefore manufacture freshness without an
execution-proven, externally retained record.

The needed correction is intentionally narrower than another evidence system:
one protected package execution may be durably recorded through the existing
certification-evidence sink, then referenced by a later v2.2 same-campaign
composition. The final release still has only the one complete unit closure and
the existing export/offline carrier.

## Decision

### Forward source and activation boundary

The canonical `devai-verifier` gains the mutation-v2.2 source branch before
DEVAI emits, verifies, retains, prepares, exports or publishes v2.2 evidence.
It supplies the strict schema validation, package-pair semantic verifier,
execution-receipt construction/reconstruction, v2.2 origin verifier and
offline verifier. DEVAI then pins the exact approved source commit/tree and
byte-equal vendor population through a forward policy and policy-schema update,
using the existing source/vendor provenance rules. A policy boolean, local
wrapper, generated document, README or source-policy statement, source
baseline, self-consistent receipt or unapproved vendor is not activation.

Until that source-first sequence is complete, no implementation may infer this
ADR as permission to accept a package execution origin. Existing v2.1 behavior
remains fail-closed under its current source pin.

### Wire compatibility and execution receipt

The new `mutation-report-set-v2` branch is `2.2.0`. It retains exact v2.1
normalized Stryker-report, package-result and input-projection bytes as the two
immutable package artifacts. It emits a v2.2 output contract, composition
summary and semantic receipt. No v2.1 pair is translated, rewritten or
dual-written. A v2.1 reader accepts only v2.1 contract, composition/summary and
semantic-receipt documents and explicitly refuses all v2.2 documents; a pair
without a valid same-version composition is never a pass.

The sole new origin carrier is the closed canonical object
`mutation-package-execution-receipt-v1` (MPE1):

```text
schemaVersion: "1.0.0"
kind: "mutation-package-execution-receipt-v1"
receiptId: "MPE1-" + first 16 lowercase hexadecimal characters of receiptDigest
repositoryId
candidate: { releaseUnit, commit, tree }
releasePlanReceiptDigest
releaseProfileDigest
policyDigest
template: { id, version }
task: { nodeId, policyDigest }
package: { packageName, workspace, inputDigest }
report: { path, sha256, sizeBytes }
result: { path, sha256, sizeBytes }
verifierProvenance
receiptDigest
```

`receiptDigest` is the framed SHA-256 with literal ASCII domain
`devai:mutation-package-execution-receipt:v1`, one NUL octet, U64BE canonical
payload length and RFC 8785 JCS UTF-8 of the closed object with both
`receiptId` and `receiptDigest` omitted. The verifier recomputes the digest and
ID. Neither field, a sink handle, an object identity, a timestamp, a process
identifier, a host path, raw output or private material appears in that digest
payload.

MPE1 report/result paths use the current `portable_path` grammar exactly:
minimum one and maximum 512 characters; no absolute, drive, UNC, backslash,
ASCII-control, repeated-separator, dot or dot-dot segment; the current regular
path shape is additionally conjuncted with NFC equality and rejection of every
Unicode `Cc` or `Cs` character. A receipt path cannot duplicate another final
member path or name an output contract, summary or semantic receipt. It must
equal byte-for-byte the required v2.2 output-contract `reportPath` or
`resultPath`, the corresponding summary/evidence-reference path and the
same-package final unit-closure member path; its SHA-256 and byte size must
equal that member after reread.

`verifierProvenance` is exactly the existing time-free closed provenance shape:

```text
{
  source: { repository: "devai-verifier", commit, tree, byteSetDigest },
  vendor: { root, manifestPath, manifestDigest, sourceCommit, sourceTree, byteSetDigest },
  byteEquality: true
}
```

The canonical v2.2 verifier compares it by RFC 8785 JCS equality with the
runtime-recomputed, forward-policy-pinned `semanticReceiptProvenance`. Generic
self-consistency, a source baseline, a different vendor population or policy
booleans do not substitute.

The v2.2 required package contract adds exactly one execution binding:

```text
executionBinding: { templateId, templateVersion, taskNode, taskPolicyDigest }
```

At certification, the protected DEVAI host derives and rechecks it from the
genuine profile and immutable task plan, then supplies it as independently
expected data to the canonical source verifier. The canonical verifier compares
MPE1 fields individually, not by comparing differently named object shapes:
`templateId == template.id`,
`templateVersion == template.version`, `taskNode == task.nodeId`, and
`taskPolicyDigest == task.policyDigest`. The latter must also be one of the
final unit receipt referent's sorted task-policy digests.

### Existing-sink package transaction

The existing `certification-evidence-sink-v3` gains a private,
authority-guarded package-execution transaction and exact reader. This is a
control-record/index extension over the sink's existing content-addressed
objects, not a sink family, ArtifactSink kind, release action, public CLI field,
state row, signer, package/tarball member or separate evidence framework.
There is no listing, ambient discovery or caller-selected path reader.

The transaction captures an exact binding: the MPE1 non-derived identity fields
and private existing-sink identities for its report, result and receipt objects.
The receipt object identity and its control-record member are created only after
the complete MPE1 bytes exist. Those opaque identities are retained only in the
host-side control record; they never appear in MPE1, a v2.2 composition, the
portable closure or offline input.
It performs, in order:

1. authority-guarded begin and immutable `put` of canonical report, result and
   receipt bytes;
2. a read-only `verify` that rehashes those captured bytes and invokes the
   canonical source package-pair verifier and MPE1 rebuilder against the exact
   binding; and
3. authority-guarded synchronous `commit` that refuses unless the exact private
   verified snapshot exists, rereads and rehashes it, then atomically creates
   one index record.

Thus verification is outside the narrow write scope but enforced by the sink's
own verified snapshot, never a caller convention. A record is issued only for
a genuinely protected program execution whose pair is canonical, process-clean,
complete and passing and whose input identity is recomputed from the exact
candidate, plan, profile, policy, template, task, environment, toolchain and
whole roster. Failed, incomplete, unknown, diagnostic or unverified material
gets no execution receipt or reader-visible record.

Every `put` invalidates the transaction's private verification epoch. `commit`
consumes the one exact verified epoch and cannot be repeated. `abort` is
available only before commit, makes that transaction terminal and can never
promote a receipt, pair or control record. These rules apply even when the
underlying content-addressed objects remain physically retained.

The reader accepts only an exact expected binding rebuilt by the protected host,
rereads and rehashes all three objects, reconstructs MPE1 and returns a
defensive copy. An existing binding cannot be overwritten. The source host may
deduplicate an identical newly captured object by content address only after a
new independent protected execution and new verified transaction; it may not
recover, enumerate, promote or recommit an old unindexed object.

### Same-campaign reuse and reconciliation

An executed v2.2 package retains null origin. A reused package carries exactly
one closed origin alternative: (1)
`{ kind: "mutation-package-execution-origin-v1", receipt: <complete MPE1> }`
for same-campaign reuse, or (2) the existing complete semantic-receipt origin
`{ candidate, semanticReceiptDigest, evidenceSetDigest }` resolved only through
the existing protected origin resolver for cross-candidate reuse. The MPE1
route permits only the exact same repository, candidate, release unit, plan,
profile, policy, template and task; digest-only, handle-only, partial or
callback-resolved MPE forms refuse. The semantic-receipt route retains every
existing protected resolver, complete producing composition, semantic
verification, provenance, policy, input and pass check; no digest-shaped
substitute is authority. A v2.2 complete producing composition and semantic
receipt is consumed only under those exact v2.2 checks. v2.1 readers and
emitters remain unchanged and refuse v2.2 documents.

For issuance and exact-record reading, the DEVAI protected host first verifies
the current plan with `verifyResolvedReleasePlanReceipt` and a genuine
`VerifiedReleasePolicyResolution`. The canonical plan receipt includes the
exact policy-resolution object in its digest, and that verifier rebuilds the
receipt from the genuine resolution and requires canonical digest equality.
This transitively binds resolution identity. The host separately recomputes the
profile digest from that verified resolution. Equality of a caller-supplied
resolution digest is never authority.

If a package-transaction commit response is lost, reconciliation performs one
exact reader call. One exact committed record becomes `reused`; no second
commit occurs. An absent record is uncommitted and may be executed anew only
under the ordinary durable lifecycle-attempt ledger. A malformed, multiple or
unreadable result is unknown and stops reconciliation, execution and commit
retry. Pre-commit/aborted blobs remain diagnostic storage only: they cannot be
recovered as evidence or origin. A later new execution may nevertheless dedupe
identical bytes through normal content addressing after independent validation.

### Final closure and portable verification

When used, MPE1 is embedded in the v2.2 summary's reused origin. It is not an
additional unit-closure member. The final mutation-required unit continues to
contain exactly `2N + 2` members: one report/result pair per required package,
one summary and one semantic receipt. The existing external unit receipt binds
the summary bytes, and the existing signed export transcript binds the closure.

Pure canonical and offline verification never asks for a host WeakMap brand,
checkout, sink reader, candidate callback or live policy resolver. When the
origin is MPE1, it verifies the embedded receipt only against already verified
portable values:

- `repositoryId` equals the external expected repository and final unit-receipt
  referent repository;
- candidate, release unit, plan/profile/policy digests equal external expected
  values and the final unit-receipt referent;
- package, input digest, report/result path, digest and size equal the v2.2
  output-contract required row and final closure members;
- MPE1 execution fields equal the required row's `executionBinding` field-wise,
  and its task policy digest belongs to the final unit-receipt referent; and
- MPE1 provenance equals the final semantic receipt provenance and the
  current pinned canonical provenance.

The complete semantic-receipt origin is resolved only during protected
certification. Offline verification rehashes and semantically verifies the
signed current semantic receipt and portable closure; it never invokes that
resolver. It treats a missing, substituted, noncanonical or inconsistent MPE1
when present, or an inconsistent complete semantic origin, as refusal; neither
origin is by itself signed release evidence, a campaign pass, a publication
proof or an offline fallback.

### Profile scope

The generic protected mutation profile gains a forward `1.3.0` template branch
that explicitly enables this existing-sink package-execution-record behavior.
The historical/fixed-diagnostic `1.1.0` and current `1.2.0` branches remain
readable and non-promoting for this feature. This is not an authorization to
change a plan's support determination, mutation determination, task selection,
thresholds, source targets, test populations or security populations.

DEVAI's forward profile keeps its exact ten mutation packages and the existing
threshold tuple. The generic parameterized template remains available to the
STYNX profile's 38 product mutation packages, preserving that profile's
existing thresholds, selectors and task/security populations without 38 copied
permanent task definitions.

### Refusal matrix

| Condition                                                                                                                                                              | Required result                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source pair is noncanonical, process-failed, incomplete, not passing, diagnostic or its actual execution/input identity differs                                        | No MPE1/index; current source semantic refusal, including `MUTATION_INCOMPLETE`, `MUTATION_RUNTIME_FAILURE`, `MUTATION_INPUT_IDENTITY_MISSING` or `MUTATION_INPUT_DIGEST_MISMATCH` as applicable. |
| MPE1, v2.2 origin, execution binding, pair identity, provenance, final referent or portable member comparison is absent, extra, malformed, stale, foreign or divergent | Refuse reuse with `MUTATION_REUSE_DENIED` or the applicable existing strict semantic refusal before certification success.                                                                        |
| Exact reader returns one valid committed record                                                                                                                        | Reuse that immutable pair; it is not re-executed solely to recreate provenance.                                                                                                                   |
| Commit outcome is not proved and reader is absent                                                                                                                      | Treat as uncommitted; new execution only under the existing attempt ledger.                                                                                                                       |
| Reader returns ambiguity or invalid data                                                                                                                               | Unknown/reconciliation stop; no abort, rollback, commit retry or reuse.                                                                                                                           |
| v2.1 reader receives v2.2 document, or v2.2 sees a legacy pair/origin outside its explicit compatibility branch                                                        | Refuse; no downgrade, translation or generic-artifact fallthrough.                                                                                                                                |

## Consequences

The Engineer implementation path is bounded: canonical verifier first, then
source-provenance pin, private existing-sink package transaction/reader,
protected producer and host reconciliation, v2.2 finalizer/origin validation,
and existing closure continuity. The final lifecycle state, action registry,
prepared ArtifactSink vocabulary, package tarball population, signer count and
public lifecycle request remain unchanged. Only the already approved final unit
closure persists in state.

The source verifier must remain the semantic authority. DEVAI wrappers may
capture protected execution and sink custody, but cannot replace source
validation with a brand, an input digest, a task PASS, an opaque handle or a
caller-owned report.

## Alternatives Considered

**Reuse uncommitted content-addressed blobs.** Rejected: content identity proves
only bytes, not protected execution, source verification or an externally
committed origin. It would turn interruption residue into authority.

**Create a second partial-evidence store or lifecycle action.** Rejected: the
existing certification-evidence sink already provides the authority, durable
content-addressing and atomic commit boundary. Another store/action would
duplicate trust and broaden the public lifecycle.

**Add execution receipts as final closure members.** Rejected: it violates the
approved exact `2N + 2` population and capacity model. Embedding the canonical
receipt in the signed summary preserves complete portable verification without
making it an independent evidence artifact.

**Require the offline verifier to replay host resolution or read sink handles.**
Rejected: offline verification has no checkout, host store, callback or live
provider. It must compare the MPE1 fields against the already verified portable
contract, unit referent and external expectations.

## Affected Rules

- A forward canonical verifier source update introduces the v2.2 strict branch,
  MPE1, package-pair verifier and portable origin validation. DEVAI vendors and
  pins those exact source bytes before activation.
- `law/policy/mutation-evidence-v2.json`, its policy schema and the
  mutation-report-set schema gain the strict forward v2.2 branch and retain
  v2.1 reads unchanged.
- The DEVAI adoption profile and release-verification-profile schema gain only
  the v1.3 generic resume declaration; current v1.1/v1.2 bytes retain their
  historical/non-promoting behavior for this feature.
- The existing certification-evidence sink, protected producer, mutation
  finalizer and continuity readers gain private package-record operations. No
  lifecycle request/state schema, action registry, ArtifactSink kind, signer,
  tarball or public CLI surface gains a field.

## Inspector Adversarial Acceptance

Exercise IA-001 through IA-006. In addition, cover a source-verifier bypass,
receipt-digest self-reference, changed source/vendor provenance, non-NFC or
control-character path, receipt path/member mismatch, wrong execution-binding
field, task digest absent from the final referent, changed plan/profile/policy
resolution, wrong candidate or release unit, stale/foreign record, commit lost
response, unindexed blob recovery attempt, and cross-candidate MPE1 replay.
Each refuses without a final unit receipt. Demonstrate exact cross-candidate
complete-semantic-origin reuse passes only through the existing protected
resolver, while offline verification uses the signed current semantic receipt
and portable closure without that resolver. Demonstrate a newly protected
execution may deduplicate byte-identical physical objects only after new source
validation and transaction verification. Demonstrate restart after one
committed package creates a mixed v2.2 composition without re-running that
package, preserves final `2N + 2` membership, and verifies offline with no
host sink, callback, checkout or live resolver.
