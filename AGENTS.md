# DEVAI development contract

This repository contains DEVAI release-candidate source. Human maintainers choose
scope, review changes, and authorize merges and releases. Constrained self-dogfooding
is verification configuration, not autonomous governance: only human-invoked checks
explicitly permitted by `law/policy/self-dogfood.json` may run in that context,
within its declared role and effect matrix. Self-dogfooding permits no scheduled
execution, backlog dequeue, self-dispatch, role widening, or remote effects; a pass
grants neither readiness nor publication authority.

- Work in a dedicated branch or worktree and preserve unrelated user changes.
- Treat `law/constitution.md`, current `law/policy/`, and current `law/schemas/` as
  product contracts. Do not widen effects, permissions, or write scopes implicitly.
- Keep the public CLI at the action set in `law/policy/action-registry.json`.
  Recipes are host-invoked contracts, not CLI dispatchers, and deterministic
  behavior belongs in typed operations.
- Run the smallest trustworthy checks affected by the change. Reuse fresh evidence for
  untouched areas; reserve full Vitest and coverage for explicit RC gates.
- Read command output and `git diff --check` before committing. Keep commits coherent.
- Do not publish packages, tags, releases, deployments, or source unless the Owner gives
  explicit authorization for that exact external effect.
