---
name: devai-assess
description: Assess repository state and explain current evidence without changing product files.
license: Apache-2.0
compatibility: Invoked by a host that reads Agent Skills from .agents/skills or .claude/skills; needs the adjacent devai.recipe.json and devai.operations.json and the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: stable
  devai-recipe-schema: '1'
---

# DEVAI assess

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`. Select only a declared variant, obey its exact effect and write policy, and invoke only the descriptor's exact operation behavior.

Use this recipe for a concise, evidence-based repository assessment.

1. Select exactly one declared variant: `health`, `inventory`, or `round`.
2. Run only the deterministic DEVAI operation declared for that variant.
3. Read the complete result before summarizing it.
4. Separate observed facts, gaps, and recommendations.
5. Do not edit files, invoke another model, or advance a round.

Return the selected variant, operations run, evidence considered, findings, and unresolved gaps.
