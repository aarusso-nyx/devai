---
id: ADR-AUT-0006
title: Exact admission of the pnpm type-check and performance sensor processes
type: adr
status: accepted
date: 2026-10-09
authority: Architect
supersedes: []
provenance:
  - ADR-AUT-0002
  - ADR-AUT-0001
  - ADR-SCR-0005
  - law/policy/subprocess-effects.json
affected_rules:
  - packages/cli/src/authority/broker.ts
  - law/policy/subprocess-effects.json
  - packages/sensors/src/type-check.ts
  - packages/sensors/src/perf-test.ts
  - law/schemas/sensor-inputs.schema.json
  - law/policy/sensor-notes/type_check.md
  - law/policy/sensor-notes/perf_test.md
  - docs/adopters/sensor-inputs.md
inspector_acceptance:
  - IA-001 -- Under sense run, a type_check declaration with argv pnpm -r typecheck runs the process in a pnpm workspace and reads FAIL with the exit code when a package fails to type-check, never a broker refusal and never PASS.
  - IA-002 -- Under sense run, perf_test with argv pnpm test:perf, or with no argv and the default scriptName test:perf, runs the process and reads a measured verdict, never AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED.
  - IA-003 -- pnpm -r typecheck or pnpm test:perf with any extra argument, pnpm typecheck without -r, pnpm run or pnpm exec in front of either script, another script name, or either shape under an action other than sense run is refused before a process starts.
  - IA-004 -- The corepack shim that a corepack-managed pnpm resolves to is admitted as the executable for both shapes, as for pnpm -r build, and an executable whose basename is neither pnpm nor that shim is refused.
  - IA-005 -- Removing any of the templates pnpm-recursive-typecheck, pnpm-test-perf, npx-tsc-noemit, npx-tsc-noemit-project, or npx-eslint-json from subprocess-effects.json while the broker still admits the shape, or the converse, fails the mirror test in the broker suite.
  - IA-006 -- Both pnpm templates declare effect local-write with the fs workspace capability, and recording either reading stays an inspector harness-write under the self-dogfood matrix.
---

# Exact admission of the pnpm type-check and performance sensor processes

## Status

Accepted on 2026-10-09 by the Architect. The Owner chose option O2 of #381 in
chat on 2026-10-09. The record extends ADR-AUT-0002, which admitted exactly
`pnpm -r build` for the build sensor, to two more exact shapes for the
type-check and performance sensors. It ships in 2.3.1. Option O3, admitting
any argv an adopter declares, is deferred to 2.4.0.

## Context

Under `sense run` the authority broker admits a sensor's process only when it
matches a literal shape that `law/policy/subprocess-effects.json` mirrors. For
`type_check` it admits `npx tsc --noEmit` and `npx tsc --noEmit -p <relative
path>`. For `perf_test` it admits the governed `pnpm vitest run --config
<governed-config> [<test-path>]`, and it refuses a bare package script.

