---
id: ADR-SCR-0010
title: The harness sensors declare their CI sample and read UNKNOWN below the minimum
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0001
  - ADR-SCR-0005
  - ADR-AUT-0001
  - ADR-CHK-0001
  - law/policy/sensor-notes/harness_green_main.md
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - packages/sensors/src/harness-green-main.ts
  - packages/sensors/src/harness-performance.ts
  - packages/sensors/src/harness-robustness.ts
  - packages/sensors/src/harness/gh-api.ts
  - law/schemas/sensor-inputs.schema.json
  - .devai/config/sensor-inputs.json
  - packages/cli/src/authority/broker.ts
  - law/policy/subprocess-effects.json
  - law/policy/sensor-notes/harness_green_main.md
  - law/policy/sensor-notes/harness_performance.md
  - law/policy/sensor-notes/harness_robustness.md
inspector_acceptance:
  - IA-001 -- A gh run list fixture with fewer runs than the declared minimum sample makes each of the three sensors read UNKNOWN with the sample size and the minimum in the finding, never FAIL and never PASS.
  - IA-002 -- A fixture whose runs all match the declared workflow and event but sit on another head branch is excluded, and a fixture that includes cancelled runs counts them only when the declaration says so.
  - IA-003 -- A run of the excluded workflow-and-job pair with a long environment wait is left out of the performance sample by identity, and a run of the sampled workflow with the same duration stays in the sample and can drive FAIL.
  - IA-004 -- A declaration that omits the workflow, the event, or the minimum sample, or that names an event the workflow does not carry, is rejected by the schema and by the declared-inputs contract test.
  - IA-005 -- A gh run list argv carrying an --event or --workflow value outside the declared grammar, or a second --branch, is refused by the broker before a process starts.
---

# The harness sensors declare their CI sample and read UNKNOWN below the minimum

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Extends the read-only `gh run
list` admission of ADR-SCR-0005 with a declared population and changes the
below-minimum verdict of the three harness sensors; no threshold changes.

## Context

The harness sensors read GitHub Actions history through `gh run list
--branch <ref> --json <fields> --limit <n>`, with `main` and a limit of 50
or 100 as defaults in `packages/sensors/src/harness-green-main.ts`,
`harness-performance.ts`, and `harness-robustness.ts`. Since the push trigger
was dropped from `pull-request-checks.yml`, one run has executed on `main`;
the gate runs on pull requests, whose head branch is never `main` (#154). The
first self-scorecard therefore rated F5:T9, F5:T7, and F5:T8 on a sample that
does not contain the workflow it means to measure. `harness_green_main`
already reads `unknown` below a minimum it computes after its `since`
filter; the other two read REVIEW or FAIL on any non-empty sample. Runs whose
duration is dominated by waiting on a protected environment, such as the
release rehearsal's approval stops, enter the performance sample beside
gate runs and distort the median.

## Decision

The three harness sensors declare their population in
`.devai/config/sensor-inputs.json`, validated by
`law/schemas/sensor-inputs.schema.json`: the workflow file name, the event
(`pull_request` or `merge_group` for the gate, `workflow_dispatch` for a
release run), the head branch pattern and the base branch, whether every
attempt of a run counts or only the last, whether cancelled runs count,
the lookback as a number of days, and the minimum sample size. The
framework declaration names `pull-request-checks.yml`, the `pull_request`
event, any head branch, base `main`, last attempt only, cancelled runs
excluded, a lookback of thirty days, and a minimum of twenty runs for
`harness_green_main` and `harness_robustness` and ten successful runs for
`harness_performance`. The declared population is part of the reading's
`metrics`, so a scorecard reader sees what was sampled.

Runs whose duration is dominated by an environment wait are excluded by
identity, never by threshold: the declaration lists workflow-and-job pairs to
leave out, the framework lists the release workflow's gated jobs, and a run
of the sampled workflow with a long duration stays in the sample and can
drive FAIL. The broker admits the `--event <event>` and `--workflow <file>`
options on the `gh run list` shape with a fixed grammar for each value, and
the `gh-run-list` templates in `law/policy/subprocess-effects.json` are
mirrored; the `--branch` option stays single and the argv stays exact.

Below the minimum sample each sensor reads `UNKNOWN`, with the sample size,
the minimum, and the population in the finding, never FAIL and never PASS.
At or above the minimum the verdict is the measured one: a success rate
below eighty percent reads FAIL in `harness_green_main`, and the existing
median and p95 thresholds apply in `harness_performance`. The `since` filter
of `harness_green_main` is kept and applied after the population filter.

The recomputation of the three cells after the sample matures is an
Inspector task under this record. It records a second scorecard beside the
first, does not overwrite the first, and notes the delta between the two in
the scorecard page. Implementation closure does not wait for the sample; the
Inspector task opens when the declared minimum is reached.

## Consequences

The three F5 cells read `UNKNOWN` until the gate has produced twenty runs
under the declared population, and then read what the runs show, including
FAIL when the gate is red or slow. A reader can no longer mistake a sample of
`main` pushes for the gate. The broker literal changes, so the task-policy
digest changes once more; the round that implements this record is the last
in campaign B, after ADR-AUT-0002 and ADR-SCR-0007. Adopters that run their
gate on `main` pushes declare that event and lose nothing.

## Alternatives Considered

Restoring the push trigger on `main` to grow the sample is rejected because
it would run the gate twice per merge for the sake of a measurement. Reading
REVIEW below the minimum is rejected because REVIEW asks a human to look at a
sample that does not exist. Excluding slow runs by a duration threshold is
rejected because it would remove the slow gate runs the sensor exists to
find. Reading FAIL on an empty sample is rejected because the absence of runs
is not a property of the harness.

## Affected Rules

- `packages/sensors/src/harness-green-main.ts`, `packages/sensors/src/harness-performance.ts`, and `packages/sensors/src/harness-robustness.ts` apply the declared population and the `UNKNOWN` rule.
- `packages/sensors/src/harness/gh-api.ts` passes the event and workflow options.
- `law/schemas/sensor-inputs.schema.json` and `.devai/config/sensor-inputs.json` carry the population declaration.
- `packages/cli/src/authority/broker.ts` and `law/policy/subprocess-effects.json` admit the widened exact shape.
- The three sensor notes describe the population and the below-minimum verdict.

## Inspector Adversarial Acceptance

Feed each sensor a `gh run list` fixture of nineteen matching runs and
confirm `UNKNOWN` with `sample_size` and `minimum_sample` in the finding;
feed twenty with five failures and confirm `harness_green_main` reads FAIL.
Feed runs on head `main` with the declared event and confirm they are
excluded; add cancelled runs and confirm they count only when the declaration
says so. Feed a release run of an excluded job with a ninety-minute duration
and confirm the performance sample omits it, then a gate run of the same
duration and confirm FAIL. Remove `minimum_sample` from the declaration and
confirm the schema and the contract test reject it; declare `push` for a
workflow without that trigger and confirm the same. Issue `gh run list` with
`--event 'pull_request; rm'` and with two `--branch` values and confirm the
broker refuses both.
