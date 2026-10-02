---
id: ADR-EVI-0005
title: Evidence record exposes bounded newest-line crash recovery
type: adr
status: accepted
date: 2026-10-01
authority: Architect
supersedes:
  - ADR-EVI-0002
provenance:
  - ADR-EVI-0002
  - docs/dev/operations/open-issue-closure-campaign/decision-register.md
  - product/campaigns/CMP-0006-open-issue-closure/issue-snapshot.json
affected_rules:
  - packages/evidence/src/evidence/chain.ts
  - packages/evidence/src/evidence/proof-epoch.ts
  - packages/evidence/src/evidence/verb-evidence.ts
  - packages/cli/src/commands/evidence/facade.ts
  - packages/cli/src/commands/evidence/facade-collect-record.ts
  - law/schemas/proof-anchor-baseline.schema.json
  - record/proofs/anchor-baseline.json
inspector_acceptance:
  - IA-001 -- The DETRAN baseline fixture of 119 lines, 67 anchored and 52 orphaned, fails evidence verify --scope chain before its historical declaration with every orphan listed, and passes after it with the declaration itself directly anchored.
  - IA-002 -- Changing one byte of an anchored historical line, or of the baseline file, makes verification fail naming the line; the sequence, link, hash, and head checks of the cryptographic chain are unchanged and still fail on their own defects.
  - IA-003 -- A historical declaration that names a line recorded after the cutoff, that lacks the Architect authorization, that omits a line digest, or that is itself unanchored is rejected, and the orphans it names stay reported.
  - IA-004 -- A newest proof line with no chain entry after a simulated crash between the two writes is reported as unanchored with the remediation of appending its entry, and a new anchor whose digest differs from the line bytes fails.
  - IA-005 -- An anchor whose canonical path contains a backslash, a dot segment, or a sequence outside the epoch's namespace, or whose line ends without a newline, resolves to no line and fails rather than matching loosely.
  - IA-006 -- After a simulated proof-write crash the CLI appends exactly one missing newest-line anchor; the physical JSONL, baseline, earlier chain entries and all historical bytes remain identical, and a retry creates no duplicate.
  - IA-007 -- An older line, changed digest, symlink, path escape, non-newline tail, already ambiguous anchor or missing write consent is refused before mutation; recovery is never a historical-gap declaration.
---

# Evidence record exposes bounded newest-line crash recovery

## Status

Accepted by the Owner in this preparation session on 2026-10-01: “I Accept all four ADR proposed.” The Architect records that acceptance here. The predecessor stays byte-exact; this forward record is the accepted superseding decision. The catalogue is regenerated and its exception digest repinned. Acceptance does not report implementation or authorize an external effect.

## Context

Issue #239 identifies a library operation with no public CLI recovery mode. The current library is packages/evidence/src/evidence/verb-evidence.ts:45-98 and the CLI seam is packages/cli/src/commands/evidence/facade-collect-record.ts:322-442.

## Decision

`evidence verify --scope chain` cross-checks in both directions. Every anchor
in the chain resolves to exactly one physical line: the canonical path is
`record/proofs/work/<kind>/<round_id>.jsonl` with forward slashes and no dot
segment, the sequence namespace is the epoch of one file, so `proof_sequence`
is the one-based position within that file and never crosses files, a line
is the bytes between the previous newline and the next newline exclusive of
the newline, a file whose last byte is not a newline is truncated and fails,
and the line digest is the SHA-256 of those bytes. Every physical line under
`record/proofs/work` has exactly one direct anchor or one governed historical
declaration. An anchor that resolves to no line, to more than one line, or to
a line whose digest differs fails the verification with the anchor and the
line named.

New anchors carry the SHA-256 of the line bytes: `appendVerbEvidence` in
`packages/evidence/src/evidence/verb-evidence.ts` records `proof_path`,
`proof_sequence`, and `proof_sha256` as structured fields on the chain entry,
and the `notes` form is kept for readers. Historical lines, whose anchors
carry no digest, are checked against a baseline that the first verification
under this record writes to `record/proofs/anchor-baseline.json`, validated
by `law/schemas/proof-anchor-baseline.schema.json`: one entry per line with
canonical path, sequence, digest, and the anchor status observed. The
baseline is append-only; a later verification may add lines that were not
yet present, and may never change or remove an entry.

