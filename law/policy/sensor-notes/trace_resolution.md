---
id: SENSOR-NOTE-trace_resolution
title: Trace Resolution
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: trace_resolution
emitter: packages/sensors/src/trace-resolve.ts
standing: cell
tiers: [SWEEP]
---

# Trace Resolution

This note defines `trace_resolution`. Its canonical emitter
is `packages/sensors/src/trace-resolve.ts`.

Bound cells: F1×T3.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.

## Executable test target classification

A traced test target uses the same executable-test filename classifier as the
repository test census: `.test`, `.spec`, `.e2e`, or `.wiring-spec`, followed by
`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, or `.cjs`. This recognition does not execute
a test or establish runner standing. Every existing repository containment,
regular-file, existence and trace-reference check remains required; declaration
files and unsupported suffixes gain no test-target classification.
