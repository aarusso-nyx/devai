---
name: devai-scaffold
description: Generate one bounded DEVAI artifact family (entity, module, CI workflow, migration) from explicit structured inputs and reviewed templates. Use when asked to scaffold a new DEVAI/STYNX module or entity.
license: Apache-2.0
compatibility: Invoked by a host that reads Agent Skills from .agents/skills or .claude/skills; needs the adjacent devai.recipe.json and devai.operations.json and the project-local @aarusso-nyx/devai package.
metadata:
  devai-status: stable
  devai-recipe-schema: '1'
---

# DEVAI scaffold

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`.

Select one variant. Require explicit structured inputs — do not infer missing identifiers or schema fields.

Derive the exact output paths from the typed scaffold operation and the structured inputs (the variant declares only glob scopes), preview them, and confirm every target matches the variant's scopes. Create only missing or byte-identical generated files; a drifted file is reported, never overwritten. Review the output and run its focused check.

No variant switching.

Worker boundary: no delegation, commit, push, publish or other remote effect from this recipe — those belong to an explicitly authorized orchestrator operation.
