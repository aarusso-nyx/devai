# Sensor: `test_security_coverage` → F3×T6

## Property semantics

**T6 Security and Privacy** (Constitution Article 5) for F3 (Observation): "the test suite exercises security/privacy behaviour — auth, RBAC, tenant isolation, common injection classes." A repo without security tests cannot rule out security regressions; this sensor measures whether security tests exist and whether they constitute a meaningful share of the suite.

## Operational definition

Walk all test files. For each, check both the filename and its content for keyword matches against a security-pattern regex:

```
\b(auth|rbac|permission|tenant.*isolation|injection|xss|csrf|cve|sql.injection)\b
```

Files matching any of these patterns count as security tests.

Compute `security_pct = security_tests / total_tests * 100`.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `security_pct ≥ 5`.
- **REVIEW:** `2 ≤ security_pct < 5`.
- **FAIL:** `security_pct < 2`.

These thresholds are deliberately permissive — most adopters have far fewer security tests than they'd ideally want; the sensor surfaces this without weaponising it.

## Adopter overrides

- `extractor_params.test_security_coverage.patterns: string[]` — extend the keyword list.
- `extractor_params.test_security_coverage.thresholds: {pass:number, review:number}` — override thresholds (in percent). Default `{pass:5, review:2}`.

## Out of scope

- **Quality of security tests.** This sensor counts presence, not whether the tests actually catch a CVE pattern.
- **Authorization model correctness.** That's a code-side concern.
