# Sensor: `test_idiomaticity` → F3×T5

## Property semantics

**T5 Idiomaticity** (Constitution Article 5): "the artifact follows the conventions and idioms expected by its ecosystem." For F3 (Observation), idiomaticity means the test suite uses fixture patterns consistently, doesn't drown in mocks where real DI/integration is feasible, and uses snapshots sparingly.

## Operational definition

Walk test files (`*.test.*` and `*.spec.*`) under configurable roots. For each file, scan content (regex):

- `beforeAll`/`beforeEach`/`afterAll`/`afterEach` calls → fixture-pattern usage.
- `jest.mock(`, `vi.mock(`, `vi.fn(`, `jest.fn(` → mock-usage.
- `toMatchSnapshot(`, `toMatchInlineSnapshot(` → snapshot-test usage.

Compute:

- `mock_heavy_files`: files with ≥ 2 mock-usage hits.
- `mock_heavy_ratio`: `mock_heavy_files / total test files`.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `mock_heavy_ratio < 0.5` AND zero "integration" or "e2e" files use mocks (mock-in-integration is the canonical anti-pattern).
- **REVIEW:** `0.5 ≤ mock_heavy_ratio < 0.8` OR at least one integration/e2e file uses mocks.
- **FAIL:** `mock_heavy_ratio ≥ 0.8` (suite is dominated by mocks; signal of either over-isolation or insufficient real-DI testing).

## Adopter overrides

- `extractor_params.test_idiomaticity.test_globs: string[]` — override test roots. Default `['packages/*/test', 'packages/*/src']`.
- `extractor_params.test_idiomaticity.thresholds: {review:number, fail:number}` — override ratios. Default `{review:0.5, fail:0.8}`.

## Out of scope

- **Test naming style.** Already covered by 27.H `test_coherence`.
- **Pattern catalogues** (page-object, builder-pattern). Adopter-specific; defer.
