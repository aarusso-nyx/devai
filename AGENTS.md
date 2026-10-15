# DEVAI development contract

`CLAUDE.md` holds `@AGENTS.md`; Codex reads this file directly. Edit guidance here only (ADR-GOV-0020).

This repository is DEVAI's own source and is **maintainer-governed**: maintainers choose scope, review changes and authorize releases. The constitutional roles (Owner, Architect, Inspector, Engineer, Auditor) govern DEVAI's _product_ behavior in adopter repositories; a maintainer session here declares none. Write authority is Constitution Article 6 by path, enforced mechanically (`devai check`, the pre-push hook, the action registry); a refused edit names its article.

## Read what the change touches

- `law/constitution.md`, `law/policy/*` — the article or policy you touch and the ADR behind it (`law/adr/README.md` indexes them).
- `law/schemas/*` — the schema and its consumers (`grep -rl <schema> packages/`).
- the public CLI action set — `law/policy/action-registry.json`; additions need an ADR.
- a recipe under `packages/skills/resources/` — `recipe.schema.json` and the adjacent `devai.recipe.json`.
- release or verification — `law/policy/release-verification.json`, `release-lifecycle.json`.
- adopter-facing docs — `docs/adopters/`, `law/policy/documentation-information-architecture.json`.
- an unfamiliar component — start at `README.md`.

A check that names an article is also a read trigger.

## Working rules

- One branch or worktree per change (`.devai/worktrees/<name>`); preserve unrelated changes.
- `law/constitution.md`, `law/policy/` and `law/schemas/` are product contracts: do not widen effects, permissions or write scopes implicitly.
- Run the smallest trustworthy checks (`devai check --affected` against the fetched base); full Vitest and coverage are for RC gates.
- Commit subjects are `type(scope)!: subject` (`law/policy/commit-grammar.json`); one change family per commit (`change-taxonomy.json`).
- Install the pre-push hook per worktree (`pnpm run hooks:install -- --pre-push`); it runs commit-grammar and `check --affected` before every push. A `BLOCKED` probe names an environment fix, not a candidate defect. Never bypass it.
- Deliver what was asked at the scope intended, making routine judgment calls yourself and noting them. Check in only when readings differ materially, authority is missing, or an effect is irreversible.
- Nothing is published — packages, tags, releases, deployments, source — without the Owner's explicit authorization for that exact effect.

## Governed workers and recipes

Recipes are host-invoked contracts, not CLI dispatchers; deterministic behavior lives in typed operations. A dispatched worker, recipes included, holds the single role its task packet names and works only in the task worktree; it cannot widen that authority. Push, merge, pull requests and publication belong to an explicitly authorized orchestrator operation. A worker may not delegate; the orchestrator may launch the independent reviewer. Missing authority blocks only the dependent action.
