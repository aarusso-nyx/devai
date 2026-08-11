---
id: SENSOR-NOTE-plant_coverage
title: Plant Coverage
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: plant_coverage
emitter: packages/sensors/src/plant-coverage.ts
standing: cell
tiers: [SWEEP]
---

# Plant Coverage

This note defines `plant_coverage`. Its canonical emitter
is `packages/sensors/src/plant-coverage.ts`.

Bound cells: F2×T1.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
