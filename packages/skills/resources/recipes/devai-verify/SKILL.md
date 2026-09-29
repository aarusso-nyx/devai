---
name: devai-verify
description: Review code, documentation, or evidence without modifying product files.
license: Apache-2.0
compatibility: Invoked by a host that reads Agent Skills from .agents/skills or .claude/skills; needs the adjacent devai.recipe.json and devai.operations.json and the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: stable
  devai-recipe-schema: '1'
---

# DEVAI verify

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`. Select only a declared variant, obey its exact effect and write policy, and invoke only the descriptor's exact operation behavior.

Use this recipe for an independent, read-only review.

1. Select exactly one declared variant: `change`, `docs-coherence`, or `rc`.
2. Establish the exact subject and evidence before evaluating it.
3. Run only the selected variant's deterministic verification operations.
4. Report failures, missing evidence, and uncertainty honestly.
5. Do not repair findings, mutate files, invoke another model, or perform remote actions.

## Orchestrator review step

When a campaign runs with `review.mode` set to `model-advisory` (ADR-GOV-0023), the orchestrator session runs the `change` variant in a subagent that is a model instance distinct from the task's working agent, and reads the reply as follows (ADR-MDL-0001).

1. The subagent ends its reply with exactly one review verdict document in the shape `law/schemas/review-verdict.schema.json` declares: `verdict` from `pass`, `review`, `fail`, or `unknown`; `confidence` in [0, 1]; `rationale`; and `findings`. Prose before the document and a code fence around it are allowed; a second object, an echoed example, or a partial document is not.
2. The orchestrator passes the full reply through the shared extractor in the model bridge and never parses it by hand. The extractor returns either a document that validates against the schema or an `error` outcome with a bounded redacted excerpt and the SHA-256 of the full reply.
3. A validated document is recorded on the task's `review` block with the reply digest, the evaluator in `runtime:model` form, and the time. It is advice to the ratifying human; it never satisfies a gate, merges, or authorizes an effect.
4. An `error` outcome (no candidate, conflicting candidates, a malformed field, a provider error, or a `length` finish) is reported with its excerpt and digest. The task stays in `pre_merge`; the orchestrator reruns the review or escalates and never records a guessed verdict.
5. To re-check a recorded document deterministically, run `devai check --only schema --schema law/schemas/review-verdict.schema.json --instance <file>`.
