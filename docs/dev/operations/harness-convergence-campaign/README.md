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

| Round  | Records                                  | Outcome                                                                                                                                                                  |
| ------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R-0301 | ADR-CHK-0003                             | A ledger-only pull request executes the planning lane with the bootstrap restored from cache and the campaign check run; policy accepted                                 |
| R-0302 | ADR-CFG-0002, ADR-GOV-0020               | Retired blocks leave the projection; `CLAUDE.md` is the import; guidance survives `--force`; recipe front matter converged                                               |
| R-0303 | ADR-GOV-0022                             | Recording eight receipts in one commit yields zero findings; deleting one yields one                                                                                     |
| R-0304 | ADR-CHK-0004                             | Two green pull requests from one base merge through the queue without a manual rebase (or the recorded serialized fallback)                                              |
| R-0305 | ADR-GOV-0023, ADR-MDL-0002, ADR-MDL-0001 | `review.mode` exists; the default tier map resolves and pins; prose around a valid verdict parses, an invalid one errors with a digest                                   |
| R-0306 | ADR-REL-0030, ADR-REL-0032               | Two stops on rehearsal, two on publication; a site-only re-run resumes its submitted record                                                                              |
| R-0307 | ADR-GOV-0021                             | One page per workflow under a completeness gate; generated ADR catalogue; stale statements corrected                                                                     |
| R-0308 | ADR-SCR-0011, ADR-REL-0033, ADR-EVI-0003 | The sweep emits a schema-valid reading for every read kind; a packed candidate proves the scorecard route in a disposable adopter; `round status` reports a sealed round |
| R-0309 | ADR-CHK-0005                             | Every check member declares where it applies; a framework-only member reports `not-applicable` in an adopter, never an empty PASS or an ENOENT                           |
| R-0310 | ADR-CHK-0003, ADR-CHK-0004               | An Owner effect resolved by its fallback is recorded with `outcome: fallback`; the round that requires it closes while the checker keeps serialized admission in force   |

## 3. Owner effects

| Effect | Before | What                                                                                                                                                                                              |
| ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OE-01  | R-0304 | Verify the merge queue supports rebase, linear history, and the required check; enable it, or record the serialized fallback                                                                      |
| OE-02  | R-0306 | Reconfigure the environments to one reviewer stop each on the three release environments and none on `github-pages`                                                                               |
| OE-03  | R-0306 | Repoint `DEVAI_PROCESS_CONTROL_COMMIT` to an explicit reviewed SHA before the next rehearsal, and again after R-0306                                                                              |
| OE-04  | R-0306 | Reissue the Pages migration audit for the next tag                                                                                                                                                |
| OE-05  | R-0305 | Supply one rejected PASS review reply as the first fixture of ADR-MDL-0001                                                                                                                        |
| OE-06  | R-0307 | Raise every maintainer host to a Claude Code release that reads `AGENTS.md` natively                                                                                                              |
| OE-07  | R-0308 | Publish the immutable release that carries the ADR-SCR-0011 schema admission and the scorecard store resolver, from the exact packed artifact the rehearsal verified, and tell DETRAN the version |

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

5. **OE-01 resolved by the fallback.** On 2026-09-29 the Owner attempted to
   create a `main` ruleset with a rebase merge queue; the API refused the
   `merge_queue` rule because the repository is owned by a user account and
   GitHub offers merge queues only to organization-owned repositories. Per
   the effect's own text, the serialized-admission fallback of
   `law/policy/campaign-execution.json` (one pull request in `pre_merge` at a
   time, enforced by the campaign check since R-0304) is the recorded outcome;
   the `merge_group` trigger stays in the gate workflow for a future move to an
   organization. The ledger keeps OE-01 unperformed: the campaign checker and
   the serialized-admission contract test read `performed_at` on OE-01 as
   "the queue is enabled" and stop enforcing one pull request in `pre_merge`,
   which is the opposite of the fallback. R-0304 therefore stays `closing`
   until the ledger can express an effect resolved by its fallback (backlog).
