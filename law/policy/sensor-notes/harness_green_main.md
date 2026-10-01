---
id: SENSOR-NOTE-harness_green_main
title: Harness Green Main
type: sensor-design-note
status: active
date: 2026-07-26
authority: Architect
sensor_kind: harness_green_main
emitter: packages/sensors/src/harness-green-main.ts
standing: cell
tiers: [SWEEP]
---

# Harness Green Main

This note defines `harness_green_main`. Its canonical emitter
is `packages/sensors/src/harness-green-main.ts`.

Bound cells: F5×T9.

## Population (ADR-SCR-0010)

The sensor samples the CI population its adopter declares under `harness_green_main` in
`.devai/config/sensor-inputs.json`, validated by `law/schemas/sensor-inputs.schema.json`: the
workflow file and the event (both required), the head branch (a literal reference passed as the
single `--branch` option, or `*` for any head branch with no `--branch` option), the base branch
applied after the call, whether every attempt or only the last attempt of a run counts, whether
cancelled runs count, the lookback in days, the minimum sample (required), and the
workflow-and-job pairs excluded by identity. The declaration drives the `gh run list` shape the
broker admits (`--workflow <file> --event <event> [--branch <ref>] --json <fields> --limit <n>
[--created >=<date>]`, templates `gh-run-list*` in `law/policy/subprocess-effects.json`), and
the population is part of the reading's `metrics`.

DEVAI declares `pull-request-checks.yml` on `pull_request`, any head branch, base `main`, last
attempt only, cancelled runs excluded, thirty days, and a minimum of twenty runs. The gate runs
on pull requests, whose head branch is never `main`, so a sample of `main` pushes is never the
gate. The `since` input is kept and applied after the population filter.

## Verdict below and above the minimum

Below the declared minimum the sensor reads `unknown` with `sample_size`, `minimum_sample`,
and the population in the finding, never FAIL and never PASS: the absence of runs is not a
property of the harness. At or above the minimum the verdict is the measured one under the
unchanged thresholds: a success rate below eighty percent reads FAIL, eighty to below
ninety-five reads REVIEW, and ninety-five or more reads PASS. Declaring a population never
changes a threshold.

The sensor emits evidence only through its registered cells or diagnostic surface. Any
future change to identity, standing, tier, or emitter requires an Architect disposition
before implementation. This note grants no mutation or release authority.
