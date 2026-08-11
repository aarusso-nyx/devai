# Sensor: `harness_performance` → F5×T7

## Property semantics

**T7 Performance and Efficiency** (Constitution Article 5) for F5 (Harness): "how long does CI take?" Concretely: the median and 95th-percentile wall-clock duration of recent successful runs on the default branch. A slow CI is a developer-loop friction tax.

## Operational definition

Call `gh run list --branch <branch> --json conclusion,createdAt,updatedAt --limit <N>`. For each `conclusion === 'success'` run, compute `duration_ms = updatedAt - createdAt`. Aggregate: median + p95 across all successes.

Graceful degradation: when `gh` is not on PATH or authentication is missing, emit `status: 'unknown'` with a reason.

## PASS / REVIEW / FAIL boundaries

- **PASS:** median_ms < 600_000 (10 min) AND p95_ms < 1_800_000 (30 min).
- **REVIEW:** median_ms < 1_200_000 (20 min) AND p95_ms < 3_600_000 (60 min).
- **FAIL:** otherwise.
- **UNKNOWN:** gh unavailable / no runs found.

## Adopter overrides

- `extractor_params.harness_performance.thresholds: {pass_median_ms, pass_p95_ms, review_median_ms, review_p95_ms}` — full threshold overrides.
- `extractor_params.harness_performance.branch: string` — default `'main'`.
- `extractor_params.harness_performance.limit: number` — default `50`.

## Out of scope

- **Per-job duration.** Aggregate workflow duration only.
- **Resource consumption** (runner minutes, costs).
