---
id: SENSOR-NOTE-e2e_test
title: E2e Test
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: e2e_test
emitter: packages/sensors/src/test.ts
standing: cell
tiers: [SWEEP]
---

# E2e Test

This note defines `e2e_test`. Its canonical emitter
is `packages/sensors/src/test.ts`.

Bound cells: F3×T1.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.

## The declared population

The framework declares the suite command in `.devai/config/sensor-inputs.json` as
`pnpm vitest run --config tests/config/rc.e2e.config.ts`, with no test path appended
(ADR-SCR-0007). The configuration's own `include` selects `tests/e2e/**/*.test.ts` and its
`exclude` leaves out `tests/e2e/inventory-sensors.smoke.test.ts`, so the population the
sensor measures is every end-to-end test file except that smoke file. The earlier declaration
ran `tests/config/local.config.ts` over `tests/e2e`, and because `LOCAL_INCLUDE` in that
configuration selects nothing under `tests/e2e`, the sensor measured an empty population
(#156). `LOCAL_INCLUDE` is unchanged by this declaration: `pnpm test` and `test:local-full`
keep their population, and the population contract test fails when a change adds `tests/e2e`
or `tests/regression` to it.

Under `sense run` the authority broker admits exactly the shape template
`pnpm-vitest-run-governed-config` in `law/policy/subprocess-effects.json` declares, and
`tests/config/rc.e2e.config.ts` is one of its governed configurations. An argv that names a
configuration outside that list, or that appends a path outside `tests/`, is refused before
vitest starts, and the refusal names the argv.

## Readings

The verdicts are measured outcomes. The sensor reads PASS when every file in the population
passes and FAIL carrying the failed count from the vitest summary when any file fails; both
stay visible on the scorecard. It reads `error` only when vitest itself does not run. A
failing test is never recorded as a missing prerequisite, and a missing prerequisite is never
recorded as a passing suite.
