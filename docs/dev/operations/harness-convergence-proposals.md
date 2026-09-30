# Harness convergence proposals

Status: proposed decision set from the 2026-09-28 maintainer brainstorm,
extended with the eighteen GitHub issues open on that date, and reconciled with
an independent review by OpenAI Codex (`gpt-6-astra`, reasoning effort high,
read-only sandbox over this checkout, 2026-09-28), whose findings are kept
outside the repository and summarized in the reconciliation section below.
Every record below is `proposed`; none binds until accepted under Architect
authority, and the repository-setting and environment changes are separate
Owner effects. The record files named here do not exist yet; the slugs are the
intended paths. The ten questions the review raised were answered by the
maintainer on 2026-09-28; the last section records the answers and every record
reflects them.

## Root cause observed

The workflow economy campaign (CMP-0001) made plan-only pull requests cheap but
not free: a ledger-only pull request still executes the unconditional floor of
the `affected` profile (`generate`, `build`, `format`, `lint`, `typecheck`,
`test:schemas`, `release:static-integrity`, `release:closure`), and before the
DAG even starts the workflow compiles the check runner from the checkout with
`tsc -b --force` (`scripts/process/bootstrap-check-runner.mjs`). The one check
that a plan change actually needs, `scripts/check-campaign.mjs`, does not run on
that path because `plan:validate` executes only the `journeys` member and the
campaign contract test lives under `test:root`, whose selectors exclude
`product/`. The `class` selector that ADR-GOV-0017 introduced has zero uses in
`test-tasks.json`, `work/` is bound in neither the descriptor nor the
materialized taxonomy binding, and the `plan` class spans all of `product/` and
`record/`, including the scorecards that `generate` consumes. The `docs` class
lists `docs-governance` as a member, yet `docs:validate` runs only
`cli-reference`, and the check fails on the framework itself because
`.devai/config/project.json` declares neither `repo.kind` nor `docs.builder`.
The gate also invokes the affected run twice, once inside `release:pr-gate`
and once directly.

The `base-up-to-date` probe and strict up-to-date protection work as designed,
and that is the problem: on 2026-09-27 the self-scorecard campaign opened four
or five task pull requests per round from one base, and eight of the thirteen
gate failures in the last one hundred and twenty runs were that probe. Nine more
runs were cancelled by superseding pushes, and five pull requests were closed as
superseded by a combined one. The repository has no merge queue, the
pull-request workflow has no `merge_group` trigger, and `allow_update_branch`
is off, so serialization is a discipline of the orchestrator rather than a
mechanism. (Run counts and repository settings were read through `gh` on
2026-09-28 and are recorded in the campaign guide, not derivable from the
checkout.)

Model-evaluated replies are parsed by a bare `JSON.parse` over the whole text
in the `llm_judge` sensor and in the triage tie-breaker, after a first look at
a provider `json` field that only the OpenAI adapter ever fills (`json_object`
mode, not a schema). The two consumers expect different documents (`verdict`
versus `classification`); on a parse failure the judge emits an `error`
reading that the scorecard maps to FAIL, and the tie-breaker returns
`inconclusive` and escalates. Neither keeps the reply, neither CLI bridge asks
the host for schema-constrained output, and both CLI bridges report
`finish_reason: stop` unconditionally.

The model tier map (`architect`, `worker-high`, `worker`, `clerk`) carries the
same host assignments in CMP-0001 and CMP-0002 with no default under
`law/policy`, and it names a Codex model that does not exist. `AGENTS.md` is
the single contract, yet `CLAUDE.md` is a stub the adopter bootstrap writes as
a byte-equal copy, the `doctor` check requires both files to carry text that
DEVAI's own files do not carry, the seven recipes are projected as duplicate
trees into `.claude/skills` and `.agents/skills`, and the recipe installer
refuses symlinks by design. Three operations pages describe the CI as three
workflows, a push-built release, or a `preflight-v1` node, none of which is
true today, and the documentation information architecture has no page for
the workflows at all. The campaign execution policy that governs all of this
still carries `status: proposed`, and the campaign checker verifies that an
Owner effect names a round but not that it was performed before that round
closed: CMP-0002 closed with OE-01 unperformed.

The first self-scorecard (`SC-20260927T205906-001`) left ten cells unmeasured
or failing for reasons that are inputs, ordering, or missing declarations
rather than plant defects: the build sensor is refused although the broker
admits `pnpm -r build` and `test-tasks.json` declares it, the broker admits no
`gh api` GET for the Pages journal, the declared e2e configuration covers no
`tests/e2e` file although `tests/config/rc.e2e.config.ts` selects them,
coverage exists only behind the database-gated RC lane, `sense record` writes
no chain entry that the alignment sensor would count, the sweep runs
`inventory_performance` as member 42 of 49 before any reading is recorded, the
observation backlog has no schema, and two inventory cells have no
applicability decision. Four adopter reports against 1.4.5 are unchanged in
1.6.0: the forbidden-actions scanner excludes the authorization registry from
the patch inspection but not from the name-status inspection, so recording a
receipt is itself a finding; the adopter-policy projection deep-merges the
current `project.json` with the overrides, so a retired block never leaves;
`init apply --force` overwrites `AGENTS.md` and `CLAUDE.md` while planning them
as `skip-exists`; and the evidence exporter derives the expected task policy
from a descriptor profile only, so a certify receipt built from a release
intent is rejected. Two adopter reports from DETRAN show that `round seal`
requires a phase-closure id that the `rounds` renderer never writes into
`record/derived/indexes/rounds.md`, and that `evidence verify --scope chain`
verifies sequence, links, hashes, and head but never the physical proof lines
the anchors point at.

