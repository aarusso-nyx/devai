# CMP-0007 mandate, baseline and Owner decisions

This file is the mandate that `campaign.json` names. It records the baseline the campaign starts from, the decisions the Owner gave, and the acceptance window each round is measured over. It is a plan record: it grants no effect and changes no setting.

## Goal

Both gate cells of the self-scorecard read PASS:

- **F5:T7, gate speed:** the `harness_performance` sensor reads a median below 900 s (D6; 600 s until 2026-10-08).
- **F5:T9, gate pass rate:** the `harness_green_main` sensor reads at least 95% green (over the final-head gate run of each pull request since D4 was amended on 2026-10-08).

Neither definition is relaxed to get there. The F5:T7 PASS median was moved from 600 s to 900 s by the Owner in D6; no other threshold changed.

## Baseline

The baseline comes from a read-only analysis of `pull-request-checks.yml` runs for the 30 days to main `92526921`, from 2026-09-07T21:39Z to 2026-10-07T21:39Z.

How runs were counted:

- Only `pull_request` events, with only the latest attempt of each run.
- Cancelled and superseded runs are excluded (37 runs).
- 355 runs are counted in total; the scorecard's own window holds 268 of them.

| Cell  | Sensor                | Baseline                                                                                      | Target                           |
| ----- | --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------- |
| F5:T7 | `harness_performance` | median 710 s over 308 successful runs (766 s in the scorecard window); p90 1032 s, p95 1059 s | median < 900 s (D6; was < 600 s) |
| F5:T9 | `harness_green_main`  | 308 of 355 runs green, 86.8% (85.1% in the scorecard window)                                  | ≥ 95%                            |

### Where the time goes

- **Queue time is negligible:** median 3 s, p95 39 s.
- **The affected-checks step dominates:** median 725 s.
  - Install, bootstrap and probes together take about 25 s.
- **The check runner executes nodes one at a time** (`packages/cli/src/services/check-runner/runner.ts`).
  - `test:cli` is 58% of job time, with a median of 339 s and a p90 of 564 s. It executes in 90% of plans.
  - The next largest nodes are `test:root` (56 s), `test:loop` (51 s), `test:sensors` (31 s) and `format` (28 s).
- **The gate median has risen as suites grew:** 435 s early in the window, 540 s in the middle, 814 s since 2026-09-30.
- **Most task executions do not reuse a cached result:** 291 cache misses and 50 protected-namespace recaptures, against 40 fresh reuses.
- **Replaying the measured node timings:**
  - serial as today: median 625 s;
  - `test:cli` in a parallel lane: median 344 s, p95 609 s;
  - `test:cli` sharded across two jobs with the rest serial: median 432 s, p95 719 s.

### Why runs fail

The window holds 47 failed runs.

