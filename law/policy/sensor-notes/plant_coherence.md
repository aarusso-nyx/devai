---
id: SENSOR-NOTE-plant_coherence
title: Plant Coherence
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: plant_coherence
emitter: packages/sensors/src/plant-coherence.ts
standing: cell
tiers: [SWEEP]
---

# Plant Coherence

This note defines `plant_coherence`. Its canonical emitter
is `packages/sensors/src/plant-coherence.ts`.

Bound cells: F2×T3.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
