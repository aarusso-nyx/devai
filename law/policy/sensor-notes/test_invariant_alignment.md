---
id: SENSOR-NOTE-test_invariant_alignment
title: Test Invariant Alignment
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: test_invariant_alignment
emitter: packages/sensors/src/test-invariant-alignment.ts
standing: cell
tiers: [TIER3, SWEEP]
---

# Test Invariant Alignment

This note defines `test_invariant_alignment`. Its canonical emitter
is `packages/sensors/src/test-invariant-alignment.ts`.

Bound cells: F3×T4.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