## Open issues

Verified against `main` at `6add3383` on 2026-09-28. Issue #153 (ledger
verification on manual dispatch only) closed on 2026-09-27; no other open issue
is already resolved.

| Issue | State on main                                                                                                                                                                                                               | Disposition                                                                                |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| #187  | `adapters-reports.ts:114` forces `scope: 'self'`; `action-effects` and `cli-reference` read framework policy and catalogue paths beneath the adopter root                                                                   | New: ADR-CHK-0005 (R-0309)                                                                 |
| #186  | `adopter-policy.schema.json` is closed and has no authority rule source; Article 6 decides by a fixed two-segment prefix and forbids wildcard rules                                                                         | Deferred: a future AUT record, see the extension proposal and the campaign guide section 7 |
| #185  | `268bb838` routes `audit scorecard` through `resolveScorecardInputs` on `main`; the published v1.6.0 still reads `record/proofs/freshness/readings`                                                                         | New: ADR-REL-0033 (R-0308); publication is OE-07                                           |
| #184  | Four read kinds of the `sweep` preset are absent from the `sensor-reading.schema.json` enum; five enum values name no registry entry                                                                                        | New: ADR-SCR-0011 (R-0308)                                                                 |
| #175  | `round/workflow.ts` calls `governedRoundStatus` and then `roundTaskStatus` unconditionally; not yet reproduced on `main`                                                                                                    | New: ADR-EVI-0003 (R-0308, reproduce first)                                                |
| #169  | `round seal` requires the closure id in `rounds.md`; the `rounds` renderer concatenates round-record bodies and ignores closures                                                                                            | New: ADR-EVI-0001                                                                          |
| #168  | `verifyChain` checks sequence, links, hashes, head; no line-level cross-check of `record/proofs/work/**/*.jsonl`                                                                                                            | New: ADR-EVI-0002                                                                          |
| #167  | `docs-governance.no-ci-publish` remediation still says CI does not publish the site; the matcher is a substring test for three action names, none present in the workflows                                                  | Overlap: ADR-CHK-0003 (wording), ADR-GOV-0021 (adopter page)                               |
| #166  | `project.json` declares no `repo.kind` or `docs.builder`; `docs-governance` is a docs-class member but `docs:validate` runs only `cli-reference`                                                                            | Overlap: ADR-CHK-0003                                                                      |
| #165  | `publish-site.mjs` binds `sourceAttempt` to `GITHUB_RUN_ATTEMPT`; the journal refuses an unmatched unresolved identity; an `intent` record with unknown submission fails closed by design                                   | New: ADR-REL-0032                                                                          |
| #162  | Item 1 broker admits only `gh run list`; item 2 control commit is `f5bd9d17`, main is `6add3383`; item 4 the binding pins `32cb…3d20` for `scorecard-na.json`, the file is `a7ee…88a2`; item 5 `law/adr/README.md` is stale | Items 1: ADR-AUT-0002; 2, 3: Owner effects; 4: ADR-CFG-0002; 5: ADR-GOV-0021               |
| #161  | Only `test:coverage:rc` produces coverage and it is database-gated                                                                                                                                                          | New: ADR-SCR-0007                                                                          |
| #160  | No schema for the observation backlog; the hook resolver receives the detached worktree root                                                                                                                                | New: ADR-SCR-0008                                                                          |
| #159  | `scorecard-na.json` declares only F1:T1 and F4:T5; regeneration also covers `dep_graph` and `coverage` kinds                                                                                                                | Merged into ADR-SCR-0008 as an applicability analysis                                      |
| #158  | `inventory_performance` is member 42 of 49 in a single-pass sweep; reading ids omit timestamp but recording compares the whole object                                                                                       | New: ADR-SCR-0008                                                                          |
| #157  | `sense record` writes only the reading file; alignment searches the chain for `sense.readings.record`                                                                                                                       | New: ADR-SCR-0008                                                                          |
| #156  | The declared e2e argv points at `local.config.ts`, whose includes exclude `tests/e2e`; `rc.e2e.config.ts` exists and selects them                                                                                           | New: ADR-SCR-0007                                                                          |
| #155  | Broker admits `pnpm -r build` under `sense run`; `test-tasks.json` declares that argv; the refusal has an unreproduced cause                                                                                                | New: ADR-AUT-0002 (reproduce first)                                                        |
| #154  | One run on `main` since the push trigger was dropped; sensors sample branch `main`, the gate runs on pull requests                                                                                                          | New: ADR-SCR-0010                                                                          |
| #70   | Bootstrap plans `AGENTS.md` and `CLAUDE.md` as `skip-exists`; `--force` overwrites them; execution reports overwritten paths separately                                                                                     | Overlap: ADR-GOV-0020                                                                      |
| #69   | `policy-builder.js` resolves a profile id only and throws `PROFILE_UNKNOWN`; no release-intent path exists                                                                                                                  | New: ADR-REL-0031                                                                          |
| #68   | `adopter-policy.ts` deep-merges the current `project.json` with the overrides; `reconcileProjectConfig` also preserves declarations                                                                                         | New: ADR-CFG-0002                                                                          |
| #67   | `scan.ts` excludes the registry from `git diff` only; the `diff-tree --name-status` pass still synthesizes `git add law/...`                                                                                                | New: ADR-GOV-0022                                                                          |

## Decision records

