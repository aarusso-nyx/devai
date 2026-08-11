# Sensor: `harness_robustness` → F5×T8

## Property semantics

**T8 Robustness** (Constitution Article 5) for F5 (Harness): "is CI stable?" Concretely: what fraction of runs succeed only after a retry? A flaky CI imposes a hidden cost on every developer and erodes trust in the gate signal.

## Operational definition

Call `gh run list --branch <branch> --json conclusion,attempts --limit <N>`. A run is _flaky_ if `conclusion === 'success'` AND `attempts > 1`. Compute `flakiness_pct = flaky_runs / total_runs * 100`.

Graceful degradation: same gh-unavailable contract as 28.G + 26.K.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `flakiness_pct < 5`.
- **REVIEW:** `5 ≤ flakiness_pct < 15`.
- **FAIL:** `flakiness_pct ≥ 15`.
- **UNKNOWN:** gh unavailable.

## Adopter overrides

- `extractor_params.harness_robustness.thresholds: {pass:number, review:number}` — percent boundaries. Default `{pass:5, review:15}`.
- `extractor_params.harness_robustness.branch: string` — default `'main'`.
- `extractor_params.harness_robustness.limit: number` — default `100`.

## Out of scope

- **Specific failure causes.** This sensor measures rate, not root cause.
- **Job-level flakiness** (one job flaky in an otherwise-green run). Aggregate workflow level only.
