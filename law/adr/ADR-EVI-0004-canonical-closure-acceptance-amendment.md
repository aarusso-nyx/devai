---
id: ADR-EVI-0004
title: Canonical closure acceptance preserves rows and sealing rather than workaround bytes
type: adr
status: accepted
date: 2026-10-01
authority: Architect
supersedes:
  - ADR-EVI-0001
provenance:
  - ADR-EVI-0001
  - docs/dev/operations/open-issue-closure-campaign/decision-register.md
  - product/campaigns/CMP-0006-open-issue-closure/issue-snapshot.json
affected_rules:
  - packages/loop/src/governance-ledger/render.ts
  - packages/evidence/src/closure/index.ts
  - packages/loop/src/round-lifecycle/index.ts
  - packages/cli/src/commands/evidence/facade.ts
  - record/derived/indexes/rounds.md
inspector_acceptance:
  - IA-001 -- A closure file whose name differs from its id, two closures with the same id, and a closure whose supersedes names an id in another round each make evidence render --kind rounds fail with the offending file named and write nothing.
  - IA-002 -- Two closures that supersede each other, or a chain of supersessions that never reaches a terminal closure, is rejected as a cycle; two terminal closures for one round are rejected as ambiguous.
  - IA-003 -- round seal against an index that mentions the closure id only inside another id, only in prose, or as a superseded row fails with ROUND_ARCHIVE_PHASE_LEDGER_MISSING; only an exact terminal row seals.
  - IA-004 -- Rendering the superseding fixture twice on two machines yields byte-identical rounds.md, and --check exits non-zero without writing when the committed file differs by one byte.
  - IA-005 -- The DETRAN fixture contains the same canonical closure rows and seals R-0017 through PC-0018; byte identity with its Portuguese workaround renderer is not required, and superseded or prose-only rows never satisfy sealing.
---

# Canonical closure acceptance preserves rows and sealing rather than workaround bytes

## Status

Accepted by the Owner in this preparation session on 2026-10-01: “I Accept all four ADR proposed.” The Architect records that acceptance here. The predecessor stays byte-exact; this forward record is the accepted superseding decision. The catalogue is regenerated and its exception digest repinned. Acceptance does not report implementation or authorize an external effect.

## Context

Issue #240 and the Owner comment of 2026-10-01 confirm the existing CMP-0004 ruling. The accepted predecessor mixes canonical row semantics with an incompatible IA-005 byte comparison.

## Decision

`evidence render --kind rounds` renders `record/derived/indexes/rounds.md`
from `readClosures` and `computeLedger`, one row per closure with the
closure id, the round id, the `supersedes` link, the `merged_as` sha, and
whether the row is terminal for its round, in a deterministic order: rounds
by id, and within a round by supersession order from the first closure to
the terminal one. The narrative concatenation of round records stays
available under a new kind, `round-narratives`, so a consumer that wants the
bodies keeps them; `rounds` no longer means that.

The renderer rejects, with the file named, a closure whose file name differs
from its id, two closures with the same id, a `supersedes` link that names an
id absent from the directory or belonging to another round, a supersession
cycle, and more than one terminal closure for one round. A rejected render
writes nothing. `--check` renders to memory and compares bytes with the
committed file, exits non-zero on any difference, and never writes.

`round seal` checks exact membership: the closure id must appear as the id
cell of a row, that row must be marked terminal, and the row's round id must
be the round being sealed. A substring match, a prose mention, or a
superseded row no longer satisfies the check, and the error code stays
`ROUND_ARCHIVE_PHASE_LEDGER_MISSING` so existing consumers keep their
mapping.

`record/derived/indexes/rounds.md` becomes a rendered file under the
existing derived-index freshness rule, so the round-close checks fail when a
closure is added without regenerating it.

Only IA-005 is replaced by this record. The Owner ruling of CMP-0004 decision 6 governs: equal closure identities, round identities, supersession links, merged heads and terminal semantics, plus sealing R-0017 through PC-0018, constitute acceptance. The canonical renderer is adopted; no Portuguese workaround byte comparison is required.

## Consequences

All substantive predecessor obligations and adversarial acceptance not expressly replaced below remain binding. This record changes no role, threshold, publication consent, historical proof byte, or default write scope.

## Alternatives Considered

Editing the accepted predecessor is rejected. Replacing the canonical renderer with the workaround is rejected.

## Affected Rules

- packages/loop/src/governance-ledger/render.ts
- packages/evidence/src/closure/index.ts
- packages/loop/src/round-lifecycle/index.ts
- packages/cli/src/commands/evidence/facade.ts
- record/derived/indexes/rounds.md

## Inspector Adversarial Acceptance

- IA-001 -- A closure file whose name differs from its id, two closures with the same id, and a closure whose supersedes names an id in another round each make evidence render --kind rounds fail with the offending file named and write nothing.
- IA-002 -- Two closures that supersede each other, or a chain of supersessions that never reaches a terminal closure, is rejected as a cycle; two terminal closures for one round are rejected as ambiguous.
- IA-003 -- round seal against an index that mentions the closure id only inside another id, only in prose, or as a superseded row fails with ROUND_ARCHIVE_PHASE_LEDGER_MISSING; only an exact terminal row seals.
- IA-004 -- Rendering the superseding fixture twice on two machines yields byte-identical rounds.md, and --check exits non-zero without writing when the committed file differs by one byte.
- IA-005 -- The DETRAN fixture contains the same canonical closure rows and seals R-0017 through PC-0018; byte identity with its Portuguese workaround renderer is not required, and superseded or prose-only rows never satisfy sealing.
