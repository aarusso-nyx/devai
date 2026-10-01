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

6. **ADR-EVI-0001 index shape (2026-10-01).** The record's Decision fixes the
   row (closure id, round, supersedes, `merged_as`, terminal) and the order
   (rounds by id, then supersession order); IA-005 asks for byte identity with
   DETRAN's own generator output, which is in Portuguese, has no terminal
   column, and is ordered by closure id. Both cannot hold. The Owner ruled that
   the Decision governs and IA-005 is met by the same rows and by sealing every
   round DETRAN sealed (R-0017 through PC-0018); DETRAN adopts the canonical
   rendering. `record/derived/indexes/README.md` is not written by hand
   (Constitution Article 6); the derived index is described on the
   `evidence render` reference page only. An amending record may restate IA-005.

7. **ADR-REL-0031 lands in the canonical verifier first (2026-10-01).** The
   Owner chose to change the canonical source `devai-nyx/devai-verifier`,
   merged as its pull request 12 (merge `097ef4a6`), and to re-vendor exactly
   commit `8b215d70`. Only the in-repository restatements of the vendored copy
   moved; the trusted-verifier pins move after the next release (step 4 of the
   repin order). A profile id containing a separator or a dot is
   `PROFILE_ID_INVALID`, decided by grammar alone.
8. **ADR-MUT-0013 (2026-10-01).** The re-vendor changed the manifest
   `mutation-evidence-v2` pins, so a new record advanced its approved source to
   `8b215d70`; the Owner accepted it as drafted and the policy and schema
   constants were repinned in the same wave, so no merged head carried a
   mutation refusal.
9. **The anchor baseline write (2026-10-01).** `evidence verify` stays `read`
   in the action registry. Without a baseline and without `--write` it fails
   `PROOF_ANCHOR_BASELINE_MISSING`; with `--write` the authority layer admits
   exactly `record/proofs/anchor-baseline.json`, as it gates
   `docs decisions render --out`. `record/proofs/README.md` is not edited by
   hand (Constitution Article 6).
10. **ADR-SCR-0010 fields (2026-10-01).** `gh run list` returns no base branch,
    workflow path, or jobs, and the record admits no other shape. Workflow,
    event, and head branch filter server side; attempts, cancelled runs, and the
    lookback filter on the rows; a job pair naming another workflow is excluded
    by construction; the base branch and a same-workflow job pair are reported
    unverified in the reading.

## 6. Round log

| Round  | Merged head | Pull requests                | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ----------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-0401 | `259197ac`  | #218, #219, #220, #221       | `closed` on 2026-10-01: wave CTG-0411 (ADR-AUT-0002, #155, #162) merged as #220 and wave CTG-0412 (ADR-SCR-0007, #156, #161) as #221; the #155 cause was the corepack `pnpm.js` shim missing the broker's basename match; `sense run build` and `sense run e2e_test` read PASS; close checks green on the merged head (`law:validate` runs as `check --only adrs`, as in CMP-0002); the database-gated RC closure passed on `259197ac` with task-policy digest `a33e4782`, recorded in the closure, and signing and export of its receipt stay the Owner's step |
| R-0402 | `24d869a2`  | #222, #224                   | `closed` on 2026-10-01: wave CTG-0421 (ADR-SCR-0008, #157 to #160) merged as #224; readings carry `supersedes`, `sense record` appends a digest-bearing chain entry and repairs a missing one, the sweep runs in two passes, the backlog has a schema and the post-merge hook reads the bound checkout store; the record pairs F4:T4 and F4:T9 with the sensors the other way round from the sensor registry, and the registry governs; close checks green on the merged head; no attestation re-issue                                                          |
| R-0403 | `839075e7`  | #223, #226, #227, #228, #229 | `closed` on 2026-10-01: CTG-0431 (ADR-EVI-0001, #169) as #226, CTG-0433 (ADR-REL-0031, #69, with ADR-MUT-0013) as #227, CTG-0432 (ADR-EVI-0002, #168) as #228; the DETRAN closures seal R-0017 through PC-0018 and the DETRAN proof baseline fails with its 52 orphans until an Architect declaration acknowledges them; close checks green on the merged head; no attestation re-issue                                                                                                                                                                         |
| R-0404 | `c0326aa9`  | #229, #230, #231             | `closed` on 2026-10-01: CTG-0441 (ADR-SCR-0010, #154) as #230, the harness sensors sample the declared gate population and read UNKNOWN below the minimum; CTG-0442 recorded SC-20261001T194346-001 at `c0681069` as #231 (PASS 35, REVIEW 4, FAIL 1, UNKNOWN 2, N/A 3, beside 31, 5, 3, 3, 3); close checks green on the merged head; no attestation re-issue                                                                                                                                                                                                  |

## 7. Second scorecard

The second self-scorecard `SC-20261001T194346-001` observes main at
`c06810699ee53f931d4426ef103ace922f829ab9` (`c0681069`, the merged head after
CTG-0441). It was taken on a fresh worktree with a clean tree, after
`pnpm install`, `pnpm run build`, `release:bootstrap`, and
`tsc -b packages/cli/tsconfig.typecheck.json`. The inspector followed the
ordered protocol of ADR-SCR-0008 and recorded every reading with
`sense record`:

1. The R-0404 `sweep` first pass (47 readings).
2. The write-effect readings the first scorecard carried, one kind at a time:
   `build`, `unit_test`, `integration_test`, `e2e_test`,
   `test_coverage_depth`, and `inventory_regeneration`.
