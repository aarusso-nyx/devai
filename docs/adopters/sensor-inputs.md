# Sensor inputs

Sensor inputs are adopter declarations. Each sensor carries a default for a conventional
service layout; a repository with another layout declares where its inputs live once, in
`.devai/config/sensor-inputs.json`, under `law/schemas/sensor-inputs.schema.json`. The file is
materialized by `init bind` from the adopter default under
`law/policy/adopter-defaults/sensor-inputs.json`, which declares no input, so every adopter
starts on the sensor defaults and declares only what differs (ADR-SCR-0005). The same file
declares which plant [surfaces](#surfaces) the repository has (ADR-SCR-0003).

A declaration changes what a sensor reads, never what it concludes. Thresholds, verdict rules,
and N/A cells are untouched; the only way a declared input moves a cell is by giving its
sensor the evidence it was already looking for. Do not declare a path to hide a defect or a
missing test; declare it because the evidence exists there.

## Shape

The file holds a `schemaVersion`, an `inputs` object keyed by registered sensor kind from
`law/policy/sensor-registry.json`, and an optional `surfaces` object. Each kind accepts only the keys listed below, every path is
repository-relative without a leading slash or a parent segment, and `sense run` refuses a
key the schema does not list, a kind the registry does not hold, and a path that resolves
outside the repository root. An explicit `--input` for the same key overrides the declaration
for that run only; the sweep dry run prints the effective inputs per member.

```json
{
  "schemaVersion": "1.0.0",
  "inputs": {
    "spec_depth": { "adrDir": "law/adr" },
    "test_coverage_depth": { "coveragePath": "coverage/coverage-final.json" }
  }
}
```

## Admitted kinds

A kind is selectable only when the packaged schema admits it. The `sensor.kind` enum of
[`law/schemas/sensor-reading.schema.json`](../../law/schemas/sensor-reading.schema.json) is
closed, and every read kind the `sweep` preset selects from
[`law/policy/sensor-registry.json`](../../law/policy/sensor-registry.json) is in it: the sweep
members minus the enum is the empty set
([ADR-SCR-0011](../../law/adr/ADR-SCR-0011-sweep-kinds-admitted-by-the-packaged-schema.md)). The
invariant is written on the preset contract
([`law/policy/sense-presets.json`](../../law/policy/sense-presets.json), `selection_effect_rule`)
and is held by a source-level test, so the registry, the preset, and the schema an adopter
extracts from the package agree on the admitted set; an adopter preflight that compares the
packaged registry with the packaged schema finds no kind on one side only.

If a registry entry is ever intentionally unsupported by the schema, the entry says so
(`schema_admission` equal to `unsupported`) and `sense run` refuses that sensor before it starts
with `SENSOR_KIND_SCHEMA_UNSUPPORTED`; no reading is emitted for it, so no invalid reading reaches
a store. A failed or skipped sensor of an admitted kind records `fail` or `skipped` and is never
promoted to `pass`.

The four diagnostic kinds `decision_record_integrity`, `decision_citation_resolution`,
`archive_immutability`, and `round_record_integrity` are admitted under ADR-SCR-0011; they map to
no scorecard cell. The five schema-only values `api_test`, `contract_validation`, `db_test`,
`journey_test`, and `mutation_test` name no registry entry and are kept as legacy, listed on the
[sensor-kind catalog](../reference/cli/sensor-kinds.md#admitted-kinds-and-schema-only-legacy-values);
they take no declared input, and naming one under `inputs` is refused as a kind the registry does
not hold.

## Keys

| Kind                                                                                                   | Key                            | Sensor default                                                                                                                       | What it changes                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_security_coverage`, `test_performance_coverage`, `test_robustness_coverage`, `test_idiomaticity` | `testGlobs`                    | `packages/*/test`, `packages/*/src`                                                                                                  | The roots the test pattern walker expands and walks for `*.test.*` and `*.spec.*` files. A repository whose tests live elsewhere otherwise reads zero test files and reports F3:T5, F3:T6, F3:T7, and F3:T8 as missing coverage.                                                                                                                                                                                                                                             |
| `spec_depth`                                                                                           | `adrDir`                       | `docs/meta/adr`                                                                                                                      | The directory whose `*.md` files count as decision records. With no records found the sensor reports F1:T2 as incomplete or absent spec substrate.                                                                                                                                                                                                                                                                                                                           |
| `spec_depth`                                                                                           | `invariantsDir`                | `law/invariants`                                                                                                                     | The directory whose `*.json` files count as invariants for the same F1:T2 reading.                                                                                                                                                                                                                                                                                                                                                                                           |
| `test_coverage_depth`                                                                                  | `coveragePath`                 | `coverage/coverage-final.json`                                                                                                       | The Istanbul per-file coverage report the sensor normalizes into a lines percentage for F3:T2. A missing report reads `review` with `TEST_COVERAGE_REPORT_MISSING`; the declared path must be the per-file `coverage-final.json` shape, not the totals-only `coverage-summary.json`.                                                                                                                                                                                         |
| `action_effect_inference`                                                                              | `tsconfigPath`                 | `tsconfig.effects.json`                                                                                                              | The TypeScript project the effect analyzer loads to infer action effects. Without a project at the default location the sensor cannot analyze the program.                                                                                                                                                                                                                                                                                                                   |
| `type_check`                                                                                           | `argv`                         | `npx tsc --noEmit` against the root                                                                                                  | The command the sensor executes for F2:T8, executable first, never joined through a shell. A workspace built from project references declares its own type check command instead of a bare root compile.                                                                                                                                                                                                                                                                     |
| `unit_test`, `integration_test`, `e2e_test`                                                            | `argv`                         | `pnpm vitest run --config tests/config/t1.unit.config.ts` (unit), `t3.integration.config.ts` (integration), `t5.e2e.config.ts` (e2e) | The suite command the sensor executes for its suite, executable first, never joined through a shell, graded by exit code and the vitest summary line. A repository whose suites do not live in those configurations declares its own; with nothing declared the hardcoded configuration is the fallback. Under `sense run` the authority broker admits only the governed vitest shape `law/policy/subprocess-effects.json` declares.                                         |
| `perf_test`                                                                                            | `argv`                         | none                                                                                                                                 | The performance suite command the sensor executes for F2:T7, executable first, never joined through a shell, graded by exit code and duration and by a JSON metrics line when it prints one. When declared it takes precedence over `scriptName`. Under `sense run` the authority broker admits only the command shapes `law/policy/subprocess-effects.json` declares, such as `pnpm vitest run --config <governed-config> [<test-path>]`; a bare package script is refused. |
| `perf_test`                                                                                            | `scriptName`                   | `test:perf`                                                                                                                          | Legacy: the root package script the sensor runs as `pnpm <scriptName>` when no `argv` is declared. A missing script reads as unmeasurable.                                                                                                                                                                                                                                                                                                                                   |
| `harness_idiomaticity`                                                                                 | `minWorkflowsForReusableCheck` | `1` (always graded)                                                                                                                  | The workflow count at or above which the harness idiomaticity sensor grades the reusable-workflow signal for F5:T5. Below the declared threshold the signal is dropped from both the score and its denominator, not counted as missing, so a repository whose CI is too small to benefit from factoring out a reusable workflow is not graded against a shape it has not grown into.                                                                                         |
| `plant_depth`                                                                                          | `excludeGlobs`                 | none (every `packages/*/src` file)                                                                                                   | Repository-relative file globs left out of the plant whose file sizes F2:T2 grades; `*` matches within one path segment and a `**` segment matches any number of segments. Declare a glob only for files that are derived rather than authored, such as a view generated from a law policy (an F4 artifact); the pass and review thresholds stay the same.                                                                                                                   |

A kind that appears under `inputs` must declare at least one key. Kinds not listed above take
no declared input, and naming one is refused as an undeclared key.

## Surfaces

The inventory and plant sensors identify a plant through HTTP endpoints, routes, tables, roles,
and PII columns. A repository without one of those surfaces is not missing coverage of it, so the
file states which surfaces exist under `surfaces`, four keys, each `true` (present) or `false`
(absent). When the object is present all four keys are required; when it is omitted every surface
is presumed present and each sensor measures as it did before the declaration existed.

| Surface    | Present means                                                   | Absent means                                                                                                                                          |
| ---------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http`     | Routes, endpoints, an API map.                                  | `inventory_api` and `inventory_routes` skip; `inventory_coverage` and `plant_coverage` stop counting endpoints.                                       |
| `database` | Tables, migrations, a data model.                               | `inventory_data_model` skips; no table is expected.                                                                                                   |
| `rbac`     | Roles, permissions, PII-bearing columns.                        | `inventory_rbac` and `inventory_data_handling` skip.                                                                                                  |
| `actions`  | A registered action surface, `law/policy/action-registry.json`. | The action registry is not measured. Present, `plant_coverage` and `inventory_coverage` measure registered actions against their specification links. |

A sensor bound only to surfaces declared absent emits a `skipped` reading whose first finding
states the declaration as its reason. The scorecard composer lists a skipped reading in its cell
but never lets it move a verdict: a cell that holds any measured reading keeps the worst-of verdict
of the measured readings, and a cell whose readings are all skipped is recorded `N/A` with the
declaration reason in its notes, never `UNKNOWN` or `REVIEW`. A cell the N/A ledger lists stays a
ledger N/A regardless. The rule is stated in full under
[Declared surfaces and the skipped-reading rule](../theory/framework/scorecard.md#declared-surfaces-and-the-skipped-reading-rule).

The declaration is symmetric and it is checked. A surface declared present is measured, and a
sensor that finds evidence of a surface declared absent (a route, a table, a role) reports a
`review` finding rather than skipping, so declaring a surface absent to hide it is caught by the
sensor that found it. Declare a surface absent because the repository has none of it, never to
move a cell.

The adopter default declares the conventional service shape, `http`, `database`, and `rbac`
present and `actions` absent:

```json
{
  "schemaVersion": "1.0.0",
  "inputs": {},
  "surfaces": { "http": true, "database": true, "rbac": true, "actions": false }
}
```

## Declaring inputs

Add the kind and the keys that differ from the sensor default, keep the reason beside the
change in review, and validate the file against the schema installed by the exact CLI package:

```bash
devai check --only schema \
  --schema law/schemas/sensor-inputs.schema.json \
  --instance .devai/config/sensor-inputs.json \
  --as-role inspector --write --format json
```

Then read the sweep dry run (`devai sense run --preset sweep --round <round> --repo-root .
--dry-run`) and confirm each member lists the effective input you declared before running
the sweep for real. A valid file proves the shape, not the layout: a declared directory that
holds nothing still reads as absent.

## The framework repository

DEVAI's own file declares the framework layout: `packages/*/tests` and `tests` as test roots
for the four test pattern sensors, `law/adr` and `law/invariants` for `spec_depth`,
`scratch/coverage/rc/coverage-final.json` (the report the RC coverage gate writes) for
`test_coverage_depth`, `tests/config/tsconfig.effects.json` for `action_effect_inference`,
`npx tsc --noEmit -p tsconfig.typecheck.json` (a read-only check of the workspace against its
built project references; the broker refuses a bare package script such as `pnpm run typecheck`)
for `type_check`,
`pnpm vitest run --config tests/config/local.config.ts` over `tests/contract`,
`tests/integration`, and `tests/e2e` as the `argv` of `unit_test`, `integration_test`, and
`e2e_test`,
`pnpm vitest run --config tests/config/rc.performance.config.ts tests/regression` (the
performance configuration over the regression suite) as `perf_test`'s `argv`, `5` for `harness_idiomaticity`'s `minWorkflowsForReusableCheck`,
and `packages/cli/src/generated/**` for `plant_depth`'s `excludeGlobs`.
DEVAI's CI is four single-purpose workflows (`pull-request-checks`, `release`,
`site-publish`, `devai-ledger-verify`), three of which share their setup steps through a
composite action, and none of them has a job the others would reuse; factoring one of the
four out as a reusable workflow would not earn its keep at this size. Five is the point where it would, so below it the sensor drops
the reusable-workflow signal instead of grading DEVAI's CI against a shape it has not grown
into. The generated action registry view under `packages/cli/src/generated/` is rendered from
`law/policy/action-registry.json` and checked against it, so it is a derived F4 artifact, not
authored plant, and it stays out of the file sizes `plant_depth` grades. The file is
adopter-owned by the framework as its own adopter, so it differs from the
adopter default and is not bound by `check-policy-materialization`.

DEVAI is a command-line framework with no routes, tables, or roles, and sixty-one registered
actions, so its file declares only `actions` present:

```json
"surfaces": { "http": false, "database": false, "rbac": false, "actions": true }
```

Under that declaration the inventory sensors bound to `http`, `database`, and `rbac` skip,
`plant_coverage` and `inventory_coverage` measure the action registry, and the grid reads 45
cells, 2 ledger N/A (F1:T1, F4:T5), 1 declaration N/A (F4:T6, whose only sensors are
`inventory_rbac` and `inventory_data_handling`), 42 scoreable; F2:T1, F4:T1, and F4:T2 are
measured through the action surface. The scorecard page lists the cells and their bound sensors.
