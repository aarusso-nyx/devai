# Reference stack

**Authority:** Architect (Constitution Article 6, F1).
Additional declared stacks are admitted through explicit F5 stack-adapter packs.

## Rule

DEVAI's primary reference stack is a mixed monorepo composed of:

- **Backends:** NestJS (TypeScript, decorator-driven module/controller/provider model).
- **Frontends:** Angular (TypeScript, `NgModule` composition).
- **Database:** Postgres (raw SQL migrations under `db/migrations/`; no ORM — see [`persistence.md`](./persistence.md)).
- **Workspace manager:** pnpm workspaces.
- **Language baseline:** TypeScript strict mode, ESM modules throughout.
- **Test runners:** Vitest for unit/integration; Playwright for end-to-end.

Adopters whose codebase fits this stack get the deepest built-in parser and
fixture coverage. Each adopter nevertheless declares exactly one resolved
stack. Adjacent stacks use explicit packs (`examples/redox-pack-*/`) for
detection, extractor parameters, prompt overlays, and templates; capability is
reported conservatively where a framework-specific parser does not exist.

## Rationale

A universal parser core was considered and rejected. Sensor heuristics,
scaffolder templates, default prompt overlays, and migration tooling benefit
from declared-stack markers. Packs make those assumptions explicit without
pretending that every parser works on every ecosystem.

A primary reference stack lets DEVAI make strong assumptions where its declared
capabilities apply:

- **File layout.** `apps/` for runnable services, `libs/` for shared code, `db/migrations/` for schema, `tests/` (per-package) for tests.
- **Build tools.** pnpm workspaces, `tsc -b` composite builds, Vitest config.
- **Test runners.** Vitest's project-references resolution; no Jest config drift.
- **ORM behaviour.** None. The sensors read `information_schema` directly; the scaffolders emit raw SQL.

Each of these collapses a significant design space. Adopters not on the canonical stack lose those collapses and have to specify what their code looks like.

## Practical consequences

1. **`examples/sample-nest-angular/`** is the canonical reference repo. Sensor fixtures and integration tests run against it. If a new sensor or skill doesn't behave correctly on the reference repo, it's not ready to ship.

2. **Stack adapter packs** under `examples/redox-pack-*/` are the supported extension surface for adjacent stacks. Each pack declares `detect.signals`, `extractor_params`, `prompt_overlays`, and `templates`. See `pack-resolution.md` in the adopters guide.

3. **Unsupported parser depth is reported, not hidden.** A path-tuned pack can
   improve discovery without implying that a NestJS AST extractor became a
   Spring or Laravel parser. Empty or partial output remains conservative
   evidence and is documented in the pack-resolution guide.

4. **The CONTRIBUTING.md "stack pins" section** lists exact versions of Node, pnpm, Postgres, and TypeScript that the canonical repo tests against. Drift from those versions is recorded under `known-tech-debt.md`.

## When to revisit

Revisit the reference stack when:

- A second stack earns first-class parser and fixture coverage beyond the
  current pack contract. The threshold is empirical adoption pressure, not a
  claim of universality.
- The canonical-stack components diverge from their assumed behaviour (for example, NestJS introduces a non-decorator module API or Angular drops `NgModule` entirely). At that point the sensor heuristics need to be re-anchored.

Adapter packs land additively under Article 1 while NestJS + Angular + Postgres remains the
primary reference stack.
