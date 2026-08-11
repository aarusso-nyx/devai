---
id: SENSOR-NOTE-test_security_coverage
title: Test Security Coverage
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: test_security_coverage
emitter: packages/sensors/src/test-security-coverage.ts
standing: cell
tiers: [SWEEP]
---

# Test Security Coverage

This note defines `test_security_coverage`. Its canonical emitter
is `packages/sensors/src/test-security-coverage.ts`.

Bound cells: F3×T6.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
