---
id: SENSOR-NOTE-type_check
title: Type Check
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: type_check
emitter: packages/sensors/src/type-check.ts
standing: cell
tiers: [BASELINE, SWEEP]
---

# Type Check

This note defines `type_check`. Its canonical emitter
is `packages/sensors/src/type-check.ts`.

Bound cells: F2×T8.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
