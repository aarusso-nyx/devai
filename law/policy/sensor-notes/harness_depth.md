---
id: SENSOR-NOTE-harness_depth
title: Harness Depth
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: harness_depth
emitter: packages/sensors/src/harness-depth.ts
standing: cell
tiers: [TIER3, SWEEP]
---

# Harness Depth

This note defines `harness_depth`. Its canonical emitter
is `packages/sensors/src/harness-depth.ts`.

Bound cells: F5×T2.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
