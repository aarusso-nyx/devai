---
id: SENSOR-NOTE-inventory_coverage
title: Inventory Coverage
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_coverage
emitter: packages/sensors/src/inventory-coverage.ts
standing: cell
tiers: [SWEEP]
---

# Inventory Coverage

This note defines `inventory_coverage`. Its canonical emitter
is `packages/sensors/src/inventory-coverage.ts`.

Bound cells: F4×T1, F4×T2.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
