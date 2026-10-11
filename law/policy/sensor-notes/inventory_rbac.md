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

## Inputs

The sensor reads the data-model body (`inventory_data_model/data-model.json`, required) and
the api-map body (`inventory_api/api-map.json`, read when present).
Each input resolves in the order fixed by
[`inventory_regeneration`](inventory_regeneration.md#sweep-consumers) (amended 2026-10-09,
#382): an explicit input passed to the producer, then the regenerated state body under
`.devai/state/sensors/<kind>/`, then the unchanged default under
`record/proofs/sensors/<kind>/`. The sweep adapter keeps `persistBody: false` and the
sweep member stays `effect: read`; the bodies come from `sense run inventory_regeneration`.

A data model absent from every location keeps `RBAC_REQUIRES_DATA_MODEL` / UNKNOWN.

Synthetic `guard:<Name>` bindings identify declared guards, not resolved
permission semantics. Under ADR-SCR-0016 a protected endpoint with a conditional
or unrecognized permission guard retains authentication/guard facts while
reporting `RBAC_AUTHORIZATION_UNRESOLVED`; it cannot become public or a proved
complete permission binding merely because a static permission decorator is
absent. A query-dependent guard must not be flattened into unconditional AND/OR
permissions. The diagnostic establishes no new permission or runtime authority.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
