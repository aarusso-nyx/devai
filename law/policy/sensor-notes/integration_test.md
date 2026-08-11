---
id: SENSOR-NOTE-integration_test
title: Integration Test
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: integration_test
emitter: packages/sensors/src/test.ts
standing: cell
tiers: [SWEEP]
---

# Integration Test

This note defines `integration_test`. Its canonical emitter
is `packages/sensors/src/test.ts`.

Bound cells: F3×T1.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
