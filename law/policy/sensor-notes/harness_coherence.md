---
id: SENSOR-NOTE-harness_coherence
title: Harness Coherence
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: harness_coherence
emitter: packages/sensors/src/harness-coherence.ts
standing: cell
tiers: [TIER3, SWEEP]
---

# Harness Coherence

This note defines `harness_coherence`. Its canonical emitter
is `packages/sensors/src/harness-coherence.ts`.

Bound cells: F5×T3.

## Generated adopter workflows

Added 2026-10-09 (#390, 2.3.2). The workflows DEVAI generates into an adopter,
`devai-local-rc-verify.yml` and `devai-main-observation.yml`, are proved like any other
workflow: through the reviewed-step registry
(`packages/sensors/src/harness/reviewed-workflow-steps.ts`), one entry per step keyed by the
sha256 of its canonical YAML, never by file name, generator receipt or host-adapter
configuration (ADR-REL-0034). A generated step's occurrence is written
`generated:<workflow file>#<job>[<step index>]`, for example
`generated:devai-local-rc-verify.yml#verify-attested-rc[0]` and
`generated:devai-main-observation.yml#observe[0]`. Its `files` list is empty because it executes
no adopter repository file the registry could pin, and the registry test rebuilds both workflows from their
generators and fails when a generated step's digest or occurrences differ from its entry. An
adopter that edits a generated step changes its digest, so that step reads `unknown` until it is
regenerated or reviewed.

A job with an `unknown` effect still fails the concurrency rule: the rule never accepts a
serializing or commit-keyed lock in place of a proved effect (ADR-REL-0034 IA-003). When the
failure comes from unknown effects, the `HARNESS_COHERENCE_CONCURRENCY_POLICY` message names
each job read `unknown` and does not state a superseding or serializing requirement as the
cause.

The install step parser accepts `pnpm install --frozen-lockfile --ignore-scripts` as an install
that binds no lifecycle script, so it executes no package script of the repository or its
dependencies. A pnpm hook file (`.pnpmfile.cjs`, `pnpmfile.cjs` or `.pnpmfile.js`) runs
regardless of `--ignore-scripts`, so with one present in the candidate tree the step reads
`unknown` (fail closed). A `pnpm install` without `--ignore-scripts` keeps following the
lifecycle scripts it would run, as before. The generated observation job installs with
`--ignore-scripts` (Owner approval 2026-10-09, `MIG-2.3.2-observation-install-ignore-scripts`
in `law/policy/adopter-migrations.json`).

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
