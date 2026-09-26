---
id: ADR-GOV-0019
title: Add a repository backlog action family with an opt-in issue projection
type: adr
status: proposed
date: 2026-09-26
authority: Architect
supersedes: []
provenance:
  - law/policy/github-issues-tracking.json
  - docs/adopters/governance-tracking.md
  - law/constitution.md#article-22-reference-gap-report-rgr
  - law/constitution.md#article-31-flaky-test-quarantine
affected_rules:
  - law/policy/action-registry.json
  - law/schemas/backlog-item.schema.json
  - law/policy/github-issues-tracking.json
  - law/schemas/github-issues-tracking-policy.schema.json
  - packages/cli/src/commands/doctor.ts
  - docs/adopters/governance-tracking.md
inspector_acceptance:
  - IA-001 -- Backlog add, list, show, and resolve are local-write actions and none of them performs a network effect.
  - IA-002 -- Projection to an issue requires the existing Owner activation and the existing disclosure profile, and a round is never inferred.
  - IA-003 -- A backlog item created in one session is surfaced by doctor and round plan in a later session without any host-specific state.
  - IA-004 -- A backlog item cannot pause, resolve, or otherwise alter a round gap.
---

# Backlog action family

## Status

Proposed. Adds four stable actions to the registry; the expected action
count must be read from the manifest under ADR-CHK-0002 before this lands.

## Context

Round gaps are round-scoped findings that pause a task. Governance tracking
projects one issue per governed round. Neither holds a finding discovered
during work that belongs to no round, a proposition for a later session, a
note from one agent to another, or a flaky test observed under ADR-CHK-0001.
Those currently live in commit messages, scratch files, or nowhere.

## Decision

Add a `backlog` action family: `backlog add`, `backlog list`, `backlog
show`, and `backlog resolve`, all stable, effect local-write, authority as
for round gaps, with optional `--round` attribution that is never inferred.
Items are schema-validated records under `.devai/state/backlog/` with a
kind (`finding`, `proposition`, `note`, `flaky-test`), a class from
ADR-GOV-0017 when a path is involved, an origin session, and a resolution
reference. Doctor and `round plan` surface open items at session start.

Projection to GitHub Issues is an extension of the existing tracking
adapter: the same Architect binding, the same Owner activation, the same
public-safe disclosure profile, and the same event kinds, with one added
event kind for backlog items. Adopters get the family through the scaffold.

## Consequences

Findings outlive the session that made them and are visible to the next
one. Flaky tests have a destination other than a retry. The registry grows
by four; the action coverage and reference generators regenerate. Round gaps
are untouched.

## Alternatives Considered

Extending round gaps with a repository scope is rejected because a gap
pauses a task and carries round semantics that a backlog item must not have.
Using GitHub Issues directly as the store is rejected because the store must
work offline and without the remote-write authority. A free-form markdown
file is rejected because it cannot be surfaced or projected deterministically.

## Affected Rules

The action registry, a new item schema, the tracking policy and schema for
the projection extension, doctor, and the tracking documentation.

## Inspector Adversarial Acceptance

Run every backlog action with network access denied and confirm success.
Attempt projection without an activation and confirm refusal. Create an
item, start a new session in a fresh clone of the same commit, and confirm
doctor lists it. Attempt to resolve a round gap through a backlog action and
confirm the action does not know the gap.
