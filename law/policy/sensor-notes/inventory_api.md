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

ADR-SCR-0016 distinguishes protected declarations from resolved authorization.
`auth.required: true` and guard names preserve observed protection but do not
resolve conditional permission branches. Missing static permission metadata
never means public; `false` requires a recognized explicit public marker.
Conditional or unresolved guard semantics remain explicit uncertainty. Do not
invent a static permission, flatten branches into an unconditional AND/OR or
claim that synthetic guard references prove complete runtime authorization.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
