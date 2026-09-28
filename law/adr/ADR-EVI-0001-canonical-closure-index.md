---
id: ADR-EVI-0001
title: The rounds index is rendered from phase closures and the seal checks exact membership
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0004
  - ADR-SCR-0006
  - ADR-GOV-0002
  - packages/evidence/src/closure/index.ts
  - packages/loop/src/round-lifecycle/index.ts
  - docs/dev/operations/harness-convergence-proposals.md
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
  - IA-005 -- The DETRAN closures fixture renders byte-identically to the adopter's generator output and seals every round the adopter sealed.
---

# The rounds index is rendered from phase closures and the seal checks exact membership

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Changes the `rounds` kind of
`evidence render` and the ledger check of `round seal`; the phase closure
schema and `closePhase` are unchanged.

## Context

`round seal` in `packages/loop/src/round-lifecycle/index.ts` requires the
round's `phase_closure` id to appear in `record/derived/indexes/rounds.md`
and fails with `ROUND_ARCHIVE_PHASE_LEDGER_MISSING` when it does not. The
`rounds` renderer in `packages/loop/src/governance-ledger/render.ts`
concatenates the `record.md` bodies under `work/rounds` and reads no closure
at all, so the id never appears unless a human types it, and the file does
not exist on the framework checkout. The check is a substring test, so an id
that is a prefix of another, or one mentioned in prose, satisfies it. The
closure reader in `packages/evidence/src/closure/index.ts` already reads
every closure under `record/proofs/compliance/closures`, refuses a duplicate
`round_id` unless the new closure names the old one in `supersedes`, and
computes a ledger per round; none of that reaches the renderer. DETRAN
reported the gap after generating the index by hand (#169).

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

## Consequences

An adopter seals a round by closing its phase and rendering the index, with
no hand edit. The index carries the supersession history that the closure
reader already validates, so a superseded closure is visible as such. The
framework checkout gains the file once its own closures are rendered. A
consumer that read the old concatenation from the `rounds` kind moves to
`round-narratives`.

## Alternatives Considered

Keeping the concatenation and appending a closure table to it is rejected
because one file would then have two generators and two freshness rules.
Relaxing the seal to a warning when the index is missing is rejected because
the index is the round's evidence of closure. Reading the closure directory
directly from `round seal` and dropping the index is rejected because the
index is the artifact reviewers and adopters read, and the seal must agree
with what they read.

## Affected Rules

- `packages/loop/src/governance-ledger/render.ts` renders the closure table and the `round-narratives` kind.
- `packages/evidence/src/closure/index.ts` exposes the terminal-closure and supersession-order computation the renderer uses.
- `packages/loop/src/round-lifecycle/index.ts` applies the exact membership check in `round seal`.
- `packages/cli/src/commands/evidence/facade.ts` admits the `round-narratives` kind and `--check` for `rounds`.
- `record/derived/indexes/rounds.md` is created as a rendered index.

## Inspector Adversarial Acceptance

Rename a closure file so it no longer matches its id, duplicate a closure
under two names, and point a `supersedes` at a closure of another round;
confirm each render fails naming the file and leaves the index untouched.
Build two closures that name each other and confirm the cycle rejection;
build two terminal closures for one round and confirm the ambiguity
rejection. Write an index that contains the closure id only as a prefix of
a longer id, only in a sentence, and only as a superseded row; confirm
`round seal` fails each time and seals only on the exact terminal row.
Render the superseding fixture on two machines and compare bytes; change one
byte of the committed file and confirm `--check` exits non-zero without
writing. Render the DETRAN fixture and compare with the adopter's output.
