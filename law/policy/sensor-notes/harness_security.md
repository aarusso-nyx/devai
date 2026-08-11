---
id: SENSOR-NOTE-harness_security
title: Harness Security
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: harness_security
emitter: packages/sensors/src/harness-security.ts
standing: cell
tiers: [SWEEP]
---

# Harness Security

This note defines `harness_security`. Its canonical emitter
is `packages/sensors/src/harness-security.ts`.

Bound cells: F5×T6.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
