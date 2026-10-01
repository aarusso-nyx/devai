---
title: Scorecard
sidebar_position: 5
---

# Scorecard

> The scorecard is the framework's MIMO error matrix: the 5×9 grid of (substrate, transversal) cells, each carrying a verdict. The hard gate is the deterministic component of error; the soft gate is the stochastic component. A merge requires both gates at or above threshold.

## Structure

Each cell of the scorecard is a single verdict, one of:

| Verdict     | Meaning                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **PASS**    | Sensor measured the cell at or above threshold.                                                                                                                                                                                                  |
| **REVIEW**  | Sensor measured below pass threshold but above review threshold. Triggers the tie-breaker ladder.                                                                                                                                                |
| **FAIL**    | Sensor measured below review threshold. Blocks merge unconditionally.                                                                                                                                                                            |
| **N/A**     | Cell is listed in the N/A ledger (`law/policy/scorecard-na.json`) with a reason, or every reading in it is `skipped` for a surface the repository declared absent (the [skipped-reading rule](#declared-surfaces-and-the-skipped-reading-rule)). |
| **UNKNOWN** | Sensor produced no reading, or reading is stale / inconclusive. Treated as `unknown` per [Article 39](../../reference/law.md).                                                                                                                   |

The overall scorecard verdict is the worst per-cell verdict, with the tie-breaker ladder applied to any REVIEW.

## Grid size and N/A cells

The grid is 5 substrates × 9 properties = 45 cells. A cell is N/A for one of two stated reasons and
no other. The first is the N/A ledger `law/policy/scorecard-na.json`, which lists a degenerate cell
with a written reason (ADR-SCR-0002); the loop derives its set of degenerate cells from the ledger
and holds no list of its own, so a change to that set is a law change reviewed like any other ledger
edit. The ledger is materialized byte-for-byte at `.devai/config/scorecard-na.json`, which is the
copy the scorecard reads. The second is a plant surface the repository declared absent, which makes
every sensor bound to it skip; that path is reading-driven and described under
[Declared surfaces and the skipped-reading rule](#declared-surfaces-and-the-skipped-reading-rule).

For the framework repository the ledger lists two cells, so DEVAI's ledger fixes **45 cells, 2 N/A,
43 scoreable** before any reading lands:

| Cell  | Substrate × property     | Why N/A                                                                                                                                                                |
| ----- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1:T1 | Specification × Coverage | Contract validation has no live emitter, so the cell is declared N/A rather than presented as reachable.                                                               |
| F4:T5 | Inventory × Idiomaticity | The degenerate cell Article 5 names: inventory artifacts are derived deterministically from F1, F2 and F3 and never authored, so idiomaticity has no authored subject. |

F4:T5 ships in the adopter default ledger, so every adopter starts at 45 cells, 1 N/A, 44
scoreable; F1:T1 is specific to this repository. See
[Scorecard N/A overrides](../../adopters/scorecard-na-overrides.md) for how an adopter edits its
ledger.

## Declared surfaces and the skipped-reading rule

The inventory and plant sensors identify a plant through HTTP endpoints, routes, tables, roles, and
PII columns. A repository that has none of those is not failing to cover them; it never claimed
them. ADR-SCR-0003 therefore lets an adopter declare its plant surfaces once, in
`.devai/config/sensor-inputs.json` under `surfaces`: `http`, `database`, `rbac`, and `actions`,
each `true` or `false` (see [Sensor inputs](../../adopters/sensor-inputs.md#surfaces)). A sensor
bound only to surfaces declared absent emits a `skipped` reading carrying the declaration as its
reason (the message of its first finding); a sensor that finds evidence of a surface declared absent
reports `review` instead, so a false declaration is caught rather than honored.

The composer applies one rule to a skipped reading, in this order of precedence:

1. **A ledger N/A wins over everything.** A cell the ledger lists takes no reading at all, skipped
   or measured; its record carries neither `sensor_readings` nor `notes`.
2. **A measured reading makes its skipped siblings inert.** A cell that holds any measured reading
   (`pass`, `review`, `fail`, `unknown`, `error`, `killed`) takes its verdict from the worst-of
   collapse of the measured readings alone, exactly as before the record; each skipped reading is
   listed in the cell's `sensor_readings` and moves neither the verdict nor the `deterministic`
   flag.
3. **An all-skipped cell is N/A by declaration.** A cell whose readings are all skipped is recorded
   `N/A`, never `UNKNOWN` or `REVIEW`. Its `sensor_readings` list the skipped readings and its
   `notes` open with the marker `N/A-declaration:` followed by one `<kind>: <reason>` entry per
   skipped reading, joined by `; `.

The two N/A sources stay distinguishable in the cell record without a new field, because
`scorecard.schema.json` closes the cell object: a ledger N/A has no readings and no notes, a
declaration N/A has both, and `scorecardCellNaSource(cell)` in the loop package reads back
`ledger` or `declaration`. Substrate aggregates and the overall verdict leave a declaration N/A
out the way they leave a ledger N/A out. Declaring a surface absent changes no threshold and no
verdict rule; the only cells it can move are the cells whose every sensor is bound to that
surface.

For the framework repository, which declares `http`, `database`, and `rbac` absent and `actions`
present, the sensor registry binds the affected cells as follows once the sensors honor the
declaration:

| Cell  | Substrate × property             | Sensors bound to it                                                               | Result                                                                                     |
| ----- | -------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| F2:T1 | Plant × Coverage                 | `plant_coverage`                                                                  | Measured: registered actions against their specification links.                            |
| F4:T1 | Inventory × Coverage             | all seven inventory kinds                                                         | Measured: `inventory_coverage` (actions) and `inventory_dep_graph` measure, the rest skip. |
| F4:T2 | Inventory × Depth                | `inventory_api`, `inventory_routes`, `inventory_data_model`, `inventory_coverage` | Measured: `inventory_coverage` (actions) measures, the rest skip.                          |
| F4:T6 | Inventory × Security and Privacy | `inventory_rbac`, `inventory_data_handling`                                       | N/A by declaration: both sensors skip for the absent `rbac` surface.                       |

So the DEVAI grid reads **45 cells, 2 ledger N/A (F1:T1, F4:T5), 1 declaration N/A (F4:T6), 42
scoreable** once the sweep records the inventory sensors under the declaration; the three other
cells the absent surfaces used to drag to review are measured through the action surface instead.
The declaration N/A is a property of the readings, not of the ledger, so it appears only in a
scorecard composed from readings taken under the declaration, and the ledger count above is
unchanged.

## One readings store

`sense record` persists every reading at `.devai/state/sensor-readings/<kind>/<id>.json`, and every
scorecard consumer resolves readings from that directory through the loop input resolver:
`audit scorecard` on demand and the Auditor after a merge read the same store, so a reading the
inspector records is visible to the on-demand scorecard at the same head without any copy or
rebuild step.

The first scorecard recorded this way is rendered on the
[Self-scorecard](../../reference/scorecard.md) page from its record
[SC-20260927T205906-001](../../../record/proofs/compliance/scorecards/SC-20260927T205906-001.json),
observed on DEVAI's own main branch in round R-0206.

### Reading instances and the recording order

A recorded reading is immutable (ADR-SCR-0008). Its id stays content-derived and the file under
`.devai/state/sensor-readings/<kind>/<id>.json` is never rewritten: a same-id different-body write
is refused with `SENSE_RECORD_ID_CONFLICT`, and a same-id same-body write is `already-recorded`. A
later reading of the same kind for the same candidate is a new instance that names the earlier id
in its optional `supersedes` field, and the loop resolver selects the latest instance per kind and
candidate by following those links, never by file time. The store is therefore an append-only
history per kind and candidate, and the scorecard reads the newest instance without a rebuild.

A recording is two ordered writes. `sense record` writes the reading file first, then appends one
`sense.readings.record` entry to `record/proofs/chain.json` naming the reading id, its kind, and the
SHA-256 of the file bytes. A missing entry is repaired by re-running `sense record` on the same
file, which appends and edits nothing; a digest mismatch is a finding, not a repair. The
`harness_invariant_alignment` sensor accepts a store reading when the reading carries its candidate
binding or its chain entry carries the candidate head, and ignores a reading with neither.

The sweep stays read-only. Two of its members measure the store itself, so on a fresh worktree they
would read an empty store if they ran beside the sensors whose readings they measure. The `sweep`
preset therefore declares an ordered second pass in `selection_effect_rule.sweep_second_pass` of
`law/policy/sense-presets.json`, today `harness_invariant_alignment` and `inventory_performance`,
and the recording protocol is first pass, record, second pass, record. Recording is the inspector's
harness-write step; the preset never records. F4:T7 and F5:T4 then read PASS or FAIL from the
substrate, and never REVIEW for the absence of their own inputs.

### Per-cell applicability of F4:T4 and F4:T9

Applicability is decided per cell from the subject the cell measures, never as a blanket N/A for a
sensor family. The ledger carries no entry for either cell:

| Cell  | Substrate × property   | Sensor bound to it       | Decision                                                                                                                                                              |
| ----- | ---------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F4:T4 | Inventory × Alignment  | `inventory_adherence`    | Measured. N/A only when every surface the sensor measures is declared absent in `sensor-inputs.json`; the framework declares `actions` present.                       |
| F4:T9 | Inventory × Discipline | `inventory_regeneration` | Measured. The regenerated `inventory_dep_graph` and `inventory_coverage` kinds are present on the framework, and a ledger N/A while their readings exist is rejected. |

Each cell reads a measured verdict or a ledger-anchored N/A with its reason, never an unexplained
blank. The ledger count above is unchanged: DEVAI's ledger still lists F1:T1 and F4:T5 only.

### The observation backlog

The backlog the Auditor compiles after a merge (Article 33) has a contract:
`law/schemas/observation-backlog.schema.json` describes the `backlog.json` that `audit observe`
writes into the observation bundle, with the observed merge sha, the timestamp, one observation per
scorecard cell carrying its verdict and reading ids, and the deltas against the previous bundle.
The object is closed, so an unknown top-level key or an observation without its cell fails, and the
validating suite rejects a delta that names a cell absent from the current observations. The
post-merge hook resolves readings from the bound checkout's `.devai/state/sensor-readings`, never
from the detached worktree root.

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

Each soft-gate reading comes from a model reply that carries one structured verdict document in the shape `law/schemas/review-verdict.schema.json` declares: `verdict`, `confidence`, `rationale`, and `findings` (ADR-MDL-0001). The `llm_judge` emitter reads it through the shared extractor in the model bridge, which accepts exactly one unambiguous candidate object in the reply, fenced or not, and refuses conflicting candidates, echoed examples, malformed fields, provider errors, and truncated replies. A refused reply is an `error` reading with a bounded redacted excerpt and the SHA-256 of the full reply, never a silent `unknown`; `unknown` remains the model's own explicit uncertainty under Article 39.

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

The cross-family breaker of step 1 replies with a document in the shape `law/schemas/triage-breaker.schema.json` declares: `classification`, `confidence`, and `rationale` (ADR-MDL-0001), read through the same extractor. A vote that matches one candidate resolves the tie in that candidate's favour; any other vote, including `inconclusive`, escalates to a human. The breaker refuses a review verdict and the judge refuses a breaker vote: neither consumer accepts the other's document.

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
