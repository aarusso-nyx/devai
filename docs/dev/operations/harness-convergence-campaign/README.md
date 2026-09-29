# Harness convergence campaign

The plan that implements the eleven flow records of the
[harness convergence proposals](../harness-convergence-proposals.md) lives at
[`product/campaigns/CMP-0003-harness-convergence/campaign.json`](../../../../product/campaigns/CMP-0003-harness-convergence/campaign.json).
Its structure is `law/schemas/campaign.schema.json`; its semantics are
`law/policy/campaign-execution.json`; the vocabulary, escalation, and the
round open and close procedures are those of the
[workflow economy campaign guide](../workflow-economy-campaign/README.md).
The sister campaign for observations and evidence is
[CMP-0004](../trustworthy-observations-campaign/README.md). This page is the
human guide: it records the diagnosis the campaign starts from and the
outcome each round must move.

The eleven records are ADR-CHK-0003, ADR-CFG-0002, ADR-GOV-0020, ADR-GOV-0022,
ADR-CHK-0004, ADR-GOV-0023, ADR-MDL-0002, ADR-MDL-0001, ADR-REL-0030,
ADR-REL-0032, and ADR-GOV-0021 under `law/adr/`, all proposed at the time of
writing. The Architect sets each round's records to accepted before that
round opens. The maintainer's ten decisions of 2026-09-28 are recorded in the
proposals document and bind every task.

## 1. Diagnosis (measured on 2026-09-28, main at `6add3383`)

| Fact                                                 | Value                                                                                                                        |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Pull-request gate runs, last 120                     | 98 success, 13 failure, 9 cancelled                                                                                          |
| Failures caused by the `base-up-to-date` probe       | 8 of 13, all on parallel task pull requests of R-0203 to R-0206 on 2026-09-27                                                |
| Pull requests closed as superseded by a combined one | 5 (#134 to #137 by #138; #147 by #148)                                                                                       |
| Gate duration, last 60 successful runs               | average 9.3 min, min 1.8 min (ledger-only), max 18.1 min                                                                     |
| Nodes a ledger-only pull request executes            | preflight, plan:validate, generate, build, format, lint, typecheck, test:schemas, release:static-integrity, release:closure  |
| Campaign check in the gate                           | never on a plan-only diff (`plan:validate` runs `journeys` only; `check-campaign.mjs` sits under `test:root`)                |
| Bootstrap compile before the DAG                     | `tsc -b --force` on every run (`scripts/process/bootstrap-check-runner.mjs`)                                                 |
| Branch protection on main                            | strict up-to-date, `devai-release-gate` required, linear history, admins enforced, no merge queue, `allow_update_branch` off |
| Environments with a reviewer                         | devai-ledger-verification, devai-rc-release, devai-rc-publication, github-pages (4 of 5)                                     |
| Environment stops per release                        | 3 on rehearsal, 1 on tag push, 4 on publication                                                                              |
| Model reply parsing                                  | bare `JSON.parse` in `judge.ts` and `triage.ts`; no schema, no repair, reply discarded on failure                            |
| Tier map                                             | same assignments copied in CMP-0001 and CMP-0002; names a Codex model that does not exist                                    |
| Instruction files                                    | `CLAUDE.md` stub; bootstrap writes both files byte-equal; `doctor` requires text DEVAI's own files lack                      |
| Claude Code on the maintainer host                   | 2.1.236 (native `AGENTS.md` reading is documented from 2.1.277)                                                              |
| Workflow documentation                               | three pages stale (three workflows, push-built release, `preflight-v1`); no information-architecture entry                   |
| Campaign policy status                               | `proposed` after governing two campaigns; Owner-effect closure not enforced (CMP-0002 closed with OE-01 unperformed)         |

Sources of the review: the repository at `6add3383`, `gh run list`, `gh api`
on branch protection and environments, and the hosts' published
documentation (Claude Code memory, skills, sub-agents, headless and model
pages; Codex AGENTS.md, skills, subagents, config reference, and models
pages), all read on 2026-09-28. The independent review by Codex is
summarized in the proposals document's reconciliation section.

## 2. Rounds and the outcome each must move

| Round  | Records                                  | Outcome                                                                                                                                  |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| R-0301 | ADR-CHK-0003                             | A ledger-only pull request executes the planning lane with the bootstrap restored from cache and the campaign check run; policy accepted |
| R-0302 | ADR-CFG-0002, ADR-GOV-0020               | Retired blocks leave the projection; `CLAUDE.md` is the import; guidance survives `--force`; recipe front matter converged               |
| R-0303 | ADR-GOV-0022                             | Recording eight receipts in one commit yields zero findings; deleting one yields one                                                     |
| R-0304 | ADR-CHK-0004                             | Two green pull requests from one base merge through the queue without a manual rebase (or the recorded serialized fallback)              |
| R-0305 | ADR-GOV-0023, ADR-MDL-0002, ADR-MDL-0001 | `review.mode` exists; the default tier map resolves and pins; prose around a valid verdict parses, an invalid one errors with a digest   |
| R-0306 | ADR-REL-0030, ADR-REL-0032               | Two stops on rehearsal, two on publication; a site-only re-run resumes its submitted record                                              |
| R-0307 | ADR-GOV-0021                             | One page per workflow under a completeness gate; generated ADR catalogue; stale statements corrected                                     |

## 3. Owner effects

| Effect | Before | What                                                                                                                         |
| ------ | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| OE-01  | R-0304 | Verify the merge queue supports rebase, linear history, and the required check; enable it, or record the serialized fallback |
| OE-02  | R-0306 | Reconfigure the environments to one reviewer stop each on the three release environments and none on `github-pages`          |
| OE-03  | R-0306 | Repoint `DEVAI_PROCESS_CONTROL_COMMIT` to an explicit reviewed SHA before the next rehearsal, and again after R-0306         |
| OE-04  | R-0306 | Reissue the Pages migration audit for the next tag                                                                           |
| OE-05  | R-0305 | Supply one rejected PASS review reply as the first fixture of ADR-MDL-0001                                                   |
| OE-06  | R-0307 | Raise every maintainer host to a Claude Code release that reads `AGENTS.md` natively                                         |

## 4. Running the campaign

Follow the workflow economy guide for opening rounds, running tasks, and
closing rounds. Two rules are specific to this campaign:

- Every prompt reads the proposals document's "Decisions taken by the
  maintainer" section; a task that finds a record and a decision in conflict
  stops and reports rather than choosing.
- R-0301 lands first and alone. Every later round's ledger commits use the
  planning lane it delivers; until then, ledger updates are batched per wave
  to keep gate runs few.

CMP-0004 depends on R-0301 and, where its prompts resolve tiers, on R-0305.

## 5. Owner decisions

Recorded on 2026-09-29, after R-0301 reached `closing` and R-0302 opened:

1. **One attestation.** The RC attestation is re-issued once, for the merged
   head at the end of the campaign, and covers every round whose tasks changed
   the task descriptor (R-0301, R-0304, R-0305). Those rounds stay `closing`
   until then; their implementation is in `main` and their close checks have
   run on their merged heads.
2. **OE-03 dates the CMP-0002 effect too.** CMP-0002's OE-01 (repoint
   `DEVAI_PROCESS_CONTROL_COMMIT`) is the same action as this campaign's
   OE-03; when OE-03 is performed, its date is recorded on both ledgers.
