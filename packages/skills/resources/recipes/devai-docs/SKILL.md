---
name: devai-docs
description: Write one evidence-grounded DEVAI developer document at the output path the selected variant declares, citing repository artifacts. Use when asked for a DEVAI overview, architecture, or operations document.
license: Apache-2.0
compatibility: Invoked by a host that reads Agent Skills from .agents/skills or .claude/skills; needs the adjacent devai.recipe.json and devai.operations.json and the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: stable
  devai-recipe-schema: '1'
---

# DEVAI docs

Read the adjacent `devai.recipe.json`. Select one document variant; its output path comes from the variant (resolved through the adopter's binding where one exists), never from the request.

Inspect the relevant inventory and source evidence. Cite concrete artifacts; mark inferences; report missing evidence rather than inventing it. Write only that one file.
