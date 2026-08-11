# Sensor: `plant_depth` → F2×T2

## Property semantics

**T2 Depth** (Constitution Article 5): "the artifact extends from surface to internals with appropriate elaboration." For F2 (Plant), depth means _complexity per unit_ — how big and how internally complex each module is. A plant that's all 100-LOC files is shallow (likely missing decomposition); a plant where the 95th-percentile file is 2000 LOC has runaway depth (likely missing decomposition the other way).

## Operational definition

Walk the configured source dirs (default `packages/*/src/**`) for `.ts` / `.tsx` files. Compute per-file LOC (raw line count). Report:

- `files_count`
- `lines_total`
- `lines_max`
- `lines_mean`
- `lines_p95` (95th percentile)

The 95th percentile is the load-bearing metric (catches outlier-bloated files without being dragged by long tails).

## PASS / REVIEW / FAIL boundaries

- **PASS:** `lines_p95 < 500`.
- **REVIEW:** `500 ≤ lines_p95 < 1000`.
- **FAIL:** `lines_p95 ≥ 1000`.

These thresholds match common "max file size" conventions (e.g. Airbnb style guide, Google's internal limits) and are adopter-overridable.

## Adopter overrides

- `extractor_params.plant_depth.source_globs: string[]` — override the file scan. Default `['packages/*/src/**']`.
- `extractor_params.plant_depth.thresholds: {pass:number, review:number}` — override the 95th-percentile boundaries. Default `{pass:500, review:1000}`.

## Out of scope

- **Cyclomatic complexity per function.** A simpler heuristic (raw LOC) gives 80% of the signal at 5% of the cost (no TS AST parse). A future `plant_depth_cyclomatic` kind could refine.
- **Dead-code detection.** A future `plant_dead_code` kind via knip integration.
