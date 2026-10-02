# CMP-0006 — complete open-issue closure

Status: source campaign active under the [standing Owner execution decision](execution-discipline.md). Six source checkpoints are ratified; TASK-0624 is committed pending acceptance under that mandate after central review. Completed contributions are integrated locally; no main merge, formal round closure or publication is claimed.

The complete live snapshot contains 22 open issues (#233-#254). Five later Owner comments have been incorporated. There are 21 remediation/acceptance issues and one Owner not-planned disposition (#253); none is silently dropped.

Artifacts: [campaign ledger](../../../../product/campaigns/CMP-0006-open-issue-closure/campaign.json), [coverage map](../../../../product/campaigns/CMP-0006-open-issue-closure/coverage.md), [snapshot](../../../../product/campaigns/CMP-0006-open-issue-closure/issue-snapshot.json), [linked predecessor evidence](../../../../product/campaigns/CMP-0006-open-issue-closure/linked-evidence.json), [decision register](decision-register.md), [round/wave cards](rounds-and-waves.md), [source map](source-map.md), [closure register](closure-register.md), [revalidation](../../../../product/campaigns/CMP-0006-open-issue-closure/revalidation.json).

The bundle includes four Owner-accepted forward ADRs under law/adr, the regenerated catalogue and repinned catalogue digest, one hashed prompt per task plus a preamble, and concrete release, Pages, verifier-repin, live-review and DETRAN handoff templates.

| Round  | Goal                                                            | Depends on                             | Required actual effects |
| ------ | --------------------------------------------------------------- | -------------------------------------- | ----------------------- |
| R-0601 | Ratify the contracts and settle dispositions                    | none                                   | OE-01–OE-03 recorded    |
| R-0602 | Remove security findings and make CI trustworthy                | R-0601                                 | none                    |
| R-0603 | Produce the inventory and stabilize observations                | R-0601, R-0602                         | none                    |
| R-0604 | Finish exact closure membership and crash recovery              | R-0601                                 | none                    |
| R-0605 | Align CLI refusals and complete the references                  | R-0601, R-0602, R-0603, R-0604, R-0606 | none                    |
| R-0606 | Prove the live review bridge                                    | R-0601                                 | OE-04                   |
| R-0607 | Prepare and authorize the shipping release and Pages deployment | R-0602, R-0603, R-0604, R-0605, R-0606 | OE-05, OE-06, OE-07     |
| R-0608 | Repin from the published artifact and prove adopter delivery    | R-0607                                 | OE-08, OE-09            |
| R-0609 | Verify issue closure and reconcile the final live backlog       | R-0608                                 | OE-10, OE-11            |

## Critical path and readiness

Primary implementation path: R-0601 → R-0602 → R-0603 → R-0605 → R-0607 → R-0608 → R-0609. R-0604 and R-0606 may progress after R-0601 only under authorized dispatch, disjoint scopes and all lock constraints; R-0605 also waits for both. Live hosts, release environments, Pages reconciliation and DETRAN response can dominate elapsed completion time. No completion date or numerical budget is defensible before those effects are scheduled.

Draft readiness: reviewable with complete issue coverage and executable offline validation vectors. Execution entry: the four record acceptances and recommended integration outcomes are recorded. The two-PR decision and scoped checkpoint procedure are recorded. Ready for fresh-session entry checks and task initiation; execution still requires the ordinary exact entry and effect gates. Closure readiness: blocked by all undischarged acceptance and Owner effects. All issues accounted for is not an all-executable promise.

## Resource and review discipline

Eight Architect round chats cover R-0602–R-0609 under the Devai project. At most
three rounds execute concurrently, with at most three active agents per round
including the coordinator, reviewers and nested workers. Initial active rounds
are R-0602, R-0604 and R-0606. Remaining chats register and become idle until the
central coordinator grants a permit with an exact candidate. Original dependencies
and complete wave locks determine the next eligible round; the priority queue is
R-0603, R-0605, R-0607, R-0608, R-0609.

Separate-role workers and designated round/central coordination messages are
authorized. Routine proposals, commits, within-campaign amendments and checkpoints
proceed after distinct review under standing Owner authority. Only the central
coordinator integrates cumulative PR branches. Campaign review.mode remains human;
the scoped source procedure does not change runtime autonomy or proof semantics.
Actual executor identity and original tier pins stay distinct; default desktop
source-authoring models are permitted without registry-conformity claims.
Costly load/live/RC work uses concrete bounded plans. Preserve the unconditional
floor, every failure, and serialized one-PR-at-a-time admission.

## Execution entry and closure

Before execution: fetch main; verify repo/branch/head/tree/clean task worktree; re-fetch all OPEN issues and each issue’s complete paginated comments; compare IDs, body digests, timestamps and comment IDs; reconcile arrivals/reopens or changed Owner decisions; verify the recorded scope/record acceptances and accepted two-PR discipline; freeze exact role paths, lock scopes, installed command support, generated outputs, predecessors and prompt hashes. Then use existing campaign-execution gates and optional materialization mapping. Never create runtime state by hand.

Task validations use staged affected checks; necessary full RC runs are authorized under the standing mandate with a concrete bounded exact-candidate plan. Existing/new focused Vitest paths are declared in prompts; new tests must be written by the Inspector before Engineer implementation. When a red Inspector counterexample depends on implementation, the human-initiated wave PR waits for the final Engineer acceptance; no red pre_merge gate is ratified.

Before closing: check every row against observed exact evidence; run universal round close checks and current issue/comment reconciliation; perform authorized receipt/release/Pages/repin/notification/adopter effects with concrete exact single-use records and observed receipts; record final Inspector observation through registered verbs; record concrete GitHub issue-state effects under the standing mandate and close the original set with verified evidence. Reconcile new/reopened issues before an empty-backlog claim. No source change or green gate alone closes release or adopter issues.

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
original 19-CTG/43-task draft. Current source checkpoints are recorded in checkpoint-register.md; no formal closure is inferred.

Final revalidation observes #253 already closed not_planned by aarusso-nyx at 2026-10-01T21:27:31Z, event 32290441966. Preserve that externally performed disposition; no duplicate issue-state effect is required. The original scope is 22 issues, and 21 remain open. All five later Owner comments, including the now-closed issue, are retained in the complete comment refresh.

Fresh-session entry: [self-contained handoff](fresh-session-handoff.md).
The two delivery PR populations and checkpoint/closure distinctions are fixed
in [integration-contract.md](integration-contract.md). Routine permission stops are superseded. TASK-0624 Pages/soft-gate proposals and
provider isolation remain substantive work; exact live/release/deployment/adopter
and final observation gates retain their declared phase order.
