---
id: SENSOR-NOTE-spec_robustness_targets
title: Spec Robustness Targets
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: spec_robustness_targets
emitter: packages/sensors/src/spec-robustness-targets.ts
standing: cell
tiers: [SWEEP]
---

# Spec Robustness Targets

This note defines `spec_robustness_targets`. Its canonical emitter
is `packages/sensors/src/spec-robustness-targets.ts`.

Bound cells: F1×T8.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
