---
id: SENSOR-NOTE-harness_performance
title: Harness Performance
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: harness_performance
emitter: packages/sensors/src/harness-performance.ts
standing: cell
tiers: [SWEEP]
---

# Harness Performance

This note defines `harness_performance`. Its canonical emitter
is `packages/sensors/src/harness-performance.ts`.

Bound cells: F5×T7.

## Population (ADR-SCR-0010)

The sensor samples the CI population its adopter declares under `harness_performance` in
`.devai/config/sensor-inputs.json`, validated by `law/schemas/sensor-inputs.schema.json`: the
workflow file and the event (both required), the head branch (a literal reference passed as the
single `--branch` option, or `*` for any head branch with no `--branch` option), the base branch
applied after the call, whether every attempt or only the last attempt of a run counts, whether
cancelled runs count, the lookback in days, the minimum sample (required), and the
workflow-and-job pairs excluded by identity. The declaration drives the `gh run list` shape the
broker admits (`--workflow <file> --event <event> [--branch <ref>] --json <fields> --limit 1000`,
templates `gh-run-list` and `gh-run-list-branch` in `law/policy/subprocess-effects.json`), and
the population is part of the reading's `metrics`.

Runs whose duration is dominated by waiting on a protected environment are excluded by
identity, never by threshold: the declaration lists the workflow-and-job pairs to leave out,
and a run of the sampled workflow with a long duration stays in the sample and can drive FAIL.
DEVAI declares `pull-request-checks.yml` on `pull_request`, any head branch, base `main`, last
attempt only, cancelled runs excluded, thirty days, a minimum of ten successful runs, and
excludes the environment-gated jobs of `release.yml`: `verify-ledger`, `build-release`,
`finalize-release`, and `deploy-pages`.

## Verdict below and above the minimum

The run list is read with the literal limit `--limit 1000` (#364). A list that returns as many
runs as the limit may have been cut before the lookback window ends, so the sensor reads
`unknown` as truncated, with the limit in its finding, and never states a verdict on it.

The minimum counts successful runs, the runs whose durations the sensor measures. Below it the
sensor reads `unknown` with `sample_size`, `minimum_sample`, and the population in the finding,
never FAIL and never PASS. At or above it the verdict is the measured one under the unchanged
median and p95 thresholds. Declaring a population never changes a threshold.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
