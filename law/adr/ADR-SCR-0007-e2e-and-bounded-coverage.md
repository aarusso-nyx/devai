---
id: ADR-SCR-0007
title: The governed e2e configuration and a database-free coverage producer with a declared denominator
type: adr
status: accepted
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0002
  - ADR-SCR-0003
  - ADR-SCR-0005
  - ADR-GOV-0002
  - tests/config/rc.e2e.config.ts
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - .devai/config/sensor-inputs.json
  - law/schemas/sensor-inputs.schema.json
  - packages/cli/src/authority/broker.ts
  - law/policy/subprocess-effects.json
  - tests/config/rc.e2e.config.ts
  - tests/config/local.coverage.config.ts
  - packages/sensors/src/test.ts
  - packages/sensors/src/test-coverage-depth.ts
  - package.json
  - law/policy/sensor-notes/e2e_test.md
  - law/policy/sensor-notes/test_coverage_depth.md
inspector_acceptance:
  - IA-001 -- With one file under tests/e2e made to fail, sense run e2e_test as inspector records FAIL carrying the failed count from the vitest summary; with every file passing it records PASS; neither run reads error.
  - IA-002 -- An e2e argv that names a configuration outside the broker's governed list, or that appends a path outside tests/, is refused before vitest starts and the refusal names the argv.
  - IA-003 -- With no scratch/coverage/local report present and no database reachable, sense run test_coverage_depth runs the local producer and records the measured ratio; a producer that exits non-zero reads FAIL with its exit code, and a report missing after a zero exit reads FAIL with COVERAGE_REPORT_MISSING, never error.
  - IA-004 -- A coverage report whose recorded population is not the declared local population, or whose exclusion list differs from the declaration, is rejected with the mismatch named, so a stale RC report is never read as the local measurement.
  - IA-005 -- Adding tests/e2e or tests/regression to LOCAL_INCLUDE fails the population contract test, so pnpm test and test:local-full keep their population, and the RC lane still refuses without DEVAI_DB_TESTS with CHECK_RC_DB_TESTS_REQUIRED.
---

# The governed e2e configuration and a database-free coverage producer with a declared denominator

## Status

Accepted on 2026-10-01 by the Architect as drafted, after the Owner
accepted it on 2026-09-30; round R-0401 of CMP-0004 implements it. Proposed on
2026-09-28 from the harness convergence brainstorm and its independent
review. Changes the declared e2e and
coverage inputs of ADR-SCR-0005 and adds one governed configuration; the RC
coverage lane and its database gate are unchanged.

## Context

