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

## Credential boundary

Credential requirements are declared by name in `law/policy/credential-requirements.json`
(DEVAI's own manifest) and `law/policy/adopter-defaults/credential-requirements-binding.json`
(the adopter starting set), both under `law/schemas/credential-requirements.schema.json`
(ADR-SEC-0001). The boundary is law: DEVAI verifies presence, shape, and scope of a declared
credential through the consuming tool's own status command and reports one of present, absent,
scope-insufficient, or expired. It never reads a value except at the subprocess boundary that
consumes it, never stores one in configuration, evidence, cache keys, or diagnostics, and never
generates keys. Signing keys stay in the trust store allowlist with revocation; custody remains
with the operator. A manifest entry, a probe report, and a doctor finding carry the credential
name and the required scope, never the value or a fragment of it.
