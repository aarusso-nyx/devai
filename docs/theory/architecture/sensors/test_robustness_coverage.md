# Sensor: `test_robustness_coverage` → F3×T8

## Property semantics

**T8 Robustness** (Constitution Article 5) for F3 (Observation): "the test suite exercises error paths and failure modes — exceptions, rejections, fault injection, retry behaviour." A repo with only happy-path tests cannot rule out robustness regressions.

## Operational definition

Walk all test files; flag those whose filename or content matches:

```
\b(throws|reject|toThrow|toReject|error|fail|fault|chaos|retry|timeout|exception|NotFound|Forbidden|Unauthorized|BadRequest)\b
```

Compute `robust_pct = robust_tests / total_tests * 100`.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `robust_pct ≥ 10`.
- **REVIEW:** `5 ≤ robust_pct < 10`.
- **FAIL:** `robust_pct < 5`.

Error-path tests are typically more common than security/perf because they fall out naturally from REST-API specs (404, 401, 403 cases); the threshold (10%) reflects that.

## Adopter overrides

- `extractor_params.test_robustness_coverage.patterns: string[]` — extend the keyword list.
- `extractor_params.test_robustness_coverage.thresholds: {pass:number, review:number}` — override percent thresholds. Default `{pass:10, review:5}`.

## Out of scope

- **Chaos engineering depth.** Production fault-injection isn't measured here.
- **Retry-policy verification.** Adjacent but separate.
