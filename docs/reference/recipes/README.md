# Recipes

DEVAI 1.0 ships seven host-invoked recipes. Recipes are prompt-and-permission
contracts for Codex and Claude; they are not CLI actions and cannot launch nested
models, publish artifacts, or widen their declared write scope.

| Recipe           | Status  | Purpose                                                                       |
| ---------------- | ------- | ----------------------------------------------------------------------------- |
| `devai-assess`   | stable  | Read-only health, inventory, and round assessment.                            |
| `devai-plan`     | stable  | Read-only change, initialization, and module planning.                        |
| `devai-fix`      | stable  | Explicit-file repair for lint, typecheck, build, test, and coverage failures. |
| `devai-docs`     | stable  | Write one named repository document within its variant scope.                 |
| `devai-scaffold` | stable  | Generate bounded database, API, UI, test, documentation, or CI assets.        |
| `devai-verify`   | stable  | Read-only change, documentation, and RC evidence review.                      |
| `devai-round`    | preview | Coordinate local preview round state without publication.                     |

## One source, generated projections

Each recipe has exactly one canonical source: the directory
`packages/skills/resources/recipes/<name>/` holding `SKILL.md` and `devai.recipe.json`.
The host trees `.agents/skills/` (Codex) and `.claude/skills/` (Claude Code) are
generated projections of that source, never edited by hand and never symlinked
([ADR-GOV-0020](../../../law/adr/ADR-GOV-0020-canonical-instructions-and-host-projections.md)).
Symlinks were weighed and set aside: a committed symlink checks out as a plain text file
on Windows without `core.symlinks`, and the installer refuses any symlink on an
installation path with `RECIPE_INSTALL_SYMLINK_REFUSED` so a projection can never point
outside the checkout. Install both projections from the packaged resources with:

```bash
devai init apply harness --include skills --target . --as-role architect --write
```

The command installs all seven recipes under both roots. For every recipe it copies the
canonical `SKILL.md` and `devai.recipe.json` byte for byte, derives `devai.operations.json`
from the typed operation catalog, and, under `.agents/skills/` only, adds the Codex
metadata file `agents/openai.yaml`. The two projections of a recipe therefore differ in
nothing but their root: same body, same front matter, same manifest. A byte-identical
reinstall is a no-op. Existing drift or a symlink in an installation path refuses the whole
adapter installation before any file is written. To change a recipe, edit the canonical
source and reinstall; a hand edit to a projection is drift and blocks the next install.

## Front matter contract

Every canonical `SKILL.md` opens with the Agent Skills core front matter and nothing else:

| Key             | Value                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`          | Equal to the recipe directory name and to `name` in `devai.recipe.json`.                                                                          |
| `description`   | Equal to `description` in `devai.recipe.json`; the loader refuses a mismatch.                                                                     |
| `license`       | `Apache-2.0`, the package license.                                                                                                                |
| `compatibility` | The environment the recipe needs: a host that reads Agent Skills, the adjacent manifest and operations descriptor, and the project-local package. |
| `metadata`      | A string map: `devai-status` (`stable` or `preview`, equal to the manifest) and `devai-recipe-schema` (`"1"`).                                    |

A recipe body names recipes and variants by their plain names and never carries a host
invocation glyph, so the same bytes serve every host; each host supplies its own way of
invoking a skill.

Every invocation selects one exact recipe and one manifest-declared variant. A host
must reject undeclared variants, effects, and paths. Local-write variants require the
explicit files or bounded patterns declared by that variant. The preview round recipe
writes only `.devai/state/round-runs/**`.

Deterministic work is implemented as typed operations rather than recipes. Each
installed `SKILL.md` tells the host to read its adjacent manifest and operation
descriptor before acting. The descriptor contains exactly the operations referenced by
that recipe's variants; the host remains responsible for enforcing the selected effect,
write policy, and exact behavior.
