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
ADR-EVI-0002, ADR-REL-0031, and ADR-SCR-0010 under `law/adr/`. All seven were
accepted as drafted on 2026-10-01 after the Owner's decisions in section 5.

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

## 5. Owner decisions

1. **Records accepted as drafted.** The Owner accepted ADR-AUT-0002 and
   ADR-SCR-0007 on 2026-09-30, and ADR-SCR-0008, ADR-EVI-0001, ADR-EVI-0002,
   ADR-REL-0031, and ADR-SCR-0010 on 2026-10-01, each without change. The
   Architect set all seven to accepted before R-0401 opened.
2. **Broker admission approved.** On 2026-09-30 the Owner explicitly approved
   every broker and subprocess admission the seven records declare: the two
   `gh api` Pages GET shapes and the build precedence of ADR-AUT-0002, the two
   governed vitest configurations of ADR-SCR-0007, and the declared shapes of
   the later rounds. A widening that no record declares still stops the task.
3. **OE-01 source.** The Owner authorized reading the DETRAN repository with
   `gh` to assemble the OE-01 fixtures: the phase closures and the rendered
   rounds index for ADR-EVI-0001, and the proof lines, the chain, and the
   R-0020 contract with the line digests for ADR-EVI-0002. Fixture bytes are
   copied unchanged; a credential or absolute host path in them stops the
   copy and returns to the Owner, because removing it would change the line
   digests the verification checks.
4. **OE-01 performed with one waiver (2026-10-01).** The fixtures are under
   `tests/fixtures/closures/detran/` and `tests/fixtures/proof-baseline/detran-r0020/`,
   each with a `PROVENANCE.md` naming the DETRAN commit and the digest of every
   file. The copied baseline reproduces 119 lines, 67 anchored and 52 orphaned.
   The DETRAN chain records carry absolute host paths in `context.repo_root`,
   which feed their manifest hashes; the Owner waived the host-path clause for
   that file so the fixture stays DETRAN's real chain. No credential was found.
5. **site_drift with an unverified journal (2026-10-01).** A well-formed
   `gh-pages` tip is not provenance on its own: when the journal holds no
   verified record, or no intent for the declared repository, `site_drift`
   reads REVIEW with that journal reason. The ruling landed with wave CTG-0411.

## 6. Round log

| Round  | Merged head | Pull requests          | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ----------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-0401 | `259197ac`  | #218, #219, #220, #221 | `closed` on 2026-10-01: wave CTG-0411 (ADR-AUT-0002, #155, #162) merged as #220 and wave CTG-0412 (ADR-SCR-0007, #156, #161) as #221; the #155 cause was the corepack `pnpm.js` shim missing the broker's basename match; `sense run build` and `sense run e2e_test` read PASS; close checks green on the merged head (`law:validate` runs as `check --only adrs`, as in CMP-0002); the database-gated RC closure passed on `259197ac` with task-policy digest `a33e4782`, recorded in the closure, and signing and export of its receipt stay the Owner's step |
| R-0402 | `24d869a2`  | #222, #224             | `closed` on 2026-10-01: wave CTG-0421 (ADR-SCR-0008, #157 to #160) merged as #224; readings carry `supersedes`, `sense record` appends a digest-bearing chain entry and repairs a missing one, the sweep runs in two passes, the backlog has a schema and the post-merge hook reads the bound checkout store; the record pairs F4:T4 and F4:T9 with the sensors the other way round from the sensor registry, and the registry governs; close checks green on the merged head; no attestation re-issue                                                          |
| R-0403 | —           | —                      | `open` on 2026-10-01 alongside R-0402 (it depends only on R-0401); TASK-0431 and TASK-0437 in progress                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
