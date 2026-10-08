---
id: ADR-SCR-0014
title: harness_green_main counts one gate outcome per pull request, on its final head
type: adr
status: accepted
date: 2026-10-08
authority: Architect
supersedes: []
provenance:
  - ADR-SCR-0010
  - ADR-SCR-0005
  - ADR-CHK-0004
  - ADR-CHK-0008
  - law/policy/sensor-notes/harness_green_main.md
affected_rules:
  - packages/sensors/src/harness-green-main.ts
  - packages/sensors/src/harness/gh-api.ts
  - law/schemas/sensor-inputs.schema.json
  - .devai/config/sensor-inputs.json
  - packages/cli/src/authority/broker.ts
  - law/policy/subprocess-effects.json
  - law/policy/sensor-notes/harness_green_main.md
  - docs/adopters/sensor-inputs.md
inspector_acceptance:
  - IA-001 -- A fixture with one pull request whose head was pushed five times, four red and the final head green, reads one green outcome under pull-request-final-head and five runs with one green under run.
  - IA-002 -- For a merged pull request the counted run is the latest completed gate run on its head at merge, for a closed or open one the latest completed run on its current head, and a cancelled or skipped run on that head is never the counted outcome.
  - IA-003 -- An open pull request whose current head has no completed gate run is excluded from the sample and the denominator, and a pull request whose only gate runs fall outside the thirty-day window is not sampled.
  - IA-004 -- A re-run counts only as its last attempt, merge_group runs and runs on other workflows or events never enter the sample, and the minimum sample counts pull requests, reading UNKNOWN below it.
  - IA-005 -- With twenty sampled pull requests and one red final outcome the reading is PASS at 95 percent, with two it is REVIEW, and a declaration that omits outcomeUnit keeps the run population of ADR-SCR-0010 unchanged.
  - IA-006 -- A pull request whose baseRefName is not the declared base is never sampled, and a run on a matching head branch and sha that was created before the pull request opened or after it closed is not its outcome, so a reused branch name never lends a run to another pull request.
  - IA-007 -- A run list or pull request list that returns as many entries as its literal limit of 1000 reads UNKNOWN as truncated with the limit in the finding, never PASS, REVIEW, or FAIL.
---

# harness_green_main counts one gate outcome per pull request

## Status

Accepted on 2026-10-08 by the Architect for campaign CMP-0007, round
R-0703. Owner decision D4 kept the F5:T9 definition on 2026-10-07 and
deferred R-0703; the Owner has now amended D4 and asked for the redefinition.
This record changes the population of `harness_green_main` only. Every other
part of ADR-SCR-0010 stays in force: the population declaration, the
`UNKNOWN` rule below the minimum, the broker grammar, and the populations of
`harness_performance` and `harness_robustness`. The thresholds are unchanged.

## Context

ADR-SCR-0010 samples every completed `pull_request` run of the gate in the
lookback window. Each push to a pull request therefore counts as one outcome.
The thirty days to main 92526921 held 355 counted runs for 207 branches.
Of those branches, 203 ended green, yet 47 runs failed, and 33 of the
failures were real defects caught while the author was still iterating.

Some of that iteration is required. Article 24 asks for test-first commits
that are red by design until the implementation lands. A per-run rate
measures how often authors push unfinished work, not whether the gate passes
the candidates that reach `main`. ADR-CHK-0008 makes it worse: every rebase
update starts one more run per open pull request.

## Decision

The `harness_green_main` declaration in `.devai/config/sensor-inputs.json`
gains `outcomeUnit`, validated by `law/schemas/sensor-inputs.schema.json`.

- **`run`** is the ADR-SCR-0010 population, one outcome per counted run. It
  is the default, so an adopter declaration without the field reads as
  before.
- **`pull-request-final-head`** counts one outcome per pull request. The
  framework declares it.

Under `pull-request-final-head`:

1. **Which pull requests.** Every pull request whose `baseRefName` equals
   the declared base branch, with at least one gate run of the declared
   workflow and event created in the lookback window: merged, closed without
   merge, and open.
2. **Final head.** For a merged pull request, the head commit at merge. For
   an open or closed pull request, its current head.
3. **Counted run.** The latest completed gate run on the final head: a run
   whose conclusion is neither `cancelled` nor `skipped`. A re-run counts as
   its last attempt. A run belongs to a pull request only when its head
   branch and sha match the final head and it was created while the pull
   request was open: at or after `createdAt`, and at or before `closedAt`,
   or now for an open pull request. The pull requests come from
   `gh pr list --state all` (`baseRefName`, `closedAt`, `createdAt`,
   `headRefName`, `headRefOid`, `mergedAt`, `number`, `state`), and the
   window's runs from the gate's run list (`headBranch`, `headSha`,
   `createdAt`).
