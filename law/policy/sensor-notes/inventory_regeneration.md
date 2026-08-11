---
id: SENSOR-NOTE-inventory_regeneration
title: Inventory Regeneration
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_regeneration
emitter: packages/cli/src/commands/sense/readings-rebuild.ts
standing: cell
tiers: [SWEEP]
---

# Inventory Regeneration

This note defines `inventory_regeneration`. Its canonical emitter
is `packages/cli/src/commands/sense/readings-rebuild.ts`.

Bound cells: F4×T9.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
