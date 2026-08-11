---
title: Evidence
sidebar_position: 8
---

# Evidence

DEVAI records governed results through one append-only, tamper-evident boundary. Each record binds
its payload, the prior chain state, and the context required to interpret the claim. Evidence is
valid only for those exact inputs; it is not a general certificate that later changes inherit.

## Current operations

- `devai evidence collect` imports one declared source into harness state.
- `devai evidence record` appends one schema-valid governed record.
- `devai evidence verify` checks a declared evidence scope and can inspect the current chain head.
- `devai evidence render` produces a view from canonical records.
- `devai evidence redact` applies an attributable redaction policy, re-links downstream records,
  and logs the redaction event.

Every write requires the action's declared role and explicit `--write` consent. Adopters must not
edit `record/proofs/chain.json` directly.

## Verification

```bash
devai evidence verify --scope local --repo-root . --format json
devai evidence verify --scope chain --show-head --repo-root . --format json
```

Verification recomputes record digests and linkage. A malformed record, unknown schema, digest
divergence, or broken prior link fails the claim. A valid chain proves integrity of the recorded
material; it does not prove that an untrusted actor actually ran the command described by a
payload.

## Recording and redaction

```bash
devai evidence record --kind generic --round R-1000 --input ./result.json \
  --as-role auditor --write --format json

devai evidence redact 1 --round R-1000 --kind generic --field secret \
  --reason "credential exposed" --as-role auditor --write --format json
```

Redaction is for sensitive payload content or legal compliance. It is not a way to turn a failed
result into a pass. The redaction itself remains attributable and visible in the chain.

## Freshness

Test and check receipts are content-addressed. Reuse requires an exact match for the task policy,
inputs, relevant environment, toolchain, and clean Git tree. Missing, stale, malformed, unknown,
failed, aborted, killed, or timed-out results are not reusable.

## See also

- [Evidence operations](../../dev/operations/evidence-chain-runbook.md)
- [Local evidence](../../dev/operations/local-evidence-runbook.md)
- [Test result contract](../../reference/contracts/test-result.md)