6. **Extension for the adopter issues.** On 2026-09-29 the five DETRAN issues
   #184, #185, #175, #187, and #186 opened and matched no round of this
   campaign or of CMP-0004. The maintainer extended this campaign instead of
   opening a new one (pull request #197, merged as `dd5c3a69`): rounds R-0308
   and R-0309, four proposed records, and owner effect OE-07; #186 is
   deferred (section 7). OE-07 narrows decision 4: one immutable version is
   published after R-0308 because #185 needs a published package; no other
   tag or publication belongs to this campaign.
7. **Answers of 2026-09-30.** ADR-SCR-0011 keeps the five schema-only legacy
   values (`api_test`, `contract_validation`, `db_test`, `journey_test`,
   `mutation_test`) as legacy, because recorded readings may exist under them
   and ADR-SCR-0008 forbids rewriting a reading; ADR-CHK-0005 takes option A
   now and leaves option B to a later record. OE-05 is the PASS reply the
   evaluator returned for `90d5fc7d`, rejected by the Owner. #186 becomes a
   campaign of its own, proposed after R-0302, not a round of this one.
8. **OE-07 executed and R-0310 authorized (2026-09-30).** The Owner authorized
   the release that OE-07 names (rolled to 1.7.0, the bump floor since
   `v1.6.0` being `minor`) and a plan-and-law round, R-0310, that gives every
   Owner effect an `outcome` (`performed` or `fallback`) so the checker keeps
   serialized admission in force under the fallback while the round that
   requires the effect closes; OE-01 is recorded that way and R-0304 closed.

## 6. Round log

Recorded by the orchestrator as each round reached `closing` or `closed`.
Close checks are the campaign's standing set (`adrs`, `schemas`, `docs-links`,
`docs-governance`, `ci-economy`, `cli-reference`, `journeys`, `forbidden-actions`,
`format:check:all`, `action-registry:check`, `test:skills`, `test:cli`) run in a
detached worktree at the merged head after `pnpm run build` and
`pnpm run release:bootstrap`.

| Round  | Merged head | Pull requests    | State                                                                                                                                                                                                                                                                                                                  |
| ------ | ----------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-0301 | `e5cfdb77`  | #173, #176, #194 | `closed`: the check-suite declaration (decision 3) merged as #194 (`722cb5a6`) after the Owner accepted its broker widening; the single RC attestation ran on that head and its task-policy digest is in the closure                                                                                                   |
| R-0302 | `12d52fa5`  | #179, #181       | `closed`: close checks green on the merged head; `test-tasks.json` unchanged, so no attestation is owed                                                                                                                                                                                                                |
| R-0303 | `0a66e13a`  | #183             | `closed`: close checks green on the merged head (990 skills tests, 3480 CLI tests); the eight-receipt acceptance was proven in the wave                                                                                                                                                                                |
| R-0304 | `468de683`  | #188, #206       | `closed`: OE-01 recorded as `performed_at` with `outcome: fallback` once R-0310 landed (decision 8); the RC task-policy digest of the run on `722cb5a6` is in the closure                                                                                                                                              |
| R-0305 | `04b141fe`  | #189, #190, #191 | `closed`: review mode, the versioned tier default, pinned resolution, the shared reply extractor; the attestation is covered by the run on `722cb5a6`; OE-05 performed with the fixture `cmp-0003-rejected-pass.txt`                                                                                                   |
| R-0306 | `5eda694f`  | #192, #193       | `closed`: OE-02, OE-03, and OE-04 performed on 2026-09-29 (control commit `722cb5a6`; the audit for tag v1.6.0 reissued against it)                                                                                                                                                                                    |
| R-0307 | `90d5fc7d`  | #195             | `closed`: OE-06 performed (Claude Code 2.1.277); the three `FORBID-CI-WITHOUT-ADR` findings on its law commits carry Owner receipts in `law/policy/forbidden-action-authorizations.json`                                                                                                                               |
| R-0308 | `bda28a33`  | #199, #200, #201 | `closing`: the four adopter records accepted (#199); wave CTG-0382 (#175) merged as #200 and wave CTG-0381 (#184, #185) as #201; close checks green on the merged head (`schemas` pass, `test:sensors` 1124, `test:loop` 1052, `test:cli` 3510, `release:static-integrity` ok); waits for OE-07                        |
| R-0309 | `1587a0a9`  | #202, #203       | `closed`: wave CTG-0391 (#187) merged as #203; every member declares applicability, a self member reports `not-applicable` in an adopter, the repository kind comes from the binding receipt and fails closed when unbound; close checks green on the merged head (`schemas` pass, `docs-links` pass, `test:cli` 3557) |
| R-0310 | `b8c975f5`  | #206             | `closed`: wave CTG-03101 merged as #206 (schema `outcome`, policy 1.3.0, 28 contract cases, checker reads the outcome); close checks green on the merged head (`schemas` pass, `test:root` 946, campaign check ok)                                                                                                     |

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

