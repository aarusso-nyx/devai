---
id: SENSOR-NOTE-llm_judge
title: Llm Judge
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: llm_judge
emitter: packages/sensors/src/judge.ts
standing: cell
tiers: [SWEEP]
---

# Llm Judge

This note defines `llm_judge`. Its canonical emitter
is `packages/sensors/src/judge.ts`.

Bound cells: F1×T3.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
