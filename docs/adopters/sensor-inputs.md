# Sensor inputs

Sensor inputs are adopter declarations. Each sensor carries a default for a conventional
service layout; a repository with another layout declares where its inputs live once, in
`.devai/config/sensor-inputs.json`, under `law/schemas/sensor-inputs.schema.json`. The file is
materialized by `init bind` from the adopter default under
`law/policy/adopter-defaults/sensor-inputs.json`, which declares nothing, so every adopter
starts on the sensor defaults and declares only what differs (ADR-SCR-0005).

A declaration changes what a sensor reads, never what it concludes. Thresholds, verdict rules,
and N/A cells are untouched; the only way a declared input moves a cell is by giving its
sensor the evidence it was already looking for. Do not declare a path to hide a defect or a
missing test; declare it because the evidence exists there.

## Shape

The file holds a `schemaVersion` and an `inputs` object keyed by registered sensor kind from
`law/policy/sensor-registry.json`. Each kind accepts only the keys listed below, every path is
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

## Keys

| Kind                                                                                                   | Key             | Sensor default                      | What it changes                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------ | --------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test_security_coverage`, `test_performance_coverage`, `test_robustness_coverage`, `test_idiomaticity` | `testGlobs`     | `packages/*/test`, `packages/*/src` | The roots the test pattern walker expands and walks for `*.test.*` and `*.spec.*` files. A repository whose tests live elsewhere otherwise reads zero test files and reports F3:T5, F3:T6, F3:T7, and F3:T8 as missing coverage.                                                     |
| `spec_depth`                                                                                           | `adrDir`        | `docs/meta/adr`                     | The directory whose `*.md` files count as decision records. With no records found the sensor reports F1:T2 as incomplete or absent spec substrate.                                                                                                                                   |
| `spec_depth`                                                                                           | `invariantsDir` | `law/invariants`                    | The directory whose `*.json` files count as invariants for the same F1:T2 reading.                                                                                                                                                                                                   |
| `test_coverage_depth`                                                                                  | `coveragePath`  | `coverage/coverage-final.json`      | The Istanbul per-file coverage report the sensor normalizes into a lines percentage for F3:T2. A missing report reads `review` with `TEST_COVERAGE_REPORT_MISSING`; the declared path must be the per-file `coverage-final.json` shape, not the totals-only `coverage-summary.json`. |
| `action_effect_inference`                                                                              | `tsconfigPath`  | `tsconfig.effects.json`             | The TypeScript project the effect analyzer loads to infer action effects. Without a project at the default location the sensor cannot analyze the program.                                                                                                                           |
| `type_check`                                                                                           | `argv`          | `npx tsc --noEmit` against the root | The command the sensor executes for F2:T8, executable first, never joined through a shell. A workspace built from project references declares its own type check command instead of a bare root compile.                                                                             |
| `perf_test`                                                                                            | `scriptName`    | `test:perf`                         | The root package script the sensor runs and parses for a JSON metrics line for F2:T7. A missing script reads as unmeasurable.                                                                                                                                                        |

A kind that appears under `inputs` must declare at least one key. Kinds not listed above take
no declared input, and naming one is refused as an undeclared key.

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
`pnpm run typecheck` (the workspace type check over its project references) for `type_check`,
and `test:perf` for `perf_test`. The file is adopter-owned by the framework as its own
adopter, so it differs from the empty default and is not bound by
`check-policy-materialization`.