A historical declaration is a proof line of kind `historical-gap`, itself
directly anchored with a digest, that names each orphan by canonical path,
sequence, and line digest, carries the Architect's authorization as the
declaring decision, and applies only to lines whose baseline entry predates
the cutoff, which is the timestamp of the first verification under this
record. It reads as `historical gap acknowledged` in the verification
result, never as restored provenance; the orphans stay listed under that
label. A declaration naming a line after the cutoff, lacking the
authorization, omitting a digest, or unanchored itself is rejected, and the
orphans it names remain failures. Old lines and old chain entries are never
edited, and the verifier refuses to run on a working tree that has modified
them.

The two-step writer, proof line then chain entry, gets a crash-recovery rule:
when the newest line of an epoch has no anchor and no declaration, the
verifier reports it as `UNANCHORED_NEWEST_LINE` with the remediation of
appending its chain entry through `evidence record`, which computes the
digest from the existing bytes and writes nothing else. Only the newest line
of an epoch qualifies; an older unanchored line is a historical gap or a
failure.

This path lives in `packages/evidence` and the CLI facade. The vendored
release verifier is not changed by this record; it keeps its own scope.

Accepted CLI spelling: evidence record --recover-newest-line --proof-path <canonical-path> --proof-sequence <positive-integer> --repo-root <root> --as-role inspector --write. These are new options on the existing evidence record action, not a new action. This spelling does not exist at draft time. The implementation resolves the newest physical line from immutable bytes, validates the canonical epoch and round, rechecks the line immediately before the append, and calls appendVerbEvidence with proofAnchor. Only the missing chain entry may be appended. Already anchored exact bytes return a non-duplicating outcome; ambiguity and an older orphan are refused. No baseline, proof line or earlier chain entry is repaired by rewriting. Authority is checked on the exact chain append and the registered initiator; no new role is admitted.

## Consequences

All substantive predecessor obligations and adversarial acceptance not expressly replaced below remain binding. This record changes no role, threshold, publication consent, historical proof byte, or default write scope.

## Alternatives Considered

Synthetic historical provenance and arbitrary re-anchoring are rejected. A new public action is unnecessary. A different flag spelling remains an Architect choice before acceptance; changing it requires prompt rehashing.

## Affected Rules

- packages/evidence/src/evidence/chain.ts
- packages/evidence/src/evidence/proof-epoch.ts
- packages/evidence/src/evidence/verb-evidence.ts
- packages/cli/src/commands/evidence/facade.ts
- packages/cli/src/commands/evidence/facade-collect-record.ts
- law/schemas/proof-anchor-baseline.schema.json
- record/proofs/anchor-baseline.json

## Inspector Adversarial Acceptance

- IA-001 -- The DETRAN baseline fixture of 119 lines, 67 anchored and 52 orphaned, fails evidence verify --scope chain before its historical declaration with every orphan listed, and passes after it with the declaration itself directly anchored.
- IA-002 -- Changing one byte of an anchored historical line, or of the baseline file, makes verification fail naming the line; the sequence, link, hash, and head checks of the cryptographic chain are unchanged and still fail on their own defects.
- IA-003 -- A historical declaration that names a line recorded after the cutoff, that lacks the Architect authorization, that omits a line digest, or that is itself unanchored is rejected, and the orphans it names stay reported.
- IA-004 -- A newest proof line with no chain entry after a simulated crash between the two writes is reported as unanchored with the remediation of appending its entry, and a new anchor whose digest differs from the line bytes fails.
- IA-005 -- An anchor whose canonical path contains a backslash, a dot segment, or a sequence outside the epoch's namespace, or whose line ends without a newline, resolves to no line and fails rather than matching loosely.
- IA-006 -- After a simulated proof-write crash the CLI appends exactly one missing newest-line anchor; the physical JSONL, baseline, earlier chain entries and all historical bytes remain identical, and a retry creates no duplicate.
- IA-007 -- An older line, changed digest, symlink, path escape, non-newline tail, already ambiguous anchor or missing write consent is refused before mutation; recovery is never a historical-gap declaration.
