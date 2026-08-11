# Migration sensing

Database migration execution is an explicit Engineer write:

```bash
devai sense migrate \
  --repo-root . \
  --migrations-dir ./migrations \
  --database-url "$DEVAI_DATABASE_URL" \
  --as-role engineer --write --format json
```

Use `--migration-dirs` for an ordered comma-separated set, `--pre-seed` for reviewed SQL,
and pack tuning only when the adopter has intentionally selected that behavior. Never put a
credential in a committed command or configuration file. A successful migration reading is
bound to that database and migration input; it is not a production deployment claim.