3. The second pass (`harness_invariant_alignment`, `inventory_performance`).
4. `audit observe` at the head.

`migration_check` was not run. It needs a database, which OE-02 declines, so
F2:T4 reads UNKNOWN in both scorecards.

The harness sensors read the declared population of ADR-SCR-0010: 186 runs of
`pull-request-checks.yml` on `pull_request` in 30 days. That is above every
declared minimum, so no harness cell reads UNKNOWN for its sample. The
scorecard, assessment, and backlog are copied byte-exact beside the first
under `record/proofs/compliance/scorecards/`.

| Scorecard                | Head       | PASS | REVIEW | FAIL | UNKNOWN | N/A |
| ------------------------ | ---------- | ---- | ------ | ---- | ------- | --- |
| `SC-20260927T205906-001` | `86d8ccea` | 31   | 5      | 3    | 3       | 3   |
| `SC-20261001T194346-001` | `c0681069` | 35   | 4      | 1    | 2       | 3   |

Cells whose verdict changed:

| Cell  | Old → new      | Cause                                                                                                                                                                  |
| ----- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F5:T7 | FAIL → PASS    | ADR-SCR-0010 (#154): `harness_performance` samples the pull request gate population instead of branch `main`                                                           |
| F5:T8 | REVIEW → PASS  | ADR-SCR-0010 (#154): `harness_robustness` samples the same declared population                                                                                         |
| F5:T9 | FAIL → REVIEW  | ADR-SCR-0010 (#154): `harness_green_main` reads 159 of 186 runs green (85.5%), between the review threshold 80% and the pass threshold 95%                             |
| F4:T7 | REVIEW → PASS  | ADR-SCR-0008 (#158): `inventory_performance` runs in the second pass after the inventory readings are recorded; overall p95 986 ms against 2000 ms                     |
| F3:T1 | FAIL → PASS    | ADR-SCR-0007 (#156): `e2e_test` selects `tests/e2e` through `rc.e2e.config.ts`; `unit_test`, `integration_test`, and `e2e_test` all read PASS                          |
| F3:T2 | REVIEW → PASS  | ADR-SCR-0007 (#161): coverage measures the local population without a database; 91.66% of lines against the pass threshold 80%                                         |
| F2:T9 | UNKNOWN → PASS | ADR-AUT-0002 (#155): the broker admits `sense run build`, which reads PASS                                                                                             |
| F2:T6 | PASS → FAIL    | No CMP-0004 record: `pnpm audit` reports 8 high-severity advisories against the review threshold 5. Worse                                                              |
| F5:T3 | PASS → REVIEW  | No CMP-0004 record: `harness_coherence` finds `.github/workflows/site-publish.yml` (changed by `ea66b63d`) without a concurrency group that cancels in progress. Worse |

Two cells got worse, F2:T6 and F5:T3, and no CMP-0004 record caused either.

The F3:T2 reading needs a caveat. In the first pass, `test_coverage_depth`
read FAIL (`COVERAGE_PRODUCER_FAILED`, the local coverage producer exited 1).
The standalone run that followed it read PASS at the same head. Under
ADR-SCR-0008 the later instance governs the cell. The reading did not keep
enough output to name the cause of the first-pass exit, so the cell may be
order-sensitive or flaky.

Cells still not PASS:

| Cell                | Verdict | Measured reason                                                                                                                       |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| F2:T6               | FAIL    | 8 high-severity advisories exceed the review threshold 5                                                                              |
| F5:T3               | REVIEW  | `HARNESS_COHERENCE_CONCURRENCY_POLICY` on `site-publish.yml`                                                                          |
| F5:T4               | REVIEW  | `HARNESS_INVARIANT_ALIGNMENT_UNMEASURED_IN_CI`: INV-DEVAI-002 and INV-HARNESS-006 have no fail-closed CI step with candidate evidence |
| F5:T9               | REVIEW  | 85.5% green over 186 runs, below 95%; the base branch filter is reported unverified                                                   |
| F4:T9               | REVIEW  | `INVENTORY_REGENERATION_NO_KINDS_TOUCHED`: no inventory bodies were found to rebuild                                                  |
| F2:T4               | UNKNOWN | `migration_check` needs a database (OE-02); not run, as in the first scorecard                                                        |
| F4:T4               | UNKNOWN | `INVENTORY_ADHERENCE_INPUT_MISSING`: `.devai/state/inventory/inventory.json` is absent                                                |
| F1:T1, F4:T5, F4:T6 | N/A     | Unchanged declarations; F4:T6 cites the `rbac` surface declared absent                                                                |

## 8. Campaign close

CMP-0004 closed on 2026-10-01 at `c0326aa9`, with all four rounds closed and
both owner effects performed. Follow-ups outside the campaign:

- F2:T6 fails on eight high-severity dependency advisories, and F5:T3 reads
  REVIEW because `site-publish.yml` has no cancelling concurrency group; no
  CMP-0004 record caused either.
- The local coverage producer exited non-zero once inside the sweep
  (`release-lifecycle-execution.test.ts`) and passed standalone; the cause is
  open.
- `ROUND_PHASE_CLOSURE_UNRESOLVED` still matches the closure id as a substring
  of the rounds index; `evidence record` has no flag for the
  `UNANCHORED_NEWEST_LINE` recovery the library supports.
- After the next release, the trusted local-RC verifier is repinned (step 4 of
  the repin order), and the Owner signs and exports the R-0401 RC receipt
  before any release plan uses that head. DETRAN adopts the canonical rounds
  index.
