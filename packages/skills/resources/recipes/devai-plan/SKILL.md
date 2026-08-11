---
name: devai-plan
description: Turn repository evidence and user intent into a bounded implementation plan without mutating the repository.
---

# DEVAI plan

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`. Select only a declared variant, obey its exact effect and write policy, and invoke only the descriptor's exact operation behavior.

Use this recipe to produce a practical plan before implementation.

1. Select exactly one declared variant: `change`, `init`, or `module`.
2. Clarify only choices that materially change the result; otherwise state reasonable assumptions.
3. Use the variant's deterministic operations to inspect current state.
4. Define owned paths, dependencies, acceptance checks, rollback points, and stop conditions.
5. Return the plan in the conversation. Do not create governance, law, product-draft, or round files.
6. Do not invoke another model.
