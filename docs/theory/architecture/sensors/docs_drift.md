# Sensor: `docs_drift` → F5×T3

## Property semantics

**T3 Coherence** (Constitution Article 5) for F5 (Harness) asks whether prose
claims agree with the system they describe. Machine-derivable facts belong in live
queries; when prose states them, this sensor detects drift.

## Operational definition

Deterministic cross-checks of machine-derivable claims against ground truth, all rooted at `--repo-root`:

1. **Schema-count claims.** Every match of `/(\d+)\s+JSON Schema files?/i` in `README.md` and `CLAUDE.md` must equal the count of `*.schema.json` files under `law/schemas/`. Mismatch → error finding.
2. **Worktree-cap coherence.** A cap stated in `law/constitution.md` must equal the
   runtime constant when the adopter supplies a source path. Mismatch → error finding.
3. **Constitution-version coherence.** The `**Version:**` header in
   `law/constitution.md` must equal the one in `.devai/constitution.md`. Mismatch →
   error finding.

A claim pattern that matches nothing is not a failure — absence of a claim is the preferred state (live counts belong in CLI queries, not prose). Each absent claim produces an info finding so the reading shows what was checked.

`drift_count` = number of error findings.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `drift_count === 0`.
- **FAIL:** `drift_count ≥ 1`. A factually wrong reference claim is binary — there is no "slightly wrong" count; REVIEW is not emitted by this sensor.

## Adopter overrides

- `extractor_params.docs_drift.claim_files: string[]` — files scanned for claims 1–2. Default `["README.md", "CLAUDE.md"]`.
- `extractor_params.docs_drift.schemas_dir: string` — default `law/schemas`.
- `extractor_params.docs_drift.worktree_cap_source: string | null` — path of the file carrying the `WORKTREE_CAP` constant; `null` disables check 3 (adopters don't carry DEVAI's core source). Default `null` for adopters; DEVAI's own invocation passes `packages/core/src/loop/worktrees.ts`.

## Out of scope

- **Narrative status claims.** These are not machine-derivable without parsing prose
  semantics.
- **Test-count claims.** Suite counts change per commit; do not hand-write them.
- **LLM-judged coherence of prose.** That is `llm_judge` / soft-gate territory; this sensor stays deterministic L0.
