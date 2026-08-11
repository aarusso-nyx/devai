# Invariant override discipline

An override is a reviewed exception with an owner, narrow scope, reason, and expiry. It must not
convert unknown, missing, skipped, or stale evidence into PASS.

Run the current override check explicitly:

```bash
devai check --only overrides --repo-root . --as-role inspector --write --format json
```

If the installed candidate does not list `overrides` as a canonical or migration-bound member,
stop and use its declared suite instead of inventing a check name. Remove expired overrides in
the same review that supplies the replacement evidence or decision.
