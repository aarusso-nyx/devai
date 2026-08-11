# Sensor: `harness_coverage` → F5×T1

## Property semantics

**T1 Coverage** (Constitution Article 5) for F5 (Harness): "does CI exercise enough of the repo?" Concretely: are the file paths that matter actually triggering a workflow run, or do many paths slip past CI because no workflow's path filter matches them?

## Operational definition

1. Walk `.github/workflows/*.yml{,.yaml}` and collect the union of `on.<trigger>.paths[]` filters across all workflows (and the union of `paths-ignore[]`).
2. List tracked repo files via `git ls-files`.
3. A file is _covered_ if some path filter glob matches it AND no `paths-ignore` glob excludes it. Workflows with no `paths` filter (i.e. they run on every push/PR) cause every tracked file to count as covered.
4. Compute `coverage_pct = covered_files / total_files * 100`.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `coverage_pct ≥ 80`.
- **REVIEW:** `50 ≤ coverage_pct < 80`.
- **FAIL:** `coverage_pct < 50`.

If any workflow has no `on.*.paths` filter (runs on everything), the sensor short-circuits to PASS with `metrics.covered_by_unfiltered_workflow = 1`.

## Adopter overrides

- `extractor_params.harness_coverage.workflow_dir: string` — override the workflow dir. Default `.github/workflows`.
- `extractor_params.harness_coverage.thresholds: {pass:number, review:number}` — override the pct boundaries.

## Out of scope

- **Whether the workflow actually does anything meaningful for the covered paths.** That's idiomaticity/depth territory.
- **Branch coverage** (does every branch trigger CI?). Adjacent concern; defer.
