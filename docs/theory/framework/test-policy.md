---
title: Test policy
sidebar_position: 12
---

# Test policy

Tests are observations of product behavior. Ordinary development selects only the
content-addressed task closure affected by a change; the release-candidate gate runs the fixed
hard closure once.

## Affected development checks

```bash
devai check --affected --task-plan --base <exact-base-commit> --repo-root . --format json
devai check --affected --run --base <exact-base-commit> --repo-root . \
  --as-role inspector --write --format json
devai check --affected --status --base <exact-base-commit> --repo-root . --format json
```

A task key binds Git blob inputs, dependency keys, canonical runner arguments and working
directory, toolchain, allowlisted environment, and output contract. It does not use mtimes or
commit identity as a substitute for content. Identical content may reuse a matching PASS.

Any changed input, dependency, command, toolchain, allowed environment value, or output contract
invalidates the affected closure. Unknown paths widen through the declared fallback. FAIL,
timeout, killed, aborted, malformed, incomplete, or unknown results are never reusable.

Known paths select matching leaf tasks and their dependent closure. `--local` selects the complete
cheap closure directly and reuses unchanged PASS nodes from the ignored cache. Dirty-tree runs may
help local iteration, but they cannot produce a candidate receipt. The local profile is always
non-attestable; a clean affected or RC run may emit an unsigned receipt only when the exact Git
tree is unchanged before and after execution.

## Release-candidate gate

```bash
devai check --rc --task-plan --repo-root . --format json
devai check --rc --run --repo-root . --as-role inspector --write --format json
```

The RC profile executes generation, build, and one coverage task. That task includes the complete
Vitest population exactly once and enforces floors of 70% statements, 60% branches, 70% functions,
and 70% lines. Database, end-to-end, performance, and containment scripts are diagnostic slices
of that population, not additional required RC gates. Real-provider execution remains explicit
opt-in.

## Receipt-only remote CI

An exporter outside the candidate first verifies the clean local receipt and result set, then
signs the canonical receipt with protected trust material. Remote CI verifies that export against
an independently pinned verifier, the exact repository/commit/tree, the approved task-policy
digest, signer allowlist and revocation state, and the complete required-node closure. It does not
rerun product tests.

A trusted signature proves receipt integrity and signer identity. It does not prove that the
signer actually executed the described command; execution trust remains an explicit operational
decision.

## Test changes

A product change should add or strengthen the smallest observation that proves its contract.
Weakening an observation requires an explicit contract change or a demonstrated test defect.
Quarantine is temporary and visible; it is not a way to convert a failing required result into a
pass.

## See also

- [Testing operations](../../dev/operations/testing.md)
- [Cheap local checks and receipt-only CI](../../adopters/ci-economy.md)
- [Test result contract](../../reference/contracts/test-result.md)
