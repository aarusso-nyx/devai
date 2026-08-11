# DEVAI v1.0rc development contract

This repository is the release-candidate source. DEVAI does not govern its own
development: human maintainers choose scope, review changes, and decide releases.

- Work in a dedicated branch or worktree and preserve unrelated user changes.
- Treat `law/constitution.md`, current `law/policy/`, and current `law/schemas/` as
  product contracts. Do not widen effects, permissions, or write scopes implicitly.
- Keep the public CLI at its approved RC action set. Recipes are host-invoked contracts,
  not CLI dispatchers, and deterministic behavior belongs in typed operations.
- Run the smallest trustworthy checks affected by the change. Reuse fresh evidence for
  untouched areas; reserve full Vitest and coverage for explicit RC gates.
- Read command output and `git diff --check` before committing. Keep commits coherent.
- Do not publish packages, tags, releases, deployments, or source unless the Owner gives
  explicit authorization for that exact external effect.
