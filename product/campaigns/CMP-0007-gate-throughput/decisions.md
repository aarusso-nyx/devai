# CMP-0007 mandate, baseline and Owner decisions

This file is the mandate that `campaign.json` names. It records the baseline the campaign starts from, the decisions the Owner gave, and the acceptance window each round is measured over. It is a plan record: it grants no effect and changes no setting.

## Goal

Both gate cells of the self-scorecard read PASS:

- **F5:T7, gate speed:** the `harness_performance` sensor reads a median below 600 s.
- **F5:T9, gate pass rate:** the `harness_green_main` sensor reads at least 95% green.

Neither threshold and neither definition is relaxed to get there.

## Baseline

The baseline comes from a read-only analysis of `pull-request-checks.yml` runs for the 30 days to main `92526921`, from 2026-09-07T21:39Z to 2026-10-07T21:39Z.

How runs were counted:

- Only `pull_request` events, with only the latest attempt of each run.
- Cancelled and superseded runs are excluded (37 runs).
- 355 runs are counted in total; the scorecard's own window holds 268 of them.

| Cell  | Sensor                | Baseline                                                                                      | Target         |
| ----- | --------------------- | --------------------------------------------------------------------------------------------- | -------------- |
| F5:T7 | `harness_performance` | median 710 s over 308 successful runs (766 s in the scorecard window); p90 1032 s, p95 1059 s | median < 600 s |
| F5:T9 | `harness_green_main`  | 308 of 355 runs green, 86.8% (85.1% in the scorecard window)                                  | ≥ 95%          |

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

| #   | Question           | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How to parallelize | In-runner parallel workers first (R-0701 CTG-0712 under ADR-CHK-0007). Shard `test:cli` only if the median is still above 600 s. The fallback is triggered: the parallel runner alone measured a best of about 617 s on the 4-vCPU runner, so CTG-0713 splits the gate into a `test:cli` job, a rest job, and a `devai-release-gate` aggregator (ADR-CHK-0007 rule 11). Scheduling declarations live in `test-task-exclusivity.json`, never in `test-tasks.json`, so the bundled verifier and release export are unaffected (coordinator ruling of 2026-10-07 on the CMP-0007 review, ADR-CHK-0007 as amended). |
| D2  | Main-moved blocks  | Enable the auto-update branch (OE-02). The setting alone updates no pull request, so R-0702 adds TASK-0726: a workflow on push to main that rebases each open pull request through the update-branch API with `update_method: rebase`, so the superseded gate run is cancelled by the per-pull-request concurrency group. No merge queue, so no `merge_group` sensor change.                                                                                                                                                                                                                                    |
| D3  | Local preflight    | A pre-push preflight hook. It is mandatory in the agent contract and opt-in for humans.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D4  | F5:T9 definition   | Keep the current definition. R-0703 is recorded as deferred, to be revisited after the R-0702 window.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D5  | Release coupling   | Ship 2.3.0 when both cells read PASS (OE-03).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## Acceptance windows

A round's post-change window starts at the merge of its last implementing task.

- **Counted runs:** the window counts runs exactly as the sensors count them: `pull_request` events, latest attempt only, cancelled and superseded runs excluded.
- **Length:** the window closes after at least 30 counted runs, and no earlier than 7 days after it opens.
- **Readings:** the readings are those of `harness_performance` and `harness_green_main` recorded over the window.

| Round  | Accepted when                                                                                                                                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-0701 | `harness_performance` median < 600 s, and no planned node is dropped from any plan: in every window run, the node set of the report's `execution` array equals the plan's node set exactly, each node once, counting every disposition (`executed`, `reused`, `aborted`, and `blocked-environment`).                               |
| R-0702 | The window opens only after TASK-0726 merges and OE-02 is performed. Over the window: no main-moved failures, real-defect failures roughly halved against the baseline rate of 33 in 355 runs, and `harness_green_main` ≥ 95%. The no-main-moved claim holds only with TASK-0726 in force; without it the setting changes nothing. |
| R-0703 | Deferred under D4. It is never opened without a new Owner decision.                                                                                                                                                                                                                                                                |

## Owner effects

The plan only names these effects. No task performs them.

- **OE-01 is not used.** The campaign policy reserves that id for a merge queue, which D2 did not choose. Serialized admission therefore stays in force: at most one task pull request is in `pre_merge` at a time.
- **OE-02, before R-0702 closes:** the Owner enables the auto-update branch repository setting with the rebase update method, and provides the non-`GITHUB_TOKEN` credential the TASK-0726 workflow uses (a push made with `GITHUB_TOKEN` starts no gate run). This happens after TASK-0721 records how that fits ADR-CHK-0004.
- **OE-03, before R-0702 closes:** publication of 2.3.0. It requires both cells to read PASS on their windows and a separately authorized release.
