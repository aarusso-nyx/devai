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

## Kinds covered and cell applicability

The emitter regenerates the inventory reading kinds (`inventory_api`,
`inventory_routes`, `inventory_data_model`, `inventory_data_handling`,
`inventory_rbac`, `inventory_dep_graph`, and `inventory_coverage`) into
`.devai/state/sensor-readings/<kind>/`. Its effect is harness-write, so the kind is
excluded from the read-only `sweep` preset and runs only as a recording step the
inspector initiates.

Applicability is decided per cell from the subject the cell measures (ADR-SCR-0008).
`inventory_dep_graph` and `inventory_coverage` are both present on the framework
repository, so F4×T9 is measured and `law/policy/scorecard-na.json` carries no entry
for it. A ledger N/A for the cell while `inventory_dep_graph` or `inventory_coverage`
readings exist is rejected by the ledger check; the cell reads a measured verdict or
nothing, never an unexplained blank.

A regenerated reading is a new instance: it never rewrites a recorded file, and when
an earlier instance of the same kind exists for the same candidate it names that
instance in `supersedes`.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
