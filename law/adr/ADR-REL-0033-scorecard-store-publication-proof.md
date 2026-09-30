---
id: ADR-REL-0033
title: A release that changes the readings store is proven from the packed artifact in a disposable adopter
type: adr
status: accepted
date: 2026-09-29
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0002
  - ADR-SCR-0008
  - ADR-REL-0025
  - ADR-REL-0026
  - packages/loop/src/scorecard/inputs.ts
  - packages/cli/src/commands/audit/scorecard.ts
  - scripts/npm-pack-output.mjs
  - docs/dev/operations/harness-convergence-extension-proposal.md
affected_rules:
  - docs/adopters/pack-resolution.md
  - scripts/rehearse-packed-adopter.mjs
  - package.json
  - packages/cli/src/commands/audit/scorecard.ts
  - packages/loop/src/scorecard/inputs.ts
  - docs/reference/scripts.md
inspector_acceptance:
  - IA-001 -- In a disposable adopter created from the packed tarball, a reading persisted by sense record --write under .devai/state/sensor-readings is consumed by audit scorecard --at <HEAD> without any copy or symlink into record/proofs/freshness/readings, and two consecutive runs produce byte-identical output.
  - IA-002 -- With an empty readings store the cell reads UNKNOWN; with a file of invalid JSON or a schema-invalid SensorReading in the store the run rejects it with a named code and never counts it as PASS.
  - IA-003 -- audit scorecard with --at set to a commit other than the exact 40-character HEAD is refused; with two readings of one kind the later one is selected deterministically; a reading older than the stale window reads stale and not PASS.
  - IA-004 -- The rehearsal script exits non-zero with a named code when the packed registry, preset, or schema differs from source, when a sweep read-kind reading fails packed-schema validation, or when the scorecard route diverges between the two runs.
  - IA-005 -- The rehearsal reads only the packed artifact and the fixture it creates; it performs no push, tag, publish, or network write, and a run without network access completes.
---

# A release that changes the readings store is proven from the packed artifact in a disposable adopter

## Status

Accepted on 2026-09-30 by the Architect before round R-0308 opened; proposed on
2026-09-29 from DETRAN R-0020 CTG-0004 (#185). Adds a
publication proof beside the offline bundle checks of ADR-REL-0025 and
ADR-REL-0026; the release ladder and channels are unchanged. The publication
itself is Owner effect OE-07 of CMP-0003.

## Context

Commit `268bb838` routes `audit scorecard` through
`resolveScorecardInputs`, whose canonical store is
`.devai/state/sensor-readings`, the same store that `sense record --write`
writes. The published v1.6.0 still loads `record/proofs/freshness/readings`,
so a valid recorded reading is invisible to the published command and a cell
that has a reading reads UNKNOWN (#185). DETRAN's accepted A1 gate needs four
measured PASS cells and cannot obtain them from v1.6.0 or from source alone;
it needs a published version and a rehearsal on the exact packed artifact.
Nothing in the release path today exercises the readings store from the
tarball, so a source fix and a published package can disagree without any
check noticing.

## Decision

A new immutable version carries the store resolver and the schema admission
of ADR-SCR-0011. v1.6.0 is not republished under its version.

A rehearsal script, `scripts/rehearse-packed-adopter.mjs`, exposed as
`release:packed-adopter`, packs the candidate with the existing
`npm-pack-output` guard, extracts it into a disposable adopter fixture, and
runs the publication proof: `sense run` for one read kind, `sense record
--write`, and `audit scorecard --repo-root . --at <HEAD>` twice. It passes
only when both outputs are byte-identical, the relevant cell consumed the
persisted reading from `.devai/state/sensor-readings`, no copy or symlink
into `record/proofs/freshness/readings` was needed, an empty store reads
UNKNOWN, and an invalid JSON file or a schema-invalid reading in the store is
rejected with a named code. It also runs the packed-artifact checks of
ADR-SCR-0011. Every failure exits non-zero with a named code. The script
reads the packed artifact and its own fixture, performs no push, tag,
publish, or network write, and completes without network access.

Every scorecard consumer resolves readings through
`packages/loop/src/scorecard/inputs.ts`, so the N/A ledger of ADR-SCR-0002
applies uniformly. Exact-HEAD enforcement, deterministic latest-per-kind
selection, and stale-failure behaviour are unchanged and are asserted by the
proof.

The rehearsal is a release gate for any version that changes the readings
store, the scorecard resolver, or the sensor schema. Publication is an Owner
effect and is performed only after the rehearsal passed on the exact
artifact to be published.

## Consequences

An adopter can pin a version knowing the scorecard route was exercised from
the same bytes. DETRAN still owns its governed pin, clone rehearsal, CI, and
real readings on its candidate HEAD; this record proves the package, not the
adopter's measurement. Release preparation gains one offline step of a few
minutes. The observation-store design question of #160, which ADR-SCR-0008
answers, is out of scope here; the boundary is that this record proves the
store the resolver reads today and does not decide which store a hook reads.

## Alternatives Considered

Republishing v1.6.0 with the fix is rejected because published versions are
immutable. Proving the route from source tests alone is rejected because the
defect was exactly a source-package divergence. Running the proof in the
release workflow against the registry-published package is rejected because
the proof must pass before publication, not after. Placing the proof inside
`release:static-integrity` is rejected because that check inspects the
artifact's contents and this one executes it.

## Affected Rules

- `docs/adopters/pack-resolution.md` defines the publication proof and its named failure codes.
- `scripts/rehearse-packed-adopter.mjs` and `package.json` provide `release:packed-adopter`.
- `packages/cli/src/commands/audit/scorecard.ts` and `packages/loop/src/scorecard/inputs.ts` are the one resolver the proof exercises.
- `docs/reference/scripts.md` documents the script.

## Inspector Adversarial Acceptance

Pack the candidate and run the rehearsal; confirm it passes and that the
fixture holds no copy or symlink under `record/proofs/freshness/readings`.
Empty the store and confirm UNKNOWN. Write a file of invalid JSON and then a
schema-invalid reading into the store and confirm each is rejected with a
named code. Pass a short or wrong `--at` and confirm refusal. Record two
readings of one kind and confirm the later is selected on both runs. Age a
reading past the stale window and confirm it does not read PASS. Alter one
byte of the packed schema and confirm the rehearsal exits non-zero with the
divergence code. Run the rehearsal with network access removed and confirm
it completes.
