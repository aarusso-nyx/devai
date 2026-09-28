---
id: ADR-CFG-0002
title: Owned configuration projection retires absent blocks under an ownership matrix
type: adr
status: proposed
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-CFG-0001
  - ADR-GOV-0002
  - docs/dev/operations/harness-convergence-proposals.md
  - packages/cli/src/services/adopter-policy.ts
  - law/policy/devai-adoption.json
affected_rules:
  - packages/cli/src/services/adopter-policy.ts
  - packages/cli/src/services/adopter-policy-binding.ts
  - packages/cli/src/commands/init/bind-adapters.ts
  - packages/cli/src/commands/init/bind-package.ts
  - packages/skills/src/bootstrap/index.ts
  - packages/cli/tests/unit/adopter-policy-ci-economy-boundary.test.ts
  - packages/cli/tests/unit/adopter-policy-materialization-depth.test.ts
  - .devai/config/adopter-policy-binding.json
inspector_acceptance:
  - IA-001 -- Retire the ci_economy block from the adopter policy source, rebind, and confirm the projected project.json carries no ci_economy key and doctor reports no trusted-local-rc-boundary failure.
  - IA-002 -- Add an adopter declaration under a key the ownership matrix does not name, rebind twice, and confirm the declaration survives both binds byte-for-byte.
  - IA-003 -- Interrupt the write between the projection and the receipt and confirm the next bind observes either the previous complete pair or the new complete pair, never a projection without its receipt.
  - IA-004 -- Rebind with an unchanged source and confirm no target file changes bytes and the receipt lists no retired key.
  - IA-005 -- Materialize the binding with a stale scorecard-na.json digest and confirm doctor reports the digest mismatch until the binding is rematerialized under this record.
---

# Owned configuration projection

## Status

Proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Binds nothing until the Architect sets it to accepted
before the round that implements it opens. Changes the merge rule of
`init bind --adopter-policy` for the keys it owns and adds a rematerialization
of the stale adopter policy binding; ADR-CFG-0001 stays in force.

## Context

`init bind --adopter-policy` projects `law/policy/devai-adoption.json` into the
five bound configuration files under `.devai/config`. For `project.json` the
projection in `packages/cli/src/services/adopter-policy.ts` deep-merges the
current `project.json` with the overrides the policy declares, so a block the
adopter retires from the source never leaves the projection. The adopter
reproduction from 1.4.5 is unchanged in 1.6.0: retiring `ci_economy` from the
policy and rebinding leaves the old `ci_economy` block in `project.json`, and
`doctor` then fails `trusted-local-rc-boundary` against a declaration nobody
holds any more (#68). `reconcileProjectConfig` in
`packages/skills/src/bootstrap/index.ts` follows the same preserving rule. A
second defect shares the mechanism: `.devai/config/adopter-policy-binding.json`
pins a digest for `scorecard-na.json` that no longer matches the file, and the
digest check that would surface it already exists in
`adopter-policy-binding.ts` (#162, item 4). No hand edit to generated
configuration is admitted, so the projection has to become authoritative for
what it owns.

## Decision

An ownership matrix, declared once in `adopter-policy.ts` and exported for the
materialization tests, names every `project.json` key and nested block that
`init bind --adopter-policy` projects from `law/policy/devai-adoption.json`,
including the `project` overrides, `ci_economy`, and `devai_version`. For an
owned key, absent in the source means absent in the projection: the bind
removes the key from the current `project.json` rather than carrying it
forward. A key the matrix does not name is an adopter declaration; it is never
read from the policy and it survives every bind unchanged. The `deepMerge` over
the current project document is replaced for owned keys by this replace-or-retire
rule, and `reconcileProjectConfig` consults the same matrix so the
bootstrap and the bind never disagree about which keys are owned.

The projection and its receipt are written as one atomic step: the bind stages
every target file and the receipt, then renames them into place, so an
interrupted bind leaves either the previous complete pair or the new complete
pair. The receipt in `.devai/config/adopter-policy-binding.json` lists the
owned keys the bind retired, by JSON pointer, beside the digests it already
carries. The operation is idempotent: a bind against an unchanged source and an
unchanged current project writes no byte to any target and records no retired
key, so a second bind is observable only through its unchanged receipt.

The stale `scorecard-na.json` digest in the committed binding is a
rematerialization task under this record, not a code change: the binding is
regenerated from the current policy and the digest check in
`adopter-policy-binding.ts` is what keeps it honest thereafter. The doctor
check that reads the binding is unchanged and keeps reporting a digest mismatch
as a failure.

## Consequences

An adopter retires a block by deleting it from the policy source and rebinding,
which is the only path; the projection becomes the authority for owned keys
and the adopter's own declarations keep their author. `doctor` stops failing
on retired declarations, and a bind can be re-run at any time without
producing churn. The receipt gains a retired-keys list, which the binding
schema and its tests must admit. The framework's own binding is rematerialized
once, which changes the committed digest bytes and nothing else.

## Alternatives Considered

Keeping the deep merge and adding a `--prune` flag is rejected because the
default path would still leave retired blocks in place and the flag would be
a hand-operated correction to generated configuration. Deleting every key not
present in the policy is rejected because it would erase adopter declarations
that the policy never governed. Editing `project.json` by hand after a bind is
rejected by the non-decisions of the proposal set: generated configuration is
never hand-edited.

## Affected Rules

- `packages/cli/src/services/adopter-policy.ts` gains the ownership matrix and
  the replace-or-retire projection for owned keys.
- `packages/cli/src/services/adopter-policy-binding.ts` admits the retired-keys
  list in the receipt and keeps the digest verification.
- `packages/cli/src/commands/init/bind-adapters.ts` and
  `packages/cli/src/commands/init/bind-package.ts` write the projection and the
  receipt atomically.
- `packages/skills/src/bootstrap/index.ts` makes `reconcileProjectConfig`
  follow the matrix.
- The two adopter-policy unit suites carry the retirement, survival, and
  idempotence fixtures.
- `.devai/config/adopter-policy-binding.json` is rematerialized.

## Inspector Adversarial Acceptance

Run the 1.4.5 reproduction: bind with `ci_economy` declared, retire it from
the source, rebind, and confirm `project.json` carries no `ci_economy` key and
`doctor` reports no `trusted-local-rc-boundary` failure. Declare a key outside
the matrix, rebind twice, and confirm it survives byte-for-byte. Kill the
process between the staged write and the rename and confirm the next bind sees
a complete pair. Rebind an unchanged source and confirm every target is
byte-identical and the receipt lists no retired key. Materialize a binding with
a stale `scorecard-na.json` digest and confirm `doctor` reports the mismatch
until the binding is regenerated.
