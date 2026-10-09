---
id: SENSOR-NOTE-inventory_coverage
title: Inventory Coverage
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_coverage
emitter: packages/sensors/src/inventory-coverage.ts
standing: cell
tiers: [SWEEP]
---

# Inventory Coverage

This note defines `inventory_coverage`. Its canonical emitter
is `packages/sensors/src/inventory-coverage.ts`.

Bound cells: F4×T1, F4×T2.

## Inputs

The sensor reads the api-map body (`inventory_api/api-map.json`) and the routes body
(`inventory_routes/routes-<framework>.json`), both counted only while `http` is declared
present.
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

The sensor reads only files tracked at the candidate HEAD, apart from the inventory bodies
it is given. A present state body is always the input: one that is not admissible is
refused and never replaced by the `record/proofs/sensors/` default. A regenerated routes
directory that is present but cannot be listed reads error with `COVERAGE_ROUTES_INVALID`,
naming the directory, and the proof routes body is not read.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
