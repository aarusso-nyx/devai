---
id: SENSOR-NOTE-inventory_performance
title: Inventory Performance
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_performance
emitter: packages/sensors/src/inventory-performance.ts
standing: cell
tiers: [SWEEP]
---

# Inventory Performance

This note defines `inventory_performance`. Its canonical emitter
is `packages/sensors/src/inventory-performance.ts`.

Bound cells: F4×T7.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