A pnpm monorepo has no single root project that type-checks the workspace.
Each package carries its own `typecheck` script, and the repository gate runs
them per package. Its performance suite runs through a package script that
the adopter writes. So for such an adopter (STYNX, #381), `sense run
type_check` and `sense run perf_test` are refused with
`AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED`, and F2:T8 and F2:T7 stay UNKNOWN
while the gate is green. A root project over every package's sources
reports cross-package errors that the real gates do not.

## Decision

Under `sense run` only, the broker admits exactly two more process shapes,
with no further argument:

- **`pnpm -r typecheck`** for `type_check`. It runs the `typecheck` script of
  every workspace package that declares one.
- **`pnpm test:perf`** for `perf_test`, as a declared argv or as the legacy
  `scriptName` default `test:perf`.

Both are matched token for token. The broker refuses:

- either shape with any added argument, such as `--filter`, `--`, or a flag;
- `pnpm typecheck` without `-r`;
- `pnpm run` or `pnpm exec` in front of either script;
- any other script name;
- either shape under any action other than `sense run`.

The executable is `pnpm`, or the corepack shim that a corepack-managed `pnpm`
on PATH resolves to (`<prefix>/corepack/dist/pnpm.js`), as for the build
sensor (#155).

These processes are **not read-only.** Each runs a package script whose
contents the adopter controls, and that script may write anywhere in the
workspace, as a compiler or a test producer usually does. Each template
therefore declares `effect: local-write` with `proc:pnpm-build` and
`fs:workspace`, as `pnpm-recursive-build` does. Recording the reading stays
an inspector harness-write under the self-dogfood matrix. The adopter
authors those scripts under its own path authority, and DEVAI only runs
them.

`law/policy/subprocess-effects.json` gains the two templates
`pnpm-recursive-typecheck` and `pnpm-test-perf`. It also gains the mirror
templates the broker already admits but the registry never listed:
`npx-tsc-noemit` (`npx tsc --noEmit`), `npx-tsc-noemit-project`
(`npx tsc --noEmit -p <relative path>`), and `npx-eslint-json`
(`npx eslint --format=json <path>`). The sentence that refused every bare
package script now names `pnpm test:perf` as its one exception.

## Consequences

A pnpm or turbo workspace declares `type_check.argv` as
`["pnpm","-r","typecheck"]` and gets a measured F2:T8, provided each package
that should be checked declares a `typecheck` script. `pnpm -r` skips the
workspace root's own script, so a root that also needs checking keeps a
package or adds an `npx tsc --noEmit -p <project>` declaration of its own.
An adopter whose performance suite is the `test:perf` script gets a measured
F2:T7 from its existing default.

The broker literal list changes, so the task-policy digest changes, and the
next release candidate needs its own attestation. Adopters rebind subprocess
effects to materialize the new templates: migration
`MIG-2.3.1-subprocess-effects-pnpm-shapes`.

## Alternatives Considered

**O1, documentation only.** Telling adopters which executables are admitted
leaves pnpm workspaces without a way to measure, so it is not enough on its
own. The adopter page still gains that documentation under this record.
**O3, admitting any argv the adopter declares.** This needs a design for
declared-argv authority, including how the declaration is bound and
reviewed, and is deferred to 2.4.0. **Classifying the shapes read-only** is
rejected because the scripts are adopter code that can write.
**Admitting `pnpm <script>` for any script name** is rejected because it
would make every package script a sensor process.

## Affected Rules

- `packages/cli/src/authority/broker.ts`: the two literals under `sense run`,
  with the corepack-aware executable.
- `law/policy/subprocess-effects.json`: the two pnpm templates and the three
  npx mirror templates.
- `packages/sensors/src/type-check.ts` and `packages/sensors/src/perf-test.ts`:
  run the admitted shapes and read their exit codes and diagnostics.
- `law/schemas/sensor-inputs.schema.json`: the descriptions of
  `type_check_inputs.argv`, `perf_test_inputs.argv`, and
  `perf_test_inputs.scriptName`.
- `law/policy/sensor-notes/type_check.md`, `law/policy/sensor-notes/perf_test.md`,
  and `docs/adopters/sensor-inputs.md`: the admitted shapes and the workspace
  guidance.

## Inspector Adversarial Acceptance

- IA-001 -- Under sense run, a type_check declaration with argv pnpm -r typecheck runs the process in a pnpm workspace and reads FAIL with the exit code when a package fails to type-check, never a broker refusal and never PASS.
- IA-002 -- Under sense run, perf_test with argv pnpm test:perf, or with no argv and the default scriptName test:perf, runs the process and reads a measured verdict, never AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED.
- IA-003 -- pnpm -r typecheck or pnpm test:perf with any extra argument, pnpm typecheck without -r, pnpm run or pnpm exec in front of either script, another script name, or either shape under an action other than sense run is refused before a process starts.
- IA-004 -- The corepack shim that a corepack-managed pnpm resolves to is admitted as the executable for both shapes, as for pnpm -r build, and an executable whose basename is neither pnpm nor that shim is refused.
- IA-005 -- Removing any of the templates pnpm-recursive-typecheck, pnpm-test-perf, npx-tsc-noemit, npx-tsc-noemit-project, or npx-eslint-json from subprocess-effects.json while the broker still admits the shape, or the converse, fails the mirror test in the broker suite.
- IA-006 -- Both pnpm templates declare effect local-write with the fs workspace capability, and recording either reading stays an inspector harness-write under the self-dogfood matrix.
