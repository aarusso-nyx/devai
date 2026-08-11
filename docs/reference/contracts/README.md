# Contracts

DEVAI's machine contracts are JSON Schema 2020-12 documents under
[`law/schemas/`](../../../law/schemas). The installed candidate's files are authoritative;
prose summaries do not add fields, defaults, or compatibility promises.

Validate one instance with the current migration-bound check:

```bash
devai check --only schema \
  --schema law/schemas/<contract>.schema.json \
  --instance <instance>.json \
  --as-role inspector --write --format json
```

The common action boundary is [`action-result.schema.json`](../../../law/schemas/action-result.schema.json):
successful output uses a structured action envelope on stdout and failures use one structured
error envelope on stderr. Aggregate verdicts must be read from the envelope; exit status alone
is transport/control information.

Do not edit generated schema browser interiors. Refresh them from the canonical schemas with the
repository generator when the product contract changes.
