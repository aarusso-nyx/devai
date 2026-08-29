---
id: ADR-014
title: Capability-based release verification profiles
status: accepted
date: 2026-08-29
authority: Architect
---

# Capability-based release verification profiles

## Decision

Release verification resolves two independent axes: a SemVer transition and a
support intention. The result is the union of mandatory capabilities from both
axes, selected risks, and Owner escalations. Unknown input is fail-closed.

The resolver is pure and additive. It does not replace the existing `affected`,
`local`, or `rc` task profiles, nor add a public CLI action. Existing task-key,
input-digest, toolchain, cache, and candidate-receipt mechanisms remain the
execution/evidence substrate for selected nodes.

`not-required` is an explicit disposition with a typed reason; it is never a
pass. Mutation is targeted for behavioral changes, full-roster only for LTS,
and may be omitted only for documentation/metadata-only patch releases.

Every valid decision includes the unconditional floor: formatting and whitespace
hygiene, lint, appropriate type integrity, schema/generated consistency, secret
and path-portability checks, package-boundary integrity, and exact candidate
identification. A profile can only add to this set. Local hooks are convenience
checks; candidate-bound CI and receipts independently require lint.

## Compatibility and boundaries

Missing release intent does not select a faster profile. A later runner
integration must require a valid intent before it may use this resolver. This
ADR changes no publication authority, workflow permissions, or release action
effect. DEVAI self-consumption is verification configuration only and does not
govern human maintainers.

## Rejected alternatives

An ordered `max(profile)` loses the distinct MAJOR and LTS mutation semantics.
A second cache/receipt system would weaken candidate-bound evidence identity.
