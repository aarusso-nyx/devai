---
id: SENSOR-NOTE-inventory_api
title: Inventory Api
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_api
emitter: packages/sensors/src/inventory-api.ts
standing: cell
tiers: [TIER2, SWEEP]
---

# Inventory Api

This note defines `inventory_api`. Its canonical emitter
is `packages/sensors/src/inventory-api.ts`.

Bound cells: F4×T1, F4×T2.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
