---
id: SENSOR-NOTE-round_record_integrity
title: Round Record Integrity
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: round_record_integrity
emitter: packages/loop/src/governance-ledger/index.ts
standing: diagnostic
tiers: [SWEEP]
---

# Round Record Integrity

This note defines `round_record_integrity`. Its canonical emitter
is `packages/loop/src/governance-ledger/index.ts`.

Diagnostic-only; no cell binding.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
