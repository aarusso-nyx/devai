---
id: ADR-CHK-0008
title: Admit the update branch with the rebase method only, driven by a rebase-update workflow when main moves
type: adr
status: accepted
date: 2026-10-08
authority: Architect
supersedes: []
provenance:
  - ADR-CHK-0004
  - ADR-CHK-0007
  - ADR-GOV-0018
  - ADR-REL-0027
  - .github/workflows/pull-request-checks.yml
  - docs/dev/operations/remote-preflight-contract.md
affected_rules:
  - .github/workflows/update-pull-request-branches.yml
  - scripts/check-workflows.mjs
  - docs/dev/operations/remote-preflight-contract.md
inspector_acceptance:
  - IA-001 -- A push to main rebases every open, non-draft pull request against main that is behind it through the update-branch API with update_method rebase and the expected head sha, and no update ever creates a merge commit on a pull-request branch.
  - IA-002 -- A pull request whose rebase conflicts is skipped and reported without failing the update of the others, and its gate run is neither started nor cancelled by the update workflow.
  - IA-003 -- A rebased head started by the update workflow starts a gate run, because the push is made with a GitHub App installation token; an update made with GITHUB_TOKEN would start none and is refused by the workflow checker.
  - IA-004 -- When the rebased head arrives while the previous head's gate is running, the per-pull-request concurrency group cancels the superseded run, which ends cancelled rather than failed and is excluded from harness_green_main.
  - IA-005 -- scripts/check-workflows.mjs fails when the update workflow loses its push-to-main trigger, its rebase update method, its expected-head-sha guard, its App-token credential, or its least-privilege permissions, and strict up-to-date protection and the single required check devai-release-gate are unchanged.
---

# Admit the update branch with the rebase method only

## Status

Accepted on 2026-10-08 by the Architect for campaign CMP-0007, round R-0702,
under Owner decision D2 of 2026-10-07: enable the auto-update branch rather
than a merge queue. This record narrows one alternative ADR-CHK-0004
rejected and leaves every other part of that record in force: strict
up-to-date branch protection, the single required check, the
`merge_group` lane, serialized admission while no queue is enabled, and the
rebase merge method.

## Context

Over the 30 days to main 92526921, 13 of the 47 failed pull-request gate runs
were the `base-up-to-date` probe reporting that main had moved. Those runs
count against F5:T9 (`harness_green_main`). ADR-CHK-0004 rejected
`allow_update_branch` because GitHub's default update merges main into the
branch, and a merge commit breaks linear history and the single-family
commit grammar (ADR-GOV-0018). GitHub's update-branch operation also has a
rebase method, which replays the branch's commits onto the new tip and
creates no merge commit. The setting by itself updates nothing: it only lets
someone press the button or call the API.

A push made with the workflow's `GITHUB_TOKEN` starts no workflow run. An
update performed with it would leave the rebased head ungated.

## Decision

`allow_update_branch` is admitted with one update method, rebase. A merge
update of a pull-request branch is refused by this record as ADR-CHK-0004
refused it.

The mechanism that keeps pull requests current is the rebase-update
workflow `.github/workflows/update-pull-request-branches.yml` (CMP-0007
TASK-0726):

1. **Trigger.** It runs on every push to main.
2. **Update.** For every open, non-draft pull request against main that is
   behind it, it calls
   `PUT /repos/{owner}/{repo}/pulls/{number}/update-branch` with
   `update_method: rebase` and the pull request's current head sha as the
   expected head.
3. **Credential.** It acts with a GitHub App installation token, never with
   `GITHUB_TOKEN`, so the rebased head starts a gate run. The workflow holds
   the least permissions it needs.
4. **Conflicts.** A pull request whose rebase conflicts is skipped and
   reported; the others are still updated, and a conflict is resolved by its
   author.

The rebased head arrives as a `synchronize` event. The existing concurrency
group of `pull-request-checks.yml`, keyed by workflow and pull-request number
with `cancel-in-progress: true`, cancels the superseded head's run. That run
ends cancelled, not failed, and the sensors exclude cancelled runs. The gate,
its three jobs (ADR-CHK-0007 rule 11), strict up-to-date protection, and the
single required check `devai-release-gate` are unchanged.

The Owner performs one effect, OE-02 of CMP-0007: enable
`allow_update_branch` on the repository and install the GitHub App with its
credential. No task performs it, and this record changes no setting.

## Consequences

A pull request no longer fails its gate because main moved: it is rebased
and re-gated instead. The only remaining main-moved failure is a run that
completed against a base that moved before the update workflow reacted.

A rebase update replays the pull request's commits, so their committer
becomes the update identity while their authorship is unchanged. A
provenance rule that requires committer to equal author therefore applies
to commits as their authors pushed them. After an update, a role session
re-establishes it by replaying its own commits, as the CMP-0007 replays did.
The commit grammar, the single-family rule, and the version-bump derivation
of ADR-REL-0027 are evaluated on the rebased commits and are unaffected.

## Alternatives Considered

The merge update method stays rejected for the reason ADR-CHK-0004 gives.
A merge queue was the alternative D2 did not choose; ADR-CHK-0004 still
governs it if it is ever enabled. Updating with `GITHUB_TOKEN` is rejected
because the rebased head would never be gated. Retrying a blocked
`base-up-to-date` probe is rejected as before: a retry reproduces the race.
Relying on the setting alone is rejected because nobody would press the
button for every open pull request on every merge.

## Affected Rules

- `.github/workflows/update-pull-request-branches.yml`: the push-to-main
  trigger, the rebase update with the expected head sha, the App-token
  credential, conflict reporting, and least-privilege permissions.
- `scripts/check-workflows.mjs`: pins for the trigger, the rebase method, the
  expected-head guard, the credential, and the permissions.
- `docs/dev/operations/remote-preflight-contract.md`: the update path and the
  exact Owner effect.

## Inspector Adversarial Acceptance

- IA-001 -- A push to main rebases every open, non-draft pull request against main that is behind it through the update-branch API with update_method rebase and the expected head sha, and no update ever creates a merge commit on a pull-request branch.
- IA-002 -- A pull request whose rebase conflicts is skipped and reported without failing the update of the others, and its gate run is neither started nor cancelled by the update workflow.
- IA-003 -- A rebased head started by the update workflow starts a gate run, because the push is made with a GitHub App installation token; an update made with GITHUB_TOKEN would start none and is refused by the workflow checker.
- IA-004 -- When the rebased head arrives while the previous head's gate is running, the per-pull-request concurrency group cancels the superseded run, which ends cancelled rather than failed and is excluded from harness_green_main.
- IA-005 -- scripts/check-workflows.mjs fails when the update workflow loses its push-to-main trigger, its rebase update method, its expected-head-sha guard, its App-token credential, or its least-privilege permissions, and strict up-to-date protection and the single required check devai-release-gate are unchanged.
