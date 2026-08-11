---
id: SENSOR-NOTE-harness_coverage
title: Harness Coverage
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: harness_coverage
emitter: packages/sensors/src/harness-coverage.ts
standing: cell
tiers: [TIER3, SWEEP]
---

# Harness Coverage

This note defines `harness_coverage`. Its canonical emitter
is `packages/sensors/src/harness-coverage.ts`.

Bound cells: F5×T1.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
