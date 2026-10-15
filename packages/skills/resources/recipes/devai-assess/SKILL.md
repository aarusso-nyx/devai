---
name: devai-assess
description: Evidence-based read of a DEVAI-governed repository's health, inventory, or current round, explained without changing files. Use for "how healthy is this repo", "what's in the inventory", "what does the current round look like".
license: Apache-2.0
compatibility: Invoked by a host that reads Agent Skills from .agents/skills or .claude/skills; needs the adjacent devai.recipe.json and devai.operations.json and the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: stable
  devai-recipe-schema: '1'
---

# DEVAI assess

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`.

Select one variant (`health`, `inventory`, `round`), run only its deterministic operation, and read the complete result before summarizing.

Separate observed facts, gaps, and recommendations. Read-only: no edits, no round advancement.

Report: variant, operations run, evidence considered, findings, unresolved gaps.

Worker boundary: no delegation, commit, push, publish or other remote effect from this recipe — those belong to an explicitly authorized orchestrator operation.