The declared `e2e_test` argv in `.devai/config/sensor-inputs.json` runs
`pnpm vitest run --config tests/config/local.config.ts tests/e2e`, and
`LOCAL_INCLUDE` in `tests/config/local.config.ts` selects no file under
`tests/e2e`, so the sensor measures an empty population and the cell it
feeds reads nothing useful (#156). `tests/config/rc.e2e.config.ts` exists,
selects `tests/e2e/**/*.test.ts`, and excludes the inventory smoke file, but
the broker's governed configuration list does not name it. Coverage exists
only behind `tests/config/rc.coverage.config.ts`, which refuses to start
without `DEVAI_DB_TESTS=1` and a reachable database, so
`test_coverage_depth` reads REVIEW with `Coverage report not found` on every
checkout that lacks one (#161). The maintainer decided on 2026-09-28 that no
test database is provided for the next scorecard, so the local population is
what the framework measures.

## Decision

The `e2e_test` argv declares `pnpm vitest run --config
tests/config/rc.e2e.config.ts`. The broker's governed configuration list in
`packages/cli/src/authority/broker.ts` admits `tests/config/rc.e2e.config.ts`
and `tests/config/local.coverage.config.ts`, and the template
`pnpm-vitest-run-governed-config` in `law/policy/subprocess-effects.json` is
mirrored to the same list. `LOCAL_INCLUDE` is unchanged, so `pnpm test` and
`test:local-full` keep their population, and the population contract test
fails when a change adds `tests/e2e` or `tests/regression` to it. This is
option 2 of #156, chosen because the configuration already exists and the
local suite must not absorb the e2e files.

A new `tests/config/local.coverage.config.ts` produces
`scratch/coverage/local/coverage-final.json`. It includes `LOCAL_INCLUDE`,
excludes the RC-only and database-bound suites by name, writes a JSON
report, and has no `DEVAI_DB_TESTS` gate. The report is accompanied by a
`scratch/coverage/local/population.json` sidecar that names the population
(`local`), the include globs, the excluded suites, and the count of files
measured. `package.json` gains `test:coverage:local` for it. The RC lane,
its configuration, and `test:coverage:rc` are unchanged.

The `test_coverage_depth` input in `.devai/config/sensor-inputs.json` points
`coveragePath` at the local report and gains `population: local` and an
`exclusions` list; `law/schemas/sensor-inputs.schema.json` carries both
fields. The sensor runs the declared producer when the report is absent,
reads the sidecar, and refuses a report whose population or exclusions
differ from the declaration. Its reading states the population it measured
in `metrics` and in the finding text, so a local ratio is never presented as
an RC ratio.

The verdicts are measured outcomes. `e2e_test` reads PASS when every file
passes, FAIL with the failed count when any file fails, and `error` only
when vitest itself does not run. `test_coverage_depth` reads PASS, REVIEW,
or FAIL from the measured ratio against its thresholds; a producer that
exits non-zero reads FAIL with its exit code and stderr head; a report
missing after a zero exit reads FAIL with `COVERAGE_REPORT_MISSING`. A
missing file or a missing prerequisite is never an `error` reading, because
the producer is part of the sensor's own command.

## Consequences

F2 gains a measured e2e cell and a measured coverage cell on every checkout,
and both can read FAIL. The coverage number carries a smaller denominator
than the RC number and says so; a reader comparing scorecards reads the
population before the ratio. The task-policy digest changes with the broker
literal and the template, in the same round as ADR-AUT-0002. The next
scorecard measures the declared local population, as the Owner decided; when
a database is later provided, the RC reading is a second population beside
the local one, not a replacement.

## Alternatives Considered

Option 1, adding `tests/e2e` to `LOCAL_INCLUDE`, is rejected because it
changes the population of `pnpm test` and of every local task that consumes
the configuration. Pointing `coveragePath` at the RC report and providing a
database for the scorecard is rejected by the maintainer decision of
2026-09-28. Reading REVIEW for a missing report is rejected because it
records the absence of a prerequisite as a verdict on the code. Enforcing
the RC thresholds inside the local configuration is rejected because the
sensor already applies thresholds and two enforcement points would disagree.

## Affected Rules

- `.devai/config/sensor-inputs.json` and `law/schemas/sensor-inputs.schema.json` declare the e2e argv, the local `coveragePath`, the population, and the exclusions.
- `packages/cli/src/authority/broker.ts` and `law/policy/subprocess-effects.json` admit the two configurations.
- `tests/config/rc.e2e.config.ts` is the governed e2e configuration; `tests/config/local.coverage.config.ts` is created as the local producer.
- `packages/sensors/src/test.ts` and `packages/sensors/src/test-coverage-depth.ts` read measured outcomes and the population sidecar.
- `package.json` carries `test:coverage:local`.
- `law/policy/sensor-notes/e2e_test.md` and `law/policy/sensor-notes/test_coverage_depth.md` describe the populations.

## Inspector Adversarial Acceptance

Make one `tests/e2e` file fail and run `sense run e2e_test` as inspector;
confirm FAIL with the failed count, then restore it and confirm PASS. Declare
an argv naming `tests/config/rc.coverage.config.ts` and one appending
`../tests/e2e`; confirm both are refused before vitest starts. Delete
`scratch/coverage/local`, unset `DEVAI_DB_TESTS`, and run `sense run
test_coverage_depth`; confirm the producer runs and the ratio is recorded
with `population: local`. Break the producer and confirm FAIL with its exit
code; make it exit zero without writing the report and confirm
`COVERAGE_REPORT_MISSING`. Copy the RC report over the local path with its
own sidecar and confirm the sensor rejects the population mismatch. Add
`tests/e2e/**/*.test.ts` to `LOCAL_INCLUDE` and confirm the population
contract test fails.
