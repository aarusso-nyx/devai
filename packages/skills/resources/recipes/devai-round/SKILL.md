---
name: devai-round
description: Preview a local round workflow with explicit phases and runtime-state-only coordination.
---

# DEVAI round preview

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`. Select only a declared variant, obey its exact effect and write policy, and invoke only the descriptor's exact operation behavior.

Use this preview recipe only when the user explicitly requests it.

1. Select one declared phase: `assess`, `plan`, `run`, or `close`.
2. Keep coordination records under the declared runtime-state scope.
3. Treat every child operation as a separate request with its own effect and permission check.
4. Never inherit or combine child permissions.
5. Stop on a failed child operation, missing evidence, or expanded scope.
6. Do not invoke another model, mutate product files, or perform any remote action.
