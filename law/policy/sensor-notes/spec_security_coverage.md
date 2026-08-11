---
id: SENSOR-NOTE-spec_security_coverage
title: Spec Security Coverage
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: spec_security_coverage
emitter: packages/sensors/src/spec-security-coverage.ts
standing: cell
tiers: [SWEEP]
---

# Spec Security Coverage

This note defines `spec_security_coverage`. Its canonical emitter
is `packages/sensors/src/spec-security-coverage.ts`.

Bound cells: F1×T6.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