| Record                                                                               | Decides                                                                                          |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| ADR-CHK-0003 (`law/adr/ADR-CHK-0003-planning-lane-and-semantic-validation.md`)       | A narrow planning lane with complete semantic validation; docs governance wired and reconciled   |
| ADR-CFG-0002 (`law/adr/ADR-CFG-0002-owned-configuration-projection.md`)              | `init bind` owns the blocks it projects; absent means retired; atomic receipts                   |
| ADR-GOV-0020 (`law/adr/ADR-GOV-0020-canonical-instructions-and-host-projections.md`) | `AGENTS.md` canonical; `CLAUDE.md` an import; guidance preserved; one recipe source, generated   |
| ADR-GOV-0022 (`law/adr/ADR-GOV-0022-authorization-registry-maintenance.md`)          | Validated registry maintenance produces no recursive finding; everything else still does         |
| ADR-CHK-0004 (`law/adr/ADR-CHK-0004-serialized-integration.md`)                      | Local preflight against a fetched base plus queue admission with explicit eviction semantics     |
| ADR-GOV-0023 (`law/adr/ADR-GOV-0023-review-boundaries.md`)                           | Which review steps a campaign may delegate to a model and which stay human                       |
| ADR-MDL-0001 (`law/adr/ADR-MDL-0001-structured-review-contracts.md`)                 | Consumer-specific reply schemas, one shared extractor, bounded diagnostics                       |
| ADR-MDL-0002 (`law/adr/ADR-MDL-0002-versioned-model-defaults.md`)                    | A repository default tier map, campaign overrides by reference, resolution pinned at task start  |
| ADR-REL-0030 (`law/adr/ADR-REL-0030-release-approval-topology.md`)                   | One stop per environment per run, from a complete job and credential matrix                      |
| ADR-REL-0032 (`law/adr/ADR-REL-0032-pages-rerun-identity.md`)                        | A site-only re-run resumes a submitted or verified record; an unknown submission stays closed    |
| ADR-AUT-0002 (`law/adr/ADR-AUT-0002-sensing-process-admission.md`)                   | Exact admission for the build sensor and the two Pages `gh api` GET shapes                       |
| ADR-SCR-0007 (`law/adr/ADR-SCR-0007-e2e-and-bounded-coverage.md`)                    | The governed e2e configuration and a database-free coverage producer with a declared denominator |
| ADR-SCR-0008 (`law/adr/ADR-SCR-0008-immutable-readings-and-recording-order.md`)      | Reading identity and supersession, recording order, backlog schema, cell applicability           |
| ADR-SCR-0010 (`law/adr/ADR-SCR-0010-ci-sampling-contract.md`)                        | Which runs the harness sensors sample and what an insufficient sample reads                      |
| ADR-REL-0031 (`law/adr/ADR-REL-0031-export-reconstructs-intent-policy.md`)           | The exporter reconstructs the expected task policy from the pinned release intent                |
| ADR-EVI-0001 (`law/adr/ADR-EVI-0001-canonical-closure-index.md`)                     | The rounds index is rendered from phase closures; the seal checks exact membership               |
| ADR-EVI-0002 (`law/adr/ADR-EVI-0002-proof-line-anchoring.md`)                        | Chain verification cross-checks every proof line; historical gaps are declared, never restored   |
| ADR-GOV-0021 (`law/adr/ADR-GOV-0021-workflow-reference-pages.md`)                    | One reference page per admitted workflow, a generated ADR catalogue, recovery paths documented   |

### ADR-CHK-0003: planning lane and semantic validation

- The planning population is the whole `plan` class: a pull request whose
  changed paths all classify as `plan` (`product/`, `record/`, `work/`) takes
  the planning lane. Renames, deletions, and mixed diffs take the `affected`
  profile. The lane is selected by the check runner from the taxonomy, not by
  a workflow path filter, so a candidate cannot suppress checks by editing the
  workflow.
- The planning lane executes `preflight`, `plan:validate`, `format`, and the
  schema members, and nothing that depends on `build`. `plan:validate` gains
  two members: `scripts/check-campaign.mjs`, so every campaign ledger and
  prompt change is validated against `law/schemas/campaign.schema.json` in the
  gate, and the scorecard page check
  (`scripts/generate-scorecard-page.mjs --check`), so a `record/` change keeps
  the rendered page consistent without running `generate`. The
  release-verification floor of ADR-014 applies to release profiles and is
  untouched.
- The check-runner bootstrap output (`.devai/state/pr-bootstrap`) is cached in
  the workflow, keyed by the digest of the TypeScript inputs, so a candidate
  that changes no source restores it instead of compiling. The duplicate
  `check --affected` invocation after `release:pr-gate` is removed.
- `class` selectors bind the floor per class in `test-tasks.json`, as
  ADR-GOV-0017 admits; `work/` is bound to `plan` in the materialized binding
  and receives a selector.