| Cause                                                          | Runs | Share |
| -------------------------------------------------------------- | ---- | ----- |
| Real defect: test, lint or type                                | 25   | 53%   |
| Real defect: commit grammar                                    | 6    | 13%   |
| Real defect: another preflight probe or the workflow script    | 2    | 4%    |
| Main moved: `base-up-to-date` BLOCKED                          | 13   | 28%   |
| Infrastructure: bootstrap cache restored without `dist` (#247) | 1    | 2%    |
| Flaky or timeout                                               | 0    | 0%    |

- **The gate works as intended:** 203 of 207 branches end green.
- **Reaching 95% needs at most 17 failures in 355 runs.**
  - Removing every main-moved and infrastructure failure still leaves 33 failures, which is about 90.7%.
  - F5:T9 therefore reaches PASS only if fewer real defects reach CI.
- **Branch protection at the baseline:**
  - strict up-to-date is on;
  - there is no merge queue;
  - `allow_update_branch` is off.

## Owner decisions

The Owner approved every recommendation of the CMP-0007 scope draft on 2026-10-07. The approval was given in the orchestrating session and relayed to the Architect in the W21 brief of the same day.

| #   | Question           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | How to parallelize | In-runner parallel workers first (R-0701 CTG-0712 under ADR-CHK-0007). Shard `test:cli` only if the median is still at or above 600 s. CTG-0713 is the partitioned gate of ADR-CHK-0007 rule 11: a `test:cli` job, a rest job, and a `devai-release-gate` aggregator. **Amended by the Owner on 2026-10-07:** "start the job split now". The decision was relayed by the coordinator. It overrides the precondition that the post-merge median is still at or above 600 s, so CTG-0713 is ready now. Evidence: the gate jobs of the parallel runner (#352) took 549 s (run 37716291070) and 798 s (run 37718529421), too variable to rely on parallelism alone. W22 had earlier measured a best case of about 617 s. Scheduling declarations live in `test-task-exclusivity.json`, never in `test-tasks.json`, so the bundled verifier and release export are unaffected (coordinator ruling of 2026-10-07 on the CMP-0007 review, ADR-CHK-0007 as amended). |
| D2  | Main-moved blocks  | Enable the auto-update branch (OE-02). The setting alone updates no pull request, so R-0702 adds TASK-0726: a workflow on push to main that rebases each open pull request through the update-branch API with `update_method: rebase`, so the superseded gate run is cancelled by the per-pull-request concurrency group. No merge queue, so no `merge_group` sensor change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D3  | Local preflight    | A pre-push preflight hook. It is mandatory in the agent contract and opt-in for humans.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D4  | F5:T9 definition   | Keep the current definition. R-0703 is recorded as deferred, to be revisited after the R-0702 window. **Amended by the Owner on 2026-10-08:** "Redefine F5:T9 now (R-0703)". The decision was relayed by the coordinator. F5:T9 now measures the gate outcome on each pull request's final head instead of every push, and R-0703 is open. Evidence: the 30-day window reads 86.4% green per push (330 of 382), against about 98% over per-pull-request final heads. Since 2026-10-06, the Article 24 test-first pushes alone run at 85.5% green, which is iteration noise rather than gate outcome. The 95% threshold is unchanged.                                                                                                                                                                                                                                                                                                                         |
| D5  | Release coupling   | Ship 2.3.0 when both cells read PASS (OE-03).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| D6  | F5:T7 target       | **Owner decision of 2026-10-08:** "Adjust target to 900s". The decision was relayed by the coordinator. The F5:T7 PASS threshold becomes median < 900 s; p95 stays < 1800 s, and the REVIEW bounds (median < 1200 s, p95 < 3600 s) are unchanged. Evidence: the first split-gate run (37723347222) took 664 s in gate-cli and 682 s of wall time, because `test:cli` alone takes about 595 s now that its CPU work has nearly doubled since September (the coordinator's test:cli profile). CTG-0717 carries the change into the target record, the sensor default and its tests.                                                                                                                                                                                                                                                                                                                                                                            |

## Acceptance windows

A round's post-change window starts at the merge of its last implementing task.

- **Counted runs:** the window counts runs exactly as the sensors count them: `pull_request` events, latest attempt only, cancelled and superseded runs excluded.
- **Length:** the window closes after at least 30 counted runs, and no earlier than 7 days after it opens.
- **Readings:** the readings are those of `harness_performance` and `harness_green_main` recorded over the window.

| Round  | Accepted when                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-0701 | `harness_performance` median < 900 s (D6), and no planned node is dropped from any plan: in every window run, each report's `execution` array holds one entry per planned node in plan order, each node once, counting every disposition (`executed`, `reused`, `aborted`, `blocked-environment`, and `partitioned-out`). An unpartitioned run has no `partitioned-out` entry. For a partitioned run (ADR-CHK-0007 rule 11, if CTG-0713 proceeds), ownership is assessed across the report pair: both reports carry the same plan, candidate, base and digests, every planned node is owned in exactly one report and is `partitioned-out` or `prerequisite` in the other, and every owned entry is a PASS. |
| R-0702 | The window opens only after TASK-0726 merges and OE-02 is performed. Over the window: no main-moved failures, real-defect failures roughly halved against the baseline rate of 33 in 355 runs, and `harness_green_main` ≥ 95%. The no-main-moved claim holds only with TASK-0726 in force; without it the setting changes nothing.                                                                                                                                                                                                                                                                                                                                                                          |
| R-0703 | Opened by the amended D4 on 2026-10-08. Accepted when CTG-0731 merges and `harness_green_main` reads ≥ 95% over the final-head gate run of each pull request in the window, with the same window rules as above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Delivery record

- **CTG-0711 delivered out of order.** PR #353 (merge 8514f91a) delivered the whole triplet, TASK-0711, TASK-0712 and TASK-0713, in one pull request. Its commit order was Architect, then Engineer, then Inspector: the roster commit (`feat(schemas)`, TASK-0713) landed before the schema contract tests (`test(schemas)`, TASK-0712). The plan keeps `upstream_task_id` in the Article 24 order Architect, Inspector, Engineer. Every later triplet of this campaign follows that order, in separate pull requests.
- **TASK-0711 boundary.** PR #353 also bound `test-task-exclusivity.json` to the ci change class in `law/policy/adopter-defaults/change-taxonomy-binding.json` and `.devai/config/change-taxonomy-binding.json`. Both paths are now in the TASK-0711 boundary.
- **Known gap, not resolved here:** `.devai/config/change-taxonomy-binding.json` is an adopter-owned binding (`packages/cli/src/services/interactive-config.ts` lists it). It is seeded at bind time, and no init action writes it afterwards, so it was edited by hand. That conflicts with Article 6 write authority. It is recorded for a later decision.

## D5 measurement and release decision

- **Delivered:**
  - #363 (merge e96b261e) delivered CTG-0726: TASK-07210, TASK-07211 and TASK-0726.
  - #366 (merge e43e8db9) delivered R-0703's CTG-0731: TASK-0731, TASK-0732 and TASK-0733.
- **Readings on main e43e8db9, 2026-10-08T17:39Z:**
  - F5:T9, `harness_green_main` (reading SR-30aa1c53e9b96427): PASS. 121 of 121 final heads are green under the final-head unit of the amended D4.
  - F5:T7, `harness_performance` (reading SR-116466b6a1b2df0b): PASS. The median is 786 s, below the 900 s target of D6.
- **D5 is satisfied.** Both cells read PASS, so 2.3.0 ships under D5. The coordinator directed the release on 2026-10-08. Publication (OE-03) still needs its separately authorized release from an exact candidate.
- **OE-02 performed on 2026-10-08:** the coordinator enabled `allow_update_branch` on the Owner's instruction ("Do what need to close CMP-0007 yourself"). The update-branch App credentials remain Owner-only.
- **Previously Owner-pending:** OE-02 (the auto-update branch setting and the update credential) and the live update-branch check on a real pull request. The release does not wait for them, and R-0702 does not close until they are done.
- **Round acceptance stays separate.** These readings are the D5 measurement. Each round's post-change window under Acceptance windows is still assessed on its own before that round closes.
- **Follow-up wave CTG-0732 in R-0703** (TASK-0734 to TASK-0736) addresses both issues below.
- **Follow-ups:** #364 (`harness_green_main`: run list `--limit 300` truncates the 30-day window) and #365 (final-head unit: verify the pull request's base branch and identity).

## Campaign close

CMP-0007 closed on 2026-10-08, with both cells reading PASS: F5:T7 at a median of 786 s (SR-116466b6a1b2df0b) and F5:T9 at 121 of 121 final heads (SR-30aa1c53e9b96427).

- **Release:** v2.3.0 was published at 2026-10-08T18:30:07Z from candidate bf9a2616, in run 37825188722 ("Rehearse or promote DEVAI release"). The consumer install pins landed in #368 (merge 873f1372). OE-03 is performed.
- **OE-02:** `allow_update_branch` was enabled on 2026-10-08. The update-branch App credentials remain Owner-only.
- **Update branch:** live update-branch check waived by coordinator ruling under the Owner's 2026-10-08 instruction "Do what need to close CMP-0007 yourself": the update-branch App credentials, which remain Owner-only, were not provided before close. Partial evidence: the update workflow fired on the push of #371 to main (run 37850122108, success) and degraded to its credentials-absent notice as designed, rebasing no pull request. The App setup and a live rebase remain an Owner follow-up outside this campaign.
- **Not delivered:** cache persistence (TASK-07110, TASK-07111) is cancelled by coordinator ruling under the Owner's 2026-10-08 instruction "Do what need to close CMP-0007 yourself", because F5:T7 reads PASS without it (median 786 s < 900 s).
- **Rounds:** R-0701, R-0702 and R-0703 are closed. Their dispositions are in `campaign.json`.

## Owner effects

The plan only names these effects. No task performs them.

- **OE-01 is not used.** The campaign policy reserves that id for a merge queue, which D2 did not choose. Serialized admission therefore stays in force: at most one task pull request is in `pre_merge` at a time.
- **OE-02, before R-0702 closes:** the Owner enables the auto-update branch repository setting with the rebase update method, and provides the non-`GITHUB_TOKEN` credential the TASK-0726 workflow uses (a push made with `GITHUB_TOKEN` starts no gate run). This happens after TASK-0721 records how that fits ADR-CHK-0004.
- **OE-03, before R-0702 closes:** publication of 2.3.0. It requires both cells to read PASS on their windows and a separately authorized release.
