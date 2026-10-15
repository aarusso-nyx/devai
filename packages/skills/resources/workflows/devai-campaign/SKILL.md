---
name: devai-campaign
description: Status, planning and readiness for DEVAI campaigns, rounds and tasks in a DEVAI-governed repo (DEVAI, STYNX, DETRAN) — where things stand, what blocks, a grounded ETA, a campaign draft from open issues, or whether a round can close, seal or release.
license: Apache-2.0
compatibility: Needs the project-local @aarusso-nyx/devai package and the GitHub CLI for the plan route.
metadata:
  devai-status: stable
  devai-workflow-schema: '1'
---

# devai-campaign

First, collect read-only facts: `git rev-parse --show-toplevel`, `git remote get-url origin`, `git rev-parse --abbrev-ref HEAD`, `git rev-parse --short HEAD` and `git status --short`, then the live round state under `.devai/state/`: the rounds with runtime state (`.devai/state/round-runs/<round>/`), each round's live controller (`controller.json`) and dispatch journal (`dispatch-journal.jsonl`), and the task records (`.devai/state/tasks/<task>.json`). There is no single current-round pointer; name the round you report on. Run nothing that builds, tests or writes. If the collector fails, say so and continue with what you can read — never guess a HEAD, round id or candidate.

Pick one route from the request.

## status

Lead with stage, done, blocked, next action, with campaign → round → task identifiers. Keep implemented, tested, reviewed, merged, released, closed and sealed as separate states; a PASS in one says nothing about the others. Evidence is receipts, task reports, CI and closure records; a session summary is a lead, not proof. Do not run builds or validations to answer status — name the missing evidence. ETA from observed durations of comparable tasks in this campaign; a best/likely/worst range only when evidence supports one, otherwise the next bounded milestone and "full ETA not yet estimable". Never infer completion from token use or a percentage. Budget, when it matters: source, unit, window, usage, cap or waiver — never mixing cached input, output, provider quota and campaign accounting.

## plan

Fetch the complete requested issue set (paginate; record query time and ids) and inspect linked decisions, PRs and current plans. Coverage table: every issue → planned work | existing active round | duplicate/resolved (with evidence) | explicit deferral | blocked on an Owner or upstream decision. Group by outcome and dependency; order rounds by prerequisite and risk. Per task, only the fields the round runner consumes (`law/policy/round-execution.json`); unapproved architecture or Owner choices are marked _proposed_; settled decisions are preserved. Keep upstream DEVAI/STYNX changes and DETRAN adoption proofs separate. Drafting authorizes nothing: no issue-state changes, commits, dispatch or publication; revalidate the issue snapshot before execution.

## readiness

Name the endpoint: close, seal, merge, tag, release, or adopter-ready. Effect table: permitted now / candidate SHA or tree / prerequisites / protected approval remaining. Reconcile candidate identity, required checks, reviewer receipts, exports and version populations; run cheap deterministic preflight before long gates. A code-assessor verdict is evidence bound to its commit and rubric hash, never authorization; a stale or mismatched one is ignored. Keep closed, sealed, merged, tagged, published and adopted distinct; a close with transferred criteria keeps their real outcomes visible. Stop on a changed candidate or an unmet protected approval and name the exact blocked action.

## Decisions

When a route surfaces an unresolved Owner decision, present it with the host's question form: the concrete problem, mutually exclusive options, your recommendation, and what each option changes in behavior, scope, effort and effects. Record the literal answer in the campaign record when writing is authorized. Silence, a default, or time elapsed is not an answer.

Boundary: read-only unless the request authorizes a write through a DEVAI action. A readiness verdict is evidence, not permission.
