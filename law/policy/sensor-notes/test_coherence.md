---
id: SENSOR-NOTE-test_coherence
title: Test Coherence
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: test_coherence
emitter: packages/sensors/src/test-coherence.ts
standing: cell
tiers: [SWEEP]
---

# Test Coherence

This note defines `test_coherence`. Its canonical emitter
is `packages/sensors/src/test-coherence.ts`.

Bound cells: F3×T3.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.

## Runner-family naming comparison

Count the complete executable test population using the shared filename classifier:
`.test`, `.spec`, `.e2e`, or `.wiring-spec`, followed by `.ts`, `.tsx`, `.js`,
`.jsx`, `.mjs`, or `.cjs`. Count every selected test in its package and global
ratios; runner classification never removes a test or source file. The existing
per-package minimum and global PASS thresholds remain unchanged.

Naming consistency compares `.test` against `.spec` (including `.wiring-spec`)
within a uniquely established static runner family. A Node TAP `.test.mjs`
and a Vitest `.spec.ts` do not contradict one another merely because their
runner families differ. An executable reference to the runner's test API must
establish the family; file extensions, comments, string contents, type-only
imports, unused runner imports and local lookalike functions do not establish it.
Conflicting or unresolved runner references remain unclassified.

The supported static naming families are Node TAP (`node:test`), Vitest
(`vitest`) and Jest (`@jest/globals`). Require a top-level ESM value import and an
actual direct test or suite API call from that imported binding. Node TAP supports
default, named and namespace imports of `test`, `it`, `describe` or `suite`;
Vitest and Jest support named and namespace imports of `test`, `it` or `describe`.
An unproved binding, shadowing, unsupported call shape or CommonJS import remains
unclassified. These source references describe naming families, never proof of
the installed or executed runner.

Mixed naming within one established family still yields REVIEW. If the global
population mixes naming conventions and any named test has an unclassified or
ambiguous family, retain the conservative mixed-naming REVIEW. A globally uniform
naming convention does not require a new runner-classification verdict.
Read failures retain the existing incomplete-population error. This static
comparison supplies no execution origin, native runner admission or test-result
standing; Node TAP execution standing remains unchanged.

## Declared adopter population

The sensor accepts `packageRoots` in the bound sensor-input declaration. Each list names repository-relative
directories and replaces the corresponding conventional root population. Both declared
and explicit populations are schema-validated and contained inside the checkout on real
paths before walking. Omission preserves the existing default; predicates, thresholds,
standing and mutation authority are unchanged.
