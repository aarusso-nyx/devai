---
id: ADR-EVI-0002
title: Chain verification cross-checks every proof line and historical gaps are declared, never restored
type: adr
status: accepted
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-REL-0025
  - ADR-AUT-0001
  - ADR-SCR-0006
  - ADR-GOV-0002
  - packages/evidence/src/evidence/chain.ts
  - docs/dev/operations/harness-convergence-proposals.md
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
---

# Chain verification cross-checks every proof line and historical gaps are declared, never restored

## Status

Accepted on 2026-10-01 by the Architect as drafted, after the Owner
accepted it on 2026-10-01; round R-0403 of CMP-0004 implements it. Proposed on
2026-09-28 from the harness convergence brainstorm and its independent
review. Extends `evidence verify --scope
chain` with a line-level cross-check and a governed historical declaration;
the manifest hashing, link, and head rules of the chain are unchanged.

## Context

`verifyChain` in `packages/evidence/src/evidence/chain.ts` checks the
sequence, the previous-hash links, each record's manifest hash, and the head
of `record/proofs/chain.json`. The chain entries that
`packages/cli/src/commands/evidence/facade-collect-record.ts` appends after a
proof line carry the anchor as `notes` of the form `round_id=<id>` and
`proof_sequence=<n>`, and nothing verifies that the physical line under
`record/proofs/work/<kind>/<round>.jsonl` exists, is unique, or has the bytes
the anchor implies. A line without any entry is invisible to verification.
DETRAN reported a baseline of 119 proof lines, 67 with an anchor and 52
without, and a verifier that said the chain was valid (#168). The
maintainer decided on 2026-09-28 that the Architect authorizes historical
orphan declarations, and that only lines recorded before the first
verification under this record are eligible.

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

## Consequences

Chain validity now means that every proof line is accounted for, so a
deleted, duplicated, or rewritten line is a verification failure rather than
a silent loss. Adopters with historical orphans declare them once, under
Architect authorization, and carry the acknowledgement forward in their
verification output. Every new recording costs one digest computation. The
first verification on any checkout writes the baseline, which is a new
committed file under `record/proofs`.

## Alternatives Considered

Re-anchoring the orphans by appending synthetic chain entries is rejected
because it would assert provenance that was never recorded. Editing the
historical entries to add digests is rejected because the chain's manifest
hashes would change and the chain would no longer be the one that was
verified. Verifying only forward from a cutoff and ignoring older lines is
rejected because the orphans would remain invisible. Placing the cross-check
in the vendored release verifier is rejected because that verifier is
immutable per release and the evidence package is where `evidence verify`
already lives.

## Affected Rules

- `packages/evidence/src/evidence/chain.ts` performs the line-level cross-check beside the existing checks.
- `packages/evidence/src/evidence/proof-epoch.ts` defines the canonical path, sequence namespace, newline rule, and line digest.
- `packages/evidence/src/evidence/verb-evidence.ts` records `proof_path`, `proof_sequence`, and `proof_sha256` on new anchors.
- `packages/cli/src/commands/evidence/facade.ts` and `packages/cli/src/commands/evidence/facade-collect-record.ts` expose the verification result, the baseline write, and the crash-recovery remediation.
- `law/schemas/proof-anchor-baseline.schema.json` and `record/proofs/anchor-baseline.json` are created for the append-only baseline.

## Inspector Adversarial Acceptance

Load the DETRAN fixture, run `evidence verify --scope chain`, and confirm
failure listing 52 orphans; add the historical declaration and confirm the
pass with the orphans labelled acknowledged. Flip one byte in an anchored
historical line and in the baseline and confirm each failure names the line;
break a previous-hash link and confirm the existing failure still appears.
Submit declarations that name a post-cutoff line, omit the authorization,
omit a digest, and lack their own anchor; confirm each is rejected with the
orphans still failing. Kill the writer between the proof line and the chain
entry, verify, and confirm `UNANCHORED_NEWEST_LINE` with the remediation;
append an anchor with a wrong digest and confirm failure. Craft anchors with
a backslash path, a `..` segment, a sequence beyond the file, and a file
without a final newline, and confirm none resolves.
