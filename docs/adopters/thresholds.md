# Threshold configuration

Threshold files are committed adopter policy. Change them through ordinary review and keep
the reason beside the change. Validate a file against its current schema with the migration-
bound schema check:

```bash
devai check --only schema \
  --schema law/schemas/thresholds.schema.json \
  --instance .devai/config/thresholds.json \
  --as-role inspector --write --format json
```

Use the schema path installed by the exact package version. A syntactically valid threshold
does not prove that the value is suitable; reviewers still own the acceptance decision.
