---
id: SENSOR-NOTE-inventory_adherence
title: Inventory Adherence
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_adherence
emitter: packages/sensors/src/inventory-adherence.ts
standing: cell
tiers: [SWEEP]
---

# Inventory Adherence

This note defines `inventory_adherence`. Its canonical emitter
is `packages/sensors/src/inventory-adherence.ts`.

Bound cells: F4×T4.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
