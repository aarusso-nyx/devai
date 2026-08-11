# database/ layout — adopter guide

**Authority:** Architect, issued cross-repo via [CONVENTIONS.md](./CONVENTIONS.md) §2 (2026-05-22).
**Applies to:** every DEVAI adopter that owns a SQL database (PEC, TEAT, SGP, PORM, STYNX where applicable). DEVAI itself has no `database/` — the framework persists state to `record/proofs/`, not a relational DB.

## Canonical tree

```
database/
├── ddl/<nn>-<script>.sql              ← bootstrap DDL, 2-digit prefix, lowercase-kebab-case slug
├── seed/<nn>-<seedfile>.sql           ← seed data, 2-digit prefix, lowercase-kebab-case slug
└── migrations/<nnn>_<migration-name>.sql  ← incremental migrations, 3-digit prefix, snake_case slug
```

A repo MAY also have `database/policies/`, `database/views/`, `database/functions/` (or other ordered subdirs) slotted between DDL and seed; declare the ordering in `database/README.md`.

## Filename conventions

| Subdir                              | Prefix          | Slug case            | Example                                                     |
| ----------------------------------- | --------------- | -------------------- | ----------------------------------------------------------- |
| `ddl/`                              | `nn` (2-digit)  | lowercase-kebab-case | `01-tenants.sql`, `02-users.sql`, `03-audit-events.sql`     |
| `seed/`                             | `nn` (2-digit)  | lowercase-kebab-case | `01-system-tenants.sql`, `02-demo-users.sql`                |
| `migrations/`                       | `nnn` (3-digit) | snake_case           | `001_add_email_to_users.sql`, `042_drop_legacy_indexes.sql` |
| `policies/`, `views/`, `functions/` | `nn` (2-digit)  | lowercase-kebab-case | `01-tenant-isolation.sql`                                   |

**Why the asymmetry?** DDL and seed are repo-internal canonical bootstrap; lowercase-kebab matches the rest of the repo's filenames. Migration naming follows ecosystem conventions (Flyway, Sqitch, Alembic, Knex, Prisma) which standardize on `<integer-prefix>_<snake_case>.sql`. Aligning migrations to the wider ecosystem makes tool-swap cheaper than internal-consistency would.

## Ordering rules

A fresh-bootstrap run executes:

1. **All of `ddl/`**, in numeric prefix order, then
2. **Any optional ordered subdirs** (`policies/`, `views/`, `functions/`, ...) in the order declared in `database/README.md`, each subdir's files in numeric prefix order, then
3. **All of `seed/`**, in numeric prefix order.

Migrations are **independent of bootstrap**. A long-lived database applies `migrations/` in 3-digit prefix order forward only; a fresh-bootstrap database does NOT replay migrations — it simply runs DDL + seed.

## Migration immutability rule

**Once a migration is shipped (merged to `main`), never re-edit it.** If a migration was wrong, ship a new migration that corrects it; the old one stays as it landed. This is the one rule that breaks if you ignore — a re-edited migration silently diverges between the repo and any database that ran the pre-edit version.

Corollary: no `git rebase` history-rewrite on `main` that touches a migration file. If you must, treat it as a destructive operation requiring explicit Owner sign-off (per Article 25 / lock authority).

## Replacing legacy locations

Common legacy paths and how to migrate them:

| Legacy path                                  | Action                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `db/` (top-level)                            | `git mv db database`                                                                              |
| `database/` flat (files at root, no subdirs) | sort into `ddl/`, `seed/`, `migrations/` then `git mv`                                            |
| `prisma/migrations/`                         | `git mv prisma/migrations database/migrations`; rename Prisma's auto-timestamps to 3-digit prefix |
| `infra/db/`                                  | `git mv infra/db database`                                                                        |
| `backend/db/`                                | `git mv backend/db database`                                                                      |

Always `git mv` (not `mv` + `git add`) so git records the rename and history follows.

## Worked example — fresh bootstrap

A hypothetical PEC-style adopter, fresh DB on Postgres 15:

```
database/
├── ddl/
│   ├── 01-extensions.sql        # CREATE EXTENSION pgcrypto, citext
│   ├── 02-tenants.sql           # CREATE TABLE tenants
│   ├── 03-users.sql             # CREATE TABLE users
│   ├── 04-audit-events.sql      # CREATE TABLE audit_events
│   └── 05-driver-records.sql    # CREATE TABLE driver_records
├── policies/
│   ├── 01-tenant-isolation.sql  # CREATE POLICY ... ON tenants USING ...
│   └── 02-rls-enable.sql        # ALTER TABLE ... ENABLE ROW LEVEL SECURITY
├── functions/
│   └── 01-audit-trigger.sql     # CREATE FUNCTION emit_audit_event()
├── views/
│   └── 01-active-drivers.sql    # CREATE VIEW active_drivers AS ...
├── seed/
│   ├── 01-system-tenant.sql     # INSERT INTO tenants ('system', ...)
│   └── 02-demo-drivers.sql      # INSERT INTO driver_records (...)
└── migrations/
    ├── 001_add_index_users_email.sql
    └── 002_rename_audit_events_to_audit_log.sql
```

`database/README.md` declares the bootstrap order:

```
1. ddl/        (01-extensions through 05-driver-records)
2. policies/   (01-tenant-isolation, 02-rls-enable)
3. functions/  (01-audit-trigger)
4. views/      (01-active-drivers)
5. seed/       (01-system-tenant, 02-demo-drivers)
```

After bootstrap, a long-lived database applies any `migrations/` whose prefix is greater than its current marker. Fresh-bootstrap databases skip `migrations/` entirely — they already have the latest DDL.

## Cross-references

- Authority: [CONVENTIONS.md](./CONVENTIONS.md) §2.
- Docs layout: [`docs-layout.md`](./docs-layout.md).
- DEVAI's current database-isolation guidance: see [`../dev/operations/db-isolation.md`](../dev/operations/db-isolation.md).
