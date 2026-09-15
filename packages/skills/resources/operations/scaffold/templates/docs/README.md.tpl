# **MODULE** Module

Generated for **NAMESPACE**/**MODULE** — spec **SPEC_VERSION** sha **SPEC_SHA**.

## Overview

Domain module under namespace `__NAMESPACE__`.

## API

- Base path: `/api/__NAMESPACE__/__kebabModule__/__kebabEntity__`
- Operations: list, get, create, update, delete
- Auth: guards declared via `__MODULE__PolicyGuard` (RBAC + ABAC).

## Data model

See `db/migration.sql` for the canonical schema (`__NAMESPACE__.__snake_table__`).

## UI

- Routes: `/__NAMESPACE__/__kebabModule__/__kebabEntity__`
- Auth: `CognitoGuard` checks authentication and `__MODULE__PolicyGuard` checks the route's resource and action.
- Bind `__MODULE__UiAuthorization` from `guards/cognito.guard.ts` to the host application's authorization service in an ancestor injector. Its `authenticated()` and `permits(resource, action)` methods return booleans or promises of booleans.
- Missing adapters, missing route policy metadata, rejected promises and non-boolean approvals deny navigation. No credentials or token-storage implementation are generated.
- UI guards complement server authorization; they do not replace API or database enforcement.

## Security

- AuthN: Cognito JWT (cluster-level).
- AuthZ: bind the host's RBAC/ABAC decisions to the UI authorization adapter and finish the template API policy guard with domain-specific rules.
- RLS: row-level security policies live in `db/rls.sql` (authored by Architect; not scaffolded).

## How to run

```bash
cd domain/__moduleSlug__/api && npm ci && npm run build && npm test
```

## Decisions

See the module's architecture decision records under `docs/`.
