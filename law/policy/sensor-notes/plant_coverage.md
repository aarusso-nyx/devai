---
id: SENSOR-NOTE-plant_coverage
title: Plant Coverage
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: plant_coverage
emitter: packages/sensors/src/plant-coverage.ts
standing: cell
tiers: [SWEEP]
---

# Plant Coverage

This note defines `plant_coverage`. Its canonical emitter
is `packages/sensors/src/plant-coverage.ts`.

Bound cells: F2×T1.

## Inputs

The sensor reads the api-map body (`inventory_api/api-map.json`) and the routes body
(`inventory_routes/routes-<framework>.json`). The former fixed default
`routes-inventory.json` is retired because the producer writes
`routes-<framework>.json`; the sensor resolves routes as `inventory_coverage` does, and a
lone legacy `routes-inventory.json` still matches the single-candidate rule.
Each input resolves in the order fixed by
[`inventory_regeneration`](inventory_regeneration.md#sweep-consumers) (amended 2026-10-09,
#382): an explicit input passed to the producer, then the regenerated state body under
`.devai/state/sensors/<kind>/`, then the unchanged default under
`record/proofs/sensors/<kind>/`. The sweep adapter keeps `persistBody: false` and the
sweep member stays `effect: read`; the bodies come from `sense run inventory_regeneration`.

The routes body is resolved in each directory by the rule of `resolveRoutesPath`
(`packages/sensors/src/inventory-coverage-inputs.ts`): `routes-<framework>.json` when a
framework is given, otherwise the single `routes-*.json` present. Two or more candidates
are ambiguous and never guessed between, and the next directory is consulted only when a
directory holds none.

Neither body present in any location keeps `PLANT_COVERAGE_NO_INVENTORY`. Two or more
routes candidates in the directory consulted read `PLANT_COVERAGE_ROUTES_AMBIGUOUS`, a
warning that makes the reading REVIEW; none of the candidates is chosen.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
