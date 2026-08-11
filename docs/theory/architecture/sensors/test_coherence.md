# Sensor: `test_coherence` → F3×T3

## Property semantics

**T3 Coherence** (Constitution Article 5): "the parts fit together — naming, structure, and layering are consistent." For F3 (Observation), this means the test suite obeys a single convention: test files use a uniform naming pattern; every package has _some_ tests; the test/source ratio is roughly proportional across packages.

## Operational definition

Walk a configured set of package roots (default `packages/*`). For each package:

1. **Count source files.** `.ts` / `.tsx` under `src/`, excluding `.d.ts` and any file ending in `.test.*` / `.spec.*`.
2. **Count test files.** Any `.test.*` or `.spec.*` under `test/` or co-located in `src/`.
3. **Compute test/source ratio.** Zero source files → ratio = 1.0 (trivially coherent).

Aggregate:

- `naming_uses_test`: number of `.test.*` files across all packages.
- `naming_uses_spec`: number of `.spec.*` files.
- `naming_consistent`: 1 iff only one of the two is non-zero.
- `packages_below_min_ratio`: count of packages where ratio < 0.1 (default).

## PASS / REVIEW / FAIL boundaries

- **PASS:** `naming_consistent === 1` AND `packages_below_min_ratio === 0` AND global ratio ≥ 0.3.
- **REVIEW:** naming consistent but ratio low in some packages, OR naming mixed with at most one offender package.
- **FAIL:** global ratio < 0.1.

## Adopter overrides

- `extractor_params.test_coherence.package_roots: string[]` — override the package scan. Default `['packages/*']`.
- `extractor_params.test_coherence.min_per_package_ratio: number` — per-package minimum. Default `0.1`.
- `extractor_params.test_coherence.pass_ratio: number` — global PASS threshold. Default `0.3`.

## Out of scope

- **Test quality.** This sensor measures _presence and distribution_, not whether tests actually cover meaningful behaviour.
- **Test-pattern coverage** (auth/perf/error tests). Those are F3×T6/T7/T8, covered by 27.J/K/L.
