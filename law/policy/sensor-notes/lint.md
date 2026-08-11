---
id: SENSOR-NOTE-lint
title: Lint
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: lint
emitter: packages/sensors/src/lint.ts
standing: cell
tiers: [BASELINE, SWEEP]
---

# Lint

This note defines `lint`. Its canonical emitter
is `packages/sensors/src/lint.ts`.

Bound cells: F2×T5.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
