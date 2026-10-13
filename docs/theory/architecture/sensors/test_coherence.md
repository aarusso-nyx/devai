# Sensor: `test_coherence` → F3×T3

## Property semantics

**T3 Coherence** (Constitution Article 5): "the parts fit together — naming, structure, and layering are consistent." For F3 (Observation), this means test files use a consistent naming pattern within each established runner family; every package has _some_ tests; the test/source ratio is roughly proportional across packages.

## Operational definition

Walk a configured set of package roots (default `packages/*`). For each package:

1. **Count source files.** `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` and `.cjs` files, excluding `.d.ts` and executable test files.
2. **Count test files.** The complete population recognized by the shared classifier: `.test`, `.spec`, `.e2e` or `.wiring-spec` followed by any of those six source extensions. Scan the complete configured package roots without dropping files by runner family.
3. **Compute test/source ratio.** Zero source files → ratio = 1.0 (trivially coherent).

Aggregate:

- `naming_uses_test`: number of `.test.*` files across all packages.
- `naming_uses_spec`: number of `.spec.*` files.
- `naming_consistent`: 1 when the global convention is uniform, or when every named test has one established runner family and each family uses one convention. Distinct runner families may use distinct conventions. Mixed conventions within a family, or mixed global conventions with any unknown/ambiguous named test, yield 0.
- `packages_below_min_ratio`: count of packages where ratio < 0.1 (default).

## PASS / REVIEW / FAIL boundaries

- **PASS:** `naming_consistent === 1` AND `packages_below_min_ratio === 0` AND global ratio ≥ 0.3.
- **REVIEW:** naming is mixed under the family rule, a package is below its minimum ratio, or the global ratio is below the PASS threshold but at or above the minimum.
- **FAIL:** global ratio < 0.1.

## Establishing a runner family

Use static executable references to the runner test API. For example, a Node TAP
`.test.mjs` and a Vitest `.spec.ts` can each be coherent within their own family.
Extensions, comments, strings, type-only imports, unused imports and local
lookalike functions do not identify a runner. Ambiguous or unsupported references
retain conservative comparison. This classification supplies no execution origin
or native result standing, and changes no ratio denominator or threshold.

The supported static naming families are Node TAP (`node:test`), Vitest
(`vitest`) and Jest (`@jest/globals`). Require a top-level ESM value import and an
actual direct test or suite API call from that imported binding. Node TAP supports
default, named and namespace imports of `test`, `it`, `describe` or `suite`;
Vitest and Jest support named and namespace imports of `test`, `it` or `describe`.
An unproved binding, shadowing, unsupported call shape or CommonJS import remains
unclassified. These source references describe naming families, never proof of
the installed or executed runner.

## Adopter overrides

- `extractor_params.test_coherence.package_roots: string[]` — override the package scan. Default `['packages/*']`.
- `extractor_params.test_coherence.min_per_package_ratio: number` — per-package minimum. Default `0.1`.
- `extractor_params.test_coherence.pass_ratio: number` — global PASS threshold. Default `0.3`.

## Out of scope

- **Test quality.** This sensor measures _presence and distribution_, not whether tests actually cover meaningful behaviour.
- **Test-pattern coverage** (auth/perf/error tests). Those are F3×T6/T7/T8, covered by 27.J/K/L.
