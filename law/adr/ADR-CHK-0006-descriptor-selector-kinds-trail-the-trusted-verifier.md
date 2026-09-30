---
id: ADR-CHK-0006
title: The committed descriptor uses only the selector kinds the pinned trusted verifier admits
type: adr
status: accepted
date: 2026-09-30
authority: Architect
supersedes: []
provenance:
  - ADR-CHK-0003
  - ADR-GOV-0017
  - ADR-014
  - law/policy/trusted-local-rc-verifier-package.json
  - packages/cli/vendor/evidence-verification/schemas/task-descriptor.schema.json
  - .devai/config/change-taxonomy-binding.json
  - docs/dev/operations/release-discipline.md
  - release rehearsal runs 36672126555 and 36674222428 of v1.7.0, failed in verify-ledger at "Bind and verify exact release evidence" with SCHEMA_INVALID on tasks[17].inputSelectors[0].kind
affected_rules:
  - test-tasks.json
  - law/policy/trusted-local-rc-verifier-package.json
  - scripts/check-test-task-workspace-selectors.mjs
  - packages/cli/src/services/check-runner/policy-descriptor.ts
  - docs/dev/operations/release-discipline.md
inspector_acceptance:
  - IA-001 -- Every selector kind in the committed descriptor is in the trusted-verifier policy's declared set, and a descriptor carrying a kind outside that set is refused by the descriptor check with the named code TEST_TASK_SELECTOR_KIND_UNADMITTED, naming the node and the kind.
  - IA-002 -- The seven former class nodes carry exactly the change-taxonomy binding expansion of their class, in the binding's order, and drift in either direction (a binding entry the descriptor lacks, or a descriptor selector the binding does not derive) fails the contract test.
  - IA-003 -- A pull request whose changed paths all classify as plan selects the planning lane from the commit-range classification with a descriptor that holds no class selector, and a class selector remains supported by the policy layer under a fixture descriptor.
  - IA-004 -- The pinned 1.5.4 verifier's policy builder accepts the committed descriptor and reproduces the ledger's task policy byte for byte, proved by a release rehearsal that passes the exact-evidence binding step.
  - IA-005 -- The ADR freeze test lists ADR-CHK-0006 among the effective authorities, and the adrs check reports it effective for every one of its declared subjects.
---

# The committed descriptor uses only the selector kinds the pinned trusted verifier admits

## Status

Proposed and accepted on 2026-09-30 by the Architect with the Owner's prior
authorization of round R-0311 of campaign CMP-0003, from the failure of the
first two live rehearsals of release v1.7.0. Narrows ADR-CHK-0003 in its
descriptor clause only: the sentence "`class` selectors bind the floor per
class in `test-tasks.json`" no longer applies until a published verifier
admits the kind. The lane selection, the two `plan:validate` members, the
`docs:validate` membership, the bootstrap cache, and every other clause of
ADR-CHK-0003 are unchanged, and ADR-GOV-0017's `class` selector kind stays in
the descriptor grammar and the policy layer.

## Context

The release workflow rebuilds the task policy from the candidate's
`test-tasks.json` with the policy builder of the pinned trusted verifier
package, `@aarusso-nyx/devai@1.5.4` under
`law/policy/trusted-local-rc-verifier-package.json`, and byte-compares it
with the ledger's task policy. That verifier is immutable by design
(ADR-014): its descriptor schema,
`dist/runtime/evidence-verification/schemas/task-descriptor.schema.json`,
admits the selector kinds `exact`, `prefix`, and `glob`, and the checkout's
vendored copy of the same schema admits the same three. Rehearsals
36672126555 and 36674222428 of v1.7.0 failed in `verify-ledger` at "Bind and
verify exact release evidence" with `SCHEMA_INVALID` on
`tasks[17].inputSelectors[0].kind`. The committed descriptor has used
`kind: class` on seven nodes since commit 2ae6b427 of 2026-09-28, after
`v1.6.0`, as ADR-CHK-0003 directed: `plan:campaign`, `plan:scorecard-page`,
and `plan:validate` select class `plan`; `docs:links`, `docs:governance`,
`docs:ci-economy`, and `docs:validate` select class `docs`. No published
package admits `class`, and the candidate cannot verify itself, so no
descriptor that uses the kind can pass the exact-evidence binding. The
verifier and the descriptor advance on different clocks: the descriptor
changes with the candidate, the verifier changes only when a release is
published and then pinned.

`.devai/config/change-taxonomy-binding.json` expands `plan` to the prefixes
`product/`, `record/`, and `work/`, and `docs` to the prefix `docs/` plus the
exact root files `README.md`, `CLAUDE.md`, `AGENTS.md`, `CHANGELOG.md`,
`LICENSE`, `NOTICE`, and `scratch/README.md`. Those expansions are expressible
in the kinds the verifier admits. The planning lane itself is selected from
the taxonomy classification of the commit range in the check-runner policy,
never from a descriptor selector, and
`packages/cli/src/services/check-runner/policy-descriptor.ts` loads the
taxonomy classifier only when the descriptor holds a class selector.

