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

The registry pairing is `inventory_regeneration` → F4:T9 (ADR-SCR-0012).
`inventory_dep_graph` and `inventory_coverage` are both measured on the framework,
so both are required production kinds there. The Owner chose production on issue #237;
the ledger has no N/A entry for this cell. A missing body cannot justify N/A.

Amended 2026-10-09 (#382): the required kinds follow the plant surfaces the repository
declares in `.devai/config/sensor-inputs.json` (ADR-SCR-0003). Regeneration is the one
governed writer of the inventory bodies. The read-only sweep never persists a body, so a
kind that regeneration does not produce has no body for its dependents to read.

| Kind                      | Required when                                 |
| ------------------------- | --------------------------------------------- |
| `inventory_dep_graph`     | always                                        |
| `inventory_api`           | `http` present                                |
| `inventory_routes`        | `http` present                                |
| `inventory_data_model`    | `database` present                            |
| `inventory_rbac`          | `rbac` and `database` present                 |
| `inventory_data_handling` | `rbac` and `database` present                 |
| `inventory_coverage`      | `http` or `actions` present (unchanged, #237) |

An omitted `surfaces` object presumes every surface present, so every kind is required.
`inventory_rbac` and `inventory_data_handling` measure from the data-model body. A
repository that declares `rbac` present and `database` absent has no data model for them
to read, so regeneration does not require them there, and their sweep readings keep their
existing data-model findings until the declaration or the repository changes.

The framework declares `http`, `database` and `rbac` absent, so on DEVAI itself
regeneration produces no HTTP, database or RBAC body and invents none just to touch all
seven kinds. That restraint applies to surfaces declared absent. Where a surface is
declared present, as in the adopter default, each required kind is produced by its own
typed producer from the source at HEAD and is never synthesized.
`inventory_data_handling` continues to respect ADR-SCR-0004's authored no-personal-data
declaration; its skipped/diagnostic result is not a PII production claim. Declared
surfaces must be accurate: a surface declared present whose producer finds nothing reads
as that producer reads, never PASS by absence.

## Typed production, bodies and recording

Use the existing `regenerateInventory` producer for the combined F4 body and each kind's
own typed operation for its body and real reading: `senseInventoryApi`,
`senseInventoryRoutes`, `senseInventoryDataModel`, `senseInventoryRbac`,
`senseInventoryDataHandling`, `senseInventoryDepGraph` and `senseInventoryCoverage`, each
called with `persistBody: false` so that regeneration, not the producer, owns publication.
The shared inventory dependency edge-list hash is not the sensor's
`{graph: adjacency-list}` body. Generate each through its own typed producer and
validator. The coverage matrix is not the combined F4 manifest and its action-link
metrics remain in the real reading.

The bounded state bodies, one file per kind, are:

| Kind                      | State body                                                         | Schema                                         |
| ------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| `inventory_api`           | `.devai/state/sensors/inventory_api/api-map.json`                  | `law/schemas/api-map.schema.json`              |
| `inventory_routes`        | `.devai/state/sensors/inventory_routes/routes-<framework>.json`    | `law/schemas/routes-inventory.schema.json`     |
| `inventory_data_model`    | `.devai/state/sensors/inventory_data_model/data-model.json`        | `law/schemas/data-model-inventory.schema.json` |
| `inventory_rbac`          | `.devai/state/sensors/inventory_rbac/rbac.json`                    | `law/schemas/rbac-inventory.schema.json`       |
| `inventory_data_handling` | `.devai/state/sensors/inventory_data_handling/data-model-pii.json` | `law/schemas/data-model-inventory.schema.json` |
| `inventory_dep_graph`     | `.devai/state/sensors/inventory_dep_graph/dep-graph.json`          | `law/schemas/dep-graph.schema.json`            |
| `inventory_coverage`      | `.devai/state/sensors/inventory_coverage/coverage-matrix.json`     | `law/schemas/coverage-matrix.schema.json`      |

Each file name is the producer's own default name, so the state name and the
`record/proofs/sensors/<kind>/` default name agree. `<framework>` is the `framework` field
of the routes body the producer returned. Publishing a routes body removes every other
`routes-*.json` from the state routes directory, so exactly one routes body stands there.

Dependents are produced after their inputs. `inventory_api`, `inventory_routes` and
`inventory_data_model` come first; then `inventory_rbac` (reads the data-model and
api-map bodies), `inventory_data_handling` (reads the data-model body) and
`inventory_coverage` (reads the api-map and routes bodies). `inventory_dep_graph` has no
inventory input. Each dependent receives the staged, not yet published, paths of its
inputs explicitly as producer options (`dataModelPath`, `apiMapPath`, `routesPath`) and
admits them although they are not tracked files. During regeneration a dependent never
reads a published state body or a `record/proofs/sensors/` default. An input whose kind is
not required is passed as no path, and the dependent measures as its producer does
without that input.

During regeneration every producer reads source files only as they are tracked at the
candidate HEAD; the staged inventory inputs above are the only untracked files admitted.
Bodies are portable bytes: a regenerated body that names the repository it read carries
`sourceRepo: "."`, never the absolute checkout path, so the same HEAD yields the same bytes
in any checkout.

These join `.devai/state/inventory/inventory.json` as machine outputs of the
registered observation/rebuild path. `sense run inventory_regeneration` regenerates every
required body for a clean HEAD commit and validates each against its schema. The changed
bodies are staged together as durable temporary files, and nothing is published unless
every body is valid and staged; a failure before the first rename writes nothing.
Publication then replaces the bodies one at a time, each by an atomic rename followed by a
directory sync, so the set as a whole is not atomic: a crash between renames can leave
bodies from two generations, and the next regeneration at the same HEAD replaces them. A
snapshot change detected after publication retracts the bodies just published. A dirty
working tree or missing candidate commit reads UNKNOWN and writes nothing. Existing direct
sensor defaults under `record/proofs/sensors/<kind>/` stay distinct and are not silently
relocated: regeneration neither writes nor removes them.

## Sweep consumers

Read-only sweep adapters retain `persistBody: false`, and every sweep member stays
`effect: read`; the sweep never writes a body. A sweep member that consumes an inventory
body resolves each input in this order and reads the first that is present:

1. an explicit input passed to the producer;
2. the regenerated state body under `.devai/state/sensors/<kind>/`;
3. the unchanged default under `record/proofs/sensors/<kind>/`.

The routes input applies, in each directory in turn, the rule of `resolveRoutesPath` in
`packages/sensors/src/inventory-coverage-inputs.ts`: `routes-<framework>.json` when a
framework is given, otherwise the single `routes-*.json` the directory holds. Two or more
candidates read as ambiguous and are never guessed between; the next directory is
consulted only when a directory holds none.

A present state body is always the input. If it is present but not admissible it is
refused, and the consumer never falls through to the `record/proofs/sensors/` default in
its place; only an absent state body falls through. A regenerated routes directory that is
present but cannot be listed reads error, naming the directory, without reading the proof
routes body: `PLANT_COVERAGE_ROUTES_UNREADABLE` in `plant_coverage` and
`COVERAGE_ROUTES_INVALID` in `inventory_coverage`.

The consumers are `inventory_rbac` (data model, api map), `inventory_data_handling`
(data model), `inventory_coverage` (api map, routes) and `plant_coverage` (api map,
routes). An input absent from every location keeps the consumer's existing finding code and,
in 2.3.1, its existing message. The message should name every location read and
`sense run inventory_regeneration` as the producer; that wording is deferred to a
follow-up. Two or more routes candidates in `plant_coverage` read
`PLANT_COVERAGE_ROUTES_AMBIGUOUS` (warning, REVIEW).

## Status and accounting

Rebuild must obtain a fresh typed result for the exact source HEAD or verify
machine-produced body/reading provenance against that HEAD and the exact body
bytes. It preserves the producer's status, findings, metrics, command hash and
input binding. Parsing arbitrary JSON or finding a body file never synthesizes
PASS. A prior FAIL/REVIEW or observation error cannot become PASS through rebuild.
Every required kind must be accounted for before regeneration completion can
PASS; successful production may preserve a producer REVIEW as that kind's real
measurement. A required producer that reads FAIL, UNKNOWN, `skipped` or error is a
production failure: the run reads FAIL and publishes nothing. Partial production remains
explicitly incomplete. Zero kinds retains `INVENTORY_REGENERATION_NO_KINDS_TOUCHED` /
REVIEW. Schema, extraction, head-binding or persistence errors remain explicit errors
with retained evidence.

Every body is validated against its schema before it is staged. A PASS body must validate
exactly. A producer that inventories nothing reads REVIEW and returns its primary
collection empty, which a schema requiring at least one item rejects (today the api-map
and rbac-inventory `minItems` collections). A REVIEW body whose only schema failures are
such empty required top-level collections is still staged and published as REVIEW: an
empty inventory is a true, reviewable result, not a production error. Every other schema
failure of a REVIEW body, and any schema failure of a PASS body, fails the run and
publishes nothing.

Aggregate metrics retain `kinds_touched`, `kinds_rebuilt`, `kinds_up_to_date` and
`error_count`, and expose which required kind is missing. A skipped-existing file
counts up-to-date only when its bound bytes and provenance match; path existence
alone is insufficient. Missing/stale input never disappears from the denominator.

The emitter's effect remains harness-write and it stays excluded from read-only
`sweep`. Inspector initiation with explicit write consent and all declared scopes is
required, on the framework and in an adopter alike. A regenerated reading is a new
immutable instance in `.devai/state/sensor-readings/<kind>/<id>.json`; it names an earlier
same-kind/same-candidate instance through `supersedes`. Preserve ID-conflict
refusal, exact-byte digest checking and chain append/repair semantics. A same-body
replay must not rewrite any recorded reading; timestamps do not select latest.
The aggregate `inventory_regeneration` reading is recorded with the same custody.

## Shipped regeneration

The repair is implemented in `packages/cli/src/commands/sense/readings-rebuild.ts` (#237,
ADR-SCR-0012) and is no longer provisional. Regeneration produces the combined F4 body
and the required kinds' bodies through their typed producers, keeps a producer's REVIEW
as REVIEW, and reads FAIL for a producer error, a missing required kind, or an aggregate
reading the store did not receive. It removes the body of a regenerated kind that the
plant-surface declaration no longer requires, then rebuilds the kinds it does not
regenerate from their recorded bodies. The extension to every surface-required kind
(#382, 2.3.1) amends that source under the contract above: every kind in the table is
regenerated and none falls back to a body-synthesized reading, and the state body of a
kind whose surface is declared absent is removed on publication. Finding codes and metric
names live in that source and in its tests; this note records only the contract. Its
remaining acceptance is the next recorded scorecard, which reads F4:T9 from a
regenerated, recorded instance.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
