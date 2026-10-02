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

The registry pairing is `inventory_adherence` → F4:T4 (ADR-SCR-0012).
The Owner chose inventory production on issue #237; the framework declares
`actions: true` in `.devai/config/sensor-inputs.json`. F4:T4 remains measured.
Only a declaration that every bound surface (`http`, `database`, `rbac`,
`actions`) is absent can produce reading-driven `skipped`. A contradictory
present surface is a finding. Neither missing inventory nor an empty report
establishes N/A or PASS; the ledger contains no waiver for this cell.

## Production and input contract

The combined body is `.devai/state/inventory/inventory.json`, produced by the
existing typed `regenerateInventory` operation under the registered observation
path. It validates against `law/schemas/inventory.schema.json`, retaining
`schemaVersion: 1.0.0`, `generated_at`, `integration_head`, modules, routes,
schemas, components, test inventory, dependency graph and governance checksums.
The producer supplies `{id, file}` tuples for reverse adherence; the schema's
legacy string-only modules cannot establish a complete file-surface denominator.
There is no new `actions` property in that closed schema.

Before measuring, the adapter verifies the body schema, a real full integration
SHA equal to the exact observed source HEAD, and its generated provenance.
Missing body/trace retains `INVENTORY_ADHERENCE_INPUT_MISSING` and UNKNOWN.
Malformed, stale, unbound, or incomplete required input yields an explicit
failure-to-observe diagnostic, never an empty PASS. A zero-SHA sentinel used by
isolated determinism tests is not an observation binding. A producer error is
not a measured verdict (Constitution Article 41).

For file-bearing modules, routes, components and dependency nodes, reverse
adherence keeps the existing `computeReverseAdherence` rule: a trace invariant's
`code_areas` must match the source file. The framework action denominator is
measured separately with the existing typed `measureActionLinkage` operation:
registered `law/policy/action-registry.json` action IDs versus explicit Owner
use-case step `refs.actionRefs[].id` references under `product/use-cases/`.
Those references are the action specification links already measured by
`inventory_coverage`; they do not prove handler-code trace adherence. Preserve
both obligations rather than treating an action link as a file claim.

The adapter combines file-surface and action-link counts in its transient report,
with one orphan per unclaimed file surface or unlinked registered action. It
retains each orphan's kind/id and each available source file; separate action
counts make the nonempty registered population independently inspectable. A
missing/invalid registry when actions are present is UNKNOWN, not zero actions.
Do not project action IDs into fabricated module IDs or invent source paths.

Thresholds remain: zero orphans PASS; 1–50 REVIEW; more than 50 FAIL, with the
existing declared `maxOrphans` override where already supported. Preserve the
existing partial/below-threshold/orphan findings and bounded orphan details.
No trace, use-case, threshold, or surface declaration is changed to obtain PASS.

The sensor reads inventory, trace and action specifications, not the readings
store. It remains read-only and runs in the first sweep pass. Measured readings
carry exact-head and input-digest evidence through existing reading metrics and
the recording chain; do not invent an undeclared top-level candidate field.

## Provisional preparation and acceptance

TASK-0631 preparation specifies this repair; it does not report it implemented.
See [inventory production](../../../docs/dev/operations/open-issue-closure-campaign/inventory-production.md)
for the exact source map, planned output population, scope-amendment prerequisites
and later adversarial acceptance. Original R-0601/R-0602 dependencies and all
validation gates remain. Refresh and independently review the exact composed
design after R-0602 source completion before downstream handoff. No generator,
runtime observation, or recording is authorized by this note.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
