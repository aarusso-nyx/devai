---
name: devai-fix
description: Repair one failing engineering concern with explicit file bounds and focused verification.
---

# DEVAI fix

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`. Select only a declared variant, obey its exact effect and write policy, and invoke only the descriptor's exact operation behavior.

Use this recipe only after a concrete failing concern is known.

1. Select exactly one declared variant: `lint`, `typecheck`, `build`, `test`, or `coverage`.
2. Name the exact files to be edited before making changes. Every file must match that variant's scopes.
3. Reproduce the focused failure, identify its cause, and make the smallest repair.
4. Do not weaken tests, broaden permissions, or edit files discovered after authorization without reporting the new need.
5. Run the focused deterministic check once after the repair.
6. Do not invoke another model, commit, push, or perform remote actions.

Report changed files, cause, verification, and any remaining risk.
