---
id: SENSOR-NOTE-archive_immutability
title: Archive Immutability
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: archive_immutability
emitter: packages/loop/src/governance-ledger/index.ts
standing: diagnostic
tiers: [SWEEP]
---

# Archive Immutability

This note defines `archive_immutability`. Its canonical emitter
is `packages/loop/src/governance-ledger/index.ts`.

Diagnostic-only; no cell binding.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
