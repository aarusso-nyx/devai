# DEVAI v1.0rc development contract

This file is the only instruction contract for every host. `CLAUDE.md` beside it
holds the single line `@AGENTS.md`, the Claude Code import that loads this file once
and never twice; edit guidance here and nowhere else (ADR-GOV-0020).

This repository is the release-candidate source. DEVAI does not govern its own
development: human maintainers choose scope, review changes, and decide releases.

## Roles and reading order

Declare one of the five roles at session start and keep it: Owner, Architect,
Inspector, Engineer, or Auditor. Constitution Article 6 fixes write authority by
path and Article 7 fixes what each role may author; a session never infers or
elevates its role. Before changing governed repository state, read `README.md`,
`law/constitution.md`, the decision records under `law/adr`, and the schemas under
`law/schemas`, in that order.

## Working rules

- Work in a dedicated branch or worktree and preserve unrelated user changes.
- Treat `law/constitution.md`, current `law/policy/`, and current `law/schemas/` as
  product contracts. Do not widen effects, permissions, or write scopes implicitly.
- Keep the public CLI at the approved action set in `law/policy/action-registry.json`. Recipes are host-invoked contracts,
  not CLI dispatchers, and deterministic behavior belongs in typed operations.
- Run the smallest trustworthy checks affected by the change. Reuse fresh evidence for
  untouched areas; reserve full Vitest and coverage for explicit RC gates.
- Read command output and `git diff --check` before committing. Keep commits coherent.
- Before opening a pull request, fetch the base branch and run the local preflight against
  that fetched base; a `BLOCKED` probe names the environment fix, not a candidate defect.
- Write commit subjects as `type(scope)!: subject` from the closed type set in
  `law/policy/commit-grammar.json`, and keep every commit inside one change family from
  `law/policy/change-taxonomy.json`; only the pairings that policy lists may cross families.
- Do not publish packages, tags, releases, deployments, or source unless the Owner gives
  explicit authorization for that exact external effect.
