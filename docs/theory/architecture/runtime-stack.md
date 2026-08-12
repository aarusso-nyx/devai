# Runtime stack

**Authority:** Architect (Constitution Article 6, F1).

## Rule

The source workspace behind the single publishable `@aarusso-nyx/devai` package is built on a fixed set of runtime and tooling choices:

| Layer              | Choice                                                                      |
| ------------------ | --------------------------------------------------------------------------- |
| Language           | TypeScript (strict mode, ESM modules throughout)                            |
| Workspace manager  | pnpm workspaces (content-addressable store, lightweight orchestration)      |
| Build              | `tsc -b` project references; Rolldown assembles one public CLI binary       |
| Test runner        | Vitest (one root config + filename-suffix-driven test categories)           |
| CLI framework      | `cac` (small, declarative, no plugin architecture)                          |
| Schema contracts   | Governed JSON Schema roster plus explicit TypeScript runtime interfaces     |
| Runtime validation | `ajv` + `ajv-formats` (Draft 2020-12 schemas, lazily compiled)              |
| Dev platform       | Node.js 24 on macOS or Linux; Windows is not a supported RC target          |
| CI platform        | Linux (GitHub Actions)                                                      |

Ten internal TypeScript workspace packages are development boundaries. Rolldown bundles their
runtime closure into the single publishable `@aarusso-nyx/devai` package; adopters do not install
the private `@devai-nyx/*` packages.

## Rationale

Each choice was made by elimination:

**CLI framework — `cac` over `commander` and `oclif`:**
`commander` is mature but verbose for this CLI. `oclif` is unnecessarily heavy; `cac` provides the required declarative command grouping without a plugin runtime.

**Workspace manager — `pnpm` over plain npm and Nx:**
Plain npm workspaces work but lack a content-addressable store, which makes installs in CI slow and disk-hungry across multiple worktrees. Nx is an orchestration framework — DEVAI _is_ an orchestration framework, so layering Nx on top would conflict on the same surface. `pnpm`'s store + workspace primitives are exactly what DEVAI needs and nothing more.

**Test framework — Vitest over Jest and `node:test`:**
Jest is CJS-by-default and slow to start across a multi-package monorepo. `node:test` is minimal but lacks the watch / coverage / project-references behaviour the workflow depends on. Vitest is ESM-native, fast, and integrates cleanly with `tsc -b` composite builds.

**Schema roster + runtime validation — explicit TypeScript interfaces + `ajv`:**
The governed roster in `packages/schemas/src/roster.ts` controls which authored schemas can become
runtime validators and which schema references are packaged. AJV compiles validators lazily.
Compile-time interfaces are explicit product code; there is no generated `.d.ts` pipeline in rc.3.

## Practical consequences

1. **No new tooling layer without an explicit design decision.** Adding a build orchestrator, a different test runner, or a different CLI framework requires review of the relevant row above. The choices are firm but not constitutional.

2. **Generated registry views are checked, not trusted as authority.** The action registry source
   in `law/policy/action-registry.json` regenerates three TypeScript views.
   `pnpm run action-registry:check` parity is part of the build contract.

3. **TypeScript composite builds enforce internal workspace boundaries.** Each internal module has a `tsconfig.json` with explicit `references`. The dependency graph is therefore declared, not inferred. Circular dependencies fail compilation. Those internal boundaries do not create additional publishable packages.

4. **Vitest configs split test categories by filename suffix**: `.test.ts` is unit, `.integration.test.ts` is integration (DB-gated, see [`../../meta/ops/testing.md`](../../dev/operations/testing.md)), `.e2e.test.ts` is end-to-end. The categorization lives in `vitest.config.ts` / `vitest.integration.config.ts` / etc.

5. **macOS-dev / Linux-CI is the canonical target pair.** Windows is unsupported. Adopters on Linux dev environments are first-class but receive less canonical testing.

## When to revisit

Each row is independently revisitable:

- **`cac` → something else:** triggered if `cac` is unmaintained, or if a need emerges that `cac` cannot model (e.g., interactive REPL mode). Currently no trigger.
- **Vitest → something else:** triggered if Vitest's project-references behaviour becomes a blocker (e.g., for parallel matrix CI runs the way Jest's workers handle it). Currently no trigger.
- **`pnpm` → something else:** triggered if pnpm's store semantics change in a way that breaks worktree-shared installs. Currently no trigger.
- **`ajv` → something else:** triggered only if JSON Schema Draft 2020-12 support drops or a meaningfully faster validator emerges. Currently no trigger.

Any row can be revisited through an explicit design decision without constitutional impact.
