---
id: SENSOR-NOTE-inventory_rbac
title: Inventory Rbac
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_rbac
emitter: packages/sensors/src/inventory-rbac.ts
standing: cell
tiers: [TIER2, SWEEP]
---

# Inventory Rbac

This note defines `inventory_rbac`. Its canonical emitter
is `packages/sensors/src/inventory-rbac.ts`.

Bound cells: F4×T1, F4×T6.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
