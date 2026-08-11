---
id: SENSOR-NOTE-security_scan
title: Security Scan
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: security_scan
emitter: packages/sensors/src/security-scan.ts
standing: cell
tiers: [SWEEP]
---

# Security Scan

This note defines `security_scan`. Its canonical emitter
is `packages/sensors/src/security-scan.ts`.

Bound cells: F2×T6.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
