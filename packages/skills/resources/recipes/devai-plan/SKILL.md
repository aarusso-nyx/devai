---
name: devai-plan
description: Turn repository evidence and intent into a bounded DEVAI implementation plan (change, init, or module) without mutating the repository. Use when explicitly asked to plan before implementing; not a required step before every change.
license: Apache-2.0
compatibility: Invoked by a host that reads Agent Skills from .agents/skills or .claude/skills; needs the adjacent devai.recipe.json and devai.operations.json and the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: stable
  devai-recipe-schema: '1'
---

# DEVAI plan

Read the adjacent `devai.recipe.json`. Select one variant (`change`, `init`, `module`) and use its deterministic operations to inspect current state.

Ask only about choices that materially change the result; otherwise state your assumptions and continue. Define owned paths, dependencies, acceptance checks, rollback points, stop conditions.

Return the plan in the conversation. No governance, law, product-draft or round files.
