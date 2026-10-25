---
id: ADR-EVI-0006
title: Evidence record recovers one custody-proven non-newest anchor lost in a chain divergence
type: adr
status: accepted
date: 2026-10-21
authority: Architect
supersedes: []
provenance:
  - ADR-EVI-0002
  - ADR-EVI-0005
  - law/constitution.md Article 41 (evidence)
  - GitHub issue aarusso-nyx/devai#418 and the DETRAN packet P4-02-S2-ANCHOR-01 (R-0025, aarusso-nyx/detran@1a781213)
affected_rules:
  - packages/evidence/src/evidence/verb-evidence.ts
  - packages/evidence/src/evidence/anchors.ts
  - packages/cli/src/commands/evidence/facade.ts
  - packages/cli/src/commands/evidence/facade-collect-record.ts
  - law/schemas/evidence.schema.json
  - docs/reference/cli/evidence-verify.md
inspector_acceptance:
  - IA-001 -- The eight-line divergence fixture, two branches that each anchored their own lines followed by an ordinary merge that keeps one branch's chain, fails evidence verify --scope chain with PROOF_LINE_ORPHAN on line 7 while the recovered newest line 8 stays anchored; one divergent-anchor recovery makes verification pass, and the proof epoch, the baseline, every earlier canonical chain entry, and the source chain file are byte-identical before and after.
  - IA-002 -- Recovery is refused before mutation when the source chain file's SHA-256 differs from the stated digest, when the source chain fails its own sequence, link, or manifest verification, when it shares no common first entry with the canonical chain, or when the line it anchors sits at or before the fork point.
  - IA-003 -- Recovery is refused when the source chain holds no anchor for the named line, more than one anchor for it, or an anchor whose proof_sha256 differs from the current line bytes, and when any other line of the same epoch that the source chain anchors no longer matches its anchored digest.
  - IA-004 -- Recovery is refused for the newest line of an epoch (newest-line recovery owns it), for a line that already has a direct canonical anchor or an accepted historical declaration, and for an orphan that no source chain anchors; no historical-gap declaration, wildcard, or bulk form exists.
  - IA-005 -- A stated expected head that differs from the canonical head when the append is about to happen refuses with PROOF_ANCHOR_RECOVERY_STALE_HEAD and writes nothing; two concurrent identical requests leave exactly one recovery entry, and the loser's retry against the new head returns that entry.
  - IA-006 -- An exact retry after success returns the existing entry identity with alreadyAnchored and appends nothing; a retry naming the same line with a different source chain or source entry is refused.
  - IA-007 -- A source chain or proof path through a symlink, a path outside the repository, a non-regular file, record/proofs/chain.json itself as the source, a proof epoch whose last byte is not a newline, and a request without the inspector role or write consent are each refused before mutation.
  - IA-008 -- The appended entry links to the canonical head at append time and never reuses the source entry's sequence or previous_hash; it lists the source chain digest and the line digest as artifacts so both enter its manifest hash, and changing either digest after the append fails evidence verify --scope chain.
---

# Evidence record recovers one custody-proven non-newest anchor lost in a chain divergence

## Status

Accepted by the Owner on 2026-10-21, who approved a supplement to the newest-line
recovery record for a narrow command that re-anchors the line issue #418 reports.
The Architect records that acceptance here. ADR-EVI-0005 stays byte-exact and
binding: this record adds one recovery case beside it and replaces none of its
rules. Acceptance does not report implementation and authorizes no release or
adopter effect; the Inspector's acceptance tests precede the Engineer's change, and
a release that ships it needs its own authorization.

## Context

An adopter evidence history can diverge without any defect: two branches each run
governed verbs, each appends lines to the same proof epoch and anchors them in its
own copy of `record/proofs/chain.json`, and an ordinary merge keeps one chain. The
lines the other branch anchored are still present and byte-identical, but no entry
of the kept chain anchors them, so `evidence verify --scope chain` reports each as
`PROOF_LINE_ORPHAN`.

