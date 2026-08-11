---
title: Developer guide
---

# Developer guide

Human maintainers choose DEVAI's scope, review changes, and authorize releases. Work in a
dedicated branch or worktree, preserve unrelated changes, and run the smallest trustworthy
checks affected by the change.

## Test lanes

| Lane                               | Purpose                                                                  | Normal trigger                     |
| ---------------------------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| affected                           | matching leaf and dependent closure from an exact base-to-candidate diff | every change                       |
| local                              | complete cheap deterministic closure with PASS cache reuse               | before integration                 |
| RC coverage                        | complete Vitest population once, floors 70/60/70/70                      | release-candidate gate only        |
| DB / E2E / performance diagnostics | focused slices already included in RC coverage                           | investigation or focused iteration |
| containment diagnostic             | focused operation, recipe, path, symlink, and write-scope slice          | containment changes                |

PASS-only cache reuse is allowed when the task key and dependency closure are unchanged.
Unknown changes widen to the full local closure. Clean affected and RC runs may emit an unsigned
candidate receipt; signing and trust material remain outside the candidate repository. Remote CI
validates the signed export and required-node closure without rerunning product tests, and it does
not claim to prove local execution.

## Runbooks

- [Testing](operations/testing.md)
- [Worktrees](operations/worktree-runbook.md)
- [Database isolation](operations/db-isolation.md)
- [Evidence](operations/local-evidence-runbook.md)
- [Incident response](operations/incident-playbook.md)
- [Security](security/README.md)