3. **Check-suite declaration at the R-0301 close.** The Architect declares the
   `campaign` and `scorecard-page` check services in
   `law/policy/check-suites.json` when R-0301 closes, so `check --only`
   reaches them.
4. **No release in this campaign.** Version rollover and publication are left
   to a later cycle; the campaign closes on `main` without a tag.

## 6. Round log

Recorded by the orchestrator as each round reached `closing` or `closed`.
Close checks are the campaign's standing set (`adrs`, `schemas`, `docs-links`,
`docs-governance`, `ci-economy`, `cli-reference`, `journeys`, `forbidden-actions`,
`format:check:all`, `action-registry:check`, `test:skills`, `test:cli`) run in a
detached worktree at the merged head after `pnpm run build` and
`pnpm run release:bootstrap`.

| Round  | Merged head | Pull requests | State                                                                                                                                   |
| ------ | ----------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| R-0301 | `e5cfdb77`  | #173, #176    | `closing`: waits for the single RC attestation (decision 1); check-suite declaration due at its close (decision 3)                      |
| R-0302 | `12d52fa5`  | #179, #181    | `closed`: close checks green on the merged head; `test-tasks.json` unchanged, so no attestation is owed                                 |
| R-0303 | `0a66e13a`  | #183          | `closed`: close checks green on the merged head (990 skills tests, 3480 CLI tests); the eight-receipt acceptance was proven in the wave |
| R-0304 | see ledger  | #188          | `closing`: waits for the single RC attestation and for OE-01 (queue enabled or the serialized fallback recorded)                        |

Backlog observed while closing R-0302 and R-0303, outside every task boundary:

- Three test nodes are load-sensitive and pass when run alone:
  `cli-shard09-verify-translation-c-overlay-boundaries`, the `test:skills`
  teardown (`ENOTEMPTY` on a temporary directory), and the check-runner
  timeout case. They deserve a fixture isolation task in a later campaign.
- The forbidden-actions scanner reports every campaign-ledger commit under
  `product/` and every policy commit under `law/` that the orchestrator
  authored with the Engineer commit identity (23 findings at `0a66e13a`). The
  scanner's author rule is right; the identity was wrong. From R-0305 on, the
  orchestrator signs ledger commits as `DEVAI Owner` and law commits as
  `DEVAI Architect`, and the Owner records receipts for the earlier findings
  at the campaign close.
