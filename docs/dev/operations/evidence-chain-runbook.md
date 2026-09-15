# Evidence operations

Verify current evidence read-only:

```bash
devai evidence verify --scope local --repo-root . --format json
devai evidence verify --scope chain --show-head --repo-root . --format json
```

Record a schema-valid payload through the append-only boundary:

```bash
devai evidence record --kind generic --round R-1000 \
  --input ./result.json --as-role auditor --write --format json
```

When sensitive payload content must be removed, record an attributable erratum rather than
rewriting history silently:

```bash
devai evidence redact <sequence> --round R-1000 --kind generic \
  --field secret --reason "credential exposed" --as-role auditor --write --format json
```

Stop on malformed records, digest divergence, unknown sequence, or partial output. Preserve the
candidate and diagnostic material until a human chooses the repair.

Agent-run receipts under `record/proofs/work/agent-runs/` follow their verified
`prev_hash` links. UUID filename order cannot determine execution order when records
share a millisecond. The agent-run writer validates the stored population and extends
its unique chain tip. Malformed records, missing predecessors, multiple genesis records,
or forks block further emission; they must not silently start a new genesis. Preserve
the complete directory for human reconciliation. A filename collision also refuses
replacement of the existing record.
