# Secret handling

Secrets enter through environment variables or host credential stores, never committed files,
CLI arguments that become process-list data, evidence payloads, or task-cache keys. Allowlisted
environment binding records only the value required by policy, preferably a non-secret digest or
presence marker.

Database operations use an environment-provided URL:

```bash
devai sense migrate --repo-root . --migrations-dir ./migrations \
  --database-url "$DEVAI_DATABASE_URL" --as-role engineer --write
```

Real-provider sensing is explicit. The host selects a provider and exact model plus budget; DEVAI
does not substitute an alias, default, preferred model, or policy fallback. Never let ambient
credentials make an ordinary test or sensor external-dependent.
If a secret enters evidence, preserve the incident record and use `evidence redact` to append an
attributable erratum.
