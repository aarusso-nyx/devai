# Examples and fixtures

`examples/` contains maintained inputs used by sensors and tests:

- `examples/fixtures/` contains compact repositories and payloads for deterministic tests.
- `examples/stack-packs/` contains declared stack-adapter pack resources.

Use the inventory surface to inspect an adopter against those resources:

```bash
devai sense inventory --slice pack --repo-root . --adopter-root . --format json
devai sense inventory --slice all --repo-root . --adopter-root . --format json
```

Examples demonstrate input shapes. They are not aliases, implicit defaults, or proof that
an adopter has passed a check.
