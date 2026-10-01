---
id: SENSOR-NOTE-test_coverage_depth
title: Test Coverage Depth
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: test_coverage_depth
emitter: packages/sensors/src/test-coverage-depth.ts
standing: cell
tiers: [SWEEP]
---

# Test Coverage Depth

This note defines `test_coverage_depth`. Its canonical emitter
is `packages/sensors/src/test-coverage-depth.ts`.

Bound cells: F3×T2.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.

## The declared population

Coverage on the framework checkout used to exist only behind
`tests/config/rc.coverage.config.ts`, which refuses to start without `DEVAI_DB_TESTS=1` and a
reachable database, so the sensor read REVIEW with a missing report on every checkout that
lacked one (#161). The maintainer decided on 2026-09-28 that no test database is provided for
the next scorecard and that database-free coverage reports a bounded, declared population
(decision 9 of the harness convergence proposals; ADR-SCR-0007).

The framework therefore declares, in `.devai/config/sensor-inputs.json`:

- `coveragePath`: `scratch/coverage/local/coverage-final.json`, the report that
  `tests/config/local.coverage.config.ts` writes through `pnpm test:coverage:local` without a
  `DEVAI_DB_TESTS` gate.
- `population`: `local`. The producer includes `LOCAL_INCLUDE` from
  `tests/config/local.config.ts` (`packages/*/tests/**/*.test.ts`,
  `packages/*/tests/**/*.spec.ts`, `tests/contract/**/*.test.ts`,
  `tests/integration/**/*.test.ts`); `tests/e2e` and `tests/regression` are not in it.
- `exclusions`: the RC-only and database-bound suites the local configuration lists as
  `RC_ONLY`, named one by one:
  `packages/authority/tests/unit/authority-resource-boundaries.red.test.ts`,
  `packages/skills/tests/recipes/adapters.test.ts`,
  `tests/integration/authority-effect-postgres.db.test.ts`, and
  `tests/integration/runtime-probe-data.integration.test.ts`.

The producer writes a `scratch/coverage/local/population.json` sidecar beside the report
naming the population, the include globs, the excluded suites, and the count of files
measured. When the report is absent the sensor runs the declared producer; it reads the
sidecar and refuses a report whose population or exclusion list differs from the declaration,
with the mismatch named, so a stale RC report copied over the local path is never read as the
local measurement. Under `sense run` the authority broker admits the producer only as the
governed shape template `pnpm-vitest-run-governed-config` in
`law/policy/subprocess-effects.json` declares, and `tests/config/local.coverage.config.ts` is
one of its governed configurations.

The RC lane is unchanged: `tests/config/rc.coverage.config.ts`, `test:coverage:rc`, and the
`CHECK_RC_DB_TESTS_REQUIRED` refusal without `DEVAI_DB_TESTS` stay as they are. When a
database is later provided, the RC reading is a second population (`rc`) beside the local
one, not a replacement.

## Readings

The verdicts are measured outcomes. The sensor reads PASS, REVIEW, or FAIL from the measured
lines ratio against its thresholds. A producer that exits non-zero reads FAIL with its exit
code and the stderr head; a report still missing after a zero exit reads FAIL with
`COVERAGE_REPORT_MISSING`. A missing file or a missing prerequisite is never an `error`
reading, because the producer is part of the sensor's own command, and the absence of a
prerequisite is never recorded as REVIEW, because REVIEW is a verdict on the code.

Every reading states the population it measured in `metrics` and in its finding text. The
local ratio carries a smaller denominator than the RC ratio and says so; a local ratio is
never presented as an RC ratio, and a reader comparing scorecards reads the population before
the ratio.
