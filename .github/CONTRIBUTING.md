# Contributing to DEVAI

Read `AGENTS.md` before changing the repository. `CLAUDE.md` delegates to the same
instructions. Keep changes inside the role and path boundary stated there, and never
publish, deploy, push, or mutate an external adopter as an implicit development step.

## Setup

DEVAI requires Node.js 24 or newer and pnpm.

```bash
pnpm install
pnpm run build
```

## Verification

During development, run the focused test and static checks affected by the change.
The repository's check planner and evidence ledger preserve fresh results for unchanged
inputs; do not repeat expensive suites merely to recreate current evidence.

Use the explicit RC gate when preparing a release candidate. Coverage, full Vitest,
package assembly, and installed-tarball smoke are local RC evidence. GitHub Actions
validates the committed ledger and package-independent policy rather than recreating
those expensive local runs.

```bash
pnpm run lint
pnpm run typecheck
pnpm vitest run --config tests/config/local.config.ts <affected-test-files>
git diff --check
```

## Recipes

DEVAI ships seven host-invoked recipes described in
[`docs/reference/recipes/README.md`](../docs/reference/recipes/README.md). Their
instructions, variant manifests, and deterministic operation descriptors are canonical
package assets. Recipe tests are deterministic and provider-independent; ordinary
development and CI do not call a model provider.

## Change discipline

- Keep commits small, coherent, and independently revertible.
- Do not weaken a test, floor, scope, or authority rule to make a gate pass.
- Treat generated and installed package parity as a tested contract.
- Report uncertainty and missing evidence instead of inferring success.
- Publication remains a separate Owner-authorized action.
