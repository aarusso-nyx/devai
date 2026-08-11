---
name: devai-verify
description: Review code, documentation, or evidence without modifying product files.
---

# DEVAI verify

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`. Select only a declared variant, obey its exact effect and write policy, and invoke only the descriptor's exact operation behavior.

Use this recipe for an independent, read-only review.

1. Select exactly one declared variant: `change`, `docs-coherence`, or `rc`.
2. Establish the exact subject and evidence before evaluating it.
3. Run only the selected variant's deterministic verification operations.
4. Report failures, missing evidence, and uncertainty honestly.
5. Do not repair findings, mutate files, invoke another model, or perform remote actions.
