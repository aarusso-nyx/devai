# Sensor: `harness_invariant_alignment` → F5×T4

## Property semantics

**T4 Alignment** (Constitution Article 5) for F5 (Harness): "does CI run what the spec says it should?" Concretely: for each `severity: gate` invariant, does at least one CI workflow actually execute one of its `measurable_via[]` actions? An invariant declared as a gate but never measured in CI is misaligned.

## Operational definition

1. Walk `law/invariants/*.json`; collect every invariant with `severity === 'gate'`.
2. For each, collect its `measurable_via[]` strings (e.g. `"sense rbac"`, `"sense coverage"`).
3. Walk all workflow `run:` scripts + `uses:` references via `workflow-parser`.
4. An invariant is _aligned_ iff ≥ 1 of its `measurable_via[]` entries appears (substring match, after normalising "sense rbac" → both "sense rbac" and "sense-rbac") in any workflow's `run:` body or `uses:` reference.

## PASS / REVIEW / FAIL boundaries

- **PASS:** every gate-severity invariant is aligned.
- **REVIEW:** zero gate invariants exist (nothing to align), OR 1-2 misaligned invariants.
- **FAIL:** ≥ 3 misaligned gate invariants.

## Adopter overrides

- `extractor_params.harness_invariant_alignment.gate_severity_value: string` — override the severity value treated as a gate. Default `'gate'`.

## Out of scope

- **Non-gate invariants.** Hard-fail / constitutional invariants are out of scope here; they have their own enforcement paths.
- **Whether the aligned action _succeeded_ in CI.** That's harness performance/robustness territory.
