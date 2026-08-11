# Sensor: `harness_depth` → F5×T2

## Property semantics

**T2 Depth** (Constitution Article 5) for F5 (Harness): "is each CI workflow thorough enough?" Concretely: do workflows have enough steps to actually verify, and do they expand the build matrix to test under realistic combinations (multiple Node versions, OSes, etc.)?

## Operational definition

Per-workflow via `workflow-parser`:

- `step_count` per job.
- `matrix_combinations` per job (product of matrix dimension sizes; 0 if no matrix).

Aggregate across all workflows:

- `steps_p95` — 95th-percentile of per-job step counts.
- `total_matrix_combinations` — sum of `matrix_combinations` across all jobs.
- `jobs_count` — total job count.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `steps_p95 ≥ 3` (workflows are non-trivial).
- **REVIEW:** `1 ≤ steps_p95 < 3` (workflows exist but minimal).
- **FAIL:** `steps_p95 < 1` (no real steps) OR `jobs_count === 0`.

## Adopter overrides

- `extractor_params.harness_depth.thresholds: {pass:number}` — override steps_p95 PASS boundary. Default `3`.

## Out of scope

- **Step quality.** A 100-step workflow isn't necessarily good.
- **Workflow-level dependency graphs** (`needs:` chains).
