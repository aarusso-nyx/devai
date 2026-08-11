# Persistence

**Authority:** Architect (Constitution Article 6, F1).

## Rule

Client repositories using DEVAI use **raw SQL migrations** for all schema management. The migrations directory is `db/migrations/`, one numbered SQL file per migration, applied in lexicographic order. No ORM mediates schema definition.

Application code may use a query builder, a thin pg-driver wrapper, or hand-written SQL — that's an application concern. But the _schema source of truth_ is the migration files, not any ORM entity declaration.

## Rationale

ORMs were considered (TypeORM, Prisma, node-pg-migrate) and rejected for three converging reasons:

1. **Per-worktree DB names break ORM startup discipline.** DEVAI provisions one Postgres database per active worktree (see [`../../meta/ops/db-isolation.md`](../../dev/operations/db-isolation.md)). ORMs expect a stable connection string or a config-loader that produces one. Wiring an ORM to honor a per-task DB name resolved at runtime is doable but fragile, and the runtime config races with TEMPLATE cloning.

2. **Schema introspection at ORM startup races with TEMPLATE cloning.** Many ORMs read `information_schema` on startup to validate the entity → table mapping. When two parallel tasks each provision a fresh DB via `CREATE DATABASE … TEMPLATE devai_template`, the introspection happens against a database that may still be settling.

3. **An opinion-layer between code and database muddies sensor readings.** DEVAI's F4 inventory sensors read `information_schema` directly to enumerate tables, columns, constraints, and indexes (`sense-data-model`). When an ORM stands between the application and the database, the sensor sees the _database's_ shape — which may differ from the _ORM's_ declared shape, and from the _application code's_ assumptions about both. Three sources of truth, none authoritative.

Raw SQL collapses this to one source of truth (the migration files), one reader (Postgres), and one observable (`information_schema`).

## Practical consequences

1. **Migration filenames are ordered**: `001_create_users.sql`, `002_add_audit_table.sql`, etc. The numbering scheme is the canonical apply order. Some clients prefer timestamp prefixes (`20260511_create_users.sql`); both work as long as lexicographic order matches intended apply order.

2. **Migrations are forward-only.** No automatic `down` migrations. If a migration needs to be reverted, write a new migration that undoes the change. This forces the change to go through the same review and validation as any other migration.

3. **The template database (`devai_template`)** is rebuilt by re-applying all migrations on every integration merge. Tasks then provision DBs via `CREATE DATABASE devai_task_<id> TEMPLATE devai_template` (see [`../../meta/ops/db-isolation.md`](../../dev/operations/db-isolation.md)).

4. **Schema sensors are pure F4 readers.** `sense-data-model`, `sense-data-handling`, and `sense-rbac` read `information_schema`, `pg_catalog`, and table-level grants directly. No ORM entity files are consulted.

5. **Type generation lives in client code, not in migration tooling.** A client may use `pg-typed`, `kysely-codegen`, or hand-written types alongside their raw-SQL approach — DEVAI doesn't prescribe. The migrations remain the schema authority regardless.

## When to revisit

Revisit this decision when:

- A canonical-stack ORM emerges that can be wired safely to per-worktree DB provisioning _and_ that the sensor inventory can introspect without depending on the ORM's runtime. Currently no candidate fits.
- The empirical cost of hand-writing migrations exceeds the benefits, measured against a real adopter survey. So far, raw SQL has been a net positive for the same adopters who would have struggled with ORM-mediated migration race conditions.

Keep the migration directory layout stable across any transition so adopter tooling remains predictable.
