---
id: SENSOR-NOTE-build
title: Build
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: build
emitter: packages/sensors/src/build.ts
standing: cell
tiers: [BASELINE, SWEEP]
---

# Build

This note defines `build`. Its canonical emitter
is `packages/sensors/src/build.ts`.

Bound cells: F2×T9.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
