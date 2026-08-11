---
id: SENSOR-NOTE-spec_freshness
title: Spec Freshness
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: spec_freshness
emitter: packages/sensors/src/spec-freshness.ts
standing: cell
tiers: [TIER3, SWEEP]
---

# Spec Freshness

This note defines `spec_freshness`. Its canonical emitter
is `packages/sensors/src/spec-freshness.ts`.

Bound cells: F1×T9.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