Backlog observed while running R-0305, outside every task boundary:

- The Codex `--output-schema` path and OpenAI strict structured outputs may
  require every property in `required`; `review-verdict.schema.json` keeps
  `findings`, `file` and `line` optional and the bridge sends the governed
  schema unchanged. A live host run must confirm both hosts accept it before
  a campaign runs under `review.mode: model-advisory`.
- The `claude -p` envelope fields the bridge maps to a finish reason
  (`stop_reason`, `is_error`, `subtype`) come from the Inspector's fixtures and
  are not yet checked against a live CLI.
- A rejected tie-breaker reply now escalates with confidence 0 instead of the
  retired 0.5 midpoint; the calibration pages that quote the midpoint need a
  pass.
- `docs/reference/error-codes.md` is generated from the CLI, authority and
  utils sources only; the campaign checker's kebab-case codes and the loop's
  `TASK_REGISTRY_IDENTITY_MISMATCH` have no home there until the generator's
  scope widens.
- When the affected check fails in the gate, its JSON report is one long
  stdout line that the GitHub log does not show, so the failing node is only
  recoverable by a local reproduction (about ten minutes). The gate step
  should print a compact per-node summary on failure or upload the report as
  an artifact; a `ci` task for a later campaign.
- The two ledger-derived contract tests of TASK-0352 first read the live task
  states and broke as soon as the wave moved to `pre_merge`; they now build
  their fixtures from a normalized copy. A contract test never depends on the
  momentary state of a moving ledger.

Backlog observed while performing the Owner effects and the OE-05 experiment
(a live run of the review evaluator through the bridge transport on
2026-09-29, Claude Code 2.1.277), outside every task boundary:

- A `claude -p --json-schema` reply ends with `stop_reason: "tool_use"` and
  `terminal_reason: "completed"` while `structured_output` is present; the
  bridge's finish mapping (`is_error`, `max_tokens`, `tool_use`) would turn
  that envelope into `reply_provider_error`. The mapping must read a completed
  terminal reason with a structured output as `stop` before any campaign runs
  under `review.mode: model-advisory`; this also settles the R-0305 backlog
  item on unverified envelope fields.
- `--tools ''` does not disable the user's MCP servers: the evaluator used a
  code-index server over fourteen turns while reviewing. The bridge needs an
  explicit way to run the review without any MCP server, verified against the
  CLI reference, so that a review reads only the prompt it was given.
- The envelope's `result` string is not byte-identical to
  `JSON.stringify(structured_output)`; the bridge prefers the structured
  output when present, so the reply digest a task records depends on that
  choice. The fixture format of ADR-MDL-0001 must say which bytes it stores.
