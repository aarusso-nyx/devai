---
id: SENSOR-NOTE-inventory_data_model
title: Inventory Data Model
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_data_model
emitter: packages/sensors/src/inventory-data-model.ts
standing: cell
tiers: [TIER2, SWEEP]
---

# Inventory Data Model

This note defines `inventory_data_model`. Its canonical emitter
is `packages/sensors/src/inventory-data-model.ts`.

Bound cells: F4×T1, F4×T2.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
