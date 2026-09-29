---
id: ADR-CHK-0004
title: Serialize integration through a merge queue gated on the queue candidate
type: adr
status: accepted
date: 2026-09-28
authority: Architect
supersedes: []
provenance:
  - ADR-CHK-0001
  - ADR-GOV-0018
  - ADR-GOV-0017
  - ADR-REL-0027
  - .github/workflows/pull-request-checks.yml
  - law/policy/campaign-execution.json
  - docs/dev/operations/harness-convergence-proposals.md
affected_rules:
  - .github/workflows/pull-request-checks.yml
  - scripts/check-workflows.mjs
  - scripts/run-pr-release-gate.mjs
  - law/policy/campaign-execution.json
  - docs/dev/operations/remote-preflight-contract.md
inspector_acceptance:
  - IA-001 -- Two green pull requests from the same base are both enqueued and both merge without a manual rebase, and the second queue run executes against the first's merged head.
  - IA-002 -- A queue run whose commit range fails the commit grammar evicts only its own entry with the diagnostic, returns that pull request to open, and leaves the entries behind it running.
  - IA-003 -- A `merge_group` run reports the check name `devai-release-gate` and takes `github.event.merge_group.base_sha` as its base, so branch protection needs no second required check.
  - IA-004 -- A workflow edit that removes the `merge_group` trigger or lets one queue entry cancel another fails `scripts/check-workflows.mjs`.
  - IA-005 -- A pull request whose own gate is red on its head is refused admission, and under the serialized fallback a second task pull request cannot enter `pre_merge` while one is already there.
---

# Serialized integration

## Status

Accepted on 2026-09-29 by the Architect before the round that implements it
opened; proposed on 2026-09-28 from the harness convergence brainstorm and its
independent review. Adds a second validation boundary
at queue admission beside the local preflight of ADR-CHK-0001, which it leaves
in force as the condition for opening a pull request.

## Context

The `base-up-to-date` probe and strict up-to-date branch protection work as
designed, and that is the problem. On 2026-09-27 the self-scorecard campaign
opened four or five task pull requests per round from one base; eight of the
thirteen gate failures in the last one hundred and twenty runs were that
probe, nine more runs were cancelled by superseding pushes, and five pull
requests were closed as superseded by a combined one. The repository has no
merge queue, `pull-request-checks.yml` has no `merge_group` trigger, and
`allow_update_branch` is off, so serialization is a discipline of the
orchestrator rather than a mechanism. The run counts and repository settings
were read through `gh` on 2026-09-28 and are recorded in the campaign guide;
they are not derivable from the checkout. The campaign policy already
forbids squash merges because they recombine single-family commits
(ADR-GOV-0018), and the commit grammar and version-bump derivation of
ADR-REL-0027 are evaluated over the pull request's commit range, so any
integration mechanism must test the exact commits that reach `main`.

## Decision

There are two validation boundaries. The local preflight against a named
fetched base stays the "ready for a pull request" condition, exactly as
ADR-CHK-0001 defines it, and integration validation runs against the queue
candidate rather than against the pull request head alone.

`pull-request-checks.yml` accepts `merge_group` in addition to
`pull_request`. Under `merge_group` the candidate is the queue's temporary
head, the base is `github.event.merge_group.base_sha`, the commit range is
base to head, and the check name `devai-release-gate` is identical to the
pull-request run, so branch protection keeps one required check. Concurrency
is keyed per queue entry, and no entry cancels another. The workflow checker
pins the trigger pair, the per-event base and candidate expressions, the
check name, and the concurrency rule.

Admission works as follows. A pull request enters the queue when its own gate
is green on its head. The queue rebases the entry onto the current tip and
re-runs the gate on the rebased candidate. A failed entry is evicted with its
diagnostic and the pull request returns to open without cancelling the entries
behind it. Because the merge method is rebase, the commits the queue tests are
the commits that reach `main`, so the commit grammar and version derivation
are evaluated on their final form.

One prerequisite is verified before the record closes: the merge queue must
support the rebase method together with linear history and the required
check. If it does not, the first delivery is serialized admission by the
orchestrator, which allows one open pull request in `pre_merge` at a time and
records that rule in `law/policy/campaign-execution.json`; the record then
states that the queue is deferred and why. `allow_update_branch` is a
convenience for the human, not a prerequisite of either delivery.

## Consequences

Two green task pull requests from one base merge in sequence without a manual
rebase, and the probe that produced most of the recent gate failures fires
only on a stale local preflight, which is what it was designed for. The gate
runs once more per merged pull request, on the queue candidate, and that run
is the one whose result is binding for `main`. Enabling the queue and its
rebase method is an Owner effect on the repository settings, recorded
separately. Under the fallback, campaign throughput drops to one integration
at a time, which is the throughput the orchestrator was already achieving by
hand.

## Alternatives Considered

Automatic retry of a blocked `base-up-to-date` probe is rejected: retrying a
stale candidate only reproduces the race it is meant to detect. Turning on
`allow_update_branch` and letting GitHub merge `main` into each branch is
rejected because a merge commit breaks linear history and the single-family
commit grammar. Combining several task pull requests into one, which happened
five times on 2026-09-27, is rejected as a standing practice because it loses
the one-task-one-pull-request binding of the campaign policy. Squash merging
in the queue is rejected by the campaign policy itself.

## Affected Rules

- `.github/workflows/pull-request-checks.yml`: the `merge_group` trigger, the
  per-event base and candidate, the check name, and the concurrency group.
- `scripts/check-workflows.mjs`: the pins for the new trigger and
  expressions.
- `scripts/run-pr-release-gate.mjs`: the base argument under `merge_group`.
- `law/policy/campaign-execution.json`: the queue admission rule, or the
  serialized-admission fallback if the prerequisite fails.
- `docs/dev/operations/remote-preflight-contract.md`: the two boundaries.

## Inspector Adversarial Acceptance

Open two green pull requests from the same base, enqueue both, and confirm
both merge with no manual rebase and that the second queue run's base is the
first's merged head. Enqueue an entry whose rebased range carries a commit
that fails the grammar and confirm only that entry is evicted, with its
diagnostic on the pull request, while the entry behind it completes. Inspect
a `merge_group` run and confirm the check name is `devai-release-gate` and
the base is the event's `base_sha`. Remove the `merge_group` trigger, or
change the concurrency group so one entry cancels another, and confirm the
workflow checker fails. Push a red head and confirm the queue refuses it; if
the fallback is in force, open a second task pull request while one is in
`pre_merge` and confirm the campaign check refuses the transition.
