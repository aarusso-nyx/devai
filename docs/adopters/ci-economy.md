# Cheap local checks and receipt-only CI

DEVAI's test DAG behaves like a content-addressed build graph. A task key binds its Git
blob inputs, dependency keys, canonical executable and arguments, working directory,
toolchain, allowlisted environment, and output contract. Commit identity and file mtimes
do not invalidate identical content.

## Local development

Plan or explain the affected closure from an exact base:

```bash
devai check --affected --task-plan --base <exact-base-commit> --format json
devai check --affected --explain --base <exact-base-commit> --format json
```

Execute it only with the required local-write consent:

```bash
devai check --affected --run --base <exact-base-commit> \
  --as-role inspector --write --format json
```

Only PASS results are reusable. A changed source, test, helper, configuration, lockfile,
dependency key, toolchain, allowlisted environment value, command, or output contract
invalidates the affected closure. Unknown paths widen through the policy's declared
`test:local-full` fallback rather than silently selecting nothing. Known paths select only
their matching leaf tasks and dependent closure. FAIL, timeout, killed, aborted, and malformed
results are never reusable.

Dirty-tree iteration may populate the ignored local cache, but it cannot produce a candidate
receipt. `--local` always uses the complete cheap cached closure and does not produce a receipt.
A clean affected or RC execution may produce an unsigned candidate receipt only when the tree
is unchanged before and after execution and the commit/tree binding is exact.

## RC gate

`devai check --rc --task-plan` selects the fixed release-candidate closure. The RC profile
runs one coverage node after generation and build. That node collects the complete 104-file
Vitest population exactly once, including database, E2E, performance, and containment tests, and
enforces floors of 70% statements, 60% branches, 70% functions, and 70% lines. The narrower DB,
E2E, performance, and containment scripts are diagnostic slices, not additional RC gates.

## Remote verification

Remote CI does not rerun product tests. A candidate-independent exporter first validates the
clean local receipt and exact results, then signs the canonical receipt outside the candidate
repository. CI checks that export with an independently pinned verifier, an allowlisted,
non-revoked Ed25519 public key, the exact repository/commit/tree, the approved task-policy
digest, and the complete required-node closure. Missing, stale, malformed, unknown, FAIL, or
ABORTED nodes reject the receipt.

This boundary is intentionally honest: a trusted local signature attests that the signer
claims the bound tasks and results. Cryptography detects tampering and identity mismatch; it
does **not** prove that the signer actually executed the commands. Trust in execution remains
a human and signer-operational decision.
