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

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