- The gate's bootstrap cache is unsafe on a hit. `bootstrap-check-runner.mjs`
  links the runner's `node_modules` to `packages/cli/node_modules`, so the
  cached `.devai/state/pr-bootstrap` holds the compiled runner and symlinks
  only; on a cache hit the workflow runs `pnpm install` and never builds the
  workspace packages, and the runner fails at import with
  `@devai-nyx/sensors/dist` missing. A hit needs a green run of the same pull
  request followed by a push that changes no key input, which first happened
  on #198 (run 36654220587, 2026-09-30); every earlier restore was a miss. The
  remedy was to delete the cache entry and rerun. The fix is a `ci` task under
  ADR-CHK-0003: cache the workspace `dist` outputs with the runner, or make
  the runner self-contained.
- Resolved by R-0310 (decision 8): an Owner effect had no outcome field. OE-01 was resolved by its fallback,
  but `performed_at` is the only state the schema offers, and both the
  campaign checker (`scripts/check-campaign.mjs`) and the contract test
  `tests/contract/campaign-plan.contract.test.ts` read it as "the merge queue
  is enabled" and stop enforcing serialized admission. The round-closure pull
  request first recorded OE-01 as performed and failed that test in the gate
  (`test:root`, three cases). The schema needs an `outcome` (`performed` or
  `fallback`) so a required effect can close its round without widening what
  the checker enforces; a `plan` and `law` task for a later round.
- The error-code generator scans only `packages/{cli,authority,utils}/src`, so
  the `RELEASE_PACKED_ADOPTER_*` codes of the rehearsal script and
  `SENSOR_KIND_NOT_IN_SCHEMA` of the schemas package cannot appear on the
  generated page; they are named on the pack-resolution page instead.
- `sense run --preset=<name>` is recognised only by the schema-admission
  refusal; the selection code still rejects the inline form with
  `SENSE_SELECTION_INVALID`. Pre-existing; decide whether the inline form is a
  supported selection.