4. **Green.** The counted run concluded `success`. Any other completed
   conclusion is not green.
5. **Exclusions.** An open pull request whose final head has no completed
   run yet is excluded from the sample and the denominator. `merge_group`
   runs stay out of scope, as do runs of other workflows or events.
6. **Minimum and verdict.** The minimum sample counts pull requests. Below it
   the reading is `UNKNOWN`, as ADR-SCR-0010 states. A run list or pull
   request list that returns as many entries as its literal limit of 1000
   may have been cut, so it also reads `UNKNOWN`, as truncated. At or above it, 95
   percent or more green reads PASS, 80 to below 95 percent reads REVIEW,
   and below 80 percent reads FAIL.

The reading's `metrics` name the outcome unit beside the rest of the
population, so a scorecard reader sees which definition produced the
number. Reading the final head of each pull request needs one more
read-only `gh` shape. The broker admits it with an exact grammar, and
`law/policy/subprocess-effects.json` mirrors it, as ADR-SCR-0005 requires.

## Consequences

F5:T9 measures the gate's outcome per candidate. A pull request that went
red on a test-first commit and green on its final head counts once, as
green. A pull request merged or abandoned on a red head counts once, as red.
Per-push noise no longer counts: Article 24 red-first commits, superseded
heads, and the extra runs that rebase updates start.

Closed pull requests stay in the population on purpose: excluding them
would hide gate failures on abandoned candidates. On 2026-10-08 the window
held 220 sampled pull requests, of which 216 were green on their final head,
98.2 percent. The four red final heads are all closed without merge: #135,
#136, #137, and #147.

The number is not comparable with readings made under the run population.
The scorecard names the unit in its metrics, and the next scorecard notes
the change of definition beside its delta.

Clarified on 2026-10-08 after 2.3.0 carried this record, for #364 and #365,
without changing its decision. Membership requires the pull request's base
branch, a run belongs to a pull request only within its open interval, and
a list that reaches its literal limit reads `UNKNOWN` as truncated. The
`gh pr list` fields gain `baseRefName` and `createdAt`. IA-006 and IA-007
cover the clarifications. The population of
`harness_performance` (F5:T7) and of `harness_robustness` (F5:T8) is
unchanged, because a duration or a retry is a property of each run.

## Alternatives Considered

Counting `merge_group` runs is rejected for now: no merge queue is enabled
(decision D2), so the population would be empty. Counting only merged pull
requests is rejected because a pull request abandoned on a red head is a
gate outcome too. Excluding the first push of each pull request is rejected
because it hides real first-push defects and keeps the remaining iteration
noise. Lowering the threshold is rejected by the CMP-0007 mandate: neither a
threshold nor the gate is relaxed, only what the cell counts.

## Affected Rules

- `packages/sensors/src/harness-green-main.ts` implements the
  `pull-request-final-head` unit.
- `packages/sensors/src/harness/gh-api.ts` reads the final head of each
  pull request.
- `law/schemas/sensor-inputs.schema.json` adds `outcomeUnit`, and
  `.devai/config/sensor-inputs.json` declares `pull-request-final-head` for
  the framework.
- `packages/cli/src/authority/broker.ts` and
  `law/policy/subprocess-effects.json` admit the added read-only `gh` shape.
- `law/policy/sensor-notes/harness_green_main.md` and
  `docs/adopters/sensor-inputs.md` describe the unit.

## Inspector Adversarial Acceptance

- IA-001 -- A fixture with one pull request whose head was pushed five times, four red and the final head green, reads one green outcome under pull-request-final-head and five runs with one green under run.
- IA-002 -- For a merged pull request the counted run is the latest completed gate run on its head at merge, for a closed or open one the latest completed run on its current head, and a cancelled or skipped run on that head is never the counted outcome.
- IA-003 -- An open pull request whose current head has no completed gate run is excluded from the sample and the denominator, and a pull request whose only gate runs fall outside the thirty-day window is not sampled.
- IA-004 -- A re-run counts only as its last attempt, merge_group runs and runs on other workflows or events never enter the sample, and the minimum sample counts pull requests, reading UNKNOWN below it.
- IA-005 -- With twenty sampled pull requests and one red final outcome the reading is PASS at 95 percent, with two it is REVIEW, and a declaration that omits outcomeUnit keeps the run population of ADR-SCR-0010 unchanged.
- IA-006 -- A pull request whose baseRefName is not the declared base is never sampled, and a run on a matching head branch and sha that was created before the pull request opened or after it closed is not its outcome, so a reused branch name never lends a run to another pull request.
- IA-007 -- A run list or pull request list that returns as many entries as its literal limit of 1000 reads UNKNOWN as truncated with the limit in the finding, never PASS, REVIEW, or FAIL.
