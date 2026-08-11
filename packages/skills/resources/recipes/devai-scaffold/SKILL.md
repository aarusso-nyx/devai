---
name: devai-scaffold
description: Generate one bounded artifact family from explicit structured inputs and reviewable templates.
---

# DEVAI scaffold

Before acting, read the adjacent `devai.recipe.json` and `devai.operations.json`. Select only a declared variant, obey its exact effect and write policy, and invoke only the descriptor's exact operation behavior.

Use this recipe for deterministic, template-based generation.

1. Select exactly one declared variant.
2. Require explicit structured inputs; do not infer missing identifiers or schema fields.
3. Preview target paths and verify every target matches the selected variant's scopes.
4. Refuse to overwrite drifted files. Create only missing or byte-identical generated artifacts.
5. Review generated output and run its focused check.
6. Do not invoke another model, switch variants, or perform remote actions.
