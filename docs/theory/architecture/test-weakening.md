# Test weakening

**Contract:** `law/schemas/test-weakening-config.schema.json`.

## Rule

DEVAI's test-weakening detector watches for **silent degradation of the Inspector substrate**: scenarios where a PR reduces the assertion density or assertion strictness of an existing test without an accompanying invariant change.

The detector has tunable thresholds:

- `threshold_ratio` — flag if the new test asserts < `(1 - threshold_ratio) × old`. Default `0.20` (i.e., 20% drop is the flag threshold).
- `absolute_floor` — flag if the new test has fewer than `absolute_floor` assertions regardless of ratio. Default `1`.
- `ignored_paths` — regex list of paths exempt from the check (e.g., test fixtures during a restructure).
- `split_not_weaken` — when a test is split into multiple smaller tests whose union retains the original assertion count, the split is not flagged.

Each adopter project can override these defaults independently via
`.devai/config/test-weakening.json`, schema-validated against
`test-weakening-config.schema.json`. An absent file selects the documented defaults.

## Rationale

Hardcoded thresholds make the detector noisy for projects whose test culture differs
from the defaults:

- **False positives** if the defaults were stricter than the project's reality (mostly small projects with low assertion density).
- **False negatives** if the defaults were looser than the project's reality (mostly governance-heavy projects with high assertion density and meaningful drift below the 20% threshold).

The config surface resolves both. The defaults remain the canonical-DEVAI tuning; adopters tighten or loosen as their own culture demands.

Values clamp into safe ranges on load (`threshold_ratio` to `[0, 1]` and
`absolute_floor` to a non-negative value). A malformed config logs the clamping and
continues.

## Practical consequences

1. **Loader entry point:** `loadTestWeakeningConfig(repoRoot)` in `packages/sensors/src/test-weakening-config.ts`. Reads `.devai/config/test-weakening.json` if present, returns canonical defaults otherwise.

2. **Schema:** `law/schemas/test-weakening-config.schema.json` declares the shape:

   ```json
   {
     "threshold_ratio": { "type": "number", "minimum": 0, "maximum": 1 },
     "absolute_floor": { "type": "integer", "minimum": 0 },
     "ignored_paths": { "type": "array", "items": { "type": "string", "format": "regex" } }
   }
   ```

3. **Adopters tighten or loosen without forking DEVAI.** A project may set
   `threshold_ratio: 0.05` to flag any 5% drop, or `0.40` to flag only larger drops.

4. **`ignored_paths` exempts legitimate restructures.** During a code reorganization
   that legitimately deletes some tests, the matching paths can be added to
   `ignored_paths` and reviewed with the change.

5. **Repositories without the config file use the stable defaults.**

## Authority and overrides

A test weakening flagged by the detector is a **REVIEW** verdict by default, not a hard fail. The Inspector substrate's Article-24 authority constraint says an Inspector acting alone cannot weaken a test independently: relaxation requires either an Architect invariant change (Article 24) or an RGR (Article 22).

The detector's findings feed:

- **Triage classification**, which decides whether the finding gates the merge.
- **The scorecard's Discipline column (T9)** for the Inspector substrate.

A `test-weakening-override` annotation can suppress an individual finding when
justified, with the override recorded as evidence.

## When to revisit

Revisit this contract if:

- Empirical evidence shows the default thresholds are wrong for the typical adopter shape (e.g., most adopters override `threshold_ratio` upward, suggesting `0.20` is too strict as a default).
- A new dimension of weakening becomes important, such as a reduction in assertion
  strictness or runtime coverage.
- The clamping behaviour proves problematic in practice (a real config bug masked by silent clamping). Currently the log-and-continue posture has been correct.
