---
title: Transversals
sidebar_position: 3
---

# Transversals

> [Constitution Article 5](../../reference/law.md) declares nine transversal properties. Each transversal applies across all five substrates. The Cartesian product of substrates and transversals defines the aspect grid that the scorecard computes verdicts over.

## The nine transversals

| ID  | Name                       | What it measures                                                               | Example sensors                                                                                                                                    |
| --- | -------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Coverage                   | Does the substrate cover what it should? Are there gaps?                       | `sense-spec-depth`, `sense-test-coverage-depth`, `sense-inventory-adherence`, `sense-harness-coverage`                                             |
| T2  | Depth                      | Are individual artifacts substantive, or shallow?                              | `sense-spec-depth`, `sense-test-coverage-depth`, `sense-plant-depth`                                                                               |
| T3  | Coherence                  | Do the parts of this substrate agree with one another?                         | `sense-spec-alignment` (cross-references), `sense-test-coherence`, `sense-harness-coherence`                                                       |
| T4  | Alignment                  | Does this substrate agree with the substrates above it in the authority chain? | `sense-test-invariant-alignment`, `sense-harness-invariant-alignment`, `sense-spec-alignment`                                                      |
| T5  | Idiomaticity               | Does this substrate follow the framework's idioms? Linter-style.               | `sense-spec-idiomaticity`, `sense-plant-coherence` + lint, `sense-test-idiomaticity`, `sense-harness-idiomaticity`                                 |
| T6  | Security and Privacy       | Are security/privacy concerns named, tested, and enforced?                     | `sense-security-scan`, `sense-spec-security-coverage`, `sense-test-security-coverage`, `sense-harness-security`                                    |
| T7  | Performance and Efficiency | Are perf/efficiency concerns named and tested?                                 | `sense-perf-test`, `sense-spec-performance-targets`, `sense-test-performance-coverage`, `sense-inventory-performance`, `sense-harness-performance` |
| T8  | Robustness                 | Does the substrate handle stress, failure, edge cases?                         | `sense-spec-robustness-targets`, `sense-test-robustness-coverage`, `sense-harness-robustness`                                                      |
| T9  | Discipline                 | Are framework rules honored over time? Is there drift?                         | `sense-test-weakening` (Article 30), `sense-harness-green-main`, `sense-trace-resolve`                                                             |

Each transversal is a single property evaluated five times — once per substrate. T6 (Security) for F1 is "are security invariants named?"; T6 for F2 is "is the code secure?"; T6 for F3 is "do tests probe security?"; and so on.

## The 5×9 aspect grid

The Cartesian product is the **aspect grid**: 45 cells indexed by (substrate, transversal). Each cell has at most one sensor mapped to it (some have multiple; some are degenerate and marked N/A).

The grid is the canonical view of the framework's regulation surface. See [Aspect grid](./aspect-grid.md) for the generated table mapping cells to sensors; W10's `gen-aspect-grid.mjs` produces it from `cell-mapping.json` + the per-sensor design notes under `docs/theory/architecture/sensors/`.

## Degenerate cells (N/A)

Some cells are degenerate by definition. F4 × T5 (Idiomaticity) is N/A because inventory is generated, not authored — it has no idiomatic style. F5 × T2 (Depth) is N/A because harness artifacts are config + machinery, not depth-bearing prose.

Per-repo N/A overrides are also possible: a client can declare specific cells N/A in their pack config if the cell is meaningfully inapplicable (e.g., a frontend-only service has no F2 × T7 DB-perf concern). The default scorecard treats unmarked N/A cells as exempt; the audit log records the override and its rationale.

## How transversals interact with the scorecard

The scorecard computes one verdict per cell (PASS / REVIEW / FAIL / N/A / UNKNOWN). The overall verdict is a roll-up:

- Any FAIL → overall FAIL.
- Otherwise, any REVIEW → overall REVIEW.
- Otherwise (all PASS / N/A) → overall PASS.

The [scorecard](./scorecard.md) page covers the threshold defaults, the soft-gate rubrics, and the tie-breaker ladder when verdicts disagree.

## See also

- [Constitution Article 5](../../reference/law.md) — the transversal enumeration.
- [Aspect grid](./aspect-grid.md) — generated cell × sensor mapping.
- [Scorecard](./scorecard.md) — verdict semantics + thresholds.
