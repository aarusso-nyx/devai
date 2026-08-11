---
id: SENSOR-NOTE-test_coherence
title: Test Coherence
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: test_coherence
emitter: packages/sensors/src/test-coherence.ts
standing: cell
tiers: [SWEEP]
---

# Test Coherence

This note defines `test_coherence`. Its canonical emitter
is `packages/sensors/src/test-coherence.ts`.

Bound cells: F3×T3.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
