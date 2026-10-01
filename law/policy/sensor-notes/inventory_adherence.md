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

## Surfaces measured and cell applicability

The sensor measures reverse adherence: every plant surface the inventory identifies
must be claimed by some invariant's `code_areas`, and the orphan count decides
PASS, REVIEW, or FAIL. The surfaces it measures are the inventory surfaces a repository
declares in `.devai/config/sensor-inputs.json` under `surfaces`: `http` (API endpoints
and routes), `database` (data-model tables), `rbac` (roles), and `actions` (registered
actions).

Applicability is decided per cell from the subject the cell measures (ADR-SCR-0008).
The cell is N/A only when every surface the sensor measures is declared absent, and
that N/A is reading-driven, never a ledger entry: the sensor emits `skipped` for the
declaration and the composer records the cell `N/A` by declaration. The framework
repository declares `actions` present, so the adapter measures the action surface and
F4×T4 is measured. `law/policy/scorecard-na.json` carries no entry for the cell; the
cell reads a measured verdict, and a ledger N/A for it while a measured surface exists
is a ledger error.

The sensor reads the inventory and the trace, not the readings store, so it runs in the
first pass of the sweep.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
