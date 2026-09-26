---
id: ADR-GOV-0018
title: Require semantic commit messages and forbid cross-family commits
type: adr
status: accepted
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/adr/ADR-GOV-0017-change-class-taxonomy.md
  - law/constitution.md#article-27-worktree-discipline
  - law/constitution.md#article-28-single-integration-branch
  - scripts/check-change-hygiene.mjs
affected_rules:
  - law/policy/commit-grammar.json
  - law/schemas/commit-grammar.schema.json
  - .githooks/commit-msg
  - .githooks/pre-commit
  - scripts/check-change-hygiene.mjs
  - scripts/run-pr-release-gate.mjs
  - AGENTS.md
inspector_acceptance:
  - IA-001 -- A commit whose staged paths span the governance and implementation families is rejected by the hook with every class named.
  - IA-002 -- A commit whose type disagrees with the class of its paths is rejected even when the paths belong to one family.
  - IA-003 -- The pull-request range check rejects a first-parent commit that a bypassed local hook allowed.
  - IA-004 -- A merge commit and a revert of a single-family commit pass without being classified as mixed.
---

# Commit grammar and single-family commits

## Status

Accepted on 2026-09-26 by maintainer decision. Depends on ADR-GOV-0017 for the class vocabulary. Disabling squash
merges in repository settings is a separate Owner-authorized effect that this
record requires but does not perform.

## Context

Commit subjects in this repository already follow the conventional form, but
no hook or check enforces it, and the history contains ad hoc types. Planning
material and implementation land in the same commits, which makes it
impossible to select checks per commit and makes plan-only history
indistinguishable from behavioral history. Seven of the last eighty commits
on main are squash merges; a squash of a multi-class branch produces one
mixed commit on the integration branch regardless of branch discipline.

## Decision

Law declares a commit grammar: `type(scope)!: subject` with a closed type set
of `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `ci`, `build`,
`chore`, `law`, `spec`, and `plan`. Each type binds to the classes it may
touch. The classes group into three families: governance holds `law`,
`spec`, and `plan`; implementation holds `code`, `tests`, `generated`, and
`docs`; infrastructure holds `ci` and `toolchain`. A commit is mixed when its
paths span more than one family, or when its type disagrees with the class of
any path. Mixed commits are rejected. Declared pairings that cross a family
are permitted only when law lists them; `law` with `generated` is listed
because the action registry and its generated views must co-commit.

Enforcement runs at three points: the commit-msg hook validates the grammar,
the pre-commit hook classifies staged paths, and the pull-request gate walks
the first-parent range from base to candidate and re-applies both rules.
Merge commits are exempt. A revert inherits the classification of the commit
it reverts. The hook names every class it found and suggests a split.

The integration branch accepts merge commits and rebases only. Squash merging
is disabled because it would recombine what the branch separated.

## Consequences

Agents split work by family before committing; the hook message makes the
split mechanical. Per-commit classes give the gate a per-commit class set,
which is what ADR-GOV-0017 needs to select checks and derive release intent.
Commit types become the source of minimum version bump under ADR-REL-0027.
`AGENTS.md` gains one sentence stating the rule.

## Alternatives Considered

Warning instead of rejecting is rejected because a warning is not evidence
and agents do not read warnings. Rejecting every cross-class commit rather
than cross-family is rejected because a feature that updates its own
documentation is normal and should not cost two commits. Enforcing only in
CI is rejected because the local hook is where the split is cheap.

## Affected Rules

A new grammar policy and schema, two repository hooks, the hygiene script
that the pre-commit hook runs, the gate script that gains the range check,
and the agent contract.

## Inspector Adversarial Acceptance

Stage a plan file and a source file together and confirm rejection naming
both classes. Commit a `docs:` type touching a source path and confirm
rejection. Bypass the local hook, push, and confirm the range check rejects
the same commit. Confirm a merge commit and a revert pass. Confirm every
existing commit type in the recent history maps to the closed type set or is
listed as a historical exception that the range check does not re-examine.
