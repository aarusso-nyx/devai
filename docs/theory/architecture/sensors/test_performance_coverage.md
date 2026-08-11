# Sensor: `test_performance_coverage` → F3×T7

## Property semantics

**T7 Performance and Efficiency** (Constitution Article 5) for F3 (Observation): "the test suite exercises perf characteristics — latency, throughput, load." A repo without perf tests cannot detect perf regressions before deployment.

## Operational definition

Walk all test files; flag those whose filename or content matches:

```
\b(bench|perf|load|throughput|latency|p95|p99|tps|rps|qps)\b
```

Compute `perf_pct = perf_tests / total_tests * 100`.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `perf_tests ≥ 1` AND `perf_pct ≥ 1`.
- **REVIEW:** `perf_tests ≥ 1` AND `perf_pct < 1` (some perf coverage, but vanishingly small share).
- **FAIL:** zero perf tests.

Perf testing is rarer than security testing in most codebases; thresholds reflect this.

## Adopter overrides

- `extractor_params.test_performance_coverage.patterns: string[]` — extend the keyword list.

## Out of scope

- **Perf test quality.** Whether perf assertions actually catch regressions is downstream.
- **Continuous perf monitoring.** F5 concern.
