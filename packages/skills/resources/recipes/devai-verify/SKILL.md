---
name: devai-verify
description: Independent read-only review of a DEVAI change, docs coherence, or release candidate against its evidence. Use for "review this change", "is the RC coherent", or when a campaign's review step runs.
license: Apache-2.0
compatibility: Invoked by a host that reads Agent Skills from .agents/skills or .claude/skills; needs the adjacent devai.recipe.json and devai.operations.json and the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: stable
  devai-recipe-schema: '1'
---

# DEVAI verify

Read the adjacent `devai.recipe.json`. Select one variant (`change`, `docs-coherence`, `rc`), establish the exact subject and its evidence, then run only that variant's deterministic verification operations.

Report every failure, missing piece of evidence and uncertainty plainly; report everything you find and let the orchestrator filter by severity. This is read-only: no repairs, no file mutation.

## Orchestrator review step

When a campaign runs with `review.mode: model-advisory` (ADR-GOV-0023), the orchestrator runs the `change` variant in a subagent that is a model instance distinct from the task's working agent (ADR-MDL-0001):

1. The subagent ends its reply with exactly one review verdict document in the shape `law/schemas/review-verdict.schema.json` declares — `verdict` ∈ {pass, review, fail, unknown}, `confidence` ∈ [0, 1], `rationale`, `findings`. Prose before it and a code fence around it are allowed; a second object, an echoed example or a partial document is not.
2. The orchestrator passes the full reply through the shared extractor in the model bridge. It returns a schema-valid document or an `error` outcome with a bounded redacted excerpt and the SHA-256 of the reply.
3. A valid document is recorded on the task's `review` block with the reply digest, the evaluator as `runtime:model`, and the time. It is advice to the ratifying human; it never satisfies a gate, merges, or authorizes an effect.
4. On `error` (no candidate, conflicting candidates, malformed field, provider error, `length` finish) the task stays in `pre_merge`; rerun or escalate — never record a guessed verdict.
5. Re-check deterministically: `devai check --only schema --schema law/schemas/review-verdict.schema.json --instance <file>`.
