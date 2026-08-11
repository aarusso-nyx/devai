---
id: SENSOR-NOTE-spec_alignment
title: Spec Alignment
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: spec_alignment
emitter: packages/sensors/src/spec-alignment.ts
standing: cell
tiers: [TIER2, SWEEP]
---

# Spec Alignment

This note defines `spec_alignment`. Its canonical emitter
is `packages/sensors/src/spec-alignment.ts`.

Bound cells: F1×T4.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
