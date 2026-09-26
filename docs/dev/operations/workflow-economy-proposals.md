# Workflow economy proposals

Status: proposed decision set from the 2026-09-26 maintainer brainstorm. Every
record below is `proposed`; none binds until accepted under Architect
authority, and the two repository-setting changes are separate Owner effects.

## Root cause observed

The task descriptor has no selector for `record/`, `product/`, `law/adr/`, or
`work/`. Unmatched paths widen to the full local suite, so a plan-only commit
runs the complete closure. The pull-request gate classifies any path outside
`docs/`, `README.md`, and `CHANGELOG.md` as behavioral. Ten of the last sixty
commits are release fixes for drifting pins, provenance, or environment.

## Decision records

| Record                                                                                         | Decides                                                              |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [ADR-GOV-0017](../../../law/adr/ADR-GOV-0017-change-class-taxonomy.md)                         | Change classes in law; path bindings as adopter policy               |
| [ADR-GOV-0018](../../../law/adr/ADR-GOV-0018-commit-grammar-and-single-family-commits.md)      | Semantic commit grammar; cross-family commits rejected               |
| [ADR-REL-0027](../../../law/adr/ADR-REL-0027-retire-changesets-version-intent-from-commits.md) | Changesets removed; bump floor from commit types                     |
| [ADR-REL-0028](../../../law/adr/ADR-REL-0028-prerelease-channel-ladder.md)                     | Alpha, beta, rc ladder with per-rung capabilities and dist-tags      |
| [ADR-CHK-0001](../../../law/adr/ADR-CHK-0001-preflight-probes-as-dag-nodes.md)                 | Preflight probes as DAG nodes; `BLOCKED` outcome for extrinsic fails |
| [ADR-CHK-0002](../../../law/adr/ADR-CHK-0002-toolchain-manifest.md)                            | One toolchain manifest consumed by workflows, provisioning, probes   |
| [ADR-SEC-0001](../../../law/adr/ADR-SEC-0001-credential-requirements-manifest.md)              | Credential requirements per effect; presence probed, values unread   |
| [ADR-GOV-0019](../../../law/adr/ADR-GOV-0019-backlog-action-family.md)                         | `backlog` action family with opt-in issue projection                 |
| [ADR-CFG-0001](../../../law/adr/ADR-CFG-0001-schema-driven-interactive-configuration.md)       | Schema-driven interactive `init plan` replaying as existing actions  |

## Sequencing

1. ADR-CHK-0002 first: the toolchain manifest removes the inline pins that
   every later change would otherwise have to touch again, including the
   expected action count in the release workflow.
2. ADR-GOV-0017, then ADR-GOV-0018, then ADR-REL-0027. Each consumes the
   previous one's vocabulary.
3. ADR-CHK-0001 and ADR-SEC-0001 together. Both change the task descriptor
   and therefore the task-policy digest; landing them in one candidate means
   one RC attestation re-issue instead of two.
4. ADR-REL-0028 and ADR-GOV-0019 are independent of the above and of each
   other, apart from the action count moving to the manifest.
5. ADR-CFG-0001 last. It is a front end over the actions the others leave
   unchanged.

## Separate Owner effects

- Disable squash merging on the integration branch (required by
  ADR-GOV-0018).
- Require the `devai-release-gate` check and strict up-to-date status in
  branch protection, as the remote preflight contract already notes.

## Non-decisions

- Constitution text is untouched. The taxonomy maps onto Article 6; the
  `.changeset/` example there stays accurate as an example.
- Verification depth per stable transition already exists in the release
  lifecycle policy and is not redefined.
- No automatic retry for flaky tests. They are backlog items.
