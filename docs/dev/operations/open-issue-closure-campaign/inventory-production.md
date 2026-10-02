# Framework inventory production — TASK-0631 provisional design

This is **provisional early Architect preparation**, based on accepted central
source checkpoint `cb00b8a5ef1c0acce3bd249f660951b67ff20bd6`, tree
`88f53cf5fa46c5d42ae2a28333e70da29ad335e4`, under
`CMP0006-OD-EARLY-ARCH-20261002`. It reports design, not production or final PASS.
Original R-0601/R-0602 dependencies, full CTG-0631 locks and validation gates remain.
After R-0602 source completion, reacquire all ten scopes, refresh against the exact
accepted composed candidate, independently review and validate before a central
downstream permit. Expected central integrations do not rewrite this frozen base.

The Owner selected production in [issue #237 comment 5940972412](https://github.com/aarusso-nyx/devai/issues/237#issuecomment-5940972412).
The complete live comment read on 2026-10-02 found that one unchanged comment and
issue `updated_at: 2026-10-01T21:27:26Z`; remote main was
`180a122787193f9bdfce9b7f4cd5600e85ae7854`. This is entry evidence, not a continuing
freshness claim. [ADR-SCR-0012](../../../../law/adr/ADR-SCR-0012-inventory-cell-naming-amendment.md)
fixes the names: adherence F4:T4, regeneration F4:T9. Both remain measured;
[ADR-SCR-0004](../../../../law/adr/ADR-SCR-0004-framework-specification-substrate.md)
keeps the framework's authored specification substrate and no-personal-data
choice. There is no N/A amendment or waiver.

## Frozen source facts and repair seams

All line spans below refer to the preparation base; re-resolve them on refresh.

| Source                                                                 | Current behavior and required repair                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/loop/src/inventory/regen.ts:13-78,89-142`                    | `regenerateInventory` returns a typed `InventoryRecord` with source HEAD/timestamp, file-bearing modules/routes/components/dependencies, tests, schemas and checksums. It does not persist the canonical adherence body or produce sensor-specific adjacency/matrix bodies.    |
| `packages/skills/src/post-merge-auditor/observation-bundle.ts:133-218` | Existing observation calls that producer, validates inventory, and writes bundle inventory under the audit observation root. It is outside TASK-0633 ownership and remains read-only.                                                                                          |
| `packages/skills/src/post-merge-auditor/index.ts:46-113`               | `runAuditObservation` demands full `--at` equal to HEAD, obtains commit timestamp, validates replay digests, and publishes `.devai/state/audit-observations/<at>/` bundle. Preserve replay and non-promoting semantics.                                                        |
| `packages/cli/src/commands/audit/observe.ts:45-144`                    | Registered `audit observe` gates self-dogfood before writes, invokes observation and appends exact artifact evidence. Connect the bounded typed production here without replacing the existing bundle service.                                                                 |
| `packages/cli/src/commands/sense/adapter-readers.ts:152-180`           | Adherence loads `.devai/state/inventory/inventory.json` plus `law/trace.json`; missing input is UNKNOWN. No schema/head check or action denominator is currently applied.                                                                                                      |
| `packages/loop/src/inventory/adherence-reverse.ts:28-55,104-175`       | Reverse claims use file-bearing route/module/component/dependency tuples and invariant code-area globs. No actions field or action-to-handler-source mapping exists in this report. Preserve this helper outside ownership.                                                    |
| `packages/sensors/src/declared-surfaces.ts:179-247`                    | Existing typed action linkage compares registered action IDs to Owner use-case step `actionRefs`; it provides action and linked/unlinked counts. It is specification linkage, not handler-file trace.                                                                          |
| `packages/sensors/src/inventory-adherence.ts:57-118`                   | Current thresholds are 0 PASS, 1–50 REVIEW, >50 FAIL; a zero-surface report currently passes. Retain thresholds and make present-but-unobserved input diagnostic.                                                                                                              |
| `packages/cli/src/commands/sense/adapters.ts:220-241`                  | Required dep-graph/coverage read adapters call typed sensors with `persistBody: false`. Keep sweep read-only; this source is outside TASK-0633 ownership.                                                                                                                      |
| `packages/cli/src/commands/sense/readings-rebuild.ts:29-47,70-216`     | Seven-kind rebuild scans `.devai/state/sensors/<kind>/*.json`, then synthesizes PASS solely from JSON parse/path. ID seeds ignore body/head, existing paths are skipped, and no required-kind population is checked. Replace this incomplete reconstruction in its owned seam. |

The observation bundle's `inventory.json` is not the canonical adherence path.
Sensor defaults under `record/proofs/sensors/` are not the rebuild input directory.
There is no verified production body in this design session. Preserve reported
`INVENTORY_ADHERENCE_INPUT_MISSING` UNKNOWN and
`INVENTORY_REGENERATION_NO_KINDS_TOUCHED` REVIEW as existing findings until actual
new observations supersede them. Known schema/catalogue FAIL remains unresolved.

## Concrete schemas, populations and body paths

The combined [inventory schema](../../../../law/schemas/inventory.schema.json)
requires `schemaVersion`, `generated_at`, `integration_head`, `modules`, `routes`,
`schemas`, `components`, `test_inventory`, `dependency_graph_hash`. The typed
producer also emits `dependency_graph` and `checksums`. `additionalProperties`
is false; add no action/candidate fields. `integration_head` has only string
validation in this schema, so the operation separately enforces a full real SHA
and exact HEAD. Legacy schema-permitted modules without `{id,file}` cannot prove
complete reverse observation. The schema admits empty arrays; production must
not interpret an absent extraction or missing declared action population as an
empty measured PASS.

| Inventory/kind                                  | Typed producer               | Existing body schema                                                                                                      | Body consumed or planned                                                                                                                                                                                                        |
| ----------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined F4 manifest                            | `regenerateInventory`        | `inventory.schema.json`                                                                                                   | Canonical adherence input `.devai/state/inventory/inventory.json`; existing audit copy `.devai/state/audit-observations/<head>/inventory.json` remains independently bound.                                                     |
| `inventory_dep_graph` (required framework kind) | `senseInventoryDepGraph`     | `dep-graph.schema.json`, `{graph}` sorted adjacency list                                                                  | Planned `.devai/state/sensors/inventory_dep_graph/dep-graph.json`; existing direct default `record/proofs/sensors/inventory_dep_graph/dep-graph.json`.                                                                          |
| `inventory_coverage` (required framework kind)  | `senseInventoryCoverage`     | `coverage-matrix.schema.json`, routes/endpoints/useCases/links/unmapped and optional stats                                | Planned `.devai/state/sensors/inventory_coverage/coverage-matrix.json`; direct default `record/proofs/sensors/inventory_coverage/coverage-matrix.json`. Preserve real action-link metrics outside the closed body.              |
| `inventory_api`                                 | `senseInventoryApi`          | `api-map.schema.json`                                                                                                     | Existing direct default `record/proofs/sensors/inventory_api/api-map.json`; rebuild directory `.devai/state/sensors/inventory_api/`. Framework HTTP absent: no synthetic body.                                                  |
| `inventory_routes`                              | `senseInventoryRoutes`       | `routes-inventory.schema.json`                                                                                            | Existing direct default `record/proofs/sensors/inventory_routes/routes-<framework>.json`; rebuild directory `.devai/state/sensors/inventory_routes/`. No arbitrary first-file selection or alias manufacture.                   |
| `inventory_data_model`                          | `senseInventoryDataModel`    | `data-model-inventory.schema.json`                                                                                        | Existing direct default `record/proofs/sensors/inventory_data_model/data-model.json`; rebuild directory `.devai/state/sensors/inventory_data_model/`. Framework database absent.                                                |
| `inventory_data_handling`                       | `senseInventoryDataHandling` | `data-model-inventory.schema.json` for emitted PII-annotated model; authored declaration uses `data-handling.schema.json` | Existing default `record/proofs/sensors/inventory_data_handling/data-model-pii.json`; rebuild directory `.devai/state/sensors/inventory_data_handling/`. Preserve no-personal-data declaration and actual applicability/result. |
| `inventory_rbac`                                | `senseInventoryRbac`         | `rbac-inventory.schema.json`                                                                                              | Existing direct default `record/proofs/sensors/inventory_rbac/rbac.json`; rebuild directory `.devai/state/sensors/inventory_rbac/`. Framework RBAC absent.                                                                      |

Required framework production is the combined manifest plus dep-graph and
coverage. The dependency helper's edge list/hash is not the sensor adjacency
body. Coverage on actions-present/no-HTTP repositories still measures registered
use-case linkage; an empty HTTP triad array cannot upgrade its action REVIEW.
Do not hand-author any inventory, reading, proof, state, or pin.

## Exact-head production and measurement protocol

The following is the implementation contract for the later triplet, not an
executable preparation grant. Keep the current public actions and authority rows.

1. Resolve the declared repository, clean exact source HEAD `H`, tree, bound
   inputs and commit-derived timestamp. `audit observe --at H` preserves its
   exact-head refusal and non-promoting observation. A dirty source, moved HEAD,
   unsupported command, invalid bound input or missing role/consent stops before
   mutation. Never use a synthetic all-zero head as live evidence.
2. In the owned observation/regen seams, call `regenerateInventory` and the two
   existing typed sensor producers. For the sensor bodies use `persistBody: false`
   and the framework's resolved declarations; only the registered bounded writer
   materializes the three planned state bodies. Pin supplied `timestamp`/`now`
   consistently for exact-repeat byte comparison. Run existing validators before
   exposing inputs. Preserve real readings, findings and metrics from production.
3. Bind each body digest to `H`, tree, schema/producer/input identities and real
   reading IDs in machine-produced evidence. Use existing `SensorReading.metrics`
   for head/body/input digests and registered evidence-chain artifacts/notes for
   custody; do not add schema-forbidden top-level fields. The planned scalar
   metrics are `integration_head` (full SHA string), `integration_tree` (tree SHA
   string), `inventory_body_sha256` (64-hex SHA-256 of exact body bytes),
   `schema_sha256`, `inputs_sha256` and `producer_sha256` (64-hex digests),
   `body_path` (repository-relative string), and `producer_reading_id` only when
   that kind actually returned a real reading. The combined manifest producer
   has no reading ID; never invent one.
   `sensor-reading.schema.json` permits scalar string/number/boolean metric values;
   nested objects/arrays are not metric values. Freeze the canonical input-digest
   manifest: exact source tree, schema bytes, producer source bytes, bound sensor
   declarations, registry/use-case/trace bytes as applicable, timestamp and kind.
   Store its machine-produced manifest as an evidence-chain artifact only after
   its exact output path is declared in the bounded amendment. Bodies without
   native head fields need this verified provenance. Exact-match replay writes no
   old reading; a moved source requires a new candidate observation.
4. `sense run inventory_adherence` remains read-only. Validate canonical body,
   exact head/provenance and trace, compute reverse file claims, then measure
   registered action specification linkage via `measureActionLinkage`. Combine
   independent file and action orphan counts without inventing handler mappings.
   Keep separate action metrics. Missing/invalid action registry when present is
   UNKNOWN. Apply the unchanged 0/50 orphan thresholds and retain findings.
5. Inspector-initiated registered `sense record --rebuild` obtains fresh typed
   body/readings for `H` or verifies exact producer provenance. It records both
   required framework kinds and an aggregate regeneration reading, preserving
   real statuses and bytes. It does not recreate a minimal PASS from arbitrary
   JSON. No-kind is REVIEW; missing one required kind is incomplete, never PASS;
   extraction/schema/persistence failures are explicit observation errors.
   Regeneration completion can PASS when both valid bodies are produced while
   preserving a constituent coverage REVIEW as REVIEW in that reading.
6. Record readings through the existing immutable file and chain protocol:
   same-ID/different-body refuses; same-body replay checks digest and appends only
   a missing chain entry; later same-kind/same-head instances use `supersedes`.
   A prior FAIL is superseded only by a real newer observation of the same kind.
   The sweep stays first pass, Inspector record, second store-reader pass,
   Inspector record. Regeneration never joins the read-only sweep.
7. Compose final observations from the bound checkout's canonical reading store,
   not a detached worktree's empty store. Source production is not a main merge,
   runtime closure, release result or readiness promotion.

## Reading identity and unresolved resolver prerequisite

The existing `buildSensorReading` ID is the first 16 SHA-256 hex characters of
`JSON.stringify([sensorName, sensorKind, command_hash, status, sorted finding
severity/code/file/line strings, forceUniqueId ? timestamp : "", optional
"supersedes:<id>"])`, prefixed `SR-`. The builder does **not** hash body, head or
metrics. Provenance metrics alone never prevent an ID collision and never prove
custody. Preserve original measured status/findings/command hash.

In the owned rebuild and adherence emitter seams, use the existing builder's
`forceUniqueId: true` with the actual reading-creation/observation timestamp for a
new candidate instance; never invent a future recording time. A rebuild's creation
time may also be its recording time only when those operations coincide. Body
generation keeps the commit-derived deterministic timestamp as a separate input.
Later Inspector recording and exact verified replay preserve the emitted timestamp
and exact reading bytes; they never recompute the timestamp. A later actual same-kind,
same-candidate observation uses the supported `supersedes` input. A real timestamp
collision or conflicting ID refuses before mutation; do not change shared ID
rules or silently force another ID. The machine-produced chain artifacts bind
the resulting recorded ID and exact file digest to source/body/input evidence.
A raw producer reading with a candidate-agnostic ID is not independently bound
merely because its ID was copied into a metric.

`packages/loop/src/scorecard/latest.ts:11-85` currently groups supersession by
kind and selects surviving instances by timestamp/id, preserving failure over
UNKNOWN/SKIPPED. The current scorecard resolver is outside the five Engineer seams. Its latest
selection does not establish this design's exact-candidate custody merely from
provenance metrics. Before final observations, an independently reviewed bounded
scope amendment must identify the exact latest/candidate resolver source and its
Inspector fixtures, maintain the accepted same-kind/same-candidate supersession
contract, and reject unbound/stale/wrong-candidate readings. Do not call a
kind-only/timestamp-based winner exact-candidate selection. This is a recorded
prerequisite, not permission to modify shared identity or resolver source now.

## Owned implementation and prerequisite amendments

TASK-0633 may change only `packages/loop/src/inventory/regen.ts`,
`packages/cli/src/commands/audit/observe.ts`,
`packages/cli/src/commands/sense/readings-rebuild.ts`,
`packages/cli/src/commands/sense/adapter-readers.ts` and
`packages/sensors/src/inventory-adherence.ts`. Reuse imported typed producers;
keep the combined producer read-only for existing callers. A bounded companion
operation may return validated bodies/readings; persistence belongs to the
already registered writer's admitted output population. Do not edit sensor
producer source, `adherence-reverse.ts`, observation-bundle service, action
registry, schema, policy or tests under Engineer authority.

Before producer execution, independently review exact planned output targets
against the effective action planner, filesystem capability/subject and
self-dogfood write population. Generic `fs:f5-state` capability is not proof of a
particular sink grant. If canonical inventory, two required body paths, provenance
or chain append needs a target/scope the current declaration does not admit,
central must accept a bounded amendment naming the exact law/source/test/output
paths, responsible roles, complete locks and validation. Likewise, modification of a
recording helper outside the five Engineer seams or changed canonical scorecard
candidate filtering requires an exact amendment first. No such scope is widened
by this design. Preserve default adopter lifecycles and read-only adapter effects.

This preparation writes only two sensor notes and this operations document.
Toolchain/dependency/bootstrap prerequisites have a separate bounded proposal;
no build, generator, runtime or production effect is included in source entry.
A narrower TypeScript bootstrap is not reported as the required full root build.
Until that prerequisite is resolved, declared bin acceptance is NOT RUN. Never
copy mutable sibling dist/node_modules/bootstrap or substitute a fixture for a
live production observation.

## Later Inspector counterexamples and final admission

TASK-0632 owns only the declared two new test files. Its exact composed-base
counterexamples must cover:

- Missing canonical inventory and trace; malformed body; stale/missing/zero head;
  body digest mismatch; source movement during generation; no empty PASS.
- Schema-valid legacy/empty inventories that conceal a nonempty action registry;
  missing registry and unlinked registered action remain visible. Removing one
  action reference increases action orphans; claiming a file does not claim an
  action or vice versa. Threshold boundaries 0/50/51 remain unchanged.
- Exact production of all three bodies from real frozen source via registered
  paths, correct body schemas, head/digest binding, and repeat byte equality.
  Dep-graph adjacency and combined edge-list hash are not interchanged.
- Read-only sweep leaves body/reading/proof files unchanged; framework absence
  declarations do not manufacture HTTP/database/RBAC bodies; actions stay measured.
- Rebuild with zero/one required kind, malformed JSON, schema-invalid but parseable
  body, stale provenance and failing/reviewing producer. None fabricates PASS or
  drops failures. Both valid required kinds allow regeneration completion while
  intrinsic coverage REVIEW/FAIL remains unchanged in its recorded reading.
- Same-ID conflicting bytes refuse, same-body replay edits nothing, newer instance
  binds the same candidate and `supersedes`, missing chain entry repairs by append,
  digest tamper fails, detached-store observation cannot replace bound evidence.
- Missing role/write consent or an undeclared output path refuses before any
  target mutation, including partial output and chain targets.

After Inspector RED and its declared Engineer handoff, TASK-0633 runs the two
focused tests, then wave `test:loop`/`test:sensors` and all affected mandatory
checks on the exact composed candidate. TASK-0631 retains its declared `adrs`,
`schemas`, `docs-links` acceptance, formatting and precommit requirements. Existing
schema/catalogue FAIL is never provisional PASS. Source-design review establishes
only a provisional design checkpoint; required validation, R-0602 completion,
refreshed independent review and central downstream permission remain outstanding.
