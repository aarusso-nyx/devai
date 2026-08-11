---
id: SENSOR-NOTE-harness_robustness
title: Harness Robustness
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: harness_robustness
emitter: packages/sensors/src/harness-robustness.ts
standing: cell
tiers: [SWEEP]
---

# Harness Robustness

This note defines `harness_robustness`. Its canonical emitter
is `packages/sensors/src/harness-robustness.ts`.

Bound cells: F5×T8.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
