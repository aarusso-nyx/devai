---
title: Scorecard
sidebar_position: 5
---

# Scorecard

> The scorecard is the framework's MIMO error matrix: the 5×9 grid of (substrate, transversal) cells, each carrying a verdict. The hard gate is the deterministic component of error; the soft gate is the stochastic component. A merge requires both gates at or above threshold.

## Structure

Each cell of the scorecard is a single verdict, one of:

| Verdict     | Meaning                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **PASS**    | Sensor measured the cell at or above threshold.                                                                                |
| **REVIEW**  | Sensor measured below pass threshold but above review threshold. Triggers the tie-breaker ladder.                              |
| **FAIL**    | Sensor measured below review threshold. Blocks merge unconditionally.                                                          |
| **N/A**     | Cell is listed in the N/A ledger (`law/policy/scorecard-na.json`) with a reason; the ledger is the only source of N/A.         |
| **UNKNOWN** | Sensor produced no reading, or reading is stale / inconclusive. Treated as `unknown` per [Article 39](../../reference/law.md). |

The overall scorecard verdict is the worst per-cell verdict, with the tie-breaker ladder applied to any REVIEW.

## Grid size and N/A cells

The grid is 5 substrates × 9 properties = 45 cells. A cell is N/A only because the N/A ledger
`law/policy/scorecard-na.json` lists it with a written reason (ADR-SCR-0002); the loop derives its
set of degenerate cells from the ledger and holds no list of its own, so a change to that set is a
law change reviewed like any other ledger edit. The ledger is materialized byte-for-byte at
`.devai/config/scorecard-na.json`, which is the copy the scorecard reads.

For the framework repository the ledger lists two cells, so DEVAI scores **45 cells, 2 N/A, 43
scoreable**:

| Cell  | Substrate × property     | Why N/A                                                                                                                                                                |
| ----- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1:T1 | Specification × Coverage | Contract validation has no live emitter, so the cell is declared N/A rather than presented as reachable.                                                               |
| F4:T5 | Inventory × Idiomaticity | The degenerate cell Article 5 names: inventory artifacts are derived deterministically from F1, F2 and F3 and never authored, so idiomaticity has no authored subject. |

F4:T5 ships in the adopter default ledger, so every adopter starts at 45 cells, 1 N/A, 44
scoreable; F1:T1 is specific to this repository. See
[Scorecard N/A overrides](../../adopters/scorecard-na-overrides.md) for how an adopter edits its
ledger.

## One readings store

`sense record` persists every reading at `.devai/state/sensor-readings/<kind>/<id>.json`, and every
scorecard consumer resolves readings from that directory through the loop input resolver:
`audit scorecard` on demand and the Auditor after a merge read the same store, so a reading the
inspector records is visible to the on-demand scorecard at the same head without any copy or
rebuild step.

## Hard gate (Article 17)

The hard gate is the deterministic component of error _Error(0)_. It comprises:

- Type-check clean on affected projects.
- Lint clean on errors. Warnings handled separately by `Plant × Discipline`.
- Build succeeds for all affected apps.
- All assigned unit, integration, API, DB, E2E, and journey tests pass.
- Migrations apply cleanly from empty database.
- Contract validation: OpenAPI, JSON Schema, SQL DDL contracts validate; generated artifacts regenerate to identical bytes.
- Inventory regenerates without error.
- AST-diff test-weakening check: weakening does not exceed configured thresholds (Article 30).

A merge requires the hard gate fully green. The hard gate is non-negotiable; it emits only PASS or FAIL.

## Soft gate (Article 18)

The soft gate is the stochastic component. It comprises LLM-judged scorings against documented rubrics for:

- Spec coherence.
- Plant idiomaticity not covered by linters.
- Test depth and non-triviality.
- Spec-to-test traceability quality.
- Mutation-testing kill rate where applicable.

Soft-gate verdicts are tri-state (PASS / REVIEW / FAIL). REVIEW triggers the [tie-breaker ladder](#tie-breaker-ladder-article-23) before resolution.

Per Article 18, **soft-gate evaluation is performed by a model distinct from the working agent** — at minimum a different model instance with no shared context, preferably a different model family from the tie-breaker ladder. This prevents an agent from being evaluator of its own output.

## Threshold defaults

Default thresholds live in `.devai/scorecard/thresholds.json`. Per-cell thresholds are sensor-specific; the framework ships defaults with rationale, and clients may tighten or loosen via pack config (per-pack tightening is encouraged; per-pack loosening surfaces as a scorecard finding the Auditor reviews).

Selected defaults:

- **Coverage** (T1): ≥80% for PASS, ≥50% for REVIEW (per-substrate).
- **Test weakening** (Article 30): 20% max assertion-decrease ratio per file; absolute floor of 1 assertion; split-not-weaken exempt.
- **Mutation kill-rate**: configurable per pack; default 75% PASS / 50% REVIEW.
- **Test coverage depth** (F3 × T2): see [test policy](./test-policy.md) for the current content-addressed coverage policy.

## Tie-breaker ladder (Article 23)

When two disciplines disagree on whether a change satisfies a specification, or when a soft-gate verdict is REVIEW, the resolution ladder is:

1. **Independent verification by a model from a different family** with the same context and prompt.
2. If still tied, **escalate to a larger model in the same family**.
3. If still tied, **escalate to a larger model in the alternate family**.
4. If still tied, **escalate to human**.

The concrete model families and the ladder's tier ordering are F5 policy configuration, not constitutional text (Article 23 as amended at 0.3.0); in the supported harness each model invocation is human-initiated.

The ladder applies to soft-gate scoring disputes, RGR ambiguity classification, triage classification confidence below threshold, and any other case where stochastic judgment governs.

## Cycle stages

The scorecard is computed at three cycle levels (Article 16):

- **Cycle A** — within-iteration checkpoint. Affected-only hard gate. No iteration counter advance.
- **Cycle B** — pre-merge gate. Full hard gate on task scope. Iteration cap applies.
- **Cycle C** — post-merge integration. Full scorecard including soft gates and Auditor regeneration.

A merge requires Cycle B clean; the post-merge Cycle C runs after.

## See also

- [Constitution Articles 17 + 18 + 23](../../reference/law.md) — gates and tie-breakers.
- [Loop](./loop.md) — the three cycles in operational detail.
- [Aspect grid](./aspect-grid.md) — the cell-by-cell sensor mapping.
