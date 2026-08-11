# Sensor: `spec_alignment` → F1×T4

## Property semantics

**T4 Alignment** (Constitution Article 5): "the artifact says what the system actually does." For F1 (Spec), alignment is bidirectional:

- **Forward.** Every claim in the spec resolves to real plant — every invariant's `scope.code_areas[]` glob matches ≥ 1 file on disk.
- **Reverse.** Every part of the plant is claimed by some spec — every authored source module is referenced by ≥ 1 invariant's `scope.code_areas[]`.

Forward catches _stale_ spec (claims about deleted code). Reverse catches _unclaimed_ code (drift from documented intent).

## Operational definition

Run two scans against a single repo root:

1. **Forward scan.** Walk `law/invariants/*.json`. For each invariant, expand each `scope.code_areas[]` glob (trailing `/**` stripped to a directory; literal paths statted directly) and count matched files. An invariant whose every entry matches zero files is _broken-forward_.
2. **Reverse scan.** Walk a configured set of source directories (default `packages/*/src/**`). For each `.ts` / `.tsx` / `.js` file, test it against the union of all `scope.code_areas[]` globs. Files matching zero globs are _unclaimed-reverse_.

Both metrics published in the SR `metrics` block.

## PASS / REVIEW / FAIL boundaries

- **PASS:** every invariant has ≥ 1 matched file AND ≥ 80 % of source files are claimed by some invariant.
- **REVIEW:** every invariant has ≥ 1 matched file but reverse-claim ratio < 80 %.
- **FAIL:** at least one invariant has zero matched files (stale-spec).

The forward direction is hard-fail because stale spec is a correctness problem (invariants making false claims). The reverse direction is REVIEW-grade because unclaimed code is a discipline signal, not a hard fault — most codebases have utility/internal code reasonably unclaimed.

## Adopter overrides

- `extractor_params.spec_alignment.source_globs: string[]` — override the reverse-scan source globs. Default `['packages/*/src/**']`.
- `extractor_params.spec_alignment.reverse_threshold_pct: number` — REVIEW/PASS boundary for reverse ratio. Default `80`.

## Out of scope

- **Per-claim verification of _semantic_ alignment** (does the file actually implement what the invariant says?). That requires an LLM judge and is outside the current deterministic kind.
- **Test alignment** (do tests claim invariants in `trace.json`?). That is an F3×T4 concern covered by `test_invariant_alignment`.
- **Cross-cell aggregation.** Per-cell only; the scorecard rolls up.
