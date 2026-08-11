---
id: SENSOR-NOTE-plant_depth
title: Plant Depth
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: plant_depth
emitter: packages/sensors/src/plant-depth.ts
standing: cell
tiers: [SWEEP]
---

# Plant Depth

This note defines `plant_depth`. Its canonical emitter
is `packages/sensors/src/plant-depth.ts`.

Bound cells: F2×T2.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
