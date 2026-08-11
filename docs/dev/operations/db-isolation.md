# Database isolation

The v1.0rc CLI does not provision task databases. Create and destroy test databases with your
database or container tooling, using a unique name per concurrent worktree. Keep credentials in
the environment and never in committed configuration.

The DEVAI database-writing surface is the explicit migration sensor:

```bash
devai sense migrate \
  --repo-root . \
  --migrations-dir ./migrations \
  --database-url "$DEVAI_DATABASE_URL" \
  --as-role engineer --write --format json
```

RC database evidence records the exact image/version, migration inputs, seed data, and database
identity. A hermetic non-DB lane cannot substitute for the required RC database node.
