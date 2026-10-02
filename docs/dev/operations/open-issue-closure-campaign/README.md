# CMP-0006 — complete open-issue closure

Status: accepted and prepared for fresh-session entry. All rounds/tasks remain planned; no implementation or external effect has started. Every round/task is planned; this bundle authorizes no worker execution or external effect.

The complete live snapshot contains 22 open issues (#233-#254). Five later Owner comments have been incorporated. There are 21 remediation/acceptance issues and one Owner not-planned disposition (#253); none is silently dropped.

Artifacts: [campaign ledger](../../../../product/campaigns/CMP-0006-open-issue-closure/campaign.json), [coverage map](../../../../product/campaigns/CMP-0006-open-issue-closure/coverage.md), [snapshot](../../../../product/campaigns/CMP-0006-open-issue-closure/issue-snapshot.json), [linked predecessor evidence](../../../../product/campaigns/CMP-0006-open-issue-closure/linked-evidence.json), [decision register](decision-register.md), [round/wave cards](rounds-and-waves.md), [source map](source-map.md), [closure register](closure-register.md), [revalidation](../../../../product/campaigns/CMP-0006-open-issue-closure/revalidation.json).

The bundle includes four Owner-accepted forward ADRs under law/adr, the regenerated catalogue and repinned catalogue digest, one hashed prompt per task plus a preamble, and concrete release, Pages, verifier-repin, live-review and DETRAN handoff templates.

| Round  | Goal                                                            | Depends on                             | Pending Owner effects |
| ------ | --------------------------------------------------------------- | -------------------------------------- | --------------------- |
| R-0601 | Ratify the contracts and settle dispositions                    | none                                   | OE-01                 |
| R-0602 | Remove security findings and make CI trustworthy                | R-0601                                 | none                  |
| R-0603 | Produce the inventory and stabilize observations                | R-0601, R-0602                         | none                  |
| R-0604 | Finish exact closure membership and crash recovery              | R-0601                                 | none                  |
| R-0605 | Align CLI refusals and complete the references                  | R-0601, R-0602, R-0603, R-0604, R-0606 | none                  |
| R-0606 | Prove the live review bridge                                    | R-0601                                 | OE-04                 |
| R-0607 | Prepare and authorize the shipping release and Pages deployment | R-0602, R-0603, R-0604, R-0605, R-0606 | OE-05, OE-06, OE-07   |
| R-0608 | Repin from the published artifact and prove adopter delivery    | R-0607                                 | OE-08, OE-09          |
| R-0609 | Verify issue closure and reconcile the final live backlog       | R-0608                                 | OE-10, OE-11          |

## Critical path and readiness

Primary implementation path: R-0601 → R-0602 → R-0603 → R-0605 → R-0607 → R-0608 → R-0609. R-0604 and R-0606 may progress after R-0601 only under authorized dispatch, disjoint scopes and all lock constraints; R-0605 also waits for both. Live hosts, release environments, Pages reconciliation and DETRAN response can dominate elapsed completion time. No completion date or numerical budget is defensible before those effects are scheduled.

Draft readiness: reviewable with complete issue coverage and executable offline validation vectors. Execution entry: the four record acceptances and recommended integration outcomes are recorded. The two-PR decision and scoped checkpoint procedure are recorded. Ready for fresh-session entry checks and task initiation; execution still requires the ordinary exact entry and effect gates. Closure readiness: blocked by all undischarged acceptance and Owner effects. All issues accounted for is not an all-executable promise.

## Resource and review proposal

Use the current repository architect tier/high for architectural sessions and worker-high/high for Inspector/Engineer sessions. A human may approve a smaller existing tier for a proven clerical-only task before dispatch and repin its prompt; no fixed models or numerical token/time budgets are introduced. The human sets caps for load/sweep, live model and RC experiments from current measurements. Escalation follows the pinned repository map. Reuse exact fresh evidence for untouched inputs, and preserve the unconditional floor.

Review mode is human throughout. Offline review-bridge tests and separately authorized live experiments do not delegate campaign gate ratification. No subagent or worker was dispatched to implement this campaign. Serialized one-PR-at-a-time admission remains the prior recorded fallback.

## Execution entry and closure

Before execution: fetch main; verify repo/branch/head/tree/clean task worktree; re-fetch all OPEN issues and each issue’s complete paginated comments; compare IDs, body digests, timestamps and comment IDs; reconcile arrivals/reopens or changed Owner decisions; verify the recorded scope/record acceptances and accepted two-PR discipline; freeze exact role paths, lock scopes, installed command support, generated outputs, predecessors and prompt hashes. Then use existing campaign-execution gates and optional materialization mapping. Never create runtime state by hand.

Task validations are staged affected checks, not permission for full RC runs. Existing/new focused Vitest paths are declared in prompts; new tests must be written by the Inspector before Engineer implementation. When a red Inspector counterexample depends on implementation, the human-initiated wave PR waits for the final Engineer acceptance; no red pre_merge gate is ratified.

Before closing: check every row against observed exact evidence; run universal round close checks and current issue/comment reconciliation; perform separately authorized receipt/release/Pages/repin/notification/adopter effects; record final Inspector observation through registered verbs; obtain exact GitHub issue-state authorization and close the original set with evidence. Reconcile new/reopened issues before an empty-backlog claim. No source change or green gate alone closes release or adopter issues.

Preserve the settled no-database decision, local coverage denominator, measured inventory applicability, accepted record bytes, vendor provenance and append-only historical proofs. Stop on source/main movement, undeclared path/process, unsupported command, policy drift or missing evidence. Replan narrowly; never waive #233 advisories, flip #237 to N/A or support #252 inline syntax contrary to the recorded Owner choices.

## Validation of this draft

See [validation results](../../../../product/campaigns/CMP-0006-open-issue-closure/validation.md) for the actual drafting checks. These validate artifacts and references, not implementation, release readiness, live providers, deployed Pages or DETRAN adoption.

The generated error reference must accompany its generator at final admission.
The Owner accepted separate role sessions and one combined reviewed candidate;
CTG-0624 supplies the bounded enforcement/generation support. See the
[integration contract](integration-contract.md), [candidate checkpoint register](checkpoint-register.md)
and [decision register](decision-register.md). The two-PR discipline is accepted: cumulative remediation first, then the
post-publication verifier repin. Main ancestry and release order remain intact.

Current scope is 9 rounds, 20 CTGs and 46 tasks; CTG-0624 adds three tasks to the
original 19-CTG/43-task draft. All rounds/tasks remain planned.

Final revalidation observes #253 already closed not_planned by aarusso-nyx at 2026-10-01T21:27:31Z, event 32290441966. Preserve that externally performed disposition; no duplicate issue-state effect is required. The original scope is 22 issues, and 21 remain open. All five later Owner comments, including the now-closed issue, are retained in the complete comment refresh.

Fresh-session entry: [self-contained handoff](fresh-session-handoff.md).
The two delivery PR populations and checkpoint/closure distinctions are fixed
in [integration-contract.md](integration-contract.md). No additional architectural
choice is pending before entry; conditional issue-specific and exact live/release/
deployment/notification/issue-state effect gates remain at their declared phases.
