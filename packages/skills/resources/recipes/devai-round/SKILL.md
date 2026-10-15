---
name: devai-round
description: Preview a local DEVAI round (assess, plan, run, close phases) with coordination records kept in runtime state. Use only when the user explicitly asks to preview or drive a round.
license: Apache-2.0
compatibility: Invoked by a host that reads Agent Skills from .agents/skills or .claude/skills; needs the adjacent devai.recipe.json and devai.operations.json and the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: preview
  devai-recipe-schema: '1'
---

# DEVAI round preview

Read the adjacent `devai.recipe.json`. Select one phase (`assess`, `plan`, `run`, `close`) and keep coordination records under the declared runtime-state scope.

Child operations run under this round's explicit authorization: each child's effect is still checked against the round's declared effects and paths, but a passing check is not a new permission request. Stop on a failed child, missing evidence, or a child whose effect exceeds what the round authorized.

No product-file edits from this recipe.

Report: phase, operations run, records written (paths), and the exact stop reason if any.