- `action_effect_inference` emits no reading in a clean adopter (ENOENT on the
  framework's effects policy), so the packed sweep validates every emitted
  reading but cannot demand one from every member; R-0309 territory.
- Two more `test:cli` cases are load-sensitive when another suite runs
  concurrently (`authority-command-boundary-finalization`, the `check-runner`
  fifteen-second timeout); both pass alone. `package.json` is class
  `toolchain`, so a `ci(scripts)` commit that also adds a package script fails
  the commit-range probe (#201 needed a `build(package)` split).
- `attestation_reissue` is `true` only on R-0301 although decision 1 names
  R-0304 and R-0305 as descriptor-changing rounds; the closures of R-0301 and
  R-0304 carry the digest of the one run anyway. The campaign schema should
  say whether the flag marks the round that owes the attestation or every
  round the attestation covers.

State on 2026-09-30, after the round-closure commits were rebased onto the
extension (`dd5c3a69`): every task of R-0301 to R-0307 is `merged`; six rounds
are `closed` and R-0304 is `closing` (decision 5); R-0308 and R-0309 are
`planned`. OE-02 to OE-06 are recorded as performed and OE-01 stays
unperformed until R-0310 gave it `outcome: fallback`; R-0304, R-0309, and R-0310
closed on 2026-09-30; R-0308 waits for OE-07, whose release 1.7.0 rolled over
as #205 and entered rehearsal; OE-05 is the fixture
`tests/fixtures/review-replies/cmp-0003-rejected-pass.txt`, the `pass` reply
(confidence 0.83) the `claude-cli:opus` evaluator returned for `90d5fc7d`
through the bridge transport, which the Owner rejected on 2026-09-30; the
fixture stores the envelope's `result` bytes. The single RC attestation of decision 1 ran
on `722cb5a6`, the merged head after #194, with the database-gated profile
(733 files, 11303 tests); its task-policy digest `4d284d80` is in the closures
of R-0301 and R-0304, and signing and export of the receipt stay the Owner's
step outside the repository. On `90d5fc7d` the scanner reported three
`FORBID-CI-WITHOUT-ADR` findings on the three R-0307 law commits that cite
`.github/workflows/` paths inside the information architecture policy and
schema without touching a workflow file; the Owner's receipts for them are
recorded and the scanner now reports zero findings with three applied. The
close checks ran on `90d5fc7d` in a detached worktree; their result is
recorded in the round-closure pull request.

## 7. Extension: R-0308 and R-0309

The extension proposal
(`docs/dev/operations/harness-convergence-extension-proposal.md`) checked the
five adopter issues against the checkout and placed them; decision 6 adopted
it. Both rounds depend on R-0301, which is closed.

| Round  | Waves                                  | Records                                  | Closes after                                                                                                 |
| ------ | -------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| R-0308 | CTG-0381 (#184, #185), CTG-0382 (#175) | ADR-SCR-0011, ADR-REL-0033, ADR-EVI-0003 | `schemas`, `test:sensors`, `test:loop`, `test:cli`, `release:static-integrity` on the merged head, and OE-07 |
| R-0309 | CTG-0391 (#187)                        | ADR-CHK-0005                             | `schemas`, `test:cli`, `docs-links` on the merged head                                                       |

Each wave is a coupled triplet (architect, inspector, engineer) with prompts
TASK-0381 to TASK-0386 and TASK-0391 to TASK-0393, run per section 4. CTG-0382
does not depend on CTG-0381. TASK-0384 reproduces #175 on a sealed fixture
round before it documents anything; if the refusal does not reproduce on
`main`, the task reports blocked and ADR-EVI-0003 is revisited.

The four records bind nothing until the Architect sets them `accepted` before
R-0308 opens. Two decisions were open inside them; decision 7 answers both as
the drafts state:

1. **ADR-SCR-0011, the five schema-only legacy kind values.** The draft keeps
   them and lists them as legacy on the sensor-kinds reference, because
   readings recorded under them exist in adopter stores and ADR-SCR-0008
   forbids rewriting a recorded reading; retiring them would be a separate
   record.
2. **ADR-CHK-0005, option A or option B for `action-effects` and
   `cli-reference` in adopters.** The draft takes option A (a structured
   `not-applicable`), because DETRAN's Owner accepted explicit N/A and option
   B (a package-owned input mode) needs a decision on which package files are
   inputs; B stays open as a later record.

Acceptance changes the authority graph: the freeze test
`packages/schemas/tests/contract/governance-v15-adr.test.ts` lists the four
as effective authorities with their subject authorities, and the catalogue
`law/adr/README.md` is regenerated and re-pinned in
`law/policy/adr-validation.json`.

#186 (governed multi-stack path authority) is deferred. Article 6 decides
authority by a fixed path prefix of at most two segments and forbids a
wildcard rule with a default remainder; the class precedence the issue needs
(colocated `*.spec.*` files under `apps/**` to Inspector, DDL to Architect,
over an Engineer grant on the root) cannot be expressed in that table, and
Article 9 makes a change to Articles 6 to 10 a constitutional amendment with
a new version. Decision 7 makes it a campaign of its own, proposed after
ADR-CFG-0002 (R-0302) on which its materialization depends, starting from the
sketch in the extension proposal.

## 8. Release and close

On 2026-09-30 the Owner authorized OE-07 and round R-0311 and delegated every
environment approval through the final publication. The first rehearsals of
v1.7.0 exposed four defects, each fixed before publication: the shared
composite action cannot resolve in jobs that check out under a path (#208);
the committed descriptor used a selector kind the pinned 1.5.4 verifier does
not admit (R-0311, ADR-CHK-0006, #209); the repository-wide decision record
scan outgrew its 15 s test limit (#210); the release lint report was one log
line the runner dropped (#211); advisories published after v1.6.0 in the
documentation site needed the compatible fixes and new Owner waivers (#212);
and the installed smoke still expected a value ADR-CFG-0002 now retires (#213).
The RC attestation was re-issued on `da5253e1` (task-policy digest `95fc800e`),
its evidence published as an immutable bundle, and the rehearsal (run 36693375074) and publication (run 36693968122) passed. `v1.7.0` is a stable
release (`latest`) signed with the release tag key; OE-07 is performed,
R-0308 and R-0311 are closed, and the campaign is closed.