## Decision

The committed `test-tasks.json` uses only the selector kinds the pinned
trusted verifier's descriptor schema admits. A descriptor kind becomes usable
in the committed descriptor one release after a published verifier admits
it: the release that first ships a verifier admitting the kind is built from
a descriptor that does not use it, and the descriptor may adopt the kind
only once that release is pinned as the trusted verifier.

`law/policy/trusted-local-rc-verifier-package.json` declares the admitted set
as `descriptor.selector_kinds`, today `exact`, `prefix`, and `glob`, the
kinds the 1.5.4 verifier schema admits. Re-pinning the verifier re-declares
the set from the pinned package's schema in the same law change.

Each of the seven class selectors is materialized into its change-taxonomy
binding expansion: the binding entries of that class, as prefix and exact
selectors, in the binding's order, replacing the class selector in place and
leaving every other selector of the node untouched. A contract test binds
the seven nodes to the binding: a binding entry for `plan` or `docs` that the
node lacks, or a selector on the node that the binding does not derive, fails
the test in either direction. The materialization holds until a published
verifier admits the `class` kind and the policy declares it; then a later
record may restore the class selectors.

The descriptor check `scripts/check-test-task-workspace-selectors.mjs`,
executed by `devai:prepare` and therefore by the `generate` node of every
gate profile that builds, refuses a selector whose kind is absent from the
declared set with the named code `TEST_TASK_SELECTOR_KIND_UNADMITTED`, naming
the node and the kind, and never rewrites the descriptor to pass.

The planning lane keeps selecting by the commit-range classification, with
no class selector in the descriptor. The check-runner policy loads the
taxonomy classifier whenever lane selection needs it, not only when the
descriptor holds a class selector. The `class` kind stays in the descriptor
schema, in `policy-descriptor.ts`, and in the policy layer, so an adopter
whose verifier admits it, and this repository after a later pin, use it
without a code change.

`docs/dev/operations/release-discipline.md`, "Publish a public release",
states the rule and the one-release lag.

## Consequences

Release v1.7.0 can be rehearsed and verified by the 1.5.4 verifier with a
descriptor the verifier's schema accepts, and every later candidate is bound
to its pinned verifier's grammar before a rehearsal is spent. The task policy
digest changes with the descriptor, so the RC attestation for the candidate
that adopts this record must be re-issued. The seven nodes select the same
paths as before through their expansions, so no lane widens or narrows;
the descriptor carries forty-one expansion selectors in place of seven class
selectors, which the contract test keeps in step with the binding. A future
selector kind costs one published release of lag before the descriptor may
use it, which is the price of an immutable verifier. Lane selection no longer
depends on the descriptor holding a class selector, which removes a latent
coupling.

## Alternatives Considered

Advancing the verifier pin to a package that admits `class` is rejected: no
published package admits it, and the first one that would is the candidate
under verification, so the pin cannot lead the descriptor. Relaxing the
pinned verifier's schema is rejected: the verifier is immutable and its
provenance digest is bound in the release manifest (ADR-014). Deferring the
release until a verifier admitting `class` exists is rejected: it blocks the
adopter waiting on v1.7.0 and would itself require a release built from a
descriptor without `class`, which is this decision. Reverting ADR-CHK-0003's
planning lane is rejected: the lane never depended on a class selector, and
the expansions preserve its node selection exactly.

## Affected Rules

- `test-tasks.json`: the seven former class nodes carry the binding
  expansion of their class, and no selector uses a kind outside the declared
  set.
- `law/policy/trusted-local-rc-verifier-package.json`: `descriptor.selector_kinds`
  declares the admitted set of the pinned verifier.
- `scripts/check-test-task-workspace-selectors.mjs`: the check refuses an
  unadmitted kind with `TEST_TASK_SELECTOR_KIND_UNADMITTED`.
- `packages/cli/src/services/check-runner/policy-descriptor.ts`: the
  classifier loads whenever lane selection needs it, and the `class` kind
  stays supported.
- `docs/dev/operations/release-discipline.md`: the rule and the one-release
  lag are stated in "Publish a public release".

## Inspector Adversarial Acceptance

Add a selector with kind `class` to one node of a fixture descriptor and
run the descriptor check; confirm it refuses with
`TEST_TASK_SELECTOR_KIND_UNADMITTED`, names the node and the kind, and leaves
the descriptor bytes unchanged. Remove one expansion selector from
`docs:validate` and confirm the contract test fails; add a prefix selector the
binding does not derive to `plan:validate` and confirm it fails too. Change
the `plan` binding in a fixture and confirm the test names the missing
expansion. Open a fixture pull request that changes only a prompt and the
campaign ledger and confirm the planning lane is selected with the committed
descriptor. Run the release rehearsal and confirm the exact-evidence binding
step passes with the 1.5.4 policy builder. Run the ADR freeze test and the
adrs check and confirm ADR-CHK-0006 is an effective authority.
