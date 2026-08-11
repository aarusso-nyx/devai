# Sensor: `harness_idiomaticity` → F5×T5

## Property semantics

**T5 Idiomaticity** (Constitution Article 5) for F5 (Harness): "does CI follow the conventions of the ecosystem it lives in?" For GitHub Actions, the canonical idioms are: factor repeated step sequences into composite actions or reusable workflows; cache deps (don't reinstall every time); use the dedicated `pnpm/action-setup` and `actions/setup-node@vX` over hand-rolled shell.

## Operational definition

Across all workflows, count three discipline signals:

1. **Composite action usage.** `uses: ./.github/actions/<name>` references count.
2. **Reusable workflow usage.** `uses: ./.github/workflows/<file>.yml` or `<owner>/<repo>/.github/workflows/<file>.yml`.
3. **Cache action usage.** Any `uses:` containing `cache` (e.g. `actions/cache@vX`, `actions/setup-node` with cache built in).

`idiomaticity_score = (composite_present ? 1 : 0) + (reusable_present ? 1 : 0) + (cache_present ? 1 : 0)`.

## PASS / REVIEW / FAIL boundaries

- **PASS:** `idiomaticity_score === 3`.
- **REVIEW:** `1 ≤ idiomaticity_score ≤ 2`.
- **FAIL:** `idiomaticity_score === 0` AND `workflow_count > 0`.

## Adopter overrides

None at present (signals are universal GitHub Actions idioms).

## Out of scope

- **Workflow-level optimisation choices.** `runs-on: ubuntu-22.04` vs `ubuntu-latest`, action SHA pinning depth.
- **Step-naming conventions.** Subjective.
