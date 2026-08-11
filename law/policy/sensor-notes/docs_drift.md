---
id: SENSOR-NOTE-docs_drift
title: Docs Drift
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: docs_drift
emitter: packages/sensors/src/docs-drift.ts
standing: cell
tiers: [TIER3, SWEEP]
---

# Docs Drift

This note defines `docs_drift`. Its canonical emitter
is `packages/sensors/src/docs-drift.ts`.

Bound cells: F5×T3.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
