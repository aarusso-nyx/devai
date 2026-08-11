# Test result contract

A test result identifies the repository, scope, tier, canonical command, toolchain, timestamp,
outcome, and output digest for one execution. It is evidence for those exact inputs only.

Record a current result through the evidence boundary:

```bash
devai evidence record --kind test --round R-1000 \
  --tier unit --cmd "pnpm vitest run packages/example/tests/unit" \
  --scope packages/example --repo devai-nyx/example \
  --out ./record/proofs/tests/unit.json \
  --as-role inspector --write --format json
```

The content-addressed check runner emits canonical task-result JSON for its task nodes. A
candidate receipt binds the complete required-node set, exact clean Git tree, and task-policy
digest. Only matching PASS results are reusable; missing, stale, malformed, unknown, FAIL,
ABORTED, killed, or timed-out results reject the closure.

A trusted signature proves receipt integrity and the identity of an allowlisted, non-revoked
signer. It does not prove that the signer actually executed the task. That limitation is part of
the contract, not an exceptional condition.
