---
id: SENSOR-NOTE-site_drift
title: Site Drift
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: site_drift
emitter: packages/sensors/src/site-drift.ts
standing: diagnostic
tiers: [SWEEP]
---

# Site Drift

This note defines `site_drift`. Its canonical emitter
is `packages/sensors/src/site-drift.ts`.

Diagnostic-only; no cell binding.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
