# Sensor: `spec_performance_targets` → F1×T7

## Property semantics

**T7 Performance and Efficiency** (Constitution Article 5): "the artifact addresses latency, throughput, and resource budgets at a level appropriate to its responsibilities." For F1 (Spec), this means the spec substrate names _concrete_ perf targets — not "should be fast" but "p95 < 200 ms" or "≥ 1000 RPS at steady state."

## Operational definition

Two presence checks against the repo root:

- **Count invariants of `type: 'performance'`** in `law/invariants/*.json`.
- **Count use-cases mentioning latency/throughput strings** in their `acceptance[]` or `preconditions[]` arrays under `product/use-cases/*.{md,json}`. Pattern: `/\b(p\d{2}|p99|latency|throughput|ms\b|rps\b|tps\b|qps\b)\b/i`.

The metrics field reports both counts plus a derived `targets_total = perf_invariants + perf_use_cases`.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `perf_invariants ≥ 1` AND `perf_use_cases ≥ 1`.
- **REVIEW:** at least one of the two is non-zero, OR no perf targets but the codebase has perf-sensitive code areas (heuristic: presence of `_probes/` or `*.bench.ts` files signals the team cares about perf without writing it down).
- **FAIL:** both zero AND no perf-sensitive code areas detected (perf is genuinely not a concern OR perf is entirely unaddressed).

## Adopter overrides

- `extractor_params.spec_performance_targets.use_case_dirs: string[]` — override use-case search paths. Default `['product/use-cases']`.
- `extractor_params.spec_performance_targets.perf_signal_patterns: string[]` — additional regex patterns marking perf-relevant code. Default includes `_probes/`, `*.bench.ts`.

## Out of scope

- **Whether the perf targets are actually measured.** That's F3×T7, covered by 27.K `test_performance_coverage`.
- **Whether targets are realistic.** No oracle.
