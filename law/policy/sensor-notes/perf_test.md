---
id: SENSOR-NOTE-perf_test
title: Perf Test
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: perf_test
emitter: packages/sensors/src/perf-test.ts
standing: cell
tiers: [SWEEP]
---

# Perf Test

This note defines `perf_test`. Its canonical emitter
is `packages/sensors/src/perf-test.ts`.

Bound cells: F2×T7.

## Admitted processes (ADR-AUT-0006)

Under `sense run` the authority broker admits exactly these argvs for `perf_test`, without
a host adapter:

- `pnpm vitest run --config <governed-config> [<test-path>]`, the governed vitest shape
  (template `pnpm-vitest-run-governed-config`, read);
- `pnpm test:perf`, as a declared argv or as the default when neither `argv` nor
  `scriptName` is declared (template `pnpm-test-perf`). This runs an adopter script, so it
  is local-write, not read-only. The executable may be `pnpm` or the corepack shim it
  resolves to.

Any other argv is refused before a process starts, including `pnpm run test:perf`, another
`scriptName`, `pnpm test:perf` with an added argument, and `node <script>`.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
