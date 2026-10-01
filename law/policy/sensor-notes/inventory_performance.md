---
id: SENSOR-NOTE-inventory_performance
title: Inventory Performance
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: inventory_performance
emitter: packages/sensors/src/inventory-performance.ts
standing: cell
tiers: [SWEEP]
---

# Inventory Performance

This note defines `inventory_performance`. Its canonical emitter
is `packages/sensors/src/inventory-performance.ts`.

Bound cells: F4×T7.

## Store read and the second sweep pass

The sensor measures the recorded inventory readings: it reads every persisted
`inventory_*` reading under `.devai/state/sensor-readings/` and scores their
durations. Its subject is therefore the store, and on a fresh worktree the store
is empty until the first pass of the sweep has been recorded.

Under ADR-SCR-0008 the sensor is a member of the ordered second pass that
`law/policy/sense-presets.json` declares in `selection_effect_rule.sweep_second_pass`.
The recording protocol is first pass, record, second pass, record: the sensor
runs only after the inspector has recorded the first pass through `sense record`,
so F4×T7 reads PASS or FAIL from the substrate and never REVIEW for the absence of
its own inputs. The preset never records; recording is the inspector's harness-write
step, and the sweep stays read-only for every role.

Where the store holds more than one instance of a kind for the same candidate, the
instances are linked by `supersedes` and the scorecard selects the latest instance by
following those links, never by file time. The sensor reads the store as it finds it
and rewrites nothing.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