- `docs:validate` runs every member the `docs` class lists, including
  `docs-governance`. `project.json` declares `repo.kind: library` and
  `docs.builder: docusaurus` (#166). The `no-ci-publish` rule keeps its
  substring matcher (none of the three action names appears in the workflows)
  and its description and remediation say that publication goes only through
  the governed Pages journal (#167).
- `scripts/check-campaign.mjs` verifies that every Owner effect carries
  `performed_at` before its `required_before` round closes, and
  `law/policy/campaign-execution.json` moves from `proposed` to `accepted`
  in the same law commit, since it has governed two campaigns already.
- `docs/dev/operations/workflow-economy-proposals.md` is annotated as delivered
  and its root-cause paragraph restated for the residue.
- Acceptance: a fixture pull request that changes one prompt and the ledger
  executes exactly the planning-lane nodes, reports the campaign check, and
  restores the bootstrap from cache; a fixture that changes a prompt and a
  package source executes the `affected` profile; `check --only
docs-governance` passes on `main`. The two-minute figure is a measured
  target for the checks after dependency setup and bootstrap restore, reported
  in the campaign guide, not an acceptance criterion.

### ADR-CFG-0002: owned configuration projection

- An ownership matrix names every `project.json` key and nested block that
  `init bind --adopter-policy` projects from `law/policy/devai-adoption.json`.
  For owned keys, absent in the source means absent in the projection; keys
  the matrix does not name are adopter declarations and survive. The
  `deepMerge` in `adopter-policy.ts` is replaced for owned keys, and
  `reconcileProjectConfig` follows the same matrix (#68).
- Projection and receipt are written atomically, the receipt lists retired
  keys, and the operation is idempotent.
- The stale `scorecard-na.json` digest in
  `.devai/config/adopter-policy-binding.json` is a rematerialization task
  under this record, since the digest check already exists in
  `adopter-policy-binding.ts` (#162, item 4).
- Acceptance: the adopter reproduction from 1.4.5 (retire `ci_economy`,
  rebind) leaves no `ci_economy` block and no `trusted-local-rc-boundary`
  failure in `doctor`; a second bind changes nothing.

### ADR-GOV-0020: canonical instructions and host projections

- `AGENTS.md` is the only instruction contract. `CLAUDE.md` contains exactly
  one line, `@AGENTS.md`, which the Claude Code documentation states never
  loads twice; a later record removes the file once every maintainer host
  reads `AGENTS.md` natively (documented from 2.1.277; verified against the
  published documentation on 2026-09-28 and re-verified at round open).
- The adopter bootstrap writes that pair, and `init apply --force` never
  overwrites `AGENTS.md`, `CLAUDE.md`, or the `README.md` files under `law/`
  once they differ from the template; the plan reports `replace` for any
  existing file it will overwrite, never `create` or `skip-exists` (#70).
- The `agents-claude-sync` doctor check verifies that `CLAUDE.md` is the
  import and that `AGENTS.md` carries the required content, and it runs
  against DEVAI itself in the round-close checks.
- Recipes keep one canonical source in `packages/skills/resources/recipes`
  and generated projections into `.claude/skills` and `.agents/skills`; the
  installer's symlink refusal stands. Skill front matter converges on the
  Agent Skills core set (`name` equal to the directory, `description`,
  `license`, `compatibility`, `metadata`) and bodies never mention an
  invocation glyph. Hook convergence is out of scope: DEVAI ships no hooks.
- Acceptance: `devai init apply harness --include skills` produces two
  projections with identical bodies and core front matter; `init apply
architect --force` on an adopter with edited guidance leaves the guidance
  untouched and reports it; `doctor` passes on DEVAI's own checkout.

### ADR-GOV-0022: authorization registry maintenance

- The forbidden-actions scanner treats a change to the configured
  authorization registry as registry maintenance when the resulting file
  validates against its schema and the change is append-only (receipts
  added, none removed or altered). Registry maintenance produces no
  `FORBID-MUTATE-INVARIANTS` finding in any inspection, including the
  name-status pass (#67).
- A commit that removes or alters a receipt, touches any other `law/` path,
  or matches another pattern is still a finding. Role authority, exact-commit
  scope, and the runtime write boundary of Article 6 are unchanged.
- Acceptance: the adopter reproduction (eight receipts recorded in one
  commit) yields zero findings with `--strict`; a commit that deletes a
  receipt yields one; the existing forbidden-path tests stay green.

### ADR-CHK-0004: serialized integration

- Two boundaries: the local preflight against a named fetched base stays the
  "ready for a pull request" condition (ADR-CHK-0001), and integration
  validation runs against the queue candidate.
- `pull-request-checks.yml` accepts `merge_group` in addition to
  `pull_request`. Under `merge_group` the candidate is the queue's temporary
  head, the base is `github.event.merge_group.base_sha`, the commit range is
  base to head, and the `devai-release-gate` check name is identical, so
  branch protection keeps one required check. Concurrency is per queue entry
  with no cancellation across entries.
- Admission: a pull request enters the queue when its own gate is green on
  its head; the queue rebases it onto the current tip and re-gates; a failed
  entry is evicted with its diagnostic and the pull request returns to open
  without cancelling the entries behind it. Because the merge method is
  rebase, the commits the queue tests are the commits that reach `main`.
- Prerequisite, verified before the record closes: the queue supports the
  rebase method together with linear history and the required check. If it
  does not, the fallback delivery is serialized admission by the orchestrator
  (one open pull request in `pre_merge` at a time), recorded as such.
  `allow_update_branch` is a convenience, not a prerequisite.
- Acceptance: two pull requests from the same base, both green, both
  enqueued, both merge without a manual rebase; the second's queue run
  executes against the first's merged head; a queue run whose commit range
  fails the grammar evicts only that entry.

### ADR-GOV-0023: review boundaries

- Article 18 permits a model to evaluate a gate when a human initiates the
  evaluation; Article 23 orders model escalation before human escalation;
  the campaign policy requires a human to evaluate and record every gate.
  This record separates four steps and says which a campaign may delegate:
  model evaluation of a task's pull request (delegable, inside the
  human-initiated orchestrator session, as an advisory verdict under
  ADR-MDL-0001); gate ratification (human); merge (human); dispatch of any
  remote effect (human, exact, single-use).
- `campaign.json` gains `review.mode` with the values `human` (default) and
  `model-advisory`. In `model-advisory` the orchestrator records the model
  verdict and its digest on the task before the human ratifies; a missing or
  invalid verdict blocks ratification.
- Acceptance: a campaign with `model-advisory` validates; a task in
  `pre_merge` without a recorded verdict cannot transition to `merged`; the
  constitution is unchanged.

### ADR-MDL-0001: structured review contracts

- Two reply schemas in `law/schemas`: `review-verdict.schema.json`
  (`verdict` from `pass | review | fail | unknown`, `confidence`, `rationale`,
  `findings`) for the judge sensor and the campaign review of ADR-GOV-0023,
  and `triage-breaker.schema.json` (`classification`, `confidence`,
  `rationale`) for the tie-breaker.
- One shared extractor in the model bridge: validate a provider `json` field
  when present; otherwise accept exactly one unambiguous candidate document
  in the text, with or without a code fence; reject multiple conflicting
  objects, echoed examples, malformed fields, provider errors, and
  truncation. Every consumer validates through `getValidator`.
- The bridge requests schema-constrained output where the provider offers it
  (`output_config.format` on the Claude API, `--json-schema` on `claude -p`,
  `--output-schema` on `codex exec`, a JSON schema `response_format` on the
  OpenAI API) and never uses prefill. The CLI transports report a real
  `finish_reason`, so truncation is `error`, never `unknown`.
- A parse or validation failure keeps a bounded, redacted excerpt and the
  SHA-256 of the full reply in the finding, which satisfies
  `partial_output: retain-as-diagnostic-only` without unbounded raw text.
- The consumer that rejected the maintainer's PASS replies is the campaign
  orchestrator session, which parses the review subagents' replies itself. The
  record gives that consumer the same verdict schema and extractor, delivered
  as a recipe step the orchestrator prompt invokes, and one rejected reply is
  attached to the record as its first fixture.
- This record is the Architect disposition that
  `law/policy/sensor-notes/llm_judge.md` requires.
- Acceptance: `Here is my assessment: {"verdict":"pass", ...}` yields `pass`;
  `{"verdict":"maybe"}` yields `error` with the excerpt and digest; two
  conflicting objects yield `error`; a `length` finish yields `error`.

### ADR-MDL-0002: versioned model defaults

- `law/policy/model-tiers.json`, validated by
  `law/schemas/model-tiers.schema.json`, holds the repository default of the
  `models` block: tiers with rank, one entry per declared host (an object
  keyed by host id), default effort, and the escalation rule, plus a
  `policy_version`.
- `campaign.json` `models` becomes optional and overrides by tier name;
  unknown tiers and efforts outside the tier grammar fail closed; a campaign
  cannot declare a host the default does not declare. The resolved map is
  pinned on each task at `task_start` with the default's `policy_version`, so
  a later default change never reinterprets a started task; closed campaigns
  keep their own `models` block byte-for-byte.
- Tier names are unchanged, including `architect`; the collision with the
  discipline name is documented, not fixed, because the closed campaigns
  reference the tier and its ceiling.
- Runtime ids and effort support resolve through
  `law/policy/model-runtime-registry.json`; the default names the host
  aliases the hosts publish (`fable`, `opus`, `sonnet`, `haiku`;
  `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`), verified against the host
  documentation on 2026-09-28 and re-verified at round open. The
  non-existent Codex model is corrected once, here.
- `docs/reference/cli/model-runtime.md` and the round-task-executors page are
  corrected to the `runtime:model` registry id form the code enforces.
- Acceptance: both closed campaigns validate unchanged; a campaign that
  declares only a `worker` override validates; a started task keeps its
  pinned map after the default changes.

### ADR-REL-0030: release approval topology

- The record starts from a complete matrix of jobs, environments, secrets
  and variables each job reads, and who stops there. Today a rehearsal stops
  three times (`verify-ledger`, `build-release`, `rehearsal-summary`) and a
  publication four times (`verify-ledger`, `promote-assets`,
  `finalize-release`, `deploy-pages`).
- Jobs that share an environment and a credential set are merged into one
  gated job: rehearsal becomes two stops (`devai-ledger-verification`,
  `devai-rc-release`) and publication two (`devai-ledger-verification`,
  `devai-rc-publication`). The `github-pages` environment keeps its
  deployment binding and its audit variables but no reviewer, so
  `deploy-pages` runs under the publication stop and a site-only dispatch
  runs on the Owner's dispatch alone. This record supersedes the approval
  clause of ADR-REL-0029 and leaves its journal, concurrency, and main-guard
  clauses in force.
- The exact, single-use Owner authorization of ADR-GOV-0012 and ADR-GOV-0013
  is untouched: `publish: true` is still a separate dispatch, and the tag is
  still signed by hand.
- `DEVAI_PROCESS_CONTROL_COMMIT` is printed in the run summary before the
  first stop, so a stale control commit is visible.
- Acceptance: the release-discipline page lists every stop by environment
  with the credential set it protects; a rehearsal and a publication each
  show the stated number of waiting jobs.

### ADR-REL-0032: Pages re-run identity

- The site-only publication identity drops `sourceAttempt` and keeps
  `sourceRun`, so a re-run of the same dispatch finds its own journal record.
- A re-run resumes a `submitted` record by observing the Pages deployment and
  recording `verified`, and treats a `verified` record as a no-op when the
  bytes match. An `intent` record whose submission is unknown stays
  fail-closed (`SUBMISSION_UNKNOWN`), and the release-discipline page
  documents the manual reconciliation for that case (#165).
- The release identity keeps its attempt; its recovery path is documented
  beside the site-only one.
- Acceptance: the pinned contract test changes from "a new attempt fails on
  its own intent" to "a new attempt resumes a submitted record and refuses an
  unknown submission".

### ADR-AUT-0002: sensing process admission

- The first task reproduces the `sense run build` refusal on the framework
  checkout: the broker admits `pnpm -r build` under `sense run`,
  `test-tasks.json` declares that argv, and `build.ts` reads the descriptor,
  so the cause is elsewhere. The record fixes the cause and defines the
  precedence between the descriptor's `build` node and any declared input
  (#155). Build is a harness-write, never described as read-only.
- The broker admits two exact `gh api` GET shapes for the harness sensors:
  the repository deployments listing and the Pages intent journal, each with
  repository, endpoint, method, and query fixed and any write-changing option
  refused, so `site_drift` stops reading
  `SITE_DRIFT_PROVENANCE_ADAPTER_REQUIRED` (#162, item 1). The shapes are
  declared as templates in `subprocess-effects.json` and mirrored, and the
  record states that the broker's literal list is the executable policy.
- Acceptance: `sense run build` and `sense run site_drift` on the repository
  each produce a reading; F2:T4 and F2:T9 carry a verdict at the next
  observation.

### ADR-SCR-0007: e2e and bounded coverage

- The e2e sensor argv declares `tests/config/rc.e2e.config.ts`, admitted in
  the broker's governed configuration list; `LOCAL_INCLUDE` is unchanged, so
  `test:local-full` and `pnpm test` keep their population (#156, option 2).
- `tests/config/local.coverage.config.ts` produces
  `scratch/coverage/local/coverage-final.json` without the database gate,
  with a declared denominator (the local population) and declared exclusions
  (database-bound suites); `coveragePath` points at it; the RC lane is
  unchanged. The reading states which population it measured (#161).
- Acceptance: `sense run e2e_test` and `sense run test_coverage_depth` as
  inspector report the measured outcome, including FAIL when a test fails,
  and never `error` for a missing file or a missing prerequisite.

### ADR-SCR-0008: immutable readings and recording order

- A recorded reading is immutable. Its id stays content-derived; a later
  reading of the same kind for the same candidate is a new instance linked by
  `supersedes`, selection takes the latest instance per kind and candidate,
  and `SENSE_RECORD_ID_CONFLICT` remains for a same-id different-body write
  (#158).
- The sweep stays read-only. The `sense-presets.json` `sweep` preset gains an
  ordered second pass for the store-reading sensors (`inventory_performance`
  and any other consumer), and the recording protocol is: first pass, record,
  second pass, record. The two writes of a recording (reading file, chain
  entry) are ordered and recoverable: the chain entry names the file digest
  and a missing entry is repaired by re-recording, never by editing.
- `sense record` appends the `sense.readings.record` chain entry under a
  self-dogfood policy row that covers the chain path, and the alignment
  sensor accepts a reading in the canonical store with its candidate
  binding; the candidate-binding requirement is not weakened (#157).
- `law/schemas/observation-backlog.schema.json` describes what `audit
observe` writes; the skills suites validate it; the post-merge hook
  resolves readings from the bound checkout's `.devai/state/sensor-readings`
  (#160).
- Applicability of F4:T4 and F4:T9 is decided per cell from its actual
  subject: `inventory_regeneration` covers `dep_graph` and `coverage` kinds,
  which exist on the framework, so it is measured, not N/A; `inventory_
adherence` is N/A only if every surface it measures is declared absent,
  otherwise the adapter is repaired (#159).
- Acceptance: on a fresh worktree the ordered protocol yields readings for
  F4:T7 and F5:T4 that reflect the substrate (pass or fail), never
  `REVIEW` for an empty store; the committed `backlog.json` validates; the
  two inventory cells read a measured verdict or a ledger-anchored N/A.

### ADR-SCR-0010: CI sampling contract

- The harness sensors (`harness_green_main`, `harness_performance`,
  `harness_robustness`) declare their population: workflow, event, head and
  base branch, attempts counted, whether cancelled runs count, lookback, and
  the minimum sample. Runs whose duration is dominated by an environment wait
  are excluded by workflow and job, not by threshold.
- Below the minimum sample the cell reads `UNKNOWN` with the sample size in
  the finding, never FAIL.
- The recomputation of the three cells after the sample matures is an
  Inspector task that records a second scorecard beside the first and notes
  the delta (#154).
- Acceptance: the sensors' declared inputs name the population; a fixture
  with fewer runs than the minimum reads `UNKNOWN`.

### ADR-REL-0031: export reconstructs intent policy

- `devai-evidence-export` accepts a receipt whose provenance records a release
  intent and reconstructs the expected task policy independently from the
  pinned intent, policy, descriptor, toolchain, environment, base, candidate,
  and stage; it never trusts the receipt's claimed task set. A profile-driven
  receipt keeps its current path (#69).
- Rejection tests cover an altered intent, a wrong stage, a stale policy, a
  wrong base, and an incomplete population.
- The change lands first in the canonical verifier source and is then
  vendored with a new immutable provenance; `PROFILE_UNKNOWN` distinguishes
  an unknown id from a path supplied where an id was expected.
- Acceptance: the certify receipt of a release-intent run exports without a
  second `--rc` execution; every rejection fixture is refused with its code.

### ADR-EVI-0001: canonical closure index

- `evidence render --kind rounds` renders `record/derived/indexes/rounds.md`
  from the closure reader in `packages/evidence/src/closure`, one row per
  closure with id, round, `supersedes`, and `merged_as`, in deterministic
  order; the narrative renderer of round records stays available under its
  own kind if a consumer needs it.
- The renderer rejects a file name that differs from the closure id,
  duplicates, a missing or crossed supersession link, a cycle, and more than
  one terminal closure per round; `--check` compares bytes without writing.
- `round seal` checks exact membership of the closure id and its terminal
  status in the index, not substring presence (#169).
- Acceptance: a fixture with superseding closures renders deterministically
  and seals; the DETRAN closures, once supplied as a fixture, render
  byte-identically to the adopter's generator.

### ADR-EVI-0002: proof-line anchoring

- `evidence verify --scope chain` cross-checks in both directions: every
  anchor (`round_id`, `proof_sequence`) resolves to exactly one physical line
  under `record/proofs/work/**/*.jsonl`, and every line has one direct anchor
  or one governed historical declaration. Canonical path, sequence
  namespace, newline handling, and byte hashing are defined in the record.
- New anchors carry the SHA-256 of the line bytes. Historical lines, which
  have no digest in their anchor, are checked against a baseline that the
  first verification records append-only.
- A historical declaration proof, itself directly anchored, names each
  orphan by canonical path, sequence, and line digest, is authorized by the
  Architect, applies only to lines before a fixed cutoff, and reads as
  "historical gap acknowledged", never as restored provenance. Old lines and
  old chain entries are never edited (#168).
- The two-step writer (proof line, then chain entry) gets a crash-recovery
  rule: an unanchored newest line is reported with its remediation.
- This path lives in `packages/evidence`, not in the vendored release
  verifier.
- Acceptance: the DETRAN baseline (119 lines, 67 anchored, 52 orphaned),
  supplied as a fixture, fails before its declaration and passes after it;
  the cryptographic chain verification is unchanged.

### ADR-GOV-0021: workflow reference pages

- `docs/dev/operations/workflows/` holds one page per admitted workflow and
  an index. Each page states: triggers and path scope, jobs and their order,
  environments and who stops there, secrets and variables each job reads,
  what each job runs, direct effects, side effects, recovery paths, and
  which steps an adopter may reuse.
- `law/policy/documentation-information-architecture.json` gains a
  `workflows` page entry with a completeness gate that requires one page per
  file under `.github/workflows/`. Drift is checked from a small metadata
  block on each page (workflow file, triggers, jobs), not by parsing tables.
- `law/adr/README.md` becomes a generated catalogue through the existing
  `renderDecisionIndex`, checked for freshness (#162, item 5).
- The stale statements are corrected: the operations README,
  `sensor-inputs.md`, the remote preflight contract, and the adopter page
  for the `no-ci-publish` rule (#167).
- Acceptance: the docs-links and information-architecture gates pass; the
  catalogue check fails when a record is added without regenerating.

## Sequencing

Two campaigns, split by outcome rather than by origin. Campaign A makes the
development flow trustworthy; campaign B makes the observations and the
evidence trustworthy. Campaign B depends on A's round 1 (the planning lane
that its own ledger commits use) and on ADR-MDL-0002 where its prompts
resolve tiers; nothing else crosses the split.

Campaign A:

1. ADR-CHK-0003 first: it accepts the campaign policy, enforces Owner-effect
   closure, and makes every later plan commit cheap.
2. ADR-CFG-0002 and ADR-GOV-0020 together: both change the bootstrap and the
   `init` surface, and the guidance rule needs the import form of
   `CLAUDE.md` defined first.
3. ADR-GOV-0022 alone: one engineer task with the adopter reproduction as the
   red test, coupled with an inspector task for the deletion case.
4. ADR-CHK-0004 after its queue prerequisite is verified; the fallback
   delivery is recorded if the verification fails.
5. ADR-GOV-0023 before ADR-MDL-0001: the review boundary decides who consumes
   the verdict schema. ADR-MDL-0002 lands in the same round as ADR-MDL-0001
   only if the maintainer names the external review consumer in time;
   otherwise MDL-0002 goes first.
6. ADR-REL-0030 and ADR-REL-0032 in separate waves of one round, once the
   environment Owner effect is performed.
7. ADR-GOV-0021 last, so the pages describe the workflows as the campaign
   leaves them.

Campaign B:

1. ADR-AUT-0002 and ADR-SCR-0007 together: both are sensor inputs and broker
   admission, and both change the task-policy digest, so one attestation
   re-issue.
2. ADR-SCR-0008 after round 1, since the second sweep pass reads the cells
   round 1 makes measurable.
3. ADR-EVI-0001 and ADR-EVI-0002 in separate waves; ADR-REL-0031 in its own
   wave with the verifier-source boundary.
4. ADR-SCR-0010, then the Inspector task that records the second scorecard
   when the sample matures; implementation closure does not wait for it.

## Separate Owner effects

- Verify that the merge queue supports the rebase method with linear history
  and the required check, then enable it on `main` (required by
  ADR-CHK-0004). `allow_update_branch` is optional.
- Reconfigure the release environments from the before/after matrix of
  ADR-REL-0030; the `github-pages` environment loses its reviewer and keeps
  its variables.
- Repoint `DEVAI_PROCESS_CONTROL_COMMIT` to an explicit reviewed SHA before
  the next rehearsal, and again after campaign A's round 6 lands (#162, item
  2).
- Reissue the Pages migration audit (`DEVAI_PAGES_MIGRATION_AUDIT_JSON` and
  its SHA-256 in the `github-pages` environment) for the next tag (#162, item
  3).
- Provide no test database for the next scorecard; ADR-SCR-0007 measures the
  declared local population instead (#161, decided 2026-09-28).
- Raise every maintainer host to a Claude Code release that reads `AGENTS.md`
  natively (documented as 2.1.277 or later), the precondition for the
  follow-up record that removes `CLAUDE.md`.
- Supply the DETRAN closures and proof baseline as fixtures for ADR-EVI-0001
  and ADR-EVI-0002, and one rejected review reply for ADR-MDL-0001.

## Non-decisions

- Constitution text is untouched. ADR-GOV-0023 works inside Articles 3, 7,
  18, and 23.
- No plan branch outside `main`. This is a simplicity choice: the campaign
  policy binds the ledger to `main`, and a parallel branch would need its own
  binding and freshness design; ADR-CHK-0003 makes plan commits cheap instead.
- No merging of the rehearsal and publication runs, and no publish on tag
  push. ADR-GOV-0012 and ADR-GOV-0013 constrain the present design; a
  successor record may be proposed later, and this set does not. ADR-REL-0029
  is superseded only in its approval clause, by ADR-REL-0030.
- No rename of the tiers, neither to a size scale nor away from `architect`.
- No shared subagent definition format and no hook convergence: DEVAI ships
  neither custom agents nor hooks today.
- No automatic retry for a blocked `base-up-to-date` probe outside the queue.
- No waiver of `FORBID-MUTATE-INVARIANTS` and no receipt that covers the
  commit introducing it.
- No rewriting of historical proof lines or chain entries; ADR-EVI-0002
  declares gaps append-only.
- No hand edits to generated configuration; ADR-CFG-0002 makes the projection
  authoritative instead.
- No blanket N/A for the inventory cells; ADR-SCR-0008 decides per cell.

## Review reconciliation

The independent review (Codex, `gpt-6-astra`, 2026-09-28) verified or
refuted every factual claim of the first draft against the checkout, judged
the sixteen records it then held, and proposed the structure this document
now follows. What this document took from it, and what it did not:

- Accepted, with the cited evidence re-checked in this checkout: the
  bootstrap compiles TypeScript before the DAG (`bootstrap-check-runner.mjs`),
  so a build-free lane needs a cache; the `plan` class is wider than
  campaigns and prompts, so the lane population is narrowed; the judge and
  the tie-breaker consume different documents; the recipe installer refuses
  symlinks (`adapters.ts`, `RECIPE_INSTALL_SYMLINK_REFUSED`), so projections
  stay generated; ADR-REL-0029 requires the `github-pages` approval, which
  the maintainer chose to supersede explicitly rather than remove in passing;
  an `intent` record with unknown submission fails closed by design;
  `adopter-policy.ts` deep-merges, which is the real cause of #68; the
  binding digest check exists, so #162 item 4 is a rematerialization;
  regeneration covers `dep_graph` and `coverage`, so #159 is not a blanket
  N/A; `rc.e2e.config.ts` exists, so #156 takes option 2; the broker admits
  `pnpm -r build`, so #155 is reproduced first; reading ids omit the
  timestamp while recording compares the whole object; `evidence verify`
  uses `packages/evidence`, not the vendored verifier; the campaign policy is
  still `proposed` and the checker does not enforce Owner-effect closure;
  the tie-breaker's `finish_reason` is hard-coded; the duplicate affected
  invocation; request 7 deserves a record rather than a non-decision; the
  `architect` rename is dropped; acceptance criteria no longer require a
  green score.
- Rejected, with evidence: the claim that `docs-governance.no-ci-publish`
  fails on the release workflow. The matcher is a substring test for
  `peaceiris/actions-gh-pages`, `actions/deploy-pages`, and
  `JamesIves/github-pages-deploy-action`; `release.yml` contains a job named
  `deploy-pages` and uses `actions/upload-pages-artifact`, and none of the
  three strings appears in any workflow. #167 is a wording repair.
- Resolved outside the checkout: the Claude Code `AGENTS.md` support and its
  version floor, the Codex model names, and the hook contracts were verified
  against the hosts' published documentation on 2026-09-28 by a research
  pass whose sources are listed in the campaign guide; the review could not
  reach the network. The records keep those facts as re-verification steps
  at round open rather than as unverifiable claims. The run counts and
  repository settings were read through `gh` on the same date.
- Adjusted wording: "copied verbatim" became "the same host assignments",
  since the `use_for` texts differ.

## Decisions taken by the maintainer

Answered on 2026-09-28; each answer is already applied to its record.

1. The planning lane covers the whole `plan` class (`product/`, `record/`,
   `work/`); the scorecard page check joins `plan:validate` so `record/`
   changes need no `generate` (ADR-CHK-0003).
2. The two-minute figure is a measured target for the checks after
   dependency setup and bootstrap restore, not an acceptance criterion
   (ADR-CHK-0003).
3. Campaign review replies are parsed in the orchestrator session; ADR-MDL-0001
   gives that consumer the shared schema and extractor, with one rejected
   reply as its first fixture.
4. Request 7 changes model evaluation only; gate ratification, merge, and
   remote dispatch stay human (ADR-GOV-0023).
5. If the merge queue is incompatible with the rebase method or the required
   check, serialized admission by the orchestrator is the first delivery
   (ADR-CHK-0004).
6. Site-only publication does not keep a `github-pages` reviewer; ADR-REL-0030
   supersedes the approval clause of ADR-REL-0029, and publication drops to
   two stops.
7. Model defaults freeze at task start; closed campaigns keep their `models`
   blocks byte-for-byte (ADR-MDL-0002).
8. Skills are generated projections from one canonical source; symlinks were
   weighed and set aside for Windows checkouts and the installer's symlink
   guard (ADR-GOV-0020).
9. No test database for the next scorecard; database-free coverage reports a
   bounded, declared population (ADR-SCR-0007).
10. The Architect authorizes historical orphan declarations; only lines
    recorded before the first verification under ADR-EVI-0002 are eligible.
