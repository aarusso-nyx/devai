---
id: SENSOR-NOTE-type_check
title: Type Check
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: type_check
emitter: packages/sensors/src/type-check.ts
standing: cell
tiers: [BASELINE, SWEEP]
---

# Type Check

This note defines `type_check`. Its canonical emitter
is `packages/sensors/src/type-check.ts`.

Bound cells: F2×T8.

## Admitted processes (ADR-AUT-0006)

Under `sense run` the authority broker admits exactly these argvs for `type_check`, without
a host adapter:

- `npx tsc --noEmit`, the default, against the root `tsconfig.json` (template
  `npx-tsc-noemit`, read);
- `npx tsc --noEmit -p <relative path>`, a declared project that is repository-relative,
  never absolute and without a `..` segment (template `npx-tsc-noemit-project`, read);
- `pnpm -r typecheck`, for a pnpm workspace whose packages each declare a `typecheck`
  script (template `pnpm-recursive-typecheck`). This runs adopter scripts, so it is
  local-write, not read-only. The executable may be `pnpm` or the corepack shim it resolves
  to. `pnpm -r` skips the workspace root's own script.

Any other argv is refused before a process starts, including `pnpm typecheck`,
`pnpm run typecheck`, `pnpm exec tsc`, or an argv with an added argument such as
`--filter`. A refused argv reads as a broker refusal, not as a type error.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
