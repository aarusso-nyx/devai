---
id: SENSOR-NOTE-harness_invariant_alignment
title: Harness Invariant Alignment
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: harness_invariant_alignment
emitter: packages/sensors/src/harness-invariant-alignment.ts
standing: cell
tiers: [TIER3, SWEEP]
---

# Harness Invariant Alignment

This note defines `harness_invariant_alignment`. Its canonical emitter
is `packages/sensors/src/harness-invariant-alignment.ts`.

Bound cells: F5×T4.

## Store read, candidate binding, and the chain entry

The sensor measures whether the harness's recorded readings align with the
candidate: it reads the canonical store `.devai/state/sensor-readings/` and the
`sense.readings.record` entries of `record/proofs/chain.json`. Its subject is the
store, so it is a member of the ordered second pass that
`law/policy/sense-presets.json` declares in `selection_effect_rule.sweep_second_pass`
and runs only after the inspector has recorded the first pass (ADR-SCR-0008).

Under ADR-SCR-0008 a recording is two ordered writes: `sense record` writes the
reading file first, then appends one `sense.readings.record` entry to
`record/proofs/chain.json` naming the reading id, its kind, and the SHA-256 of the
file bytes. A missing entry is repaired by re-running `sense record` on the same file,
which appends and edits nothing; a digest mismatch is a finding, not a repair.

The sensor accepts a store reading when the reading carries its candidate binding or
its chain entry carries the candidate head. A reading with neither is ignored, and a
reading whose binding does not match the candidate head is ignored, so the
candidate-binding requirement is not weakened by the store read. F5×T4 therefore
reads PASS or FAIL from the substrate: a missing binding is a FAIL the cell shows,
never a REVIEW for the absence of inputs.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
