# Sensor: `spec_robustness_targets` → F1×T8

## Property semantics

**T8 Robustness** (Constitution Article 5): "the artifact addresses error paths, failure modes, retry behaviour, and degradation." For F1 (Spec), this means the spec substrate names _concrete_ robustness/error-semantics targets — not "should handle errors" but "all writes are idempotent under retry" or "any GET on a missing resource returns 404 with code MISSING_RESOURCE."

## Operational definition

Two presence checks:

- **Count invariants of `type: 'error_semantics'`** (or `data_contract` with the word "error" / "retry" / "idempotent" in their `statement`) in `law/invariants/*.json`.
- **Count error-contract files** under `docs/reference/contracts/` matching `errors*.json` or `error-*.{md,json}`.

The metrics field reports both counts plus a derived `targets_total`.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `error_semantics_invariants ≥ 1` AND `error_contract_files ≥ 1`.
- **REVIEW:** exactly one of the two is non-zero.
- **FAIL:** both zero.

## Adopter overrides

- `extractor_params.spec_robustness_targets.error_contract_globs: string[]` — override the file search. Default `['docs/contracts']` (any file under there matching the error-name regex).

## Out of scope

- **Whether the error contracts are actually enforced.** That's F3×T8, covered by 27.L `test_robustness_coverage`.
