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
runs one coverage node after generation and build. For the stable 1.0 candidate that node
collects 106 files and 926 tests exactly once, including database, E2E, performance, and
containment tests, and
enforces floors of 70% statements, 60% branches, 70% functions, and 70% lines. The narrower DB,
E2E, performance, and containment scripts are diagnostic slices, not additional RC gates.

## Remote verification

Remote CI does not rerun the attested RC closure. It may execute the cheap local closure —
lint, typecheck, and the local test suite — as a non-attesting preflight signal on pull
requests. A preflight run creates no evidence: it neither produces, substitutes for, nor
supplements a candidate receipt, and a green preflight proves only that those commands exited
zero on an untrusted runner. Declare what must never run remotely with
`ci_economy.attested_rc.local_only_nodes`; `check --only ci-economy` fails closed on any
workflow that reaches a declared local-only node, directly or through an npm-script alias.

The package-owned `devai-evidence-export` entry point first
validates the clean local receipt and exact results from the protected signing environment, then
signs the canonical receipt outside the candidate repository. CI checks that export with the
immutable verifier in the exact installed DEVAI package, an allowlisted,
non-revoked Ed25519 public key, the exact repository/commit/tree, the approved task-policy
digest, and the complete required-node closure. Missing, stale, malformed, unknown, FAIL, or
ABORTED nodes reject the receipt.

This boundary is intentionally honest: a trusted local signature attests that the signer
claims the bound tasks and results. Cryptography detects tampering and identity mismatch; it
does **not** prove that the signer actually executed the commands. Trust in execution remains
a human and signer-operational decision.

## Remote workflow posture

Pull-request workflows cancel superseded runs and use Linux runners. They do not
combine pull-request, push, and scheduled product-validation triggers. Path filters
are appropriate only for content the gate does not consume; tested documentation and
policy inputs remain unfiltered. Concurrent suites that use PostgreSQL need isolated
ephemeral databases or serialized database-heavy work rather than inflated timeouts.

A preflight lane, where a repository runs one, is untrusted and non-attesting by
construction: pull-request trigger only, `contents: read`, no job environment, no secret
reference, pinned actions, no artifact upload, and no path from its result into the evidence
chain. It is a contradiction check that runs before a signer spends time on a candidate, not
a second source of truth.

The `ci_economy` project configuration selects the full or staged enforcement profile.
Its optional `local_evidence` declaration is fail-closed: a missing declaration never
accepts claimed local evidence, and policy-sensitive changes always force the protected
remote path.