DETRAN R-0025 is the observed case (#418, packet P4-02-S2-ANCHOR-01). Under
`@aarusso-nyx/devai@2.6.3` the merge kept main's chain; newest-line recovery
(ADR-EVI-0005) re-anchored line 8; line 7 stays an orphan. Neither existing route
applies: newest-line recovery is newest-only by decision, and a historical-gap
declaration (ADR-EVI-0002) admits only lines whose baseline entry predates the
cutoff. Truncating the epoch is refused as `PROOF_HISTORY_MODIFIED`, as it must be.

The adopter preserved the divergent chain's exact bytes, so the line's original
direct anchor can be proved rather than asserted.

## Decision

`evidence record` gains one recovery mode. Accepted CLI spelling:

`evidence record --recover-divergent-anchor --proof-path <canonical-path> --proof-sequence <positive-integer> --source-chain <repository-relative-path> --source-chain-sha256 <hex> --expected-head <manifest-hash> --repo-root <root> --as-role inspector --write`

These are options on the existing `evidence record` action, as in ADR-EVI-0005, not
a new action. The role, initiator, and authority checks are those of newest-line
recovery; no role is admitted that is not admitted today.

**Source custody.** The source chain is a regular file inside the repository,
reached without a symlink component, and never `record/proofs/chain.json`. Its
SHA-256 equals `--source-chain-sha256`, and it passes the same sequence, link, and
manifest verification as the canonical chain. The two chains share a common prefix:
entries 1 to k are identical in canonical form for some k of at least 1, and they
differ at entry k+1 (the fork point). A source chain with no common first entry is
not a divergence of this history and is refused.

**The line.** The named line is a physical line of a canonical proof epoch, read
under the ADR-EVI-0002 rules, and it is not the newest line of that epoch. It has no
direct canonical anchor and no accepted historical declaration. Exactly one source
entry after the fork point anchors it, and that anchor's `proof_sha256` equals the
SHA-256 of the current line bytes. Every other line of the same epoch that the
source chain anchors still matches its anchored digest, so the epoch prefix the
source vouched for is intact.

**The append.** Immediately before writing, the verifier rechecks the line, the
source digest, and the canonical head; a head that differs from `--expected-head`
refuses with `PROOF_ANCHOR_RECOVERY_STALE_HEAD` and writes nothing. The mode then
appends exactly one entry through `appendVerbEvidence`, linked to the canonical head
at that moment, carrying `proof_path`, `proof_sequence`, and `proof_sha256` like any
direct anchor, and a structured `recovered_from` object naming the source chain
path and digest, the source entry `id`, `sequence`, and `manifest_hash`, and the
fork point. The entry lists two artifacts, the source chain file and the proof line,
each with its SHA-256, so both digests enter its manifest hash. It never reuses the
source entry's `sequence` or `previous_hash`, never copies the source entry, and
never re-runs or re-records the line's evidence. `law/schemas/evidence.schema.json`
gains `recovered_from` as an optional closed object; entries without it are
unchanged.

**Verification.** The recovery entry is a direct anchor and verifies as one. Its
artifact digests are checked like any other entry's; the source chain file is not
re-read at verification time, because its digest is already bound into the entry.

**Retry and conflict.** An exact retry, same line and same source entry, returns
the existing entry with `alreadyAnchored` and appends nothing. The same line with a
different source chain or source entry is refused. Concurrent requests serialize on
the expected-head check: one appends, the others are refused as stale and, retried
against the new head, return the existing entry. The chain write is the existing
temporary-file-and-rename write, so a crash leaves either the old chain or the new
one.

**Refusals.** Every refusal happens before mutation and names its reason under
`PROOF_ANCHOR_RECOVERY_REFUSED <reason>`. The reasons are the source digest, the
source chain's verification, a missing common prefix, a line at or before the fork
point, a missing, duplicated, or mismatched source anchor, a changed epoch prefix,
the newest line, an existing anchor or declaration, a path or file-type violation,
and missing role or consent; the stale head keeps its own code above. The
`PROOF_LINE_ORPHAN` remediation names this mode only when the verifier can see no
other route; it never suggests a historical-gap declaration for a post-cutoff line.

## Consequences

- An adopter whose history diverged in an ordinary merge recovers each lost anchor
  by proving it, one line per invocation, with every proof byte and every earlier
  canonical entry unchanged.
- Orphans that no preserved chain anchored stay orphans: the mode admits no
  assertion, waiver, or bulk repair, and the historical-gap cutoff is unchanged.
- Adopters must keep the divergent chain's bytes to use the mode. Recovery depends
  on that preserved file, so documentation tells adopters to preserve it before
  resolving a chain conflict.
- DETRAN adopts the mode only through a released package version and its own
  separately approved, version-specific adoption; nothing here changes an adopter
  repository.

## Alternatives Considered

- **Widen newest-line recovery to any line.** Rejected: ADR-EVI-0005 rejects
  arbitrary re-anchoring because a bare line digest proves nothing about the line's
  provenance. This mode requires the original anchor, in a verifiable chain that
  shares this history.
- **Admit post-cutoff historical-gap declarations.** Rejected: a declaration
  acknowledges a gap rather than restoring provenance, and opening it to new lines
  would weaken the orphan gate for every adopter.
- **Splice the source entry into the canonical chain.** Rejected: its sequence and
  previous hash belong to the other chain, so the splice would break the canonical
  links or rewrite history.
- **A new public action.** Rejected for the reason ADR-EVI-0005 gives: recovery is
  an append of one anchor and belongs to `evidence record`.

## Affected Rules

- packages/evidence/src/evidence/verb-evidence.ts
- packages/evidence/src/evidence/anchors.ts
- packages/cli/src/commands/evidence/facade.ts
- packages/cli/src/commands/evidence/facade-collect-record.ts
- law/schemas/evidence.schema.json
- docs/reference/cli/evidence-verify.md

## Inspector Adversarial Acceptance

- IA-001 -- The eight-line divergence fixture, two branches that each anchored their own lines followed by an ordinary merge that keeps one branch's chain, fails evidence verify --scope chain with PROOF_LINE_ORPHAN on line 7 while the recovered newest line 8 stays anchored; one divergent-anchor recovery makes verification pass, and the proof epoch, the baseline, every earlier canonical chain entry, and the source chain file are byte-identical before and after.
- IA-002 -- Recovery is refused before mutation when the source chain file's SHA-256 differs from the stated digest, when the source chain fails its own sequence, link, or manifest verification, when it shares no common first entry with the canonical chain, or when the line it anchors sits at or before the fork point.
- IA-003 -- Recovery is refused when the source chain holds no anchor for the named line, more than one anchor for it, or an anchor whose proof_sha256 differs from the current line bytes, and when any other line of the same epoch that the source chain anchors no longer matches its anchored digest.
- IA-004 -- Recovery is refused for the newest line of an epoch (newest-line recovery owns it), for a line that already has a direct canonical anchor or an accepted historical declaration, and for an orphan that no source chain anchors; no historical-gap declaration, wildcard, or bulk form exists.
- IA-005 -- A stated expected head that differs from the canonical head when the append is about to happen refuses with PROOF_ANCHOR_RECOVERY_STALE_HEAD and writes nothing; two concurrent identical requests leave exactly one recovery entry, and the loser's retry against the new head returns that entry.
- IA-006 -- An exact retry after success returns the existing entry identity with alreadyAnchored and appends nothing; a retry naming the same line with a different source chain or source entry is refused.
- IA-007 -- A source chain or proof path through a symlink, a path outside the repository, a non-regular file, record/proofs/chain.json itself as the source, a proof epoch whose last byte is not a newline, and a request without the inspector role or write consent are each refused before mutation.
- IA-008 -- The appended entry links to the canonical head at append time and never reuses the source entry's sequence or previous_hash; it lists the source chain digest and the line digest as artifacts so both enter its manifest hash, and changing either digest after the append fails evidence verify --scope chain.
