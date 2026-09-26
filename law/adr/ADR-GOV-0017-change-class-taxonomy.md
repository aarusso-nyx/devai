---
id: ADR-GOV-0017
title: Classify every tracked path into one change class declared in law
type: adr
status: proposed
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/constitution.md#article-6-substrate-authority-by-path
  - docs/adopters/ci-economy.md
  - scripts/run-pr-release-gate.mjs
affected_rules:
  - law/policy/change-taxonomy.json
  - law/schemas/change-taxonomy.schema.json
  - law/policy/adopter-defaults/change-taxonomy-binding.json
  - test-tasks.json
  - packages/cli/src/services/check-runner/policy.ts
  - scripts/run-pr-release-gate.mjs
  - scripts/check-policy-materialization.mjs
inspector_acceptance:
  - IA-001 -- A tracked path matched by no binding fails the taxonomy check instead of silently widening to the fallback node.
  - IA-002 -- A path bound to two classes is rejected at policy load, not resolved by declaration order.
  - IA-003 -- A plan-class-only change selects no node that executes package code, and the release intent it derives is not behavioral.
  - IA-004 -- An adopter binding that renames a law class or adds a class is rejected as policy drift.
---

# Change class taxonomy

## Status

Proposed. Changes the task descriptor and the derived release intent, so the
task-policy digest changes and the RC attestation must be re-issued for the
candidate that adopts it.

## Context

The task descriptor selects nodes by path prefix, exact path, or glob. Paths
matched by no selector widen to the declared fallback node, which is the full
local suite. `record/`, `product/`, `law/adr/`, and `work/` have no selector,
so a commit that only adds a round plan or an ADR executes the complete local
closure. The pull-request gate separately classifies the release intent with
hand-written regular expressions and treats anything outside `docs/`,
`README.md`, and `CHANGELOG.md` as behavioral. The constitution already
assigns authority by path prefix, but nothing assigns a verification class.

## Decision

Law declares a closed vocabulary of change classes and, for each class, the
check members it engages and the classes it may share a commit with. The
classes are `law`, `spec`, `plan`, `code`, `tests`, `docs`, `ci`,
`toolchain`, and `generated`. Each class maps onto the constitution's
authority-by-path table; the taxonomy never contradicts that table.

The binding from path to class is adopter policy with a law-provided default,
because adopter layouts differ. DEVAI carries its own binding for its own
repository. A binding may only assign paths to law classes; it may not add,
rename, or merge classes. Every tracked path resolves to exactly one class.
Overlapping bindings are a policy load error.

The task descriptor gains a `class` selector kind. Nodes for non-code classes
select by class rather than by prefix, so classified paths never reach the
fallback. The fallback remains for genuinely unclassified paths, and a
`change-taxonomy` check member fails whenever a tracked path is unclassified.
The pull-request gate derives the release intent's change kind and risks from
the class set instead of from inline regular expressions.

## Consequences

Plan-only, law-only, and docs-only changes execute only their class checks.
The DAG selection semantics and the content-addressed cache are unchanged;
this adds a selector kind and a validation member. The taxonomy policy joins
the materialized policy set, so `check-policy-materialization` and `doctor`
gain one file. Commit hygiene under ADR-GOV-0018 consumes the same classes.

## Alternatives Considered

Adding prefix selectors for the missing paths without a taxonomy is rejected
because the release intent would still be derived by regular expressions and
adopters would inherit nothing. Making the taxonomy adopter-only is rejected
because the class vocabulary must be stable for law, hooks, and the release
kernel to agree. Weakening the fallback to "select nothing" is rejected
because unknown paths must widen, never vanish.

## Affected Rules

A new policy and schema, the adopter default binding, the descriptor selector
grammar, the check-runner policy that evaluates selectors, the gate script
that derives release intent, and the materialization check list.

## Inspector Adversarial Acceptance

Introduce an unbound tracked path and confirm the taxonomy member fails.
Bind one path to two classes and confirm load rejection. Commit a plan-only
change and confirm the planned node set contains no vitest or build node and
the derived intent is not behavioral. Attempt an adopter binding that adds a
class and confirm drift rejection. Confirm the existing prefix, exact, and
glob selectors behave identically before and after the change.
