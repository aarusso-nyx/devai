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
so both are required production kinds. The Owner chose production on issue #237;
the ledger has no N/A entry for this cell. A missing body cannot justify N/A.

The existing rebuild kind table contains `inventory_api`, `inventory_routes`,
`inventory_data_model`, `inventory_data_handling`, `inventory_rbac`,
`inventory_dep_graph`, and `inventory_coverage`. Retain these kinds and their
already-declared applicability. Framework `http`, `database` and `rbac` are absent;
produce no invented HTTP/database/RBAC bodies just to touch all seven kinds.
`inventory_data_handling` continues to respect ADR-SCR-0004's authored no-personal-
data declaration; its skipped/diagnostic result is not a PII production claim.

## Typed production, bodies and recording

Use the existing `regenerateInventory` producer for the combined F4 body and
existing `senseInventoryDepGraph` / `senseInventoryCoverage` operations for their
respective bodies and real readings. The shared inventory dependency edge-list
hash is not the sensor's `{graph: adjacency-list}` body. Generate each through its
own typed producer and validator. The coverage matrix is not the combined F4
manifest and its action-link metrics remain in the real reading.

The bounded state bodies for the two required framework kinds are:

- `.devai/state/sensors/inventory_dep_graph/dep-graph.json`, validated by
  `law/schemas/dep-graph.schema.json`.
- `.devai/state/sensors/inventory_coverage/coverage-matrix.json`, validated by
  `law/schemas/coverage-matrix.schema.json`.

These join `.devai/state/inventory/inventory.json` as machine outputs of the
registered observation/rebuild path. `sense run inventory_regeneration` regenerates all
of them for a clean HEAD commit, validates each against its schema, and publishes the
set together by atomic replacement only when every body is valid; a failure before
publication writes nothing, and a dirty working tree or missing candidate commit reads
UNKNOWN. Existing direct sensor defaults under
`record/proofs/sensors/<kind>/` stay distinct and are not silently relocated.
Read-only sweep adapters retain `persistBody: false`.

Rebuild must obtain a fresh typed result for the exact source HEAD or verify
machine-produced body/reading provenance against that HEAD and the exact body
bytes. It preserves the producer's status, findings, metrics, command hash and
input binding. Parsing arbitrary JSON or finding a body file never synthesizes
PASS. A prior FAIL/REVIEW or observation error cannot become PASS through rebuild.
Both required kinds must be accounted for before regeneration completion can
PASS; successful production may preserve a coverage REVIEW as that kind's real
measurement. Partial production remains explicitly incomplete. Zero kinds
retains `INVENTORY_REGENERATION_NO_KINDS_TOUCHED` / REVIEW. Schema, extraction,
head-binding or persistence errors remain explicit errors with retained evidence.

Aggregate metrics retain `kinds_touched`, `kinds_rebuilt`, `kinds_up_to_date` and
`error_count`, and expose which required kind is missing. A skipped-existing file
counts up-to-date only when its bound bytes and provenance match; path existence
alone is insufficient. Missing/stale input never disappears from the denominator.

The emitter's effect remains harness-write and it stays excluded from read-only
`sweep`. On the framework, Inspector initiation with explicit write consent and
all declared scopes is required. A regenerated reading is a new immutable
instance in `.devai/state/sensor-readings/<kind>/<id>.json`; it names an earlier
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
regenerate from their recorded bodies. The coverage kind is required unless both `http` and
`actions` are declared absent. Finding codes and metric names live in that source and in its
tests; this note records only the contract. Its remaining acceptance is the next recorded
scorecard, which reads F4:T9 from a regenerated, recorded instance.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
