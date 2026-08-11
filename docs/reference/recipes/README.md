# Recipes

DEVAI v1.0rc ships seven host-invoked recipes. Recipes are prompt-and-permission
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

The canonical manifests and shared host-neutral bodies live under
`packages/skills/resources/recipes/`. Install both host adapters from the packaged
resources with:

```bash
devai init apply harness --include skills --target . --as-role architect --write
```

The command installs all seven recipes under both `.agents/skills/` and
`.claude/skills/`. It copies the canonical `SKILL.md` and `devai.recipe.json`, derives
`devai.operations.json` from the typed operation catalog, and adds Codex invocation
metadata. A byte-identical reinstall is a no-op. Existing drift or a symlink in an
installation path refuses the whole adapter installation before any file is written.

Every invocation selects one exact recipe and one manifest-declared variant. A host
must reject undeclared variants, effects, and paths. Local-write variants require the
explicit files or bounded patterns declared by that variant. The preview round recipe
writes only `.devai/state/round-runs/**`.

Deterministic work is implemented as typed operations rather than recipes. Each
installed `SKILL.md` tells the host to read its adjacent manifest and operation
descriptor before acting. The descriptor contains exactly the operations referenced by
that recipe's variants; the host remains responsible for enforcing the selected effect,
write policy, and exact behavior.
