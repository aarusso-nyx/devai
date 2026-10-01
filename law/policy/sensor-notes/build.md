---
id: SENSOR-NOTE-build
title: Build
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: build
emitter: packages/sensors/src/build.ts
standing: cell
tiers: [BASELINE, SWEEP]
---

# Build

This note defines `build`. Its canonical emitter
is `packages/sensors/src/build.ts`.

Bound cells: F2×T9.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.

## Effect

The build is a write. The registry keeps `local-write` with the `proc:pnpm-build` and
`fs:workspace` capabilities because the compiler materializes its outputs under the package
directories; the sensor is excluded from the `sweep` preset for that reason, and no note,
page, or declaration describes it as read-only. Recording its reading is an inspector
harness-write under the self-dogfood matrix. Under `sense run` the authority broker admits
exactly the shape template `pnpm-recursive-build` in `law/policy/subprocess-effects.json`
declares, `pnpm -r build`, without a host adapter (ADR-AUT-0002).

## Command selection and precedence

The sensor's argv and cwd come from two sources in a fixed order:

1. The `build` node of `test-tasks.json`. When the descriptor carries that node, its `argv`
   and `cwd` are the command, and no declaration replaces them.
2. The `build` entry of `.devai/config/sensor-inputs.json`, an `argv` array and an optional
   repository-relative `cwd` under `law/schemas/sensor-inputs.schema.json`. It is admitted
   only when the descriptor has no `build` node, which is the adopter case without a
   descriptor.

A declaration that names a different argv while the descriptor carries a `build` node is a
declaration defect, never a silent preference: the declared-inputs contract test rejects it
naming both argv, and at run time the sensor reads `error` with `BUILD_ARGV_CONFLICT`. With
neither source the sensor falls back to the root package manifest's `build` script through
the lockfile's package manager, and with no script at all it reads `skipped` with
`BUILD_NOT_DECLARED`. Whatever source supplies the argv, admission stays the broker's: a
selected argv outside the declared shape is refused before a process starts, and the sensor
reports the refusal rather than a reading.

A failing build reads FAIL with the exit code and the stderr head and stays visible on the
scorecard; a build that exits zero without finding a project reads `review` with
`BUILD_POPULATION_EMPTY`.

## Reproduction of the refusal (2026-09-30)

Record ADR-AUT-0002 requires the `sense run build` refusal of scorecard
`SC-20260927T205906-001` (#155) to be reproduced before anything is declared. Reproduced on
the framework checkout at commit `a6aee5ed` in a linked worktree, after `pnpm run build` and
`pnpm run release:bootstrap`, with the exact argv

```text
node .devai/state/pr-bootstrap/cli/bin.js sense run build --repo-root . --as-role inspector --write --format json
```

Result: exit 2 after about one second, no process spawned, refusal
`AUTHORITY_POLICY_RESOLVED_BYTES_MISMATCH` (class `routing-authority`, message "authority
policy resolved bytes mismatch"). The same argv with `--dry-run` returns `POLICY_ALLOW`, and
read-effect sensors (`harness_green_main`) and `check` run to completion on the same
checkout.

Cause identified: the materialized `.devai/config/authority-policy.json` on this checkout is
stale. It was bound on 2026-08-27 under framework package 1.3.1 and holds 83 rules; the
policy the CLI compiles from the action registry at this commit holds 92 rules, the nine
protected-release rules (`core-protected-release-*`, `core-architect-release-*-output-*`)
being absent from the view, and the compiled class rules changed again on 2026-09-30 when the
adopter class write verbs were compiled into them. The policy loader
(`packages/authority/src/runtime/policy-loader.ts`) compares the resolved rule bytes of the
compiled policy with the view's and refuses on inequality. The loader runs only for actions
that do not use the bootstrap policy; `read` actions and dry runs use the virtual policy, so
only write actions such as this sensor meet the refusal. `doctor` reports the same posture
(`policy_binding: mismatch`) and names the remedy, a re-materialization through `init bind`,
which is an authority policy edit outside this task's boundary and was not performed.

Not reproduced: the refusal the scorecard recorded, `AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED`.
On this checkout the stale policy refuses first and masks whatever the broker would decide
about the argv. The candidate the record names as the executable resolution in `build.ts` is
consistent with the recorded code and remains the one to test: `resolveExecutable` returns the
real path of the first `pnpm` on `PATH`, which under a corepack-managed toolchain is the shim
`pnpm.js`, while the broker admits the build shape only when the basename of the executable
is `pnpm`; a non-matching basename falls through to the process-target path and the
`AUTHORITY_HOST_PROCESS_ADAPTER_REQUIRED` refusal. This is a reading of the source, not a
reproduction; the fix lands in the source a reproduction with a current policy names, with
that reproduction as its test.
