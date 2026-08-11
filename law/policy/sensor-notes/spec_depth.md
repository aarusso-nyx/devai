---
id: SENSOR-NOTE-spec_depth
title: Spec Depth
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: spec_depth
emitter: packages/sensors/src/spec-depth.ts
standing: cell
tiers: [TIER2, SWEEP]
---

# Spec Depth

This note defines `spec_depth`. Its canonical emitter
is `packages/sensors/src/spec-depth.ts`.

Bound cells: F1×T2.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
