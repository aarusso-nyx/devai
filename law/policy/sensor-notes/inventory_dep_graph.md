---
id: SENSOR-NOTE-inventory_dep_graph
title: Inventory Dep Graph
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_dep_graph
emitter: packages/sensors/src/inventory-dep-graph.ts
standing: cell
tiers: [TIER2, SWEEP]
---

# Inventory Dep Graph

This note defines `inventory_dep_graph`. Its canonical emitter
is `packages/sensors/src/inventory-dep-graph.ts`.

Bound cells: F4×T1, F4×T3.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
