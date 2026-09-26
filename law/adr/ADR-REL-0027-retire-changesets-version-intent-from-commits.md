---
id: ADR-REL-0027
title: Retire changesets and derive the minimum version bump from commit types
type: adr
status: accepted
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-GOV-0018-commit-grammar-and-single-family-commits.md
  - law/policy/release-lifecycle.json
  - scripts/check-changesets.mjs
affected_rules:
  - .changeset/config.json
  - scripts/check-changesets.mjs
  - packages/cli/src/commands/check/adapters.ts
  - docs/reference/scripts.md
  - scripts/run-pr-release-gate.mjs
inspector_acceptance:
  - IA-001 -- A pull request containing a feat commit whose candidate version is only a patch bump above base is blocked at preflight.
  - IA-002 -- A pull request with a breaking marker whose candidate version is not a major bump is blocked at preflight.
  - IA-003 -- The changeset-version check member no longer exists and requesting it is an unknown-member error, never a pass.
---

# Retire changesets

## Status

Accepted on 2026-09-26 by maintainer decision. Depends on ADR-GOV-0018 for enforced commit types.

## Context

The repository carries a `.changeset` directory holding only a configuration
file, a validation script for changeset entries that has nothing to validate,
and a check member that runs that script. No changeset entry exists in the
history. The single release unit is versioned by hand in the package
manifest, and the pull-request gate already compares the base and candidate
manifest versions. Two version-intent mechanisms, one of them unused, invite
drift and give agents two places to be wrong.

## Decision

Remove the changeset directory, its validation script, its check member, and
its reference in the scripts documentation. Version intent comes from the
enforced commit grammar: `feat` requires at least a minor bump, `fix`,
`perf`, and `refactor` at least a patch bump, and a breaking marker requires
a major bump. Commits of governance, infrastructure, `docs`, `test`,
`chore`, and `build` types require no bump. The pull-request gate computes
the minimum bump over the first-parent range and blocks a candidate whose
manifest version delta is below it. A candidate may exceed the minimum; the
human version decision remains authoritative for anything above the floor.

## Consequences

One fewer mechanism and one fewer script. The constitution's mention of
`.changeset/` as an example host-tool directory stays accurate as an example
and needs no amendment. The `yaml` development dependency remains because
two other scripts use it. The release lifecycle kernel is unchanged; the
floor is computed before it and expressed as a blocking preflight reason.

## Alternatives Considered

Adopting changesets fully is rejected because a single release unit gains
nothing from per-package release files and the commit grammar already
carries the same information. Leaving the empty mechanism in place is
rejected because an unused gate is a false signal.

## Affected Rules

The changeset configuration and script are removed, the check adapter loses
one member, the scripts reference loses one row, and the gate script gains
the bump floor computation.

## Inspector Adversarial Acceptance

Open a pull request with a `feat` commit and a patch-level manifest bump and
confirm the block. Repeat with a breaking marker and a minor bump. Request
the removed check member by name and confirm an unknown-member error rather
than a pass or a skip. Confirm a docs-only pull request with no bump passes
the floor.
