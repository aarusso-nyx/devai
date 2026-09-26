---
title: Contributing
sidebar_position: 7
---

> **Sync stub.** At publish time, `docs/site/scripts/sync-docs.mjs` overwrites this stub with the content of `CONTRIBUTING.md` at the repo root, per the root-file allowlist in `docs/_ia/categories.json`.

## Commit grammar and single-family commits

Every commit subject reads `type(scope)!: subject` with a type from the closed set in
`law/policy/commit-grammar.json`; the scope is optional and lowercase, and the `!` marker
declares a breaking change. A commit may touch paths of one change family only, as declared
in `law/policy/change-taxonomy.json`, and its type must agree with the class of every path.
The commit-msg and pre-commit hooks name every class they find and suggest a split.

Two correct splits:

- A round plan plus the source change it describes: commit `product/...` alone as
  `plan(campaign): ...` (governance), then `packages/...` as `feat(...)`, `fix(...)`, or
  `refactor(...)` (implementation). One commit with both is mixed and is rejected.
- A decision record plus the generated views it drives: `law/adr/...` with the registry
  under `law/policy/action-registry.json` and the generated views under `packages/*/src/generated/`
  land together as `law(...)`, because the taxonomy lists `law` with `generated` as the one
  permitted pairing. The tests or documentation that follow are a second commit of their own
  type.
