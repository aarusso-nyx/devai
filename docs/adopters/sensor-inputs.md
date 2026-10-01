# Sensor inputs

Sensor inputs are adopter declarations. Each sensor carries a default for a conventional
service layout; a repository with another layout declares where its inputs live once, in
`.devai/config/sensor-inputs.json`, under `law/schemas/sensor-inputs.schema.json`. The file is
materialized by `init bind` from the adopter default under
`law/policy/adopter-defaults/sensor-inputs.json`, which declares only the
[CI population](#the-harness-sensor-population) of the three harness sensors, so every adopter
starts on the sensor defaults and declares only what differs (ADR-SCR-0005,
[ADR-SCR-0010](../../law/adr/ADR-SCR-0010-ci-sampling-contract.md)). The same file
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

| Kind                                                                                                   | Key                            | Sensor default                                                                                                                       | What it changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test_security_coverage`, `test_performance_coverage`, `test_robustness_coverage`, `test_idiomaticity` | `testGlobs`                    | `packages/*/test`, `packages/*/src`                                                                                                  | The roots the test pattern walker expands and walks for `*.test.*` and `*.spec.*` files. A repository whose tests live elsewhere otherwise reads zero test files and reports F3:T5, F3:T6, F3:T7, and F3:T8 as missing coverage.                                                                                                                                                                                                                                                                                                                                                    |
| `spec_depth`                                                                                           | `adrDir`                       | `docs/meta/adr`                                                                                                                      | The directory whose `*.md` files count as decision records. With no records found the sensor reports F1:T2 as incomplete or absent spec substrate.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `spec_depth`                                                                                           | `invariantsDir`                | `law/invariants`                                                                                                                     | The directory whose `*.json` files count as invariants for the same F1:T2 reading.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test_coverage_depth`                                                                                  | `coveragePath`                 | `coverage/coverage-final.json`                                                                                                       | The Istanbul per-file coverage report the sensor normalizes into a lines percentage for F3:T2; the declared path must be the per-file `coverage-final.json` shape, not the totals-only `coverage-summary.json`. When the report is absent the sensor runs the declared producer for the population; a producer that exits non-zero reads FAIL with its exit code, and a report still missing after a zero exit reads FAIL with `COVERAGE_REPORT_MISSING`, never `error` and never `review` ([ADR-SCR-0007](../../law/adr/ADR-SCR-0007-e2e-and-bounded-coverage.md)).                |
| `test_coverage_depth`                                                                                  | `population`                   | none                                                                                                                                 | The name of the test population the report measures, `local` or `rc`. The producer writes a `population.json` sidecar beside the report; the sensor refuses a report whose sidecar names another population, and every reading states the population it measured in `metrics` and in its finding text, so a ratio over one population is never presented as a ratio over another. See [The coverage population](#the-coverage-population).                                                                                                                                          |
| `test_coverage_depth`                                                                                  | `exclusions`                   | none                                                                                                                                 | The test files the declared population leaves out, named one by one. The sensor refuses a report whose sidecar lists a different exclusion set, with the mismatch named. An exclusion changes the denominator the reading states, never a threshold.                                                                                                                                                                                                                                                                                                                                |
| `action_effect_inference`                                                                              | `tsconfigPath`                 | `tsconfig.effects.json`                                                                                                              | The TypeScript project the effect analyzer loads to infer action effects. Without a project at the default location the sensor cannot analyze the program.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `type_check`                                                                                           | `argv`                         | `npx tsc --noEmit` against the root                                                                                                  | The command the sensor executes for F2:T8, executable first, never joined through a shell. A workspace built from project references declares its own type check command instead of a bare root compile.                                                                                                                                                                                                                                                                                                                                                                            |
| `unit_test`, `integration_test`, `e2e_test`                                                            | `argv`                         | `pnpm vitest run --config tests/config/t1.unit.config.ts` (unit), `t3.integration.config.ts` (integration), `t5.e2e.config.ts` (e2e) | The suite command the sensor executes for its suite, executable first, never joined through a shell, graded by exit code and the vitest summary line. A repository whose suites do not live in those configurations declares its own; with nothing declared the hardcoded configuration is the fallback. Under `sense run` the authority broker admits only the governed vitest shape `law/policy/subprocess-effects.json` declares. The suite reads PASS when every file passes, FAIL with the failed count when any file fails, and `error` only when vitest itself does not run. |
| `perf_test`                                                                                            | `argv`                         | none                                                                                                                                 | The performance suite command the sensor executes for F2:T7, executable first, never joined through a shell, graded by exit code and duration and by a JSON metrics line when it prints one. When declared it takes precedence over `scriptName`. Under `sense run` the authority broker admits only the command shapes `law/policy/subprocess-effects.json` declares, such as `pnpm vitest run --config <governed-config> [<test-path>]`; a bare package script is refused.                                                                                                        |
| `perf_test`                                                                                            | `scriptName`                   | `test:perf`                                                                                                                          | Legacy: the root package script the sensor runs as `pnpm <scriptName>` when no `argv` is declared. A missing script reads as unmeasurable.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `build`                                                                                                | `argv`                         | the `build` node of `test-tasks.json`, else the root package `build` script                                                          | The build command the sensor executes for F2:T9, executable first, never joined through a shell, graded by exit code. Admitted only when `test-tasks.json` has no `build` node; see [Build command precedence](#build-command-precedence). Under `sense run` the authority broker admits only the build shape `law/policy/subprocess-effects.json` declares (`pnpm -r build`); a declared argv outside it is refused before a process starts.                                                                                                                                       |
| `build`                                                                                                | `cwd`                          | the repository root                                                                                                                  | The repository-relative directory the build command runs from, under the same path grammar as the other inputs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `harness_idiomaticity`                                                                                 | `minWorkflowsForReusableCheck` | `1` (always graded)                                                                                                                  | The workflow count at or above which the harness idiomaticity sensor grades the reusable-workflow signal for F5:T5. Below the declared threshold the signal is dropped from both the score and its denominator, not counted as missing, so a repository whose CI is too small to benefit from factoring out a reusable workflow is not graded against a shape it has not grown into.                                                                                                                                                                                                |
| `plant_depth`                                                                                          | `excludeGlobs`                 | none (every `packages/*/src` file)                                                                                                   | Repository-relative file globs left out of the plant whose file sizes F2:T2 grades; `*` matches within one path segment and a `**` segment matches any number of segments. Declare a glob only for files that are derived rather than authored, such as a view generated from a law policy (an F4 artifact); the pass and review thresholds stay the same.                                                                                                                                                                                                                          |
| `harness_green_main`, `harness_performance`, `harness_robustness`                                      | `workflow`                     | none (required)                                                                                                                      | The workflow file under `.github/workflows` whose runs the sensor samples for F5:T9, F5:T7, or F5:T8, passed to `gh run list` as `--workflow <file>`. See [The harness sensor population](#the-harness-sensor-population).                                                                                                                                                                                                                                                                                                                                                          |
| `harness_green_main`, `harness_performance`, `harness_robustness`                                      | `event`                        | none (required)                                                                                                                      | The event whose runs are sampled, one of `push`, `pull_request`, `merge_group`, `workflow_dispatch`, or `schedule`, passed as `--event <event>`. The workflow must carry the event under its `on:` block; the declared-inputs contract test rejects one that does not.                                                                                                                                                                                                                                                                                                              |
| `harness_green_main`, `harness_performance`, `harness_robustness`                                      | `headBranch`                   | `*` (any head branch)                                                                                                                | A literal branch reference, passed as the single `--branch <ref>` option, or `*` to keep every head branch and pass no `--branch` option. A gate that runs on pull requests declares `*`, since a pull request's head branch is never the base branch.                                                                                                                                                                                                                                                                                                                              |
| `harness_green_main`, `harness_performance`, `harness_robustness`                                      | `baseBranch`                   | `main`                                                                                                                               | The branch the sampled runs target, applied by the sensor after the `gh run list` call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `harness_green_main`, `harness_performance`, `harness_robustness`                                      | `attempts`                     | `last`                                                                                                                               | Whether only the last attempt of each run counts (`last`, so a rerun replaces the attempt it retried) or every attempt counts (`all`).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `harness_green_main`, `harness_performance`, `harness_robustness`                                      | `includeCancelled`             | `false`                                                                                                                              | Whether cancelled runs count. `false` leaves them out of the sample and the denominator; `true` counts a cancelled run as one that did not succeed.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `harness_green_main`, `harness_performance`, `harness_robustness`                                      | `lookbackDays`                 | `30`                                                                                                                                 | How many days back a run may have been created and still be sampled. The `since` input of `harness_green_main` is kept and applied after this filter.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `harness_green_main`, `harness_performance`, `harness_robustness`                                      | `minimumSample`                | none (required)                                                                                                                      | How many runs the population must hold before the sensor states a verdict: sampled runs for `harness_green_main` and `harness_robustness`, successful runs for `harness_performance`. Below it the reading is `UNKNOWN` with `sample_size` and `minimum_sample` in the finding, never FAIL and never PASS; at or above it the verdict is the measured one under the unchanged thresholds.                                                                                                                                                                                           |
| `harness_green_main`, `harness_performance`, `harness_robustness`                                      | `excludedJobs`                 | none                                                                                                                                 | Workflow-and-job pairs (`{ "workflow", "job" }`, the job key under `jobs:`) left out of the sample by identity, never by duration: jobs that wait on a protected environment, whose wall-clock time would otherwise enter the performance median. A slow run of the sampled workflow stays in and can drive FAIL.                                                                                                                                                                                                                                                                   |

A kind that appears under `inputs` must declare at least one key. Kinds not listed above take
no declared input, and naming one is refused as an undeclared key.

## The harness sensor population

`harness_green_main`, `harness_performance`, and `harness_robustness` read GitHub Actions run
history through `gh run list`, and a sample is only as meaningful as the population it was
drawn from. Before [ADR-SCR-0010](../../law/adr/ADR-SCR-0010-ci-sampling-contract.md) the
three sensors sampled the last runs on head branch `main`; a gate that runs on pull requests
has a head branch that is never `main`, so the sample did not contain the workflow it meant to
measure (#154). Each sensor therefore declares its population: `workflow` and `event` are
required and name the runs; `headBranch`, `baseBranch`, `attempts`, `includeCancelled`, and
`lookbackDays` narrow them; `minimumSample` is required and says how many runs make a verdict;
`excludedJobs` leaves out workflow-and-job pairs by identity. The declaration is part of the
reading's `metrics`, so a scorecard reader sees what was sampled. Below the minimum each sensor
reads `UNKNOWN` with the sample size, the minimum, and the population in the finding, never
FAIL and never PASS; at or above it the verdict is the measured one, including FAIL when the
gate is red or slow. No threshold changes.

The declaration drives the argv: a literal `headBranch` is passed as the single `--branch`
option and `*` passes none, so the broker admits four exact `gh run list` shapes
(`gh-run-list`, `gh-run-list-created`, `gh-run-list-branch`, `gh-run-list-branch-created` in
[`law/policy/subprocess-effects.json`](../../law/policy/subprocess-effects.json)), each with
`--workflow <file>` and `--event <event>` under the grammar the schema fixes; a value outside
it, a second `--branch`, or any other option is refused before a process starts.

The adopter default declares a conventional gate, `ci.yml` on `pull_request` against `main`,
any head branch, last attempt only, cancelled runs excluded, thirty days, twenty runs for
`harness_green_main` and `harness_robustness` and ten successful runs for
`harness_performance`, and no excluded job. An adopter whose gate runs on pushes to `main`
declares `push` with `headBranch` `main` and loses nothing:

```json
{
  "schemaVersion": "1.0.0",
  "inputs": {
    "harness_green_main": {
      "workflow": "ci.yml",
      "event": "push",
      "headBranch": "main",
      "minimumSample": 20
    }
  }
}
```

## The coverage population

A coverage ratio is only as meaningful as its denominator, so the `test_coverage_depth`
declaration names the population beside the report
([ADR-SCR-0007](../../law/adr/ADR-SCR-0007-e2e-and-bounded-coverage.md)). The producer that
writes the report also writes a `population.json` sidecar beside it naming the population, the
include globs, the excluded suites, and the count of files measured; the sensor reads the
sidecar and refuses a report whose population or exclusion list differs from the declaration.
The reading then states the population in `metrics` and in its finding text, so two scorecards
measured over different populations are read as such and never compared ratio to ratio.

The framework declares the `local` population: `LOCAL_INCLUDE` from
`tests/config/local.config.ts`, produced by `tests/config/local.coverage.config.ts` through
`pnpm test:coverage:local` into `scratch/coverage/local/coverage-final.json` without a
database, excluding the RC-only and database-bound suites that configuration lists as
`RC_ONLY`. The maintainer decided on 2026-09-28 that no test database is provided for the next
scorecard, so the local population is what the framework measures. The RC lane
(`tests/config/rc.coverage.config.ts`, `test:coverage:rc`, the `CHECK_RC_DB_TESTS_REQUIRED`
refusal without `DEVAI_DB_TESTS`) is unchanged; when a database is provided, the `rc`
population is a second reading beside the local one, not a replacement, and it carries the
larger denominator.

```json
{
  "schemaVersion": "1.0.0",
  "inputs": {
    "test_coverage_depth": {
      "coveragePath": "scratch/coverage/local/coverage-final.json",
      "population": "local",
      "exclusions": ["tests/integration/authority-effect-postgres.db.test.ts"]
    }
  }
}
```

## Build command precedence

The `build` sensor is a write: the compiler materializes its outputs under the package
directories, so the sensor runs with `--write`, stays out of the `sweep` preset, and records
its reading as a harness-write. Its command comes from two sources in a fixed order
([ADR-AUT-0002](../../law/adr/ADR-AUT-0002-sensing-process-admission.md); the template
`pnpm-recursive-build` in
[`law/policy/subprocess-effects.json`](../../law/policy/subprocess-effects.json) declares the
order as `argv_precedence`):

1. The `build` node of `test-tasks.json`. When the descriptor carries that node, its `argv`
   and `cwd` are the command, and no declaration replaces them.
2. The `build` entry of `.devai/config/sensor-inputs.json`, admitted only when the descriptor
   has no `build` node. This is the adopter case without a descriptor.

Declaring a `build` argv beside a descriptor `build` node that names a different argv is a
declaration defect, not a preference: the declared-inputs contract test fails naming both
argv, and at run time the sensor reads `error` with `BUILD_ARGV_CONFLICT`. With neither source
the sensor falls back to the root package `build` script through the lockfile's package
manager, and with no script it reads `skipped` with `BUILD_NOT_DECLARED`. Whichever source
supplies the argv, the broker admits only the declared shape, `pnpm -r build`, under
`sense run`; a selected argv outside it is refused before any process starts and the sensor
reports the refusal rather than a reading. A failing build reads FAIL with its exit code and
stays visible on the scorecard.

```json
{
  "schemaVersion": "1.0.0",
  "inputs": {
    "build": { "argv": ["pnpm", "-r", "build"], "cwd": "." }
  }
}
```

## GitHub CLI shapes the broker admits

Harness sensors reach GitHub only through the GitHub CLI shapes
[`law/policy/subprocess-effects.json`](../../law/policy/subprocess-effects.json) declares and
the authority broker admits without a host adapter. Beyond `gh auth`, `gh auth status`, and
the four `gh run list` shapes of the [harness sensor population](#the-harness-sensor-population)
(`gh run list --workflow <file> --event <event> [--branch <ref>] --json <fields> --limit <n>
[--created >=<date>]`, one template per combination of the optional pairs), the `site_drift` sensor reads the Pages
publication journal through two exact read-only `gh api` GET shapes
([ADR-AUT-0002](../../law/adr/ADR-AUT-0002-sensing-process-admission.md)):

| Template                           | Argv                                                                                        | Reads                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `gh-api-pages-deployments`         | `gh api /repos/<owner>/<repo>/deployments?environment=devai-pages-publication&per_page=100` | The Pages publication deployments the journal records.                                                    |
| `gh-api-pages-deployment-statuses` | `gh api /repos/<owner>/<repo>/deployments/<id>/statuses?per_page=100`                       | The statuses of one deployment: the publication intent and its verification. `<id>` is a decimal integer. |

In both, `<owner>/<repo>` is the journal repository the sensor declares, the endpoint and
query are fixed strings, the method is the implicit GET, and every option is refused,
including `--method`, `-X`, `-f`, `-F`, `--field`, `--raw-field`, `--input`, `--paginate`,
and `--hostname`. An argv that names another repository, a non-integer deployment id, or a
third endpoint is refused although the method is GET, and `site_drift` reports the refused argv
verbatim. With the shapes admitted the sensor reads PASS when the local `gh-pages` tip matches
the last verified identity, REVIEW with `journal-not-verified` or `journal-no-matching-intent`
when the journal holds no usable record, and FAIL when the tip differs; it reads
`SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED` only for an argv the broker actually refuses. The
broker's literal list is the executable policy and the templates describe it; every future
read-only `gh` shape follows the same path of broker literal, mirrored template, and mirror
test.

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
present and `actions` absent, beside the harness population above (shown here for one of the
three kinds; `harness_performance` and `harness_robustness` repeat it with their own
`minimumSample`):

```json
{
  "schemaVersion": "1.0.0",
  "inputs": {
    "harness_green_main": {
      "workflow": "ci.yml",
      "event": "pull_request",
      "headBranch": "*",
      "baseBranch": "main",
      "attempts": "last",
      "includeCancelled": false,
      "lookbackDays": 30,
      "minimumSample": 20,
      "excludedJobs": []
    }
  },
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
`scratch/coverage/local/coverage-final.json` with `population` `local` and the four `RC_ONLY`
suites of `tests/config/local.config.ts` as `exclusions` (the report the database-free local
producer writes; see [The coverage population](#the-coverage-population)) for
`test_coverage_depth`, `tests/config/tsconfig.effects.json` for `action_effect_inference`,
`npx tsc --noEmit -p tsconfig.typecheck.json` (a read-only check of the workspace against its
built project references; the broker refuses a bare package script such as `pnpm run typecheck`)
for `type_check`,
`pnpm vitest run --config tests/config/local.config.ts` over `tests/contract` and
`tests/integration` as the `argv` of `unit_test` and `integration_test`,
`pnpm vitest run --config tests/config/rc.e2e.config.ts` with no test path as the `argv` of
`e2e_test` (the governed e2e configuration selects `tests/e2e/**/*.test.ts` itself and leaves
out the inventory smoke file; `LOCAL_INCLUDE` selects nothing under `tests/e2e`, so the
earlier declaration over `local.config.ts` measured an empty population),
`pnpm vitest run --config tests/config/rc.performance.config.ts tests/regression` (the
performance configuration over the regression suite) as `perf_test`'s `argv`, `5` for `harness_idiomaticity`'s `minWorkflowsForReusableCheck`,
`packages/cli/src/generated/**` for `plant_depth`'s `excludeGlobs`, and for the three harness
sensors the population of the gate: `pull-request-checks.yml` on `pull_request`, any head
branch (`*`), base `main`, last attempt only, cancelled runs excluded, thirty days, a minimum
of twenty runs for `harness_green_main` and `harness_robustness` and ten successful runs for
`harness_performance`, and the four environment-gated jobs of `release.yml` (`verify-ledger`,
`build-release`, `finalize-release`, `deploy-pages`) excluded by identity, so a release
rehearsal's approval waits never enter the performance median. It declares no
`build` input: DEVAI's `test-tasks.json` carries a `build` node (`pnpm -r build` from the
repository root), and under the [precedence above](#build-command-precedence) that node is the
build sensor's command and a declaration beside it is not admitted.
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
