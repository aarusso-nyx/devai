# Trustworthy observations campaign

The plan that implements the seven observation and evidence records of the
[harness convergence proposals](../harness-convergence-proposals.md) lives at
[`product/campaigns/CMP-0004-trustworthy-observations/campaign.json`](../../../../product/campaigns/CMP-0004-trustworthy-observations/campaign.json).
Its structure is `law/schemas/campaign.schema.json`; its semantics are
`law/policy/campaign-execution.json`; the vocabulary, escalation, and the
round open and close procedures are those of the
[workflow economy campaign guide](../workflow-economy-campaign/README.md).
The sister campaign for the development flow is
[CMP-0003](../harness-convergence-campaign/README.md); this campaign depends
on its R-0301 (the planning lane) and, where prompts resolve tiers, on its
R-0305. This page is the human guide: it records the diagnosis the campaign
starts from and the outcome each round must move.

The seven records are ADR-AUT-0002, ADR-SCR-0007, ADR-SCR-0008, ADR-EVI-0001,
ADR-EVI-0002, ADR-REL-0031, and ADR-SCR-0010 under `law/adr/`, all proposed at
the time of writing. The Architect sets each round's records to accepted
before that round opens.

## 1. Diagnosis (measured on 2026-09-28, main at `6add3383`)

The first self-scorecard `SC-20260927T205906-001` (head `86d8ccea`) read
PASS 31, REVIEW 5, FAIL 3, UNKNOWN 3, N/A 3. The cells below are the ones
whose verdict is an input, ordering, or declaration problem rather than a
plant defect; each is an open issue.

| Cell                | Reading            | Cause verified on main                                                                                      | Issue | Record       |
| ------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- | ----- | ------------ |
| F2:T4, F2:T9        | UNKNOWN            | `sense run build` refused although the broker admits `pnpm -r build` and the descriptor declares it         | #155  | ADR-AUT-0002 |
| site_drift          | UNKNOWN            | broker admits only `gh run list`; the Pages journal and deployments GET shapes are not admitted             | #162  | ADR-AUT-0002 |
| F3:T1               | FAIL               | e2e argv points at `local.config.ts`, whose includes exclude `tests/e2e`; `rc.e2e.config.ts` selects them   | #156  | ADR-SCR-0007 |
| F3:T2               | REVIEW             | only `test:coverage:rc` produces coverage and it needs a database; no database will be provided             | #161  | ADR-SCR-0007 |
| F5:T4               | REVIEW             | `sense record` writes no `sense.readings.record` chain entry that the alignment sensor counts               | #157  | ADR-SCR-0008 |
| F4:T7               | REVIEW             | `inventory_performance` is member 42 of 49 in a single-pass sweep, before any reading is recorded           | #158  | ADR-SCR-0008 |
| F4:T4, F4:T9        | UNKNOWN, REVIEW    | no applicability decision; regeneration covers `dep_graph` and `coverage` kinds that exist on the framework | #159  | ADR-SCR-0008 |
| backlog             | unvalidated        | no schema for the observation backlog; the hook resolves readings from the detached worktree                | #160  | ADR-SCR-0008 |
| F5:T7, F5:T8, F5:T9 | FAIL, REVIEW, FAIL | sensors sample branch `main` while the gate runs on pull requests; waiting runs dominate                    | #154  | ADR-SCR-0010 |

Two adopter reports from DETRAN and one against 1.4.5 complete the set: the
`rounds` renderer never writes the closure id that `round seal` requires
(#169, ADR-EVI-0001); chain verification never cross-checks the physical
proof lines, so 52 orphaned lines coexisted with a valid chain (#168,
ADR-EVI-0002); and the evidence exporter rejects a certify receipt built from
a release intent, forcing a second multi-hour verification run (#69,
ADR-REL-0031).

## 2. Rounds and the outcome each must move

| Round  | Records                                  | Outcome                                                                                                                               |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| R-0401 | ADR-AUT-0002, ADR-SCR-0007               | `sense run build` and `sense run site_drift` produce readings; e2e and coverage report measured outcomes, including FAIL              |
| R-0402 | ADR-SCR-0008                             | Ordered protocol on a fresh worktree yields substrate-reflecting readings for F4:T7 and F5:T4; the committed backlog validates        |
| R-0403 | ADR-EVI-0001, ADR-EVI-0002, ADR-REL-0031 | Superseding closures render and seal; the DETRAN baseline fails before its declaration and passes after; intent receipts export       |
| R-0404 | ADR-SCR-0010                             | Harness sensors declare their population and read UNKNOWN below the minimum sample; the second scorecard is recorded beside the first |

## 3. Owner effects

| Effect | Before | What                                                                                                         |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------ |
| OE-01  | R-0403 | Supply the DETRAN closures and the proof-line baseline as sanitized fixtures                                 |
| OE-02  | R-0401 | Provide no test database for the next scorecard (decided 2026-09-28); coverage measures the local population |

## 4. Running the campaign

Follow the workflow economy guide for opening rounds, running tasks, and
closing rounds. Three rules are specific to this campaign:

- Sensing tasks rebuild and run `pnpm run release:bootstrap` before any
  acceptance command that invokes `bin.js`, and copy the gitignored
  `.devai/config/authority-policy.json` from the bound checkout.
- Acceptance is a measured outcome, never a green score: a task that would
  need to edit a threshold, an override, or a reading to pass stops and
  reports.
- R-0404's second scorecard waits for the declared minimum sample on `main`;
  implementation closure of the other rounds does not wait for it.
