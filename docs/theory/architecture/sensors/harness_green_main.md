# Sensor: `harness_green_main` → F5×T9

## Property semantics

**T9 Quality of outcome** (Constitution Article 5) for F5 (Harness): "does the gate pass
the candidates it is asked to judge?" A gate that rejects most final candidates either
guards a broken plant or blocks sound work. A gate that passes every candidate may not be
guarding anything. Neither reading should be mistaken for how often authors push unfinished
work.

## Operational definition

The sensor reads the pull-request gate's runs through read-only `gh` calls. It samples the
population declared in `.devai/config/sensor-inputs.json` (ADR-SCR-0010): the workflow, the
event, the base branch, the lookback, and the minimum sample.

The declaration's outcome unit (ADR-SCR-0014) decides what one outcome is. DEVAI declares
`pull-request-final-head`:

1. **Sampled pull requests.** Every pull request against `main` (merged, closed without
   merge, or open) with a `pull-request-checks.yml` run on `pull_request` created in the
   last thirty days.
2. **Final head.** The head at merge for a merged pull request, and the current head for an
   open or closed one.
3. **Counted run.** The latest completed gate run on that head. Cancelled and skipped runs
   never count, and a re-run counts as its last attempt.
4. **Green.** The counted run concluded `success`.
5. **Rate.** `green_pct = green pull requests / sampled pull requests * 100`.

Two exclusions apply. An open pull request whose final head has no completed run yet is left
out. `merge_group` runs are out of scope.

The `run` unit, the default for adopters, counts every completed run as one outcome instead.

Graceful degradation: when `gh` is not on PATH or authentication is missing, the reading is
`unknown` with a reason.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `green_pct >= 95`.
- **REVIEW:** `80 <= green_pct < 95`.
- **FAIL:** `green_pct < 80`.
- **UNKNOWN:** fewer sampled outcomes than the declared minimum (twenty for DEVAI), or `gh`
  unavailable. A missing sample is never a property of the harness.

## Adopter overrides

- `harness_green_main.outcomeUnit` in `.devai/config/sensor-inputs.json`: `run` (default) or
  `pull-request-final-head`.
- The rest of the population declaration (workflow, event, head and base branch, attempts,
  cancelled runs, lookback, minimum sample) as
  [the sensor inputs page](../../../adopters/sensor-inputs.md) states.

## Out of scope

- **Merge-queue outcomes.** No merge queue is enabled (CMP-0007 decision D2), so
  `merge_group` runs are not sampled.
- **Duration and retries.** These are per-run properties and stay with
  [`harness_performance`](./harness_performance.md) (F5×T7) and
  [`harness_robustness`](./harness_robustness.md) (F5×T8).
- **Why a run failed.** The reading counts outcomes; the gate's report names the failing
  nodes.
