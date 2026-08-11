---
id: SENSOR-NOTE-runtime_probe_auth
title: Runtime Probe Auth
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: runtime_probe_auth
emitter: packages/sensors/src/runtime-probe.ts
standing: diagnostic
tiers: [SWEEP]
---

# Runtime Probe Auth

This note defines `runtime_probe_auth`. Its canonical emitter
is `packages/sensors/src/runtime-probe.ts`.

Diagnostic-only; no cell binding.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
